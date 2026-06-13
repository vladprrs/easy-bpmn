// The easy-bpmn execution engine — the single source of orchestration truth.
//
// M1 evolves it from a linear scalar-cursor interpreter into a SCOPE-AWARE one:
//   - Service Tasks are durable PULL waits (a leasable job + step.waitForEvent on
//     `bpmn_job_<jobId>`); a remote worker leases, runs, then complete/fail.
//   - A `transaction` is a saga scope; completed compensatable steps are appended
//     to the saga ledger atomically with advance.
//   - A business error (worker fail with an errorCode matching an error boundary)
//     routes the single token to a cancel end event, which CANCELS the
//     transaction → reverse-order compensation of the ledger → the cancel
//     boundary's failure path. An uncaught/technical exhaustion is a Hazard →
//     terminal incident (never auto-compensation).
//
// M2 (TASK-32) makes the walk CYCLE-CAPABLE — "the walk is the replay":
//   - Every drive RE-WALKS the graph from the start element. A walk-local,
//     IN-MEMORY visit counter assigns each visit of an element an OCCURRENCE
//     (0-based). Occurrence is NEVER derived from live D1 row counts — during a
//     Workflow replay those reads see post-crash state and would desynchronize
//     step names from the original execution.
//   - Every step name and persistence key carries the occurrence
//     (`svc-create:el#2`, `wait-job:el#2`, `msg:el#1`, …); jobs / saga-ledger
//     rows / message subscriptions are keyed per (element, occurrence).
//   - Already-applied visits FAST-FORWARD WRITE-FREE from canonical D1 state:
//     a completed job with output_applied=1 (or a failed one whose business
//     error was routed), a consumed subscription, or a bookkeeping node whose
//     per-visit history event landed are pure in-memory cursor moves. The
//     applied marker is set in the SAME dbBatch as the advance, so the
//     crash window between a worker completion and its apply resumes exactly
//     once (re-applying would re-merge an old iteration's output over newer
//     variables, rewrite the cursor backwards, and duplicate history).
//
// M2 (TASK-34) adds exclusiveGateway dispatch: one persisted step per visit
// (`gw:el#occ`) evaluates non-default outgoing FEEL conditions in DOCUMENT
// ORDER (first true wins → else default → else terminal noPath incident) and
// commits the gateway_decisions row + transition + history event in ONE
// dbBatch. An existing decision row for (instance, gateway, occurrence) is the
// rewalk/replay fast-forward predicate — the recorded branch is reused, never
// re-evaluated, even if variables changed since.
//
// Both drivers share this code: the Workflow suspends/resumes in place across
// `waitFor` (step.do memoization fast-forwards replays by step NAME); the
// deterministic DirectExecutor parks (waitFor=null) and resumes by re-running
// the same rewalk — the instance status + the ledger are re-derived from D1
// each time, so direct-mode resume and crash recovery are the same path.
// D1 is canonical.
//
// M3 (TASK-38, L0) extracts the cohesive node-kind blocks into sibling modules —
// forward-task.ts (forward Service Task visit), compensation.ts (reverse pass),
// incidents.ts (terminal/park/incident writes) — plus engine-shared.ts (shared
// types + loadInst/isTransactionScope). This file is the walk/dispatch core: the
// rewalk loop, the bookkeeping nodes (start / tx enter / commit), the exclusive
// gateway, and the Receive Task wait. Behavior-frozen — the extraction changed
// no step name, history event type, persisted shape, or API response.

import type { Env } from "../env";
import type { MessageEventPayload } from "../contracts/workflow-events";
import type { ExecutionGraph, Flow, GraphNode, NodeType } from "../bpmn/graph";
import { workflowEventTypeFor } from "../bpmn/profile";
import { ExpressionEvaluationError, evaluateCondition, normalizeFeelValue } from "./expressions";
import { brokerKeyOf, type RegisterSubscriptionResult } from "./broker-types";
import { MAX_EVENT_PAYLOAD_BYTES, payloadByteSize } from "./payload";
import {
  ONE_HOUR_MS,
  isoPlusMs,
  isTerminalInstanceStatus,
  mergeVariables,
  newId,
  nowIso,
  parseJson,
  traceIdFor,
  type JsonObject,
} from "../util";
import { getVersionGraph } from "../persistence/definitions";
import { dbBatch } from "../persistence/db";
import { hasHistoryMarkerForOccurrence, historyStmt } from "../persistence/history";
import {
  applyTransitionStmt,
  createSubscription,
  getSubscriptionForVisit,
  subscriptionConsumedStmt,
  variableSnapshotStmt,
} from "../persistence/instances";
import { markScopeStepsCommittedStmt } from "../persistence/saga";
import { messageCorrelatedStmt } from "../persistence/messages";
import {
  getGatewayDecision,
  insertGatewayDecisionStmt,
  type GatewayFlowEvaluation,
} from "../persistence/gateway-decisions";
import {
  loadInst,
  isTransactionScope,
  SVC_WAIT_TIMEOUT,
  type RunStep,
  type WaitForEvent,
  type DriveResult,
} from "./engine-shared";
import { createIncident, completeInstance, recordTerminalIncident, raiseConcurrencyLimit as raiseConcurrencyLimitIncident, raiseStepBudget as raiseStepBudgetIncident } from "./incidents";
import {
  reconstructFrontier,
  syncFrontierReadModel,
  resolveScope,
  driveFrontier,
  raceParkedWaits,
  matchKeyedEvent,
  WaitCollector,
  type DriveCaps,
  type LeafDrivers,
  type LeafOutcome,
} from "./frontier";
import { completeInstanceGuarded } from "../persistence/instances";
import { branchHistoryTags, listLiveTokens, setTokenStatusStmt, rootTokenId, getToken, parseOverlay, readOverlay, setTokenOverlayStmt, writeOverlay } from "../persistence/tokens";
import { withDriveLock } from "../persistence/drive-lock";
import { driveForwardServiceTask, terminateUnleasableJob } from "./forward-task";
import { beginCompensating, settleAfterCompensation } from "./compensation";
import {
  armTimerDO,
  buildBoundaryArm,
  buildBoundaryCancelSettle,
  convertOnFire,
  settleOverdueBoundaryTimerOnWake,
  timerBoundaryFor,
  timerGuardedTimeout,
  timerHasFired,
} from "./boundary-timer";
import { getTimer, timerIdFor } from "../persistence/timers";
import { driveIntermediateCatch } from "./intermediate-timer";
import { driveEventBasedGateway } from "./event-gateway";

// Public surface (M3-L0): the node-kind blocks moved to sibling modules, but the
// engine.ts import path stays the stable façade for every dependent — re-export
// the shared types and the relocated public helpers so callers need NO edits.
export type { RunStep, WaitOutcome, WaitForEvent, DriveStatus, DriveResult } from "./engine-shared";
export { recordTerminalIncident, terminateUnleasableJob };
export { workflowEventTypeFor };

interface RunOptions {
  runStep: RunStep;
  waitFor: WaitForEvent | null;
  /**
   * @deprecated TASK-32: the engine ALWAYS re-walks from the start element
   * ("the walk is the replay") and fast-forwards write-free through applied
   * steps, so a resume hint is advisory at best and ignored. Kept so existing
   * callers (executor resume paths) keep compiling without behavior change.
   */
  startAt?: string;
  incomingEvent?: MessageEventPayload;
}

/**
 * Loop-iteration cap (design M2 §5): a walk that would visit the same element
 * id more than this many times settles a terminal `loopLimit` incident instead
 * of spinning (and bounds the Workflow step budget — the cap-vs-platform-budget
 * math lives next to the workflows config in wrangler.jsonc, R-M2-5). The cap
 * counts walk-local VISITS per element, never lease attempts: technical
 * retries of one iteration share one occurrence and do not consume it.
 */
export const MAX_ELEMENT_OCCURRENCES = 1000;

/**
 * Live-token frontier cap (M4 design §9). Caps execution_tokens in a LIVE status
 * (active|waiting|arrivedAtJoin); counted from the in-memory reconstructed
 * frontier during the rewalk (NEVER a live COUNT — that would fire
 * nondeterministically on replay). Exceeding it at a split fan-out settles a
 * terminal `concurrencyLimit` incident, so a runaway fan-out (nested splits, or a
 * split inside a loop accumulating un-merged tokens) degrades into a graceful,
 * operator-visible incident instead of an opaque errored Workflow.
 */
export const MAX_CONCURRENT_TOKENS = 256;

/**
 * Soft step budget (M4 design §9). The engine maintains a per-drive cumulative
 * runStep/waitForEvent counter; crossing this settles a graceful `stepBudget`
 * incident BELOW the platform ceiling (wrangler workflows limits.steps = 25000),
 * so a hot parallel×loop shape never becomes an opaque errored Workflow. Forward
 * steps of all live tokens, in-region loops, and the reverse-compensation pass
 * must jointly fit; the three caps (MAX_CONCURRENT_TOKENS, MAX_ELEMENT_OCCURRENCES,
 * step budget) enforce this together.
 */
export const STEP_BUDGET_SOFT = 20000;

/**
 * TEST-ONLY cap overrides (design §9 / L6.1). Integration tests lower a cap via an
 * env var so a bomb fixture trips it without 256 real branches / 20000 real steps;
 * production never sets these (the `Env` fields are optional + test-only). A
 * non-positive / non-numeric value falls back to the production constant.
 */
function maxConcurrentTokens(env: Env): number {
  const o = Number((env as { MAX_CONCURRENT_TOKENS_OVERRIDE?: string }).MAX_CONCURRENT_TOKENS_OVERRIDE);
  return Number.isFinite(o) && o > 0 ? o : MAX_CONCURRENT_TOKENS;
}
function stepBudgetSoft(env: Env): number {
  const o = Number((env as { STEP_BUDGET_SOFT_OVERRIDE?: string }).STEP_BUDGET_SOFT_OVERRIDE);
  return Number.isFinite(o) && o > 0 ? o : STEP_BUDGET_SOFT;
}

/**
 * Walk-local visit counter (design M2 §5). Returns the 0-based occurrence of
 * this visit and bumps the in-memory counter. Deliberately NOT derived from D1.
 */
function nextOccurrence(visits: Map<string, number>, elementId: string): number {
  const occ = visits.get(elementId) ?? 0;
  visits.set(elementId, occ + 1);
  return occ;
}

export async function loadGraphForInstance(env: Env, instanceId: string): Promise<ExecutionGraph> {
  const inst = await loadInst(env, instanceId);
  const graph = await getVersionGraph(env.DB, inst.definition_version_id);
  if (!graph) throw new Error(`Definition version ${inst.definition_version_id} has no parsed profile`);
  return graph;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runInstance(env: Env, instanceId: string, opts: RunOptions): Promise<DriveResult> {
  // Direct-mode drives (waitFor === null: the CI harness + production inline-resume)
  // can race saga_steps.seq when concurrent worker callbacks drive one instance at
  // once; serialise them with a per-instance advisory lock (design §10). Workflow
  // mode (a real waitFor) is already serialised by the single Workflow instance, so
  // leave it unwrapped.
  if (opts.waitFor === null) {
    return withDriveLock(env.DB, instanceId, () => runInstanceInner(env, instanceId, opts));
  }
  return runInstanceInner(env, instanceId, opts);
}

async function runInstanceInner(env: Env, instanceId: string, opts: RunOptions): Promise<DriveResult> {
  const graph = await opts.runStep("init", () => loadGraphForInstance(env, instanceId));
  const inst = await loadInst(env, instanceId);

  // Resume into the reverse compensation pass (direct-mode resume / crash recovery):
  // the cursor is re-derived from the ledger + the current (cancel-end) element.
  if (inst.status === "compensating") {
    const scopeId = graph.nodes[inst.current_element_id ?? ""]?.scopeId ?? null;
    if (!scopeId) return { status: "completed" };
    return settleAfterCompensation(env, instanceId, graph, scopeId, opts.runStep, opts.waitFor);
  }
  if (isTerminalInstanceStatus(inst.status)) return { status: "completed" };

  // "The walk is the replay" (TASK-32): ALWAYS re-walk from the start element,
  // in both modes — opts.startAt is ignored. Applied steps fast-forward
  // write-free from canonical D1 state; the walk lands on the live frontier.
  const result = await loop(env, instanceId, graph, opts.runStep, opts.waitFor, opts.incomingEvent);
  // M4-L2: refresh the single-token read-model from the settled cursor. GATED on
  // !graph.regions (design refinement): a region graph's frontier is owned by the
  // DFS (fanOutSplit / claimJoinCompletion write the token rows directly), and the
  // single-token reconstruct would wrongly mark live branch tokens 'consumed'.
  // Best-effort + non-fatal — it never blocks the drive.
  if (!graph.regions) {
    try {
      await syncFrontierReadModel(env, instanceId, await reconstructFrontier(env, graph, instanceId));
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", message: "frontier read-model sync failed", instanceId, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main scope-aware loop (single-token in M1; occurrence-aware rewalk in M2)
// ---------------------------------------------------------------------------

async function loop(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
  incomingEvent?: MessageEventPayload,
): Promise<DriveResult> {
  // The delivered event flows to the receive leaf that matches it (consumed at the
  // LIVE visit only); a region re-walk re-points it via matchKeyedEvent.
  let pending = incomingEvent;

  // Concurrency caps (M4-L6, design §9). The per-drive step budget wraps runStep so
  // EVERY runStep / waitForEvent issuance bumps a shared counter; the region DFS
  // checks it at the top of the walk and settles a graceful `stepBudget` incident
  // below the platform step ceiling. The count is replay-stable (the walk is
  // deterministic), unlike a SQL COUNT. The single-token path uses the same wrapped
  // runStep but NEVER checks the budget (MAX_ELEMENT_OCCURRENCES already bounds it),
  // so its behaviour stays byte-identical to pre-M4.
  const caps: DriveCaps = {
    maxConcurrentTokens: maxConcurrentTokens(env),
    stepBudgetSoft: stepBudgetSoft(env),
    budget: { steps: 0 },
  };
  const rawRunStep = runStep;
  runStep = (name, fn) => {
    caps.budget.steps++;
    return rawRunStep(name, fn);
  };

  // The per-node leaf dispatch (design §5.1: `driveLeaf`) — the SINGLE source of
  // node handling for BOTH the single-token scalar walk and the region DFS. It
  // returns a `LeafOutcome`; the existing per-kind drivers are reused verbatim,
  // threaded with `activeTokenId` (Task L3.2 branch-scoped reads/writes).
  const drivers: LeafDrivers = {
    async driveLeaf(cur: string, occ: number, activeTokenId: string, collector: WaitCollector): Promise<LeafOutcome> {
      const node = graph.nodes[cur]!;
      const tag = `${cur}#${occ}`;
      // In a region graph in WORKFLOW mode a park REGISTERS in the collector (one
      // post-DFS `Promise.race`, design §5.2) instead of suspending; direct mode
      // (waitFor === null) and single-token graphs use the real waitFor unchanged.
      const leafWaitFor: WaitForEvent | null =
        waitFor && graph.regions ? collectingWaitFor(collector, activeTokenId) : waitFor;

      if (node.type === "startEvent") {
        return { kind: "next", next: await runStep(`start:${tag}`, () => enterStart(env, instanceId, graph, cur, occ, node)) };
      }

      if (node.type === "transaction") {
        const innerStart = graph.transactions?.[cur]?.startId;
        if (!innerStart) return { kind: "completed" }; // malformed (validator guards this)
        return { kind: "next", next: await runStep(`tx:${tag}`, () => enterTransaction(env, instanceId, cur, occ, innerStart)) };
      }

      if (node.type === "serviceTask" && !node.isForCompensation) {
        const r = await driveForwardServiceTask(env, instanceId, graph, cur, occ, node, runStep, leafWaitFor, activeTokenId);
        if (r.kind === "waiting") return { kind: "parked" };
        if (r.kind === "incident") return { kind: "incident" };
        return { kind: "next", next: r.next };
      }

      if (node.type === "receiveTask") {
        const r = await driveReceiveTask(env, instanceId, graph, cur, occ, node, runStep, leafWaitFor, pending, activeTokenId);
        if (r.kind === "waiting") return { kind: "parked" };
        if (r.kind === "incident") return { kind: "incident" };
        // The delivered event is consumed at the LIVE visit only — a consumed
        // (fast-forwarded) earlier iteration must NOT clear it, or the live
        // frontier would never see it; conversely once applied it must never
        // leak into a later visit of the same (or another) receive task.
        if (r.consumedPending) pending = undefined;
        return { kind: "next", next: r.next };
      }

      if (node.type === "intermediateCatchEvent") {
        if (node.messageName) {
          // M3-L4 (TASK-46): a STANDALONE message intermediate catch — IDENTICAL
          // wait/correlation/resume semantics to a receiveTask, so it is driven by
          // the SAME driveReceiveTask path (the subscription/correlation/broker
          // machinery, NOT a parallel copy). The validator guarantees no boundary
          // timer attaches, so driveReceiveTask's timer branches are inert.
          const r = await driveReceiveTask(env, instanceId, graph, cur, occ, node, runStep, leafWaitFor, pending, activeTokenId);
          if (r.kind === "waiting") return { kind: "parked" };
          if (r.kind === "incident") return { kind: "incident" };
          if (r.consumedPending) pending = undefined;
          return { kind: "next", next: r.next };
        }
        // M3-L4 (TASK-45): a timer delay on the token path. Arms + parks; the DO
        // alarm (fireTimer) claims the `timer_outcomes` decider in the same batch
        // as the advance, then re-walks here to fast-forward.
        const r = await driveIntermediateCatch(env, instanceId, graph, cur, occ, node, runStep, leafWaitFor, activeTokenId);
        if (r.kind === "waiting") return { kind: "parked" };
        return { kind: "next", next: r.next };
      }

      if (node.type === "exclusiveGateway") {
        // Branch selection OWNS the successor: the engine NEVER reads `.next` on a
        // gateway (null by IR contract) — the chosen flow's targetId drives the
        // cursor. The recorded gateway_decisions row is the fast-forward predicate.
        // A branch token reads its RESOLVED scope (Task L3.2); root/single-token
        // keeps the M0–M3 path (activeTokenId === root ⇒ inst.variables verbatim).
        const r = await runStep(`gw:${tag}`, () => decideGateway(env, instanceId, cur, occ, node, activeTokenId));
        if (r.kind === "incident") return { kind: "incident" };
        return { kind: "next", next: r.next };
      }

      if (node.type === "eventBasedGateway") {
        // M3-L4 (TASK-46): the timer/message race; the decision is claimed by a
        // CONCURRENT writer (broker apply vs fireTimer). Reuses the receiveTask
        // `pending` consume rule.
        const r = await driveEventBasedGateway(env, instanceId, graph, cur, occ, node, runStep, leafWaitFor, pending, activeTokenId);
        if (r.kind === "waiting") return { kind: "parked" };
        if (r.kind === "incident") return { kind: "incident" };
        if (r.consumedPending) pending = undefined;
        return { kind: "next", next: r.next };
      }

      if (node.type === "endEvent") {
        if (node.endKind === "cancel" && isTransactionScope(graph, node.scopeId)) {
          await runStep(`cancel:${tag}`, () => beginCompensating(env, instanceId, node.scopeId!, cur));
          return { kind: "compensate", scopeId: node.scopeId!, elementId: cur };
        }
        if (isTransactionScope(graph, node.scopeId)) {
          // Inner none end → COMMIT the transaction → continue on its outer flow.
          return { kind: "next", next: await runStep(`commit:${tag}`, () => commitTransaction(env, instanceId, graph, node.scopeId!, cur, occ)) };
        }
        // Process-level none end. A single-token (M0–M3) instance completes
        // DIRECTLY — byte-identical to the old loop. In a region graph, last-token-
        // out (§5.6): consume THIS token; the loop's settleFrontierCompletion fires
        // the guarded terminal once no other token is live.
        if (!graph.regions) {
          await runStep(`end:${tag}`, () => completeInstance(env, instanceId, cur));
          return { kind: "completed" };
        }
        await runStep(`end:${tag}`, () => consumeTokenAtEnd(env, instanceId, cur, occ, activeTokenId));
        return { kind: "consumed" };
      }

      // Boundary events / compensation handlers are never on the token path — the
      // validator rejects sequence flows into them. A walk can only land here on an
      // injected/legacy graph that bypassed the publish gate: fail LOUD.
      await runStep(`non-token:${tag}`, () =>
        createIncident(
          env,
          instanceId,
          cur,
          0,
          `Element '${cur}' (${node.type}) is not a token-path node — the validator should have rejected this model.`,
          { elementId: cur, nodeType: node.type },
          "serviceTaskFailure",
        ),
      );
      return { kind: "incident" };
    },

    async raiseLoopLimit(elementId: string, occ: number): Promise<void> {
      // Loop guard (design M2 §5, TASK-35): only COMPLETED-VISIT re-entries reach
      // this — a technical retry re-walks to the SAME occurrence and never consumes
      // the cap. Inside a transaction the trip is a HAZARD (saga §4.5).
      await runStep(`loop-limit:${elementId}#${occ}`, () =>
        createIncident(
          env,
          instanceId,
          elementId,
          0,
          `Element '${elementId}' exceeded the loop-iteration cap (${MAX_ELEMENT_OCCURRENCES} visits).`,
          { elementId, occurrence: occ, cap: MAX_ELEMENT_OCCURRENCES },
          "loopLimit",
        ),
      );
    },

    async raiseConcurrencyLimit(splitId: string, occ: number): Promise<void> {
      // Terminal concurrencyLimit (M4-L6, design §9): a fan-out would exceed the
      // live-token cap. Claimed once (createIncident is one-way + idempotent on a
      // replay re-issuing this uniquely-named step).
      await runStep(`concurrency-limit:${splitId}#${occ}`, () => raiseConcurrencyLimitIncident(env, instanceId, splitId, caps.maxConcurrentTokens));
    },

    async raiseStepBudget(elementId: string, occ: number): Promise<void> {
      // Graceful stepBudget (M4-L6, design §9): the per-drive step counter crossed
      // the soft budget, BELOW the platform ceiling. Claimed once.
      await runStep(`step-budget:${elementId}#${occ}`, () => raiseStepBudgetIncident(env, instanceId, elementId, caps.stepBudgetSoft, caps.budget.steps));
    },
  };

  // ---- Single-token graphs (M0–M3): the exact scalar walk, byte-identical ----
  // No `regions` ⇒ no split/join nodes ⇒ the frontier is one chain from the root
  // token, driven leaf-by-leaf via `driveLeaf`. This preserves the original loop()
  // control flow (occurrence counting, loop cap, terminal completion) verbatim.
  if (!graph.regions) {
    const visits = new Map<string, number>();
    const scratch = new WaitCollector(); // unused: scalar leaves use the real waitFor / direct-mode park
    let cur: string = graph.startElementId;
    while (true) {
      if (!graph.nodes[cur]) return { status: "completed" };
      const occ = nextOccurrence(visits, cur);
      if (occ >= MAX_ELEMENT_OCCURRENCES) {
        await drivers.raiseLoopLimit(cur, occ);
        return { status: "incident" };
      }
      const r = await drivers.driveLeaf(cur, occ, rootTokenId(instanceId), scratch);
      if (r.kind === "next") {
        cur = r.next;
        continue;
      }
      if (r.kind === "parked") return { status: "waiting" };
      if (r.kind === "incident") return { status: "incident" };
      if (r.kind === "compensate") return settleAfterCompensation(env, instanceId, graph, r.scopeId, runStep, waitFor);
      return { status: "completed" }; // completed | consumed (consumed is unreachable without regions)
    }
  }

  // ---- Concurrent regions (M4): the deterministic token-frontier DFS owns the ----
  // walk. One pass per drive in direct mode (the drive lock serialises siblings);
  // workflow mode loops, racing the collected waits and re-walking on each event.
  while (true) {
    const { result, collector } = await driveFrontier(env, graph, instanceId, drivers, MAX_ELEMENT_OCCURRENCES, caps);
    if (result.incident) return { status: "incident" };
    if (result.compensate) return settleAfterCompensation(env, instanceId, graph, result.compensate.scopeId, runStep, waitFor);
    if (result.completed) return { status: "completed" };
    if (result.parked) {
      if (!waitFor) return { status: "waiting" }; // direct mode parks; the next callback re-drives
      // Workflow-mode multi-wait (design §5.2/§14) — manual-matrix-validated, not CI.
      // Count each collected waitForEvent against the step budget (design §9): a
      // multi-wait that keeps timing out and re-looping (carried blocker #3) burns
      // steps each pass, so stepBudget is the natural circuit breaker on the top of
      // the next walk rather than an unbounded re-race.
      caps.budget.steps += collector.size;
      const outcome = await raceParkedWaits(collector, waitFor);
      pending = matchKeyedEvent(outcome);
      continue;
    }
    // Nothing parked and nothing completed → the token frontier drained → last-
    // token-out completion (the guarded terminal fires iff no token is live, §5.6).
    return await settleFrontierCompletion(env, instanceId, graph);
  }
}

/**
 * A region branch (or the post-join root) token reaching a process-level none end
 * (design §5.6 last-token-out): mark THIS token `consumed` + an audit marker. The
 * instance terminal is NOT written here — `settleFrontierCompletion` fires it once
 * the whole frontier is drained, so a none-end on one branch can never complete the
 * instance while a sibling is still live.
 */
async function consumeTokenAtEnd(env: Env, instanceId: string, elementId: string, occ: number, tokenId: string): Promise<void> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "elementEntered", diagnostics: { elementType: "endEvent", endKind: "none", occurrence: occ, tokenId } }),
    setTokenStatusStmt(env.DB, tokenId, "consumed", now),
  ]);
}

/**
 * Last-token-out completion (design §5.6): if ANY token is still live the instance
 * is not done (a sibling is in flight) → `waiting`. Otherwise a GUARDED terminal
 * transition (running/waiting → completed, completed_at stamped) fires; the single
 * rows-changed return is the one drive that emits `instanceCompleted`.
 */
async function settleFrontierCompletion(env: Env, instanceId: string, graph: ExecutionGraph): Promise<DriveResult> {
  const live = await listLiveTokens(env.DB, instanceId);
  if (live.length > 0) return { status: "waiting" };
  const now = nowIso();
  const changed = await completeInstanceGuarded(env.DB, instanceId, now);
  if (changed > 0) {
    const inst = await loadInst(env, instanceId);
    await historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId: inst.current_element_id ?? graph.endElementIds[0] ?? "",
      type: "instanceCompleted",
      diagnostics: {},
    }).run();
  }
  return { status: "completed" };
}

/**
 * The COLLECTING waitFor (workflow-mode multi-wait, design §5.2): instead of
 * suspending the Workflow at the first branch's wait, it REGISTERS the wait in the
 * drive's `WaitCollector` (keyed by step name, deduped) and returns `parked`, so
 * the DFS keeps fanning out across siblings. After the DFS, `raceParkedWaits`
 * issues ONE `Promise.race` over every collected wait. Direct mode never builds
 * this (waitFor === null); it is recorded for the L6.7 manual matrix.
 */
function collectingWaitFor(collector: WaitCollector, tokenId: string): WaitForEvent {
  return async (sub) => {
    collector.add({ name: sub.name, workflowEventType: sub.workflowEventType, timeout: sub.timeout, tokenId });
    return { kind: "parked" };
  };
}

// ---------------------------------------------------------------------------
// Transaction enter / commit + bookkeeping fast-forward predicate
// ---------------------------------------------------------------------------

/**
 * Fast-forward predicate for BOOKKEEPING nodes (start / tx enter / commit end):
 * these nodes have no per-visit job or subscription row, but each visit writes
 * exactly ONE history event of `markerType` for `elementId`, stamped with its
 * occurrence, atomically with its transition. Applied ⇔ a marker for THIS
 * occurrence exists. Deliberately existence-based, NOT `count > occ`: duplicate
 * concurrent walks could double-write a marker, and a count-based predicate
 * would then falsely fast-forward a later visit k+1 (for commitTransaction also
 * falsely skipping markScopeStepsCommittedStmt, so a later cancel could
 * re-compensate already-committed steps); existence-per-occurrence makes a
 * duplicate marker harmless audit noise. M1 markers (pre-occurrence) carry no
 * `occurrence` field and are always visit 0 — the predicate folds them to 0
 * (see hasHistoryMarkerForOccurrence). This is a live D1 read used only as an
 * APPLIED predicate inside an idempotent step body — never to derive the
 * occurrence itself (in Workflow mode normal replays don't even evaluate it:
 * step.do memoization short-circuits the body; only direct-mode rewalks and
 * the crash-after-commit window do).
 */
async function visitApplied(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  markerType: string,
): Promise<boolean> {
  return hasHistoryMarkerForOccurrence(env.DB, instanceId, elementId, markerType, occ);
}

async function enterStart(env: Env, instanceId: string, graph: ExecutionGraph, elementId: string, occ: number, node: GraphNode): Promise<string> {
  const next = node.next!;
  if (await visitApplied(env, instanceId, elementId, occ, "elementEntered")) return next; // write-free rewalk
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  if (isTransactionScope(graph, node.scopeId)) {
    // Inner transaction start — just advance (the transaction node already audited entry).
    await dbBatch(env.DB, [
      // MARKER: visitApplied(...) fast-forwards on the EXISTENCE of this occurrence's marker — exactly one per visit, atomic with the transition; do not add/remove/conditionalize.
      historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "elementEntered", diagnostics: { elementType: "startEvent", scope: node.scopeId, occurrence: occ } }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
    ]);
    return next;
  }
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "instanceStarted", diagnostics: { definitionVersionId: inst.definition_version_id, correlationKey: inst.correlation_key, traceId: traceIdFor(instanceId) } }),
    // MARKER: visitApplied(...) fast-forwards on the EXISTENCE of this occurrence's marker — exactly one per visit, atomic with the transition; do not add/remove/conditionalize.
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "elementEntered", diagnostics: { elementType: "startEvent", occurrence: occ } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
  ]);
  return next;
}

async function enterTransaction(env: Env, instanceId: string, txId: string, occ: number, innerStart: string): Promise<string> {
  if (await visitApplied(env, instanceId, txId, occ, "transactionEntered")) return innerStart; // write-free rewalk
  const inst = await loadInst(env, instanceId);
  await dbBatch(env.DB, [
    // MARKER: visitApplied(...) fast-forwards on the EXISTENCE of this occurrence's marker — exactly one per visit, atomic with the transition; do not add/remove/conditionalize.
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: txId, type: "transactionEntered", diagnostics: { transaction: txId, traceId: traceIdFor(instanceId), occurrence: occ } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: innerStart, status: "running", now: nowIso() }),
  ]);
  return innerStart;
}

async function commitTransaction(env: Env, instanceId: string, graph: ExecutionGraph, txId: string, endElementId: string, occ: number): Promise<string> {
  const txNode = graph.nodes[txId];
  const outer = txNode?.next ?? null;
  if (await visitApplied(env, instanceId, endElementId, occ, "elementEntered")) return outer ?? endElementId; // write-free rewalk
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  await dbBatch(env.DB, [
    // Terminalize this scope's ledger so a later cancel can't re-compensate it.
    markScopeStepsCommittedStmt(env.DB, { instanceId, scopeId: txId, now }),
    // MARKER: visitApplied(...) fast-forwards on the EXISTENCE of this occurrence's marker — exactly one per visit, atomic with the transition; do not add/remove/conditionalize.
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: endElementId, type: "elementEntered", diagnostics: { elementType: "endEvent", endKind: "none", scope: txId, occurrence: occ } }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: txId, type: "transactionCommitted", diagnostics: { transaction: txId } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: outer ?? endElementId, status: "running", now }),
  ]);
  return outer ?? endElementId;
}

// ---------------------------------------------------------------------------
// Exclusive gateway — persisted XOR branch decision (design M2 §6, TASK-34)
// ---------------------------------------------------------------------------

type GatewayOutcome = { kind: "next"; next: string } | { kind: "incident" };

/**
 * Re-type recorded evaluations for JSON diagnostics. GatewayFlowEvaluation is
 * JSON-safe by construction (`value` is pre-normalized by normalizeFeelValue),
 * but as an interface it lacks the index signature JsonObject wants — the
 * fresh object literal supplies it without an unchecked cast.
 */
function evaluationsAsJson(evaluations: GatewayFlowEvaluation[]): JsonObject[] {
  return evaluations.map((e) => ({ ...e }));
}

/** Resolve a recorded chosen_flow_id back to its target on the immutable graph. */
function chosenFlowTarget(node: GraphNode, elementId: string, chosenFlowId: string): string {
  const flow = node.outgoing.find((f) => f.flowId === chosenFlowId);
  if (!flow) {
    // Unreachable by construction: definition versions are immutable and the
    // decision row was written from this same graph's outgoing[].
    throw new Error(
      `Invariant violation: gateway '${elementId}' recorded decision flow '${chosenFlowId}' is not among its outgoing flows.`,
    );
  }
  return flow.targetId;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE/i.test(err.message);
}

/**
 * One exclusiveGateway visit (idempotent step body, `gw:el#occ`):
 *
 * 1. A gateway_decisions row for (instance, gateway, occurrence) is the
 *    rewalk/replay fast-forward predicate — take its chosen_flow_id with ZERO
 *    writes and NEVER re-evaluate (crash/resume keeps the recorded branch even
 *    if variables changed since). Row EXISTENCE, never history-marker counts.
 * 2. Else evaluate the NON-default outgoing conditions in DOCUMENT ORDER
 *    (= persisted outgoing[] order): first boolean `true` wins (selection
 *    short-circuits — later flows are not evaluated and not recorded); none
 *    true → the `default` flow (never evaluated); no default → terminal
 *    incident kind=noPath. Inside a transaction noPath is a HAZARD (saga
 *    design §4.5): no auto-compensation; the instance parks in 'incident'
 *    where operator POST /instances/{id}/cancel stays available and
 *    compensates the pending ledger. The FIRST hard interpreter failure
 *    (ExpressionEvaluationError) aborts the whole evaluation → deterministic
 *    operator-visible incident naming the flow (a later flow must never be
 *    taken after an earlier hard error).
 * 3. Persist decision row + transition to the chosen target +
 *    `gatewayDecisionEvaluated` history event in ONE dbBatch
 *    (persist-before-advance).
 *
 * PASS-THROUGH (1-out gateway: XOR join/merge, N-in/1-out — no waiting): take
 * the single flow WITHOUT evaluating any condition it may carry (the validator
 * tolerates one; the design pins pass-through semantics, §3). It still writes
 * a normal decision row (single flow chosen, evaluations [], no snapshot)
 * rather than a cheaper marker: the row at (instance, element, occurrence) is
 * EXACTLY the per-visit fast-forward predicate a cyclic walk needs (visit k
 * fast-forwards only on its own occurrence-k row), it keeps split and join on
 * one code path and one race contract (plain INSERT + unique index), and it
 * preserves the audit invariant "every gateway visit has a decision row". A
 * history-marker variant would still cost one row per visit while adding a
 * second predicate mechanism.
 *
 * Exported for the duplicate-walk race test; production entry is loop().
 */
export async function decideGateway(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  node: GraphNode,
  activeTokenId?: string,
): Promise<GatewayOutcome> {
  const recorded = await getGatewayDecision(env.DB, instanceId, elementId, occ);
  if (recorded) {
    return { kind: "next", next: chosenFlowTarget(node, elementId, recorded.chosenFlowId) };
  }

  const inst = await loadInst(env, instanceId);
  // Branch-scoped reads (design §5.7): a gateway inside a region evaluates against
  // its token's resolved overlay chain; the recorded variables_snapshot then
  // captures that RESOLVED scope and is never re-evaluated. A null/root token
  // resolves to root variables verbatim (the exact M0–M3 path).
  const variables = activeTokenId
    ? await resolveScope(env, instanceId, parseJson<JsonObject>(inst.variables, {}), activeTokenId)
    : parseJson<JsonObject>(inst.variables, {});

  let chosen: Flow | null = null;
  let isDefault = false;
  const evaluations: GatewayFlowEvaluation[] = [];
  const passThrough = node.outgoing.length === 1;

  if (passThrough) {
    chosen = node.outgoing[0]!;
  } else {
    for (const flow of node.outgoing) {
      if (flow.isDefault) continue; // the default is the no-match fallback, never evaluated
      const expression = flow.conditionExpression;
      if (expression == null) {
        // Unreachable by construction: the publish gate requires a condition on
        // every non-default flow of a multi-out gateway, and versions are immutable.
        throw new Error(
          `Invariant violation: non-default flow '${flow.flowId}' of exclusiveGateway '${elementId}' carries no condition expression.`,
        );
      }
      let evaluation;
      try {
        evaluation = evaluateCondition(expression, variables);
      } catch (err) {
        if (err instanceof ExpressionEvaluationError) {
          // M3-L1 (TASK-39): a hard FEEL error is its own taxonomy bucket
          // ('conditionFailure'), no longer masked as a serviceTaskFailure.
          return createIncident(
            env,
            instanceId,
            elementId,
            0,
            `exclusiveGateway '${elementId}' condition on flow '${flow.flowId}' failed to evaluate: ${err.message}`,
            { flowId: flow.flowId, expression, occurrence: occ },
            "conditionFailure",
          );
        }
        throw err;
      }
      evaluations.push({
        flowId: flow.flowId,
        expression,
        result: evaluation.taken,
        value: normalizeFeelValue(evaluation.value),
        ...(evaluation.warnings.length > 0 ? { warnings: evaluation.warnings } : {}),
      });
      if (evaluation.taken) {
        chosen = flow; // first true wins (document order); stop evaluating
        break;
      }
    }
    if (!chosen) {
      const fallback = node.outgoing.find((f) => f.isDefault === true);
      if (fallback) {
        chosen = fallback;
        isDefault = true;
      }
    }
  }

  if (!chosen) {
    // noPath — terminal incident (Hazard inside a transaction: no
    // auto-compensation; operator /cancel compensates the pending ledger).
    return createIncident(
      env,
      instanceId,
      elementId,
      0,
      `exclusiveGateway '${elementId}' selected no path: no condition evaluated to true and the gateway has no default flow.`,
      { occurrence: occ, evaluations: evaluationsAsJson(evaluations) },
      "noPath",
    );
  }

  const next = chosen.targetId;
  const now = nowIso();
  // variables_snapshot is the evaluation context, capped by the existing
  // payload limit: an oversized context is OMITTED (null + a diagnostics
  // flag), never an error — the decision itself is unaffected.
  const variablesByteSize = payloadByteSize(variables);
  const snapshotFits = variablesByteSize <= MAX_EVENT_PAYLOAD_BYTES;
  const variablesSnapshot = passThrough || !snapshotFits ? null : variables;
  const diagnostics: JsonObject = {
    chosenFlowId: chosen.flowId,
    occurrence: occ,
    isDefault,
    evaluations: evaluationsAsJson(evaluations),
    ...(passThrough ? { passThrough: true } : {}),
    ...(!passThrough && !snapshotFits ? { variablesSnapshotOmitted: true, variablesByteSize } : {}),
    ...branchHistoryTags(activeTokenId),
  };

  try {
    await dbBatch(env.DB, [
      insertGatewayDecisionStmt(env.DB, {
        decisionId: newId("gwd"),
        instanceId,
        elementId,
        occurrence: occ,
        chosenFlowId: chosen.flowId,
        isDefault,
        evaluations,
        variablesSnapshot,
        now,
      }),
      historyStmt(env.DB, {
        workspaceId: inst.workspace_id,
        instanceId,
        elementId,
        type: "gatewayDecisionEvaluated",
        diagnostics,
      }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
    ]);
  } catch (err) {
    // Plain-INSERT race contract (gateway-decisions.ts): a losing concurrent
    // walk's unique violation on (instance, element, occurrence) aborts its
    // ENTIRE batch — transition and history included — so the loser re-reads
    // the decision and follows the RECORDED branch; never re-evaluates. Only
    // the unique violation with a confirmed winner row is handled; any other
    // batch failure propagates untouched.
    if (isUniqueConstraintViolation(err)) {
      const winner = await getGatewayDecision(env.DB, instanceId, elementId, occ);
      if (winner) {
        return { kind: "next", next: chosenFlowTarget(node, elementId, winner.chosenFlowId) };
      }
    }
    throw err;
  }
  return { kind: "next", next };
}

// ---------------------------------------------------------------------------
// Receive Task (durable message wait) — occurrence-keyed subscriptions (M2 §5):
// a Receive Task inside a loop re-subscribes per visit; the broker key
// (workspace + messageName + correlationKey) is unchanged — sequential
// re-subscription on the same key is the already-supported broker pattern.
// The subscription row's `consumed` status (set atomically with the
// transition out of the wait) IS the write-free fast-forward predicate.
//
// M3-L4 (TASK-46): a STANDALONE message `intermediateCatchEvent` shares THIS
// exact driver (design §3 item 3 — "identical wait/correlation/resume semantics
// to a receiveTask"). It is dispatched here from loop() with the same signature;
// `timerBoundaryFor` returns null for an event (no boundary attaches to a catch),
// so the timer-boundary branches below are inert and the path collapses to the
// plain register → park → apply machinery — NOT a parallel copy.
// ---------------------------------------------------------------------------

type ReceiveOutcome =
  | { kind: "next"; next: string; consumedPending?: boolean }
  | { kind: "waiting" }
  | { kind: "incident" };

async function driveReceiveTask(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
  pending?: MessageEventPayload,
  activeTokenId?: string,
): Promise<ReceiveOutcome> {
  const tag = `${elementId}#${occ}`;
  const next = node.next!;
  const messageName = node.messageName ?? "";
  const tb = timerBoundaryFor(graph, elementId);

  // Boundary-timer fast-forward (M3-L3): a fired timer already superseded the
  // subscription and transitioned the token down the boundary path (write-free).
  if (tb && (await timerHasFired(env, instanceId, tb, occ))) {
    return { kind: "next", next: tb.node.next! };
  }

  // Already applied → pure in-memory cursor move, NO writes, NO step. If the
  // in-flight delivery is exactly the message this visit consumed (a racing
  // duplicate drive applied it first), drop it so it can never advance a
  // SECOND iteration.
  const sub = await getSubscriptionForVisit(env.DB, instanceId, elementId, occ);
  if (sub?.status === "consumed") {
    return { kind: "next", next, consumedPending: !!pending && sub.external_message_id === pending.externalMessageId };
  }

  // Match-keyed apply (design §5.2): a delivered message is consumed HERE only when
  // its messageName matches THIS receive's — never positionally. In a region a
  // sibling branch's message (a different name) must fall through so the matching
  // branch consumes it (single-token M3 always matches, so this is a no-op there).
  if (pending && pending.messageName === messageName) {
    const r = await runStep(`msg:${tag}`, () => applyMessage(env, instanceId, graph, elementId, occ, next, pending, activeTokenId));
    return { kind: "next", next: r.next, consumedPending: true };
  }

  const reg = await runStep(`recv:${tag}`, () => registerReceive(env, instanceId, graph, elementId, occ, messageName, node.type, activeTokenId));
  if (reg.kind === "incident") return { kind: "incident" };
  if (reg.kind === "applied") return { kind: "next", next };
  if (reg.kind === "correlated") {
    const r = await runStep(`msg:${tag}`, () => applyMessage(env, instanceId, graph, elementId, occ, next, reg.event, activeTokenId));
    return { kind: "next", next: r.next };
  }
  if (!waitFor) return { kind: "waiting" };
  // Self-healing re-arm (design §4.2): a rewalk landing on a still-armed timer
  // re-arms the DO idempotently so a lost alarm is repaired by the next drive.
  if (tb) {
    const trow = await getTimer(env.DB, timerIdFor(instanceId, tb.boundaryId, occ));
    if (trow?.status === "armed") await armTimerDO(env, trow.timerId, trow.fireAt);
  }
  // A timer-guarded wait is SIZED to the timer (so a long timer costs O(1) steps).
  const timeout = tb ? await timerGuardedTimeout(env, instanceId, tb, occ) : SVC_WAIT_TIMEOUT;
  const outcome = await waitFor({ name: `wait:${tag}`, workflowEventType: reg.workflowEventType, timeout });
  // M4-L3 multi-wait: a region branch in workflow mode REGISTERED this wait and did
  // not suspend — return parked (raceParkedWaits awaits it). Direct mode never hits this.
  if (outcome.kind === "parked") return { kind: "waiting" };
  // The timer may have fired (its wake, or a concurrent alarm) while we waited.
  if (tb && (await timerHasFired(env, instanceId, tb, occ))) {
    return { kind: "next", next: tb.node.next! };
  }
  if (outcome.kind === "timeout") {
    // D1 is canonical: an inline drive (e.g. after a Workflow handover) may
    // have applied this visit's message while we waited — advance, don't fail.
    const fresh = await getSubscriptionForVisit(env.DB, instanceId, elementId, occ);
    if (fresh?.status === "consumed") return { kind: "next", next };
    if (tb) {
      // Lost-alarm backstop (design §4.2, risk R5). A wait guarded by a modeled
      // timer NEVER raises waitTimeout. The DO alarm is the PRIMARY firing
      // mechanism; this timer-SIZED timeout doubles as the backstop for a lost/
      // failed alarm: on this wake re-read D1 and settle an OVERDUE timer INLINE
      // exactly as the alarm path would (superseding the subscription), RETURNING
      // the boundary path to THIS drive loop. We are already inside a drive, so
      // there is no executor wake here — that is what avoids the runtime/timers →
      // executor → engine import cycle. (Workflow-mode-only; the DO-alarm fire path
      // is the CI-tested mechanism.)
      const settled = await settleOverdueBoundaryTimerOnWake(env, graph, instanceId, elementId, occ);
      if (settled.kind === "fired") return { kind: "next", next: settled.next };
      if (settled.kind === "reparked") return { kind: "waiting" }; // armed-but-early → re-armed; re-park
      // fallThrough: a concurrent message apply settled the timer 'cancelled' (its
      // transition rode the same batch) — re-read and advance if consumed, so a
      // swallowed wake is not stranded.
      const reread = await getSubscriptionForVisit(env.DB, instanceId, elementId, occ);
      if (reread?.status === "consumed") return { kind: "next", next };
      return { kind: "waiting" }; // still parked (e.g. a concurrent /cancel terminal) — re-park
    }
    // M3-L1 (TASK-39): the un-guarded receive-task wait cap is 'waitTimeout'
    // (shared with the service-task wait cap), split out of the legacy 'timeout'.
    await runStep(`recv-timeout:${tag}`, () => createIncident(env, instanceId, elementId, 0, `${node.type === "intermediateCatchEvent" ? "Message catch" : "Receive Task"} wait timed out.`, { messageName }, "waitTimeout"));
    return { kind: "incident" };
  }
  const event = parseMessageEvent(outcome.payload);
  const r = await runStep(`msg:${tag}`, () => applyMessage(env, instanceId, graph, elementId, occ, next, event, activeTokenId));
  return { kind: "next", next: r.next };
}

function parseMessageEvent(payload: unknown): MessageEventPayload {
  // The broker delivers a fully-formed MessageEventPayload; trust the runtime shape.
  return payload as MessageEventPayload;
}

type RegisterOutcome =
  | { kind: "waiting"; workflowEventType: string; subscriptionId: string }
  | { kind: "correlated"; event: MessageEventPayload }
  // This visit's message was applied concurrently — nothing to register.
  | { kind: "applied" }
  | { kind: "incident" };

async function registerReceive(env: Env, instanceId: string, graph: ExecutionGraph, elementId: string, occ: number, messageName: string, elementType: NodeType, activeTokenId?: string): Promise<RegisterOutcome> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  // Honest operator-visible labels: a standalone message intermediate catch
  // (M3-L4, TASK-46) is an EVENT, not an activity — its parked-wait marker and
  // failure wording must NOT read "Receive Task" (design §3 item 3).
  const isCatch = elementType === "intermediateCatchEvent";

  const existing = await getSubscriptionForVisit(env.DB, instanceId, elementId, occ);
  if (existing?.status === "consumed") return { kind: "applied" }; // idempotent re-run guard
  const active = existing?.status === "active" ? existing : null;

  if (!active) {
    // First registration for this visit — exactly one audit entry per occurrence
    // (a rewalk that lands on an already-active wait re-registers WRITE-FREE).
    // `elementType` is the honest audit label: "receiveTask" or, when the SAME
    // wait machinery drives a standalone message intermediate catch (M3-L4,
    // TASK-46), "intermediateCatchEvent".
    await historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "elementEntered", diagnostics: { elementType, messageName, occurrence: occ } }).run();
  }

  const subscriptionId = active?.subscription_id ?? newId("sub");
  const workflowEventType = workflowEventTypeFor(messageName);
  const brokerKey = brokerKeyOf(inst.workspace_id, messageName, inst.correlation_key);
  const expiresAt = isoPlusMs(now, ONE_HOUR_MS);

  const brokerId = env.CORRELATION_BROKER.idFromName(brokerKey);
  const broker = env.CORRELATION_BROKER.get(brokerId);
  const result = (await broker.registerSubscription({
    workspaceId: inst.workspace_id,
    instanceId,
    workflowInstanceId: inst.workflow_instance_id,
    elementId,
    subscriptionId,
    messageName,
    correlationKey: inst.correlation_key,
    workflowEventType,
    expiresAt,
    now,
  })) as RegisterSubscriptionResult;

  if (result.status === "rejected") {
    await createIncident(env, instanceId, elementId, 0, `${isCatch ? "Message catch" : "Receive Task"} could not register: ${result.reason}`, { existingInstanceId: result.existingInstanceId ?? null }, "serviceTaskFailure");
    await historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "invariantViolation", diagnostics: { reason: result.reason, messageName, correlationKey: inst.correlation_key } }).run();
    return { kind: "incident" };
  }
  if (result.status === "correlated") return { kind: "correlated", event: result.event };

  if (!active) {
    await createSubscription(env.DB, { subscriptionId, workspaceId: inst.workspace_id, instanceId, elementId, messageName, correlationKey: inst.correlation_key, brokerKey, workflowEventType, status: "active", expiresAt, occurrence: occ, now });
    // M3-L3: arm the interrupting boundary timer (if any) in the SAME
    // first-registration batch (persist-before-advance); arm the DO after commit.
    const arm = buildBoundaryArm(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: elementId, occ, now });
    await dbBatch(env.DB, [
      historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: isCatch ? "messageCatchWaiting" : "receiveTaskWaiting", diagnostics: { subscriptionId, messageName, correlationKey: inst.correlation_key, expiresAt, occurrence: occ, ...branchHistoryTags(activeTokenId) } }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now }),
      ...(arm ? arm.stmts : []),
    ]);
    if (arm) await armTimerDO(env, arm.timerId, arm.fireAt);
  }
  return { kind: "waiting", workflowEventType, subscriptionId };
}

async function applyMessage(env: Env, instanceId: string, graph: ExecutionGraph, elementId: string, occ: number, next: string, event: MessageEventPayload, activeTokenId?: string): Promise<{ next: string }> {
  const inst = await loadInst(env, instanceId);
  const sub = await getSubscriptionForVisit(env.DB, instanceId, elementId, occ);
  // Apply-once guard (idempotent step body): the payload merge + the transition
  // out of the wait commit atomically below; once `consumed`, a re-run is a no-op.
  if (sub?.status === "consumed") return { next };
  const active = sub?.status === "active" ? sub : null;
  const now = nowIso();
  // Branch-scoped payload (design §5.7 — applyMessage is a named scope-aware site):
  // a branch token's message payload merges onto its OWN overlay (not root); root
  // vars mutate only at the join fold-up. A null/root token keeps the M0–M3 path.
  const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
  const branchTokenRow = isBranch ? await getToken(env.DB, activeTokenId!) : null;
  // R2-aware read (M4-L6, design §9.1): a branch overlay may be an {"__r2":…} ref.
  const baseVars = isBranch ? (branchTokenRow ? await readOverlay(env, parseOverlay(branchTokenRow)) : {}) : parseJson<JsonObject>(inst.variables, {});
  const merged = mergeVariables(baseVars, event.payload ?? {});
  // R2-aware write (M4-L6): offload a large branch overlay before the D1 commit.
  const storedBranchOverlay = isBranch ? await writeOverlay(env, instanceId, activeTokenId!, merged) : merged;

  let subscriptionId = active?.subscription_id;
  if (!subscriptionId) {
    subscriptionId = newId("sub");
    await createSubscription(env.DB, {
      subscriptionId,
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      messageName: event.messageName,
      correlationKey: inst.correlation_key,
      brokerKey: brokerKeyOf(inst.workspace_id, event.messageName, inst.correlation_key),
      workflowEventType: workflowEventTypeFor(event.messageName),
      status: "consumed",
      expiresAt: isoPlusMs(now, ONE_HOUR_MS),
      consumedAt: now,
      externalMessageId: event.externalMessageId,
      occurrence: occ,
      now,
    });
  }

  const statements: D1PreparedStatement[] = [
    // A branch token's payload goes to its OWN overlay (design §5.7); the instance
    // status moves to 'running' WITHOUT touching root vars or pinning a single
    // current_element_id (NULL = multi-token frontier). A root/single-token token
    // keeps the exact M0–M3 write (merged → process_instances.variables).
    ...(isBranch
      ? [setTokenOverlayStmt(env.DB, activeTokenId!, storedBranchOverlay, now), applyTransitionStmt(env.DB, { instanceId, currentElementId: null, status: "running", now })]
      : [applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: next, status: "running", now })]),
    ...(active ? [subscriptionConsumedStmt(env.DB, subscriptionId, event.externalMessageId, now)] : []),
    messageCorrelatedStmt(env.DB, { externalMessageId: event.externalMessageId, instanceId, subscriptionId, now }),
    variableSnapshotStmt(env.DB, { instanceId, source: "message", sourceId: event.externalMessageId, variables: event.payload ?? {}, now }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, externalMessageId: event.externalMessageId, type: "messageCorrelated", diagnostics: { subscriptionId, messageName: event.messageName, messageId: event.messageId, occurrence: occ, ...branchHistoryTags(activeTokenId) }, payloadSnapshot: event.payload ?? {} }),
  ];
  // M3-L3: settle the guarding timer 'cancelled' ATOMICALLY with consuming the
  // message; on a decider conflict the timer FIRED first → convert to its path.
  const cancelSettle = buildBoundaryCancelSettle(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: elementId, occ, now });
  if (cancelSettle) statements.push(...cancelSettle.stmts);
  try {
    await dbBatch(env.DB, statements);
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const converted = await convertOnFire(env, graph, instanceId, elementId, occ);
      if (converted) return { next: converted };
    }
    throw err;
  }
  return { next };
}

// ---------------------------------------------------------------------------
// Inline drive (HTTP-side operator cancel/retry)
// ---------------------------------------------------------------------------

/**
 * Drive the engine inline (HTTP-side), e.g. for operator cancel/retry: it creates
 * the next pull job and parks, or settles a terminal saga. Mode-agnostic — the
 * resulting jobs are leased + completed through the pull plane like any other.
 * `startAt` is accepted for caller compatibility but IGNORED (TASK-32): the
 * engine always rewalks from the start element and fast-forwards write-free.
 */
export async function resumeInline(env: Env, instanceId: string, startAt?: string): Promise<DriveResult> {
  const inline = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
  return runInstance(env, instanceId, { runStep: inline, waitFor: null, startAt });
}
