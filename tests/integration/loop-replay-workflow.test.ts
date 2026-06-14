import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createVersion } from "../../src/persistence/definitions";
import { ensureWorkspace } from "../../src/persistence/db";
import { createInstance, getForwardJob, getSubscriptionForVisit, jobCompleteStmt } from "../../src/persistence/instances";
import { insertExternalMessage } from "../../src/persistence/messages";
import { runInstance, type WaitOutcome } from "../../src/runtime/engine";
import { WAKE_TYPE } from "../../src/runtime/wake";
import type { ExecutionGraph } from "../../src/bpmn/graph";

// TASK-32 / TASK-54 — "the walk is the replay" (design M2 §5), under the SINGLE-WAKE
// engine (TASK-54), WORKFLOW mode.
//
// The vitest suite runs EXECUTION_MODE=direct, so the real Cloudflare Workflow path
// is untested project-wide. This harness reproduces the properties the engine relies
// on from step.do, migrated to the single-wake reality:
//
//   1. MEMOIZATION BY STEP NAME persisting across replay invocations of runInstance
//      (a Map shared across calls); already-applied visits ALSO fast-forward
//      WRITE-FREE from canonical D1 state regardless of whether their memo survives.
//   2. The nastier window — a crash AFTER a step's D1 batch committed but BEFORE its
//      result was memoized (Workflows can replay a step whose effects landed) —
//      implemented as run-the-body-then-throw-without-memoizing (`crashAfterCommit`).
//
// SINGLE-WAKE MECHANICS (TASK-54). Leaf drivers NEVER suspend: a parked service task
// emits `svc-park:${tag}` (idempotent re-park) and a parked receive task emits its
// `recv:${tag}` register as the last step. `loop` then issues exactly ONE
// `step.waitForEvent` on the constant `bpmn_wake` type per parked pass, named
// sequentially `wake#k` (the counter RESETS per fresh runInstance call). A wake throw
// is SWALLOWED (self-heal → re-walk), so a run can only END at a step-body crash
// (`crashAfterCommit`) or instance completion — never "suspended at a wait". Each
// scripted wake must advance D1 so the next re-walk progresses; an unscripted wake
// would be swallowed and the re-walk would spin. Messages are recovered via
// APPLY-FROM-D1: the wake correlates an `external_messages` row to the active
// subscription, and the re-walk's `msg:${tag}` step reads it from D1 (no in-flight
// event). NOT simulated: step.do retry-with-backoff on throwing bodies, real CF
// event-type matching/buffering, and the real wake-on-tickle delivery (here a
// scripted handler stands in for "a sendEvent landed and the worker mutated D1").

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
  /** Scripted wake outcomes by wake name (`wake#k`); the handler advances D1. */
  waitScript: Map<string, () => Promise<WaitOutcome>>;
  /** Every wait that was armed: `${name}|${workflowEventType}` (always `wake#k|bpmn_wake`). */
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
    // The single wake. A throw here would be SWALLOWED by issueWake (self-heal), so an
    // unscripted wake must never be issued — every wake the loop issues is scripted to
    // advance D1. The handler's returned outcome is IGNORED by issueWake (the re-walk
    // reconciles from D1); it must merely not throw.
    waitFor: async (sub) => {
      waits.push(`${sub.name}|${sub.workflowEventType}`);
      const handler = waitScript.get(sub.name);
      if (!handler) throw new Error(`unscripted-wake:${sub.name}`);
      waitScript.delete(sub.name);
      return handler();
    },
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

describe("loop replay — workflow-mode single-wake memoization harness", () => {
  it("crash/replay mid-loop is write-free for applied steps, survives the committed-but-unmemoized window (both a message step and a service-task step), and lands on the frontier", async () => {
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

    // A wake that completes TaskA's job at `occ` — the re-walk then applies it.
    const completeJob = (occ: number, output: Record<string, unknown>) => async (): Promise<WaitOutcome> => {
      const job = await getForwardJob(env.DB, instanceId, "TaskA", occ);
      expect(job).toBeTruthy();
      await jobCompleteStmt(env.DB, job!.job_id, output, new Date().toISOString()).run();
      return { kind: "event", payload: {} };
    };
    // A wake that CORRELATES a message into D1 against Recv#occ's active subscription
    // (registered by the `recv:Recv#occ` step that preceded this park). The re-walk's
    // apply-from-D1 path reads it via getCorrelatedMessageForSubscription. The payload
    // merges `{[msg${occ}]: true}`, matching the variable accumulation asserted below.
    const correlateMsg = (occ: number) => async (): Promise<WaitOutcome> => {
      const sub = await getSubscriptionForVisit(env.DB, instanceId, "Recv", occ);
      expect(sub?.status).toBe("active");
      const ts = new Date().toISOString();
      await insertExternalMessage(env.DB, {
        externalMessageId: `em-${ck}-${occ}`,
        workspaceId: "default",
        messageName: MSG,
        correlationKey: ck,
        messageId: `m-${ck}-${occ}`,
        payload: { [`msg${occ}`]: true },
        payloadHash: "h",
        outcome: "correlated",
        finalOutcome: "correlated",
        matchedInstanceId: instanceId,
        matchedSubscriptionId: sub!.subscription_id,
        receivedAt: ts,
        correlatedAt: ts,
      });
      return { kind: "event", payload: {} };
    };

    // ---- run 1: iteration 0 runs fully (job TaskA#0 completes, message Recv#0
    // correlates), then `msg:Recv#0` COMMITS (msg0 merged, subscription consumed,
    // messageCorrelated history) but crashes BEFORE memoizing — the committed-but-
    // unmemoized window on a MESSAGE step.
    h.waitScript.set("wake#0", completeJob(0, { iter0: true }));
    h.waitScript.set("wake#1", correlateMsg(0));
    h.crashAfterCommit.add("msg:Recv#0");
    const run1 = await run();
    expect(run1.ok).toBe(false);
    expect((run1 as { e: string }).e).toContain("crash-after-commit:msg:Recv#0");
    expect(h.executed).toEqual([
      "init",
      "start:Start#0",
      "svc-create:TaskA#0",
      "svc-park:TaskA#0",
      "svc-apply:TaskA#0",
      "recv:Recv#0",
      "msg:Recv#0",
    ]);
    expect((await getForwardJob(env.DB, instanceId, "TaskA", 0))!.output_applied).toBe(1);

    // ---- run 2 (replay, SAME memo): Recv#0's committed-but-unmemoized message
    // fast-forwards WRITE-FREE (the subscription is `consumed` ⇒ pure cursor move, NO
    // `msg:Recv#0` re-run). Iteration 1's job completes, then `svc-apply:TaskA#1`
    // COMMITS (iter1 merged, output_applied=1) and crashes before memoizing — the
    // committed-but-unmemoized window on a SERVICE-TASK step.
    h.executed.length = 0;
    h.waitScript.set("wake#0", completeJob(1, { iter1: true }));
    h.crashAfterCommit.add("svc-apply:TaskA#1");
    const run2 = await run();
    expect(run2.ok).toBe(false);
    expect((run2 as { e: string }).e).toContain("crash-after-commit:svc-apply:TaskA#1");
    // The replay re-ran NO applied step bodies (memoization + D1 fast-forward): only
    // genuinely-new iteration-1 work appears, and Recv#0's `msg` step did NOT re-run.
    expect(h.executed).toEqual(["svc-create:TaskA#1", "svc-park:TaskA#1", "svc-apply:TaskA#1"]);
    expect((await getForwardJob(env.DB, instanceId, "TaskA", 1))!.output_applied).toBe(1);

    // ---- run 3 (replay): everything applied fast-forwards WRITE-FREE — including
    // TaskA#1, whose `svc-apply` memo was LOST in run 2 (the D1 output_applied=1 marker
    // drives the write-free fast-forward, not the memo). Iteration 1's message
    // (Recv#1) correlates + applies; the walk creates the frontier job TaskA#2 and
    // parks — `svc-park:TaskA#2` commits the park then crashes, leaving the live
    // frontier on TaskA#2.
    h.executed.length = 0;
    h.waitScript.set("wake#0", correlateMsg(1));
    h.crashAfterCommit.add("svc-park:TaskA#2");
    const histBefore = await historyCounts(instanceId);
    const run3 = await run();
    expect(run3.ok).toBe(false);
    expect((run3 as { e: string }).e).toContain("crash-after-commit:svc-park:TaskA#2");
    expect(h.executed).toEqual(["recv:Recv#1", "msg:Recv#1", "svc-create:TaskA#2", "svc-park:TaskA#2"]);

    // svc-apply:TaskA#1's committed-but-unmemoized batch was NOT re-applied across the
    // replays: no duplicate serviceTaskCompleted, no variable regression. Likewise
    // msg:Recv#0 correlated exactly once.
    const histAfter = await historyCounts(instanceId);
    expect(histAfter.messageCorrelated).toBe(2);
    expect(histAfter.serviceTaskCompleted).toBe(2);
    expect(histAfter.instanceStarted).toBe(1);
    expect(histAfter.receiveTaskWaiting).toBe(2);
    // The only new bookkeeping in run 3 is iteration 2's job-created (svc-create:TaskA#2);
    // the two applied iterations did not re-emit history.
    expect(histAfter.serviceTaskJobCreated).toBe(3);
    expect((histAfter.serviceTaskJobCreated ?? 0) - (histBefore.serviceTaskJobCreated ?? 0)).toBe(1);

    // Canonical end state: 3 occurrence-keyed jobs (0,1 applied; 2 = frontier),
    // variables accumulated with NO regression.
    const jobs = (
      await env.DB.prepare(
        `SELECT job_id, status, occurrence, output_applied FROM service_task_jobs WHERE instance_id = ? ORDER BY occurrence`,
      )
        .bind(instanceId)
        .all()
    ).results as Array<{ job_id: string; status: string; occurrence: number; output_applied: number }>;
    expect(jobs.map((j) => [j.occurrence, j.status, j.output_applied])).toEqual([
      [0, "completed", 1],
      [1, "completed", 1],
      [2, "created", 0],
    ]);
    expect(new Set(jobs.map((j) => j.job_id)).size).toBe(3);

    const inst = await env.DB.prepare(`SELECT status, variables FROM process_instances WHERE instance_id = ?`)
      .bind(instanceId)
      .first<{ status: string; variables: string }>();
    expect(inst!.status).toBe("waiting"); // parked on the frontier (TaskA#2)
    expect(JSON.parse(inst!.variables)).toMatchObject({ seed: true, iter0: true, iter1: true, msg0: true, msg1: true });

    // Per-occurrence subscriptions: one consumed row per receive visit.
    const subs = (
      await env.DB.prepare(
        `SELECT occurrence, status FROM message_subscriptions WHERE instance_id = ? ORDER BY occurrence`,
      )
        .bind(instanceId)
        .all()
    ).results as Array<{ occurrence: number; status: string }>;
    expect(subs.map((s) => [s.occurrence, s.status])).toEqual([
      [0, "consumed"],
      [1, "consumed"],
    ]);

    // Single-wake contract (TASK-54): every armed wait is the constant `bpmn_wake`,
    // named sequentially per run (`wake#k`, the counter resets each runInstance call).
    // run 1 issued wake#0 (complete TaskA#0) + wake#1 (correlate Recv#0); runs 2 & 3
    // each issued exactly one wake#0. There is exactly ONE event type across the whole
    // execution — the multi-wait fan of per-job `bpmn_job_<id>` types is gone.
    expect(h.waits).toEqual([
      `wake#0|${WAKE_TYPE}`,
      `wake#1|${WAKE_TYPE}`,
      `wake#0|${WAKE_TYPE}`,
      `wake#0|${WAKE_TYPE}`,
    ]);
    expect(new Set(h.waits.map((w) => w.split("|")[1]))).toEqual(new Set([WAKE_TYPE]));

    // Step-name determinism: the memo (= durable step log) holds exactly one
    // occurrence-suffixed entry per applied step, never a duplicate variant.
    const stepNames = [...h.memo.keys()];
    for (const name of [
      "start:Start#0",
      "svc-create:TaskA#0",
      "svc-park:TaskA#0",
      "svc-apply:TaskA#0",
      "recv:Recv#0",
      "svc-create:TaskA#1",
      "svc-park:TaskA#1",
      "recv:Recv#1",
      "msg:Recv#1",
      "svc-create:TaskA#2",
    ]) {
      expect(stepNames).toContain(name);
    }
  });
});
