import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ERROR_END_BPMN, ERROR_END_ROOT_BPMN, authedPost, leaseAndComplete, mintWorkerToken, publishAndStart } from "../helpers";

// M5-L1 error end event (spec §5.2, TASK-10): an endEvent carrying an
// <errorEventDefinition> THROWS from its enclosing scope via the same
// hierarchical attachment-chain walk as a worker-task business error
// (errorCatchTarget, Task 9) — level 0 is a no-op (boundaries never attach to
// end events), so the chain effectively starts at the enclosing scope. Caught
// → drain the catch host's subtree, transition to the boundary target.
// Uncaught at the process root → a NEW `uncaughtError` incident kind (worker-
// task uncaught errors keep `serviceTaskFailure`).

/**
 * `tests/integration/nested-compensation.test.ts` and friends share the D1
 * test DB across `it()` blocks, and `/jobs/activate` leases FIFO by taskType
 * only (instance-blind), so a stray un-leased job from an earlier test would
 * be picked up here. Flush to quiescence first (the established mitigation;
 * see scope-error-bubbling.test.ts).
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

describe("M5-L1 error end event (spec §5.2)", () => {
  it("[S-ERR-END-01] an error end inside a subProcess routes to the scope's error boundary", async () => {
    const token = await mintWorkerToken();
    await flushStrayJobs(token, ["prep", "recover"]);
    const { instance } = await publishAndStart(ERROR_END_BPMN, {
      correlationKey: `error-end-${crypto.randomUUID()}`,
      variables: { fail: true },
    });
    const instanceId = instance.body.instanceId as string;
    await leaseAndComplete(token, "prep", {}); // drives the XOR to the error path
    await leaseAndComplete(token, "recover", {});
    expect((await getInstanceRow(instanceId))!.status).toBe("completed");
  });

  it("[S-ERR-END-01] an error end at process level settles an uncaughtError Hazard", async () => {
    const token = await mintWorkerToken();
    await flushStrayJobs(token, ["prep"]);
    const { instance } = await publishAndStart(ERROR_END_ROOT_BPMN, {
      correlationKey: `error-end-root-${crypto.randomUUID()}`,
      variables: { fail: true },
    });
    const instanceId = instance.body.instanceId as string;
    await leaseAndComplete(token, "prep", {});
    const inst = await getInstanceRow(instanceId);
    expect(inst!.status).toBe("incident");
    const inc = await env.DB.prepare(`SELECT kind FROM incidents WHERE instance_id = ?`).bind(instanceId).first<{ kind: string }>();
    expect(inc!.kind).toBe("uncaughtError");
  });
});
