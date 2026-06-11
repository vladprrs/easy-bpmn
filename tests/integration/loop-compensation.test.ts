import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  SAGA_LOOP_BPMN,
  authedPost,
  get,
  leaseAndComplete,
  leaseOne,
  mintWorkerToken,
  post,
  publishAndStart,
  rewindBackoff,
} from "../helpers";
import { resumeInline } from "../../src/runtime/engine";

// TASK-36 — compensation across loop iterations (design M2 §8; saga design
// §4.4/§4.5), DIRECT mode, AUTO-compensation path. Each completed pass of a
// compensatable step is its own occurrence-keyed ledger row, so the existing
// reverse pass (ORDER BY seq DESC) compensates every iteration separately with
// ZERO algorithm change. These tests prove and harden that property over
// SAGA_LOOP_BPMN (reserveItem ⟲ via GW_more/f_more; releaseItem compensator;
// finalize with a FINALIZE_FAILED error boundary → Tx_cancel cancel end):
//
//   1. business error after N iterations → N compensation jobs in REVERSE seq
//      order, each seeded with ITS OWN iteration's originalInput +
//      capturedOutput (the /jobs/activate ledger enrichment, per occurrence);
//   2. a duplicate /jobs/complete within one iteration is a LEDGER no-op (the
//      INSERT OR IGNORE dedup contract held per occurrence, engine path);
//   3. a compensator exhausting retries mid-pass stops the reverse pass at
//      THAT iteration (the already-compensated suffix stays compensated);
//      operator /retry resumes from exactly the failed iteration;
//   4. a crash mid-compensation re-attaches to the occurrence's EXISTING
//      compensation job on recovery (the M1 'compensating' re-attach rule,
//      held per occurrence — never a second comp job).

/** The instance's saga ledger in completion (seq) order. */
async function ledgerRows(instanceId: string) {
  const res = await env.DB.prepare(
    `SELECT element_id, seq, occurrence, compensation_status, compensation_job_id, captured_input, captured_output
       FROM saga_steps WHERE instance_id = ? ORDER BY seq`,
  )
    .bind(instanceId)
    .all<{
      element_id: string;
      seq: number;
      occurrence: number;
      compensation_status: string;
      compensation_job_id: string | null;
      captured_input: string;
      captured_output: string | null;
    }>();
  return res.results ?? [];
}

/** All compensation-lane job rows, by occurrence. */
async function compJobRows(instanceId: string) {
  const res = await env.DB.prepare(
    `SELECT job_id, occurrence, status, attempt_count, idempotency_key
       FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 1 ORDER BY occurrence`,
  )
    .bind(instanceId)
    .all<{ job_id: string; occurrence: number; status: string; attempt_count: number; idempotency_key: string }>();
  return res.results ?? [];
}

async function compensationStartedOccurrences(instanceId: string): Promise<number[]> {
  const history = await get(`/instances/${instanceId}/history`);
  return history.body.events
    .filter((e: any) => e.type === "compensationStarted")
    .map((e: any) => e.diagnostics.occurrence as number);
}

/**
 * Drive N completed reserveItem iterations (occurrence k completes with
 * itemId `i-k`; `more` drives f_more for all but the last), then business-fail
 * finalize (FINALIZE_FAILED → error boundary → Tx_cancel cancel end → AUTO
 * reverse pass). Returns the instance id.
 */
async function runLoopSagaToAutoCancel(token: string, iterations: number): Promise<string> {
  const { instance } = await publishAndStart(SAGA_LOOP_BPMN, {
    correlationKey: `loop-comp-${crypto.randomUUID()}`,
    variables: { sku: "tee" },
  });
  expect(instance.status).toBe(201);
  const id = instance.body.instanceId as string;

  for (let k = 0; k < iterations; k++) {
    const job = await leaseAndComplete(token, "reserve-item", { itemId: `i-${k}`, more: k < iterations - 1 });
    expect(job.instanceId).toBe(id);
  }

  // Parked at finalize (default flow f_done after the last iteration).
  expect((await get(`/instances/${id}`)).body.currentElementId).toBe("finalize");
  const fin = await leaseOne(token, "finalize-order");
  expect(fin.elementId).toBe("finalize");
  const failed = await authedPost(`/jobs/${fin.jobId}/fail`, token, {
    lockToken: fin.lockToken,
    reason: "no warehouse capacity",
    errorCode: "FINALIZE_FAILED",
    retryable: false,
  });
  expect(failed.status).toBe(200);
  return id;
}

describe("loop + cancel end — the reverse pass compensates every iteration (AC1, AC2)", () => {
  it(
    "3 iterations + business-failed finalize → 3 comp jobs in reverse seq order, each seeded with its own iteration's originalInput + capturedOutput; a duplicate complete stays a ledger no-op",
    { timeout: 30_000 },
    async () => {
      const token = await mintWorkerToken();
      const { instance } = await publishAndStart(SAGA_LOOP_BPMN, {
        correlationKey: `loop-comp-${crypto.randomUUID()}`,
        variables: { sku: "tee" },
      });
      const id = instance.body.instanceId as string;

      // Iterations 0..2; capture iteration 1's lease for the duplicate below.
      await leaseAndComplete(token, "reserve-item", { itemId: "i-0", more: true });
      const it1 = await leaseAndComplete(token, "reserve-item", { itemId: "i-1", more: true });

      // AC2 (engine path): a duplicate /jobs/complete of iteration 1 — same
      // jobId + lockToken, hostile different output — returns the stable prior
      // outcome and leaves the LEDGER untouched: still 2 rows, iteration 1's
      // captured_output NOT rewritten (INSERT OR IGNORE per occurrence; the
      // duplicate callback never reaches a second ledger write).
      const before = await ledgerRows(id);
      expect(before).toHaveLength(2);
      const dup = await authedPost(`/jobs/${it1.jobId}/complete`, token, {
        lockToken: it1.lockToken,
        outputVariables: { itemId: "DUP", more: false },
      });
      expect(dup.status).toBe(200);
      expect(dup.body.outcome).toBe("completed"); // stable prior outcome
      expect(await ledgerRows(id)).toEqual(before);

      await leaseAndComplete(token, "reserve-item", { itemId: "i-2", more: false });

      // Business-fail finalize → error boundary → Tx_cancel → AUTO reverse pass.
      const fin = await leaseOne(token, "finalize-order");
      const failed = await authedPost(`/jobs/${fin.jobId}/fail`, token, {
        lockToken: fin.lockToken,
        reason: "no warehouse capacity",
        errorCode: "FINALIZE_FAILED",
        retryable: false,
      });
      expect(failed.status).toBe(200);

      // The pass is sequential-in-reverse: highest occurrence first, ONE comp
      // job in flight at a time; the instance parks 'compensating'.
      const mid = await get(`/instances/${id}`);
      expect(mid.body.status).toBe("compensating");
      expect(mid.body.saga.phase).toBe("compensating");
      expect(await compJobRows(id)).toHaveLength(1);

      // Each comp job is seeded (at /jobs/activate, from the ledger row keyed
      // by element + occurrence) with ITS OWN iteration's captured state — the
      // heart of AC1. Iteration k's originalInput is the instance variables at
      // that iteration's dispatch (so it embeds iteration k-1's output).
      const expectations = [
        { occ: 2, originalInput: { sku: "tee", itemId: "i-1", more: true }, capturedOutput: { itemId: "i-2", more: false } },
        { occ: 1, originalInput: { sku: "tee", itemId: "i-0", more: true }, capturedOutput: { itemId: "i-1", more: true } },
        { occ: 0, originalInput: { sku: "tee" }, capturedOutput: { itemId: "i-0", more: true } },
      ];
      for (const exp of expectations) {
        const comp = await leaseOne(token, "release-item");
        expect(comp.isCompensation).toBe(true);
        expect(comp.elementId).toBe("reserveItem");
        expect(comp.originalInput).toEqual(exp.originalInput);
        expect(comp.capturedOutput).toEqual(exp.capturedOutput);
        const row = await env.DB.prepare(`SELECT occurrence, idempotency_key FROM service_task_jobs WHERE job_id = ?`)
          .bind(comp.jobId)
          .first<{ occurrence: number; idempotency_key: string }>();
        expect(row?.occurrence).toBe(exp.occ);
        // key shape: instance:element:isCompensation:occurrence — the `1` is the compensation lane.
        expect(row?.idempotency_key).toBe(`${id}:reserveItem:1:${exp.occ}`);
        expect(
          (
            await authedPost(`/jobs/${comp.jobId}/complete`, token, {
              lockToken: comp.lockToken,
              outputVariables: { released: `i-${exp.occ}` },
            })
          ).status,
        ).toBe(200);
      }

      // Reverse seq order on the audit surface too.
      expect(await compensationStartedOccurrences(id)).toEqual([2, 1, 0]);

      // Settled: saga-failed terminal via the cancel boundary; every iteration
      // compensated; N comp jobs total (one per iteration, none doubled).
      const done = await get(`/instances/${id}`);
      expect(done.body.status).toBe("compensated");
      expect(done.body.currentElementId).toBe("Failed");
      expect((await ledgerRows(id)).map((r) => [r.occurrence, r.compensation_status])).toEqual([
        [0, "compensated"],
        [1, "compensated"],
        [2, "compensated"],
      ]);
      expect(await compJobRows(id)).toHaveLength(3);

      // The AUTO path (business error → cancel end) never raises an incident —
      // compensation here is the modeled outcome, not a Hazard.
      const incidents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE instance_id = ?`)
        .bind(id)
        .first<{ n: number }>();
      expect(incidents?.n).toBe(0);
    },
  );
});

describe("compensationFailed mid-reverse-pass stops at the failed iteration (AC3)", () => {
  it(
    "occurrence 2 compensates, occurrence 1 exhausts its retries → compensationFailed; /retry resumes from EXACTLY iteration 1 (same comp job), iteration 0 untouched until then",
    { timeout: 30_000 },
    async () => {
      const token = await mintWorkerToken();
      const id = await runLoopSagaToAutoCancel(token, 3);

      // Reverse pass: occurrence 2's compensator succeeds.
      const c2 = await leaseAndComplete(token, "release-item", { released: "i-2" });
      expect(c2.capturedOutput).toEqual({ itemId: "i-2", more: false });
      const settledC2 = (await compJobRows(id)).find((j) => j.occurrence === 2)!;
      expect(settledC2.status).toBe("completed");

      // Occurrence 1's compensator fails TECHNICALLY to exhaustion: comp jobs
      // share the forward retry semantics (releaseItem retries=5 → retry_limit
      // 5 lease attempts; each retryable fail parks behind backoff and
      // re-leases the SAME job; the final fail is terminal-for-the-step).
      let compJobId: string | null = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        const c1 = await leaseOne(token, "release-item");
        compJobId = compJobId ?? c1.jobId;
        expect(c1.jobId).toBe(compJobId); // the SAME iteration-1 comp job, re-leased
        expect(c1.attempt).toBe(attempt);
        expect(c1.capturedOutput).toEqual({ itemId: "i-1", more: true });
        const failed = await authedPost(`/jobs/${c1.jobId}/fail`, token, {
          lockToken: c1.lockToken,
          reason: "release API down",
          retryable: true,
        });
        expect(failed.status).toBe(200);
        if (attempt < 5) await rewindBackoff(id, "release-item");
      }

      // The reverse pass STOPPED at iteration 1: suffix (occ 2) stays
      // compensated, occ 1 is failed, occ 0 was never started (pending, no
      // comp job row).
      const stopped = await get(`/instances/${id}`);
      expect(stopped.body.status).toBe("compensationFailed");
      expect(stopped.body.incident.kind).toBe("compensationFailure");
      expect(stopped.body.incident.elementId).toBe("reserveItem");
      expect(stopped.body.incident.resolution).toBe("open");
      expect((await ledgerRows(id)).map((r) => [r.occurrence, r.compensation_status])).toEqual([
        [0, "pending"],
        [1, "failed"],
        [2, "compensated"],
      ]);
      expect((await compJobRows(id)).map((j) => [j.occurrence, j.status])).toEqual([
        [1, "failed"],
        [2, "completed"],
      ]);

      // Operator /retry resumes from EXACTLY the failed iteration: the SAME
      // comp job row is reset (no second job), iteration 2 stays settled.
      const retry = await post(`/instances/${id}/retry`, {});
      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe("compensating");
      const afterRetry = await compJobRows(id);
      expect(afterRetry).toHaveLength(2); // still occ 1 + occ 2 — nothing new
      expect(afterRetry.find((j) => j.occurrence === 1)).toMatchObject({ job_id: compJobId, status: "created", attempt_count: 0 });
      expect(afterRetry.find((j) => j.occurrence === 2)).toMatchObject({
        job_id: settledC2.job_id,
        status: "completed",
        attempt_count: settledC2.attempt_count, // the compensated suffix is untouched
      });

      // Iteration 1's comp job re-runs (fresh attempt budget) and succeeds...
      const c1retry = await leaseOne(token, "release-item");
      expect(c1retry.jobId).toBe(compJobId);
      expect(c1retry.attempt).toBe(1);
      expect(c1retry.capturedOutput).toEqual({ itemId: "i-1", more: true });
      expect(
        (await authedPost(`/jobs/${c1retry.jobId}/complete`, token, { lockToken: c1retry.lockToken, outputVariables: { released: "i-1" } }))
          .status,
      ).toBe(200);

      // ...then the pass continues to iteration 0 (its comp job only exists now).
      const c0 = await leaseOne(token, "release-item");
      expect(c0.jobId).not.toBe(compJobId);
      expect(c0.capturedOutput).toEqual({ itemId: "i-0", more: true });
      expect(
        (await authedPost(`/jobs/${c0.jobId}/complete`, token, { lockToken: c0.lockToken, outputVariables: { released: "i-0" } })).status,
      ).toBe(200);

      const done = await get(`/instances/${id}`);
      expect(done.body.status).toBe("compensated");
      expect((await ledgerRows(id)).every((r) => r.compensation_status === "compensated")).toBe(true);
      expect(await compensationStartedOccurrences(id)).toEqual([2, 1, 0]); // started once each, reverse order

      // Resolution lifecycle interplay (TASK-36 carry): the /retry path marks
      // the incident 'operatorResolved', which is STICKY — the settle's
      // compensating→compensated advance is guarded on the exact prior value
      // and must not clobber it.
      const incident = await env.DB.prepare(`SELECT resolution FROM incidents WHERE instance_id = ?`)
        .bind(id)
        .first<{ resolution: string }>();
      expect(incident?.resolution).toBe("operatorResolved");
    },
  );
});

describe("crash mid-compensation re-attaches per occurrence (AC4)", () => {
  it(
    "recovery re-drives attach to the occurrence's EXISTING compensation job — never a second comp job, no duplicate audit",
    { timeout: 30_000 },
    async () => {
    const token = await mintWorkerToken();
    const id = await runLoopSagaToAutoCancel(token, 2);

    // The reverse pass parked 'compensating' with iteration 1's comp job
    // created and the ledger row attached to it.
    const initial = await compJobRows(id);
    expect(initial).toHaveLength(1);
    const j1 = initial[0]!;
    expect(j1.occurrence).toBe(1);
    const step1 = (await ledgerRows(id)).find((r) => r.occurrence === 1)!;
    expect(step1.compensation_status).toBe("compensating");
    expect(step1.compensation_job_id).toBe(j1.job_id);

    // Crash/recovery while the comp job is still UNLEASED: re-driving the
    // engine (direct-mode resume == crash recovery, same path) re-derives the
    // reverse cursor from the ledger and RE-ATTACHES — same single job row,
    // same binding, one compensationStarted event.
    await resumeInline(env, id);
    await resumeInline(env, id);
    let after = await compJobRows(id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ job_id: j1.job_id, occurrence: 1, status: "created" });
    expect((await ledgerRows(id)).find((r) => r.occurrence === 1)?.compensation_job_id).toBe(j1.job_id);
    expect(await compensationStartedOccurrences(id)).toEqual([1]);

    // Crash/recovery while the comp job is LEASED (a worker holds the lock):
    // recovery must not clone or reset the in-flight job either.
    const leased = await leaseOne(token, "release-item");
    expect(leased.jobId).toBe(j1.job_id);
    await resumeInline(env, id);
    after = await compJobRows(id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ job_id: j1.job_id, status: "locked", attempt_count: 1 });

    // The worker completes iteration 1 → the pass moves to iteration 0; the
    // re-attach rule holds for THAT occurrence too.
    expect(
      (await authedPost(`/jobs/${leased.jobId}/complete`, token, { lockToken: leased.lockToken, outputVariables: { released: "i-1" } }))
        .status,
    ).toBe(200);
    const atZero = await compJobRows(id);
    expect(atZero.map((j) => j.occurrence)).toEqual([0, 1]);
    const j0 = atZero.find((j) => j.occurrence === 0)!;
    await resumeInline(env, id);
    await resumeInline(env, id);
    const stillTwo = await compJobRows(id);
    expect(stillTwo).toHaveLength(2);
    expect(stillTwo.find((j) => j.occurrence === 0)?.job_id).toBe(j0.job_id);
    expect(await compensationStartedOccurrences(id)).toEqual([1, 0]);

    // Settle.
    const c0 = await leaseOne(token, "release-item");
    expect(c0.jobId).toBe(j0.job_id);
    expect(
      (await authedPost(`/jobs/${c0.jobId}/complete`, token, { lockToken: c0.lockToken, outputVariables: { released: "i-0" } })).status,
    ).toBe(200);
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    expect(done.body.currentElementId).toBe("Failed");
    expect(await compJobRows(id)).toHaveLength(2); // exactly one comp job per iteration, ever
    },
  );
});
