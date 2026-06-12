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
import { applyTransitionStmt, getInstanceRow, incidentStmt, type IncidentKind } from "../persistence/instances";
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

export async function parkWaiting(env: Env, instanceId: string, elementId: string, kind: "serviceTask" | "receiveTask"): Promise<void> {
  const inst = await loadInst(env, instanceId);
  // Idempotent re-park: a rewalk that lands on an already-parked wait frontier
  // (operator resume, duplicate drive) is WRITE-FREE — never duplicate the
  // serviceTaskWaiting audit event or touch the cursor it would re-set.
  if (inst.status === "waiting" && inst.current_element_id === elementId) return;
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

/** Workflow-driver fallback: a terminal/uncaught failure becomes a view-only incident. */
export async function recordTerminalIncident(env: Env, instanceId: string, reason: string): Promise<void> {
  const inst = await getInstanceRow(env.DB, instanceId);
  if (!inst || isTerminalInstanceStatus(inst.status)) return;
  await createIncident(env, instanceId, inst.current_element_id ?? "unknown", 0, reason, {}, "serviceTaskFailure");
}
