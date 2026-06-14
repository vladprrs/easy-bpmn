// Reverse-order compensation pass (M3-L0 extraction, TASK-38).
//
// The saga compensation pass lifted verbatim from engine.ts: cancel-end entry
// (beginCompensating), the resumable reverse walk over the ledger
// (settleAfterCompensation → runCompensation), per-step compensation jobs, and
// the saga-failed terminal settle. Behavior-frozen — step names, history event
// types, ledger transitions, and the compensation wait cap are unchanged.

import type { Env } from "../env";
import type { ExecutionGraph } from "../bpmn/graph";
import { isTerminalInstanceStatus, newId, nowIso, parseJson, traceIdFor, type JsonObject } from "../util";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import {
  advanceIncidentResolutionStmt,
  applyTransitionStmt,
  createJobStmt,
  getCompensationJob,
  getForwardJobByElement,
  incidentStmt,
  type JobRow,
} from "../persistence/instances";
import {
  attachCompensationJobStmt,
  filterLineageQuiesced,
  getSagaStep,
  insertSagaStepStmt,
  selectScopeStepsForCompensation,
  updateCompensationStatusStmt,
  type SagaStepView,
} from "../persistence/saga";
import { listLiveTokens, setTokenStatusStmt } from "../persistence/tokens";
import { armCohortLeaseExpiryTerminators } from "./forward-task";
import { loadInst, type RunStep, type WaitForEvent, type DriveResult } from "./engine-shared";
import { WAKE_TYPE, wakeBackstop } from "./wake";

/** The failure-path target of the cancel boundary attached to transaction `scopeId`. */
function cancelBoundaryTarget(graph: ExecutionGraph, scopeId: string): string | null {
  for (const [, node] of Object.entries(graph.nodes)) {
    if (node.type === "boundaryEvent" && node.boundaryKind === "cancel" && node.attachedToRef === scopeId) {
      return node.next ?? null;
    }
  }
  return null;
}

export async function beginCompensating(env: Env, instanceId: string, scopeId: string, cancelEndId: string): Promise<void> {
  const inst = await loadInst(env, instanceId);
  // Idempotent re-run: once the cancel transition committed the reverse pass
  // owns the instance — never duplicate transactionCancelled or regress status.
  if (inst.status === "compensating" || isTerminalInstanceStatus(inst.status)) return;
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: scopeId, type: "transactionCancelled", diagnostics: { transaction: scopeId, via: cancelEndId, traceId: traceIdFor(instanceId) } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: cancelEndId, status: "compensating", now: nowIso() }),
  ]);
  // M4-L5 (design §8.2): arm a per-token lease-expiry terminator for every in-flight
  // cohort forward job so the quiescence barrier drains without a future worker poll.
  // No-op for single-token instances (no locked forward job survives to a cancel-end).
  await armCohortLeaseExpiryTerminators(env, instanceId);
}

/** Run (or resume) the reverse pass for `scopeId`, then settle the saga-failed terminal. */
export async function settleAfterCompensation(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  scopeId: string,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
): Promise<DriveResult> {
  const result = await runCompensation(env, instanceId, graph, scopeId, runStep, waitFor);
  if (result === "waiting") return { status: "waiting" };
  if (result === "failed") return { status: "incident" }; // compensationFailed terminal (operator-resumable)
  await runStep(`settle:${scopeId}`, () => settleSagaCompensated(env, instanceId, scopeId, cancelBoundaryTarget(graph, scopeId)));
  return { status: "completed" };
}

type CompResult = "compensated" | "waiting" | "failed";

async function runCompensation(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  scopeId: string,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
): Promise<CompResult> {
  // Re-derive the cursor from the ledger each pass (crash-safe, resumable).
  // With loops each iteration is its own ledger row (occurrence-keyed), so the
  // reverse pass compensates every iteration separately with zero algorithm
  // change; compensation jobs + step names inherit the forward occurrence.
  //
  // M4-L5: under in-instance concurrency a scope can have several live branch
  // tokens at cancel. `isRegion` gates the cohort logic so M1–M3 single-token
  // instances behave EXACTLY as before (no token rows of interest, the filter is a
  // no-op, the barrier reduces to "ledger empty ⇒ compensated").
  const isRegion = !!graph.regions;
  // Single-wake the reverse pass (TASK-54): `compWakeSeq` mirrors the forward loop's
  // `wakeSeq` and RESETS to 0 on each runCompensation invocation. On a CF replay the
  // walk re-derives the cursor from the ledger; already-compensated steps replay their
  // memoized markStepCompensated/comp-create runSteps and re-issue their cached
  // `comp-wake#k` (CF returns the cached event, no re-suspend) before the walk reaches
  // the live pending step, so the k-th `comp-wake` always maps deterministically to the
  // k-th still-pending comp step. The `comp-wake` prefix is distinct from the forward
  // `wake#k`, so a forward→cancel→compensate drive never collides step names.
  let compWakeSeq = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // M4-L5 (design §8.3): before the reverse pass, catch stragglers + drain
    // terminal cohort tokens — a token whose forward job COMPLETED (possibly after
    // cancel) is ledgered (INSERT OR IGNORE) + consumed; a FAILED one is discarded.
    if (isRegion) await ledgerStragglers(env, instanceId, graph, scopeId);

    const steps = await selectScopeStepsForCompensation(env.DB, instanceId, scopeId);
    // Live cohort tokens (region only). filterLineageQuiesced is a no-op for the
    // single-token path (token_id NULL steps are never blocked), so `live` is only
    // needed for region instances.
    const live = isRegion ? await listLiveTokens(env.DB, instanceId) : [];

    // Quiescence barrier (design §8.3): settle the terminal ONLY when no scope step
    // still needs compensation AND no cohort token is live. If the ledger is drained
    // but a token is still in flight, park (`waiting`) on the terminators so a late
    // straggler is always ledgered + compensated before the terminal transition.
    if (steps.length === 0) return live.length === 0 ? "compensated" : "waiting";

    // Lineage-quiescence-ordered reverse (design §8.4 / Principle VI): a step is
    // eligible only once its branch lineage has no live descendant — so a causally-
    // downstream straggler is compensated before its predecessor. Cross-branch order
    // is unconstrained (concurrent branches have no happens-before relation).
    const eligible = filterLineageQuiesced(steps, live);
    if (eligible.length === 0) return "waiting"; // every remaining step blocked by a live descendant → park
    const step = eligible[0]!; // highest seq among the eligible (selectScope orders seq DESC)
    const ctag = `${step.elementId}#${step.occurrence}`;

    let comp = await getCompensationJob(env.DB, instanceId, step.elementId, step.occurrence);
    if (!comp) {
      comp = await runStep(`comp-create:${ctag}`, () => createCompensationJob(env, instanceId, graph, step));
    }
    if (comp.status === "completed") {
      await runStep(`comp-done:${ctag}`, () => markStepCompensated(env, instanceId, step));
      continue;
    }
    if (comp.status === "failed") {
      await runStep(`comp-fail:${ctag}`, () => markStepCompensationFailed(env, instanceId, step));
      return "failed";
    }
    if (!waitFor) return "waiting"; // direct mode parks at 'compensating'; resume re-runs this pass
    // Workflow mode (TASK-54): the comp job is created but not yet terminal — issue ONE
    // replay-stable bpmn_wake (sequential `comp-wake#k`) and re-read after the worker's
    // /jobs/complete tickles the Workflow. Mirrors the forward loop's issueWake; without
    // this the reverse pass busy-spins on the created job (it never suspends so the worker
    // can never complete it). A wake TIMEOUT (lost tickle) self-heals: catch → re-read.
    const timeout = await wakeBackstop(env, instanceId);
    try {
      await waitFor({ name: `comp-wake#${compWakeSeq}`, workflowEventType: WAKE_TYPE, timeout });
    } catch {
      /* lost/expired wake → self-heal: fall through to re-read the ledger */
    }
    compWakeSeq += 1;
    // loop re-reads the (now terminal) comp job
  }
}

/**
 * Cohort straggler scan (design §8.1/§8.3) — region instances only. For each LIVE
 * token positioned inside the compensating scope, settle it against its forward
 * job so the quiescence barrier can drain and no executed side-effect leaks:
 *   - forward job COMPLETED → ledger it (INSERT OR IGNORE, carrying the producing
 *     token + the job's occurrence/captured I/O — a no-op when the forward path
 *     already wrote the row) and CONSUME the token. This catches a straggler that
 *     completed AFTER cancel began, and an `arrivedAtJoin` token whose step was
 *     ledgered upstream (the half-satisfied join never fires).
 *   - forward job FAILED → DISCARD the token (a failed forward job executed no
 *     compensatable side-effect; the per-token terminator may have just failed it).
 *   - no forward job at the position (a gateway/event/pure-wait) → DISCARD (owes no
 *     compensation), so the barrier is never wedged by a non-compensatable token.
 *   - forward job still `created`/`locked` (in-flight) → LEAVE the token live; the
 *     per-token terminator (DLQ / lease-expiry, L5.3) drives it terminal and the
 *     next pass re-scans.
 *
 * Single-transaction scope assumption: branch tokens are confined to one region per
 * the SESE validator, so "positioned inside `scopeId`" (the position node's scopeId)
 * is the cohort; a token's region branch is a single-entry/single-exit sub-region.
 */
async function ledgerStragglers(env: Env, instanceId: string, graph: ExecutionGraph, scopeId: string): Promise<void> {
  const live = await listLiveTokens(env.DB, instanceId);
  for (const t of live) {
    if (graph.nodes[t.position_element_id]?.scopeId !== scopeId) continue; // not in this cohort
    const now = nowIso();
    const job = await getForwardJobByElement(env.DB, instanceId, t.position_element_id);
    if (job && job.status === "completed") {
      const stmts: D1PreparedStatement[] = [];
      if (!(await getSagaStep(env.DB, instanceId, t.position_element_id, job.occurrence))) {
        const wiring = graph.transactions?.[scopeId]?.compensations?.[t.position_element_id];
        const handlerNode = wiring ? graph.nodes[wiring.handlerId] : undefined;
        stmts.push(
          insertSagaStepStmt(env.DB, {
            stepId: newId("step"),
            instanceId,
            scopeId,
            elementId: t.position_element_id,
            forwardJobId: job.job_id,
            capturedInput: parseJson<JsonObject>(job.input_variables, {}),
            capturedOutput: job.output_variables ? parseJson<JsonObject>(job.output_variables, {}) : null,
            compensationElementId: wiring?.handlerId ?? null,
            compensationTaskType: handlerNode?.taskType ?? null,
            compensationStatus: wiring ? "pending" : "notRequired",
            traceId: traceIdFor(instanceId),
            occurrence: job.occurrence,
            tokenId: t.token_id,
            now,
          }),
        );
      }
      stmts.push(setTokenStatusStmt(env.DB, t.token_id, "consumed", now));
      await dbBatch(env.DB, stmts);
    } else if (job && job.status === "failed") {
      await dbBatch(env.DB, [setTokenStatusStmt(env.DB, t.token_id, "discarded", now)]);
    } else if (!job) {
      await dbBatch(env.DB, [setTokenStatusStmt(env.DB, t.token_id, "discarded", now)]);
    }
    // else: job created/locked (in-flight) → leave live for the terminator.
  }
}

async function createCompensationJob(env: Env, instanceId: string, graph: ExecutionGraph, step: SagaStepView): Promise<JobRow> {
  // Idempotent re-run (Workflow step retry after a committed batch).
  const existing = await getCompensationJob(env.DB, instanceId, step.elementId, step.occurrence);
  if (existing) return existing;

  const inst = await loadInst(env, instanceId);
  const handlerNode = step.compensationElementId ? graph.nodes[step.compensationElementId] : undefined;
  const jobId = newId("job");
  const taskType = step.compensationTaskType ?? handlerNode?.taskType ?? "";
  await dbBatch(env.DB, [
    createJobStmt(env.DB, {
      jobId,
      instanceId,
      elementId: step.elementId, // forward element id (uq is per kind + occurrence)
      taskType,
      retryLimit: Math.max(1, handlerNode?.retries ?? 1),
      idempotencyKey: `${instanceId}:${step.elementId}:1:${step.occurrence}`,
      inputVariables: parseJson<JsonObject>(inst.variables, {}),
      workspaceId: inst.workspace_id,
      isCompensation: true,
      compensatesElementId: step.elementId,
      // A compensation job inherits its forward step's occurrence (design M2 §8).
      occurrence: step.occurrence,
      now: nowIso(),
    }),
    attachCompensationJobStmt(env.DB, { stepId: step.stepId, compensationJobId: jobId, now: nowIso() }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: step.elementId, type: "compensationStarted", diagnostics: { jobId, handler: step.compensationElementId, taskType, traceId: traceIdFor(instanceId), occurrence: step.occurrence } }),
  ]);
  return (await getCompensationJob(env.DB, instanceId, step.elementId, step.occurrence))!;
}

async function markStepCompensated(env: Env, instanceId: string, step: SagaStepView): Promise<void> {
  const inst = await loadInst(env, instanceId);
  await dbBatch(env.DB, [
    updateCompensationStatusStmt(env.DB, { stepId: step.stepId, status: "compensated", now: nowIso() }),
    // `occurrence` mirrors compensationStarted (TASK-37 carry): without it an
    // operator could not tell WHICH loop iteration finished compensating.
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: step.elementId, type: "compensationCompleted", diagnostics: { handler: step.compensationElementId, occurrence: step.occurrence } }),
  ]);
}

async function markStepCompensationFailed(env: Env, instanceId: string, step: SagaStepView): Promise<void> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  await dbBatch(env.DB, [
    updateCompensationStatusStmt(env.DB, { stepId: step.stepId, status: "failed", now }),
    incidentStmt(env.DB, {
      incidentId: newId("inc"),
      instanceId,
      elementId: step.elementId,
      reason: `Compensation handler exhausted retries for step '${step.elementId}'.`,
      retryCount: 0,
      kind: "compensationFailure",
      resolution: "open",
      payloadContext: { handler: step.compensationElementId, compensationJobId: step.compensationJobId },
      now,
    }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: step.elementId, type: "compensationFailed", diagnostics: { handler: step.compensationElementId } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: step.elementId, status: "compensationFailed", now }),
  ]);
}

/** Settle the saga-failed terminal WITHOUT completeInstance (keep 'compensated'). */
async function settleSagaCompensated(env: Env, instanceId: string, scopeId: string, failureTarget: string | null): Promise<void> {
  const inst = await loadInst(env, instanceId);
  if (inst.status !== "compensating") return; // already settled / not in pass
  const now = nowIso();
  const finalEl = failureTarget ?? scopeId;
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: scopeId, type: "compensationCompleted", diagnostics: { transaction: scopeId, outcome: "compensated" } }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: finalEl, type: "sagaFailed", diagnostics: { settledVia: finalEl } }),
    // Incident lifecycle (TASK-36 carry): an operator /cancel of a Hazard set
    // the incident resolution to 'compensating'; the settle is its natural
    // completion → advance to 'compensated' atomically with the terminal
    // transition. Guarded on the exact prior value, so the /retry path's
    // sticky 'operatorResolved' and an 'open' incident are never clobbered,
    // and instances with no incident (auto cancel-end / operator cancel of a
    // running saga) no-op.
    advanceIncidentResolutionStmt(env.DB, { instanceId, from: "compensating", to: "compensated" }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: finalEl, status: "compensated", completedAt: now, now }),
  ]);
}
