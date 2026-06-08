import { describe, expect, it } from "vitest";
import { DEMO_BPMN, drainSampleWorkers, get, publishAndStart, publishMessage } from "../helpers";

describe("Scenario 3: duplicate message publish", () => {
  it("advances at most once and returns a stable duplicate", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "dup-1",
      variables: { amount: 5 },
    });
    const instanceId = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting");
    // Drive the pull Service Task so the instance reaches the Receive Task.
    await drainSampleWorkers({ taskTypes: ["external-check"] });

    const first = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: "dup-1",
      messageId: "dup-msg-1",
      payload: { approved: true },
    });
    expect(first.body.outcome).toBe("correlated");

    const second = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: "dup-1",
      messageId: "dup-msg-1",
      payload: { approved: true },
    });
    expect(second.body.outcome).toBe("duplicate");
    expect(second.body.duplicateOf).toBe(first.body.externalMessageId);

    // The instance completed exactly once.
    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("completed");
    const history = await get(`/instances/${instanceId}/history`);
    const correlatedCount = history.body.events.filter((e: any) => e.type === "messageCorrelated").length;
    expect(correlatedCount).toBe(1);
  });
});
