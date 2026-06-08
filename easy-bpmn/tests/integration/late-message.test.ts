import { describe, expect, it } from "vitest";
import { DEMO_BPMN, get, publishAndStart, publishMessage } from "../helpers";

// runtime-contracts.md: "A different messageId after an instance already advanced
// is recorded as `late` or `rejected`." spec edge case + FR-020. The message
// cannot correlate (the instance moved past its Receive Task) and must be
// recorded — never buffered to silently advance a future instance.
describe("Scenario: late message after the instance advanced", () => {
  it("rejects a new messageId for an already-advanced key and records it as `late`", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "late-1",
      variables: { amount: 1 },
    });
    const instanceId = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting");

    const first = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: "late-1",
      messageId: "late-msg-1",
      payload: { approved: true, approvedBy: "first" },
    });
    expect(first.body.outcome).toBe("correlated");
    expect((await get(`/instances/${instanceId}`)).body.status).toBe("completed");

    // A different messageId for the same broker key now arrives too late.
    const late = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: "late-1",
      messageId: "late-msg-2",
      payload: { approved: false, approvedBy: "second" },
    });
    expect(late.status).toBe(409);
    expect(late.body.outcome).toBe("rejected");

    // Recorded as `late` in the canonical message record, with an operator reason.
    const view = await get(`/messages/${late.body.externalMessageId}`);
    expect(view.body.finalOutcome).toBe("late");
    expect(view.body.reason).toMatch(/late/i);

    // The completed instance is untouched by the late message.
    const done = await get(`/instances/${instanceId}`);
    expect(done.body.status).toBe("completed");
    expect(done.body.variables.approvedBy).toBe("first");

    // Re-publishing the late messageId returns the stable duplicate.
    const dup = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: "late-1",
      messageId: "late-msg-2",
      payload: { approved: false },
    });
    expect(dup.body.outcome).toBe("duplicate");
    expect(dup.body.duplicateOf).toBe(late.body.externalMessageId);
  });
});
