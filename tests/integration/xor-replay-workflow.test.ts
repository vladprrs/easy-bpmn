import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createVersion } from "../../src/persistence/definitions";
import { ensureWorkspace } from "../../src/persistence/db";
import { createInstance, getForwardJob, jobCompleteStmt } from "../../src/persistence/instances";
import { getGatewayDecision } from "../../src/persistence/gateway-decisions";
import { runInstance, type WaitOutcome } from "../../src/runtime/engine";
import type { ExecutionGraph } from "../../src/bpmn/graph";

// TASK-34 — gateway decision replay, WORKFLOW mode (memoizing step.do harness,
// same contract simulation as loop-replay-workflow.test.ts): step results are
// memoized BY NAME across crash/replay invocations of runInstance, including
// the nastier committed-but-unmemoized window (the step's dbBatch landed but
// the step result was lost). The decision-replay claim under test: a crash at
// the gateway NEVER re-evaluates — the replay re-runs the `gw:el#occ` body,
// finds the persisted gateway_decisions row, and follows the RECORDED branch
// even though the variables were MUTATED between the runs.

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
  runStep: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  waitFor: (sub: { name: string; workflowEventType: string; timeout: string }) => Promise<WaitOutcome>;
}

function makeHarness(): Harness {
  const memo = new Map<string, unknown>();
  const executed: string[] = [];
  const crashAfterCommit = new Set<string>();
  const waitScript = new Map<string, () => Promise<WaitOutcome>>();
  return {
    memo,
    executed,
    crashAfterCommit,
    waitScript,
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
      const handler = waitScript.get(sub.name);
      if (!handler) throw new Error(`crash-at-wait:${sub.name}`);
      waitScript.delete(sub.name);
      return handler();
    },
  };
}

describe("gateway decision replay — workflow-mode memoization harness", () => {
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
    // transition), then the Workflow crashes BEFORE memoizing the step result.
    h.crashAfterCommit.add("gw:GW#0");
    const run1 = await run();
    expect(run1.ok).toBe(false);
    expect((run1 as any).e).toContain("crash-after-commit:gw:GW#0");
    expect(h.executed).toEqual(["init", "start:Start#0", "gw:GW#0"]);
    const committed = await getGatewayDecision(env.DB, instanceId, "GW", 0);
    expect(committed!.chosenFlowId).toBe("f_high");

    // ---- mutate the variables so a RE-evaluation would now take f_low.
    await env.DB.prepare(`UPDATE process_instances SET variables = ? WHERE instance_id = ?`)
      .bind(JSON.stringify({ amount: 5 }), instanceId)
      .run();

    // ---- run 2 (replay, SAME memo): gw:GW#0's memo was lost, so its body
    // re-runs — it finds the persisted decision and follows the RECORDED
    // branch (f_high) with zero writes; the walk then creates TaskHigh's job
    // and crashes suspended at its wait.
    h.executed.length = 0;
    const run2 = await run();
    expect(run2.ok).toBe(false);
    expect((run2 as any).e).toContain("crash-at-wait:wait-job:TaskHigh#0");
    expect(h.executed).toEqual(["gw:GW#0", "svc-create:TaskHigh#0"]);

    // Recorded decision untouched: same row, same branch, original snapshot.
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

    // ---- run 3 (replay): complete TaskHigh's job at the scripted wait → the
    // instance finishes down the recorded branch; TaskLow NEVER ran.
    h.waitScript.set("wait-job:TaskHigh#0", async () => {
      const job = await getForwardJob(env.DB, instanceId, "TaskHigh", 0);
      expect(job).toBeTruthy();
      await jobCompleteStmt(env.DB, job!.job_id, { handled: "high" }, new Date().toISOString()).run();
      return { kind: "event", payload: {} };
    });
    h.executed.length = 0;
    const run3 = await run();
    expect(run3.ok).toBe(true);
    expect((run3 as any).r).toEqual({ status: "completed" });
    expect(h.executed).toEqual(["svc-apply:TaskHigh#0", "end:End#0"]);

    const jobs = await env.DB.prepare(
      `SELECT element_id FROM service_task_jobs WHERE instance_id = ?`,
    )
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
