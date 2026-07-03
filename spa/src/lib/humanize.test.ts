import { describe, expect, it } from "vitest";
import { humanize, humanizeProcessName, isOpaqueId, narrate, KNOWN_EMITTED_TYPES } from "./humanize";
import { statusTone } from "./format";

// The authoritative set grepped from the Worker runtime (src/runtime/*, the
// correlation broker, src/index.ts, src/persistence/*). If the engine adds a new
// `type:` literal, it must be added to the humanize table or this test fails.
const EMITTED = [
  "branchArrivedAtJoin", "branchForked", "businessErrorCaught", "compensationCompleted",
  "compensationFailed", "compensationStarted", "definitionDraftCreated", "definitionPublished",
  "duplicateIgnored", "ebgDecision", "elementEntered", "eventBasedGatewayWaiting",
  "gatewayDecisionEvaluated", "incidentCreated", "instanceCancelled", "instanceCompleted",
  "instanceStarted", "invariantViolation", "jobActivated", "jobActivationExpired", "jobCompleted",
  "jobFailed", "joinCompleted", "messageBuffered", "messageCorrelated", "messageExpired",
  "messageLate", "messageReceived", "operatorRetry", "poisonJob", "regionActivated", "sagaFailed",
  "serviceTaskCompleted", "serviceTaskJobCreated", "serviceTaskOutputRejected", "serviceTaskWaiting",
  "timerArmed", "timerCancelled", "timerFired", "transactionCancelled", "transactionCommitted",
  "transactionEntered",
];

describe("event humanization (§13, G3)", () => {
  it("maps every runtime-emitted type with no raw-jargon fallback", () => {
    for (const t of EMITTED) {
      const h = humanize(t);
      expect(h.mapped, `missing humanization for "${t}"`).toBe(true);
      expect(h.title.length).toBeGreaterThan(0);
    }
  });

  it("every table entry has a non-empty title and a valid tone", () => {
    const tones = new Set(["info", "ok", "warn", "danger", "muted", "accent"]);
    for (const t of KNOWN_EMITTED_TYPES) {
      const h = humanize(t);
      expect(tones.has(h.tone)).toBe(true);
    }
  });

  it("never emits an em-dash in a user-visible title or narration", () => {
    for (const t of KNOWN_EMITTED_TYPES) {
      expect(humanize(t).title).not.toContain("—");
      expect(narrate(t, "Capture Payment").line).not.toContain("—");
      expect(narrate(t, null).line).not.toContain("—");
    }
  });

  it("falls back deterministically (title-cased + muted) for an unknown/future type", () => {
    const h = humanize("someBrandNewEngineEvent");
    expect(h.mapped).toBe(false);
    expect(h.title).toBe("Some Brand New Engine Event");
    expect(h.tone).toBe("muted");
  });
});

describe("instance-status humanization (M5-L2 callActivity, Task 11)", () => {
  it("humanizes the child-only `errored` terminal as a distinct, danger-toned label", () => {
    const h = humanize("errored");
    expect(h.mapped).toBe(true);
    expect(h.title).toBe("Errored (child)");
    expect(h.tone).toBe("danger");
    expect(statusTone("errored")).toBe("danger");
  });
});

describe("process-name humanization (StageHeader headline)", () => {
  it("title-cases real names across slug / snake / camel forms", () => {
    expect(humanizeProcessName("Order Fulfillment")).toBe("Order Fulfillment");
    expect(humanizeProcessName("order-fulfillment")).toBe("Order Fulfillment");
    expect(humanizeProcessName("order_fulfillment_v2")).toBe("Order Fulfillment V2");
    expect(humanizeProcessName("paymentCaptureFlow")).toBe("Payment Capture Flow");
  });

  it("strips known id prefixes but keeps the meaningful tail", () => {
    expect(humanizeProcessName("saga-order-fulfillment")).toBe("Order Fulfillment");
    expect(humanizeProcessName("process-payment-capture")).toBe("Payment Capture");
  });

  it("never surfaces an opaque saga id as the headline", () => {
    expect(humanizeProcessName("psaga-1781422408")).toBe("Untitled process");
    expect(humanizeProcessName(null, "psaga-1781422408")).toBe("Untitled process");
    expect(humanizeProcessName(undefined, "")).toBe("Untitled process");
  });

  it("prefers the first candidate that yields real words", () => {
    expect(humanizeProcessName("psaga-1781422408", "Refund Saga")).toBe("Refund Saga");
    expect(humanizeProcessName("Refund Saga", "psaga-1781422408")).toBe("Refund Saga");
  });

  it("recognises opaque machine ids vs human names", () => {
    expect(isOpaqueId("psaga-1781422408")).toBe(true);
    expect(isOpaqueId("3f9a1c2e-0b44-4d2a-9c11-7e6f0a1b2c3d")).toBe(true);
    expect(isOpaqueId("Order Fulfillment")).toBe(false);
    expect(isOpaqueId("order-fulfillment")).toBe(false);
    expect(isOpaqueId("")).toBe(false);
    expect(isOpaqueId(null)).toBe(false);
  });
});
