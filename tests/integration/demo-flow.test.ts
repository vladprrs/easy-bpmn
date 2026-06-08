import { describe, expect, it } from "vitest";
import {
  DEMO_BPMN,
  createDraft,
  drainSampleWorkers,
  get,
  publishDraft,
  publishMessage,
  startInstance,
} from "../helpers";

describe("Scenario 1: full demo flow (pull workers)", () => {
  it("upload → publish → start → pull service task → message → complete → history", async () => {
    // 1-2. upload + publish
    const draft = await createDraft(DEMO_BPMN, "Simple approval");
    expect(draft.body.status).toBe("valid");
    const version = await publishDraft(draft.body.draftId);
    expect(version.status).toBe(201);

    // 3. start — the instance parks at the pull Service Task awaiting a worker
    const started = await startInstance(version.body.definitionVersionId, {
      correlationKey: "approval-001",
      businessKey: "demo-approval-001",
      variables: { amount: 42 },
    });
    expect(started.status).toBe(201);
    const instanceId = started.body.instanceId;
    expect(started.body.status).toBe("waiting");

    // 4. a remote worker leases + completes the Service Task; the instance then
    //    advances and parks at the Receive Task.
    expect(await drainSampleWorkers({ taskTypes: ["external-check"] })).toBeGreaterThan(0);
    const afterWork = await get(`/instances/${instanceId}`);
    expect(afterWork.body.status).toBe("waiting");
    expect(afterWork.body.currentElementId).toBe("Task_wait");
    expect(afterWork.body.variables.checkStatus).toBe("approved");
    expect(afterWork.body.variables.checkedAmount).toBe(42);

    // 5. publish the matching external message
    const msg = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: "approval-001",
      messageId: "approval-message-001",
      payload: { approved: true, approvedBy: "demo-admin" },
    });
    expect(msg.body.outcome).toBe("correlated");
    expect(msg.body.instanceId).toBe(instanceId);

    // 6. inspect
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
      "jobActivated",
      "jobCompleted",
      "serviceTaskCompleted",
      "receiveTaskWaiting",
      "messageCorrelated",
      "instanceCompleted",
    ]) {
      expect(types).toContain(expected);
    }

    // Raw payload snapshots remain visible by default: the job binding, the worker
    // output, and the correlated message payload are all captured.
    const ev = (t: string) => history.body.events.find((e: any) => e.type === t);
    expect(ev("serviceTaskJobCreated").diagnostics.taskType).toBe("external-check");
    expect(ev("jobCompleted").payloadSnapshot.checkStatus).toBe("approved");
    const correlated = ev("messageCorrelated");
    expect(correlated.payloadSnapshot.approvedBy).toBe("demo-admin");
    expect(correlated.externalMessageId).toMatch(/^msg_/);
  });
});
