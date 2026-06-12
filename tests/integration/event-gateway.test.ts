import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, leaseAndComplete, mintWorkerToken, post, publishAndStart, publishMessage } from "../helpers";
import { resumeInline } from "../../src/runtime/engine";

// eventBasedGateway runtime end-to-end (M3-L4, TASK-46; design §4.5, §7 gate 5).
// The EBG races a message branch against a timer branch (or two message
// branches), deciding on a SINGLE gateway_decisions row claimed by a plain
// INSERT. Exercised in direct mode with the REAL D1 + broker + Scheduler DO
// (runDurableObjectAlarm), both race orders, plus the early-buffered and
// two-buffered tie-break paths.

const svc = (id: string, type: string) =>
  `<bpmn:serviceTask id="${id}"><bpmn:extensionElements><easy-bpmn:taskDefinition type="${type}"/></bpmn:extensionElements></bpmn:serviceTask>`;

// S → EBG → { onApprove (message "EbgApprove") → approved , onTimer (timer PT5M) → timedOut } → E.
const TIMER_MSG_EBG = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_ebg1" targetNamespace="x">
  <bpmn:message id="MA" name="EbgApprove"/>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:eventBasedGateway id="EBG"/>
    <bpmn:intermediateCatchEvent id="onApprove"><bpmn:messageEventDefinition messageRef="MA"/></bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="onTimer"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>
    ${svc("approved", "ebg-approved")}
    ${svc("timedOut", "ebg-timedout")}
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="EBG"/>
    <bpmn:sequenceFlow id="e1" sourceRef="EBG" targetRef="onApprove"/>
    <bpmn:sequenceFlow id="e2" sourceRef="EBG" targetRef="onTimer"/>
    <bpmn:sequenceFlow id="m1" sourceRef="onApprove" targetRef="approved"/>
    <bpmn:sequenceFlow id="m2" sourceRef="onTimer" targetRef="timedOut"/>
    <bpmn:sequenceFlow id="z1" sourceRef="approved" targetRef="E"/>
    <bpmn:sequenceFlow id="z2" sourceRef="timedOut" targetRef="E"/>
  </bpmn:process>
</bpmn:definitions>`;

// S → EBG → { onA (message "EbgA") → afterA , onB (message "EbgB") → afterB } → E.
const TWO_MSG_EBG = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_ebg2" targetNamespace="x">
  <bpmn:message id="MA" name="EbgA"/>
  <bpmn:message id="MB" name="EbgB"/>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:eventBasedGateway id="EBG"/>
    <bpmn:intermediateCatchEvent id="onA"><bpmn:messageEventDefinition messageRef="MA"/></bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="onB"><bpmn:messageEventDefinition messageRef="MB"/></bpmn:intermediateCatchEvent>
    ${svc("afterA", "ebg-a")}
    ${svc("afterB", "ebg-b")}
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="EBG"/>
    <bpmn:sequenceFlow id="e1" sourceRef="EBG" targetRef="onA"/>
    <bpmn:sequenceFlow id="e2" sourceRef="EBG" targetRef="onB"/>
    <bpmn:sequenceFlow id="m1" sourceRef="onA" targetRef="afterA"/>
    <bpmn:sequenceFlow id="m2" sourceRef="onB" targetRef="afterB"/>
    <bpmn:sequenceFlow id="z1" sourceRef="afterA" targetRef="E"/>
    <bpmn:sequenceFlow id="z2" sourceRef="afterB" targetRef="E"/>
  </bpmn:process>
</bpmn:definitions>`;

async function historyTypes(instanceId: string): Promise<string[]> {
  const h = await get(`/instances/${instanceId}/history`);
  return (h.body.events as any[]).map((e) => e.type);
}
async function subStatus(instanceId: string, elementId: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT status FROM message_subscriptions WHERE instance_id = ? AND element_id = ?`).bind(instanceId, elementId).first<{ status: string }>();
  return r?.status ?? null;
}
async function gwDecision(instanceId: string): Promise<{ chosen_flow_id: string } | null> {
  return env.DB.prepare(`SELECT chosen_flow_id FROM gateway_decisions WHERE instance_id = ? AND element_id = 'EBG'`).bind(instanceId).first<{ chosen_flow_id: string }>();
}
function timerStub(timerId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`timer:${timerId}`));
}
async function ebgTimer(instanceId: string): Promise<any> {
  return env.DB.prepare(`SELECT * FROM timers WHERE instance_id = ? AND kind = 'eventGateway' LIMIT 1`).bind(instanceId).first<any>();
}
async function fireEbgTimerNow(instanceId: string): Promise<string> {
  const t = await ebgTimer(instanceId);
  await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(t.timer_id).run();
  const ran = await runDurableObjectAlarm(timerStub(t.timer_id));
  expect(ran).toBe(true);
  return t.timer_id;
}

describe("eventBasedGateway — message wins (M3-L4 §7 gate 5)", () => {
  it("parks racing a message + a timer branch, then a message correlates and advances down its branch", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(TIMER_MSG_EBG, { correlationKey: "ebg-msg", variables: {} });
    const id = instance.body.instanceId;

    // Parked at the EBG: an ACTIVE subscription for the message branch + an armed
    // timer for the timer branch; one waiting marker.
    expect(instance.body.status).toBe("waiting");
    expect(instance.body.currentElementId).toBe("EBG");
    expect(await subStatus(id, "onApprove")).toBe("active");
    const t = await ebgTimer(id);
    expect(t.status).toBe("armed");
    expect(t.gateway_id).toBe("EBG");
    expect(await historyTypes(id)).toContain("eventBasedGatewayWaiting");
    // §4.5 storage: the branch subscription stores the per-VISIT GATEWAY wake type
    // (not the per-message type), so one waitForEvent is woken by any branch — this
    // is the value the workflow-mode delivery path honors.
    const subType = await env.DB.prepare(`SELECT workflow_event_type FROM message_subscriptions WHERE instance_id = ? AND element_id = 'onApprove'`).bind(id).first<{ workflow_event_type: string }>();
    expect(subType?.workflow_event_type).toBe("bpmn_ebg_EBG_0");

    // The message wins: payload merged atomically with the transition to its branch.
    const pub = await publishMessage({ messageName: "EbgApprove", correlationKey: "ebg-msg", messageId: "ebg-msg-1", payload: { approver: "ada" } });
    expect(pub.body.outcome).toBe("correlated");

    const advanced = await get(`/instances/${id}`);
    expect(advanced.body.currentElementId).toBe("approved");
    expect(advanced.body.variables.approver).toBe("ada");
    const types = await historyTypes(id);
    expect(types).toContain("messageCorrelated");
    expect(types).toContain("ebgDecision");
    expect(types).not.toContain("incidentCreated");
    // The decision recorded the message branch; the timer was cancelled (bookkeeping,
    // NO timer_outcomes row — gateway_decisions is its sole decider).
    expect((await gwDecision(id))?.chosen_flow_id).toBe("e1");
    expect((await ebgTimer(id)).status).toBe("cancelled");
    const outcomeRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM timer_outcomes WHERE timer_id = ?`).bind(t.timer_id).first<{ n: number }>();
    expect(outcomeRow?.n).toBe(0);

    await leaseAndComplete(token, "ebg-approved", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  it("a stray timer alarm AFTER the message won is a no-op (loser fireTimer converts)", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(TIMER_MSG_EBG, { correlationKey: "ebg-msg-then-timer", variables: {} });
    const id = instance.body.instanceId;
    await publishMessage({ messageName: "EbgApprove", correlationKey: "ebg-msg-then-timer", messageId: "ebg-mt-1", payload: {} });
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("approved");

    // Force the (now bookkeeping-cancelled) timer overdue and fire its alarm: the
    // decision already exists → planEventGatewayTimerFire skips → no second advance.
    const t = await ebgTimer(id);
    await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(t.timer_id).run();
    await runDurableObjectAlarm(timerStub(t.timer_id));
    const after = await get(`/instances/${id}`);
    expect(after.body.currentElementId).toBe("approved");
    expect(await historyTypes(id)).not.toContain("timerFired");
    expect((await gwDecision(id))?.chosen_flow_id).toBe("e1");

    await leaseAndComplete(token, "ebg-approved", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});

describe("eventBasedGateway — timer wins (M3-L4 §7 gate 5)", () => {
  it("the timer fires first → advances down the timer branch; the message subscription is superseded", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(TIMER_MSG_EBG, { correlationKey: "ebg-timer", variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.currentElementId).toBe("EBG");

    const timerId = await fireEbgTimerNow(id);

    const advanced = await get(`/instances/${id}`);
    expect(advanced.body.currentElementId).toBe("timedOut");
    const types = await historyTypes(id);
    expect(types).toContain("timerFired");
    expect(types).toContain("ebgDecision");
    expect(types).not.toContain("incidentCreated");
    // The timer branch won; the message subscription was superseded.
    expect((await gwDecision(id))?.chosen_flow_id).toBe("e2");
    expect(await subStatus(id, "onApprove")).toBe("superseded");
    expect((await get(`/instances/${id}`)).body.timers?.find((t: any) => t.elementId === "onTimer")?.status).toBe("fired");
    expect(timerId).toContain("onTimer");

    await leaseAndComplete(token, "ebg-timedout", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  it("a late publish to the superseded message branch does NOT advance a second time (loser message)", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(TIMER_MSG_EBG, { correlationKey: "ebg-timer-then-msg", variables: {} });
    const id = instance.body.instanceId;
    await fireEbgTimerNow(id);
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("timedOut");

    // The message branch's broker subscription was superseded → a late publish gets
    // buffered/no-match (NOT correlated), and the instance stays on the timer path.
    const late = await publishMessage({ messageName: "EbgApprove", correlationKey: "ebg-timer-then-msg", messageId: "ebg-tm-1", payload: {} });
    expect(late.body.outcome).not.toBe("correlated");
    const stable = await get(`/instances/${id}`);
    expect(stable.body.currentElementId).toBe("timedOut");
    expect((await gwDecision(id))?.chosen_flow_id).toBe("e2");

    await leaseAndComplete(token, "ebg-timedout", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});

describe("eventBasedGateway — early-buffered + tie-break (M3-L4 §7 gate 5)", () => {
  it("an early-buffered message is claimed at registration and the EBG advances immediately", async () => {
    const token = await mintWorkerToken();
    const early = await publishMessage({ messageName: "EbgApprove", correlationKey: "ebg-early", messageId: "ebg-early-1", payload: { approver: "early" } });
    expect(early.body.outcome).toBe("buffered");

    const { instance } = await publishAndStart(TIMER_MSG_EBG, { correlationKey: "ebg-early", variables: {} });
    const id = instance.body.instanceId;
    // The message branch correlated during the start drive → no park, advanced.
    expect(instance.body.currentElementId).toBe("approved");
    expect(instance.body.variables.approver).toBe("early");
    expect((await gwDecision(id))?.chosen_flow_id).toBe("e1");
    expect(await historyTypes(id)).toContain("ebgDecision");

    await leaseAndComplete(token, "ebg-approved", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  it("TWO buffered branches resolve by MODEL DOCUMENT ORDER (first branch wins), not publish order", async () => {
    const token = await mintWorkerToken();
    // Publish branch B's message FIRST (chronologically), then branch A's.
    await publishMessage({ messageName: "EbgB", correlationKey: "ebg-tie", messageId: "ebg-tie-b", payload: { who: "B" } });
    await publishMessage({ messageName: "EbgA", correlationKey: "ebg-tie", messageId: "ebg-tie-a", payload: { who: "A" } });

    // Start: branches register in document order (onA = e1 first) → A is claimed,
    // even though B's message was published first.
    const { instance } = await publishAndStart(TWO_MSG_EBG, { correlationKey: "ebg-tie", variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.currentElementId).toBe("afterA");
    expect(instance.body.variables.who).toBe("A");
    expect((await gwDecision(id))?.chosen_flow_id).toBe("e1");
    // Branch B's subscription was superseded (its buffered message lapses unmatched).
    expect(await subStatus(id, "onB")).toBe("superseded");

    await leaseAndComplete(token, "ebg-a", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});

describe("eventBasedGateway — operator /cancel during the race", () => {
  it("operator /cancel settles the armed timer branch; a stray alarm afterwards is a no-op", async () => {
    const { instance } = await publishAndStart(TIMER_MSG_EBG, { correlationKey: "ebg-cancel", variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.currentElementId).toBe("EBG");
    const t = await ebgTimer(id);
    expect(t.status).toBe("armed");

    // Empty ledger → terminal cancel; the shared sweep settles the armed EBG timer.
    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.body.status).toBe("cancelled");
    expect((await ebgTimer(id)).status).toBe("cancelled");

    // A stray alarm now finds a decided/terminal instance → no-op (never advances,
    // never records an EBG decision).
    await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(t.timer_id).run();
    await runDurableObjectAlarm(timerStub(t.timer_id));
    const stable = await get(`/instances/${id}`);
    expect(stable.body.status).toBe("cancelled");
    expect(stable.body.currentElementId).toBe("EBG");
    expect(await gwDecision(id)).toBeNull();
    expect(await historyTypes(id)).not.toContain("ebgDecision");
  });
});

describe("eventBasedGateway — rewalk fast-forward (M3-L4 AC#1: replay-stable)", () => {
  it("a decided EBG re-derives the cursor from the gateway_decisions row, write-free", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(TIMER_MSG_EBG, { correlationKey: "ebg-ff", variables: {} });
    const id = instance.body.instanceId;

    // ARMED fast-forward: a rewalk while parked re-registers idempotently — still
    // parked, no duplicate waiting marker, exactly one timer row.
    await resumeInline(env, id);
    const reparked = await get(`/instances/${id}`);
    expect(reparked.body.currentElementId).toBe("EBG");
    expect((await historyTypes(id)).filter((t) => t === "eventBasedGatewayWaiting")).toHaveLength(1);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM timers WHERE instance_id = ?`).bind(id).first<{ n: number }>();
    expect(n?.n).toBe(1);

    // Resolve via message, then rewalk: the decision row re-derives the cursor with
    // no new decision/history rows.
    await publishMessage({ messageName: "EbgApprove", correlationKey: "ebg-ff", messageId: "ebg-ff-1", payload: {} });
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("approved");
    await resumeInline(env, id);
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("approved");
    expect((await historyTypes(id)).filter((t) => t === "ebgDecision")).toHaveLength(1);

    await leaseAndComplete(token, "ebg-approved", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});
