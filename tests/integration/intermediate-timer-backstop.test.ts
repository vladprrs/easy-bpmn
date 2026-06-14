import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, publishAndStart } from "../helpers";
import { loadGraphForInstance, runInstance, settleOverdueTimersForInstance } from "../../src/runtime/engine";
import type { RunStep, WaitForEvent } from "../../src/runtime/engine";

// Lost-alarm backstop for the intermediate timer catch under the SINGLE-WAKE drive
// (TASK-54, design §4.2 / Q2). The catch analogue of boundary-timer-backstop.test.ts.
//
// Pre-TASK-54 the inline overdue-catch settle lived in driveIntermediateCatch's
// workflow-mode `outcome.kind === "timeout"` branch. TASK-54 unifies the engine onto
// ONE `bpmn_wake` issued by `loop`: leaf drivers always PARK, and on a wake TIMEOUT
// the loop calls `settleOverdueTimersForInstance` (the per-instance sweep) BEFORE
// re-walking — so a modeled deadline still fires within the backstop bound (instead of
// busy-re-walking) even when the DO alarm was lost. The sweep reuses the IDENTICAL
// `settleOverdueIntermediateCatchOnWake` builder, so the R5 promise holds: a
// timer-guarded wait NEVER raises waitTimeout.
//
// CI runs EXECUTION_MODE=direct, where the single wake never fires. We cover the
// backstop two ways (mirroring boundary-timer-backstop.test.ts):
//   (1) INTEGRATION — drive `runInstance` with a `waitFor` stub that THROWS (the real
//       Cloudflare `waitForEvent` throws on timeout), so `issueWake`'s catch runs the
//       sweep and the re-walk takes the catch's fired path. An always-throwing stub
//       drives exactly ONE wake→sweep→re-walk cycle: the sweep fires the overdue
//       catch, so the re-walk reaches END and completes before a second wake.
//   (2) UNIT — call `settleOverdueTimersForInstance` directly to prove its decision
//       logic in isolation (not-yet-due is skipped; an already-cancelled catch is
//       never re-fired) — cases that, as integration drives, would re-walk forever
//       because nothing progresses (the always-throwing wake never advances them).
//
// This is DISTINCT from intermediate-timer.test.ts, which exercises the PRIMARY
// DO-alarm fire path. The catch routes to an END (no host task to muddy the "no
// waitTimeout incident" claim) so the fired token runs to completion cleanly.

const inline: RunStep = (_name, fn) => fn();
const throwingWait: WaitForEvent = async () => {
  throw new Error("Execution timed out after 1ms");
};

// S → catch (timer PT5M) → E (end). The catch IS the wait; on fire it runs to
// completion cleanly (no host task to muddy the "no waitTimeout incident" claim).
const CATCH_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_bk_ic" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:intermediateCatchEvent id="catch"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="catch"/>
    <bpmn:sequenceFlow id="s1" sourceRef="catch" targetRef="E"/>
  </bpmn:process>
</bpmn:definitions>`;

async function theTimer(instanceId: string): Promise<any> {
  return env.DB.prepare(`SELECT * FROM timers WHERE instance_id = ? ORDER BY created_at LIMIT 1`).bind(instanceId).first<any>();
}
async function timerOutcome(timerId: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT outcome FROM timer_outcomes WHERE timer_id = ?`).bind(timerId).first<{ outcome: string }>();
  return r?.outcome ?? null;
}
async function setFireAt(timerId: string, iso: string): Promise<void> {
  await env.DB.prepare(`UPDATE timers SET fire_at = ? WHERE timer_id = ?`).bind(iso, timerId).run();
}
async function historyTypes(instanceId: string): Promise<string[]> {
  const h = await get(`/instances/${instanceId}/history`);
  return (h.body.events as any[]).map((e) => e.type);
}

const PAST = "2000-01-01T00:00:00Z";
// In the future but under workerd's ~year-2189 setAlarm cap so a self-heal re-arm
// (armTimerDO) does not throw inside the JobScheduler DO.
const FUTURE = "2100-01-01T00:00:00Z";

describe("Intermediate-catch lost-alarm backstop (TASK-54, design §4.2 / Q2)", () => {
  it("INTEGRATION: an OVERDUE catch fires INLINE on a wake TIMEOUT — advances, NO waitTimeout incident", async () => {
    const { instance } = await publishAndStart(CATCH_BPMN, { correlationKey: `bk-ic-fire-${crypto.randomUUID()}`, variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting"); // parked at the catch, timer armed
    expect(instance.body.currentElementId).toBe("catch");

    // The deadline elapsed but the DO alarm was LOST: force the armed timer overdue.
    const timer = await theTimer(id);
    expect(timer.status).toBe("armed");
    await setFireAt(timer.timer_id, PAST);

    // Drive with a THROWING waitFor — the single-wake TIMEOUT seam. issueWake catches
    // the throw, runs settleOverdueTimersForInstance (fires the overdue catch inline),
    // then re-walks to the catch's fired path. (If the sweep were not wired into
    // issueWake this would re-walk forever / never fire and every assertion below
    // would fail.)
    const result = await runInstance(env, id, { runStep: inline, waitFor: throwingWait });
    expect(result.status).toBe("completed");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.timers?.find((t: any) => t.elementId === "catch")?.status).toBe("fired");
    expect(await timerOutcome(timer.timer_id)).toBe("fired");

    // R5 promise: a timer-guarded wait NEVER raises waitTimeout, even on a (lost-
    // alarm) timeout wake. A timerFired event exists; NO incident was written.
    const types = await historyTypes(id);
    expect(types).toContain("timerFired");
    expect(types).not.toContain("incidentCreated");
  });

  it("UNIT: the sweep SKIPS a not-yet-due catch — no fire, no incident, still armed", async () => {
    const { instance } = await publishAndStart(CATCH_BPMN, { correlationKey: `bk-ic-early-${crypto.randomUUID()}`, variables: {} });
    const id = instance.body.instanceId;
    const timer = await theTimer(id);
    await setFireAt(timer.timer_id, FUTURE); // NOT yet due → the sweep must skip it

    const graph = await loadGraphForInstance(env, id);
    await settleOverdueTimersForInstance(env, graph, id);

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("waiting");
    expect(inst.body.currentElementId).toBe("catch");
    expect(inst.body.timers?.find((t: any) => t.elementId === "catch")?.status).toBe("armed"); // still armed
    expect(await timerOutcome(timer.timer_id)).toBeNull(); // no decider row — never fired

    const types = await historyTypes(id);
    expect(types).not.toContain("timerFired");
    expect(types).not.toContain("incidentCreated");
  });

  it("UNIT: the sweep SKIPS a catch already DECIDED 'cancelled' — never re-fires", async () => {
    const { instance } = await publishAndStart(CATCH_BPMN, { correlationKey: `bk-ic-cancel-${crypto.randomUUID()}`, variables: {} });
    const id = instance.body.instanceId;
    const timer = await theTimer(id);
    // Simulate a concurrent /cancel that already settled the decider 'cancelled'.
    // Even though the timer is now OVERDUE, the sweep must skip it (status != 'armed')
    // — a decided-cancelled catch never fires.
    await env.DB.prepare(`INSERT INTO timer_outcomes (timer_id, outcome, decided_at) VALUES (?, 'cancelled', ?)`).bind(timer.timer_id, PAST).run();
    await env.DB.prepare(`UPDATE timers SET status = 'cancelled' WHERE timer_id = ?`).bind(timer.timer_id).run();
    await setFireAt(timer.timer_id, PAST);

    const graph = await loadGraphForInstance(env, id);
    await settleOverdueTimersForInstance(env, graph, id);

    expect(await timerOutcome(timer.timer_id)).toBe("cancelled"); // unchanged — NOT flipped to fired
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("waiting");
    expect(inst.body.currentElementId).toBe("catch");

    const types = await historyTypes(id);
    expect(types).not.toContain("timerFired");
    expect(types).not.toContain("incidentCreated");
  });
});
