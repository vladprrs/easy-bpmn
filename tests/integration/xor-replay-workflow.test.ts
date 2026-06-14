import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createVersion } from "../../src/persistence/definitions";
import { ensureWorkspace } from "../../src/persistence/db";
import { createInstance, getForwardJob, jobCompleteStmt } from "../../src/persistence/instances";
import { getGatewayDecision } from "../../src/persistence/gateway-decisions";
import { runInstance, type WaitOutcome } from "../../src/runtime/engine";
import { WAKE_TYPE } from "../../src/runtime/wake";
import type { ExecutionGraph } from "../../src/bpmn/graph";

// TASK-34 / TASK-54 — gateway decision replay, WORKFLOW mode, under the SINGLE-WAKE
// engine (TASK-54). Same memoizing step.do harness as loop-replay-workflow.test.ts:
// step results are memoized BY NAME across replay invocations of runInstance,
// including the committed-but-unmemoized window (the step's dbBatch landed but the
// step result was lost). Already-applied visits also fast-forward WRITE-FREE from D1.
//
// The decision-replay claim under test: a crash at the gateway NEVER re-evaluates —
// the replay re-runs the `gw:el#occ` body, finds the persisted gateway_decisions row,
// and follows the RECORDED branch even though the variables were MUTATED between runs.
//
// SINGLE-WAKE MECHANICS (TASK-54). Leaf drivers PARK rather than suspend: a parked
// service task emits `svc-park:${tag}`; `loop` then issues exactly ONE
// `step.waitForEvent` on the constant `bpmn_wake` type, named `wake#k` (the counter
// resets per fresh runInstance call). A wake throw is swallowed (self-heal), so a run
// ends only at a step-body crash (`crashAfterCommit`) or instance completion; each
// scripted wake advances D1 so the next re-walk progresses. The gateway crash injects
// at the `gw:GW#0` body (not at a wait): its decision row + history + transition
// commit, then it throws before memoizing — the real committed-but-unmemoized window
// the replay-no-re-evaluate claim guards.

function xorGraph(taskHigh: string, taskLow: string): ExecutionGraph {
  return {
    processId: "P_gw_replay",
    startElementId: "Start",
    endElementIds: ["End"],
    elements: [],
    nodes: {
      Start: {
        type: "startEvent",
        next: "GW",
        outgoing: [{ flowId: "f0", targetId: "GW", conditionExpression: null, isDefault: false }],
      },
      GW: {
        type: "exclusiveGateway",
        next: null,
        outgoing: [
          { flowId: "f_high", targetId: "TaskHigh", conditionExpression: "amount > 100", isDefault: false },
          { flowId: "f_low", targetId: "TaskLow", conditionExpression: null, isDefault: true },
        ],
      },
      TaskHigh: {
        type: "serviceTask",
        taskType: taskHigh,
        retries: 1,
        next: "End",
        outgoing: [{ flowId: "f1", targetId: "End", conditionExpression: null, isDefault: false }],
      },
      TaskLow: {
        type: "serviceTask",
        taskType: taskLow,
        retries: 1,
        next: "End",
        outgoing: [{ flowId: "f2", targetId: "End", conditionExpression: null, isDefault: false }],
      },
      End: { type: "endEvent", next: null, outgoing: [], endKind: "none" },
    },
  };
}

interface Harness {
  memo: Map<string, unknown>;
  executed: string[];
  crashAfterCommit: Set<string>;
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
    // The single wake. A throw here would be swallowed by issueWake (self-heal), so an
    // unscripted wake must never be issued; every issued wake is scripted to advance
    // D1. The returned outcome is ignored by issueWake (the re-walk reconciles D1).
    waitFor: async (sub) => {
      waits.push(`${sub.name}|${sub.workflowEventType}`);
      const handler = waitScript.get(sub.name);
      if (!handler) throw new Error(`unscripted-wake:${sub.name}`);
      waitScript.delete(sub.name);
      return handler();
    },
  };
}

describe("gateway decision replay — workflow-mode single-wake memoization harness", () => {
  it("crash after the decision committed (memo lost) + variables mutated → the replay keeps the recorded branch", async () => {
    const taskHigh = `gw-high-${crypto.randomUUID()}`;
    const taskLow = `gw-low-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await ensureWorkspace(env.DB, "default", now);
    const versionId = `pdv_gwwf_${crypto.randomUUID()}`;
    await createVersion(env.DB, {
      definitionVersionId: versionId,
      draftId: `draft_gwwf_${crypto.randomUUID()}`,
      workspaceId: "default",
      versionNumber: 1,
      bpmnXml: "<!-- engine-harness-only gateway graph -->",
      bpmnXmlHash: `hash_${crypto.randomUUID()}`,
      graph: xorGraph(taskHigh, taskLow),
      now,
    });
    const instanceId = `pi_gwwf_${crypto.randomUUID()}`;
    await createInstance(env.DB, {
      instanceId,
      workspaceId: "default",
      definitionVersionId: versionId,
      workflowInstanceId: instanceId,
      correlationKey: `gwwf-${crypto.randomUUID()}`,
      startElementId: "Start",
      variables: { amount: 500 }, // → f_high at the live evaluation
      now,
    });

    const h = makeHarness();
    const run = () =>
      runInstance(env, instanceId, { runStep: h.runStep, waitFor: h.waitFor }).then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e: String(e) }),
      );

    // ---- run 1: the gateway step's dbBatch COMMITS (decision row + history +
    // transition), then crashes BEFORE memoizing the step result. The crash injects at
    // the STEP BODY (`gw:GW#0`) — the real committed-but-unmemoized window; there is no
    // wait to crash at. No wake is issued (the run ends inside the first re-walk).
    h.crashAfterCommit.add("gw:GW#0");
    const run1 = await run();
    expect(run1.ok).toBe(false);
    expect((run1 as { e: string }).e).toContain("crash-after-commit:gw:GW#0");
    expect(h.executed).toEqual(["init", "start:Start#0", "gw:GW#0"]);
    expect(h.waits).toEqual([]); // crashed before any park → no wake
    const committed = await getGatewayDecision(env.DB, instanceId, "GW", 0);
    expect(committed!.chosenFlowId).toBe("f_high");

    // ---- mutate the variables so a RE-evaluation would now take f_low.
    await env.DB.prepare(`UPDATE process_instances SET variables = ? WHERE instance_id = ?`)
      .bind(JSON.stringify({ amount: 5 }), instanceId)
      .run();

    // ---- run 2 (replay, SAME memo): gw:GW#0's memo was lost, so its body re-runs — it
    // finds the persisted decision and follows the RECORDED branch (f_high) with zero
    // writes; the walk creates TaskHigh's job and parks. The single wake completes the
    // job, the re-walk applies it, and the instance finishes down the recorded branch.
    // TaskLow NEVER ran. (The whole run lands on completion in this one invocation —
    // the single-wake engine drives across parks via wakes rather than per-wait runs.)
    h.executed.length = 0;
    h.waitScript.set("wake#0", async () => {
      const job = await getForwardJob(env.DB, instanceId, "TaskHigh", 0);
      expect(job).toBeTruthy();
      await jobCompleteStmt(env.DB, job!.job_id, { handled: "high" }, new Date().toISOString()).run();
      return { kind: "event", payload: {} };
    });
    const run2 = await run();
    expect(run2.ok).toBe(true);
    expect((run2 as { r: { status: string } }).r).toEqual({ status: "completed" });
    expect(h.executed).toEqual([
      "gw:GW#0", // re-runs the body (memo lost) but follows the recorded branch WRITE-FREE
      "svc-create:TaskHigh#0",
      "svc-park:TaskHigh#0",
      "svc-apply:TaskHigh#0",
      "end:End#0",
    ]);
    // Single-wake contract: exactly one `bpmn_wake` (TaskHigh's completion tickle).
    expect(h.waits).toEqual([`wake#0|${WAKE_TYPE}`]);
    expect(new Set(h.waits.map((w) => w.split("|")[1]))).toEqual(new Set([WAKE_TYPE]));

    // Recorded decision untouched: same row, same branch, original snapshot — the
    // re-run never re-evaluated against the mutated {amount:5}.
    const after = await getGatewayDecision(env.DB, instanceId, "GW", 0);
    expect(after!.decisionId).toBe(committed!.decisionId);
    expect(after!.chosenFlowId).toBe("f_high");
    expect(after!.variablesSnapshot).toEqual({ amount: 500 });
    // Exactly ONE decision event despite the body re-run (write-free replay).
    const events = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM history_events WHERE instance_id = ? AND type = 'gatewayDecisionEvaluated'`,
    )
      .bind(instanceId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);

    // TaskLow NEVER ran — only TaskHigh's job exists; instance completed; final
    // variables carry the mutated amount + TaskHigh's output.
    const jobs = await env.DB.prepare(`SELECT element_id FROM service_task_jobs WHERE instance_id = ?`)
      .bind(instanceId)
      .all<{ element_id: string }>();
    expect((jobs.results ?? []).map((j) => j.element_id)).toEqual(["TaskHigh"]);
    const inst = await env.DB.prepare(`SELECT status, variables FROM process_instances WHERE instance_id = ?`)
      .bind(instanceId)
      .first<{ status: string; variables: string }>();
    expect(inst!.status).toBe("completed");
    expect(JSON.parse(inst!.variables)).toMatchObject({ amount: 5, handled: "high" });
  });
});
