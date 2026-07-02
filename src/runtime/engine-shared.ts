// Shared engine seams (M3-L0 extraction, TASK-38).
//
// Small internal module holding the types + helpers that the engine walk/dispatch
// core (engine.ts) and the extracted node-kind modules (forward-task.ts,
// compensation.ts, incidents.ts) all depend on. Lifted here so those modules can
// import the shared pieces without a cycle back through engine.ts. Behavior-frozen
// move of the original engine.ts definitions — no semantic change.

import type { Env } from "../env";
import type { ExecutionGraph } from "../bpmn/graph";
import { getInstanceRow, type InstanceRow } from "../persistence/instances";
import { scopesOf } from "../bpmn/scope-tree";

export type RunStep = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
// `parked` is a VESTIGIAL WaitOutcome member: it was the M4-L3 multi-wait sentinel
// returned by the collecting waitFor, but TASK-54 collapsed onto a single bpmn_wake
// (the leaf drivers PARK and never suspend), so the multi-wait race machinery
// (WaitCollector / collectingWaitFor / raceParkedWaits) was removed. No code path
// now produces `parked`; the member is left in the union as a harmless no-op.
export type WaitOutcome = { kind: "event"; payload: unknown } | { kind: "timeout" } | { kind: "parked" };
export type WaitForEvent = (sub: {
  name: string;
  workflowEventType: string;
  timeout: string;
}) => Promise<WaitOutcome>;

export type DriveStatus = "completed" | "waiting" | "incident";
export interface DriveResult {
  status: DriveStatus;
}

// M5-L1 (Task 8): a nested cancel-end reverse pass settles NON-terminally — after
// compensating its own subtree the instance CONTINUES on the cancel boundary's
// failure path. `settleAfterCompensation` returns this extra `continue` shape so
// the walk / frontier / resume sites route the cursor to `next` instead of
// returning a terminal DriveResult. A top-level (process-root) settle is terminal
// and still returns a plain DriveResult.
export type SettleResult = DriveResult | { status: "continue"; next: string };

export async function loadInst(env: Env, instanceId: string): Promise<InstanceRow> {
  const row = await getInstanceRow(env.DB, instanceId);
  if (!row) throw new Error(`Process instance ${instanceId} not found`);
  return row;
}

export function isTransactionScope(graph: ExecutionGraph, scopeId: string | null | undefined): scopeId is string {
  return !!scopeId && graph.nodes[scopeId]?.type === "transaction";
}

/** Kind of the given scope id, or null at process level. Legacy graphs resolve transactions only. */
export function scopeKindOf(graph: ExecutionGraph, scopeId: string | null | undefined): "transaction" | "subProcess" | null {
  if (!scopeId) return null;
  const kind = scopesOf(graph)[scopeId]?.kind;
  return kind === "transaction" || kind === "subProcess" ? kind : graph.nodes[scopeId]?.type === "transaction" ? "transaction" : null;
}
