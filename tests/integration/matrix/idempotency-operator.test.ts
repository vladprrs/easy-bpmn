import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  publishAndStart,
  startInstance,
  createDraft,
  publishDraft,
  get,
  post,
  authedPost,
  publishMessage,
  mintWorkerToken,
  leaseOne,
  leaseAndComplete,
  rewindBackoff,
  drainSampleWorkers,
  PARALLEL_BPMN,
  PARALLEL_MESSAGE_DISTINCT_BPMN,
  PARALLEL_SAGA_BPMN,
  type LeasedTestJob,
} from "../../helpers";
import { getSagaStepsForInstance } from "../../../src/persistence/saga";
import { listTokens } from "../../../src/persistence/tokens";
import { getOpenIncidentsForInstance } from "../../../src/persistence/instances";

// Direct-mode characterization of at-least-once idempotency + operator remediation
// into ONE branch of an M4 token set (Phase-1 matrix, Task 3.7). M4 (L1-L6) is
// shipped + GREEN, so each of these SHOULD pass; they re-prove the duplicate-worker-
// callback / duplicate-message / early-buffer+late / operator-/retry invariants now
// hold per-branch under concurrency (not just on the single-token M1-M3 paths).
//
// The PARALLEL_* fixtures use CUSTOM service-task types; every forward AND
// compensation task is driven over the pull data plane (leaseOne / complete /
// /jobs/{id}/fail), never drainSampleWorkers — except the sample-worker-wired
// `branch-settle` (failSettle), the only auto-run task here.

// --- shared helpers (mirrors matrix/compensation.test.ts) --------------------

const complete = (
  t: string,
  j: { jobId: string; lockToken: string },
  out: Record<string, unknown> = {},
) => authedPost(`/jobs/${j.jobId}/complete`, t, { lockToken: j.lockToken, outputVariables: out });

const statusOf = async (id: string): Promise<string> => (await get(`/instances/${id}`)).body.status;

const liveTokens = async (id: string) =>
  (await listTokens(env.DB, id)).filter((r) => ["active", "waiting", "arrivedAtJoin"].includes(r.status));

const steps = (id: string) => getSagaStepsForInstance(env.DB, id);
const stepOf = async (id: string, elementId: string, occurrence = 0) =>
  (await steps(id)).find((s) => s.elementId === elementId && s.occurrence === occurrence);

/** Count history events of `type` for a given element id (audit-visible advances). */
async function historyCount(id: string, type: string, elementId: string): Promise<number> {
  const h = await get(`/instances/${id}/history`);
  return (h.body.events as any[]).filter((e) => e.type === type && e.elementId === elementId).length;
}

/** Count compensation-lane job rows for a given FORWARD element id (no-double-apply proof). */
async function compJobCount(id: string, elementId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND element_id = ? AND is_compensation = 1`,
  )
    .bind(id, elementId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Fail a leased compensation job to retry-exhaustion (matrix/compensation.test.ts
 * pattern): `retries=N` ⇒ N lease attempts, each retryable fail parks behind backoff
 * and re-leases the SAME job; the Nth fail is terminal-for-the-step
 * (markStepCompensationFailed → compensationFailure incident + status
 * compensationFailed). Returns the comp job id.
 */
async function exhaustCompensator(token: string, id: string, compType: string, retryLimit: number): Promise<string> {
  let jobId: string | null = null;
  for (let attempt = 1; attempt <= retryLimit; attempt++) {
    const c = await leaseOne(token, compType);
    jobId = jobId ?? c.jobId;
    expect(c.jobId).toBe(jobId); // the SAME comp job, re-leased each attempt
    expect(c.isCompensation).toBe(true);
    expect(c.attempt).toBe(attempt);
    const failed = await authedPost(`/jobs/${c.jobId}/fail`, token, {
      lockToken: c.lockToken,
      reason: `${compType} unavailable`,
      retryable: true,
    });
    expect(failed.status).toBe(200);
    if (attempt < retryLimit) await rewindBackoff(id, compType);
  }
  return jobId!;
}

/** Fail the post-join `settle` (branch-settle sample worker, errorCode SETTLE_REJECTED). */
const failSettle = (token: string) => drainSampleWorkers({ taskTypes: ["branch-settle"], token });

/** A full single-delivery PARALLEL_BPMN run (no duplicates); returns the merged vars. */
async function parallelSingleDelivery(token: string, key: string): Promise<Record<string, unknown>> {
  const { instance } = await publishAndStart(PARALLEL_BPMN, { correlationKey: key, variables: { base: 1 } });
  expect(instance.status).toBe(201);
  const id = instance.body.instanceId;
  await complete(token, await leaseOne(token, "reserve-stock"), { shared: "A", fromA: 1 });
  await complete(token, await leaseOne(token, "authorize-payment"), { shared: "B", fromB: 1 });
  await complete(token, await leaseOne(token, "confirm-order"), {});
  const done = await get(`/instances/${id}`);
  expect(done.body.status).toBe("completed");
  return done.body.variables as Record<string, unknown>;
}

/** A full single-delivery PARALLEL_MESSAGE_DISTINCT_BPMN run; returns the merged vars. */
async function messageSingleDelivery(key: string): Promise<Record<string, unknown>> {
  const { instance } = await publishAndStart(PARALLEL_MESSAGE_DISTINCT_BPMN, { correlationKey: key, variables: {} });
  expect(instance.status).toBe(201);
  const id = instance.body.instanceId;
  const a = await publishMessage({ messageName: "Ready", correlationKey: key, messageId: `${key}-a`, payload: { shared: "A", fromA: 1 } });
  expect(a.body.outcome).toBe("correlated");
  const b = await publishMessage({ messageName: "Paid", correlationKey: key, messageId: `${key}-b`, payload: { shared: "B", fromB: 1 } });
  expect(b.body.outcome).toBe("correlated");
  const done = await get(`/instances/${id}`);
  expect(done.body.status).toBe("completed");
  return done.body.variables as Record<string, unknown>;
}

describe("matrix: idempotency into one branch of a token set (direct mode)", () => {
  // -------------------------------------------------------------------------
  // [C-IDEMP-DUP-01] — at-least-once into ONE branch (the duplicate-CALLBACK half).
  it("[C-IDEMP-DUP-01] a duplicate worker /complete into branch A advances exactly once; merged vars == single-delivery", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_BPMN, { correlationKey: "idmp-dupjob-1", variables: { base: 1 } });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Lease + complete branch A (reserve-stock), then re-POST the SAME /complete
    // (same jobId + same lockToken) — the at-least-once redelivery.
    const a: LeasedTestJob = await leaseOne(token, "reserve-stock");
    const first = await complete(token, a, { shared: "A", fromA: 1 });
    expect(first.status).toBe(200);
    expect(first.body.disposition).toBe("applied");
    expect(first.body.outcome).toBe("completed");

    const dup = await complete(token, a, { shared: "A", fromA: 1 }); // SAME jobId + lockToken
    expect(dup.status).toBe(200);
    // output_applied=1 fast-forwards write-free: the idempotency record (jobId:lockToken)
    // returns the STABLE prior ack — no second advance.
    expect(dup.body).toEqual(first.body);
    expect(dup.body.outcome).toBe("completed");

    // Branch A advanced EXACTLY once: a single serviceTaskCompleted audit for element A,
    // and no second forward job created for it.
    expect(await historyCount(id, "serviceTaskCompleted", "A")).toBe(1);
    const aJobs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND element_id = 'A' AND is_compensation = 0`,
    ).bind(id).first<{ n: number }>();
    expect(aJobs?.n).toBe(1);

    // Drive branch B + the join + the post-join confirm to completion.
    await complete(token, await leaseOne(token, "authorize-payment"), { shared: "B", fromB: 1 });
    await complete(token, await leaseOne(token, "confirm-order"), {});
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
    // Document-order merge winner (f2 "B"); the duplicate neither duplicated fromA nor
    // corrupted the merge. Still one serviceTaskCompleted for A after B/C re-drove.
    expect(done.body.variables).toMatchObject({ base: 1, shared: "B", fromA: 1, fromB: 1 });
    expect(await historyCount(id, "serviceTaskCompleted", "A")).toBe(1);

    // Identical to a single-delivery (no-duplicate) run, driven AFTER this one
    // completes so no overlapping leasable job of the same task type exists.
    const control = await parallelSingleDelivery(token, "idmp-dupjob-1-ctrl");
    expect(done.body.variables).toEqual(control);
  });

  // -------------------------------------------------------------------------
  // [C-IDEMP-DUP-01] — at-least-once into ONE branch (the duplicate-MESSAGE half).
  it("[C-IDEMP-DUP-01] a duplicate message publish into branch A advances exactly once; merged vars == single-delivery", async () => {
    const { instance } = await publishAndStart(PARALLEL_MESSAGE_DISTINCT_BPMN, { correlationKey: "idmp-dupmsg-1", variables: {} });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Satisfy branch A's catch ("Ready"), then re-publish the SAME
    // {workspaceId, messageName, correlationKey, messageId}.
    const a1 = await publishMessage({ messageName: "Ready", correlationKey: "idmp-dupmsg-1", messageId: "dm-a", payload: { shared: "A", fromA: 1 } });
    expect(a1.body.outcome).toBe("correlated");

    const a2 = await publishMessage({ messageName: "Ready", correlationKey: "idmp-dupmsg-1", messageId: "dm-a", payload: { shared: "A", fromA: 1 } });
    // The duplicate returns the STABLE prior outcome — no second advance.
    expect(a2.body.outcome).toBe("duplicate");
    expect(a2.body.duplicateOf).toBe(a1.body.externalMessageId);

    // Branch A correlated exactly once; the join has NOT fired (branch B "Paid" pending).
    expect(await historyCount(id, "messageCorrelated", "R1")).toBe(1);
    expect(["running", "waiting"]).toContain(await statusOf(id));

    // Satisfy branch B's catch ("Paid") → the join fires once → completed.
    const b1 = await publishMessage({ messageName: "Paid", correlationKey: "idmp-dupmsg-1", messageId: "dm-b", payload: { shared: "B", fromB: 1 } });
    expect(b1.body.outcome).toBe("correlated");
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
    expect(await historyCount(id, "messageCorrelated", "R1")).toBe(1); // still exactly once
    expect(await historyCount(id, "messageCorrelated", "R2")).toBe(1);
    // Document-order merge winner (f2 "Paid" = "B"); identical to a single-delivery run.
    expect(done.body.variables).toMatchObject({ shared: "B", fromA: 1, fromB: 1 });
    const control = await messageSingleDelivery("idmp-dupmsg-1-ctrl");
    expect(done.body.variables).toEqual(control);
  });

  // -------------------------------------------------------------------------
  // [C-IDEMP-MSGTIMING-01] — early-buffered + late message into a token-set branch.
  it("[C-IDEMP-MSGTIMING-01] branch A claims an early-buffered message at registration; a later messageId is `late`, never re-advancing the branch", async () => {
    const key = "idmp-msgtiming-1";
    const draft = await createDraft(PARALLEL_MESSAGE_DISTINCT_BPMN);
    const version = await publishDraft(draft.body.draftId);

    // EARLY: publish branch A's "Ready" BEFORE the instance (and thus before any
    // subscription) exists — it must be BUFFERED (1h TTL). (Direct mode drives the
    // start synchronously to the parked frontier, so "before fan-out" == before start.)
    const early = await publishMessage({ messageName: "Ready", correlationKey: key, messageId: "mt-ready-early", payload: { ready: true, fromA: 1 } });
    const started = await startInstance(version.body.definitionVersionId, { correlationKey: key, variables: {} });
    expect(started.status).toBe(201); // published (201)
    expect(early.body.outcome).toBe("buffered");
    const id = started.body.instanceId;

    // Fan-out: branch A registers its "Ready" subscription, which CLAIMS the buffered
    // message (earliest-buffered, at-most-one active subscription per broker key) and
    // advances branch A to the join. Branch B ("Paid") parks → instance not yet done.
    expect(await historyCount(id, "messageCorrelated", "R1")).toBe(1);
    expect(["running", "waiting"]).toContain(await statusOf(id));
    expect(await historyCount(id, "messageCorrelated", "R2")).toBe(0);
    // Re-publishing the early messageId is a stable duplicate of the buffered outcome.
    const earlyDup = await publishMessage({ messageName: "Ready", correlationKey: key, messageId: "mt-ready-early", payload: { ready: true, fromA: 1 } });
    expect(earlyDup.body.outcome).toBe("duplicate");

    // LATE: a NEW messageId for the SAME "Ready" name arrives after branch A advanced
    // (the broker key was consumed). It cannot correlate → recorded `late`, rejected.
    const late = await publishMessage({ messageName: "Ready", correlationKey: key, messageId: "mt-ready-late", payload: { ready: false, fromA: 999 } });
    expect(late.status).toBe(409);
    expect(late.body.outcome).toBe("rejected");
    const lateView = await get(`/messages/${late.body.externalMessageId}`);
    expect(lateView.body.finalOutcome).toBe("late");
    expect(lateView.body.reason).toMatch(/late/i);
    // Branch A did NOT re-advance, and the join is unaffected (still pending branch B).
    expect(await historyCount(id, "messageCorrelated", "R1")).toBe(1);
    expect(["running", "waiting"]).toContain(await statusOf(id));

    // Satisfy branch B → join fires → completed; the early payload survived the merge.
    const paid = await publishMessage({ messageName: "Paid", correlationKey: key, messageId: "mt-paid", payload: { paid: true, fromB: 1 } });
    expect(paid.body.outcome).toBe("correlated");
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
    expect(done.body.variables).toMatchObject({ ready: true, fromA: 1, paid: true, fromB: 1 });
    expect(done.body.variables.fromA).toBe(1); // the `late` payload (fromA:999) never landed
  });
});

describe("matrix: operator /retry on compensationFailed in one lineage (direct mode)", () => {
  // -------------------------------------------------------------------------
  // [C-OP-RETRY-COMPFAILED-01]
  it("[C-OP-RETRY-COMPFAILED-01] /retry re-drives ONLY the failed compensator; sibling lineage not re-run; incident closed; terminal compensated, no double-apply", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, { correlationKey: "opretry-cf1", variables: { failSettle: true } });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Forward both branches in order so seq(branchA)=1 < seq(branchB)=2 → the reverse
    // pass compensates branchB FIRST (succeeds) and branchA last (we exhaust it).
    await leaseAndComplete(token, "branch-a", {});
    await leaseAndComplete(token, "branch-b", {});
    await failSettle(token); // settle SETTLE_REJECTED → Tx_cancel → reverse pass

    // Sibling branchB compensates first (comp-b, highest seq) and succeeds.
    await complete(token, await leaseOne(token, "comp-b"), {});
    expect((await stepOf(id, "branchB"))!.compensationStatus).toBe("compensated");
    expect(await compJobCount(id, "branchB")).toBe(1);

    // branchA's compensator exhausts its 3 retries (comp-a retries=3) → compensationFailed.
    await exhaustCompensator(token, id, "comp-a", 3);
    const failed = await get(`/instances/${id}`);
    expect(failed.body.status).toBe("compensationFailed");
    expect(failed.body.incident.kind).toBe("compensationFailure");
    expect(failed.body.incident.elementId).toBe("branchA");
    expect(failed.body.incident.resolution).toBe("open");
    expect((await getOpenIncidentsForInstance(env.DB, id)).some((i) => i.kind === "compensationFailure")).toBe(true);
    expect((await stepOf(id, "branchA"))!.compensationStatus).toBe("failed");
    // The sibling lineage stayed compensated, untouched by the failure.
    expect((await stepOf(id, "branchB"))!.compensationStatus).toBe("compensated");
    expect(await compJobCount(id, "branchB")).toBe(1);

    // Operator /retry: a CONDITIONAL reset on the compensationFailed status → compensating.
    const retry = await post(`/instances/${id}/retry`, {});
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("compensating");

    // ONLY the failed compensator is re-driven: comp-a re-leases at a FRESH attempt
    // budget (attempt 1), reusing the SAME comp job (no new comp-a job)...
    const c = await leaseOne(token, "comp-a");
    expect(c.attempt).toBe(1);
    // ...and the already-compensated sibling is NOT re-run — no comp-b job to lease.
    const noSibling = await authedPost("/jobs/activate", token, { taskType: "comp-b", workerId: "w-resib" });
    expect(noSibling.body.jobs).toHaveLength(0);
    await complete(token, c, {});

    // Terminal compensated; the compensationFailure incident is closed; no double-apply.
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    expect((await stepOf(id, "branchA"))!.compensationStatus).toBe("compensated");
    expect(await getOpenIncidentsForInstance(env.DB, id)).toHaveLength(0); // incident closed
    expect(await compJobCount(id, "branchA")).toBe(1); // SAME comp job reused across the retry
    expect(await compJobCount(id, "branchB")).toBe(1); // sibling ran exactly once
    expect(await historyCount(id, "compensationCompleted", "branchA")).toBe(1);
    expect(await historyCount(id, "compensationCompleted", "branchB")).toBe(1);
    expect(await liveTokens(id)).toHaveLength(0);
  });
});
