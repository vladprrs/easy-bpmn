import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createVersion } from "../../src/persistence/definitions";
import { ensureWorkspace } from "../../src/persistence/db";
import { createInstance, getForwardJob, jobCompleteStmt } from "../../src/persistence/instances";
import { runInstance, type WaitOutcome } from "../../src/runtime/engine";
import type { MessageEventPayload } from "../../src/contracts/workflow-events";
import type { ExecutionGraph } from "../../src/bpmn/graph";

// TASK-32 — "the walk is the replay" (design M2 §5), WORKFLOW mode.
//
// The vitest suite runs EXECUTION_MODE=direct, so the real Cloudflare Workflow
// runtime path is untested project-wide. This harness reproduces the two
// properties the engine relies on from step.do:
//   1. MEMOIZATION BY STEP NAME persisting across crash/replay invocations of
//      runInstance (a Map shared across calls);
//   2. the nastier window — a crash AFTER a step's D1 batch committed but
//      BEFORE its result was memoized (Workflows can replay a step whose
//      effects landed) — implemented as run-the-body-then-throw-without-memoizing.
// waitFor is scripted per step name; an unscripted wait throws (= crash while
// suspended). Same engine-harness-only cyclic fixture as loop-rewalk.test.ts.

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

interface Harness {
  memo: Map<string, unknown>;
  /** Step names whose BODIES actually ran (memo misses), in order. */
  executed: string[];
  /** Step names that run their body, COMMIT, then crash before memoizing. */
  crashAfterCommit: Set<string>;
  /** Scripted wait outcomes by step name; an unscripted wait = crash. */
  waitScript: Map<string, () => Promise<WaitOutcome>>;
  /** Every wait that was armed: `${name}|${workflowEventType}`. */
  waits: string[];
  runStep: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  waitFor: (sub: { name: string; workflowEventType: string; timeout: string }) => Promise<WaitOutcome>;
}

function makeHarness(): Harness {
  const memo = new Map<string, unknown>();
  const executed: string[] = [];
  const crashAfterCommit = new Set<string>();
  const waitScript = new Map<string, () => Promise<WaitOutcome>>();
  const waits: string[] = [];
  return {
    memo,
    executed,
    crashAfterCommit,
    waitScript,
    waits,
    runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (memo.has(name)) return memo.get(name) as T; // step.do replay
      const result = await fn();
      executed.push(name);
      if (crashAfterCommit.has(name)) {
        crashAfterCommit.delete(name);
        throw new Error(`crash-after-commit:${name}`); // effects landed, memo lost
      }
      memo.set(name, result);
      return result;
    },
    waitFor: async (sub) => {
      waits.push(`${sub.name}|${sub.workflowEventType}`);
      const handler = waitScript.get(sub.name);
      if (!handler) throw new Error(`crash-at-wait:${sub.name}`);
      waitScript.delete(sub.name);
      return handler();
    },
  };
}

function msgEvent(ck: string, k: number): MessageEventPayload {
  return {
    externalMessageId: `em-${ck}-${k}`,
    messageName: MSG,
    correlationKey: ck,
    messageId: `m-${ck}-${k}`,
    payload: { [`msg${k}`]: true },
  };
}

async function historyCounts(instanceId: string): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT type, COUNT(*) AS n FROM history_events WHERE instance_id = ? GROUP BY type`,
  )
    .bind(instanceId)
    .all<{ type: string; n: number }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.type, r.n]));
}

describe("loop replay — workflow-mode memoization harness", () => {
  it("crash/replay mid-loop is write-free for applied steps, survives the committed-but-unmemoized window, and lands on the frontier", async () => {
    const taskType = `wf-loop-${crypto.randomUUID()}`;
    const ck = `wf-${crypto.randomUUID()}`;
    const versionId = `pdv_wf_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await ensureWorkspace(env.DB, "default", now);
    await createVersion(env.DB, {
      definitionVersionId: versionId,
      draftId: `draft_wf_${crypto.randomUUID()}`,
      workspaceId: "default",
      versionNumber: 1,
      bpmnXml: "<!-- engine-harness-only cyclic graph -->",
      bpmnXmlHash: `hash_${crypto.randomUUID()}`,
      graph: loopGraph(taskType),
      now,
    });
    const instanceId = `pi_wf_${crypto.randomUUID()}`;
    await createInstance(env.DB, {
      instanceId,
      workspaceId: "default",
      definitionVersionId: versionId,
      workflowInstanceId: instanceId,
      correlationKey: ck,
      startElementId: "Start",
      variables: { seed: true },
      now,
    });

    const h = makeHarness();
    const run = () =>
      runInstance(env, instanceId, { runStep: h.runStep, waitFor: h.waitFor }).then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e: String(e) }),
      );
    const completeJob = (occ: number, output: Record<string, unknown>) => async (): Promise<WaitOutcome> => {
      const job = await getForwardJob(env.DB, instanceId, "TaskA", occ);
      expect(job).toBeTruthy();
      await jobCompleteStmt(env.DB, job!.job_id, output, new Date().toISOString()).run();
      return { kind: "event", payload: {} }; // engine re-reads the job from D1
    };

    // ---- run 1: iteration 0 completes; CRASH while suspended at TaskA#1's wait.
    h.waitScript.set("wait-job:TaskA#0", completeJob(0, { iter0: true }));
    h.waitScript.set("wait:Recv#0", async () => ({ kind: "event", payload: msgEvent(ck, 0) }));
    const run1 = await run();
    expect(run1.ok).toBe(false);
    expect((run1 as any).e).toContain("crash-at-wait:wait-job:TaskA#1");
    expect(h.executed).toEqual([
      "init",
      "start:Start#0",
      "svc-create:TaskA#0",
      "svc-apply:TaskA#0",
      "recv:Recv#0",
      "msg:Recv#0",
      "svc-create:TaskA#1",
    ]);
    expect((await getForwardJob(env.DB, instanceId, "TaskA", 0))!.output_applied).toBe(1);

    // ---- run 2 (replay, SAME memo): TaskA#1 completes; svc-apply:TaskA#1
    // COMMITS but crashes before memoizing (the nastier window).
    h.executed.length = 0;
    h.crashAfterCommit.add("svc-apply:TaskA#1");
    h.waitScript.set("wait-job:TaskA#1", completeJob(1, { iter1: true }));
    const run2 = await run();
    expect(run2.ok).toBe(false);
    expect((run2 as any).e).toContain("crash-after-commit:svc-apply:TaskA#1");
    // The replay re-ran NO applied step bodies — memoization + D1 fast-forward.
    expect(h.executed).toEqual(["svc-apply:TaskA#1"]);
    expect((await getForwardJob(env.DB, instanceId, "TaskA", 1))!.output_applied).toBe(1);

    // ---- run 3 (replay): TaskA#1 fast-forwards from D1 (its memo was lost!),
    // Recv#1 registers + receives; msg:Recv#1 COMMITS then crashes unmemoized.
    h.executed.length = 0;
    h.crashAfterCommit.add("msg:Recv#1");
    h.waitScript.set("wait:Recv#1", async () => ({ kind: "event", payload: msgEvent(ck, 1) }));
    const run3 = await run();
    expect(run3.ok).toBe(false);
    expect((run3 as any).e).toContain("crash-after-commit:msg:Recv#1");
    expect(h.executed).toEqual(["recv:Recv#1", "msg:Recv#1"]);

    // ---- run 4 (replay): everything applied fast-forwards write-free; the
    // walk lands on the live frontier (TaskA#2) and suspends on its wait.
    h.executed.length = 0;
    const histBefore = await historyCounts(instanceId);
    const run4 = await run();
    expect(run4.ok).toBe(false);
    expect((run4 as any).e).toContain("crash-at-wait:wait-job:TaskA#2");
    expect(h.executed).toEqual(["svc-create:TaskA#2"]); // the ONLY new work
    // msg:Recv#1's committed-but-unmemoized batch was NOT re-applied: no new
    // correlation, no variable regression, no duplicate history.
    const histAfter = await historyCounts(instanceId);
    expect(histAfter.messageCorrelated).toBe(2);
    expect(histAfter.serviceTaskCompleted).toBe(2);
    expect(histAfter.instanceStarted).toBe(1);
    expect(histAfter.receiveTaskWaiting).toBe(2);
    expect({ ...histBefore, serviceTaskJobCreated: 3, elementEntered: (histBefore.elementEntered ?? 0) + 1 }).toEqual(histAfter);

    // Canonical end state: 3 occurrence-keyed jobs (0,1 applied; 2 = frontier),
    // variables accumulated with no regression, distinct per-iteration waits.
    const jobs = (
      await env.DB.prepare(
        `SELECT job_id, status, occurrence, output_applied FROM service_task_jobs WHERE instance_id = ? ORDER BY occurrence`,
      )
        .bind(instanceId)
        .all()
    ).results as any[];
    expect(jobs.map((j) => [j.occurrence, j.status, j.output_applied])).toEqual([
      [0, "completed", 1],
      [1, "completed", 1],
      [2, "created", 0],
    ]);
    expect(new Set(jobs.map((j) => j.job_id)).size).toBe(3);

    const inst = await env.DB.prepare(`SELECT variables FROM process_instances WHERE instance_id = ?`)
      .bind(instanceId)
      .first<{ variables: string }>();
    expect(JSON.parse(inst!.variables)).toMatchObject({ seed: true, iter0: true, iter1: true, msg0: true, msg1: true });

    const subs = (
      await env.DB.prepare(
        `SELECT occurrence, status FROM message_subscriptions WHERE instance_id = ? ORDER BY occurrence`,
      )
        .bind(instanceId)
        .all()
    ).results as any[];
    expect(subs.map((s) => [s.occurrence, s.status])).toEqual([
      [0, "consumed"],
      [1, "consumed"],
    ]);

    // AC2: every wait is uniquely named per iteration and waits on a unique
    // per-job event type (bpmn_job_<jobId>). `wait-job:TaskA#1` appears twice:
    // run 1 crashed while suspended on it, so run 2's replay re-arms the SAME
    // wait under the SAME name — exactly the workflow-replay contract.
    const waitNames = h.waits.map((w) => w.split("|")[0]);
    expect(waitNames).toEqual(["wait-job:TaskA#0", "wait:Recv#0", "wait-job:TaskA#1", "wait-job:TaskA#1", "wait:Recv#1", "wait-job:TaskA#2"]);
    const jobWaitTypes = h.waits.filter((w) => w.startsWith("wait-job:")).map((w) => w.split("|")[1]);
    expect(new Set(jobWaitTypes).size).toBe(3);

    // Step-name determinism: the memo (= durable step log) holds exactly one
    // occurrence-suffixed entry per applied step, never a duplicate variant.
    const stepNames = [...h.memo.keys()];
    for (const name of ["start:Start#0", "svc-create:TaskA#0", "svc-apply:TaskA#0", "recv:Recv#0", "msg:Recv#0", "svc-create:TaskA#1", "recv:Recv#1", "svc-create:TaskA#2"]) {
      expect(stepNames).toContain(name);
    }
  });
});
