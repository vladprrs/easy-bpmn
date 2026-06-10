// gateway_decisions — the persisted XOR branch record (M2 design §6). A row is
// written INSERT OR IGNORE atomically with the transition out of the gateway
// (persist-before-advance), so crash/replay REUSES the recorded branch and never
// re-evaluates conditions. Keyed per loop iteration by (instance_id, element_id,
// occurrence). Statement builders only; branch selection lives in the engine.

import { dbFirst, stmt } from "./db";
import { parseJson, toJson, type JsonObject } from "../util";

/** One condition evaluation, recorded in document order (= evaluation order). */
export interface GatewayFlowEvaluation {
  flowId: string;
  expression: string;
  result: boolean;
}

export interface GatewayDecisionRow {
  decision_id: string;
  instance_id: string;
  element_id: string;
  occurrence: number;
  chosen_flow_id: string;
  is_default: number;
  evaluations: string;
  variables_snapshot: string | null;
  created_at: string;
}

export interface GatewayDecisionView {
  decisionId: string;
  instanceId: string;
  elementId: string;
  occurrence: number;
  chosenFlowId: string;
  isDefault: boolean;
  evaluations: GatewayFlowEvaluation[];
  variablesSnapshot: JsonObject | null;
  createdAt: string;
}

export function mapGatewayDecision(row: GatewayDecisionRow): GatewayDecisionView {
  return {
    decisionId: row.decision_id,
    instanceId: row.instance_id,
    elementId: row.element_id,
    occurrence: row.occurrence,
    chosenFlowId: row.chosen_flow_id,
    isDefault: row.is_default === 1,
    evaluations: parseJson<GatewayFlowEvaluation[]>(row.evaluations, []),
    variablesSnapshot: row.variables_snapshot
      ? parseJson<JsonObject>(row.variables_snapshot, {})
      : null,
    createdAt: row.created_at,
  };
}

/**
 * INSERT OR IGNORE the branch decision — composed into the SAME dbBatch as the
 * transition to the chosen target (persist-before-advance). A duplicate
 * (instance_id, element_id, occurrence) is ignored: the first recorded decision
 * is authoritative and replay must take it, not re-evaluate.
 */
export function insertGatewayDecisionStmt(
  db: D1Database,
  input: {
    decisionId: string;
    instanceId: string;
    elementId: string;
    occurrence: number;
    chosenFlowId: string;
    /** True when the gateway's `default` flow was taken (no condition matched). */
    isDefault: boolean;
    /** Per-flow evaluations in document order; [] when fast-forwarding/default-only. */
    evaluations: GatewayFlowEvaluation[];
    /** Evaluation context snapshot; size-capped by the payload limit. */
    variablesSnapshot: JsonObject | null;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT OR IGNORE INTO gateway_decisions
       (decision_id, instance_id, element_id, occurrence, chosen_flow_id, is_default, evaluations, variables_snapshot, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.decisionId,
      input.instanceId,
      input.elementId,
      input.occurrence,
      input.chosenFlowId,
      input.isDefault ? 1 : 0,
      toJson(input.evaluations),
      input.variablesSnapshot ? toJson(input.variablesSnapshot) : null,
      input.now,
    ],
  );
}

/**
 * The recorded decision for one gateway visit, or null if this iteration has
 * not decided yet. The engine's gateway step checks this FIRST (design §6.1) —
 * an existing row is fast-forward, never re-evaluation.
 */
export async function getGatewayDecision(
  db: D1Database,
  instanceId: string,
  elementId: string,
  occurrence: number,
): Promise<GatewayDecisionView | null> {
  const row = await dbFirst<GatewayDecisionRow>(
    db,
    `SELECT * FROM gateway_decisions WHERE instance_id = ? AND element_id = ? AND occurrence = ?`,
    [instanceId, elementId, occurrence],
  );
  return row ? mapGatewayDecision(row) : null;
}
