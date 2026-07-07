import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedPost, get, mintWorkerToken, publishAndStart } from "../helpers";
import { ensureWorkspace } from "../../src/persistence/db";
import { createVersion } from "../../src/persistence/definitions";
import { createInstance } from "../../src/persistence/instances";
import { resumeInline } from "../../src/runtime/engine";
import type { ExecutionGraph } from "../../src/bpmn/graph";
import { MI_COND_BPMN, MI_COND_SUB_BPMN, MI_COND_SUB_TX_BPMN } from "./multi-instance-fixtures";

// M5-L3 (Task 8) — completionCondition early settle + NORMAL (non-compensating)
// cancel-remaining, DIRECT mode. The once-only `condition` settle decider stops
// starting new iterations (Task 6); Task 8 tears down the ones already in flight
// as a plain frontier discard — in-flight serviceTask jobs terminal-abandoned,
// live subProcess iteration tokens marked `discarded` — NEVER via compensation.
// The flagship gate: after an early settle inside a transaction that later
// cancels, EXACTLY the finished iterations compensate and the discarded ones
// ledger nothing. Every test mints its OWN taskType(s) (D1 job state is
// file-visible; a shared type would cross-lease leftovers).

const uid = () => crypto.randomUUID().slice(0, 8);

interface LeasedJob {
  jobId: string;
  instanceId: string;
  elementId: string;
  lockToken: string;
  attempt: number;
  isCompensation?: boolean;
  variables: Record<string, unknown>;
}

async function leaseUpTo(token: string, taskType: string, maxJobs: number): Promise<LeasedJob[]> {
  const r = await authedPost("/jobs/activate", token, { taskType, workerId: "mi-cond-worker", maxJobs });
  expect(r.status).toBe(200);
  return r.body.jobs as LeasedJob[];
}

async function completeJob(token: string, job: LeasedJob, output: Record<string, unknown>): Promise<void> {
  const done = await authedPost(`/jobs/${job.jobId}/complete`, token, { lockToken: job.lockToken, outputVariables: output });
  expect(done.status).toBe(200);
}

async function historyCounts(instanceId: string): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(`SELECT type, COUNT(*) AS n FROM history_events WHERE instance_id = ? GROUP BY type`)
    .bind(instanceId)
    .all<{ type: string; n: number }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.type, r.n]));
}

async function historyDiag(instanceId: string, type: string): Promise<any[]> {
  const h = await get(`/instances/${instanceId}/history`);
  return h.body.events.filter((e: any) => e.type === type);
}

async function jobRows(instanceId: string) {
  return (
    await env.DB.prepare(
      `SELECT job_id, element_id, status, occurrence, iteration_index, is_compensation
         FROM service_task_jobs WHERE instance_id = ? ORDER BY is_compensation, occurrence, iteration_index`,
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

async function miTokens(instanceId: string) {
  return (
    await env.DB.prepare(
      `SELECT branch_flow_id, status FROM execution_tokens WHERE instance_id = ? AND branch_flow_id LIKE 'mi#%' ORDER BY branch_flow_id`,
    )
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

describe("M5-L3 completionCondition — early settle + non-compensating cancel-remaining (direct mode)", () => {
  it("[MI-COND-EARLY-01] serviceTask MI: completing 2 of 4 settles once, terminal-abandons the other 2 jobs, ZERO compensation", async () => {
    const taskType = `mi-cond-${uid()}`;
    const { instance } = await publishAndStart(MI_COND_BPMN(taskType), {
      correlationKey: `mi-cond-${uid()}`,
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting"); // parked on the MI activity

    // Four concurrent iteration jobs (loopCounter 0..3).
    const token = await mintWorkerToken();
    const jobs = await leaseUpTo(token, taskType, 10);
    expect(jobs).toHaveLength(4);
    const byCounter = new Map(jobs.map((j) => [j.variables.loopCounter as number, j]));
    expect([...byCounter.keys()].sort()).toEqual([0, 1, 2, 3]);

    // Complete iterations 0 and 1 → nrOfCompletedInstances reaches 2 → early settle.
    await completeJob(token, byCounter.get(0)!, { probe: "a" });
    await completeJob(token, byCounter.get(1)!, { probe: "b" });

    // The instance COMPLETES without the other two iterations running.
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    // `results` collects only the 2 finished iterations by index; null at the
    // abandoned indexes.
    expect(inst.body.variables.results).toEqual([{ probe: "a" }, { probe: "b" }, null, null]);

    // Iterations 2 and 3 are terminal-abandoned (failed), NOT completed.
    const rows = await jobRows(id);
    const statusByIter = Object.fromEntries(rows.map((r) => [r.iteration_index, r.status]));
    expect(statusByIter[0]).toBe("completed");
    expect(statusByIter[1]).toBe("completed");
    expect(statusByIter[2]).toBe("failed");
    expect(statusByIter[3]).toBe("failed");

    // The flagship invariant: a NORMAL discard, NEVER compensation.
    expect(await compensationJobCount(id)).toBe(0);

    // Audit: exactly one condition-settle, with the completed count.
    const met = await historyDiag(id, "miCompletionConditionMet");
    expect(met).toHaveLength(1);
    expect(met[0].diagnostics.completedCount).toBe(2);

    const history = await historyCounts(id);
    expect(history["miActivated"]).toBe(1);
    expect(history["miIterationCompleted"]).toBe(2); // only the finished iterations audited
    expect(history["miCompleted"]).toBe(1);
  });

  it("[MI-COND-SUB-01] subProcess MI: an early settle marks the still-live iteration token discarded (never consumed, never compensated)", async () => {
    const taskType = `mi-cond-sub-${uid()}`;
    const { instance } = await publishAndStart(MI_COND_SUB_BPMN(taskType), {
      correlationKey: `mi-cond-sub-${uid()}`,
      variables: {},
    });
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    const token = await mintWorkerToken();
    // Two interior `handle` jobs, one per iteration.
    const handleJobs = await leaseUpTo(token, taskType, 10);
    expect(handleJobs).toHaveLength(2);
    const byCounter = new Map(handleJobs.map((j) => [j.variables.loopCounter as number, j]));

    // Both iteration tokens live mid-flight.
    const live = await miTokens(id);
    expect(live.map((t) => t.branch_flow_id)).toEqual(["mi#0", "mi#1"]);
    expect(live.every((t) => ["active", "waiting"].includes(t.status))).toBe(true);

    // Finish iteration 0 → nrOfCompletedInstances = 1 → early settle at k=1.
    await completeJob(token, byCounter.get(0)!, { handled: "a" });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    // Aggregate: iteration 0's final overlay; null at the discarded index.
    expect(inst.body.variables.results).toEqual([{ loopCounter: 0, handled: "a" }, null]);

    // The still-live iteration token was DISCARDED (a normal frontier teardown),
    // never consumed.
    const done = await miTokens(id);
    expect(done.find((t) => t.branch_flow_id === "mi#0")!.status).toBe("consumed");
    expect(done.find((t) => t.branch_flow_id === "mi#1")!.status).toBe("discarded");

    expect(await compensationJobCount(id)).toBe(0);
    const met = await historyDiag(id, "miCompletionConditionMet");
    expect(met).toHaveLength(1);
    expect(met[0].diagnostics.completedCount).toBe(1);
    const history = await historyCounts(id);
    expect(history["miIterationCompleted"]).toBe(1); // only the finished iteration
  });

  it("[MI-COND-LEDGER-01] early settle inside a transaction that later cancels → EXACTLY the finished iterations compensate; the discarded ones ledger nothing", async () => {
    const handleType = `mi-led-handle-${uid()}`;
    const undoType = `mi-led-undo-${uid()}`;
    const finalizeType = `mi-led-final-${uid()}`;
    const { instance } = await publishAndStart(MI_COND_SUB_TX_BPMN(handleType, undoType, finalizeType), {
      correlationKey: `mi-led-${uid()}`,
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    const token = await mintWorkerToken();
    // Four interior `handle` iteration jobs.
    const handleJobs = await leaseUpTo(token, handleType, 10);
    expect(handleJobs).toHaveLength(4);
    const byCounter = new Map(handleJobs.map((j) => [j.variables.loopCounter as number, j]));

    // Finish iterations 0 and 1 → early settle at k=2; iterations 2,3 discarded.
    await completeJob(token, byCounter.get(0)!, { reserved: 0 });
    await completeJob(token, byCounter.get(1)!, { reserved: 1 });

    // Parked at `finalize` inside the transaction; the MI early-settled.
    const mid = await get(`/instances/${id}`);
    expect(mid.body.status).toBe("waiting");
    expect(mid.body.currentElementId).toBe("finalize");

    // ONLY the 2 finished iterations left pending ledger rows (occurrence-keyed,
    // scope = the miBody `mi1`); the discarded iterations ledger NOTHING.
    const preCancel = await ledgerRows(id);
    expect(preCancel.map((r) => [r.element_id, r.occurrence, r.compensation_status])).toEqual([
      ["handle", 0, "pending"],
      ["handle", 1, "pending"],
    ]);
    expect(preCancel.every((r) => r.scope_id === "mi1")).toBe(true);

    const tokensAtCancel = await miTokens(id);
    expect(tokensAtCancel.find((t) => t.branch_flow_id === "mi#2")!.status).toBe("discarded");
    expect(tokensAtCancel.find((t) => t.branch_flow_id === "mi#3")!.status).toBe("discarded");

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

    // Reverse pass compensates the finished iterations in reverse occurrence order,
    // ONE comp job in flight at a time.
    const c1 = (await leaseUpTo(token, undoType, 5))[0]!;
    expect(c1.isCompensation).toBe(true);
    expect(c1.elementId).toBe("handle");
    await completeJob(token, c1, { undone: 1 });
    const c0 = (await leaseUpTo(token, undoType, 5))[0]!;
    await completeJob(token, c0, { undone: 0 });

    // Settled: saga-compensated via the cancel boundary.
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    expect(done.body.currentElementId).toBe("Failed");

    // EXACTLY 2 compensation jobs — one per finished iteration, none for the discarded.
    expect(await compensationJobCount(id)).toBe(2);
    const finalLedger = await ledgerRows(id);
    expect(finalLedger.map((r) => [r.occurrence, r.compensation_status])).toEqual([
      [0, "compensated"],
      [1, "compensated"],
    ]);
    // Reverse occurrence order on the audit surface (occ 1 then occ 0).
    const started = (await historyDiag(id, "compensationStarted")).map((e: any) => e.diagnostics.occurrence);
    expect(started).toEqual([1, 0]);
  });
});

// ---------------------------------------------------------------------------
// A hard FEEL failure in the completionCondition → a deterministic
// `conditionFailure` incident. A broken FEEL body is publish-rejected
// (parseCondition), so the only way to reach the runtime throw is an injected
// graph — the exclusiveGateway conditionFailure precedent.
// ---------------------------------------------------------------------------

function miCondFailGraph(taskType: string, condition: string): ExecutionGraph {
  return {
    processId: "P_mi_condfail",
    startElementId: "S",
    endElementIds: ["E"],
    elements: [],
    nodes: {
      S: { type: "startEvent", next: "mi1", outgoing: [{ flowId: "f1", targetId: "mi1" }] },
      mi1: {
        type: "serviceTask",
        taskType,
        retries: 1,
        next: "E",
        scopeId: null,
        outgoing: [{ flowId: "f2", targetId: "E" }],
        multiInstance: {
          isSequential: false,
          loopCardinality: "2",
          collection: null,
          elementVariable: null,
          outputVariable: "results",
          completionCondition: condition,
          bodyStepCost: 1,
        },
      },
      E: { type: "endEvent", next: null, outgoing: [], endKind: "none" },
    },
    scopes: {
      mi1: { id: "mi1", kind: "miBody", parentId: null, depth: 1, startId: "mi1" },
    },
  };
}

async function injectMiInstance(graph: ExecutionGraph, variables: Record<string, unknown>): Promise<string> {
  const now = new Date().toISOString();
  await ensureWorkspace(env.DB, "default", now);
  const versionId = `pdv_mi_${crypto.randomUUID()}`;
  await createVersion(env.DB, {
    definitionVersionId: versionId,
    draftId: `draft_mi_${crypto.randomUUID()}`,
    workspaceId: "default",
    versionNumber: 1,
    bpmnXml: "<!-- engine-harness-only MI graph; injected, never published -->",
    bpmnXmlHash: `hash_${crypto.randomUUID()}`,
    graph,
    now,
  });
  const instanceId = `pi_mi_${crypto.randomUUID()}`;
  await createInstance(env.DB, {
    instanceId,
    workspaceId: "default",
    definitionVersionId: versionId,
    workflowInstanceId: instanceId,
    correlationKey: `mi-cf-${crypto.randomUUID()}`,
    startElementId: "S",
    variables,
    now,
  });
  return instanceId;
}

describe("M5-L3 completionCondition — conditionFailure (injected graph)", () => {
  it("[MI-COND-FAIL-01] a hard FEEL error in the completionCondition → a deterministic conditionFailure incident on the MI activity", async () => {
    const taskType = `mi-cf-${uid()}`;
    const id = await injectMiInstance(miCondFailGraph(taskType, "nrOfCompletedInstances >="), {});
    await resumeInline(env, id); // activate + fan out the iteration jobs, park

    const token = await mintWorkerToken();
    const jobs = await leaseUpTo(token, taskType, 10);
    expect(jobs).toHaveLength(2);

    // Completing ONE iteration triggers the (broken) completionCondition
    // evaluation → the interpreter throws → conditionFailure.
    await completeJob(token, jobs[0]!, { probe: "x" });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("conditionFailure");
    expect(inst.body.incident.elementId).toBe("mi1");
    expect(await compensationJobCount(id)).toBe(0);
  });
});
