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
});
