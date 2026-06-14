import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createVersion } from "../../src/persistence/definitions";
import { ensureWorkspace } from "../../src/persistence/db";
import { createInstance, getCompensationJob, getForwardJob, jobCompleteStmt } from "../../src/persistence/instances";
import { runInstance, type WaitOutcome } from "../../src/runtime/engine";
import { WAKE_TYPE } from "../../src/runtime/wake";
import type { Env } from "../../src/env";
import type { ExecutionGraph } from "../../src/bpmn/graph";

// TASK-54 — single-wake REVERSE (compensation) pass, WORKFLOW mode. The CI guard for
// the workflow-mode-only regression where the reverse pass busy-spun on a created comp
// job (it never suspended, so the external worker could never complete it) — multi-step
// compensation stalled after the first comp step on real Cloudflare Workflows. The
// vitest suite runs EXECUTION_MODE=direct, where `if (!waitFor) return "waiting"` parks
// cleanly, so this path is INVISIBLE to every direct-mode compensation test
// (loop-compensation, parallel-compensation, saga-*). This harness drives the REAL
// runInstance → settleAfterCompensation → runCompensation path in simulated workflow
// mode (a mock `waitFor` + memoizing `runStep`, exactly like loop-replay-workflow.test.ts
// / xor-replay-workflow.test.ts), over a transaction that cancels with TWO compensatable
// steps, and asserts the reverse pass suspends ONE `comp-wake#k` between comp steps
// instead of busy-spinning.
//
// SINGLE-WAKE MECHANICS (TASK-54). Leaf drivers NEVER suspend. The FORWARD loop issues
// `wake#k`; the REVERSE pass issues `comp-wake#k` (a distinct prefix, distinct counter,
// each resets per invocation). A wake throw is SWALLOWED (self-heal → re-walk), so each
// scripted wake must advance D1: a forward wake completes that step's FORWARD job, a
// comp wake completes that step's COMPENSATION job. The whole forward+cancel+compensate
// drive lands terminal in ONE runInstance invocation (the single-wake engine drives
// across parks via wakes rather than per-wait runs).
//
// BUSY-SPIN GUARD. Without the fix the reverse pass loops forever re-reading the created
// comp job via selectScopeStepsForCompensation / getCompensationJob (D1 reads) and NEVER
// calls `waitFor` — a runStep/waitFor counter cannot catch it. So the spin guard caps
// `env.DB.prepare` calls made by the drive (a Proxy over the binding): the infinite spin
// hammers `prepare` and trips the cap with a CLEAN "busy-spin detected" throw rather than
// hanging the suite, while the bounded legit drive stays far below it.

const SPIN_CAP = 4000; // legit 2-step forward+comp drive uses a few hundred prepares; an infinite spin trips this immediately.

/** Wrap an Env so every `DB.prepare` issued by the drive is counted; throw past `cap`. */
function spinGuardedEnv(real: Env, cap: number): { env: Env; prepareCount: () => number } {
  let n = 0;
  const dbProxy = new Proxy(real.DB, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (query: string) => {
          n += 1;
          if (n > cap) throw new Error(`busy-spin detected: >${cap} DB.prepare calls in a single drive`);
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  const envProxy = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "DB") return dbProxy;
      return Reflect.get(target, prop, receiver);
    },
  }) as Env;
  return { env: envProxy, prepareCount: () => n };
}

/**
 * Start → Tx{ innerStart → reserve → charge → cancelEnd } with a cancel boundary on Tx
 * → Failed. reserve + charge are compensatable (releaseReserve / releaseCharge handlers).
 * The forward token reaches the inner CANCEL end → beginCompensating → reverse pass over
 * the 2-step ledger.
 */
function sagaGraph(reserveType: string, chargeType: string, relReserveType: string, relChargeType: string): ExecutionGraph {
  return {
    processId: "P_comp",
    startElementId: "Start",
    endElementIds: ["Failed"],
    elements: [],
    transactions: {
      Tx: {
        transactionId: "Tx",
        startId: "innerStart",
        childIds: ["innerStart", "reserve", "charge", "cancelEnd"],
        endIds: ["cancelEnd"],
        compensations: {
          reserve: { handlerId: "releaseReserve", boundaryId: "bReserve" },
          charge: { handlerId: "releaseCharge", boundaryId: "bCharge" },
        },
      },
    },
    nodes: {
      Start: {
        type: "startEvent",
        next: "Tx",
        outgoing: [{ flowId: "f0", targetId: "Tx", conditionExpression: null, isDefault: false }],
      },
      Tx: {
        type: "transaction",
        next: "Done", // outer flow after a (never-taken) commit; the cancel path exits via the boundary
        outgoing: [{ flowId: "fTx", targetId: "Done", conditionExpression: null, isDefault: false }],
      },
      innerStart: {
        type: "startEvent",
        scopeId: "Tx",
        next: "reserve",
        outgoing: [{ flowId: "f1", targetId: "reserve", conditionExpression: null, isDefault: false }],
      },
      reserve: {
        type: "serviceTask",
        scopeId: "Tx",
        taskType: reserveType,
        retries: 1,
        next: "charge",
        outgoing: [{ flowId: "f2", targetId: "charge", conditionExpression: null, isDefault: false }],
      },
      charge: {
        type: "serviceTask",
        scopeId: "Tx",
        taskType: chargeType,
        retries: 1,
        next: "cancelEnd",
        outgoing: [{ flowId: "f3", targetId: "cancelEnd", conditionExpression: null, isDefault: false }],
      },
      cancelEnd: { type: "endEvent", scopeId: "Tx", endKind: "cancel", next: null, outgoing: [] },
      cancelBoundary: {
        type: "boundaryEvent",
        boundaryKind: "cancel",
        attachedToRef: "Tx",
        next: "Failed",
        outgoing: [{ flowId: "fb", targetId: "Failed", conditionExpression: null, isDefault: false }],
      },
      Failed: { type: "endEvent", endKind: "none", next: null, outgoing: [] },
      Done: { type: "endEvent", endKind: "none", next: null, outgoing: [] },
      releaseReserve: { type: "serviceTask", isForCompensation: true, taskType: relReserveType, retries: 1, next: null, outgoing: [] },
      releaseCharge: { type: "serviceTask", isForCompensation: true, taskType: relChargeType, retries: 1, next: null, outgoing: [] },
    },
  };
}

interface Harness {
  memo: Map<string, unknown>;
  waitScript: Map<string, () => Promise<WaitOutcome>>;
  /** Every wait that was armed, in order: `${name}|${workflowEventType}`. */
  waits: string[];
  runStep: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  waitFor: (sub: { name: string; workflowEventType: string; timeout: string }) => Promise<WaitOutcome>;
}

function makeHarness(): Harness {
  const memo = new Map<string, unknown>();
  const waitScript = new Map<string, () => Promise<WaitOutcome>>();
  const waits: string[] = [];
  return {
    memo,
    waitScript,
    waits,
    runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (memo.has(name)) return memo.get(name) as T; // step.do replay
      const result = await fn();
      memo.set(name, result);
      return result;
    },
    // The single wake. A throw here is SWALLOWED by the engine's issueWake / the comp-pass
    // catch (self-heal), so an unscripted wake must never be issued — every wake the engine
    // issues is scripted to advance D1. The returned outcome is IGNORED (the re-walk
    // reconciles from D1); the handler must merely not throw.
    waitFor: async (sub) => {
      waits.push(`${sub.name}|${sub.workflowEventType}`);
      const handler = waitScript.get(sub.name);
      if (!handler) throw new Error(`unscripted-wake:${sub.name}`);
      waitScript.delete(sub.name);
      return handler();
    },
  };
}

async function ledgerRows(instanceId: string) {
  const res = await env.DB.prepare(
    `SELECT element_id, seq, occurrence, compensation_status FROM saga_steps WHERE instance_id = ? ORDER BY seq`,
  )
    .bind(instanceId)
    .all<{ element_id: string; seq: number; occurrence: number; compensation_status: string }>();
  return res.results ?? [];
}

async function compJobRows(instanceId: string) {
  const res = await env.DB.prepare(
    `SELECT element_id, status FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 1 ORDER BY element_id`,
  )
    .bind(instanceId)
    .all<{ element_id: string; status: string }>();
  return res.results ?? [];
}

describe("compensation replay — workflow-mode single-wake reverse pass", () => {
  it("multi-step compensation suspends ONE comp-wake per pending step and reaches 'compensated' (no busy-spin)", async () => {
    const reserveType = `wf-reserve-${crypto.randomUUID()}`;
    const chargeType = `wf-charge-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await ensureWorkspace(env.DB, "default", now);
    const versionId = `pdv_comp_${crypto.randomUUID()}`;
    await createVersion(env.DB, {
      definitionVersionId: versionId,
      draftId: `draft_comp_${crypto.randomUUID()}`,
      workspaceId: "default",
      versionNumber: 1,
      bpmnXml: "<!-- engine-harness-only saga graph -->",
      bpmnXmlHash: `hash_${crypto.randomUUID()}`,
      graph: sagaGraph(reserveType, chargeType, `wf-rel-reserve-${crypto.randomUUID()}`, `wf-rel-charge-${crypto.randomUUID()}`),
      now,
    });
    const instanceId = `pi_comp_${crypto.randomUUID()}`;
    await createInstance(env.DB, {
      instanceId,
      workspaceId: "default",
      definitionVersionId: versionId,
      workflowInstanceId: instanceId,
      correlationKey: `comp-${crypto.randomUUID()}`,
      startElementId: "Start",
      variables: { sku: "tee" },
      now,
    });

    const h = makeHarness();
    const guard = spinGuardedEnv(env as Env, SPIN_CAP);

    // FORWARD wakes complete the forward jobs (the external worker tickle): reserve then
    // charge, each ledgered as a compensatable step. After charge the token reaches the
    // inner CANCEL end → compensation. The handlers run against the REAL env (out-of-band
    // worker mutation), so they are NOT counted by the spin guard.
    const completeForwardJob = (elementId: string, occ: number, output: Record<string, unknown>) => async (): Promise<WaitOutcome> => {
      const job = await getForwardJob(env.DB, instanceId, elementId, occ);
      expect(job).toBeTruthy();
      await jobCompleteStmt(env.DB, job!.job_id, output, new Date().toISOString()).run();
      return { kind: "event", payload: {} };
    };
    // COMP wakes complete the compensation jobs: the reverse pass compensates the highest
    // seq first (charge), then reserve.
    const completeCompJob = (elementId: string, occ: number, output: Record<string, unknown>) => async (): Promise<WaitOutcome> => {
      const job = await getCompensationJob(env.DB, instanceId, elementId, occ);
      expect(job).toBeTruthy();
      await jobCompleteStmt(env.DB, job!.job_id, output, new Date().toISOString()).run();
      return { kind: "event", payload: {} };
    };

    h.waitScript.set("wake#0", completeForwardJob("reserve", 0, { reserved: true }));
    h.waitScript.set("wake#1", completeForwardJob("charge", 0, { charged: true }));
    h.waitScript.set("comp-wake#0", completeCompJob("charge", 0, { releasedCharge: true }));
    h.waitScript.set("comp-wake#1", completeCompJob("reserve", 0, { releasedReserve: true }));

    const result = await runInstance(guard.env, instanceId, { runStep: h.runStep, waitFor: h.waitFor });

    // The whole forward → cancel → reverse-pass drive lands on the saga-failed terminal
    // in one invocation.
    expect(result).toEqual({ status: "completed" });

    // (1) The reverse pass SUSPENDED exactly one `comp-wake#k` per pending comp step
    // (2 compensatable steps → comp-wake#0 + comp-wake#1) — it never busy-spun. Distinct
    // sequential names on the constant WAKE_TYPE; the forward loop's wakes use the `wake#`
    // prefix (no step-name collision across the forward→compensate drive).
    const compWaits = h.waits.filter((w) => w.startsWith("comp-wake#"));
    expect(compWaits).toEqual([`comp-wake#0|${WAKE_TYPE}`, `comp-wake#1|${WAKE_TYPE}`]);
    expect(h.waits).toEqual([
      `wake#0|${WAKE_TYPE}`,
      `wake#1|${WAKE_TYPE}`,
      `comp-wake#0|${WAKE_TYPE}`,
      `comp-wake#1|${WAKE_TYPE}`,
    ]);
    expect(new Set(h.waits.map((w) => w.split("|")[1]))).toEqual(new Set([WAKE_TYPE]));

    // (2) Both ledger steps reached the COMPENSATED terminal, two comp jobs completed,
    // and the instance settled 'compensated' at the cancel boundary's failure target.
    expect((await ledgerRows(instanceId)).map((r) => [r.element_id, r.compensation_status])).toEqual([
      ["reserve", "compensated"],
      ["charge", "compensated"],
    ]);
    expect(await compJobRows(instanceId)).toEqual([
      { element_id: "charge", status: "completed" },
      { element_id: "reserve", status: "completed" },
    ]);
    const inst = await env.DB.prepare(`SELECT status, current_element_id FROM process_instances WHERE instance_id = ?`)
      .bind(instanceId)
      .first<{ status: string; current_element_id: string }>();
    expect(inst!.status).toBe("compensated");
    expect(inst!.current_element_id).toBe("Failed");

    // (3) The legit drive stayed far below the busy-spin cap (sanity that the guard is a
    // ceiling, not a near-miss): without the single-wake fix this same run loops forever
    // re-reading the created comp job and trips `busy-spin detected` instead.
    expect(guard.prepareCount()).toBeLessThan(SPIN_CAP);
  });
});
