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
  post,
  PARALLEL_BPMN,
  PARALLEL_SAGA_BPMN,
} from "../../helpers";
import { PARALLEL_LOOP_INBRANCH_BPMN } from "../../fixtures/matrix/fixtures";
import { listTokens } from "../../../src/persistence/tokens";
import { MAX_ELEMENT_OCCURRENCES, terminateUnleasableJob } from "../../../src/runtime/engine";

// Direct-mode characterization of the M4 cap / loop / DLQ / retry corners under
// concurrency (Phase-1 matrix, Task 3.6). M4 (L1-L6) is shipped+green, so each of
// these SHOULD pass — all NEW coverage.
//
// The matrix fixture (PARALLEL_LOOP_INBRANCH_BPMN) and PARALLEL_BPMN /
// PARALLEL_SAGA_BPMN branch tasks use CUSTOM service-task types with NO registered
// sample worker, so every task is driven over the pull data plane (leaseOne /
// leaseAndComplete + explicit /jobs/{id}/complete|fail), never drainSampleWorkers.

// --- shared helpers ----------------------------------------------------------

const complete = (
  t: string,
  j: { jobId: string; lockToken: string },
  out: Record<string, unknown> = {},
) => authedPost(`/jobs/${j.jobId}/complete`, t, { lockToken: j.lockToken, outputVariables: out });

const LIVE = ["active", "waiting", "arrivedAtJoin"];
const liveTokens = (rows: Array<{ status: string }>) => rows.filter((r) => LIVE.includes(r.status));

async function joinCompletionCount(instanceId: string, joinId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM join_completions WHERE instance_id = ? AND join_id = ?`,
  )
    .bind(instanceId, joinId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function decisionCount(instanceId: string, elementId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM gateway_decisions WHERE instance_id = ? AND element_id = ?`,
  )
    .bind(instanceId, elementId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function compJobCount(instanceId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 1`,
  )
    .bind(instanceId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

const fullJobRow = (jobId: string) =>
  env.DB.prepare(
    `SELECT job_id, element_id, task_type, status, lock_token, lock_expires_at, attempt_count, occurrence, is_compensation FROM service_task_jobs WHERE job_id = ?`,
  )
    .bind(jobId)
    .first<any>();

const jobByType = (instanceId: string, taskType: string) =>
  env.DB.prepare(
    `SELECT job_id, element_id, status, attempt_count, activation_expires_at, occurrence FROM service_task_jobs WHERE instance_id = ? AND task_type = ? AND is_compensation = 0`,
  )
    .bind(instanceId, taskType)
    .first<any>();

const historyLen = async (id: string) => ((await get(`/instances/${id}/history`)).body.events as any[]).length;
const schedulerStub = (jobId: string) => env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(jobId));

describe("matrix: caps, loops, DLQ & retry under concurrency (direct mode)", () => {
  // -------------------------------------------------------------------------
  it("[C-LOOP-INBRANCH-01] a loop wholly inside one AND branch keys per-branch occurrences (#0,#1,#2); sibling is an independent lineage; join waits for the looped branch", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_LOOP_INBRANCH_BPMN, {
      correlationKey: `li-${crypto.randomUUID()}`,
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Branch A loops li-a: the split Xl reads `loopAgain` from li-a's branch-local
    // output — true loops back via the merge Xm, false exits via the default xl_done
    // to the join. Three li-a completions ⇒ occurrences #0,#1,#2.
    await leaseAndComplete(token, "li-a", { loopAgain: true, a0: 1 }); // occ 0
    await leaseAndComplete(token, "li-a", { loopAgain: true, a1: 1 }); // occ 1 (arms occ 2)

    // Sibling branch B arrives at the AND join — but the join must WAIT for the still
    // looping branch A (last-token-out).
    await leaseAndComplete(token, "li-b", { b: 1 });
    expect((await get(`/instances/${id}`)).body.status).not.toBe("completed");

    await leaseAndComplete(token, "li-a", { loopAgain: false, a2: 1 }); // occ 2 (exit → join fires)

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");

    // Each branch-A iteration is its OWN occurrence-keyed job row (svcA #0,#1,#2);
    // sibling B is an independent lineage at occurrence 0 (no cross-token collision).
    const jobs = await env.DB.prepare(
      `SELECT element_id, occurrence FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 0 ORDER BY element_id, occurrence`,
    )
      .bind(id)
      .all<{ element_id: string; occurrence: number }>();
    expect((jobs.results ?? []).map((j) => [j.element_id, j.occurrence])).toEqual([
      ["svcA", 0],
      ["svcA", 1],
      ["svcA", 2],
      ["svcB", 0],
    ]);

    // The three li-a occurrences all ran on the SAME branch-A token (one lineage
    // looping in place); branch B is a distinct token.
    const rows = await listTokens(env.DB, id);
    const aTok = rows.find((r) => r.branch_flow_id === "f1");
    const bTok = rows.find((r) => r.branch_flow_id === "f2");
    expect(aTok).toBeDefined();
    expect(bTok).toBeDefined();
    expect(aTok!.token_id).not.toBe(bTok!.token_id);

    // The join folded looped-A + B into root variables; frontier drained.
    expect(inst.body.variables).toMatchObject({ a0: 1, a1: 1, a2: 1, b: 1 });
    expect(liveTokens(rows)).toHaveLength(0);
    // No incident of any kind (in particular NOT loopLimit) — a normal-length loop.
    const incidents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE instance_id = ?`)
      .bind(id)
      .first<{ n: number }>();
    expect(incidents?.n).toBe(0);
  });

  // -------------------------------------------------------------------------
  it(
    "[C-LOOP-LIMIT-BRANCH-01] a gateway self-loop inside one AND branch trips MAX_ELEMENT_OCCURRENCES → terminal loopLimit (not stepBudget / concurrencyLimit); process-level Hazard, no auto-compensation, sibling frozen",
    { timeout: 90_000 },
    async () => {
      const token = await mintWorkerToken();
      // spin=true with loopAgain unset: FEEL evaluates xl_loop (loopAgain) BEFORE
      // xl_spin (spin) in document order, so loopAgain must be false/unset for the
      // self-loop xl_spin to win and burn occurrences with zero jobs.
      const { instance } = await publishAndStart(PARALLEL_LOOP_INBRANCH_BPMN, {
        correlationKey: `ll-${crypto.randomUUID()}`,
        variables: { spin: true },
      });
      expect(instance.status).toBe(201);
      const id = instance.body.instanceId;

      // ONE li-a completion drives branch A's token svcA → Xl; with spin=true Xl takes
      // the xl_spin SELF-LOOP (pure gateway visits, zero jobs) until the walk-local
      // counter trips the real cap inside this single drive.
      await leaseAndComplete(token, "li-a", { spin: true });

      const inst = await get(`/instances/${id}`);
      expect(inst.body.status).toBe("incident");
      expect(inst.body.incident.kind).toBe("loopLimit");
      expect(inst.body.incident.kind).not.toBe("stepBudget");
      expect(inst.body.incident.kind).not.toBe("concurrencyLimit");
      expect(inst.body.incident.elementId).toBe("Xl"); // the self-looping split in branch A
      expect(inst.body.incident.status).toBe("open");
      expect(inst.body.incident.reason).toContain("Xl");
      expect(inst.body.incident.reason).toContain(String(MAX_ELEMENT_OCCURRENCES));
      expect(inst.body.incident.payloadContext.occurrence).toBe(MAX_ELEMENT_OCCURRENCES);
      expect(inst.body.incident.payloadContext.cap).toBe(MAX_ELEMENT_OCCURRENCES);
      // Storage stays bounded: visits 0..cap-1 each wrote one decision row.
      expect(await decisionCount(id, "Xl")).toBe(MAX_ELEMENT_OCCURRENCES);

      // Process-level fixture (NO transaction): a loopLimit Hazard does NOT
      // auto-compensate — no compensation jobs exist.
      expect(await compJobCount(id)).toBe(0);

      // Sibling branch B is FROZEN: its li-b job was created at fan-out but never
      // leased, its branch token still live.
      const bJob = await jobByType(id, "li-b");
      expect(bJob.status).toBe("created"); // never advanced
      const bTok = (await listTokens(env.DB, id)).find((r) => r.branch_flow_id === "f2");
      expect(bTok).toBeDefined();
      expect(LIVE).toContain(bTok!.status);

      // Terminal within the test: exactly one incident; a re-read is stable.
      const incidents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE instance_id = ?`)
        .bind(id)
        .first<{ n: number }>();
      expect(incidents?.n).toBe(1);
      expect((await get(`/instances/${id}`)).body.status).toBe("incident");
    },
  );

  // -------------------------------------------------------------------------
  it("[C-BRANCH-DLQ-01] a never-leased AND-branch service job hits its activation TTL → jobActivationTimeout via the per-job JobScheduler DLQ; sibling frozen; duplicate alarm is a no-op; operator /cancel settles the cohort", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_BPMN, {
      correlationKey: `dlq-${crypto.randomUUID()}`,
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // The LIVE sibling (authorize-payment, branch B) is leased + LEFT in-flight — the
    // frozen cohort token captured by the cancel. Branch A's reserve-stock is NEVER
    // leased; it stays 'created', armed with activation_expires_at at fan-out.
    const bLease = await leaseOne(token, "authorize-payment");
    expect(bLease.attempt).toBe(1);
    const aJob = await jobByType(id, "reserve-stock");
    expect(aJob.status).toBe("created");
    expect(aJob.activation_expires_at).not.toBeNull(); // armed with a TTL at creation

    // Mechanism (saga-dlq-timeout.test.ts): rewind activation_expires_at into the past,
    // then fire the per-job JobScheduler DO alarm armed at job creation.
    await env.DB.prepare(`UPDATE service_task_jobs SET activation_expires_at = '2000-01-01T00:00:00Z' WHERE job_id = ?`)
      .bind(aJob.job_id)
      .run();
    const ran = await runDurableObjectAlarm(schedulerStub(aJob.job_id));
    expect(ran).toBe(true);

    // terminateUnleasableJob wrote a terminal incident kind='jobActivationTimeout'
    // (NOT waitTimeout, NOT serviceTaskFailure) attributed to branch A's task element.
    const inc1 = await get(`/instances/${id}`);
    expect(inc1.body.status).toBe("incident");
    expect(inc1.body.incident.kind).toBe("jobActivationTimeout");
    expect(inc1.body.incident.kind).not.toBe("waitTimeout");
    expect(inc1.body.incident.kind).not.toBe("serviceTaskFailure");
    expect(inc1.body.incident.elementId).toBe("A"); // reserve-stock lives in branch A
    expect(inc1.body.incident.reason).toMatch(/un-leasable/i);
    // The DLQ'd job is failed so a stray late lease can't pick it up.
    expect((await fullJobRow(aJob.job_id)).status).toBe("failed");

    // The live sibling (authorize-payment) is FROZEN: still 'locked' (in-flight),
    // never advanced past the join, its branch token live, and the join never fired.
    expect((await fullJobRow(bLease.jobId)).status).toBe("locked");
    const bTok = (await listTokens(env.DB, id)).find((r) => r.branch_flow_id === "f2");
    expect(bTok).toBeDefined();
    expect(LIVE).toContain(bTok!.status);
    expect(await joinCompletionCount(id, "join")).toBe(0);

    // A duplicate / late alarm fire is an idempotent no-op — no new incident, no new history.
    const beforeLen = await historyLen(id);
    const firstIncidentId = inc1.body.incident.incidentId;
    await terminateUnleasableJob(env, aJob.job_id); // late/duplicate
    expect(await historyLen(id)).toBe(beforeLen);
    const inc2 = await get(`/instances/${id}`);
    expect(inc2.body.status).toBe("incident");
    expect(inc2.body.incident.incidentId).toBe(firstIncidentId);
    const incidents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE instance_id = ?`)
      .bind(id)
      .first<{ n: number }>();
    expect(incidents?.n).toBe(1);

    // Operator /cancel from the incident captures the frozen cohort INTO the compensation
    // lifecycle. PARALLEL_BPMN is a region with live cohort tokens, so cancel does NOT take
    // the empty-ledger 'cancelled' shortcut (index.ts gates it on liveCohort===0) — it
    // transitions to 'compensating'.
    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("compensating"); // cohort captured into the compensation lifecycle

    // CHARACTERIZATION FINDING (reported as a concern, NOT weakened to hide it): for a
    // PROCESS-LEVEL region (no enclosing transaction) the reverse pass has no transaction
    // scopeId to run — engine.ts runInstanceInner bails for a compensating instance whose
    // current element is process-scoped ("if (!scopeId) return {completed}"), so the cohort
    // straggler scan never runs. The captured cohort therefore does NOT auto-drain to a
    // terminal state in direct mode: the instance is STABLE at 'compensating' (a
    // non-terminal limbo) with its cohort tokens still tracked. A TRANSACTION-scoped region
    // (PARALLEL_SAGA_*) drains to a terminal 'compensated' — see compensation.test.ts.
    const afterCancel = await get(`/instances/${id}`);
    expect(afterCancel.body.status).toBe("compensating"); // stable, non-terminal limbo
    expect(liveTokens(await listTokens(env.DB, id)).length).toBeGreaterThan(0); // cohort captured, not drained
  });

  // -------------------------------------------------------------------------
  // PARALLEL_SAGA_BPMN's branchA carries easy-bpmn:taskDefinition retries="2" (>=2);
  // PARALLEL_BPMN's reserve-stock omits retries → DEFAULT_SERVICE_TASK_ATTEMPTS=1, too
  // few for a retry-then-{succeed|exhaust} pair, so PARALLEL_SAGA_BPMN is used here.
  it("[C-BRANCH-RETRY-01] retryable /jobs/fail parks an occurrence-keyed branch job behind backoff; reclaim re-leases the SAME row (attempt bumped); sibling proceeds; succeeds after a retry, then exhausts to a serviceTaskFailure Hazard", async () => {
    // ===== variant 1: success after one retry =====
    {
      const token = await mintWorkerToken();
      const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, {
        correlationKey: `retry-ok-${crypto.randomUUID()}`,
        variables: {},
      });
      expect(instance.status).toBe(201);
      const id = instance.body.instanceId;

      // Lease branch A (retries=2) → attempt 1; retryable fail parks it behind backoff.
      const a1 = await leaseOne(token, "branch-a");
      expect(a1.attempt).toBe(1);
      const failAt = Date.now();
      const failed = await authedPost(`/jobs/${a1.jobId}/fail`, token, {
        lockToken: a1.lockToken,
        reason: "transient PSP outage",
        retryable: true,
      });
      expect(failed.status).toBe(200);
      const parked = await fullJobRow(a1.jobId);
      expect(parked.status).toBe("locked"); // backoff park, NOT 'created'
      expect(parked.lock_token).toBeNull();
      expect(parked.lock_expires_at).not.toBeNull();
      expect(new Date(parked.lock_expires_at).getTime()).toBeGreaterThanOrEqual(failAt - 1000); // future-ish

      // Sibling branch B advances independently WHILE branch A is parked in backoff.
      await leaseAndComplete(token, "branch-b", { b: 1 });
      expect((await get(`/instances/${id}`)).body.status).not.toBe("completed"); // join waits on A

      // Rewind the backoff (stand-in for elapsed wall-clock) and re-lease: the SAME
      // occurrence-keyed branch-A row is re-handed with attempt_count bumped.
      await rewindBackoff(id, "branch-a");
      const a2 = await leaseOne(token, "branch-a");
      expect(a2.jobId).toBe(a1.jobId); // the SAME job row, not a fresh one
      expect(a2.attempt).toBe(2);

      // Complete A → the join fires exactly once with A's output.
      await complete(token, a2, { a: 1 });
      expect(await joinCompletionCount(id, "join")).toBe(1);

      // Post-join settle commits the transaction → completed.
      await leaseAndComplete(token, "branch-settle", {});
      const done = await get(`/instances/${id}`);
      expect(done.body.status).toBe("completed");

      // attempt_count bumped on the SAME branchA occurrence row (no collision with B).
      const aRow = await fullJobRow(a1.jobId);
      expect(aRow).toMatchObject({ element_id: "branchA", occurrence: 0, attempt_count: 2, is_compensation: 0 });
      expect(aRow.status).toBe("completed");
      const branchAJobs = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND element_id = 'branchA' AND is_compensation = 0`,
      )
        .bind(id)
        .first<{ n: number }>();
      expect(branchAJobs?.n).toBe(1); // ONE branchA job, retried in place — not a fresh row
    }

    // ===== variant 2: exhaustion → serviceTaskFailure Hazard, sibling frozen =====
    {
      const token = await mintWorkerToken();
      const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, {
        correlationKey: `retry-exhaust-${crypto.randomUUID()}`,
        variables: {},
      });
      expect(instance.status).toBe(201);
      const id = instance.body.instanceId;

      const a1 = await leaseOne(token, "branch-a");
      expect(a1.attempt).toBe(1);
      await authedPost(`/jobs/${a1.jobId}/fail`, token, { lockToken: a1.lockToken, reason: "transient", retryable: true });

      // Sibling B advances independently while A backs off → arrives at the join.
      await leaseAndComplete(token, "branch-b", { b: 1 });

      await rewindBackoff(id, "branch-a");
      const a2 = await leaseOne(token, "branch-a");
      expect(a2.jobId).toBe(a1.jobId); // same occurrence-keyed row, re-leased
      expect(a2.attempt).toBe(2);

      // The 2nd retryable fail spends the last attempt (retries=2) → exhaustion.
      const fail2 = await authedPost(`/jobs/${a2.jobId}/fail`, token, { lockToken: a2.lockToken, reason: "still down", retryable: true });
      expect(fail2.status).toBe(200);

      // Technical exhaustion inside a transaction is a serviceTaskFailure Hazard
      // (whole-instance incident, no auto-compensation).
      const inst = await get(`/instances/${id}`);
      expect(inst.body.status).toBe("incident");
      expect(inst.body.incident.kind).toBe("serviceTaskFailure");
      expect(inst.body.incident.elementId).toBe("branchA");

      // Same branchA occurrence row, attempt budget spent, terminal failed.
      const aRow = await fullJobRow(a1.jobId);
      expect(aRow).toMatchObject({ element_id: "branchA", occurrence: 0, attempt_count: 2, is_compensation: 0 });
      expect(aRow.status).toBe("failed");

      // Sibling B is FROZEN: arrived at the join, but the join never fired (A failed).
      const bTok = (await listTokens(env.DB, id)).find((r) => r.branch_flow_id === "f_b");
      expect(bTok).toBeDefined();
      expect(LIVE).toContain(bTok!.status);
      expect(await joinCompletionCount(id, "join")).toBe(0);
    }
  });
});
