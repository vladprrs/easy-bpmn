import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, leaseAndComplete, mintWorkerToken, publishAndStart, publishMessage } from "../helpers";

// Standalone message intermediate catch runtime end-to-end (M3-L4, TASK-46;
// design §3 item 3, §7 gate 9). A `intermediateCatchEvent + messageEventDefinition`
// is a token-path node with IDENTICAL wait/correlation/resume semantics to a
// receiveTask — it REUSES the receive-task subscription/correlation/broker
// machinery (registerReceive / applyMessage / the correlation broker), exercised
// here with REAL D1 + the REAL broker (no mocks). Gate 9 requires correlation +
// advance in BOTH orders: publish-after (subscription waits, then the message
// arrives) and publish-before (early/buffered message claimed at registration).

const svc = (id: string, type: string) =>
  `<bpmn:serviceTask id="${id}"><bpmn:extensionElements><easy-bpmn:taskDefinition type="${type}"/></bpmn:extensionElements></bpmn:serviceTask>`;

// Process level: S → catch (message "CatchApproval") → after (service) → E.
const PROCESS_MSG_CATCH_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_mic" targetNamespace="x">
  <bpmn:message id="Msg" name="CatchApproval"/>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:intermediateCatchEvent id="catch"><bpmn:messageEventDefinition messageRef="Msg"/></bpmn:intermediateCatchEvent>
    ${svc("after", "after-catch")}
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="catch"/>
    <bpmn:sequenceFlow id="s1" sourceRef="catch" targetRef="after"/>
    <bpmn:sequenceFlow id="s2" sourceRef="after" targetRef="E"/>
  </bpmn:process>
</bpmn:definitions>`;

// Transaction saga: Tx[ TxS → reserve (compensatable) → catch (message) → TxE ].
const TX_MSG_CATCH_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_txmic" targetNamespace="x">
  <bpmn:message id="Msg" name="CatchApprovalTx"/>
  <bpmn:process id="CatchSaga" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx">
      <bpmn:startEvent id="TxS"/>
      ${svc("reserve", "reserve-mic")}
      <bpmn:boundaryEvent id="reserve_comp" attachedToRef="reserve"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="release" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="release-mic"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:association id="a1" associationDirection="One" sourceRef="reserve_comp" targetRef="release"/>
      <bpmn:intermediateCatchEvent id="catch"><bpmn:messageEventDefinition messageRef="Msg"/></bpmn:intermediateCatchEvent>
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

async function historyTypes(instanceId: string): Promise<string[]> {
  const h = await get(`/instances/${instanceId}/history`);
  return (h.body.events as any[]).map((e) => e.type);
}

describe("Message intermediate catch — process level, publish-AFTER (M3-L4 §7 gate 9)", () => {
  it("parks at the catch waiting on its subscription, then a later message correlates and advances", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PROCESS_MSG_CATCH_BPMN, { correlationKey: "mic-after", variables: {} });
    const id = instance.body.instanceId;

    // The catch IS the wait: parked at it, an ACTIVE subscription registered.
    expect(instance.body.status).toBe("waiting");
    expect(instance.body.currentElementId).toBe("catch");
    const sub = await env.DB.prepare(`SELECT status, element_id FROM message_subscriptions WHERE instance_id = ?`).bind(id).first<any>();
    expect(sub.element_id).toBe("catch");
    expect(sub.status).toBe("active");
    expect(await historyTypes(id)).not.toContain("incidentCreated");

    // A later message correlates (reusing the receive-task correlation path) and
    // the payload is applied ATOMICALLY with the transition out of the wait.
    const pub = await publishMessage({
      messageName: "CatchApproval",
      correlationKey: "mic-after",
      messageId: "mic-after-1",
      payload: { approved: true, approver: "ada" },
    });
    expect(pub.body.outcome).toBe("correlated");

    const advanced = await get(`/instances/${id}`);
    expect(advanced.body.currentElementId).toBe("after");
    expect(advanced.body.status).toBe("waiting");
    expect(advanced.body.variables.approver).toBe("ada");
    expect(advanced.body.variables.approved).toBe(true);
    const types = await historyTypes(id);
    expect(types).toContain("messageCorrelated");
    expect(types).not.toContain("incidentCreated");

    await leaseAndComplete(token, "after-catch", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  it("a DUPLICATE publish does not advance a second time (at-least-once dedup)", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PROCESS_MSG_CATCH_BPMN, { correlationKey: "mic-dup", variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.currentElementId).toBe("catch");

    const first = await publishMessage({
      messageName: "CatchApproval",
      correlationKey: "mic-dup",
      messageId: "mic-dup-1",
      payload: { approver: "first" },
    });
    expect(first.body.outcome).toBe("correlated");
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("after");

    // Re-publishing the SAME messageId returns the stable prior outcome and never
    // re-advances the (now parked at `after`) instance.
    const dup = await publishMessage({
      messageName: "CatchApproval",
      correlationKey: "mic-dup",
      messageId: "mic-dup-1",
      payload: { approver: "first" },
    });
    expect(dup.body.outcome).toBe("duplicate");
    const after = await get(`/instances/${id}`);
    expect(after.body.currentElementId).toBe("after");
    expect(after.body.variables.approver).toBe("first");
    // Exactly one correlation history row (no double apply).
    expect((await historyTypes(id)).filter((t) => t === "messageCorrelated")).toHaveLength(1);

    await leaseAndComplete(token, "after-catch", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});

describe("Message intermediate catch — process level, publish-BEFORE (M3-L4 §7 gate 9: early/buffered)", () => {
  it("an early message is buffered, then claimed at registration so the catch advances immediately", async () => {
    const token = await mintWorkerToken();

    // Publish BEFORE any instance exists for this correlation key → buffered.
    const early = await publishMessage({
      messageName: "CatchApproval",
      correlationKey: "mic-before",
      messageId: "mic-before-1",
      payload: { approved: true, approver: "early" },
    });
    expect(early.body.outcome).toBe("buffered");

    // Start: the catch's registration consumes the buffered message (the broker
    // returns `correlated`) and the token advances to `after` during the start drive.
    const { instance } = await publishAndStart(PROCESS_MSG_CATCH_BPMN, { correlationKey: "mic-before", variables: {} });
    const id = instance.body.instanceId;
    expect(instance.body.currentElementId).toBe("after");
    expect(instance.body.status).toBe("waiting");
    expect(instance.body.variables.approver).toBe("early");
    expect(await historyTypes(id)).toContain("messageCorrelated");

    // Repeating the same publish returns the original (buffered) outcome as duplicate.
    const repeat = await publishMessage({
      messageName: "CatchApproval",
      correlationKey: "mic-before",
      messageId: "mic-before-1",
      payload: { approved: true },
    });
    expect(repeat.body.outcome).toBe("duplicate");

    await leaseAndComplete(token, "after-catch", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});

describe("Message intermediate catch — inside a transaction (M3-L4: scope stays open across the wait)", () => {
  it("the saga scope stays open while the catch waits; correlation commits the transaction", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(TX_MSG_CATCH_BPMN, { correlationKey: "mic-tx", variables: {} });
    const id = instance.body.instanceId;

    await leaseAndComplete(token, "reserve-mic", {}); // compensatable, ledger 'pending'
    const parked = await get(`/instances/${id}`);
    expect(parked.body.currentElementId).toBe("catch");
    expect(parked.body.status).toBe("waiting");
    // Scope OPEN across the wait: still forward, the reserve ledger row pending,
    // the transaction NOT yet committed.
    expect(parked.body.saga?.phase).toBe("forward");
    expect(parked.body.saga?.steps?.find((s: any) => s.elementId === "reserve")?.compensationStatus).toBe("pending");
    expect(await historyTypes(id)).not.toContain("transactionCommitted");

    const pub = await publishMessage({
      messageName: "CatchApprovalTx",
      correlationKey: "mic-tx",
      messageId: "mic-tx-1",
      payload: { ok: true },
    });
    expect(pub.body.outcome).toBe("correlated");

    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
    const types = await historyTypes(id);
    expect(types).toContain("transactionCommitted");
    expect(types).toContain("messageCorrelated");
    expect(types).not.toContain("compensationStarted"); // committed, never compensated
  });
});
