import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { insertExternalMessage, getCorrelatedMessageForSubscription } from "../../src/persistence/messages";

describe("getCorrelatedMessageForSubscription", () => {
  it("returns the correlated message (with payload) linked to a subscription, else null", async () => {
    const now = "2026-06-13T00:00:00.000Z";
    await insertExternalMessage(env.DB, {
      externalMessageId: "em1", workspaceId: "default", messageName: "Ready",
      correlationKey: "k1", messageId: "mid1", payload: { ok: true }, payloadHash: "h",
      outcome: "correlated", finalOutcome: "correlated",
      matchedInstanceId: "i1", matchedSubscriptionId: "sub_1", receivedAt: now, correlatedAt: now,
    });
    const m = await getCorrelatedMessageForSubscription(env.DB, "sub_1");
    expect(m).toMatchObject({ externalMessageId: "em1", messageName: "Ready", messageId: "mid1", correlationKey: "k1" });
    expect(m?.payload).toEqual({ ok: true });
    expect(await getCorrelatedMessageForSubscription(env.DB, "sub_none")).toBeNull();
  });
});
