import { describe, expect, it } from "vitest";
import { messageEventPayloadSchema } from "../../src/contracts/workflow-events";
import { workflowEventTypeFor } from "../../src/bpmn/profile";
import { DEMO_BPMN, createDraft, get, post, publishDraft, startInstance } from "../helpers";

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

  it("emits Service Task worker-contract diagnostics in history", async () => {
    const draft = await createDraft(DEMO_BPMN);
    const version = await publishDraft(draft.body.draftId);
    const inst = await startInstance(version.body.definitionVersionId, {
      correlationKey: "rc-1",
      variables: { amount: 7 },
    });
    const history = await get(`/instances/${inst.body.instanceId}/history`);
    const started = history.body.events.find((e: any) => e.type === "workerAttemptStarted");
    expect(started).toBeTruthy();
    // The worker request snapshot carries taskType + attempt + elementId (audit only).
    expect(started.payloadSnapshot.taskType).toBe("external-check");
    expect(started.payloadSnapshot.attempt).toBe(1);
    expect(started.payloadSnapshot.elementId).toBe("Task_check");
  });

  it("records the correlated message payload snapshot atomically with the transition", async () => {
    const draft = await createDraft(DEMO_BPMN);
    const version = await publishDraft(draft.body.draftId);
    const inst = await startInstance(version.body.definitionVersionId, {
      correlationKey: "rc-2",
      variables: { amount: 7 },
    });
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
