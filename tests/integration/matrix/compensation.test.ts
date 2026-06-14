import { describe, it, expect } from "vitest";
import { env, runDurableObjectAlarm } from "cloudflare:test";
import {
  publishAndStart,
  get,
  authedPost,
  leaseOne,
  leaseAndComplete,
  mintWorkerToken,
  rewindBackoff,
  drainSampleWorkers,
  post,
  PARALLEL_SAGA_BPMN,
} from "../../helpers";
import {
  PARALLEL_SAGA_MULTISTEP_BPMN,
  PARALLEL_NESTEDTX_BRANCH_BPMN,
  PARALLEL_LOOP_BRANCH_BPMN,
  PARALLEL_BRANCH_ERR_COMP_BPMN,
} from "../../fixtures/matrix/fixtures";
import { getSagaStepsForInstance } from "../../../src/persistence/saga";
import { listTokens } from "../../../src/persistence/tokens";

// Direct-mode characterization of the M4 saga-compensation corners under
// concurrency (Phase-1 matrix, Task 3.4). M4 (L1-L6) is shipped+green, so each of
// these SHOULD pass; several are NEW coverage of subtle per-lineage / quiescence
// invariants. The matrix fixtures use CUSTOM service-task types with NO registered
// sample worker (only `branch-settle`/`failSettle` + `branch-b`/`hazardBranchB`
// from PARALLEL_SAGA_BPMN are sample-worker-wired), so every other task — forward
// AND compensation — is driven over the pull data plane (leaseOne/leaseAndComplete
// + explicit /jobs/{id}/complete|fail), never drainSampleWorkers.

// --- shared helpers ----------------------------------------------------------

const complete = (
  t: string,
  j: { jobId: string; lockToken: string },
  out: Record<string, unknown> = {},
) => authedPost(`/jobs/${j.jobId}/complete`, t, { lockToken: j.lockToken, outputVariables: out });

const TERMINAL = ["compensated", "compensationFailed", "cancelled", "completed", "failed", "incident"];

const statusOf = async (id: string): Promise<string> => (await get(`/instances/${id}`)).body.status;

const liveTokens = async (id: string) =>
  (await listTokens(env.DB, id)).filter((r) => ["active", "waiting", "arrivedAtJoin"].includes(r.status));

const steps = (id: string) => getSagaStepsForInstance(env.DB, id);
const stepOf = async (id: string, elementId: string, occurrence = 0) =>
  (await steps(id)).find((s) => s.elementId === elementId && s.occurrence === occurrence);

/** All history events of a type, in audit (rowid) order, mapped to {elementId, occurrence}. */
async function historyOf(id: string, type: string): Promise<Array<{ elementId: string | null; occurrence: number | undefined }>> {
  const h = await get(`/instances/${id}/history`);
  return (h.body.events as any[])
    .filter((e) => e.type === type)
    .map((e) => ({ elementId: e.elementId as string | null, occurrence: e.diagnostics?.occurrence as number | undefined }));
}
const compStartedElements = async (id: string): Promise<string[]> =>
  (await historyOf(id, "compensationStarted")).map((e) => e.elementId!).filter(Boolean);
const compCompletedElements = async (id: string): Promise<string[]> =>
  (await historyOf(id, "compensationCompleted")).map((e) => e.elementId!).filter(Boolean);

/** Count compensation-lane job rows for a given FORWARD element id. */
async function compJobCount(id: string, elementId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND element_id = ? AND is_compensation = 1`,
  )
    .bind(id, elementId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}
const jobRow = (jobId: string) =>
  env.DB.prepare(`SELECT status, lock_token, attempt_count FROM service_task_jobs WHERE job_id = ?`)
    .bind(jobId)
    .first<{ status: string; lock_token: string | null; attempt_count: number }>();

/**
 * Drive the reverse compensation pass to its terminal: the engine creates ONE
 * comp job at a time (highest-seq eligible step) and parks `compensating`; each
 * /jobs/complete re-drives and creates the next. So just poll every comp taskType
 * and complete whatever is open until the instance is terminal (or stalls).
 */
async function driveComps(token: string, id: string, compTypes: string[], maxRounds = 80): Promise<string> {
  for (let r = 0; r < maxRounds; r++) {
    const st = await statusOf(id);
    if (TERMINAL.includes(st)) return st;
    let progressed = false;
    for (const t of compTypes) {
      const act = await authedPost("/jobs/activate", token, { taskType: t, workerId: "comp-w" });
      for (const job of (act.body.jobs ?? []) as any[]) {
        progressed = true;
        await complete(token, job, {});
      }
    }
    if (!progressed) return statusOf(id);
  }
  return statusOf(id);
}

/**
 * Fail a leased compensation job to retry-exhaustion. Comp jobs share the forward
 * retry semantics: `retries=N` ⇒ N lease attempts, each retryable fail parks behind
 * backoff and re-leases the SAME job; the Nth fail is terminal-for-the-step
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

describe("matrix: saga compensation under concurrency (direct mode)", () => {
  // -------------------------------------------------------------------------
  it("[C-COMP-LINEAGE-REVERSE-01] per-lineage reverse (seq DESC over the SAME branch token); cross-branch order unpinned", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_SAGA_MULTISTEP_BPMN, {
      correlationKey: "clr1",
      variables: { failSettle: true },
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Drive both 2-step branches forward (chain A: A1→A2, chain B: B1→B2). seq is
    // assigned at forward completion, so within each lineage A2>A1 and B2>B1.
    await leaseAndComplete(token, "ms-a1", {});
    await leaseAndComplete(token, "ms-a2", {});
    await leaseAndComplete(token, "ms-b1", {});
    await leaseAndComplete(token, "ms-b2", {});

    // Post-join settle raises SETTLE_REJECTED → error boundary → Tx_cancel → reverse pass.
    await failSettle(token);
    const terminal = await driveComps(token, id, ["comp-ms-a1", "comp-ms-a2", "comp-ms-b1", "comp-ms-b2"]);
    expect(terminal).toBe("compensated");

    const all = await steps(id);
    const A1 = all.find((s) => s.elementId === "A1")!;
    const A2 = all.find((s) => s.elementId === "A2")!;
    const B1 = all.find((s) => s.elementId === "B1")!;
    const B2 = all.find((s) => s.elementId === "B2")!;
    expect([A1, A2, B1, B2].every(Boolean)).toBe(true);

    // Per-lineage: each branch's two steps share ONE branch token id; the two
    // branches are distinct lineages (no happens-before between them).
    expect(A1.tokenId).toBe(A2.tokenId);
    expect(B1.tokenId).toBe(B2.tokenId);
    expect(A1.tokenId).not.toBe(B1.tokenId);
    expect(A1.tokenId).toBeTruthy();
    expect(B1.tokenId).toBeTruthy();

    // seq DESC reverse-pass order WITHIN a lineage: the later step compensates first.
    expect(A2.seq).toBeGreaterThan(A1.seq);
    expect(B2.seq).toBeGreaterThan(B1.seq);

    // The compensationStarted audit order proves the per-lineage suffix order:
    // comp-ms-a2 strictly before comp-ms-a1; comp-ms-b2 strictly before comp-ms-b1.
    const order = await compStartedElements(id);
    expect(order.indexOf("A2")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("A2")).toBeLessThan(order.indexOf("A1"));
    expect(order.indexOf("B2")).toBeLessThan(order.indexOf("B1"));
    // CROSS-branch order is NOT pinned — deliberately asserted only per-lineage.

    // Every step compensated; instance terminal compensated; frontier drained.
    for (const s of [A1, A2, B1, B2]) expect(s.compensationStatus).toBe("compensated");
    expect(await statusOf(id)).toBe("compensated");
    expect(await liveTokens(id)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it("[C-COMP-FAILED-01] one compensator exhausts retries → compensationFailed incident; sibling lineage compensated; operator-resumable, no double-apply", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, {
      correlationKey: "cf1",
      variables: { failSettle: true },
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Forward both branches in a controlled order so seq(branchA)=1 < seq(branchB)=2.
    // The reverse pass then compensates branchB FIRST (it succeeds) and branchA last
    // (we exhaust it) — proving the sibling lineage is unaffected by the failure.
    await leaseAndComplete(token, "branch-a", {});
    await leaseAndComplete(token, "branch-b", {});
    await failSettle(token);

    // comp-b (highest seq) is the first comp job → complete it (sibling lineage).
    await complete(token, await leaseOne(token, "comp-b"), {});
    expect((await stepOf(id, "branchB"))!.compensationStatus).toBe("compensated");

    // comp-a is now created → exhaust its 3 retries (comp-a retries=3) → compensationFailed.
    await exhaustCompensator(token, id, "comp-a", 3);

    const failed = await get(`/instances/${id}`);
    expect(failed.body.status).toBe("compensationFailed");
    expect(failed.body.incident.kind).toBe("compensationFailure");
    expect(failed.body.incident.elementId).toBe("branchA");
    expect(failed.body.incident.resolution).toBe("open");
    // The sibling lineage stayed compensated; the failed step is `failed`, not double-applied.
    expect((await stepOf(id, "branchB"))!.compensationStatus).toBe("compensated");
    expect((await stepOf(id, "branchA"))!.compensationStatus).toBe("failed");
    expect(await compJobCount(id, "branchB")).toBe(1); // comp-b ran exactly once
    expect((await compCompletedElements(id)).filter((e) => e === "branchB")).toHaveLength(1);

    // Operator-resumable: /retry resets ONLY the failed comp step → compensating (non-4xx).
    const retry = await post(`/instances/${id}/retry`, {});
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("compensating");

    // The reset comp-a re-runs (fresh attempt budget) and succeeds → terminal compensated.
    const c = await leaseOne(token, "comp-a");
    expect(c.attempt).toBe(1);
    await complete(token, c, {});

    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    expect((await stepOf(id, "branchA"))!.compensationStatus).toBe("compensated");
    // No double-apply: each branch compensated exactly once.
    expect(await compJobCount(id, "branchA")).toBe(1);
    expect(await compJobCount(id, "branchB")).toBe(1);
    expect((await compCompletedElements(id)).filter((e) => e === "branchB")).toHaveLength(1);
    expect(await liveTokens(id)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it("[C-COMP-FAILED-INFLIGHT-01] compensationFailed declared while a sibling forward job is still live; terminator/late-complete are guarded no-ops; /retry straggler-ledgers + compensates it", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, {
      correlationKey: "cfi1",
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Both branches in-flight (leased, nothing completed) → operator cancel leaves the
    // cohort live with the compensation scope resolvable. branch-a (retries=2) is the
    // still-in-flight sibling we re-lease later as a straggler; branch-b is completed
    // late (post-cancel straggler) so its compensator (comp-b) can be exhausted.
    const aLease = await leaseOne(token, "branch-a"); // locked, the live sibling
    const bLease = await leaseOne(token, "branch-b");
    const aJobId = aLease.jobId;

    const cancelled = await post(`/instances/${id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("compensating");

    // Late-complete branch-b → straggler-ledgered → comp-b created. branch-a stays
    // locked + live (the live sibling branchA token does NOT block branchB's lineage).
    const bAck = await complete(token, bLease, { didWork: true });
    expect(bAck.body.outcome).toBe("completed");
    expect(await compJobCount(id, "branchB")).toBe(1);

    // Exhaust comp-b's 3 retries → compensationFailed declared THE INSTANT comp-b fails,
    // while branchA is still locked + live (the barrier does NOT wait for branchA).
    await exhaustCompensator(token, id, "comp-b", 3);
    expect(await statusOf(id)).toBe("compensationFailed");
    const inc = (await get(`/instances/${id}`)).body.incident;
    expect(inc.kind).toBe("compensationFailure");
    expect(inc.elementId).toBe("branchB");
    expect(inc.resolution).toBe("open");
    // branchA is still in-flight + live; it owes no ledger row yet (never completed).
    expect((await jobRow(aJobId))!.status).toBe("locked");
    expect((await liveTokens(id)).length).toBeGreaterThanOrEqual(1);
    expect(await stepOf(id, "branchA")).toBeUndefined();

    // branchA's lease-expiry terminator firing on the now-compensationFailed instance
    // is a GUARDED no-op (terminateUnleasableJob only acts when status==='compensating').
    // Force the lease overdue, fire the JobScheduler alarm armed at cancel time.
    await env.DB.prepare(`UPDATE service_task_jobs SET lock_expires_at = '2000-01-01T00:00:00Z' WHERE job_id = ?`)
      .bind(aJobId)
      .run();
    const ran = await runDurableObjectAlarm(env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(aJobId)));
    expect(ran).toBe(true); // an alarm WAS armed for the cohort job at cancel
    expect((await jobRow(aJobId))!.status).toBe("locked"); // guarded: NOT failed
    expect(await statusOf(id)).toBe("compensationFailed");

    // A late branchA completion is NOT advanced past the terminal: the complete handler
    // no-ops on a terminal instance (disposition 'ignored'); branchA stays locked.
    const lateAck = await complete(token, aLease, { didWork: true });
    expect(lateAck.status).toBe(200);
    expect(lateAck.body.disposition).toBe("ignored");
    expect(await statusOf(id)).toBe("compensationFailed");
    expect((await jobRow(aJobId))!.status).toBe("locked");

    // Fix comp-b + /retry → resumes compensating; the barrier re-scans.
    const retry = await post(`/instances/${id}/retry`, {});
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("compensating");

    // The genuine straggler: branchA's lease lapsed (rewound above), so a reclaim
    // re-hands it (attempt 2 of 2 — within budget) with a FRESH token; completing it
    // under `compensating` straggler-ledgers branchA + consumes its token. (The
    // original lease's lock token was poisoned by the late-complete idempotency,
    // mirroring at-least-once redelivery.)
    await authedPost("/jobs/activate", token, { taskType: "branch-a", workerId: "reclaim" }); // reclaim → backoff park
    await rewindBackoff(id, "branch-a");
    const aStraggler = await leaseOne(token, "branch-a");
    expect(aStraggler.jobId).toBe(aJobId); // same forward job, re-leased
    await complete(token, aStraggler, { didWork: true });

    // Drain the reverse pass: branchA (straggler-ledgered) + branchB (reset) compensate.
    const terminal = await driveComps(token, id, ["comp-a", "comp-b"]);
    expect(terminal).toBe("compensated");

    const aStep = await stepOf(id, "branchA");
    expect(aStep).toBeDefined(); // straggler-ledgered
    expect(aStep!.compensationStatus).toBe("compensated");
    expect((await stepOf(id, "branchB"))!.compensationStatus).toBe("compensated");
    // No double-apply: exactly one comp job per branch.
    expect(await compJobCount(id, "branchA")).toBe(1);
    expect(await compJobCount(id, "branchB")).toBe(1);
    expect(await liveTokens(id)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it("[C-COMP-NESTEDTX-BRANCH-01] an inner-tx-committed step is never re-compensated by the outer cancel; outer-scope branch steps are", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_NESTEDTX_BRANCH_BPMN, {
      correlationKey: "cnx1",
      variables: { failSettle: true },
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Branch A: inner transaction (ntx-a1 → inner none-end COMMIT) then ntx-a2.
    // Completing ntx-a1 drives the inner none-end → the inner tx commits → ntx-a1's
    // step is terminalized `committed`.
    await leaseAndComplete(token, "ntx-a1", {});
    expect((await stepOf(id, "a1"))!.compensationStatus).toBe("committed");
    await leaseAndComplete(token, "ntx-a2", {});
    // Branch B: a single outer-scope compensatable task.
    await leaseAndComplete(token, "ntx-b", {});

    // failSettle → outer Tx_outer_cancel → reverse pass over the OUTER scope.
    await failSettle(token);
    const terminal = await driveComps(token, id, ["comp-ntx-a1", "comp-ntx-a2", "comp-ntx-b"]);
    expect(terminal).toBe("compensated");

    // The inner-committed step stays `committed` and is NEVER re-compensated: no
    // comp-ntx-a1 job is ever created.
    expect((await stepOf(id, "a1"))!.compensationStatus).toBe("committed");
    expect(await compJobCount(id, "a1")).toBe(0);
    expect((await compStartedElements(id)).includes("a1")).toBe(false);

    // The outer-scope branch steps ARE compensated in their lineages.
    expect((await stepOf(id, "a2"))!.compensationStatus).toBe("compensated");
    expect((await stepOf(id, "branchB"))!.compensationStatus).toBe("compensated");
    expect(await compJobCount(id, "a2")).toBe(1);
    expect(await compJobCount(id, "branchB")).toBe(1);

    expect(await statusOf(id)).toBe("compensated");
    expect(await liveTokens(id)).toHaveLength(0);
  });
});
