import { describe, expect, it } from "vitest";
import {
  DEMO_BPMN,
  createDraft,
  get,
  publishDraft,
  publishMessage,
  startInstance,
} from "../helpers";

describe("Scenario 1: full demo flow", () => {
  it("upload → publish → start → service task → message → complete → history", async () => {
    // 1. upload
    const draft = await createDraft(DEMO_BPMN, "Simple approval");
    expect(draft.body.status).toBe("valid");

    // 2. publish
    const version = await publishDraft(draft.body.draftId);
    expect(version.status).toBe(201);

    // 3. start — the sample Service Task runs, then the instance waits for the message
    const started = await startInstance(version.body.definitionVersionId, {
      correlationKey: "approval-001",
      businessKey: "demo-approval-001",
      variables: { amount: 42 },
    });
    expect(started.status).toBe(201);
    const instanceId = started.body.instanceId;
    expect(started.body.status).toBe("waiting");
    // service task output is persisted before advancing to the receive task
    expect(started.body.variables.checkStatus).toBe("approved");
    expect(started.body.variables.checkedAmount).toBe(42);

    // 4. publish the matching external message
    const msg = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: "approval-001",
      messageId: "approval-message-001",
      payload: { approved: true, approvedBy: "demo-admin" },
    });
    expect(msg.body.outcome).toBe("correlated");
    expect(msg.body.instanceId).toBe(instanceId);

    // 5. inspect
    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.currentElementId).toBe("End_1");
    expect(inst.body.variables).toMatchObject({
      amount: 42,
      checkStatus: "approved",
      approved: true,
      approvedBy: "demo-admin",
    });

    const history = await get(`/instances/${instanceId}/history`);
    const types = history.body.events.map((e: any) => e.type);
    for (const expected of [
      "instanceStarted",
      "serviceTaskJobCreated",
      "workerAttemptStarted",
      "workerAttemptSucceeded",
      "receiveTaskWaiting",
      "messageCorrelated",
      "instanceCompleted",
    ]) {
      expect(types).toContain(expected);
    }

    // SC-007: raw payload snapshots are visible by default. The worker request,
    // worker result, and correlated message payload are all captured in history.
    const ev = (t: string) => history.body.events.find((e: any) => e.type === t);
    expect(ev("workerAttemptStarted").payloadSnapshot.taskType).toBe("external-check");
    expect(ev("workerAttemptSucceeded").payloadSnapshot.checkStatus).toBe("approved");
    const correlated = ev("messageCorrelated");
    expect(correlated.payloadSnapshot.approvedBy).toBe("demo-admin");
    expect(correlated.externalMessageId).toMatch(/^msg_/);
  });
});
