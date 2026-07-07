import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedPost, get, mintWorkerToken, publishAndStart } from "../helpers";
import { resumeInline } from "../../src/runtime/engine";
import {
  MI_CAP_BPMN,
  MI_IN_PARALLEL_BRANCH_BPMN,
  MI_PAR_TASK_BPMN,
  MI_SEQ_COLL_BPMN,
  MI_ZERO_BPMN,
} from "./multi-instance-fixtures";

// M5-L3 (Task 6) — the MI runtime core over serviceTask bodies, DIRECT mode:
// activation decider (mi_activations = the gateway_decisions analogue), parallel
// vs sequential iteration fan-out over the pull-worker data plane, index-ordered
// aggregation into `outputVariable`, N=0 immediate completion, and the runtime
// body-aware `miCardinality` cap. Every test mints its OWN taskType (D1 job
// state is file-visible; a shared type would cross-lease leftovers).

const uid = () => crypto.randomUUID().slice(0, 8);

interface LeasedJob {
  jobId: string;
  instanceId: string;
  elementId: string;
  lockToken: string;
  variables: Record<string, unknown>;
}

async function leaseUpTo(token: string, taskType: string, maxJobs: number): Promise<LeasedJob[]> {
  const r = await authedPost("/jobs/activate", token, { taskType, workerId: "mi-worker", maxJobs });
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

async function jobCount(instanceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Full canonical-state snapshot for write-freedom / idempotency assertions. */
async function snapshot(instanceId: string) {
  const inst = await env.DB.prepare(
    `SELECT status, current_element_id, variables FROM process_instances WHERE instance_id = ?`,
  )
    .bind(instanceId)
    .first();
  const jobs = (
    await env.DB.prepare(
      `SELECT job_id, status, occurrence, iteration_index, output_applied, idempotency_key
         FROM service_task_jobs WHERE instance_id = ? ORDER BY iteration_index`,
    )
      .bind(instanceId)
      .all()
  ).results;
  const acts = (
    await env.DB.prepare(`SELECT * FROM mi_activations WHERE instance_id = ? ORDER BY element_id, occurrence`)
      .bind(instanceId)
      .all()
  ).results;
  const history = await historyCounts(instanceId);
  return { inst, jobs, acts, history };
}

describe("M5-L3 multi-instance runtime core — serviceTask bodies (direct mode)", () => {
  it("[MI-PAR-TASK-01] parallel cardinality MI: three concurrent iteration jobs, index-ordered aggregation regardless of completion order", async () => {
    const taskType = `mi-charge-${uid()}`;
    const { instance } = await publishAndStart(MI_PAR_TASK_BPMN(taskType), {
      correlationKey: `mi-par-${uid()}`,
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting"); // parked on the MI activity

    // THREE iteration jobs leasable CONCURRENTLY, distinct loopCounter 0/1/2.
    const token = await mintWorkerToken();
    const jobs = await leaseUpTo(token, taskType, 5);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.instanceId === id && j.elementId === "mi1")).toBe(true);
    const counters = jobs.map((j) => j.variables.loopCounter as number).sort();
    expect(counters).toEqual([0, 1, 2]);

    // Complete OUT OF ORDER (2, 0, 1) — the aggregate must still be index-ordered.
    const byCounter = new Map(jobs.map((j) => [j.variables.loopCounter as number, j]));
    for (const i of [2, 0, 1]) {
      await completeJob(token, byCounter.get(i)!, { amount: 10 * (i + 1) });
    }

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.variables.results).toEqual([{ amount: 10 }, { amount: 20 }, { amount: 30 }]);

    const history = await historyCounts(id);
    expect(history["miActivated"]).toBe(1);
    expect(history["miIterationCompleted"]).toBe(3);
    expect(history["miCompleted"]).toBe(1);
  });

  it("[MI-SEQ-COLL-01] sequential collection MI: one leasable job at a time, item + loopCounter visible, items pinned in mi_activations", async () => {
    const taskType = `mi-order-${uid()}`;
    const { instance } = await publishAndStart(MI_SEQ_COLL_BPMN(taskType), {
      correlationKey: `mi-seq-${uid()}`,
      variables: { orders: ["a", "b"] },
    });
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    const token = await mintWorkerToken();
    // Only ONE job leasable while iteration 0 is live.
    const first = await leaseUpTo(token, taskType, 5);
    expect(first).toHaveLength(1);
    expect(first[0]!.variables.order).toBe("a");
    expect(first[0]!.variables.loopCounter).toBe(0);
    expect(await leaseUpTo(token, taskType, 5)).toHaveLength(0); // nothing else in flight

    await completeJob(token, first[0]!, { handled: "a" });

    // Iteration 1 appears only AFTER iteration 0 completed.
    const second = await leaseUpTo(token, taskType, 5);
    expect(second).toHaveLength(1);
    expect(second[0]!.variables.order).toBe("b");
    expect(second[0]!.variables.loopCounter).toBe(1);
    await completeJob(token, second[0]!, { handled: "b" });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.variables.results).toEqual([{ handled: "a" }, { handled: "b" }]);

    // The activation pinned the collection snapshot ONCE (gateway_decisions style).
    const act = await env.DB.prepare(
      `SELECT cardinality, is_sequential, items, settled_kind, output_applied
         FROM mi_activations WHERE instance_id = ? AND element_id = 'mi1' AND occurrence = 0`,
    )
      .bind(id)
      .first<{ cardinality: number; is_sequential: number; items: string; settled_kind: string; output_applied: number }>();
    expect(act).toBeTruthy();
    expect(act!.cardinality).toBe(2);
    expect(act!.is_sequential).toBe(1);
    expect(JSON.parse(act!.items)).toEqual(["a", "b"]);
    expect(act!.output_applied).toBe(1);
  });

  it("[MI-ZERO-01] empty collection: the instance completes on the start-drive with results = []", async () => {
    const taskType = `mi-zero-${uid()}`;
    const { instance } = await publishAndStart(MI_ZERO_BPMN(taskType), {
      correlationKey: `mi-zero-${uid()}`,
      variables: { items: [] },
    });
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("completed");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.variables.results).toEqual([]);
    expect(await jobCount(id)).toBe(0); // zero iterations → zero jobs

    const history = await historyCounts(id);
    expect(history["miActivated"]).toBe(1);
    expect(history["miCompleted"]).toBe(1);
    expect(history["miIterationCompleted"]).toBeUndefined();
  });

  it("[MI-CAP-01] cardinality above the body-aware cap settles a terminal miCardinality incident with NO jobs created", async () => {
    const taskType = `mi-cap-${uid()}`;
    const { instance } = await publishAndStart(MI_CAP_BPMN(taskType), {
      correlationKey: `mi-cap-${uid()}`,
      variables: {},
    });
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("incident");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("miCardinality");
    expect(inst.body.incident.elementId).toBe("mi1");
    expect(inst.body.incident.payloadContext.cardinality).toBe(999);
    expect(await jobCount(id)).toBe(0);
  });

  it("[MI-IDEM-01] duplicate resumeInline is write-free mid-flight and after completion (history counts + variables byte-identical)", async () => {
    const taskType = `mi-idem-${uid()}`;
    const { instance } = await publishAndStart(MI_PAR_TASK_BPMN(taskType), {
      correlationKey: `mi-idem-${uid()}`,
      variables: { seed: 1 },
    });
    const id = instance.body.instanceId as string;
    const token = await mintWorkerToken();
    const jobs = await leaseUpTo(token, taskType, 5);
    expect(jobs).toHaveLength(3);
    const byCounter = new Map(jobs.map((j) => [j.variables.loopCounter as number, j]));

    // Mid-flight: iteration 0 applied, 1 + 2 still leased — resume is pure rewalk.
    await completeJob(token, byCounter.get(0)!, { amount: 10 });
    const midFlight = await snapshot(id);
    await resumeInline(env, id);
    await resumeInline(env, id);
    expect(await snapshot(id)).toEqual(midFlight);

    await completeJob(token, byCounter.get(2)!, { amount: 30 });
    await completeJob(token, byCounter.get(1)!, { amount: 20 });

    // After completion: the settled + applied activation fast-forwards write-free.
    const done = await snapshot(id);
    expect((done.inst as { status: string }).status).toBe("completed");
    await resumeInline(env, id);
    await resumeInline(env, id);
    expect(await snapshot(id)).toEqual(done);
    const inst = await get(`/instances/${id}`);
    expect(inst.body.variables).toMatchObject({ seed: 1, results: [{ amount: 10 }, { amount: 20 }, { amount: 30 }] });
  });

  it("[MI-BRANCH-01] MI inside an M4 parallel branch: the aggregate lands in the branch overlay and folds up at the join", async () => {
    const miType = `mi-branch-${uid()}`;
    const plainType = `mi-plain-${uid()}`;
    const { instance } = await publishAndStart(MI_IN_PARALLEL_BRANCH_BPMN(miType, plainType), {
      correlationKey: `mi-branch-${uid()}`,
      variables: {},
    });
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    const token = await mintWorkerToken();
    const miJobs = await leaseUpTo(token, miType, 5);
    expect(miJobs).toHaveLength(2);
    expect(miJobs.map((j) => j.variables.loopCounter as number).sort()).toEqual([0, 1]);

    // Complete the MI iterations out of order; branch A then waits at the join.
    const byCounter = new Map(miJobs.map((j) => [j.variables.loopCounter as number, j]));
    await completeJob(token, byCounter.get(1)!, { amount: 20 });
    await completeJob(token, byCounter.get(0)!, { amount: 10 });

    // Root variables must NOT yet carry the aggregate (it lives in the branch overlay).
    const preJoin = await get(`/instances/${id}`);
    expect(preJoin.body.status).not.toBe("completed");
    expect(preJoin.body.variables.results).toBeUndefined();

    // Sibling branch completes → AND join folds both overlays into root.
    const plainJobs = await leaseUpTo(token, plainType, 5);
    expect(plainJobs).toHaveLength(1);
    await completeJob(token, plainJobs[0]!, { sibling: true });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.variables.results).toEqual([{ amount: 10 }, { amount: 20 }]);
    expect(inst.body.variables.sibling).toBe(true);

    const history = await historyCounts(id);
    expect(history["miActivated"]).toBe(1);
    expect(history["miIterationCompleted"]).toBe(2);
    expect(history["miCompleted"]).toBe(1);
  });
});
