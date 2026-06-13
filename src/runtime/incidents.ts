// Completion + incident write helpers (M3-L0 extraction, TASK-38).
//
// The terminal/park/incident write block lifted verbatim from engine.ts: the
// happy completion terminal (completeInstance), the durable-wait park
// (parkWaiting), the one-way incident settle (createIncident), and the
// Workflow-driver fallback (recordTerminalIncident). Behavior-frozen — every
// history event type, persisted shape, and status transition is unchanged.

import type { Env } from "../env";
import { isTerminalInstanceStatus, newId, nowIso, type JsonObject } from "../util";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import { applyTransitionStmt, getForwardJob, getInstanceRow, getSubscriptionForVisit, incidentStmt, type IncidentKind } from "../persistence/instances";
import { loadInst } from "./engine-shared";

export async function completeInstance(env: Env, instanceId: string, elementId: string): Promise<void> {
  const inst = await loadInst(env, instanceId);
  if (isTerminalInstanceStatus(inst.status)) return;
  const now = nowIso();
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "elementEntered", diagnostics: { elementType: "endEvent" } }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "instanceCompleted", diagnostics: {} }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "completed", completedAt: now, now }),
  ]);
}

export async function parkWaiting(env: Env, instanceId: string, elementId: string, occ: number, kind: "serviceTask" | "receiveTask"): Promise<void> {
  const inst = await loadInst(env, instanceId);
  // Idempotent re-park (M4 per-token): a rewalk landing on an already-parked wait
  // is WRITE-FREE. Guard on the LIVE per-(element,occurrence) row, never the scalar
  // current_element_id (a sibling token may have moved it — design §5.3).
  const job = kind === "serviceTask" ? await getForwardJob(env.DB, instanceId, elementId, occ) : null;
  const sub = kind === "receiveTask" ? await getSubscriptionForVisit(env.DB, instanceId, elementId, occ) : null;
  const alreadyParked = inst.status === "waiting" &&
    ((kind === "serviceTask" && job && (job.status === "created" || job.status === "locked")) ||
     (kind === "receiveTask" && sub?.status === "active"));
  if (alreadyParked) return;
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "serviceTaskWaiting", diagnostics: { kind } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now: nowIso() }),
  ]);
}

export async function createIncident(
  env: Env,
  instanceId: string,
  elementId: string,
  retryCount: number,
  reason: string,
  diagnostics: JsonObject,
  kind: IncidentKind,
): Promise<{ kind: "incident" }> {
  const inst = await loadInst(env, instanceId);
  // One-way status table (§4.6): never regress a terminal or compensating
  // instance back to 'incident' (e.g. a 1-hour-late forward-wait timeout
  // resuming after an operator /cancel already moved the saga on).
  if (isTerminalInstanceStatus(inst.status) || inst.status === "compensating") {
    return { kind: "incident" };
  }
  const now = nowIso();
  const incidentId = newId("inc");
  const payloadContext: JsonObject = { reason, ...diagnostics };
  await dbBatch(env.DB, [
    incidentStmt(env.DB, { incidentId, instanceId, elementId, reason, retryCount, kind, resolution: "open", payloadContext, now }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "incidentCreated", diagnostics: { incidentId, reason, retryCount, kind }, payloadSnapshot: payloadContext }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "incident", now }),
  ]);
  return { kind: "incident" };
}

/**
 * CONCURRENCY caps (M4-L6, design §9). Both are terminal, view-only incidents
 * (the §8.5 generalised cohort capture freezes any live sibling tokens). They are
 * claimed once via the one-way `createIncident` (idempotent on replay):
 *  - concurrencyLimit — a split fan-out would exceed MAX_CONCURRENT_TOKENS live
 *    tokens (counted from the in-memory frontier, never a SQL COUNT).
 *  - stepBudget — the per-drive cumulative runStep/waitForEvent counter crossed
 *    STEP_BUDGET_SOFT, BELOW the platform step ceiling, so a hot parallel×loop
 *    shape degrades gracefully instead of becoming an opaque errored Workflow.
 */
export async function raiseConcurrencyLimit(env: Env, instanceId: string, splitId: string, cap: number): Promise<{ kind: "incident" }> {
  return createIncident(
    env,
    instanceId,
    splitId,
    0,
    `Fan-out at '${splitId}' exceeded the live-token cap (${cap} concurrent tokens).`,
    { splitId, cap },
    "concurrencyLimit",
  );
}

export async function raiseStepBudget(env: Env, instanceId: string, elementId: string, budget: number, steps: number): Promise<{ kind: "incident" }> {
  return createIncident(
    env,
    instanceId,
    elementId,
    0,
    `Engine step budget exceeded (${steps} > ${budget}) at '${elementId}' — settled as a graceful incident below the platform step ceiling.`,
    { elementId, budget, steps },
    "stepBudget",
  );
}

/** Workflow-driver fallback: a terminal/uncaught failure becomes a view-only incident. */
export async function recordTerminalIncident(env: Env, instanceId: string, reason: string): Promise<void> {
  const inst = await getInstanceRow(env.DB, instanceId);
  if (!inst || isTerminalInstanceStatus(inst.status)) return;
  await createIncident(env, instanceId, inst.current_element_id ?? "unknown", 0, reason, {}, "serviceTaskFailure");
}
