import { describe, expect, it } from "vitest";
import { jobResultEventSchema, messageEventPayloadSchema } from "../../src/contracts/workflow-events";
import { activateJobsResponseSchema } from "../../src/contracts/api";
import { WAKE_TYPE } from "../../src/runtime/wake";
import { DEMO_BPMN, PARALLEL_BPMN, createDraft, drainSampleWorkers, get, post, publishAndStart, publishDraft, startInstance } from "../helpers";

// Cloudflare Workflows reject event types that don't match this pattern
// (sendEvent throws `workflow.invalid_event_type`). Must hold for every name.
const CF_EVENT_TYPE = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

describe("Runtime contracts", () => {
  it("waits/wakes on the single WAKE_TYPE, which satisfies the Cloudflare charset (no dots)", () => {
    // Single-wake (TASK-54): the per-message/job/timer/gateway event-type derivation
    // was removed — every step.waitForEvent / sendEvent uses the ONE constant WAKE_TYPE.
    // The contract that remains is that this constant is a legal Cloudflare event type.
    expect(WAKE_TYPE).toBe("bpmn_wake");
    expect(WAKE_TYPE).toMatch(CF_EVENT_TYPE);
    expect(WAKE_TYPE.length).toBeLessThanOrEqual(100);
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

  it("job-result discriminator carries the timeout/poison failure classification (TASK-23 §4.2/§4.3)", () => {
    // un-leasable DLQ synthetic result
    const dlq = jobResultEventSchema.safeParse({ outcome: "failed", jobId: "job_1", retryable: false, kind: "timeout", reason: "un-leasable" });
    expect(dlq.success).toBe(true);
    // poison classification
    const poison = jobResultEventSchema.safeParse({ outcome: "failed", jobId: "job_2", retryable: false, kind: "poison", reason: "un-applicable output" });
    expect(poison.success).toBe(true);
    // a business/technical failure may omit kind; a bogus classification is rejected
    expect(jobResultEventSchema.safeParse({ outcome: "failed", jobId: "job_3", retryable: true, reason: "retry" }).success).toBe(true);
    expect(jobResultEventSchema.safeParse({ outcome: "failed", jobId: "job_4", retryable: false, kind: "weird", reason: "x" }).success).toBe(false);
  });

  it("activate-response schema validates the backoff-gated empty result (TASK-23 §4.1)", () => {
    // While every job of a taskType is parked behind backoff, activate returns {jobs:[]}.
    expect(activateJobsResponseSchema.safeParse({ jobs: [] }).success).toBe(true);
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

  it("GET /instances/{id} returns tokens array + null currentElementId when >1 token is live (M4-L6.3)", async () => {
    const { instance } = await publishAndStart(PARALLEL_BPMN, { correlationKey: "rc-tok-1", variables: {} });
    const id = instance.body.instanceId;

    // Right after start the fork has fanned out: two branch service-task jobs are
    // leasable concurrently, so there must be ≥2 live tokens in the read-model.
    const inst = await get(`/instances/${id}`);
    expect(inst.status).toBe(200);

    // tokens array must be present and contain at least the two branch tokens.
    const tokens: any[] = inst.body.tokens;
    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens.length).toBeGreaterThanOrEqual(2);

    // Every token object must carry all 7 required fields.
    for (const tok of tokens) {
      expect(typeof tok.tokenId).toBe("string");
      expect(typeof tok.positionElementId).toBe("string");
      expect(typeof tok.status).toBe("string");
      // regionId / branchFlowId / parentTokenId are nullable strings
      expect(tok).toHaveProperty("regionId");
      expect(tok).toHaveProperty("regionActivation");
      expect(tok).toHaveProperty("branchFlowId");
      expect(tok).toHaveProperty("parentTokenId");
    }

    // The two expected branch tokens must be present with the correct metadata.
    const f1 = tokens.find((t) => t.branchFlowId === "f1");
    const f2 = tokens.find((t) => t.branchFlowId === "f2");
    expect(f1).toBeTruthy();
    expect(f2).toBeTruthy();
    expect(f1).toMatchObject({
      tokenId: `${id}:fork#0:f1`,
      positionElementId: "A",
      regionId: "fork",
      regionActivation: 0,
      parentTokenId: `${id}:#root`,
      status: expect.stringMatching(/^(active|waiting)$/),
    });
    expect(f2).toMatchObject({
      tokenId: `${id}:fork#0:f2`,
      positionElementId: "B",
      regionId: "fork",
      regionActivation: 0,
      parentTokenId: `${id}:#root`,
      status: expect.stringMatching(/^(active|waiting)$/),
    });

    // currentElementId must be null while >1 token is live (design §L6.3).
    expect(inst.body.currentElementId).toBeNull();
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
