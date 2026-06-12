// Reverse-order compensation pass (M3-L0 extraction, TASK-38).
//
// The saga compensation pass lifted verbatim from engine.ts: cancel-end entry
// (beginCompensating), the resumable reverse walk over the ledger
// (settleAfterCompensation → runCompensation), per-step compensation jobs, and
// the saga-failed terminal settle. Behavior-frozen — step names, history event
// types, ledger transitions, and the compensation wait cap are unchanged.

import type { Env } from "../env";
import type { ExecutionGraph } from "../bpmn/graph";
import { workflowJobEventTypeFor } from "../bpmn/profile";
import { isTerminalInstanceStatus, newId, nowIso, parseJson, traceIdFor, type JsonObject } from "../util";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import {
  advanceIncidentResolutionStmt,
  applyTransitionStmt,
  createJobStmt,
  getCompensationJob,
  incidentStmt,
  type JobRow,
} from "../persistence/instances";
import {
  attachCompensationJobStmt,
  selectScopeStepsForCompensation,
  updateCompensationStatusStmt,
  type SagaStepView,
} from "../persistence/saga";
import { loadInst, SVC_WAIT_TIMEOUT, type RunStep, type WaitForEvent, type DriveResult } from "./engine-shared";

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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const steps = await selectScopeStepsForCompensation(env.DB, instanceId, scopeId);
    if (steps.length === 0) return "compensated";
    const step = steps[0]!; // highest seq still needing compensation
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

    const outcome = await waitFor({ name: `wait-comp:${ctag}`, workflowEventType: workflowJobEventTypeFor(comp.job_id), timeout: SVC_WAIT_TIMEOUT });
    if (outcome.kind === "timeout") {
      await runStep(`comp-timeout:${ctag}`, () => markStepCompensationFailed(env, instanceId, step));
      return "failed";
    }
    // loop re-reads the (now terminal) comp job
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
