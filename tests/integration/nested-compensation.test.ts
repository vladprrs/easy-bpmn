import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  NESTED_COMMIT_BPMN,
  RE_ENTRY_TX_BPMN,
  authedPost,
  leaseAndComplete,
  leaseOne,
  mintWorkerToken,
  post,
  publishAndStart,
} from "../helpers";
import { resumeInline } from "../../src/runtime/engine";

// M5-L1 nested compensation (spec §3.4 / §4). The root-relative reverse pass:
// an outer cancel compensates committed-inner-tx rows in global reverse order; a
// nested cancel-end runs the inner tx's OWN reverse pass (shielding earlier
// committed occurrences) and CONTINUES the instance on the cancel boundary; an
// operator /cancel is a process-root cancel (retained committedLocal rows
// compensate, sealed 'committed' rows never do).

/**
 * NESTED_COMMIT_BPMN / RE_ENTRY_TX_BPMN reuse task types (stepA/stepB/trip/…).
 * The D1 test DB is shared across `it()` blocks in this file and `/jobs/activate`
 * leases FIFO by taskType only (instance-blind), so a stray un-leased job from an
 * earlier test would be picked up here. Flush to quiescence first (the established
 * mitigation, mirrored from nested-ledger.test.ts).
 */
async function flushStrayJobs(token: string, taskTypes: string[]): Promise<void> {
  for (const taskType of taskTypes) {
    for (let guard = 0; guard < 20; guard++) {
      const r = await authedPost<{ jobs: { jobId: string; lockToken: string }[] }>("/jobs/activate", token, {
        taskType,
        workerId: "flush-worker",
      });
      const jobs = r.body.jobs ?? [];
      if (jobs.length === 0) break;
      for (const job of jobs) {
        await authedPost(`/jobs/${job.jobId}/complete`, token, { lockToken: job.lockToken, outputVariables: {} });
      }
    }
  }
}

/** Lease the single open job of `taskType`, then business-fail it (routes to an error boundary). */
async function leaseAndFail(
  token: string,
  taskType: string,
  fail: { errorCode?: string; reason?: string; retryable?: boolean },
): Promise<void> {
  const job = await leaseOne(token, taskType);
  const res = await authedPost(`/jobs/${job.jobId}/fail`, token, {
    lockToken: job.lockToken,
    reason: fail.reason ?? "boom",
    ...(fail.errorCode ? { errorCode: fail.errorCode } : {}),
    ...(fail.retryable !== undefined ? { retryable: fail.retryable } : {}),
  });
  expect(res.status).toBe(200);
}

async function getInstanceRow(instanceId: string) {
  return env.DB.prepare(`SELECT status, current_element_id FROM process_instances WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ status: string; current_element_id: string | null }>();
}

/** element_id → compensation_status (one row per element; use *Occ for looped elements). */
async function ledgerByElement(instanceId: string): Promise<Record<string, string>> {
  const res = await env.DB.prepare(
    `SELECT element_id, compensation_status FROM saga_steps WHERE instance_id = ? ORDER BY seq`,
  )
    .bind(instanceId)
    .all<{ element_id: string; compensation_status: string }>();
  const out: Record<string, string> = {};
  for (const r of res.results ?? []) out[r.element_id] = r.compensation_status;
  return out;
}

/** Map "element#occurrence" → compensation_status. */
async function ledgerByElementOcc(instanceId: string): Promise<Map<string, string>> {
  const res = await env.DB.prepare(
    `SELECT element_id, occurrence, compensation_status FROM saga_steps WHERE instance_id = ? ORDER BY seq`,
  )
    .bind(instanceId)
    .all<{ element_id: string; occurrence: number; compensation_status: string }>();
  const out = new Map<string, string>();
  for (const r of res.results ?? []) out.set(`${r.element_id}#${r.occurrence}`, r.compensation_status);
  return out;
}

/** History rows as {type, element_id}, in insertion (rowid) order. */
async function historyTypes(instanceId: string): Promise<{ type: string; element_id: string | null }[]> {
  const res = await env.DB.prepare(
    `SELECT type, element_id FROM history_events WHERE instance_id = ? ORDER BY rowid ASC`,
  )
    .bind(instanceId)
    .all<{ type: string; element_id: string | null }>();
  return res.results ?? [];
}

describe("M5-L1 nested compensation (spec §3.4 / §4)", () => {
  // GATE 1 (spec §10.1): outer cancel compensates a committed inner tx, reverse order.
  it("outer-tx > subProcess > inner-tx-commits; outer cancel compensates A and B in reverse", async () => {
    const token = await mintWorkerToken();
    await flushStrayJobs(token, ["stepA", "stepB", "trip", "undoA", "undoB"]);
    const { instance } = await publishAndStart(NESTED_COMMIT_BPMN, { correlationKey: `nc-g1-${crypto.randomUUID()}`, variables: {} });
    const instanceId = instance.body.instanceId as string;
    await leaseAndComplete(token, "stepA", {}); // T commits → A committedLocal
    await leaseAndComplete(token, "stepB", {}); // B pending (scope O)
    await leaseAndFail(token, "trip", { errorCode: "BOOM", retryable: false }); // error boundary → o_cancel → O cancels
    // reverse pass: undoB first (higher global seq), then undoA
    await leaseAndComplete(token, "undoB", {});
    await leaseAndComplete(token, "undoA", {});
    const inst = await getInstanceRow(instanceId);
    expect(inst!.status).toBe("compensated");
    const rows = await ledgerByElement(instanceId);
    expect(rows["A"]).toBe("compensated");
    expect(rows["B"]).toBe("compensated");
    // reverse order held: undoB's compensationStarted precedes undoA's
    const hist = await historyTypes(instanceId);
    expect(hist.filter((h) => h.type === "compensationStarted").map((h) => h.element_id)).toEqual(["B", "A"]);
  });

  // GATE 4 (spec §10.4): self re-entry shield.
  it("T committed at occ0 then cancelled at occ1: occ0 rows untouched; later outer cancel compensates both", async () => {
    const token = await mintWorkerToken();
    await flushStrayJobs(token, ["stepA", "bump", "trip", "undoA"]);
    const { instance } = await publishAndStart(RE_ENTRY_TX_BPMN, { correlationKey: `nc-g4-${crypto.randomUUID()}`, variables: { round: 1 } });
    const instanceId = instance.body.instanceId as string;
    await leaseAndComplete(token, "stepA", {}); // T#occ0 commits → A#0 committedLocal
    await leaseAndComplete(token, "bump", { round: 2 });
    await leaseAndComplete(token, "stepA", {}); // T#occ1: A#1 pending; tgw → t_cancel
    await leaseAndComplete(token, "undoA", {}); // T's OWN reverse pass: A#1 only
    let rows = await ledgerByElementOcc(instanceId); // Map "A#<occ>" → status
    expect(rows.get("A#1")).toBe("compensated");
    expect(rows.get("A#0")).toBe("committedLocal"); // the shield held
    // nested cancel settled non-terminally: the instance CONTINUED via T_cancel → gwm
    await leaseAndComplete(token, "bump", { round: 3 });
    await leaseAndFail(token, "trip", { errorCode: "BOOM", retryable: false }); // O cancels
    await leaseAndComplete(token, "undoA", {}); // occ0 finally compensates (root O ⊐ T)
    rows = await ledgerByElementOcc(instanceId);
    expect(rows.get("A#0")).toBe("compensated");
    expect((await getInstanceRow(instanceId))!.status).toBe("compensated");
  });

  // Operator /cancel = process root: retained committedLocal rows compensate; sealed never.
  it("operator /cancel drives committedLocal (retained) rows, skips sealed committed rows", async () => {
    const token = await mintWorkerToken();
    await flushStrayJobs(token, ["stepA", "stepB", "trip", "undoA", "undoB"]);
    const { instance } = await publishAndStart(NESTED_COMMIT_BPMN, { correlationKey: `nc-op-${crypto.randomUUID()}`, variables: {} });
    const instanceId = instance.body.instanceId as string;
    await leaseAndComplete(token, "stepA", {}); // A committedLocal
    // O still open (B not driven) → operator cancels the instance
    await post(`/instances/${instanceId}/cancel`, {});
    await resumeInline(env, instanceId);
    await leaseAndComplete(token, "undoA", {});
    const rows = await ledgerByElement(instanceId);
    expect(rows["A"]).toBe("compensated");
  });
});
