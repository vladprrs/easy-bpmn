import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, leaseAndComplete, mintWorkerToken, post, publishAndStart } from "../helpers";
import { resumeInline } from "../../src/runtime/engine";

// Intermediate timer catch runtime end-to-end (M3-L4, TASK-45; design §4.4, §7
// gate 4). The DO-alarm → fireTimer → claim/abort → D1 path is the primary
// mechanism in BOTH modes; here it is exercised in direct mode via
// runDurableObjectAlarm. Unlike a boundary timer, the catch IS the wait — there
// is no host job/subscription, and the single outgoing flow is the delay's
// continuation (not a separate "timeout path").

const svc = (id: string, type: string) =>
  `<bpmn:serviceTask id="${id}"><bpmn:extensionElements><easy-bpmn:taskDefinition type="${type}"/></bpmn:extensionElements></bpmn:serviceTask>`;

// Process level: S → catch (timer PT5M) → after (service) → E.
const PROCESS_CATCH_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_ic" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:intermediateCatchEvent id="catch"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>
    ${svc("after", "after-delay")}
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="catch"/>
    <bpmn:sequenceFlow id="s1" sourceRef="catch" targetRef="after"/>
    <bpmn:sequenceFlow id="s2" sourceRef="after" targetRef="E"/>
  </bpmn:process>
</bpmn:definitions>`;

// Transaction saga: Tx[ TxS → reserve (compensatable) → catch (timer) → TxE ].
const TX_CATCH_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_txic" targetNamespace="x">
  <bpmn:process id="CatchSaga" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx">
      <bpmn:startEvent id="TxS"/>
      ${svc("reserve", "reserve")}
      <bpmn:boundaryEvent id="reserve_comp" attachedToRef="reserve"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="release" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="release"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:association id="a1" associationDirection="One" sourceRef="reserve_comp" targetRef="release"/>
      <bpmn:intermediateCatchEvent id="catch"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>
      <bpmn:endEvent id="TxE"/>
      <bpmn:sequenceFlow id="t1" sourceRef="TxS" targetRef="reserve"/>
      <bpmn:sequenceFlow id="t2" sourceRef="reserve" targetRef="catch"/>
      <bpmn:sequenceFlow id="t3" sourceRef="catch" targetRef="TxE"/>
    </bpmn:transaction>
    <bpmn:endEvent id="Done"/>
    <bpmn:sequenceFlow id="g1" sourceRef="Start" targetRef="Tx"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="Done"/>
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
async function countTimerRows(instanceId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM timers WHERE instance_id = ?`).bind(instanceId).first<{ n: number }>();
  return r?.n ?? 0;
}
/** Force the armed timer overdue, then fire its DO alarm (the deadline elapsing stand-in). */
async function fireTimerNow(instanceId: string): Promise<string> {
  const t = await theTimer(instanceId);
  await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(t.timer_id).run();
  const ran = await runDurableObjectAlarm(timerStub(t.timer_id));
  expect(ran).toBe(true);
  return t.timer_id;
}
async function historyTypes(instanceId: string): Promise<string[]> {
  const h = await get(`/instances/${instanceId}/history`);
  return (h.body.events as any[]).map((e) => e.type);
}
async function entered(instanceId: string): Promise<string[]> {
  const h = await get(`/instances/${instanceId}/history`);
  return (h.body.events as any[]).filter((e) => e.type === "elementEntered").map((e) => e.elementId);
}

describe("Intermediate timer catch — process level (M3-L4 §7 gate 4)", () => {
  it("delays at the catch, then fires and advances down the single outgoing flow", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PROCESS_CATCH_BPMN, { correlationKey: "ic-1", variables: {} });
    const id = instance.body.instanceId;

    // Delaying: parked at the catch (the catch IS the wait), timer armed.
    expect(instance.body.status).toBe("waiting");
    expect(instance.body.currentElementId).toBe("catch");
    const timer = await theTimer(id);
    expect(timer.status).toBe("armed");
    expect(timer.kind).toBe("intermediateCatch");
    expect((await historyTypes(id))).toContain("timerArmed");
    expect((await historyTypes(id))).not.toContain("timerFired");

    // The deadline elapses → the catch fires and the token advances to `after`.
    const timerId = await fireTimerNow(id);
    expect(await timerOutcome(timerId)).toBe("fired");

    const advanced = await get(`/instances/${id}`);
    expect(advanced.body.currentElementId).toBe("after");
    expect(advanced.body.status).toBe("waiting");
    // A timerFired (modeled path), NEVER a waitTimeout incident.
    const types = await historyTypes(id);
    expect(types).toContain("timerFired");
    expect(types).not.toContain("incidentCreated");
    // inspection timers block: the catch is fired.
    expect(advanced.body.timers?.find((t: any) => t.elementId === "catch")?.status).toBe("fired");

    await leaseAndComplete(token, "after-delay", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});

describe("Intermediate timer catch — inside a transaction (M3-L4 §7 gate 4: scope stays open)", () => {
  it("the saga scope stays open across the delay; firing commits the transaction", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(TX_CATCH_BPMN, { correlationKey: "ic-tx", variables: {} });
    const id = instance.body.instanceId;

    await leaseAndComplete(token, "reserve", {}); // compensatable, ledger 'pending'
    const parked = await get(`/instances/${id}`);
    expect(parked.body.currentElementId).toBe("catch");
    expect(parked.body.status).toBe("waiting");
    // Scope OPEN across the delay: still forward, the reserve ledger row pending,
    // the transaction NOT yet committed.
    expect(parked.body.saga?.phase).toBe("forward");
    expect(parked.body.saga?.steps?.find((s: any) => s.elementId === "reserve")?.compensationStatus).toBe("pending");
    expect(await historyTypes(id)).not.toContain("transactionCommitted");

    await fireTimerNow(id); // → TxE → commit → Done
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
    const types = await historyTypes(id);
    expect(types).toContain("transactionCommitted");
    expect(types).toContain("timerFired");
    expect(types).not.toContain("compensationStarted"); // committed, never compensated
  });
});

describe("Intermediate timer catch — operator /cancel settlement (M3-L4 AC#2)", () => {
  it("operator /cancel during the catch park settles the timer; a stray alarm afterwards is a no-op", async () => {
    const { instance } = await publishAndStart(PROCESS_CATCH_BPMN, { correlationKey: "ic-cancel", variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.currentElementId).toBe("catch");
    const timer = await theTimer(id);
    expect(timer.status).toBe("armed");

    // Empty ledger → terminal cancel; the sweep settles the armed catch timer.
    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.body.status).toBe("cancelled");
    const settled = await theTimer(id);
    expect(settled.status).toBe("cancelled");
    expect(await timerOutcome(timer.timer_id)).toBe("cancelled");

    // A stray alarm now finds a decided (cancelled) timer → no-op (never advances).
    await runDurableObjectAlarm(timerStub(timer.timer_id));
    const stable = await get(`/instances/${id}`);
    expect(stable.body.status).toBe("cancelled");
    expect(await entered(id)).not.toContain("after");
    expect(await historyTypes(id)).not.toContain("timerFired");
  });
});

describe("Intermediate timer catch — rewalk fast-forward (M3-L4 AC#3)", () => {
  it("an armed catch re-parks idempotently; a fired catch is a write-free cursor move", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PROCESS_CATCH_BPMN, { correlationKey: "ic-ff", variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.currentElementId).toBe("catch");

    // ARMED fast-forward: a rewalk while parked re-parks + re-arms idempotently —
    // exactly ONE timer row and ONE timerArmed event, no duplicate, still parked.
    await resumeInline(env, id);
    const afterRewalk = await get(`/instances/${id}`);
    expect(afterRewalk.body.currentElementId).toBe("catch");
    expect(afterRewalk.body.status).toBe("waiting");
    expect(await countTimerRows(id)).toBe(1);
    expect((await historyTypes(id)).filter((t) => t === "timerArmed")).toHaveLength(1);

    // Fire → advance to `after` (parks there).
    const timerId = await fireTimerNow(id);
    expect(await timerOutcome(timerId)).toBe("fired");
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("after");
    const firedArmCount = (await historyTypes(id)).filter((t) => t === "timerFired").length;

    // FIRED fast-forward (write-free): a rewalk re-derives the cursor purely from
    // the `timer_outcomes='fired'` decider — no new timer/history writes for the
    // catch, still parked at `after`.
    await resumeInline(env, id);
    const afterFiredRewalk = await get(`/instances/${id}`);
    expect(afterFiredRewalk.body.currentElementId).toBe("after");
    expect(await countTimerRows(id)).toBe(1);
    expect((await historyTypes(id)).filter((t) => t === "timerFired")).toHaveLength(firedArmCount); // no duplicate fire
    expect((await historyTypes(id)).filter((t) => t === "timerArmed")).toHaveLength(1);

    await leaseAndComplete(token, "after-delay", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});
