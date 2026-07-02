import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NESTED_COMMIT_BPMN, NESTED_TX_BPMN, authedPost, leaseAndComplete, mintWorkerToken, publishAndStart } from "../helpers";

/**
 * NESTED_COMMIT_BPMN reuses NESTED_TX_BPMN's task types (stepA/stepB/trip). The
 * D1 test database is shared across `it()` blocks within this file (not
 * per-test-isolated), and `/jobs/activate` leases FIFO by taskType only — never
 * by instance, since the pull-worker model is deliberately instance-blind. The
 * "ledger-write gate" suite above leaves a `stepB` job un-leased (it only drives
 * as far as `A`); left alone, that stray job — and anything it cascades into —
 * would be picked up here instead of this test's own instance. Flush to
 * quiescence first so every lease below targets this test's own instance.
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

describe("M5-L1 ledger-write gate (spec §3.3)", () => {
  it("a completed task inside tx > subProcess is ledgered with scope_id = the subProcess", async () => {
    const { instance } = await publishAndStart(NESTED_TX_BPMN, { correlationKey: "nested-gate-1", variables: {} });
    const instanceId = instance.body.instanceId;
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "stepA", { a: 1 });
    const row = await env.DB.prepare(
      `SELECT scope_id, compensation_status, compensation_element_id FROM saga_steps WHERE instance_id = ? AND element_id = 'A'`,
    ).bind(instanceId).first<{ scope_id: string; compensation_status: string; compensation_element_id: string }>();
    expect(row).toEqual({ scope_id: "S", compensation_status: "pending", compensation_element_id: "undoA" });
  });
});

describe("M5-L1 commit shield — two-tier commit (spec §3.2)", () => {
  it("nested tx commit writes committedLocal over its owned scopes only", async () => {
    const token = await mintWorkerToken();
    await flushStrayJobs(token, ["stepA", "stepB", "trip"]);
    const { instance } = await publishAndStart(NESTED_COMMIT_BPMN, { correlationKey: "nested-commit-1", variables: {} });
    const instanceId = instance.body.instanceId;
    await leaseAndComplete(token, "stepA", {}); // completes A → T commits
    const a = await env.DB.prepare(
      `SELECT compensation_status s FROM saga_steps WHERE instance_id = ? AND element_id = 'A'`,
    ).bind(instanceId).first<{ s: string }>();
    expect(a!.s).toBe("committedLocal"); // NOT terminal 'committed'
  });

  it("outermost commit seals the whole subtree to committed", async () => {
    const token = await mintWorkerToken();
    await flushStrayJobs(token, ["stepA", "stepB", "trip"]);
    const { instance } = await publishAndStart(NESTED_COMMIT_BPMN, { correlationKey: "nested-commit-2", variables: {} });
    const instanceId = instance.body.instanceId;
    await leaseAndComplete(token, "stepA", {});
    await leaseAndComplete(token, "stepB", {});
    await leaseAndComplete(token, "trip", {}); // trip SUCCEEDS → O commits
    const rows = (
      await env.DB.prepare(
        `SELECT element_id, compensation_status s FROM saga_steps WHERE instance_id = ? ORDER BY element_id`,
      ).bind(instanceId).all<{ element_id: string; s: string }>()
    ).results!;
    // trip has no compensation boundary → its row stays notRequired (never flipped).
    expect(rows).toEqual([
      { element_id: "A", s: "committed" },
      { element_id: "B", s: "committed" },
      { element_id: "trip", s: "notRequired" },
    ]);
  });
});
