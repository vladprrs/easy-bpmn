// Active-subscription release helpers (M4-L5 TASK-52 whole-instance release,
// relocated + extended to a scope-subtree equivalent by M5-L1 follow-up TASK-72).
// Kept as runtime code (not index.ts) so both the HTTP operator-cancel handler
// AND the engine's scope drain can call it without a route-layer dependency;
// the M5-L2 plan (callActivity) needs this importable from runtime code too.

import type { Env } from "../env";
import type { ExecutionGraph } from "../bpmn/graph";
import { listActiveSubscriptionsForInstance, subscriptionSupersededStmt } from "../persistence/instances";
import { supersedeBrokerSubscription } from "./boundary-timer";
import { subtreeScopeIds } from "../bpmn/scope-tree";

/**
 * Frontier-wide broker release (M4-L5, design §8.1): supersede every ACTIVE message
 * subscription of an instance on cancel — a best-effort broker supersede per key (so a
 * late publish gets the stable buffered/no-match outcome) + the `active → superseded`
 * D1 flip. Prevents a leaked broker key when a region cohort token parked at a message
 * catch is abandoned without eagerly failing its forward work.
 */
export async function releaseActiveSubscriptionsForInstance(env: Env, instanceId: string, now: string): Promise<void> {
  for (const sub of await listActiveSubscriptionsForInstance(env.DB, instanceId)) {
    // Per-subscription best-effort: one release failure (broker hiccup or D1 error)
    // must NOT abort the cancel before the status transition + resumeInline, which
    // would strand the instance. A leaked broker key is recoverable via its TTL;
    // a stuck cancel is not.
    try {
      await supersedeBrokerSubscription(env, sub);
      await subscriptionSupersededStmt(env.DB, sub.subscription_id, now).run();
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", message: "releaseActiveSubscription failed", subscriptionId: sub.subscription_id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}

/**
 * The scoped equivalent of `releaseActiveSubscriptionsForInstance` (TASK-72, M5-L1
 * follow-up): release only the ACTIVE subscriptions whose owning element lives in
 * `subtreeScopeIds(graph, rootScopeId)` — the same subtree `drainScopeSubtree`
 * settles. `rootScopeId = null` means the whole process, matching that contract.
 * Called from `drainScopeSubtree`'s per-token settle so an abnormal-exit drain
 * (error bubbling, timer fire, cancel) never strands a receiveTask/message-catch
 * subscription's broker key inside the drained subtree until the 1-hour TTL.
 */
export async function releaseSubscriptionsInScopeSubtree(
  env: Env,
  graph: ExecutionGraph,
  instanceId: string,
  rootScopeId: string | null,
  now: string,
): Promise<void> {
  const subtree = subtreeScopeIds(graph, rootScopeId);
  for (const sub of await listActiveSubscriptionsForInstance(env.DB, instanceId)) {
    const subScope = graph.nodes[sub.element_id]?.scopeId ?? null;
    const inSubtree = subScope == null ? rootScopeId == null : subtree.includes(subScope);
    if (!inSubtree) continue;
    // Best-effort, mirroring releaseActiveSubscriptionsForInstance: one broker/D1
    // hiccup must not abort the drain — a leaked broker key self-heals via the TTL.
    try {
      await supersedeBrokerSubscription(env, sub);
      await subscriptionSupersededStmt(env.DB, sub.subscription_id, now).run();
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", message: "releaseSubscriptionsInScopeSubtree failed", subscriptionId: sub.subscription_id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}
