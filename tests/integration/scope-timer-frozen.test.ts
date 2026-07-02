import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedPost, drainSampleWorkers, get, leaseAndComplete, mintWorkerToken, post, publishAndStart } from "../helpers";
import { resumeInline } from "../../src/runtime/engine";

// TASK-73 (M5-L1 follow-up, PR #4 review finding #4): an armed scope timer that
// comes due while the instance is FROZEN (parked out of the running|waiting lane
// into `incident` / `compensating` by a path the arming logic never observed — a
// sibling/inner technical failure or an operator action) must NOT silently
// unfreeze/interrupt the instance. Policy (owner-decided): record-and-apply-at-
// resume — the fire is recorded in the existing `timer_outcomes` decider with a
// suppressed audit and NO transition; at operator /retry → resume → rewalk,
// `timerHasFired` fast-forwards the walk onto the boundary path and drains the
// interrupted scope's stragglers, so the deadline is applied AFTER the freeze
// clears, never violating it.

/** A transaction whose inner service task fails TECHNICALLY (always-fail) → Hazard
 *  incident, with a PT1S boundary timer on the transaction itself. */
const TX_TIMER_FAIL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="def_tx_timer_fail" targetNamespace="http://example.com">
  <bpmn:process id="proc_tx_timer_fail" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="TX"/>
    <bpmn:transaction id="TX">
      <bpmn:startEvent id="t_start"/>
      <bpmn:sequenceFlow id="tf1" sourceRef="t_start" targetRef="innerFail"/>
      <bpmn:serviceTask id="innerFail"><bpmn:extensionElements><easy-bpmn:taskDefinition type="always-fail" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="tf2" sourceRef="innerFail" targetRef="t_end"/>
      <bpmn:endEvent id="t_end"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="TX_timer" attachedToRef="TX"><bpmn:timerEventDefinition><bpmn:timeDuration>PT1S</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="TX_timer" targetRef="afterTimer"/>
    <bpmn:serviceTask id="afterTimer"><bpmn:extensionElements><easy-bpmn:taskDefinition type="afterTimer" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="afterTimer" targetRef="after_end"/>
    <bpmn:endEvent id="after_end"/>
    <bpmn:sequenceFlow id="f4" sourceRef="TX" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;

/** A plain (non-transaction) subProcess variant of the same shape — inner task
 *  fails technically → incident; PT1S boundary timer on the subProcess. */
const SUBPROC_TIMER_FAIL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="def_sp_timer_fail" targetNamespace="http://example.com">
  <bpmn:process id="proc_sp_timer_fail" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="SP"/>
    <bpmn:subProcess id="SP">
      <bpmn:startEvent id="sp_start"/>
      <bpmn:sequenceFlow id="sf1" sourceRef="sp_start" targetRef="spFail"/>
      <bpmn:serviceTask id="spFail"><bpmn:extensionElements><easy-bpmn:taskDefinition type="always-fail" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="sf2" sourceRef="spFail" targetRef="sp_end"/>
      <bpmn:endEvent id="sp_end"/>
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="SP_timer" attachedToRef="SP"><bpmn:timerEventDefinition><bpmn:timeDuration>PT1S</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="SP_timer" targetRef="afterTimer"/>
    <bpmn:serviceTask id="afterTimer"><bpmn:extensionElements><easy-bpmn:taskDefinition type="afterTimer" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="afterTimer" targetRef="after_end"/>
    <bpmn:endEvent id="after_end"/>
    <bpmn:sequenceFlow id="f4" sourceRef="SP" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;

function timerStub(timerId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`timer:${timerId}`));
}

async function theTimer(instanceId: string): Promise<any> {
  return env.DB.prepare(`SELECT * FROM timers WHERE instance_id = ? ORDER BY created_at LIMIT 1`).bind(instanceId).first<any>();
}

async function timerOutcome(timerId: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT outcome FROM timer_outcomes WHERE timer_id = ?`).bind(timerId).first<{ outcome: string }>();
  return r?.outcome ?? null;
}

/** Force the armed scope-hosted timer overdue, then fire its DO alarm. */
async function fireDueBoundaryTimer(instanceId: string): Promise<string> {
  const t = await theTimer(instanceId);
  await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(t.timer_id).run();
  const ran = await runDurableObjectAlarm(timerStub(t.timer_id));
  expect(ran).toBe(true);
  return t.timer_id;
}

async function getInstanceRow(instanceId: string) {
  return env.DB.prepare(`SELECT status, current_element_id FROM process_instances WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ status: string; current_element_id: string | null }>();
}

/** The status of an in-flight (or settled) forward job of `taskType`, or null. */
async function forwardJobStatus(instanceId: string, taskType: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT status FROM service_task_jobs WHERE instance_id = ? AND task_type = ? AND is_compensation = 0 ORDER BY rowid DESC LIMIT 1`,
  )
    .bind(instanceId, taskType)
    .first<{ status: string }>();
  return r?.status ?? null;
}

async function timerFiredEvents(instanceId: string): Promise<any[]> {
  const hist = await get(`/instances/${instanceId}/history`);
  return (hist.body.events as any[]).filter((e) => e.type === "timerFired");
}

/** Drive a fixture to a Hazard incident on its always-fail inner task. */
async function startFrozenAtInnerIncident(bpmn: string, correlationKey: string): Promise<{ instanceId: string; innerId: string }> {
  const { instance } = await publishAndStart(bpmn, { correlationKey: `${correlationKey}-${crypto.randomUUID()}`, variables: {} });
  const instanceId = instance.body.instanceId as string;
  await drainSampleWorkers({ taskTypes: ["always-fail"], maxRounds: 80 });
  const inst = await get(`/instances/${instanceId}`);
  expect(inst.body.status).toBe("incident");
  const innerId = inst.body.incident.elementId as string;
  // The scope's boundary timer is still armed (the incident froze the instance by a
  // path the arming logic never observed — it was NOT disarmed).
  expect((await theTimer(instanceId)).status).toBe("armed");
  return { instanceId, innerId };
}

describe("TASK-73 scope timer fires on a frozen instance — record-and-apply-at-resume", () => {
  it("[TASK-73] TX timer due while `incident`: suppressed record, no transition, then /retry applies it and drains the scope", async () => {
    const token = await mintWorkerToken();
    const { instanceId } = await startFrozenAtInnerIncident(TX_TIMER_FAIL_BPMN, "tx73-incident");

    const before = await getInstanceRow(instanceId);
    const timerId = await fireDueBoundaryTimer(instanceId);

    // Suppressed record: the fire is decided `fired` (single-decide) but NOTHING
    // else — the instance stays `incident`, the cursor never moved to afterTimer.
    expect(await timerOutcome(timerId)).toBe("fired");
    const frozen = await getInstanceRow(instanceId);
    expect(frozen!.status).toBe("incident");
    expect(frozen!.current_element_id).toBe(before!.current_element_id);
    expect(frozen!.current_element_id).not.toBe("afterTimer");

    // Audit: a `timerFired` event tagged `suppressed: true`, and NO `scopeExited`
    // for TX (the scope was NOT interrupted while frozen).
    const fired = await timerFiredEvents(instanceId);
    expect(fired).toHaveLength(1);
    expect(fired[0].diagnostics.suppressed).toBe(true);
    const hist = await get(`/instances/${instanceId}/history`);
    expect((hist.body.events as any[]).some((e) => e.type === "scopeExited" && e.elementId === "TX")).toBe(false);

    // Operator resolves the inner incident and retries → resume rewalk fast-forwards
    // onto the boundary path (timerHasFired) and drains the interrupted scope.
    const retry = await post(`/instances/${instanceId}/retry`, {});
    expect(retry.status).toBe(200);

    const resumed = await getInstanceRow(instanceId);
    expect(resumed!.current_element_id).toBe("afterTimer");
    expect(resumed!.status).not.toBe("incident");

    // The interrupted scope's straggler (the inner job re-created by /retry) is
    // settled — NOT left leasable inside the drained scope.
    expect(["failed", "cancelled", null]).toContain(await forwardJobStatus(instanceId, "always-fail"));

    // The boundary continuation is reachable and completes the instance.
    await leaseAndComplete(token, "afterTimer", {});
    expect((await getInstanceRow(instanceId))!.status).toBe("completed");
  });

  it("[TASK-73] AC#5 fire wins then /cancel: single decide, no double-transition, never routes to afterTimer", async () => {
    const token = await mintWorkerToken();
    const { instanceId } = await startFrozenAtInnerIncident(TX_TIMER_FAIL_BPMN, "tx73-cancel-fire-first");

    // The suppressed fire lands FIRST (records `fired`).
    const timerId = await fireDueBoundaryTimer(instanceId);
    expect(await timerOutcome(timerId)).toBe("fired");
    expect((await getInstanceRow(instanceId))!.current_element_id).not.toBe("afterTimer");

    // A concurrent operator /cancel then proceeds on the post-fire state — the sweep
    // sees the timer already decided and does NOT double-decide; the instance
    // compensates normally rather than routing down the timer path.
    const cancel = await post(`/instances/${instanceId}/cancel`, {});
    expect(cancel.status).toBe(200);
    await resumeInline(env, instanceId);
    expect(await timerOutcome(timerId)).toBe("fired"); // unchanged — single-decide held
    expect((await getInstanceRow(instanceId))!.current_element_id).not.toBe("afterTimer");
    expect(["compensating", "compensated", "cancelled"]).toContain((await getInstanceRow(instanceId))!.status);

    // A late alarm on the decided timer is an idempotent no-op.
    await runDurableObjectAlarm(timerStub(timerId));
    expect((await getInstanceRow(instanceId))!.current_element_id).not.toBe("afterTimer");
    void token;
  });

  it("[TASK-73] AC#5 cancel wins first: the late alarm no-ops (existing decider guard)", async () => {
    const { instanceId } = await startFrozenAtInnerIncident(TX_TIMER_FAIL_BPMN, "tx73-cancel-first");
    const timerId = (await theTimer(instanceId)).timer_id;

    // /cancel sweeps the still-armed timer to `cancelled` before the alarm fires.
    const cancel = await post(`/instances/${instanceId}/cancel`, {});
    expect(cancel.status).toBe(200);
    await resumeInline(env, instanceId);
    expect(await timerOutcome(timerId)).toBe("cancelled");

    // The now-overdue alarm is an idempotent no-op (decided already) — no fired
    // record, never routes to afterTimer.
    await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(timerId).run();
    await runDurableObjectAlarm(timerStub(timerId));
    expect(await timerOutcome(timerId)).toBe("cancelled");
    expect((await getInstanceRow(instanceId))!.current_element_id).not.toBe("afterTimer");
  });

  it("[TASK-73] AC#6 subProcess host: timer due while `incident` is recorded suppressed, no transition", async () => {
    const { instanceId } = await startFrozenAtInnerIncident(SUBPROC_TIMER_FAIL_BPMN, "sp73-incident");
    const before = await getInstanceRow(instanceId);

    const timerId = await fireDueBoundaryTimer(instanceId);

    expect(await timerOutcome(timerId)).toBe("fired");
    const frozen = await getInstanceRow(instanceId);
    expect(frozen!.status).toBe("incident");
    expect(frozen!.current_element_id).toBe(before!.current_element_id);
    expect(frozen!.current_element_id).not.toBe("afterTimer");

    const fired = await timerFiredEvents(instanceId);
    expect(fired).toHaveLength(1);
    expect(fired[0].diagnostics.suppressed).toBe(true);
  });
});
