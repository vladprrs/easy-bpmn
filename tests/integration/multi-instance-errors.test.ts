import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedPost, get, mintWorkerToken, post, publishAndStart } from "../helpers";
import { fireTimer } from "../../src/runtime/timers";
import {
  MI_ERR_BOUNDARY_BPMN,
  MI_ERR_SUB_BPMN,
  MI_ERR_UNCAUGHT_BPMN,
  MI_TIMER_BPMN,
} from "./multi-instance-fixtures";

// M5-L3 (Task 9) — iteration errors + the Hazard timer on the MI activity,
// DIRECT mode. An iteration BUSINESS error (worker /jobs/fail with an error code,
// or a subProcess-body error end) settles the activation `abort` ONCE, drains the
// miBody subtree (retention: finished iterations kept, in-flight abandoned), then
// routes exactly as "the MI activity threw": error boundary on the MI element →
// its flow; else bubble up the scope tree; root → `uncaughtError`. A timer
// boundary on the MI activity = Hazard: fire → drain (mark abort) → continue on
// the boundary flow, NO compensation; the retained finished rows compensate only
// if an operator /cancel later drives the reverse pass. Every test mints its OWN
// taskType(s) (D1 job state is file-visible; a shared type would cross-lease).

const uid = () => crypto.randomUUID().slice(0, 8);

interface LeasedJob {
  jobId: string;
  instanceId: string;
  elementId: string;
  lockToken: string;
  attempt?: number;
  isCompensation?: boolean;
  variables: Record<string, unknown>;
}

async function leaseUpTo(token: string, taskType: string, maxJobs: number): Promise<LeasedJob[]> {
  const r = await authedPost("/jobs/activate", token, { taskType, workerId: "mi-err-worker", maxJobs });
  expect(r.status).toBe(200);
  return r.body.jobs as LeasedJob[];
}

async function completeJob(token: string, job: LeasedJob, output: Record<string, unknown>): Promise<void> {
  const done = await authedPost(`/jobs/${job.jobId}/complete`, token, { lockToken: job.lockToken, outputVariables: output });
  expect(done.status).toBe(200);
}

async function failJob(token: string, job: LeasedJob, errorCode: string): Promise<void> {
  const done = await authedPost(`/jobs/${job.jobId}/fail`, token, {
    lockToken: job.lockToken,
    reason: "iteration business error",
    errorCode,
    retryable: false,
  });
  expect(done.status).toBe(200);
}

async function historyCounts(instanceId: string): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(`SELECT type, COUNT(*) AS n FROM history_events WHERE instance_id = ? GROUP BY type`)
    .bind(instanceId)
    .all<{ type: string; n: number }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.type, r.n]));
}

async function jobRows(instanceId: string) {
  return (
    await env.DB.prepare(
      `SELECT job_id, element_id, status, occurrence, iteration_index, is_compensation
         FROM service_task_jobs WHERE instance_id = ? ORDER BY is_compensation, element_id, occurrence, iteration_index`,
    )
      .bind(instanceId)
      .all()
  ).results as {
    job_id: string;
    element_id: string;
    status: string;
    occurrence: number;
    iteration_index: number;
    is_compensation: number;
  }[];
}

async function compensationJobCount(instanceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 1`)
    .bind(instanceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function miActivation(instanceId: string, elementId = "mi1") {
  return env.DB.prepare(`SELECT settled_kind, settled_count, output_applied FROM mi_activations WHERE instance_id = ? AND element_id = ? AND occurrence = 0`)
    .bind(instanceId, elementId)
    .first<{ settled_kind: string | null; settled_count: number | null; output_applied: number }>();
}

async function miTokens(instanceId: string) {
  return (
    await env.DB.prepare(`SELECT branch_flow_id, status FROM execution_tokens WHERE instance_id = ? AND branch_flow_id LIKE 'mi#%' ORDER BY branch_flow_id`)
      .bind(instanceId)
      .all()
  ).results as { branch_flow_id: string; status: string }[];
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

async function theTimer(instanceId: string): Promise<{ timer_id: string } | null> {
  return env.DB.prepare(`SELECT timer_id FROM timers WHERE instance_id = ? ORDER BY created_at LIMIT 1`).bind(instanceId).first<{ timer_id: string }>();
}

/**
 * Force the armed timer overdue in D1, then fire it DIRECTLY via `fireTimer`
 * (re-reads the canonical timer + fire_at, exactly what the DO alarm dispatches
 * to). The fixture arms a long (PT30S) timer that never elapses on its own during
 * the test, so this is fully deterministic — unlike a short PT0.5S timer whose DO
 * alarm can auto-fire in the background under full-suite load (the flaky path).
 */
async function fireTimerNow(instanceId: string): Promise<string> {
  const t = await theTimer(instanceId);
  expect(t).toBeTruthy();
  await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(t!.timer_id).run();
  await fireTimer(env, t!.timer_id);
  return t!.timer_id;
}

describe("M5-L3 iteration errors + Hazard timer on the MI activity (direct mode)", () => {
  it("[MI-ERR-BOUNDARY-01] a business error in one iteration aborts the visit, drains the in-flight iterations, and routes the error boundary on the MI activity", async () => {
    const taskType = `mi-err-charge-${uid()}`;
    const handlerType = `mi-err-handler-${uid()}`;
    const { instance } = await publishAndStart(MI_ERR_BOUNDARY_BPMN(taskType, handlerType), {
      correlationKey: `mi-err-boundary-${uid()}`,
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    const token = await mintWorkerToken();
    const jobs = await leaseUpTo(token, taskType, 5);
    expect(jobs).toHaveLength(3);
    const byCounter = new Map(jobs.map((j) => [j.variables.loopCounter as number, j]));

    // Iteration 0 completes; iteration 1 business-errors with MI_FAIL; iteration 2
    // is still in flight and must be abandoned by the abort drain.
    await completeJob(token, byCounter.get(0)!, { amount: 10 });
    await failJob(token, byCounter.get(1)!, "MI_FAIL");

    // The visit aborted once, and the token routed to the error boundary handler.
    const act = await miActivation(id);
    expect(act?.settled_kind).toBe("abort");

    const rows = await jobRows(id);
    const statusByIter = Object.fromEntries(rows.filter((r) => r.element_id === "mi1").map((r) => [r.iteration_index, r.status]));
    expect(statusByIter[0]).toBe("completed"); // finished iteration retained
    expect(statusByIter[1]).toBe("failed"); // the business error
    expect(statusByIter[2]).toBe("failed"); // in-flight → abandoned by the drain

    // Routed to the boundary handler (never the normal mi1 → E exit).
    const routed = await get(`/instances/${id}`);
    expect(routed.body.status).toBe("waiting");
    expect(routed.body.currentElementId).toBe("handler");

    // NEVER auto-compensation; the audit records the abort with the code + index.
    expect(await compensationJobCount(id)).toBe(0);
    const history = await historyCounts(id);
    expect(history["miAborted"]).toBe(1);
    expect(history["miCompleted"]).toBeUndefined(); // aborted, never applied

    // Finish the handler → the saga completes on the boundary path.
    const handlerJob = (await leaseUpTo(token, handlerType, 5))[0]!;
    expect(handlerJob.elementId).toBe("handler");
    await completeJob(token, handlerJob, {});
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
  });

  it("[MI-ERR-UNCAUGHT-01] a business error with no matching boundary aborts and settles a graceful uncaughtError incident at root", async () => {
    const taskType = `mi-unc-${uid()}`;
    const { instance } = await publishAndStart(MI_ERR_UNCAUGHT_BPMN(taskType), {
      correlationKey: `mi-unc-${uid()}`,
      variables: {},
    });
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    const token = await mintWorkerToken();
    const jobs = await leaseUpTo(token, taskType, 5);
    expect(jobs).toHaveLength(3);
    const byCounter = new Map(jobs.map((j) => [j.variables.loopCounter as number, j]));

    await failJob(token, byCounter.get(0)!, "MI_FAIL");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("uncaughtError");
    expect(inst.body.incident.elementId).toBe("mi1");

    const act = await miActivation(id);
    expect(act?.settled_kind).toBe("abort");

    // The two other in-flight iterations were abandoned by the drain.
    const rows = await jobRows(id);
    const statuses = rows.filter((r) => r.element_id === "mi1").map((r) => r.status).sort();
    expect(statuses).toEqual(["failed", "failed", "failed"]);
    expect(await compensationJobCount(id)).toBe(0);
  });

  it("[MI-ERR-SUB-01] a subProcess-body error end routes identically: aborts, drains the sibling iteration, and takes the MI error boundary", async () => {
    const checkType = `mi-sub-check-${uid()}`;
    const handlerType = `mi-sub-handler-${uid()}`;
    const { instance } = await publishAndStart(MI_ERR_SUB_BPMN(checkType, handlerType), {
      correlationKey: `mi-err-sub-${uid()}`,
      variables: {},
    });
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    const token = await mintWorkerToken();
    const checks = await leaseUpTo(token, checkType, 5);
    expect(checks).toHaveLength(2);
    const byCounter = new Map(checks.map((j) => [j.variables.loopCounter as number, j]));

    // Iteration 0's check reports fail=true → its interior gateway routes to the
    // error end → the whole MI aborts; iteration 1 is still in flight.
    await completeJob(token, byCounter.get(0)!, { fail: true });

    const act = await miActivation(id);
    expect(act?.settled_kind).toBe("abort");

    // Routed to the MI error boundary handler.
    const routed = await get(`/instances/${id}`);
    expect(routed.body.status).toBe("waiting");
    expect(routed.body.currentElementId).toBe("handler");

    // The sibling iteration token was discarded (a normal frontier teardown).
    const tokens = await miTokens(id);
    expect(tokens.find((t) => t.branch_flow_id === "mi#1")!.status).toBe("discarded");
    expect(await compensationJobCount(id)).toBe(0);

    const history = await historyCounts(id);
    expect(history["miAborted"]).toBe(1);

    const handlerJob = (await leaseUpTo(token, handlerType, 5))[0]!;
    expect(handlerJob.elementId).toBe("handler");
    await completeJob(token, handlerJob, {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  it("[MI-HAZARD-TIMER-01] a timer boundary on the MI activity interrupts WITHOUT compensation; a later operator /cancel compensates the retained finished iterations", async () => {
    const handleType = `mi-tmr-handle-${uid()}`;
    const undoType = `mi-tmr-undo-${uid()}`;
    const timeoutType = `mi-tmr-timeout-${uid()}`;
    const { instance } = await publishAndStart(MI_TIMER_BPMN(handleType, undoType, timeoutType), {
      correlationKey: `mi-timer-${uid()}`,
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    const token = await mintWorkerToken();
    const handles = await leaseUpTo(token, handleType, 5);
    expect(handles).toHaveLength(3);
    const byCounter = new Map(handles.map((j) => [j.variables.loopCounter as number, j]));

    // Finish iteration 0 (retained), then FIRE THE TIMER while 1 and 2 are in flight.
    await completeJob(token, byCounter.get(0)!, { reserved: 0 });
    const timerId = await fireTimerNow(id);
    expect(
      (await env.DB.prepare(`SELECT outcome FROM timer_outcomes WHERE timer_id = ?`).bind(timerId).first<{ outcome: string }>())?.outcome,
    ).toBe("fired");

    // The MI aborted (Hazard) and the token took the boundary flow.
    const act = await miActivation(id);
    expect(act?.settled_kind).toBe("abort");
    const routed = await get(`/instances/${id}`);
    expect(routed.body.status).toBe("waiting");
    expect(routed.body.currentElementId).toBe("onTimeout");

    // Iteration 0 consumed + its interior ledger row RETAINED pending; iterations
    // 1 and 2 discarded, their handle jobs abandoned. ZERO compensation so far.
    const tokens = await miTokens(id);
    expect(tokens.find((t) => t.branch_flow_id === "mi#0")!.status).toBe("consumed");
    expect(tokens.find((t) => t.branch_flow_id === "mi#1")!.status).toBe("discarded");
    expect(tokens.find((t) => t.branch_flow_id === "mi#2")!.status).toBe("discarded");
    expect(await compensationJobCount(id)).toBe(0);
    const retained = await ledgerRows(id);
    expect(retained.map((r) => [r.element_id, r.occurrence, r.compensation_status])).toEqual([["handle", 0, "pending"]]);
    expect(retained.every((r) => r.scope_id === "mi1")).toBe(true);

    // Operator /cancel drives the reverse pass over the retained finished iteration.
    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.status).toBe(200);

    const undo = (await leaseUpTo(token, undoType, 5))[0]!;
    expect(undo.isCompensation).toBe(true);
    expect(undo.elementId).toBe("handle");
    await completeJob(token, undo, { undone: 0 });

    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    // EXACTLY one compensation job — for the single finished iteration.
    expect(await compensationJobCount(id)).toBe(1);
    const finalLedger = await ledgerRows(id);
    expect(finalLedger.map((r) => [r.occurrence, r.compensation_status])).toEqual([[0, "compensated"]]);
  });
});
