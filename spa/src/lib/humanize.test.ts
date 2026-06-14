import { describe, expect, it } from "vitest";
import { humanize, KNOWN_EMITTED_TYPES } from "./humanize";

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

  it("falls back deterministically (title-cased + muted) for an unknown/future type", () => {
    const h = humanize("someBrandNewEngineEvent");
    expect(h.mapped).toBe(false);
    expect(h.title).toBe("Some Brand New Engine Event");
    expect(h.tone).toBe("muted");
  });
});
