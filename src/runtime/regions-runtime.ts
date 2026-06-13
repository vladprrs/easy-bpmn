// Concurrent-region runtime (M4-L3/L4): split fan-out, join arrival/completion
// claim, and the deterministic merge-at-join. All race-claimed via a plain INSERT
// into join_completions composed in the advance batch (the gateway_decisions
// discipline, gateway-decisions.ts:70-84). execution_tokens is a read-model; the
// join facts (join_arrivals / join_completions) are the truth.

import type { Env } from "../env";
import type { ExecutionGraph, RegionInfo } from "../bpmn/graph";
import { mergeVariables, nowIso, parseJson, type JsonObject } from "../util";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import { applyTransitionStmt } from "../persistence/instances";
import { getGatewayDecision } from "../persistence/gateway-decisions";
import {
  branchTokenId,
  foldTokenOverlayStmt,
  getJoinArrivals,
  getJoinCompletion,
  getToken,
  insertBranchTokenStmt,
  insertJoinArrivalStmt,
  insertJoinCompletionStmt,
  parseOverlay,
  rootTokenId,
  setTokenStatusStmt,
  upsertTokenStmt,
} from "../persistence/tokens";
import { loadInst } from "./engine-shared";

/**
 * Deterministic merge (design §5.7): start from the parent overlay, then for each
 * required branch in split-out-flow DOCUMENT order (`order` = the region's stored
 * `branchFlowIds`), shallow-assign its top-level keys (later branch wins). The
 * `branches` array may be a SUBSET (an OR join) and may be in any array order —
 * the stored `order` alone fixes precedence. Shallow (top-level union), matching
 * `mergeVariables`.
 */
export function mergeBranchOverlays(
  parentOverlay: JsonObject,
  order: string[],
  branches: { branchFlowId: string; overlay: JsonObject }[],
): JsonObject {
  const byFlow = new Map(branches.map((b) => [b.branchFlowId, b.overlay]));
  let merged: JsonObject = { ...parentOverlay };
  for (const flowId of order) {
    const ov = byFlow.get(flowId);
    if (ov) merged = mergeVariables(merged, ov);
  }
  return merged;
}

/**
 * The branch flows ACTIVATED at a split. AND (design §5.4): always all the
 * region's out-flows (the static `branchFlowIds`). OR (L4): the recorded
 * `gateway_decisions.activated_flow_ids` subset — not yet implemented here, so an
 * OR region throws until L4 fills it in.
 */
export async function resolveActivatedFlows(env: Env, _graph: ExecutionGraph, instanceId: string, region: RegionInfo, splitId: string, occ: number): Promise<string[]> {
  if (region.type === "and") return region.branchFlowIds;
  // OR — recorded activation subset (M4-L4). For L3 (AND-only) this is unreachable.
  const recorded = await getGatewayDecision(env.DB, instanceId, splitId, occ);
  if (recorded) return recorded.evaluations.length ? region.branchFlowIds.filter((f) => recorded.chosenFlowId === f || recorded.evaluations.some((e) => e.flowId === f && e.result)) : [recorded.chosenFlowId];
  throw new Error(`inclusiveGateway split '${splitId}' activation is M4-L4 work (OR not yet runtime-enabled).`);
}

/**
 * The branch flows REQUIRED at the join. AND: all `branchFlowIds`. OR (L4): the
 * recorded activated subset (origin-branch keyed, design §6). For L3 (AND) this
 * is the full set.
 */
export async function requiredFlowsFor(env: Env, graph: ExecutionGraph, instanceId: string, region: RegionInfo, splitOccurrence: number): Promise<string[]> {
  if (region.type === "and") return region.branchFlowIds;
  return resolveActivatedFlows(env, graph, instanceId, region, region.splitId, splitOccurrence);
}

/**
 * Fan out a split (design §5.4): plain-INSERT one branch token per activated flow,
 * composed with the `regionActivated` marker history + a `branchForked` event per
 * branch, in ONE dbBatch. The token_id PK is the race claim — a duplicate
 * concurrent fan-out aborts wholesale on the PK and re-reads. `region_activation`
 * = the split's walk-local occurrence (`activation`). Branch tokens start with an
 * empty overlay (a delta over the parent scope).
 */
export async function fanOutSplit(env: Env, instanceId: string, graph: ExecutionGraph, region: RegionInfo, splitId: string, activation: number, parentTokenId: string, activatedFlowIds: string[]): Promise<void> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const splitNode = graph.nodes[splitId]!;
  const stmts: D1PreparedStatement[] = [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: splitId, type: "regionActivated", diagnostics: { splitId, type: region.type, activation, activatedFlowIds } }),
  ];
  for (const flowId of activatedFlowIds) {
    const flow = splitNode.outgoing.find((f) => f.flowId === flowId)!;
    const tid = branchTokenId(instanceId, splitId, activation, flowId);
    stmts.push(
      insertBranchTokenStmt(env.DB, { tokenId: tid, instanceId, regionId: splitId, regionActivation: activation, parentTokenId, branchFlowId: flowId, positionElementId: flow.targetId, variablesOverlay: {}, now }),
      historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: splitId, type: "branchForked", diagnostics: { tokenId: tid, branchFlowId: flowId, target: flow.targetId, activation } }),
    );
  }
  await dbBatch(env.DB, stmts);
}

/** True once the split's branch tokens exist (the first activated flow's token), so a re-walk does not re-fan-out (the plain INSERT would abort on the PK). */
export async function splitAlreadyFannedOut(env: Env, instanceId: string, splitId: string, activation: number, activatedFlowIds: string[]): Promise<boolean> {
  if (activatedFlowIds.length === 0) return true;
  const first = await getToken(env.DB, branchTokenId(instanceId, splitId, activation, activatedFlowIds[0]!));
  return first !== null;
}

/** Record one branch's arrival at a join (design §5.4): INSERT OR IGNORE; a duplicate arrival is a no-op. The arriving branch token is flipped to `arrivedAtJoin`. */
export async function recordJoinArrival(env: Env, instanceId: string, joinId: string, activation: number, branchFlowId: string, branchTokenIdStr: string): Promise<void> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  await dbBatch(env.DB, [
    insertJoinArrivalStmt(env.DB, { instanceId, joinId, activation, branchFlowId, now }),
    setTokenStatusStmt(env.DB, branchTokenIdStr, "arrivedAtJoin", now),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: joinId, type: "branchArrivedAtJoin", diagnostics: { joinId, activation, branchFlowId, tokenId: branchTokenIdStr } }),
  ]);
}

/** Are all required branches present for this join activation? AND = all branchFlowIds; OR = the recorded activated subset (passed in). */
export async function joinBarrierSatisfied(env: Env, instanceId: string, joinId: string, activation: number, requiredFlowIds: string[]): Promise<boolean> {
  const arrived = new Set(await getJoinArrivals(env.DB, instanceId, joinId, activation));
  return requiredFlowIds.every((f) => arrived.has(f));
}

/**
 * Claim the join (design §5.4): a plain-INSERT of `join_completions` in the SAME
 * batch as the merged-overlay write, the contributing branch tokens → 'merged',
 * and the advance to the join's out-flow. A losing concurrent batch aborts on the
 * PK and re-reads the recorded produced token (fast-forward). Returns the produced
 * token's next element id (the join's single out-flow target, SESE).
 *
 * SESE (design §5.5): the region consumes the parent token at the split and
 * returns ONE token to the enclosing scope at the join — so the produced token
 * RE-USES `parentTokenId`. The merge fold-up (design §5.7/§6):
 *  - ROOT region → the base is `process_instances.variables` and the merge is
 *    written back up to it (the only place root vars mutate); the root token row
 *    is upserted to the post-join position with an empty overlay.
 *  - NESTED region → the base is the enclosing-branch (parent) token's overlay and
 *    the merge is folded onto THAT token's overlay (no root write).
 */
export async function claimJoinCompletion(env: Env, instanceId: string, graph: ExecutionGraph, region: RegionInfo, joinId: string, activation: number, requiredFlowIds: string[], parentTokenId: string): Promise<string> {
  const joinNode = graph.nodes[joinId]!;
  const outTarget = joinNode.outgoing[0]!.targetId; // a join has exactly one out-flow (SESE)
  const existing = await getJoinCompletion(env.DB, instanceId, joinId, activation);
  if (existing) return outTarget; // already produced → fast-forward

  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const isRoot = parentTokenId === rootTokenId(instanceId);
  const parent = await getToken(env.DB, parentTokenId);
  // Merge base: root region folds onto process_instances.variables; a nested
  // region folds onto its enclosing-branch token overlay (design §5.7/§6).
  const baseOverlay: JsonObject = isRoot
    ? parseJson<JsonObject>(inst.variables, {})
    : parent
      ? parseOverlay(parent)
      : {};
  // Gather the required branch tokens' overlays.
  const branchTokens: { branchFlowId: string; overlay: JsonObject; tokenId: string }[] = [];
  for (const flowId of requiredFlowIds) {
    const tid = branchTokenId(instanceId, region.splitId, activation, flowId);
    const row = await getToken(env.DB, tid);
    branchTokens.push({ branchFlowId: flowId, overlay: row ? parseOverlay(row) : {}, tokenId: tid });
  }
  const mergedOverlay = mergeBranchOverlays(baseOverlay, region.branchFlowIds, branchTokens);

  const stmts: D1PreparedStatement[] = [
    insertJoinCompletionStmt(env.DB, { instanceId, joinId, activation, producedTokenId: parentTokenId, now }), // THE CLAIM
    ...branchTokens.map((b) => setTokenStatusStmt(env.DB, b.tokenId, "merged", now)),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: joinId, type: "joinCompleted", diagnostics: { joinId, activation, producedTokenId: parentTokenId, contributingTokenIds: branchTokens.map((b) => b.tokenId), outTarget } }),
  ];
  if (isRoot) {
    // Produced token = root: re-position the root token (overlay stays empty —
    // root vars live in process_instances.variables) and fold the merge up.
    stmts.push(
      upsertTokenStmt(env.DB, { tokenId: parentTokenId, instanceId, regionId: null, regionActivation: 0, parentTokenId: null, branchFlowId: null, positionElementId: outTarget, status: "active", variablesOverlay: {}, now }),
      applyTransitionStmt(env.DB, { instanceId, variables: mergedOverlay, currentElementId: outTarget, status: "running", now }),
    );
  } else {
    // Produced token = the enclosing-branch (parent) token: fold the merge onto
    // ITS overlay; no root variable write (design §6 nested placement).
    stmts.push(
      foldTokenOverlayStmt(env.DB, { tokenId: parentTokenId, positionElementId: outTarget, variablesOverlay: mergedOverlay, now }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: null, status: "running", now }),
    );
  }
  // Plain-INSERT race contract (design §5.4, the gateway_decisions discipline): the
  // join_completions PK is the claim. The per-instance drive lock serialises drives,
  // but under extreme contention it proceeds unlocked (drive-lock.ts) — so a losing
  // concurrent batch's UNIQUE violation aborts this ENTIRE batch (the produced-token
  // write + advance included); re-read the winner and fast-forward, never double-produce.
  try {
    await dbBatch(env.DB, stmts);
  } catch (err) {
    if (isUniqueConstraintViolation(err) && (await getJoinCompletion(env.DB, instanceId, joinId, activation))) {
      return outTarget;
    }
    throw err;
  }
  return outTarget;
}

/** A D1 UNIQUE-constraint violation (the plain-INSERT race loser); mirrors engine.ts. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE/i.test(err.message);
}

export { getToken, parseOverlay };
