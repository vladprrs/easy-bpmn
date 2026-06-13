// gateway_decisions — the persisted XOR branch record (M2 design §6). A row is
// written with a plain INSERT atomically with the transition out of the gateway
// (persist-before-advance), so crash/replay REUSES the recorded branch and never
// re-evaluates conditions. Keyed per loop iteration by (instance_id, element_id,
// occurrence). Statement builders only; branch selection lives in the engine.

import { dbFirst, stmt } from "./db";
import { parseJson, toJson, type JsonObject } from "../util";

/**
 * One condition evaluation, recorded in document order (= evaluation order).
 * Only flows ACTUALLY evaluated appear: selection short-circuits at the first
 * `true`, so flows after the winner (and the never-evaluated default) are
 * absent by design — the record is the evaluation trace, not the flow list.
 */
export interface GatewayFlowEvaluation {
  flowId: string;
  expression: string;
  /** True only when the expression evaluated to boolean `true` (strict contract). */
  result: boolean;
  /**
   * The raw FEEL result, made JSON-safe by `normalizeFeelValue`
   * (runtime/expressions.ts — the canonical normalization contract).
   */
  value?: string | number | boolean | null;
  /** Interpreter warnings (e.g. "Variable 'amount' not found"); omitted when clean. */
  warnings?: string[];
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
  /** JSON document-order array of the activated out-flows (inclusiveGateway split); NULL for XOR/EBG/parallel. */
  activated_flow_ids: string | null;
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
  /** The activated out-flow subset in document order (inclusiveGateway split); null for XOR/EBG/parallel. */
  activatedFlowIds: string[] | null;
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
    activatedFlowIds: row.activated_flow_ids
      ? parseJson<string[]>(row.activated_flow_ids, [])
      : null,
    createdAt: row.created_at,
  };
}

/**
 * Plain INSERT (NOT `OR IGNORE`) of the branch decision — composed into the
 * SAME dbBatch as the transition to the chosen target + its history event
 * (persist-before-advance).
 *
 * Engine contract (check-first): the gateway step READS the decision row first;
 * if one exists it follows the recorded branch with no writes. This INSERT only
 * runs when no row was found. With a plain INSERT, a losing concurrent walk's
 * unique-constraint violation on (instance_id, element_id, occurrence) aborts
 * its ENTIRE batch atomically — transition and history included — and the
 * caller must re-read the decision and follow the recorded branch; never
 * re-evaluate. With `OR IGNORE`, the losing batch's transition would still
 * commit while its decision row is discarded, permanently recording branch A
 * while the instance advanced down branch B.
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
    /**
     * The activated out-flow subset in document order — ONLY an inclusiveGateway
     * (OR) split passes this (M4-L4). XOR/EBG callers omit it ⇒ it binds NULL
     * (the column default), so XOR/EBG behaviour is unchanged.
     */
    activatedFlowIds?: string[] | null;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO gateway_decisions
       (decision_id, instance_id, element_id, occurrence, chosen_flow_id, is_default, evaluations, variables_snapshot, activated_flow_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.decisionId,
      input.instanceId,
      input.elementId,
      input.occurrence,
      input.chosenFlowId,
      input.isDefault ? 1 : 0,
      toJson(input.evaluations),
      input.variablesSnapshot ? toJson(input.variablesSnapshot) : null,
      input.activatedFlowIds ? toJson(input.activatedFlowIds) : null,
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
