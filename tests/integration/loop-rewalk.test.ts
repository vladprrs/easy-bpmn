import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedPost, get, mintWorkerToken, publishMessage, startInstance } from "../helpers";
import { createVersion } from "../../src/persistence/definitions";
import { getForwardJob, jobCompleteStmt } from "../../src/persistence/instances";
import { resumeInline } from "../../src/runtime/engine";
import type { ExecutionGraph } from "../../src/bpmn/graph";

// TASK-32 — "the walk is the replay" (design M2 §5), DIRECT mode.
//
// ENGINE-HARNESS-ONLY fixture (not publishable): gateway dispatch has not
// landed (TASK-34), so the cyclic graph is injected DIRECTLY via createVersion,
// bypassing the publish gate (which would reject a model with no reachable end
// event). Shape: Start → TaskA (serviceTask) → Recv (receiveTask) → back to
// TaskA. Each iteration the instance PARKS at the Receive Task, so the test
// drives the loop one message at a time. The instance never completes — these
// tests pin the occurrence machinery, not process completion.
//
// NOTE: each test mints its OWN taskType. The loop instance is intentionally
// left with a forever-leasable parked job, and D1 job state is visible across
// tests in this file — a shared taskType would let a later test's
// /jobs/activate lease an EARLIER test's leftover job (ORDER BY created_at).

const MSG = "LoopMsg";

function loopGraph(taskType: string): ExecutionGraph {
  return {
    processId: "P_loop",
    startElementId: "Start",
    endElementIds: [],
    elements: [],
    nodes: {
      Start: {
        type: "startEvent",
        next: "TaskA",
        outgoing: [{ flowId: "f0", targetId: "TaskA", conditionExpression: null, isDefault: false }],
      },
      TaskA: {
        type: "serviceTask",
        taskType,
        retries: 1,
        next: "Recv",
        outgoing: [{ flowId: "f1", targetId: "Recv", conditionExpression: null, isDefault: false }],
      },
      Recv: {
        type: "receiveTask",
        messageName: MSG,
        next: "TaskA",
        outgoing: [{ flowId: "f2", targetId: "TaskA", conditionExpression: null, isDefault: false }],
      },
    },
  };
}

async function injectLoopVersion(taskType: string): Promise<string> {
  const versionId = `pdv_loop_${crypto.randomUUID()}`;
  await createVersion(env.DB, {
    definitionVersionId: versionId,
    draftId: `draft_loop_${crypto.randomUUID()}`,
    workspaceId: "default",
    versionNumber: 1,
    bpmnXml: "<!-- engine-harness-only cyclic graph; injected, never published -->",
    bpmnXmlHash: `hash_${crypto.randomUUID()}`,
    graph: loopGraph(taskType),
    now: new Date().toISOString(),
  });
  return versionId;
}

/** Lease the single open loop job over the pull plane and complete it. */
async function leaseAndCompleteLoopJob(token: string, taskType: string, instanceId: string, output: Record<string, unknown>) {
  const r = await authedPost("/jobs/activate", token, { taskType, workerId: "loop-worker" });
  expect(r.status).toBe(200);
  expect(r.body.jobs).toHaveLength(1);
  const job = r.body.jobs[0] as { jobId: string; lockToken: string; elementId: string; instanceId: string };
  expect(job.instanceId).toBe(instanceId);
  const done = await authedPost(`/jobs/${job.jobId}/complete`, token, {
    lockToken: job.lockToken,
    outputVariables: output,
  });
  expect(done.status).toBe(200);
  return job;
}

async function historyCounts(instanceId: string): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT type, COUNT(*) AS n FROM history_events WHERE instance_id = ? GROUP BY type`,
  )
    .bind(instanceId)
    .all<{ type: string; n: number }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.type, r.n]));
}

/** Full canonical-state snapshot for write-freedom assertions. */
async function snapshot(instanceId: string) {
  const inst = await env.DB.prepare(
    `SELECT status, current_element_id, variables, updated_at FROM process_instances WHERE instance_id = ?`,
  )
    .bind(instanceId)
    .first();
  const jobs = (
    await env.DB.prepare(
      `SELECT job_id, status, occurrence, output_applied, is_compensation, idempotency_key
         FROM service_task_jobs WHERE instance_id = ? ORDER BY is_compensation, occurrence`,
    )
      .bind(instanceId)
      .all()
  ).results;
  const subs = (
    await env.DB.prepare(
      `SELECT subscription_id, status, occurrence, external_message_id
         FROM message_subscriptions WHERE instance_id = ? ORDER BY occurrence`,
    )
      .bind(instanceId)
      .all()
  ).results;
  const history = await historyCounts(instanceId);
  const varSnaps = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM variable_snapshots WHERE instance_id = ?`,
  )
    .bind(instanceId)
    .first<{ n: number }>();
  return { inst, jobs, subs, history, varSnaps: varSnaps?.n ?? 0 };
}

describe("loop rewalk — occurrence-discriminated execution (direct mode)", () => {
  it("runs N iterations of the same serviceTask as N distinct occurrence-keyed jobs and re-subscribes the receiveTask per iteration", async () => {
    const taskType = `loop-task-${crypto.randomUUID()}`;
    const versionId = await injectLoopVersion(taskType);
    const ck = `loop-${crypto.randomUUID()}`;
    const started = await startInstance(versionId, { correlationKey: ck, variables: { seed: 1 } });
    expect(started.status).toBe(201);
    const id = started.body.instanceId as string;
    expect(started.body.status).toBe("waiting"); // parked at TaskA occurrence 0

    const token = await mintWorkerToken();
    const jobIds: string[] = [];
    for (let k = 0; k < 3; k++) {
      const job = await leaseAndCompleteLoopJob(token, taskType, id, { lastIteration: k, [`out${k}`]: true });
      jobIds.push(job.jobId);
      // The walk applied the output and parked at Recv for THIS iteration.
      const mid = await get(`/instances/${id}`);
      expect(mid.body.status).toBe("waiting");
      expect(mid.body.currentElementId).toBe("Recv");

      const msg = await publishMessage({
        messageName: MSG,
        correlationKey: ck,
        messageId: `loop-msg-${ck}-${k}`,
        payload: { [`msg${k}`]: true },
      });
      expect(msg.body.outcome).toBe("correlated");
      // The walk looped back: a FRESH job row for the next iteration.
      const after = await get(`/instances/${id}`);
      expect(after.body.status).toBe("waiting");
      expect(after.body.currentElementId).toBe("TaskA");
    }

    // AC2: N+1 distinct job rows at occurrence 0..N, occurrence-keyed
    // idempotency keys, applied markers on every applied iteration.
    const s = await snapshot(id);
    expect(s.jobs).toHaveLength(4);
    expect(s.jobs.map((j: any) => j.occurrence)).toEqual([0, 1, 2, 3]);
    expect(new Set(s.jobs.map((j: any) => j.job_id)).size).toBe(4); // distinct jobs ⇒ distinct bpmn_job_<id> event types
    for (const j of s.jobs as any[]) {
      expect(j.idempotency_key).toBe(`${id}:TaskA:0:${j.occurrence}`);
    }
    expect((s.jobs as any[]).slice(0, 3).every((j) => j.status === "completed" && j.output_applied === 1)).toBe(true);
    expect((s.jobs as any[])[3]).toMatchObject({ status: "created", output_applied: 0 });

    // AC5: the receive task re-subscribed per iteration — occurrence-keyed
    // subscription rows, each consumed by its own message.
    expect(s.subs.map((x: any) => [x.occurrence, x.status])).toEqual([
      [0, "consumed"],
      [1, "consumed"],
      [2, "consumed"],
    ]);
    expect(new Set(s.subs.map((x: any) => x.external_message_id)).size).toBe(3);

    // Variables accumulated across iterations (no regression to an older merge).
    const inst = await get(`/instances/${id}`);
    expect(inst.body.variables).toMatchObject({
      seed: 1,
      out0: true,
      out1: true,
      out2: true,
      msg0: true,
      msg1: true,
      msg2: true,
      lastIteration: 2,
    });

    // History: per-visit events exactly once per iteration; bookkeeping
    // (start) exactly once despite every drive re-walking from the start.
    expect(s.history["instanceStarted"]).toBe(1);
    expect(s.history["serviceTaskJobCreated"]).toBe(4);
    expect(s.history["serviceTaskCompleted"]).toBe(3);
    expect(s.history["receiveTaskWaiting"]).toBe(3);
    expect(s.history["messageCorrelated"]).toBe(3);
  });

  it("rewalk fast-forward is write-free: resuming mid-loop changes NOTHING (parked at serviceTask and at receiveTask)", async () => {
    const taskType = `loop-task-${crypto.randomUUID()}`;
    const versionId = await injectLoopVersion(taskType);
    const ck = `loop-ff-${crypto.randomUUID()}`;
    const started = await startInstance(versionId, { correlationKey: ck, variables: { seed: 1 } });
    const id = started.body.instanceId as string;
    const token = await mintWorkerToken();

    // One full iteration, then parked at TaskA occurrence 1.
    await leaseAndCompleteLoopJob(token, taskType, id, { out0: true });
    await publishMessage({ messageName: MSG, correlationKey: ck, messageId: `ff-${ck}-0`, payload: { msg0: true } });

    // Resume while parked at the serviceTask frontier: pure rewalk, zero writes.
    const atSvc = await snapshot(id);
    expect((atSvc.inst as any).current_element_id).toBe("TaskA");
    await resumeInline(env, id);
    await resumeInline(env, id);
    expect(await snapshot(id)).toEqual(atSvc);

    // Advance to the receive frontier, then resume there: zero writes too.
    await leaseAndCompleteLoopJob(token, taskType, id, { out1: true });
    const atRecv = await snapshot(id);
    expect((atRecv.inst as any).current_element_id).toBe("Recv");
    await resumeInline(env, id);
    await resumeInline(env, id);
    expect(await snapshot(id)).toEqual(atRecv);

    // The loop still works after the resumes: the next message advances once.
    await publishMessage({ messageName: MSG, correlationKey: ck, messageId: `ff-${ck}-1`, payload: { msg1: true } });
    const after = await snapshot(id);
    expect((after.inst as any).current_element_id).toBe("TaskA");
    expect(after.jobs).toHaveLength(3); // occ 0..2
    expect(after.history["messageCorrelated"]).toBe(2);
  });

  it("legacy M1 markers (no occurrence field in diagnostics) still fast-forward as occurrence 0", async () => {
    const taskType = `loop-task-${crypto.randomUUID()}`;
    const versionId = await injectLoopVersion(taskType);
    const ck = `loop-legacy-${crypto.randomUUID()}`;
    const started = await startInstance(versionId, { correlationKey: ck, variables: { seed: 1 } });
    const id = started.body.instanceId as string;
    expect(started.body.status).toBe("waiting"); // parked at TaskA occurrence 0

    // Simulate a pre-deploy (M1) instance: marker events were written WITHOUT
    // an occurrence field in diagnostics — the predicate must fold them to 0.
    await env.DB.prepare(
      `UPDATE history_events SET diagnostics = json_remove(diagnostics, '$.occurrence') WHERE instance_id = ?`,
    )
      .bind(id)
      .run();

    // Resuming rewalks through the start marker: pure write-free fast-forward —
    // no duplicate instanceStarted/elementEntered, no state change.
    const before = await snapshot(id);
    expect(before.history["instanceStarted"]).toBe(1);
    expect(before.history["elementEntered"]).toBe(2); // Start marker + TaskA entry
    await resumeInline(env, id);
    await resumeInline(env, id);
    expect(await snapshot(id)).toEqual(before);
  });

  it("apply-once across the crash window: a completed-but-unapplied job resumes exactly once (output_applied atomic with the advance)", async () => {
    const taskType = `loop-task-${crypto.randomUUID()}`;
    const versionId = await injectLoopVersion(taskType);
    const ck = `loop-crash-${crypto.randomUUID()}`;
    const started = await startInstance(versionId, { correlationKey: ck, variables: { seed: 1 } });
    const id = started.body.instanceId as string;
    const token = await mintWorkerToken();

    // Iteration 0 completes fully; parked at TaskA occurrence 1.
    await leaseAndCompleteLoopJob(token, taskType, id, { out0: true });
    await publishMessage({ messageName: MSG, correlationKey: ck, messageId: `crash-${ck}-0`, payload: { msg0: true } });

    // Simulate the crash window: the WORKER completion landed in D1, but the
    // engine drive crashed before applying it (no deliverJobResult).
    const job1 = await getForwardJob(env.DB, id, "TaskA", 1);
    expect(job1).toBeTruthy();
    await jobCompleteStmt(env.DB, job1!.job_id, { crashOut: 99 }, new Date().toISOString()).run();
    expect((await getForwardJob(env.DB, id, "TaskA", 1))!.output_applied).toBe(0);

    // First resume applies the output ONCE and lands on the next frontier.
    await resumeInline(env, id);
    const applied = await snapshot(id);
    expect((applied.inst as any).current_element_id).toBe("Recv");
    expect((applied.inst as any).status).toBe("waiting");
    const j1 = await getForwardJob(env.DB, id, "TaskA", 1);
    expect(j1!.output_applied).toBe(1);
    const inst = await get(`/instances/${id}`);
    expect(inst.body.variables).toMatchObject({ crashOut: 99, out0: true, msg0: true });
    expect(applied.history["serviceTaskCompleted"]).toBe(2); // occ 0 + occ 1, exactly once each

    // Further resumes are pure fast-forward — no re-merge, no duplicates.
    await resumeInline(env, id);
    await resumeInline(env, id);
    expect(await snapshot(id)).toEqual(applied);
  });

  it("duplicate worker callback and duplicate message within one iteration advance at most once per occurrence", async () => {
    const taskType = `loop-task-${crypto.randomUUID()}`;
    const versionId = await injectLoopVersion(taskType);
    const ck = `loop-dup-${crypto.randomUUID()}`;
    const started = await startInstance(versionId, { correlationKey: ck, variables: { seed: 1 } });
    const id = started.body.instanceId as string;
    const token = await mintWorkerToken();

    // Iteration 0 completes; now in iteration 1.
    await leaseAndCompleteLoopJob(token, taskType, id, { out0: true });
    await publishMessage({ messageName: MSG, correlationKey: ck, messageId: `dup-${ck}-0`, payload: { msg0: true } });

    // Duplicate COMPLETE of iteration 1's job (same lockToken) → stable
    // idempotent ack, no second advance, no new occurrence.
    const job = await leaseAndCompleteLoopJob(token, taskType, id, { out1: true });
    const before = await snapshot(id);
    const dup = await authedPost(`/jobs/${job.jobId}/complete`, token, {
      lockToken: (job as any).lockToken,
      outputVariables: { out1: "SHOULD-NOT-APPLY" },
    });
    expect(dup.status).toBe(200);
    expect(await snapshot(id)).toEqual(before);
    expect((before.inst as any).current_element_id).toBe("Recv"); // still iteration 1's wait

    // Duplicate MESSAGE within iteration 1 (same messageId) → broker dedup,
    // single correlation, single advance.
    await publishMessage({ messageName: MSG, correlationKey: ck, messageId: `dup-${ck}-1`, payload: { msg1: true } });
    const second = await publishMessage({ messageName: MSG, correlationKey: ck, messageId: `dup-${ck}-1`, payload: { msg1: true } });
    expect(second.body.outcome).toBe("duplicate");
    const after = await snapshot(id);
    expect(after.history["messageCorrelated"]).toBe(2);
    expect(after.jobs).toHaveLength(3); // occ 0..2 — advanced exactly once
    expect((after.inst as any).current_element_id).toBe("TaskA");
  });
});
