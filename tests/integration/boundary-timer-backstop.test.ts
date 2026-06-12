import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, leaseOne, mintWorkerToken, publishAndStart } from "../helpers";
import { runInstance } from "../../src/runtime/engine";
import type { RunStep, WaitForEvent } from "../../src/runtime/engine";

// Workflow-mode lost-alarm BACKSTOP in direct mode (TASK-44 review fix; design
// §4.2, risk R5). `settleOverdueBoundaryTimerOnWake` (commit a6fc248) was the
// believed-untestable Workflow-mode-only path: when a timer-guarded wait wakes on
// a TIMEOUT (a lost/failed DO alarm), the engine settles an overdue timer INLINE
// instead of blindly re-parking. The reviewer found it IS reachable in direct
// mode — the only CI mode — via the SAME seam wait-cap-incidents.test.ts uses for
// the un-guarded wait caps: drive `runInstance` with a `waitFor` stub that returns
// a timeout, forcing the `outcome.kind === "timeout"` branch of forward-task.ts.
//
// This is DISTINCT from boundary-timer.test.ts, which exercises the PRIMARY
// DO-alarm fire path (runDurableObjectAlarm). Here we cover the inline settle the
// engine runs on the timeout-WAKE, proving the R5 promise: a timer-guarded wait
// NEVER raises waitTimeout, even on a (lost-alarm) timeout wake.
//
// Seam note: direct mode normally PARKS (waitFor=null) and never times out; these
// tests pass waitFor=timeoutWait so the timeout branch runs and calls
// settleOverdueBoundaryTimerOnWake. The boundary timer routes to an END event (not
// another service task) deliberately — under a timeout-returning drive every
// service-task wait would itself cap with waitTimeout, so a second guarded task
// would muddy the "no waitTimeout incident" assertion; an end event lets the fired
// token run to completion cleanly.

const inline: RunStep = (_name, fn) => fn();
const timeoutWait: WaitForEvent = async () => ({ kind: "timeout" });

// Start → slow (service task `slow`, timer boundary tb PT5M → onTimeout END) → E END.
function svcBackstopBpmn(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_bk_svc" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:serviceTask id="slow"><bpmn:extensionElements><easy-bpmn:taskDefinition type="slow" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:boundaryEvent id="tb" attachedToRef="slow"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    <bpmn:endEvent id="onTimeout"/>
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="slow"/>
    <bpmn:sequenceFlow id="s1" sourceRef="slow" targetRef="E"/>
    <bpmn:sequenceFlow id="tf" sourceRef="tb" targetRef="onTimeout"/>
  </bpmn:process>
</bpmn:definitions>`;
}

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
async function historyEventTypes(instanceId: string): Promise<string[]> {
  const h = await get(`/instances/${instanceId}/history`);
  return (h.body.events as any[]).map((e) => e.type);
}

const PAST = "2000-01-01T00:00:00Z";
// Clearly in the future, but under workerd's ~year-2189 setAlarm cap so the
// reparked self-heal re-arm (armTimerDO) does not throw inside the JobScheduler DO.
const FUTURE = "2100-01-01T00:00:00Z";

describe("Workflow-mode lost-alarm backstop in direct mode (TASK-44 review fix; design §4.2, risk R5)", () => {
  it("an OVERDUE timer fires INLINE on a timeout-wake — boundary path taken, NO waitTimeout incident", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(svcBackstopBpmn(), { correlationKey: `bk-fire-${crypto.randomUUID()}`, variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting"); // parked at slow: job created, timer armed

    // The host wait is in-flight (a worker holds the lease but has not resolved).
    await leaseOne(token, "slow");
    // The deadline elapsed but the DO alarm was LOST: force the armed timer overdue.
    const timer = await theTimer(id);
    expect(timer.status).toBe("armed");
    await setFireAt(timer.timer_id, PAST);

    // Drive with a timeout-returning waitFor — the Workflow-mode TIMEOUT-wake seam.
    // (If a6fc248's branch were reverted to a blind re-park, this returns "waiting"
    // with no fire and every assertion below fails — that is what proves the seam
    // genuinely exercises settleOverdueBoundaryTimerOnWake.)
    const result = await runInstance(env, id, { runStep: inline, waitFor: timeoutWait });
    expect(result.status).toBe("completed");

    // The token took the boundary path, settled INLINE by the backstop (not an alarm).
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.currentElementId).toBe("onTimeout");
    expect(inst.body.timers?.find((t: any) => t.elementId === "tb")?.status).toBe("fired");
    expect(await timerOutcome(timer.timer_id)).toBe("fired");

    // R5 promise: a timer-guarded wait NEVER raises waitTimeout, even on a (lost-
    // alarm) timeout wake. A timerFired event exists; NO incident was written.
    const types = await historyEventTypes(id);
    expect(types).toContain("timerFired");
    expect(types).not.toContain("incidentCreated");
  });

  it("an EARLY/spurious timeout-wake REPARKS (re-arms the DO) — no fire, no incident", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(svcBackstopBpmn(), { correlationKey: `bk-early-${crypto.randomUUID()}`, variables: {} });
    const id = instance.body.instanceId;

    await leaseOne(token, "slow");
    const timer = await theTimer(id);
    await setFireAt(timer.timer_id, FUTURE); // NOT yet due → the wake is early/spurious

    const result = await runInstance(env, id, { runStep: inline, waitFor: timeoutWait });
    expect(result.status).toBe("waiting"); // reparked, NOT fired

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("waiting");
    expect(inst.body.currentElementId).toBe("slow");
    expect(inst.body.timers?.find((t: any) => t.elementId === "tb")?.status).toBe("armed"); // still armed
    expect(await timerOutcome(timer.timer_id)).toBeNull(); // no decider row — never fired

    const types = await historyEventTypes(id);
    expect(types).not.toContain("timerFired");
    expect(types).not.toContain("incidentCreated");
  });

  it("a timer already DECIDED 'cancelled' falls THROUGH on a timeout-wake — never re-fires", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(svcBackstopBpmn(), { correlationKey: `bk-cancel-${crypto.randomUUID()}`, variables: {} });
    const id = instance.body.instanceId;

    await leaseOne(token, "slow");
    const timer = await theTimer(id);
    // Simulate a concurrent NORMAL resolution that already settled the decider
    // 'cancelled' (in real life its transition rode the same batch). The host wait
    // is still non-terminal here, so even an OVERDUE timeout-wake must fall through
    // to normal handling — a decided-cancelled timer must NEVER fire.
    await env.DB.prepare(`INSERT INTO timer_outcomes (timer_id, outcome, decided_at) VALUES (?, 'cancelled', ?)`).bind(timer.timer_id, PAST).run();
    await env.DB.prepare(`UPDATE timers SET status = 'cancelled' WHERE timer_id = ?`).bind(timer.timer_id).run();
    await setFireAt(timer.timer_id, PAST);

    const result = await runInstance(env, id, { runStep: inline, waitFor: timeoutWait });
    expect(result.status).toBe("waiting"); // fell through → host job still locked → re-park

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("waiting");
    expect(inst.body.currentElementId).toBe("slow");
    expect(await timerOutcome(timer.timer_id)).toBe("cancelled"); // unchanged — NOT flipped to fired

    const types = await historyEventTypes(id);
    expect(types).not.toContain("timerFired");
    expect(types).not.toContain("incidentCreated");
  });
});
