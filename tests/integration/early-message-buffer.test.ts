import { describe, expect, it } from "vitest";
import {
  DEMO_BPMN,
  createDraft,
  get,
  publishDraft,
  publishMessage,
  startInstance,
} from "../helpers";

describe("Scenario 4: early message buffering", () => {
  it("buffers a message published before the Receive Task is eligible, then correlates it", async () => {
    // Publish BEFORE any instance exists for this correlation key.
    const early = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: "buf-1",
      messageId: "buf-msg-1",
      payload: { approved: true, approvedBy: "early" },
    });
    expect(early.body.outcome).toBe("buffered");

    // Now start the instance — registration should consume the buffered message.
    const draft = await createDraft(DEMO_BPMN);
    const version = await publishDraft(draft.body.draftId);
    const started = await startInstance(version.body.definitionVersionId, {
      correlationKey: "buf-1",
      variables: { amount: 10 },
    });
    expect(started.body.status).toBe("completed");
    expect(started.body.variables.approvedBy).toBe("early");

    // Repeating the same publish returns the original (buffered) outcome as duplicate.
    const repeat = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: "buf-1",
      messageId: "buf-msg-1",
      payload: { approved: true },
    });
    expect(repeat.body.outcome).toBe("duplicate");

    const inst = await get(`/instances/${started.body.instanceId}`);
    expect(inst.body.status).toBe("completed");
  });
});
