import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedPost, get, mintWorkerToken, post, publishAndStart } from "../helpers";
import { MI_SUB_COMP_TX_BPMN, MI_SUB_MULTI_TX_BPMN } from "./multi-instance-fixtures";

// M5-L3 (Task 11) — per-iteration compensation over a SUBPROCESS MI, DIRECT mode.
// This suite PROVES the "zero-algorithm-change" claim of the design (§3/§5): the
// shipped M5-L1 reverse cursor (`selectSubtreeStepsForCompensation` seq DESC),
// straggler scan (`ledgerStragglers`), and live-token quiescence barrier see MI
// iteration ledger rows / iteration tokens with no new compensation code — the
// miBody `scope_id` makes every interior step a member of the enclosing tx subtree,
// and Task 7's strided interior occurrences give each iteration a distinct row.
//
// The GENUINELY NEW coverage is [MI-COMP-STRAGGLER-01]: an operator /cancel fires
// while one iteration's interior job is STILL IN FLIGHT. The two-phase cancel
// abandons that job, the completed iterations compensate, and the barrier RELEASES
// (the instance reaches `compensated`, never wedges) — the §3.1.2 gate over MI.
//
// Every test mints its OWN taskType(s) (D1 job state is file-visible; a shared type
// would cross-lease leftovers — the loop-rewalk precedent).

const uid = () => crypto.randomUUID().slice(0, 8);

interface LeasedJob {
  jobId: string;
  instanceId: string;
  elementId: string;
  lockToken: string;
  isCompensation?: boolean;
  variables: Record<string, unknown>;
}

async function leaseUpTo(token: string, taskType: string, maxJobs: number): Promise<LeasedJob[]> {
  const r = await authedPost("/jobs/activate", token, { taskType, workerId: "mi-comp-worker", maxJobs });
  expect(r.status).toBe(200);
  return r.body.jobs as LeasedJob[];
}

async function completeJob(token: string, job: LeasedJob, output: Record<string, unknown> = {}): Promise<void> {
  const done = await authedPost(`/jobs/${job.jobId}/complete`, token, { lockToken: job.lockToken, outputVariables: output });
  expect(done.status).toBe(200);
}

async function jobRows(instanceId: string) {
  return (
    await env.DB.prepare(
      `SELECT element_id, status, occurrence, iteration_index, is_compensation
         FROM service_task_jobs WHERE instance_id = ? ORDER BY is_compensation, element_id, occurrence, iteration_index`,
    )
      .bind(instanceId)
      .all()
  ).results as { element_id: string; status: string; occurrence: number; iteration_index: number; is_compensation: number }[];
}

async function compensationJobCount(instanceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 1`)
    .bind(instanceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function miTokens(instanceId: string) {
  return (
    await env.DB.prepare(
      `SELECT branch_flow_id, status, position_element_id FROM execution_tokens WHERE instance_id = ? AND branch_flow_id LIKE 'mi#%' ORDER BY branch_flow_id`,
    )
      .bind(instanceId)
      .all()
  ).results as { branch_flow_id: string; status: string; position_element_id: string }[];
}

async function ledgerRows(instanceId: string) {
  return (
    await env.DB.prepare(
      `SELECT element_id, seq, occurrence, iteration_index, scope_id, compensation_status
         FROM saga_steps WHERE instance_id = ? ORDER BY seq`,
    )
      .bind(instanceId)
      .all()
  ).results as {
    element_id: string;
    seq: number;
    occurrence: number;
    iteration_index: number;
    scope_id: string;
    compensation_status: string;
  }[];
}

async function historyDiag(instanceId: string, type: string): Promise<any[]> {
  const h = await get(`/instances/${instanceId}/history`);
  return h.body.events.filter((e: any) => e.type === type);
}

describe("M5-L3 per-iteration compensation over a subProcess MI (direct mode)", () => {
  it("[MI-COMP-REVERSE-01] all 3 iterations complete → tx cancel → THREE refund jobs in reverse occurrence order; parent compensated", async () => {
    const chargeType = `mi-rev-charge-${uid()}`;
    const refundType = `mi-rev-refund-${uid()}`;
    const finalizeType = `mi-rev-final-${uid()}`;
    const { instance } = await publishAndStart(MI_SUB_COMP_TX_BPMN(chargeType, refundType, finalizeType), {
      correlationKey: `mi-rev-${uid()}`,
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting"); // parked on the MI activity

    const token = await mintWorkerToken();
    // Three interior `charge` iteration jobs (one per iteration).
    const charges = await leaseUpTo(token, chargeType, 10);
    expect(charges).toHaveLength(3);
    const byCounter = new Map(charges.map((j) => [j.variables.loopCounter as number, j]));
    expect([...byCounter.keys()].sort()).toEqual([0, 1, 2]);

    // Complete in loopCounter order so the ledger seq is deterministic (iter 0 →
    // lowest seq, iter 2 → highest).
    for (const i of [0, 1, 2]) await completeJob(token, byCounter.get(i)!, { charged: i });

    // The MI aggregated all 3 → advanced to `finalize` inside the transaction.
    const mid = await get(`/instances/${id}`);
    expect(mid.body.status).toBe("waiting");
    expect(mid.body.currentElementId).toBe("finalize");

    // THREE pending ledger rows — one `charge` per iteration, occurrence-distinct
    // (Task 7's strided first-lap occurrences 0/1/2), scope = the miBody `mi1`,
    // iteration_index 0 (the strided occurrence carries iteration identity, NOT the
    // iteration column).
    const preCancel = await ledgerRows(id);
    expect(preCancel.map((r) => [r.element_id, r.occurrence, r.compensation_status])).toEqual([
      ["charge", 0, "pending"],
      ["charge", 1, "pending"],
      ["charge", 2, "pending"],
    ]);
    expect(preCancel.every((r) => r.scope_id === "mi1" && r.iteration_index === 0)).toBe(true);

    // Business-fail `finalize` → error boundary → transaction cancel end → AUTO reverse pass.
    const fin = (await leaseUpTo(token, finalizeType, 5))[0]!;
    expect(fin.elementId).toBe("finalize");
    const failed = await authedPost(`/jobs/${fin.jobId}/fail`, token, {
      lockToken: fin.lockToken,
      reason: "no capacity",
      errorCode: "FINALIZE_FAILED",
      retryable: false,
    });
    expect(failed.status).toBe(200);
    expect((await get(`/instances/${id}`)).body.status).toBe("compensating");

    // Reverse pass compensates the 3 iterations in reverse occurrence order (2 → 1 →
    // 0), ONE `refund` comp job in flight at a time (direct mode parks between).
    for (let round = 0; round < 3; round++) {
      const c = (await leaseUpTo(token, refundType, 5))[0]!;
      expect(c.isCompensation).toBe(true);
      expect(c.elementId).toBe("charge");
      await completeJob(token, c, {});
    }

    // Settled: saga-compensated via the cancel boundary.
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    expect(done.body.currentElementId).toBe("Failed");

    // EXACTLY 3 compensation jobs — one per finished iteration.
    expect(await compensationJobCount(id)).toBe(3);
    const finalLedger = await ledgerRows(id);
    expect(finalLedger.map((r) => [r.occurrence, r.compensation_status])).toEqual([
      [0, "compensated"],
      [1, "compensated"],
      [2, "compensated"],
    ]);
    // Reverse occurrence order on the audit surface (occ 2, then 1, then 0).
    const started = (await historyDiag(id, "compensationStarted")).map((e: any) => e.diagnostics.occurrence);
    expect(started).toEqual([2, 1, 0]);
  });

  it("[MI-COMP-STRAGGLER-01] operator /cancel while iteration 2's interior job is in flight → two-phase cancel; completed iterations compensate, barrier releases", async () => {
    const chargeType = `mi-str-charge-${uid()}`;
    const refundType = `mi-str-refund-${uid()}`;
    const finalizeType = `mi-str-final-${uid()}`;
    const { instance } = await publishAndStart(MI_SUB_COMP_TX_BPMN(chargeType, refundType, finalizeType), {
      correlationKey: `mi-str-${uid()}`,
      variables: {},
    });
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    const token = await mintWorkerToken();
    // Lease all three interior `charge` jobs; complete ONLY iterations 0 and 1.
    // Iteration 2's job stays LEASED-but-uncompleted (in flight) — the straggler.
    const charges = await leaseUpTo(token, chargeType, 10);
    expect(charges).toHaveLength(3);
    const byCounter = new Map(charges.map((j) => [j.variables.loopCounter as number, j]));
    await completeJob(token, byCounter.get(0)!, { charged: 0 });
    await completeJob(token, byCounter.get(1)!, { charged: 1 });

    // Still parked on the MI activity (iteration 2 not finished → not settled). The
    // inspection API folds `currentElementId` to null while iteration tokens are
    // live, so assert the authoritative DB cursor (`current_element_id = mi1`).
    const mid = await get(`/instances/${id}`);
    expect(mid.body.status).toBe("waiting");
    const cursor = await env.DB.prepare(`SELECT current_element_id FROM process_instances WHERE instance_id = ?`).bind(id).first<{ current_element_id: string }>();
    expect(cursor!.current_element_id).toBe("mi1");

    // Only the 2 finished iterations left pending ledger rows; iteration 2 (in
    // flight) has committed nothing → NO row for it.
    const preCancel = await ledgerRows(id);
    expect(preCancel.map((r) => [r.element_id, r.occurrence, r.compensation_status])).toEqual([
      ["charge", 0, "pending"],
      ["charge", 1, "pending"],
    ]);
    // mi#2 iteration token is still live, positioned on the interior `charge`.
    const tokAtCancel = await miTokens(id);
    expect(tokAtCancel.find((t) => t.branch_flow_id === "mi#0")!.status).toBe("consumed");
    expect(tokAtCancel.find((t) => t.branch_flow_id === "mi#1")!.status).toBe("consumed");
    const live2 = tokAtCancel.find((t) => t.branch_flow_id === "mi#2")!;
    expect(["active", "waiting"]).toContain(live2.status);
    expect(live2.position_element_id).toBe("charge");

    // OPERATOR /cancel — the two-phase process-root cancel. Phase 1 abandons the
    // in-flight interior `charge` job; the reverse pass then discards the orphaned
    // mi#2 token (its job is now failed) so the barrier is NOT wedged by it.
    const cancelled = await post(`/instances/${id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("compensating");

    // Reverse pass compensates EXACTLY the 2 finished iterations, reverse occurrence
    // order (1 → 0). Iteration 2 is NEVER compensated (it committed nothing).
    for (let round = 0; round < 2; round++) {
      const c = (await leaseUpTo(token, refundType, 5))[0]!;
      expect(c.isCompensation).toBe(true);
      expect(c.elementId).toBe("charge");
      await completeJob(token, c, {});
    }

    // THE CRUX: the barrier RELEASED — the instance reached a terminal `compensated`,
    // it did not wedge at `compensating`/`waiting` behind the in-flight iteration. An
    // operator /cancel is a PROCESS-ROOT compensation (not the tx's own cancel-end),
    // so it settles at the process id, NOT the tx cancel-boundary's `Failed` target.
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    expect(done.body.currentElementId).toBe("P_mi_sub_comp");

    // Iteration 2's interior job was abandoned (failed), not compensated.
    const jobs = await jobRows(id);
    const iter2Charge = jobs.find((j) => j.element_id === "charge" && j.occurrence === 2 && j.is_compensation === 0)!;
    expect(iter2Charge.status).toBe("failed");
    // mi#2 was discarded by the straggler scan (never consumed, never re-driven).
    expect((await miTokens(id)).find((t) => t.branch_flow_id === "mi#2")!.status).toBe("discarded");

    // EXACTLY 2 compensation jobs — the in-flight iteration ledgered nothing.
    expect(await compensationJobCount(id)).toBe(2);
    const finalLedger = await ledgerRows(id);
    expect(finalLedger.map((r) => [r.element_id, r.occurrence, r.compensation_status])).toEqual([
      ["charge", 0, "compensated"],
      ["charge", 1, "compensated"],
    ]);
    // Never a ledger row for the abandoned iteration 2.
    expect(finalLedger.some((r) => r.occurrence === 2)).toBe(false);
    const started = (await historyDiag(id, "compensationStarted")).map((e: any) => e.diagnostics.occurrence);
    expect(started).toEqual([1, 0]);
  });

  it("[MI-COMP-SUBPROC-01] a subProcess MI with TWO compensable interior steps per iteration compensates every row in strict reverse seq", async () => {
    const chargeType = `mi-sp-charge-${uid()}`;
    const refundType = `mi-sp-refund-${uid()}`;
    const shipType = `mi-sp-ship-${uid()}`;
    const unshipType = `mi-sp-unship-${uid()}`;
    const finalizeType = `mi-sp-final-${uid()}`;
    const { instance } = await publishAndStart(MI_SUB_MULTI_TX_BPMN(chargeType, refundType, shipType, unshipType, finalizeType), {
      correlationKey: `mi-sp-${uid()}`,
      variables: {},
    });
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    const token = await mintWorkerToken();
    // Cardinality 2: fan-out creates both `charge` jobs. Complete them (charge#0,
    // then charge#1) — each completion re-drives its iteration to create its `ship`.
    const charges = await leaseUpTo(token, chargeType, 10);
    expect(charges).toHaveLength(2);
    const chargeByCounter = new Map(charges.map((j) => [j.variables.loopCounter as number, j]));
    await completeJob(token, chargeByCounter.get(0)!, {});
    await completeJob(token, chargeByCounter.get(1)!, {});

    // Now both `ship` jobs exist; complete ship#0 then ship#1 → both iterations reach
    // the inner none-end. Deterministic ledger seq: charge0, charge1, ship0, ship1.
    const ships = await leaseUpTo(token, shipType, 10);
    expect(ships).toHaveLength(2);
    const shipByCounter = new Map(ships.map((j) => [j.variables.loopCounter as number, j]));
    await completeJob(token, shipByCounter.get(0)!, {});
    await completeJob(token, shipByCounter.get(1)!, {});

    // The MI aggregated both iterations → advanced to `finalize`.
    const mid = await get(`/instances/${id}`);
    expect(mid.body.status).toBe("waiting");
    expect(mid.body.currentElementId).toBe("finalize");

    // FOUR pending rows, element+occurrence distinct, seq in completion order.
    const preCancel = await ledgerRows(id);
    expect(preCancel.map((r) => [r.element_id, r.occurrence])).toEqual([
      ["charge", 0],
      ["charge", 1],
      ["ship", 0],
      ["ship", 1],
    ]);
    expect(preCancel.every((r) => r.scope_id === "mi1" && r.compensation_status === "pending")).toBe(true);

    // Business-fail `finalize` → cancel end → reverse pass.
    const fin = (await leaseUpTo(token, finalizeType, 5))[0]!;
    const failed = await authedPost(`/jobs/${fin.jobId}/fail`, token, {
      lockToken: fin.lockToken,
      reason: "nope",
      errorCode: "FINALIZE_FAILED",
      retryable: false,
    });
    expect(failed.status).toBe(200);
    expect((await get(`/instances/${id}`)).body.status).toBe("compensating");

    // Drain the comp jobs — the reverse pass runs strict `seq DESC`, so the order is
    // ship#1, ship#0 (unship), then charge#1, charge#0 (refund). Drain whichever
    // comp type has the single live job each round.
    for (let round = 0; round < 4; round++) {
      const unship = await leaseUpTo(token, unshipType, 5);
      const refund = unship.length === 0 ? await leaseUpTo(token, refundType, 5) : [];
      const c = (unship[0] ?? refund[0])!;
      expect(c.isCompensation).toBe(true);
      await completeJob(token, c, {});
    }

    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    expect(done.body.currentElementId).toBe("Failed");

    // All 4 rows compensated; 4 comp jobs.
    expect(await compensationJobCount(id)).toBe(4);
    expect((await ledgerRows(id)).every((r) => r.compensation_status === "compensated")).toBe(true);

    // Strict reverse-seq audit order: ship occ1, ship occ0, charge occ1, charge occ0.
    const started = (await historyDiag(id, "compensationStarted")).map((e: any) => [e.elementId, e.diagnostics.occurrence]);
    expect(started).toEqual([
      ["ship", 1],
      ["ship", 0],
      ["charge", 1],
      ["charge", 0],
    ]);
  });
});
