import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, publishAndStart } from "../helpers";
import { runInstance } from "../../src/runtime/engine";
import type { RunStep, WaitForEvent } from "../../src/runtime/engine";

// Workflow-mode lost-alarm BACKSTOP for the intermediate timer catch, in direct
// mode (M3-L4, TASK-45; design §4.2, risk R5). The catch analogue of
// boundary-timer-backstop.test.ts: when a timer-guarded wait wakes on a TIMEOUT
// (a lost/failed DO alarm), `settleOverdueIntermediateCatchOnWake` settles an
// overdue catch INLINE instead of blindly re-parking. Reachable in the only CI
// mode (direct) via the SAME seam wait-cap-incidents.test.ts uses: drive
// runInstance with a waitFor stub that returns a timeout, forcing the
// `outcome.kind === "timeout"` branch of driveIntermediateCatch.
//
// This is DISTINCT from intermediate-timer.test.ts, which exercises the PRIMARY
// DO-alarm fire path. Here we prove the R5 promise for the catch: a timer-guarded
// wait NEVER raises waitTimeout, even on a (lost-alarm) timeout wake.

const inline: RunStep = (_name, fn) => fn();
const timeoutWait: WaitForEvent = async () => ({ kind: "timeout" });

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
// In the future but under workerd's ~year-2189 setAlarm cap so the reparked
// self-heal re-arm (armTimerDO) does not throw inside the JobScheduler DO.
const FUTURE = "2100-01-01T00:00:00Z";

describe("Intermediate-catch lost-alarm backstop in direct mode (M3-L4; design §4.2, risk R5)", () => {
  it("an OVERDUE catch fires INLINE on a timeout-wake — advances, NO waitTimeout incident", async () => {
    const { instance } = await publishAndStart(CATCH_BPMN, { correlationKey: `bk-ic-fire-${crypto.randomUUID()}`, variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting"); // parked at the catch, timer armed
    expect(instance.body.currentElementId).toBe("catch");

    // The deadline elapsed but the DO alarm was LOST: force the armed timer overdue.
    const timer = await theTimer(id);
    expect(timer.status).toBe("armed");
    await setFireAt(timer.timer_id, PAST);

    // Drive with a timeout-returning waitFor — the Workflow-mode TIMEOUT-wake seam.
    const result = await runInstance(env, id, { runStep: inline, waitFor: timeoutWait });
    expect(result.status).toBe("completed");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.timers?.find((t: any) => t.elementId === "catch")?.status).toBe("fired");
    expect(await timerOutcome(timer.timer_id)).toBe("fired");

    const types = await historyTypes(id);
    expect(types).toContain("timerFired");
    expect(types).not.toContain("incidentCreated"); // R5: never a waitTimeout
  });

  it("an EARLY/spurious timeout-wake REPARKS (re-arms the DO) — no fire, no incident", async () => {
    const { instance } = await publishAndStart(CATCH_BPMN, { correlationKey: `bk-ic-early-${crypto.randomUUID()}`, variables: {} });
    const id = instance.body.instanceId;
    const timer = await theTimer(id);
    await setFireAt(timer.timer_id, FUTURE); // NOT yet due → the wake is early/spurious

    const result = await runInstance(env, id, { runStep: inline, waitFor: timeoutWait });
    expect(result.status).toBe("waiting"); // reparked, NOT fired

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("waiting");
    expect(inst.body.currentElementId).toBe("catch");
    expect(inst.body.timers?.find((t: any) => t.elementId === "catch")?.status).toBe("armed");
    expect(await timerOutcome(timer.timer_id)).toBeNull();
    expect(await historyTypes(id)).not.toContain("timerFired");
  });

  it("a catch already DECIDED 'cancelled' falls THROUGH on a timeout-wake — never re-fires", async () => {
    const { instance } = await publishAndStart(CATCH_BPMN, { correlationKey: `bk-ic-cancel-${crypto.randomUUID()}`, variables: {} });
    const id = instance.body.instanceId;
    const timer = await theTimer(id);
    // A concurrent /cancel already settled the decider 'cancelled'. Even an OVERDUE
    // timeout-wake must fall through (re-park) — a decided-cancelled catch never fires.
    await env.DB.prepare(`INSERT INTO timer_outcomes (timer_id, outcome, decided_at) VALUES (?, 'cancelled', ?)`).bind(timer.timer_id, PAST).run();
    await env.DB.prepare(`UPDATE timers SET status = 'cancelled' WHERE timer_id = ?`).bind(timer.timer_id).run();
    await setFireAt(timer.timer_id, PAST);

    const result = await runInstance(env, id, { runStep: inline, waitFor: timeoutWait });
    expect(result.status).toBe("waiting"); // fell through → re-park

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("waiting");
    expect(inst.body.currentElementId).toBe("catch");
    expect(await timerOutcome(timer.timer_id)).toBe("cancelled"); // unchanged — NOT flipped to fired
    expect(await historyTypes(id)).not.toContain("timerFired");
  });
});
