// execution_tokens read-model + join facts (M4-L2/L3). Statement builders + reads.
// execution_tokens.position_element_id/status are NEVER a replay input; the join
// facts (join_arrivals INSERT OR IGNORE, join_completions PLAIN INSERT) are.

import { dbAll, dbFirst, stmt } from "./db";
import { parseJson, toJson, type JsonObject } from "../util";

export type TokenStatus = "active" | "waiting" | "arrivedAtJoin" | "consumed" | "merged" | "discarded";
export const LIVE_TOKEN_STATUSES: TokenStatus[] = ["active", "waiting", "arrivedAtJoin"];

export interface TokenRow {
  token_id: string;
  instance_id: string;
  region_id: string | null;
  region_activation: number;
  parent_token_id: string | null;
  branch_flow_id: string | null;
  position_element_id: string;
  status: string;
  variables_overlay: string;
  created_at: string;
  updated_at: string;
}

export const rootTokenId = (instanceId: string) => `${instanceId}:#root`;
export const branchTokenId = (instanceId: string, splitId: string, activation: number, branchFlowId: string) =>
  `${instanceId}:${splitId}#${activation}:${branchFlowId}`;

export function parseTokenId(tokenId: string): { kind: "root" } | { kind: "branch"; splitId: string; activation: number; branchFlowId: string } | { kind: "unknown" } {
  const rest = tokenId.slice(tokenId.indexOf(":") + 1);
  if (rest === "#root") return { kind: "root" };
  const m = rest.match(/^(.+)#(\d+):(.+)$/);
  if (m) return { kind: "branch", splitId: m[1]!, activation: Number(m[2]), branchFlowId: m[3]! };
  return { kind: "unknown" };
}

/** Upsert a token row (read-model). Position/status are derived; safe to overwrite. */
export function upsertTokenStmt(db: D1Database, input: {
  tokenId: string; instanceId: string; regionId?: string | null; regionActivation?: number;
  parentTokenId?: string | null; branchFlowId?: string | null; positionElementId: string;
  status: TokenStatus; variablesOverlay?: JsonObject; now: string;
}): D1PreparedStatement {
  return stmt(db,
    `INSERT INTO execution_tokens
       (token_id, instance_id, region_id, region_activation, parent_token_id, branch_flow_id, position_element_id, status, variables_overlay, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token_id) DO UPDATE SET position_element_id = excluded.position_element_id, status = excluded.status, updated_at = excluded.updated_at`,
    [input.tokenId, input.instanceId, input.regionId ?? null, input.regionActivation ?? 0, input.parentTokenId ?? null,
     input.branchFlowId ?? null, input.positionElementId, input.status, toJson(input.variablesOverlay ?? {}), input.now, input.now]);
}

/** Plain INSERT of a branch token at split fan-out (design §5.4): the token_id PK is the race claim. */
export function insertBranchTokenStmt(db: D1Database, input: {
  tokenId: string; instanceId: string; regionId: string; regionActivation: number;
  parentTokenId: string; branchFlowId: string; positionElementId: string; variablesOverlay: JsonObject; now: string;
}): D1PreparedStatement {
  return stmt(db,
    `INSERT INTO execution_tokens
       (token_id, instance_id, region_id, region_activation, parent_token_id, branch_flow_id, position_element_id, status, variables_overlay, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [input.tokenId, input.instanceId, input.regionId, input.regionActivation, input.parentTokenId,
     input.branchFlowId, input.positionElementId, toJson(input.variablesOverlay), input.now, input.now]);
}

export function setTokenStatusStmt(db: D1Database, tokenId: string, status: TokenStatus, now: string): D1PreparedStatement {
  return stmt(db, `UPDATE execution_tokens SET status = ?, updated_at = ? WHERE token_id = ?`, [status, now, tokenId]);
}

/**
 * Fold a merged overlay onto an EXISTING token row (M4-L3, design §5.7/§6): the
 * join-time produce of a NESTED region re-uses its enclosing-branch token and
 * must overwrite that token's `variables_overlay` with the merged result —
 * which `upsertTokenStmt`'s ON CONFLICT deliberately does NOT touch (so the
 * post-drive read-model sync can never clobber a branch's accumulated writes).
 * A plain UPDATE keyed by token_id; sets overlay + position + status='active'.
 */
export function foldTokenOverlayStmt(db: D1Database, input: { tokenId: string; positionElementId: string; variablesOverlay: JsonObject; now: string }): D1PreparedStatement {
  return stmt(db,
    `UPDATE execution_tokens SET variables_overlay = ?, position_element_id = ?, status = 'active', updated_at = ? WHERE token_id = ?`,
    [toJson(input.variablesOverlay), input.positionElementId, input.now, input.tokenId]);
}

/** Set a token's overlay only (M4-L3): a forward service task in a branch writes its output to the token's own scope. */
export function setTokenOverlayStmt(db: D1Database, tokenId: string, variablesOverlay: JsonObject, now: string): D1PreparedStatement {
  return stmt(db, `UPDATE execution_tokens SET variables_overlay = ?, updated_at = ? WHERE token_id = ?`, [toJson(variablesOverlay), now, tokenId]);
}

export async function getToken(db: D1Database, tokenId: string): Promise<TokenRow | null> {
  return dbFirst<TokenRow>(db, `SELECT * FROM execution_tokens WHERE token_id = ?`, [tokenId]);
}
export async function listTokens(db: D1Database, instanceId: string): Promise<TokenRow[]> {
  return dbAll<TokenRow>(db, `SELECT * FROM execution_tokens WHERE instance_id = ? ORDER BY rowid`, [instanceId]);
}
export async function listLiveTokens(db: D1Database, instanceId: string): Promise<TokenRow[]> {
  return dbAll<TokenRow>(db, `SELECT * FROM execution_tokens WHERE instance_id = ? AND status IN ('active','waiting','arrivedAtJoin') ORDER BY rowid`, [instanceId]);
}
export const parseOverlay = (row: TokenRow): JsonObject => parseJson<JsonObject>(row.variables_overlay, {});

// ---- join facts ----
export function insertJoinArrivalStmt(db: D1Database, input: { instanceId: string; joinId: string; activation: number; branchFlowId: string; now: string }): D1PreparedStatement {
  return stmt(db, `INSERT OR IGNORE INTO join_arrivals (instance_id, join_id, activation, branch_flow_id, arrived_at) VALUES (?, ?, ?, ?, ?)`,
    [input.instanceId, input.joinId, input.activation, input.branchFlowId, input.now]);
}
export function insertJoinCompletionStmt(db: D1Database, input: { instanceId: string; joinId: string; activation: number; producedTokenId: string; now: string }): D1PreparedStatement {
  return stmt(db, `INSERT INTO join_completions (instance_id, join_id, activation, produced_token_id, decided_at) VALUES (?, ?, ?, ?, ?)`,
    [input.instanceId, input.joinId, input.activation, input.producedTokenId, input.now]);
}
export async function getJoinArrivals(db: D1Database, instanceId: string, joinId: string, activation: number): Promise<string[]> {
  const rows = await dbAll<{ branch_flow_id: string }>(db, `SELECT branch_flow_id FROM join_arrivals WHERE instance_id = ? AND join_id = ? AND activation = ?`, [instanceId, joinId, activation]);
  return rows.map((r) => r.branch_flow_id);
}
export async function getJoinCompletion(db: D1Database, instanceId: string, joinId: string, activation: number): Promise<{ produced_token_id: string } | null> {
  return dbFirst<{ produced_token_id: string }>(db, `SELECT produced_token_id FROM join_completions WHERE instance_id = ? AND join_id = ? AND activation = ?`, [instanceId, joinId, activation]);
}
