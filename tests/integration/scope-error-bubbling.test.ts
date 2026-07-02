import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  HAZARD_BUBBLE_BPMN,
  SCOPE_ERR_BPMN,
  authedPost,
  leaseAndComplete,
  leaseOne,
  mintWorkerToken,
  publishAndStart,
} from "../helpers";

// M5-L1 hierarchical error bubbling (spec §5.1): an uncaught business error from a
// task climbs the ATTACHMENT chain — the throwing element's own boundaries first,
// then each enclosing scope bottom-up. Error boundaries may now attach to
// subProcess/transaction hosts (Task 9), not just serviceTask (M3).

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

/**
 * `tests/integration/nested-compensation.test.ts` and `nested-ledger.test.ts`
 * share the D1 test DB across `it()` blocks, and `/jobs/activate` leases FIFO by
 * taskType only (instance-blind), so a stray un-leased job from an earlier test
 * would be picked up here. Flush to quiescence first (the established mitigation).
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

async function getInstanceRow(instanceId: string) {
  return env.DB.prepare(`SELECT status, current_element_id FROM process_instances WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ status: string; current_element_id: string | null }>();
}

/** History rows as {type, element_id}, in insertion (rowid) order. */
async function historyTypes(instanceId: string): Promise<{ type: string; element_id: string | null }[]> {
  const res = await env.DB.prepare(`SELECT type, element_id FROM history_events WHERE instance_id = ? ORDER BY rowid ASC`)
    .bind(instanceId)
    .all<{ type: string; element_id: string | null }>();
  return res.results ?? [];
}

describe("M5-L1 hierarchical error bubbling (spec §5.1)", () => {
  it("an uncaught task error climbs to the nearest enclosing scope boundary", async () => {
    const token = await mintWorkerToken();
    await flushStrayJobs(token, ["failing", "recover"]);
    const { instance } = await publishAndStart(SCOPE_ERR_BPMN, { correlationKey: `scope-err-${crypto.randomUUID()}`, variables: {} });
    const instanceId = instance.body.instanceId as string;
    await leaseAndFail(token, "failing", { errorCode: "BIZ", retryable: false });
    await leaseAndComplete(token, "recover", {}); // boundary target ran → bubbling worked
    expect((await getInstanceRow(instanceId))!.status).toBe("completed");
    // retained: A has no compensation wiring here, but S2's drain kept no live tokens
    const hist = await historyTypes(instanceId);
    // Abnormal exit audited EXACTLY ONCE: this run spans multiple drives (the
    // recover completion rewalks re-derive A's applied failure through
    // appliedForwardOutcome), pinning the self-heal path's existence guard —
    // repeated rewalks never duplicate the scopeExited row.
    expect(hist.filter((h) => h.type === "scopeExited" && h.element_id === "S1")).toHaveLength(1);
  });

  it("no boundary anywhere → Hazard at root (serviceTaskFailure, no auto-compensation)", async () => {
    const token = await mintWorkerToken();
    await flushStrayJobs(token, ["failing", "recover"]);
    const { instance } = await publishAndStart(HAZARD_BUBBLE_BPMN, { correlationKey: `hazard-bubble-${crypto.randomUUID()}`, variables: {} });
    const instanceId = instance.body.instanceId as string;
    await leaseAndFail(token, "failing", { errorCode: "BIZ", retryable: false });
    const inst = await getInstanceRow(instanceId);
    expect(inst!.status).toBe("incident");
    const inc = await env.DB.prepare(`SELECT kind FROM incidents WHERE instance_id = ?`).bind(instanceId).first<{ kind: string }>();
    expect(inc!.kind).toBe("serviceTaskFailure");
  });
});
