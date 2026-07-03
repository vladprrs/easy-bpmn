import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, drainSampleWorkers, get, leaseAndComplete, mintWorkerToken, post, publishAndStart, publishDraft } from "../helpers";
import {
  CALL_CHILD_BPMN,
  CALL_CHILD_TX_PARK_BPMN,
  CALL_PARENT_TX_CANCEL_BPMN,
  CALL_PARENT_TX_CANCEL_PARK_BPMN,
  CALL_PARENT_TX_CANCEL_SIMPLE_BPMN,
  SIMPLE_CHILD_BPMN,
} from "./call-activity-fixtures";
import { childInstanceIdFor } from "../../src/runtime/call-activity";
import { resumeInline } from "../../src/runtime/engine";

// M5-L2 Task 9 — child compensation (design §5): a committed callActivity's
// saga step compensates by driving the CHILD's OWN reverse pass, not a
// compensation job. Covers: reverse-order dispatch (child's compensator before
// the parent's earlier step), the {completed,cancelled} → compensating CAS
// entry, the empty-ledger no-op shortcut (no park), compensationFailed
// surfacing as the PARENT's own compensationFailure incident on call1, the
// drain-interrupted (cancelled) child whose retained committedLocal steps still
// reverse, and at-least-once double-entry idempotency (no second CAS, no
// duplicate comp job). Also locks the R1 seal semantics this task introduces: a
// CHILD instance's outermost tx commit is only LOCAL (`committedLocal`) — the
// parent is a real outer scope that may reverse it.

async function instRow(instanceId: string) {
  return env.DB.prepare(
    `SELECT status, error_code, current_element_id FROM process_instances WHERE instance_id = ?`,
  )
    .bind(instanceId)
    .first<{ status: string; error_code: string | null; current_element_id: string | null }>();
}

async function sagaSteps(instanceId: string) {
  const res = await env.DB.prepare(
    `SELECT element_id, seq, compensation_status, child_instance_id FROM saga_steps WHERE instance_id = ? ORDER BY seq`,
  )
    .bind(instanceId)
    .all<{ element_id: string; seq: number; compensation_status: string; child_instance_id: string | null }>();
  return res.results ?? [];
}

async function jobsFor(instanceId: string, taskType: string) {
  const res = await env.DB.prepare(
    `SELECT status, is_compensation FROM service_task_jobs WHERE instance_id = ? AND task_type = ?`,
  )
    .bind(instanceId, taskType)
    .all<{ status: string; is_compensation: number }>();
  return res.results ?? [];
}

async function historyOfType(instanceId: string, type: string): Promise<Array<{ elementId: string | null; diagnostics: Record<string, unknown> }>> {
  const res = await get(`/instances/${instanceId}/history`);
  return (res.body.events as Array<{ type: string; elementId: string | null; diagnostics: Record<string, unknown> }>).filter((e) => e.type === type);
}

describe("callActivity child compensation (M5-L2 Task 9)", () => {
  it("[1] committed callActivity compensates via the child's reverse pass, in reverse order before the parent's earlier step", async () => {
    const childDraft = await createDraft(CALL_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CALL_PARENT_TX_CANCEL_BPMN, {
      correlationKey: "ca-comp-order",
      variables: { failSettle: true },
    });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);

    // Forward: charge the card, then run the child to completion.
    await drainSampleWorkers({ taskTypes: ["charge-card"], token });
    await drainSampleWorkers({ taskTypes: ["reserve-stock"], token });
    expect((await instRow(childId))?.status).toBe("completed");

    // R1 seal semantics (this task): a CHILD's outermost tx commit is only
    // LOCAL — the ledger row reads committedLocal, never sealed 'committed'.
    const childRows = await sagaSteps(childId);
    expect(childRows.find((r) => r.element_id === "c-reserve")?.compensation_status).toBe("committedLocal");

    // The parent applied the child and ledgered call1 as a child-instance step.
    const call1Step = (await sagaSteps(parentId)).find((r) => r.element_id === "call1");
    expect(call1Step?.child_instance_id).toBe(childId);
    expect(call1Step?.compensation_status).toBe("pending");

    // The steered settle failure routes to the cancel end → the reverse pass.
    await drainSampleWorkers({ taskTypes: ["branch-settle"], token });
    expect((await instRow(parentId))?.status).toBe("compensating");

    // REVERSE ORDER: the child's own reverse pass runs FIRST — its release-stock
    // compensation job exists while the parent's refund-card does NOT yet.
    expect((await instRow(childId))?.status).toBe("compensating");
    const releaseJobs = await jobsFor(childId, "release-stock");
    expect(releaseJobs).toHaveLength(1);
    expect(releaseJobs[0]!.is_compensation).toBe(1);
    expect(await jobsFor(parentId, "refund-card")).toHaveLength(0);

    // Complete the child's compensator → child settles compensated; the parent
    // marks call1 compensated and only THEN creates the refund-card comp job.
    await leaseAndComplete(token, "release-stock", {});
    expect((await instRow(childId))?.status).toBe("compensated");
    const afterChild = await sagaSteps(parentId);
    expect(afterChild.find((r) => r.element_id === "call1")?.compensation_status).toBe("compensated");
    expect(await jobsFor(parentId, "refund-card")).toHaveLength(1);
    // The child's own ledger reversed too.
    expect((await sagaSteps(childId)).find((r) => r.element_id === "c-reserve")?.compensation_status).toBe("compensated");

    // Complete refund-card → the parent settles per the cancel boundary path.
    await leaseAndComplete(token, "refund-card", {});
    const parent = await instRow(parentId);
    expect(parent?.status).toBe("compensated");
    expect(parent?.current_element_id).toBe("px-failed");
    expect((await sagaSteps(parentId)).find((r) => r.element_id === "px-charge")?.compensation_status).toBe("compensated");
  });

  it("[2] no-op compensator: an empty-ledger committed child settles compensated immediately, no comp job, no park", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CALL_PARENT_TX_CANCEL_SIMPLE_BPMN, {
      correlationKey: "ca-comp-noop",
      variables: { failSettle: true },
    });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);

    await drainSampleWorkers({ taskTypes: ["charge-card"], token });
    // Complete ONLY the child's sc-echo (single lease; the parent has no other
    // echo-typed task in this fixture, but stay deliberate about the drain).
    await leaseAndComplete(token, "echo", {});
    expect((await instRow(childId))?.status).toBe("completed");
    expect(await sagaSteps(childId)).toHaveLength(0); // no tx anywhere → empty ledger

    // Cancel: the child CASes to compensating and settles compensated
    // SYNCHRONOUSLY (no comp job); the parent reverse continues WITHOUT parking
    // on it — refund-card already exists by the time this drive returns.
    await drainSampleWorkers({ taskTypes: ["branch-settle"], token });
    expect((await instRow(childId))?.status).toBe("compensated");
    const childCompJobs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 1`,
    )
      .bind(childId)
      .first<{ n: number }>();
    expect(childCompJobs?.n).toBe(0);
    const cancelled = await historyOfType(childId, "transactionCancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.diagnostics).toMatchObject({ by: "parentCompensation" });
    const completedEvents = await historyOfType(childId, "compensationCompleted");
    expect(completedEvents.some((e) => e.diagnostics.emptyLedger === true)).toBe(true);
    expect((await sagaSteps(parentId)).find((r) => r.element_id === "call1")?.compensation_status).toBe("compensated");
    expect(await jobsFor(parentId, "refund-card")).toHaveLength(1); // reverse continued, not parked

    await leaseAndComplete(token, "refund-card", {});
    expect((await instRow(parentId))?.status).toBe("compensated");
  });

  it("[3] child compensationFailed surfaces as the PARENT's own compensationFailure incident on call1", async () => {
    const childDraft = await createDraft(CALL_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CALL_PARENT_TX_CANCEL_BPMN, {
      correlationKey: "ca-comp-fail",
      variables: { failSettle: true, releaseFails: true },
    });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);

    await drainSampleWorkers({ taskTypes: ["charge-card"], token });
    await drainSampleWorkers({ taskTypes: ["reserve-stock"], token });
    await drainSampleWorkers({ taskTypes: ["branch-settle"], token });
    // The child's release-stock compensator is steered to fail; retries=1 →
    // exhaustion → the CHILD settles compensationFailed…
    await drainSampleWorkers({ taskTypes: ["release-stock"], token, maxRounds: 80 });
    expect((await instRow(childId))?.status).toBe("compensationFailed");

    // …and the PARENT gets its OWN compensationFailure incident on call1.
    const parent = await get(`/instances/${parentId}`);
    expect(parent.body.status).toBe("compensationFailed");
    expect(parent.body.incident.kind).toBe("compensationFailure");
    expect(parent.body.incident.elementId).toBe("call1");
    // The reverse pass halted — the earlier px-charge step was never reached.
    expect(await jobsFor(parentId, "refund-card")).toHaveLength(0);
    expect((await sagaSteps(parentId)).find((r) => r.element_id === "px-charge")?.compensation_status).toBe("pending");
    expect((await sagaSteps(parentId)).find((r) => r.element_id === "call1")?.compensation_status).toBe("failed");
  });

  // Task 10 unskips: the cascading /retry (POST /instances/{parent}/retry)
  // recursively repairs the CHILD's failed compensator first, then the parent's
  // own reverse pass resumes and settles.
  it("[3b] cascading /retry heals a child compensationFailed (Task 10)", async () => {
    const childDraft = await createDraft(CALL_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CALL_PARENT_TX_CANCEL_BPMN, {
      correlationKey: "ca-comp-retry",
      variables: { failSettle: true, releaseFails: true },
    });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);

    await drainSampleWorkers({ taskTypes: ["charge-card"], token });
    await drainSampleWorkers({ taskTypes: ["reserve-stock"], token });
    await drainSampleWorkers({ taskTypes: ["branch-settle"], token });
    await drainSampleWorkers({ taskTypes: ["release-stock"], token, maxRounds: 80 });
    expect((await instRow(parentId))?.status).toBe("compensationFailed");

    // Operator fixes the condition and retries the PARENT — the cascade reaches
    // the child's failed compensator first.
    const retry = await post(`/instances/${parentId}/retry`, { variables: { releaseFails: false } });
    expect(retry.status).toBe(200);
    await drainSampleWorkers({ taskTypes: ["release-stock", "refund-card"], token, maxRounds: 80 });
    expect((await instRow(childId))?.status).toBe("compensated");
    expect((await instRow(parentId))?.status).toBe("compensated");
  });

  it("[4] a drain-interrupted (cancelled) child still reverses its committed steps under the parent's reverse pass", async () => {
    const childDraft = await createDraft(CALL_CHILD_TX_PARK_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CALL_PARENT_TX_CANCEL_PARK_BPMN, {
      correlationKey: "ca-comp-interrupted",
      variables: {},
    });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);

    await drainSampleWorkers({ taskTypes: ["charge-card"], token });
    // The child's tx COMMITS (committedLocal — the child has a parent), then the
    // child parks forever on ctp-park; the parent is parked at call1.
    await drainSampleWorkers({ taskTypes: ["reserve-stock-park"], token });
    expect((await instRow(childId))?.status).toBe("waiting");
    expect((await sagaSteps(childId)).find((r) => r.element_id === "ctp-reserve")?.compensation_status).toBe("committedLocal");

    // Operator /cancel: the Task-8 cascade cancels the child mid-flight, then
    // the parent's reverse pass ledgers the call1 straggler and drives the
    // CANCELLED child's reverse over its retained committedLocal steps.
    const cancelled = await post(`/instances/${parentId}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("compensating");
    expect((await instRow(childId))?.status).toBe("compensating"); // cancelled → CAS'd into its own reverse
    const releaseJobs = await jobsFor(childId, "release-stock-park");
    expect(releaseJobs).toHaveLength(1);
    expect(releaseJobs[0]!.is_compensation).toBe(1);

    await leaseAndComplete(token, "release-stock-park", {});
    expect((await instRow(childId))?.status).toBe("compensated");
    expect((await sagaSteps(childId)).find((r) => r.element_id === "ctp-reserve")?.compensation_status).toBe("compensated");
    const call1Step = (await sagaSteps(parentId)).find((r) => r.element_id === "call1");
    expect(call1Step?.child_instance_id).toBe(childId);
    expect(call1Step?.compensation_status).toBe("compensated");

    // The parent reverse continues to its own earlier step and settles.
    await leaseAndComplete(token, "refund-card", {});
    expect((await instRow(parentId))?.status).toBe("compensated");
  });

  it("[5] idempotent double entry: a duplicate parent drive never re-CASes the child or duplicates a comp job", async () => {
    const childDraft = await createDraft(CALL_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CALL_PARENT_TX_CANCEL_BPMN, {
      correlationKey: "ca-comp-idem",
      variables: { failSettle: true },
    });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);

    await drainSampleWorkers({ taskTypes: ["charge-card"], token });
    await drainSampleWorkers({ taskTypes: ["reserve-stock"], token });
    await drainSampleWorkers({ taskTypes: ["branch-settle"], token });
    expect((await instRow(childId))?.status).toBe("compensating");

    // Duplicate parent drives while the child is mid-reverse: no second CAS
    // (single transactionCancelled marker), no duplicate release-stock job.
    await resumeInline(env, parentId);
    await resumeInline(env, parentId);
    expect(await jobsFor(childId, "release-stock")).toHaveLength(1);
    const cancelMarkers = await historyOfType(childId, "transactionCancelled");
    expect(cancelMarkers.filter((e) => e.diagnostics.by === "parentCompensation")).toHaveLength(1);
    expect((await instRow(childId))?.status).toBe("compensating");

    await leaseAndComplete(token, "release-stock", {});
    expect((await instRow(childId))?.status).toBe("compensated");

    // Duplicate drive after the child settled: the compensated step is a
    // write-free fast-forward — status stable, still exactly one refund-card job.
    await resumeInline(env, parentId);
    expect((await instRow(childId))?.status).toBe("compensated");
    expect(await jobsFor(parentId, "refund-card")).toHaveLength(1);
    expect(await jobsFor(childId, "release-stock")).toHaveLength(1);

    await leaseAndComplete(token, "refund-card", {});
    expect((await instRow(parentId))?.status).toBe("compensated");

    // A drive after the terminal settle is a cheap no-op.
    await resumeInline(env, parentId);
    expect((await instRow(parentId))?.status).toBe("compensated");
    expect((await instRow(childId))?.status).toBe("compensated");
  });
});
