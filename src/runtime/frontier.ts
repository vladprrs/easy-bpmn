// In-memory token frontier (M4-L2 seed; L3 grows it to the deterministic DFS).
//
// L2: derive the single root token from the instance (one live position). L3
// replaces reconstructFrontier with a depth-first re-walk from startElementId that
// descends each split's outgoing[] in DOCUMENT ORDER, fast-forwarding applied
// visits write-free and forking at splits.

import type { Env } from "../env";
import type { ExecutionGraph } from "../bpmn/graph";
import { isTerminalInstanceStatus, nowIso, type JsonObject } from "../util";
import { dbBatch } from "../persistence/db";
import { rootTokenId, upsertTokenStmt, setTokenStatusStmt, listLiveTokens, getToken, parseOverlay } from "../persistence/tokens";
import { loadInst } from "./engine-shared";

export interface Token {
  tokenId: string;
  positionElementId: string;
  occurrence: number;
  regionId: string | null;
  regionActivation: number;
  branchFlowId: string | null;
  parentTokenId: string | null;
}

/** L2: the single live token derived from the instance cursor (or [] when terminal/at end). */
export async function reconstructFrontier(env: Env, graph: ExecutionGraph, instanceId: string): Promise<Token[]> {
  const inst = await loadInst(env, instanceId);
  if (isTerminalInstanceStatus(inst.status)) return [];
  const pos = inst.current_element_id;
  if (!pos || !graph.nodes[pos]) return [];
  return [{ tokenId: rootTokenId(instanceId), positionElementId: pos, occurrence: 0, regionId: null, regionActivation: 0, branchFlowId: null, parentTokenId: null }];
}

/**
 * Resolve a token's effective variable scope (design §5.7): root variables with
 * each ancestor token's overlay layered on, root→token, NEAREST WINS. The root
 * token resolves to `rootVars` verbatim (its overlay is conceptually empty — root
 * vars live in process_instances.variables), preserving the exact M0–M3 read path.
 * A cycle guard bounds a malformed parent chain.
 */
export async function resolveScope(env: Env, instanceId: string, rootVars: JsonObject, tokenId: string): Promise<JsonObject> {
  if (tokenId === rootTokenId(instanceId)) return rootVars;
  // Collect overlays token→root, then apply root→token so the nearest overlay wins.
  const chain: JsonObject[] = [];
  let cur: string | null = tokenId;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const row = await getToken(env.DB, cur);
    if (!row) break;
    chain.push(parseOverlay(row));
    cur = row.parent_token_id;
  }
  let scope: JsonObject = { ...rootVars };
  for (let i = chain.length - 1; i >= 0; i--) scope = { ...scope, ...chain[i]! };
  return scope;
}

/** Write the read-model after a drive: upsert the frontier's tokens; mark vanished live tokens consumed. */
export async function syncFrontierReadModel(env: Env, instanceId: string, frontier: Token[]): Promise<void> {
  const now = nowIso();
  const live = await listLiveTokens(env.DB, instanceId);
  const stmts: D1PreparedStatement[] = [];
  const present = new Set<string>();
  for (const t of frontier) {
    present.add(t.tokenId);
    stmts.push(upsertTokenStmt(env.DB, {
      tokenId: t.tokenId, instanceId, regionId: t.regionId, regionActivation: t.regionActivation,
      parentTokenId: t.parentTokenId, branchFlowId: t.branchFlowId, positionElementId: t.positionElementId, status: "active", now,
    }));
  }
  for (const r of live) if (!present.has(r.token_id)) stmts.push(setTokenStatusStmt(env.DB, r.token_id, "consumed", now));
  if (stmts.length) await dbBatch(env.DB, stmts);
}
