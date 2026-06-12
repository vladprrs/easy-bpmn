import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const NOW = "2026-06-07T12:00:00.000Z";
const FUTURE = "2026-06-07T13:00:00.000Z"; // +1h
const PAST_EXPIRY = "2026-06-07T14:30:00.000Z"; // > 1h after NOW

function broker(key: string) {
  const id = env.CORRELATION_BROKER.idFromName(key);
  return env.CORRELATION_BROKER.get(id) as any;
}

function regReq(over: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws",
    instanceId: "pi_1",
    workflowInstanceId: "pi_1",
    elementId: "R",
    subscriptionId: "sub_1",
    messageName: "M",
    correlationKey: "c",
    workflowEventType: "bpmn.message.M",
    expiresAt: FUTURE,
    now: NOW,
    ...over,
  };
}

function pubReq(over: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws",
    messageName: "M",
    correlationKey: "c",
    messageId: "m1",
    externalMessageId: "msg_1",
    payload: { approved: true },
    now: NOW,
    ...over,
  };
}

describe("CorrelationBroker", () => {
  it("registers then correlates a published message", async () => {
    const b = broker("k-correlate");
    expect((await b.registerSubscription(regReq())).status).toBe("waiting");
    const pub = await b.publishMessage(pubReq());
    expect(pub.outcome).toBe("correlated");
    expect(pub.instanceId).toBe("pi_1");
    expect(pub.event.payload).toEqual({ approved: true });
  });

  it("returns the subscription's STORED workflow_event_type on correlation (M3-L4 §4.5 delivery contract)", async () => {
    // For an eventBasedGateway branch the stored wake type is the per-visit GATEWAY
    // type (not the per-message type), so a single waitForEvent is woken by any
    // branch. The delivery path honors THIS value rather than re-deriving from the
    // message name — the broker must surface it on the correlated result.
    const b = broker("k-ebg-type");
    await b.registerSubscription(regReq({ workflowEventType: "bpmn_ebg_EBG_0" }));
    const pub = await b.publishMessage(pubReq());
    expect(pub.outcome).toBe("correlated");
    expect(pub.workflowEventType).toBe("bpmn_ebg_EBG_0");
  });

  it("buffers an early message and correlates it on registration", async () => {
    const b = broker("k-buffer");
    const pub = await b.publishMessage(pubReq());
    expect(pub.outcome).toBe("buffered");
    const reg = await b.registerSubscription(regReq());
    expect(reg.status).toBe("correlated");
    expect(reg.event.messageId).toBe("m1");
  });

  it("returns a stable duplicate for a repeated messageId", async () => {
    const b = broker("k-dupe");
    await b.registerSubscription(regReq());
    const first = await b.publishMessage(pubReq());
    expect(first.outcome).toBe("correlated");
    const second = await b.publishMessage(pubReq({ externalMessageId: "msg_2" }));
    expect(second.outcome).toBe("duplicate");
    expect(second.duplicateOf).toBe(first.externalMessageId);
  });

  it("buffered duplicate also returns the original outcome", async () => {
    const b = broker("k-buffer-dupe");
    const first = await b.publishMessage(pubReq());
    expect(first.outcome).toBe("buffered");
    const second = await b.publishMessage(pubReq({ externalMessageId: "msg_2" }));
    expect(second.outcome).toBe("duplicate");
    expect(second.originalOutcome).toBe("buffered");
  });

  it("rejects a second active subscription for the same broker key", async () => {
    const b = broker("k-invariant");
    expect((await b.registerSubscription(regReq())).status).toBe("waiting");
    const second = await b.registerSubscription(
      regReq({ instanceId: "pi_2", workflowInstanceId: "pi_2", subscriptionId: "sub_2", elementId: "R2" }),
    );
    expect(second.status).toBe("rejected");
    expect(second.existingInstanceId).toBe("pi_1");
  });

  it("expires buffered messages after the TTL", async () => {
    const b = broker("k-expire");
    await b.publishMessage(pubReq());
    const expire = await b.expireBufferedMessages(PAST_EXPIRY);
    expect(expire.expired).toHaveLength(1);
    const state = await b.getState();
    expect(state.bufferedCount).toBe(0);
    // An expired message no longer correlates to a later subscription.
    const reg = await b.registerSubscription(regReq({ now: PAST_EXPIRY }));
    expect(reg.status).toBe("waiting");
    // Re-publishing the same messageId returns the expired dedup outcome.
    const again = await b.publishMessage(pubReq({ externalMessageId: "msg_2", now: PAST_EXPIRY }));
    expect(again.outcome).toBe("duplicate");
    expect(again.originalOutcome).toBe("expired");
  });
});
