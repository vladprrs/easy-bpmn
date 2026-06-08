import { describe, expect, it } from "vitest";
import { messageEventPayloadSchema } from "../../src/contracts/workflow-events";
import { workflowEventTypeFor } from "../../src/bpmn/profile";
import { DEMO_BPMN, createDraft, drainSampleWorkers, get, post, publishDraft, startInstance } from "../helpers";

// Cloudflare Workflows reject event types that don't match this pattern
// (sendEvent throws `workflow.invalid_event_type`). Must hold for every name.
const CF_EVENT_TYPE = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

describe("Runtime contracts", () => {
  it("derives Workflow event types that satisfy the Cloudflare charset (no dots)", () => {
    for (const name of ["ApprovalReceived", "order.completed", "a b/c", "héllo-世界", "x".repeat(200)]) {
      const t = workflowEventTypeFor(name);
      expect(t).toMatch(CF_EVENT_TYPE);
      expect(t.length).toBeLessThanOrEqual(100);
    }
    // Symmetric: the same name always derives the same type (register == deliver).
    expect(workflowEventTypeFor("ApprovalReceived")).toBe(workflowEventTypeFor("ApprovalReceived"));
  });

  it("validates the Workflow message event payload schema", () => {
    const ok = messageEventPayloadSchema.safeParse({
      externalMessageId: "msg_1",
      messageName: "ApprovalReceived",
      correlationKey: "c",
      messageId: "m1",
      payload: { approved: true },
    });
    expect(ok.success).toBe(true);
    const bad = messageEventPayloadSchema.safeParse({ messageName: "X" });
    expect(bad.success).toBe(false);
  });

  it("emits pull Service Task worker-contract diagnostics in history", async () => {
    const draft = await createDraft(DEMO_BPMN);
    const version = await publishDraft(draft.body.draftId);
    const inst = await startInstance(version.body.definitionVersionId, {
      correlationKey: "rc-1",
      variables: { amount: 7 },
    });
    // The leasable job is created (persist-before-advance) with its routing key.
    const h1 = await get(`/instances/${inst.body.instanceId}/history`);
    const created = h1.body.events.find((e: any) => e.type === "serviceTaskJobCreated");
    expect(created).toBeTruthy();
    expect(created.elementId).toBe("Task_check");
    expect(created.diagnostics.taskType).toBe("external-check");

    // A worker leasing the job records a jobActivated event carrying the attempt.
    await drainSampleWorkers({ taskTypes: ["external-check"] });
    const h2 = await get(`/instances/${inst.body.instanceId}/history`);
    const activated = h2.body.events.find((e: any) => e.type === "jobActivated");
    expect(activated).toBeTruthy();
    expect(activated.elementId).toBe("Task_check");
    expect(activated.diagnostics.attempt).toBe(1);
  });

  it("records the correlated message payload snapshot atomically with the transition", async () => {
    const draft = await createDraft(DEMO_BPMN);
    const version = await publishDraft(draft.body.draftId);
    const inst = await startInstance(version.body.definitionVersionId, {
      correlationKey: "rc-2",
      variables: { amount: 7 },
    });
    await drainSampleWorkers({ taskTypes: ["external-check"] });
    await post("/messages", {
      workspaceId: "default",
      messageName: "ApprovalReceived",
      correlationKey: "rc-2",
      messageId: "rc-2-msg",
      payload: { approved: true, approvedBy: "tester" },
    });
    const history = await get(`/instances/${inst.body.instanceId}/history`);
    const correlated = history.body.events.find((e: any) => e.type === "messageCorrelated");
    expect(correlated).toBeTruthy();
    expect(correlated.payloadSnapshot.approvedBy).toBe("tester");
    expect(correlated.externalMessageId).toMatch(/^msg_/);
  });
});
