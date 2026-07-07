import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedPost, get, mintWorkerToken, publishAndStart } from "../helpers";
import { resumeInline } from "../../src/runtime/engine";
import { MI_PAR_SUB_BPMN, MI_SEQ_SUB_BPMN } from "./multi-instance-fixtures";

// M5-L3 (Task 7) — MI over a SUBPROCESS body, DIRECT mode: per-iteration `mi#`
// execution tokens, the driver body sub-walk (inner-start / end-event
// intercepts, interior leaves driven via the engine's driveLeaf), overlay
// isolation (interior writes land in the iteration overlay, NEVER root vars
// until miCompleted), aggregation from the consumed tokens' final overlays, and
// ITERATION-STRIDED interior occurrences (occ = k*N + i): iteration identity
// lives in the occurrence residue class, so two iterations visiting the same
// interior gateway record occurrence-distinct gateway_decisions rows regardless
// of completion order. Every test mints its OWN taskType(s).

const uid = () => crypto.randomUUID().slice(0, 8);

interface LeasedJob {
  jobId: string;
  instanceId: string;
  elementId: string;
  lockToken: string;
  variables: Record<string, unknown>;
}

async function leaseUpTo(token: string, taskType: string, maxJobs: number): Promise<LeasedJob[]> {
  const r = await authedPost("/jobs/activate", token, { taskType, workerId: "mi-sub-worker", maxJobs });
  expect(r.status).toBe(200);
  return r.body.jobs as LeasedJob[];
}

async function completeJob(token: string, job: LeasedJob, output: Record<string, unknown>): Promise<void> {
  const done = await authedPost(`/jobs/${job.jobId}/complete`, token, {
    lockToken: job.lockToken,
    outputVariables: output,
  });
  expect(done.status).toBe(200);
}

async function historyCounts(instanceId: string): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT type, COUNT(*) AS n FROM history_events WHERE instance_id = ? GROUP BY type`,
  )
    .bind(instanceId)
    .all<{ type: string; n: number }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.type, r.n]));
}

async function miTokens(instanceId: string) {
  return (
    await env.DB.prepare(
      `SELECT token_id, branch_flow_id, position_element_id, status, variables_overlay, updated_at
         FROM execution_tokens WHERE instance_id = ? AND branch_flow_id LIKE 'mi#%' ORDER BY branch_flow_id`,
    )
      .bind(instanceId)
      .all()
  ).results as {
    token_id: string;
    branch_flow_id: string;
    position_element_id: string;
    status: string;
    variables_overlay: string;
    updated_at: string;
  }[];
}

async function gatewayDecisions(instanceId: string, elementId: string) {
  return (
    await env.DB.prepare(
      `SELECT element_id, occurrence, chosen_flow_id, is_default FROM gateway_decisions
        WHERE instance_id = ? AND element_id = ? ORDER BY occurrence`,
    )
      .bind(instanceId, elementId)
      .all()
  ).results as { element_id: string; occurrence: number; chosen_flow_id: string; is_default: number }[];
}

async function jobRows(instanceId: string) {
  return (
    await env.DB.prepare(
      `SELECT job_id, element_id, status, occurrence, iteration_index, output_applied
         FROM service_task_jobs WHERE instance_id = ? ORDER BY element_id, occurrence`,
    )
      .bind(instanceId)
      .all()
  ).results as {
    job_id: string;
    element_id: string;
    status: string;
    occurrence: number;
    iteration_index: number;
    output_applied: number;
  }[];
}

/** Full canonical-state snapshot for the cold re-drive write-freedom assertion. */
async function snapshot(instanceId: string) {
  const inst = await env.DB.prepare(
    `SELECT status, current_element_id, variables FROM process_instances WHERE instance_id = ?`,
  )
    .bind(instanceId)
    .first();
  const acts = (
    await env.DB.prepare(`SELECT * FROM mi_activations WHERE instance_id = ? ORDER BY element_id, occurrence`)
      .bind(instanceId)
      .all()
  ).results;
  return {
    inst,
    jobs: await jobRows(instanceId),
    acts,
    tokens: await miTokens(instanceId),
    decisions: await gatewayDecisions(instanceId, "gw"),
    history: await historyCounts(instanceId),
  };
}

describe("M5-L3 multi-instance over subProcess bodies (direct mode)", () => {
  it("[MI-PAR-SUB-01] parallel subProcess MI: concurrent iterations, occurrence-strided interior rows, overlay aggregation, token lifecycle", async () => {
    const reserveType = `mi-sub-reserve-${uid()}`;
    const extraType = `mi-sub-extra-${uid()}`;
    const { instance } = await publishAndStart(MI_PAR_SUB_BPMN(reserveType, extraType), {
      correlationKey: `mi-par-sub-${uid()}`,
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting"); // parked on the MI activity

    // TWO interior reserve jobs leasable CONCURRENTLY, one per iteration, with
    // the iteration context (loopCounter) visible through the mi# overlay chain.
    const token = await mintWorkerToken();
    const reserveJobs = await leaseUpTo(token, reserveType, 5);
    expect(reserveJobs).toHaveLength(2);
    expect(reserveJobs.every((j) => j.instanceId === id && j.elementId === "reserve")).toBe(true);
    const counters = reserveJobs.map((j) => j.variables.loopCounter as number).sort();
    expect(counters).toEqual([0, 1]);

    // Two LIVE mi# iteration tokens during flight, parked at the interior task.
    const inFlight = await miTokens(id);
    expect(inFlight.map((t) => t.branch_flow_id)).toEqual(["mi#0", "mi#1"]);
    expect(inFlight.every((t) => ["active", "waiting"].includes(t.status))).toBe(true);
    expect(inFlight.every((t) => t.position_element_id === "reserve")).toBe(true);

    // Iteration-strided occurrences (occ = k*N + i): iteration i's reserve job
    // sits at occurrence i, and iteration_index stays 0 for INTERIOR rows —
    // iteration identity lives in the strided occurrence.
    const jobsAfterLease = await jobRows(id);
    const byCounter = new Map(reserveJobs.map((j) => [j.variables.loopCounter as number, j]));
    for (const i of [0, 1]) {
      const row = jobsAfterLease.find((r) => r.job_id === byCounter.get(i)!.jobId)!;
      expect(row.occurrence).toBe(i);
      expect(row.iteration_index).toBe(0);
    }

    // Complete OUT OF ORDER — iteration 1 FIRST (the aliasing-order stress):
    // its gateway decision must land at ITS occurrence (1), and iteration 0's
    // later walk must not adopt it.
    await completeJob(token, byCounter.get(1)!, { order: "b" });

    // Iteration 1 took the conditional branch → an `extra` job exists for it,
    // reading iteration 1's overlay (order = "b"); iteration 0 is untouched.
    const extraJobs = await leaseUpTo(token, extraType, 5);
    expect(extraJobs).toHaveLength(1);
    expect(extraJobs[0]!.variables.order).toBe("b");
    expect(extraJobs[0]!.variables.loopCounter).toBe(1);

    // Root variables carry NO interior writes mid-flight (overlay isolation).
    const midFlight = await get(`/instances/${id}`);
    expect(midFlight.body.status).not.toBe("completed");
    expect(midFlight.body.variables.order).toBeUndefined();
    expect(midFlight.body.variables.results).toBeUndefined();

    await completeJob(token, byCounter.get(0)!, { order: "a" }); // default branch → iteration 0 completes
    await completeJob(token, extraJobs[0]!, { extraDone: true }); // iteration 1 completes

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    // Aggregation = each consumed token's FINAL overlay (the pinned iteration
    // context + interior writes), index-ordered.
    expect(inst.body.variables.results).toEqual([
      { loopCounter: 0, order: "a" },
      { loopCounter: 1, order: "b", extraDone: true },
    ]);

    // TWO occurrence-distinct gateway_decisions rows for the interior gateway:
    // iteration 0 at occ 0 (default), iteration 1 at occ 1 (conditional) —
    // deterministic under the strided scheme regardless of completion order.
    const decisions = await gatewayDecisions(id, "gw");
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({ occurrence: 0, chosen_flow_id: "bDef", is_default: 1 });
    expect(decisions[1]).toMatchObject({ occurrence: 1, chosen_flow_id: "bExtra", is_default: 0 });

    // Both iteration tokens are consumed after completion.
    const done = await miTokens(id);
    expect(done.map((t) => t.status)).toEqual(["consumed", "consumed"]);

    const history = await historyCounts(id);
    expect(history["miActivated"]).toBe(1);
    expect(history["miIterationCompleted"]).toBe(2);
    expect(history["miCompleted"]).toBe(1);
    expect(history["instanceStarted"]).toBe(1); // the inner none-start never re-audits instanceStarted
  });

  it("[MI-SEQ-SUB-01] sequential subProcess MI: one iteration at a time, root vars untouched mid-flight, per-iteration overlay aggregation", async () => {
    const taskType = `mi-sub-handle-${uid()}`;
    const { instance } = await publishAndStart(MI_SEQ_SUB_BPMN(taskType), {
      correlationKey: `mi-seq-sub-${uid()}`,
      variables: { orders: ["a", "b"] },
    });
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    const token = await mintWorkerToken();
    // Only iteration 0's interior job is leasable while it is live.
    const first = await leaseUpTo(token, taskType, 5);
    expect(first).toHaveLength(1);
    expect(first[0]!.variables.order).toBe("a");
    expect(first[0]!.variables.loopCounter).toBe(0);
    expect(await leaseUpTo(token, taskType, 5)).toHaveLength(0);

    // Exactly ONE live mi# token (iteration 0) mid-flight.
    const tokens0 = await miTokens(id);
    expect(tokens0).toHaveLength(1);
    expect(tokens0[0]!.branch_flow_id).toBe("mi#0");

    await completeJob(token, first[0]!, { handled: "a" });

    // Interior write landed in the ITERATION overlay, not root variables.
    const midFlight = await get(`/instances/${id}`);
    expect(midFlight.body.status).not.toBe("completed");
    expect(midFlight.body.variables).toEqual({ orders: ["a", "b"] });

    // Iteration 1 opens only after iteration 0 consumed; strided occurrence = 1.
    const second = await leaseUpTo(token, taskType, 5);
    expect(second).toHaveLength(1);
    expect(second[0]!.variables.order).toBe("b");
    expect(second[0]!.variables.loopCounter).toBe(1);
    const jobs = await jobRows(id);
    expect(jobs.map((j) => [j.element_id, j.occurrence, j.iteration_index])).toEqual([
      ["handle", 0, 0],
      ["handle", 1, 0],
    ]);
    const tokensMid = await miTokens(id);
    expect(tokensMid.find((t) => t.branch_flow_id === "mi#0")!.status).toBe("consumed");
    expect(["active", "waiting"]).toContain(tokensMid.find((t) => t.branch_flow_id === "mi#1")!.status);

    await completeJob(token, second[0]!, { handled: "b" });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    // Whole-final-overlay aggregation: pinned base + item + loopCounter + interior writes.
    expect(inst.body.variables.results).toEqual([
      { orders: ["a", "b"], loopCounter: 0, order: "a", handled: "a" },
      { orders: ["a", "b"], loopCounter: 1, order: "b", handled: "b" },
    ]);

    const history = await historyCounts(id);
    expect(history["miActivated"]).toBe(1);
    expect(history["miIterationCompleted"]).toBe(2);
    expect(history["miCompleted"]).toBe(1);
  });

  it("[MI-SUB-IDEM-01] cold re-drive mid-flight (one iteration consumed, one parked) is write-free: no duplicate jobs, history, decisions, or token churn", async () => {
    const reserveType = `mi-sub-idem-${uid()}`;
    const extraType = `mi-sub-idem-x-${uid()}`;
    const { instance } = await publishAndStart(MI_PAR_SUB_BPMN(reserveType, extraType), {
      correlationKey: `mi-sub-idem-${uid()}`,
      variables: {},
    });
    const id = instance.body.instanceId as string;

    const token = await mintWorkerToken();
    const reserveJobs = await leaseUpTo(token, reserveType, 5);
    expect(reserveJobs).toHaveLength(2);
    const byCounter = new Map(reserveJobs.map((j) => [j.variables.loopCounter as number, j]));

    // Iteration 0 runs to consumption (default branch); iteration 1 stays
    // parked (its reserve job is still leased) — the brief's mid-flight shape.
    await completeJob(token, byCounter.get(0)!, { order: "a" });
    const tokens = await miTokens(id);
    expect(tokens.find((t) => t.branch_flow_id === "mi#0")!.status).toBe("consumed");
    expect(["active", "waiting"]).toContain(tokens.find((t) => t.branch_flow_id === "mi#1")!.status);

    const midFlight = await snapshot(id);
    await resumeInline(env, id);
    await resumeInline(env, id);
    expect(await snapshot(id)).toEqual(midFlight); // byte-identical: pure rewalk

    // Finish iteration 1 down the conditional branch; end-state re-drives stay write-free too.
    await completeJob(token, byCounter.get(1)!, { order: "b" });
    const extraJobs = await leaseUpTo(token, extraType, 5);
    expect(extraJobs).toHaveLength(1);
    await completeJob(token, extraJobs[0]!, { extraDone: true });

    const done = await snapshot(id);
    expect((done.inst as { status: string }).status).toBe("completed");
    await resumeInline(env, id);
    await resumeInline(env, id);
    expect(await snapshot(id)).toEqual(done);

    const inst = await get(`/instances/${id}`);
    expect(inst.body.variables.results).toEqual([
      { loopCounter: 0, order: "a" },
      { loopCounter: 1, order: "b", extraDone: true },
    ]);
  });
});
