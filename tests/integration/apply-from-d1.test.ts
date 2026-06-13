import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, get } from "../helpers";
import { resumeInline } from "../../src/runtime/engine";
import { getSubscriptionForVisit, listActiveSubscriptionsForInstance } from "../../src/persistence/instances";
import { insertExternalMessage } from "../../src/persistence/messages";

// Minimal single receive-task model (Start → ReceiveTask "Ready" → End).
const RECEIVE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D_recv" targetNamespace="x">
  <bpmn:message id="m_ready" name="Ready"/>
  <bpmn:process id="P_recv" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>s0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="R"/>
    <bpmn:receiveTask id="R" name="Wait" messageRef="m_ready"><bpmn:incoming>s0</bpmn:incoming><bpmn:outgoing>s1</bpmn:outgoing></bpmn:receiveTask>
    <bpmn:sequenceFlow id="s1" sourceRef="R" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>s1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

// Valid EBG: >=2 branches (a message catch + a never-firing timer); the messageRef
// sits INSIDE <messageEventDefinition> (validator requirement, src/bpmn/validator.ts).
const EBG_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D_ebg" targetNamespace="x">
  <bpmn:message id="m_go" name="Go"/>
  <bpmn:process id="P_ebg" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>s0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="G"/>
    <bpmn:eventBasedGateway id="G"><bpmn:incoming>s0</bpmn:incoming><bpmn:outgoing>g1</bpmn:outgoing><bpmn:outgoing>g2</bpmn:outgoing></bpmn:eventBasedGateway>
    <bpmn:sequenceFlow id="g1" sourceRef="G" targetRef="C1"/>
    <bpmn:intermediateCatchEvent id="C1"><bpmn:messageEventDefinition messageRef="m_go"/><bpmn:incoming>g1</bpmn:incoming><bpmn:outgoing>s1</bpmn:outgoing></bpmn:intermediateCatchEvent>
    <bpmn:sequenceFlow id="g2" sourceRef="G" targetRef="C2"/>
    <bpmn:intermediateCatchEvent id="C2"><bpmn:timerEventDefinition><bpmn:timeDuration>PT1H</bpmn:timeDuration></bpmn:timerEventDefinition><bpmn:incoming>g2</bpmn:incoming><bpmn:outgoing>s2</bpmn:outgoing></bpmn:intermediateCatchEvent>
    <bpmn:sequenceFlow id="s1" sourceRef="C1" targetRef="E"/>
    <bpmn:sequenceFlow id="s2" sourceRef="C2" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>s1</bpmn:incoming><bpmn:incoming>s2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

describe("apply-from-D1 (TASK-54)", () => {
  it("applies a correlated message from D1 on re-walk with NO in-flight event", async () => {
    const { instance } = await publishAndStart(RECEIVE_BPMN, { correlationKey: "afd1", variables: {} });
    const id = instance.body.instanceId;

    // Parked at the receive task — an active subscription exists for R#0.
    const parked = await get(`/instances/${id}`);
    expect(parked.body.status).toBe("waiting");
    const sub = await getSubscriptionForVisit(env.DB, id, "R", 0);
    expect(sub?.status).toBe("active");

    // Simulate the broker's POST-time link WITHOUT delivering an in-flight event.
    const now = new Date().toISOString();
    await insertExternalMessage(env.DB, {
      externalMessageId: "em_afd1", workspaceId: "default", messageName: "Ready",
      correlationKey: "afd1", messageId: "mid_afd1", payload: { greeted: true }, payloadHash: "h",
      outcome: "correlated", finalOutcome: "correlated",
      matchedInstanceId: id, matchedSubscriptionId: sub!.subscription_id, receivedAt: now, correlatedAt: now,
    });

    // The single-wake re-walk: a tickle drives runInstance with NO incomingEvent.
    await resumeInline(env, id);

    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
    expect(done.body.variables).toMatchObject({ greeted: true });
  });

  it("EBG applies a correlated message branch from D1 on re-walk", async () => {
    const { instance } = await publishAndStart(EBG_BPMN, { correlationKey: "afd-ebg", variables: {} });
    const id = instance.body.instanceId;
    // Only the message branch registers a subscription (the timer is a timers-table row).
    const subs = await listActiveSubscriptionsForInstance(env.DB, id);
    expect(subs.length).toBe(1);
    const now = new Date().toISOString();
    await insertExternalMessage(env.DB, {
      externalMessageId: "em_ebg", workspaceId: "default", messageName: "Go",
      correlationKey: "afd-ebg", messageId: "mid_ebg", payload: { went: 1 }, payloadHash: "h",
      outcome: "correlated", finalOutcome: "correlated",
      matchedInstanceId: id, matchedSubscriptionId: subs[0].subscription_id, receivedAt: now, correlatedAt: now,
    });
    await resumeInline(env, id);
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
    expect(done.body.variables).toMatchObject({ went: 1 });
  });
});
