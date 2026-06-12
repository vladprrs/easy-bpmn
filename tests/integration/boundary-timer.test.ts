import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  authedPost,
  get,
  leaseAndComplete,
  leaseOne,
  mintWorkerToken,
  post,
  publishAndStart,
  publishMessage,
} from "../helpers";

// Boundary-timer runtime end-to-end (M3-L3, TASK-44; design §4.3, §7 gates 1-6, 10).
// The DO-alarm → fireTimer → claim/abort → D1 path is the primary mechanism in BOTH
// modes and is fully exercised here in direct mode via runDurableObjectAlarm.

const svc = (id: string, type: string, retries?: string) =>
  `<bpmn:serviceTask id="${id}"><bpmn:extensionElements><easy-bpmn:taskDefinition type="${type}"${retries ? ` retries="${retries}"` : ""}/></bpmn:extensionElements></bpmn:serviceTask>`;
const timerBoundary = (id: string, host: string, target: string, dur = "PT5M") =>
  `<bpmn:boundaryEvent id="${id}" attachedToRef="${host}"><bpmn:timerEventDefinition><bpmn:timeDuration>${dur}</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
   <bpmn:sequenceFlow id="${id}_f" sourceRef="${id}" targetRef="${target}"/>`;

// Process-level service task `slow` guarded by a timer boundary → onTimeout.
function svcTimerBpmn(opts: { errorBoundary?: boolean } = {}): string {
  const err = opts.errorBoundary
    ? `<bpmn:boundaryEvent id="eb" attachedToRef="slow"><bpmn:errorEventDefinition errorRef="Err_boom"/></bpmn:boundaryEvent>
       <bpmn:sequenceFlow id="eb_f" sourceRef="eb" targetRef="errPath"/>
       ${svc("errPath", "err-path")}
       <bpmn:sequenceFlow id="ef" sourceRef="errPath" targetRef="E"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_svct" targetNamespace="x">
  <bpmn:error id="Err_boom" name="Boom" errorCode="BOOM"/>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    ${svc("slow", "slow", "1")}
    ${svc("onTimeout", "timeout-handler")}
    ${timerBoundary("tb", "slow", "onTimeout")}
    ${err}
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="slow"/>
    <bpmn:sequenceFlow id="s1" sourceRef="slow" targetRef="E"/>
    <bpmn:sequenceFlow id="af" sourceRef="onTimeout" targetRef="E"/>
  </bpmn:process>
</bpmn:definitions>`;
}

// Transaction saga: reserve (compensatable) → slow (timer → Tx_cancel) → Tx_ok.
const SAGA_TIMER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_sagat" targetNamespace="x">
  <bpmn:process id="TimerSaga" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx">
      <bpmn:startEvent id="Tx_start"/>
      ${svc("reserve", "reserve")}
      <bpmn:boundaryEvent id="reserve_comp" attachedToRef="reserve"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="release" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="release"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:association id="a1" associationDirection="One" sourceRef="reserve_comp" targetRef="release"/>
      ${svc("slow", "slow")}
      <bpmn:boundaryEvent id="tb" attachedToRef="slow"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
      <bpmn:endEvent id="Tx_ok"/>
      <bpmn:endEvent id="Tx_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      <bpmn:sequenceFlow id="t1" sourceRef="Tx_start" targetRef="reserve"/>
      <bpmn:sequenceFlow id="t2" sourceRef="reserve" targetRef="slow"/>
      <bpmn:sequenceFlow id="t3" sourceRef="slow" targetRef="Tx_ok"/>
      <bpmn:sequenceFlow id="tf" sourceRef="tb" targetRef="Tx_cancel"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="Tx_cancelled" attachedToRef="Tx"><bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:endEvent id="Done"/>
    <bpmn:endEvent id="Failed"/>
    <bpmn:sequenceFlow id="g1" sourceRef="Start" targetRef="Tx"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="Done"/>
    <bpmn:sequenceFlow id="g3" sourceRef="Tx_cancelled" targetRef="Failed"/>
  </bpmn:process>
</bpmn:definitions>`;

// Receive task `wait` (msg=Approval) guarded by a timer boundary → onTimeout.
const RECV_TIMER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_recvt" targetNamespace="x">
  <bpmn:message id="M" name="Approval"/>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:receiveTask id="wait" messageRef="M"/>
    ${svc("onTimeout", "timeout-handler")}
    <bpmn:boundaryEvent id="tb" attachedToRef="wait"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="wait"/>
    <bpmn:sequenceFlow id="s1" sourceRef="wait" targetRef="E"/>
    <bpmn:sequenceFlow id="tf" sourceRef="tb" targetRef="onTimeout"/>
    <bpmn:sequenceFlow id="af" sourceRef="onTimeout" targetRef="E"/>
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
/** Force the armed timer overdue, then fire its DO alarm (the test stand-in for the deadline elapsing). */
async function fireTimerNow(instanceId: string): Promise<string> {
  const t = await theTimer(instanceId);
  await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(t.timer_id).run();
  const ran = await runDurableObjectAlarm(timerStub(t.timer_id));
  expect(ran).toBe(true);
  return t.timer_id;
}
async function entered(instanceId: string): Promise<string[]> {
  const h = await get(`/instances/${instanceId}/history`);
  return h.body.events.filter((e: any) => e.type === "elementEntered").map((e: any) => e.elementId);
}

describe("Boundary timer on a service task (M3-L3 §7 gate 1)", () => {
  it("fires → alternate path taken; a late worker callback gets the stable no-op ack", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(svcTimerBpmn(), { correlationKey: "tim-1", variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting");

    // The worker leases `slow` (holds a lockToken) but has not completed yet.
    const slow = await leaseOne(token, "slow");

    // The timer fires → token routes down the boundary path; the slow job is abandoned.
    const timerId = await fireTimerNow(id);
    expect(await timerOutcome(timerId)).toBe("fired");

    const parked = await get(`/instances/${id}`);
    expect(parked.body.status).toBe("waiting");
    expect(parked.body.currentElementId).toBe("onTimeout");
    expect(await entered(id)).toContain("onTimeout");
    // inspection timers block (gate 7 API): tb is fired
    expect(parked.body.timers?.find((t: any) => t.elementId === "tb")?.status).toBe("fired");
    // a timerFired history event (NOT a waitTimeout incident)
    const hist = await get(`/instances/${id}/history`);
    expect(hist.body.events.some((e: any) => e.type === "timerFired")).toBe(true);
    expect(hist.body.events.some((e: any) => e.type === "incidentCreated")).toBe(false);

    // The late worker callback on the abandoned slow job → stable no-op ack.
    const late = await authedPost(`/jobs/${slow.jobId}/complete`, token, { lockToken: slow.lockToken, outputVariables: {} });
    expect(late.status).toBe(200);
    expect(late.body.outcome).toBe("noop");
    expect(late.body.disposition).toBe("ignored");

    // Finish the timer path.
    await leaseAndComplete(token, "timeout-handler", {});
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
  });
});

describe("Boundary timer inside a transaction → compensation (M3-L3 §7 gate 2)", () => {
  it("fires → cancel end → reverse compensation of the completed step", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(SAGA_TIMER_BPMN, { correlationKey: "tim-tx", variables: {} });
    const id = instance.body.instanceId;

    await leaseAndComplete(token, "reserve", {}); // compensatable, ledger 'pending'
    const parked = await get(`/instances/${id}`);
    expect(parked.body.currentElementId).toBe("slow");

    await fireTimerNow(id); // → Tx_cancel → begin compensation
    const comp = await get(`/instances/${id}`);
    expect(comp.body.status).toBe("compensating");

    await leaseAndComplete(token, "release", {}); // the compensation handler
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    const hist = await get(`/instances/${id}/history`);
    expect(hist.body.events.filter((e: any) => e.type === "compensationStarted").map((e: any) => e.elementId)).toEqual(["reserve"]);
  });
});

describe("Timer-vs-completion race, both orders (M3-L3 §7 gate 3)", () => {
  it("complete-first → the fire alarm is a no-op (timer cancelled by the completion)", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(svcTimerBpmn(), { correlationKey: "race-c", variables: {} });
    const id = instance.body.instanceId;

    await leaseAndComplete(token, "slow", {}); // normal completion → advance to E
    const after = await get(`/instances/${id}`);
    expect(after.body.status).toBe("completed");
    const timer = await theTimer(id);
    expect(timer.status).toBe("cancelled");
    expect(await timerOutcome(timer.timer_id)).toBe("cancelled");

    // A stray/late alarm now finds a decided (cancelled) timer → no-op.
    await runDurableObjectAlarm(timerStub(timer.timer_id));
    const stable = await get(`/instances/${id}`);
    expect(stable.body.status).toBe("completed");
    expect(await entered(id)).not.toContain("onTimeout");
  });

  it("fire-first → the late worker complete gets the superseded no-op ack", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(svcTimerBpmn(), { correlationKey: "race-f", variables: {} });
    const id = instance.body.instanceId;
    const slow = await leaseOne(token, "slow");

    const timerId = await fireTimerNow(id); // timer wins
    expect(await timerOutcome(timerId)).toBe("fired");

    const ack = await authedPost(`/jobs/${slow.jobId}/complete`, token, { lockToken: slow.lockToken, outputVariables: { x: 1 } });
    expect(ack.body.outcome).toBe("noop"); // superseded → stable no-op
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("onTimeout");

    // Drain the timer-path job so it does not leak into another test's FIFO lease
    // (worker leases are workspace-scoped, not instance-scoped).
    await leaseAndComplete(token, "timeout-handler", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});

describe("Boundary timer on a receive task (M3-L3 §7 gate 6/4)", () => {
  it("fires → subscription superseded; a late publish gets the stable buffered/no-match outcome", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(RECV_TIMER_BPMN, { correlationKey: "recv-t", variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting");
    expect(instance.body.currentElementId).toBe("wait");

    const timerId = await fireTimerNow(id); // supersede the active subscription
    expect(await timerOutcome(timerId)).toBe("fired");
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("onTimeout");

    // The subscription row is superseded (not active, not consumed-down-the-message-path).
    const sub = await env.DB.prepare(`SELECT status FROM message_subscriptions WHERE instance_id = ?`).bind(id).first<{ status: string }>();
    expect(sub?.status).toBe("superseded");

    await leaseAndComplete(token, "timeout-handler", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");

    // A late publish to the same broker key cannot correlate to the timed-out wait.
    const pub = await publishMessage({ messageName: "Approval", correlationKey: "recv-t", messageId: "late-1", payload: { ok: true } });
    expect(pub.body.outcome).toBe("buffered");
  });
});

describe("Abnormal-exit timer settlement (M3-L3 §7 gate 10)", () => {
  it("retry exhaustion cancels the armed timer; a stray alarm afterwards is a no-op", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(svcTimerBpmn(), { correlationKey: "ab-exh", variables: {} });
    const id = instance.body.instanceId;
    const slow = await leaseOne(token, "slow");
    // retryable=false → immediate exhaustion → Hazard incident.
    await authedPost(`/jobs/${slow.jobId}/fail`, token, { lockToken: slow.lockToken, reason: "boom", retryable: false });

    const inc = await get(`/instances/${id}`);
    expect(inc.body.status).toBe("incident");
    const timer = await theTimer(id);
    expect(timer.status).toBe("cancelled");

    await runDurableObjectAlarm(timerStub(timer.timer_id)); // stray alarm → no-op
    const stable = await get(`/instances/${id}`);
    expect(stable.body.status).toBe("incident");
    expect(await entered(id)).not.toContain("onTimeout");
  });

  it("a business-error route cancels the armed timer; a stray alarm afterwards is a no-op", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(svcTimerBpmn({ errorBoundary: true }), { correlationKey: "ab-err", variables: {} });
    const id = instance.body.instanceId;
    const slow = await leaseOne(token, "slow");
    await authedPost(`/jobs/${slow.jobId}/fail`, token, { lockToken: slow.lockToken, reason: "boom", errorCode: "BOOM" });

    expect(await entered(id)).toContain("errPath"); // routed down the error path
    const timer = await theTimer(id);
    expect(timer.status).toBe("cancelled");

    await runDurableObjectAlarm(timerStub(timer.timer_id)); // stray alarm → no-op
    expect(await entered(id)).not.toContain("onTimeout");

    await leaseAndComplete(token, "err-path", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  it("operator /cancel cancels the armed timer; no stray mid-compensation firing", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(SAGA_TIMER_BPMN, { correlationKey: "ab-cancel", variables: {} });
    const id = instance.body.instanceId;
    await leaseAndComplete(token, "reserve", {});
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("slow"); // timer armed

    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.body.status).toBe("compensating");
    const timer = await theTimer(id);
    expect(timer.status).toBe("cancelled");

    // A stray alarm mid-compensation must NOT fire the timer path.
    await runDurableObjectAlarm(timerStub(timer.timer_id));
    expect((await get(`/instances/${id}`)).body.status).toBe("compensating");

    await leaseAndComplete(token, "release", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("compensated");
    expect(await entered(id)).not.toContain("Tx_cancel"); // timer never routed
  });
});
