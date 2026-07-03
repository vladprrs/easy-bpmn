// Cascading child cancel (M5-L2 callActivity, Task 8). A callActivity CHILD is
// its own process instance with its own Workflow — when the containing scope of
// the callActivity that invoked it drains abnormally (a boundary-timer Hazard,
// an error-bubble scope exit, or an operator /cancel) every live descendant
// (transitively — grandchildren, great-grandchildren, bounded at publish time by
// MAX_CALL_DEPTH) must be cancelled too, or its Workflow and any in-flight
// forward work would keep running unobserved by the now-abandoned parent.
//
// Kept as its own leaf module — not folded into call-activity.ts or
// compensation.ts — so BOTH can call it without a cycle: call-activity.ts
// already imports compensation.ts (`drainScopeSubtree`, for the scope-caught
// error route), and `drainScopeSubtree` itself needs to cascade-cancel
// callActivity children (this task's drain-site hook) — a direct
// compensation.ts <-> call-activity.ts edge would cycle. This module depends on
// neither, mirroring the instance-release.ts extraction (TASK-52/TASK-72).
//
// Hazard semantics (deliberate, mirrors the M5-L1 scope-timer Hazard-vs-Cancel
// split): `cancelChildCascade` NEVER compensates — it abandons in-flight work
// and CAS's the child terminal, RETAINING its saga ledger untouched. Retention,
// not compensation, is the drain contract here; Task 9's reverse pass walks the
// PARENT's own ledger (including the retained child step), not the child's.

import type { Env } from "../env";
import type { ExecutionGraph } from "../bpmn/graph";
import { isTerminalInstanceStatus, nowIso } from "../util";
import { historyStmt } from "../persistence/history";
import { getInstanceRow, transitionStatusGuarded } from "../persistence/instances";
import { abandonActiveForwardJobs } from "../persistence/jobs";
import { listChildrenByElement, listChildrenOfInstance } from "../persistence/child-instances";
import { subtreeScopeIds } from "../bpmn/scope-tree";
import { cancelArmedTimersForInstance } from "./boundary-timer";
import { releaseActiveSubscriptionsForInstance } from "./instance-release";
import { getExecutor } from "./executor";

/** A status from which a child must never be cancelled/regressed: already
 *  terminal, or already mid its OWN reverse compensation pass. */
function isCancelIneligible(status: string): boolean {
  return isTerminalInstanceStatus(status) || status === "compensating";
}

/**
 * Depth-first recursive cancel of a NON-terminal child (Task 8): its own
 * non-terminal children (grandchildren) are cancelled FIRST — so a Workflow is
 * never terminated while it still has a live descendant of its own — then this
 * child's in-flight forward work is abandoned, any held message subscription is
 * released (defensive: v1's publish-time validator already rejects a message
 * wait anywhere in a call tree), its armed boundary timers are disarmed, its
 * Workflow is terminated, and its status is CAS'd
 * `{starting,running,waiting,incident} → cancelled`. A terminal or already-
 * `compensating` child short-circuits immediately (never regressed) — making a
 * re-drive that lands on an already-cancelled child a single cheap read
 * (at-least-once safe, idempotent). The saga ledger is left untouched
 * (retention, not compensation — see module header).
 */
export async function cancelChildCascade(env: Env, childInstanceId: string): Promise<void> {
  const child = await getInstanceRow(env.DB, childInstanceId);
  if (!child || isCancelIneligible(child.status)) return;
  for (const gc of await listChildrenOfInstance(env.DB, childInstanceId)) {
    await cancelChildCascade(env, gc.child_instance_id);
  }
  const now = nowIso();
  await abandonActiveForwardJobs(env.DB, childInstanceId, now);
  await releaseActiveSubscriptionsForInstance(env, childInstanceId, now);
  await cancelArmedTimersForInstance(env, childInstanceId);
  await getExecutor(env).terminate(childInstanceId);
  const changed = await transitionStatusGuarded(env.DB, childInstanceId, ["starting", "running", "waiting", "incident"], "cancelled", now);
  if (changed > 0) {
    await historyStmt(env.DB, {
      workspaceId: child.workspace_id,
      instanceId: childInstanceId,
      elementId: child.parent_element_id ?? "",
      type: "instanceCancelled",
      diagnostics: { by: "parentDrain" },
    }).run();
  }
}

/**
 * Cancel every non-terminal callActivity CHILD invoked by an element whose
 * scope lives in `subtreeScopeIds(graph, rootScopeId)` (`rootScopeId=null` =
 * every scope in the process — the operator process-root /cancel shape). The
 * drain-site hook for a scope exit (`drainScopeSubtree`, compensation.ts) and
 * for an operator /cancel (`handleCancelInstance`, index.ts);
 * `cancelChildCascade`'s own recursion then reaches every grandchild
 * transitively. Idempotent: a re-run (a second drain over the same subtree, a
 * retried step) finds every child already cancelled/terminal and
 * short-circuits per row.
 */
export async function cancelChildrenInSubtree(env: Env, graph: ExecutionGraph, instanceId: string, rootScopeId: string | null): Promise<void> {
  const subtree = rootScopeId == null ? null : new Set(subtreeScopeIds(graph, rootScopeId));
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.type !== "callActivity") continue;
    const nodeScope = node.scopeId ?? null;
    if (subtree != null && (nodeScope == null || !subtree.has(nodeScope))) continue;
    for (const c of await listChildrenByElement(env.DB, instanceId, id)) {
      await cancelChildCascade(env, c.child_instance_id);
    }
  }
}
