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

export type RunStep = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
// `parked` is the M4-L3 multi-wait sentinel: in a region graph in WORKFLOW mode the
// frontier driver hands each leaf a COLLECTING waitFor that registers the wait in
// the drive's WaitCollector and returns `parked` instead of suspending — the driver
// returns 'waiting' and the post-DFS `raceParkedWaits` issues one Promise.race over
// every collected wait (design §5.2). Direct mode (waitFor=null) never sees it.
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

export const SVC_WAIT_TIMEOUT = "1 hour";

export async function loadInst(env: Env, instanceId: string): Promise<InstanceRow> {
  const row = await getInstanceRow(env.DB, instanceId);
  if (!row) throw new Error(`Process instance ${instanceId} not found`);
  return row;
}

export function isTransactionScope(graph: ExecutionGraph, scopeId: string | null | undefined): scopeId is string {
  return !!scopeId && graph.nodes[scopeId]?.type === "transaction";
}
