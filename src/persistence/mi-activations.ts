// mi_activations (M5-L3 multiInstanceLoopCharacteristics, migration 0009) — the
// per-visit MI decider table, the gateway_decisions analogue. One row per MI
// activity VISIT (instance, element, occurrence) pins the evaluated `cardinality`
// ONCE at activation (never re-evaluated on a rewalk, exactly like a persisted
// gateway decision), then hosts two idempotent CAS deciders that make the fan-out
// replay-safe:
//   - settled_kind: the ONCE-ONLY early-settle decider (all | condition | abort).
//     settleMiActivationStmt guards `WHERE settled_kind IS NULL`, so the FIRST
//     settle wins and every later one (a replay, a racing completionCondition
//     evaluation, an interrupt) flips 0 rows.
//   - output_applied: the SINGLE-APPLY CAS for the aggregation merge — the twin of
//     service_task_jobs.output_applied. markMiOutputAppliedStmt guards
//     `WHERE output_applied = 0`, so the aggregate is merged into the caller's
//     variables exactly once across at-least-once drives.
// Statement builders only; the MI runtime (Task 6+) reads this table to decide
// whether a visit already activated, already settled, and already applied.

import { dbFirst, stmt } from "./db";
import { toJson } from "../util";

export interface MiActivationRow {
  instance_id: string;
  element_id: string;
  occurrence: number;
  cardinality: number;
  is_sequential: number;
  items: string | null;
  settled_kind: "all" | "condition" | "abort" | null;
  settled_count: number | null;
  output_applied: number;
  created_at: string;
  updated_at: string;
}

/**
 * INSERT the decider row for one MI activity VISIT — composed into the SAME batch
 * as the fan-out (persist-before-advance). Pins `cardinality` + the resolved
 * `items` list ONCE; a duplicate visit is rejected by uq_mi_activations_visit (the
 * unique-index guard, the activation analogue of a gateway_decisions PK). Always
 * starts `settled_kind = NULL` (running) and `output_applied = 0`.
 */
export function insertMiActivationStmt(
  db: D1Database,
  input: {
    instanceId: string;
    elementId: string;
    occurrence: number;
    cardinality: number;
    isSequential: boolean;
    items: unknown[] | null;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO mi_activations
       (instance_id, element_id, occurrence, cardinality, is_sequential, items, settled_kind, settled_count, output_applied, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
    [
      input.instanceId,
      input.elementId,
      input.occurrence,
      input.cardinality,
      input.isSequential ? 1 : 0,
      input.items !== null ? toJson(input.items) : null,
      input.now,
      input.now,
    ],
  );
}

/**
 * The decider row for one MI activity VISIT (design mirrors getForwardJob /
 * getChildInstanceForVisit): no row → the visit has not activated yet; a row with
 * `settled_kind = NULL` → the fan-out is live; a settled row → the reverse/apply
 * fast-forward reads its pinned cardinality + settle outcome.
 */
export async function getMiActivation(
  db: D1Database,
  instanceId: string,
  elementId: string,
  occurrence: number,
): Promise<MiActivationRow | null> {
  return dbFirst<MiActivationRow>(
    db,
    `SELECT * FROM mi_activations
       WHERE instance_id = ? AND element_id = ? AND occurrence = ?`,
    [instanceId, elementId, occurrence],
  );
}

/**
 * The ONCE-ONLY early-settle decider (the gateway_decisions analogue): flip a live
 * activation to a terminal settle `kind` (all = every iteration finished normally;
 * condition = a completionCondition fired; abort = an interrupt/error stopped the
 * fan-out), recording how many iterations had completed (`count`). Guarded by
 * `WHERE settled_kind IS NULL`, so the FIRST settle wins and a replay / racing
 * evaluation flips 0 rows — callers assert the winner via `meta.changes`.
 */
export function settleMiActivationStmt(
  db: D1Database,
  input: {
    instanceId: string;
    elementId: string;
    occurrence: number;
    kind: "all" | "condition" | "abort";
    count: number;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE mi_activations
       SET settled_kind = ?, settled_count = ?, updated_at = ?
     WHERE instance_id = ? AND element_id = ? AND occurrence = ? AND settled_kind IS NULL`,
    [input.kind, input.count, input.now, input.instanceId, input.elementId, input.occurrence],
  );
}

/**
 * The SINGLE-APPLY CAS for the aggregation merge — composed into the SAME batch as
 * the caller's variable merge + transition out of the MI wait (persist-before-
 * advance), the MI twin of markJobOutputAppliedStmt. Guarded by
 * `WHERE output_applied = 0` so a duplicate settle event (at-least-once) or a
 * replay flips 0 rows the second time — the aggregate is merged exactly once.
 */
export function markMiOutputAppliedStmt(
  db: D1Database,
  input: { instanceId: string; elementId: string; occurrence: number; now: string },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE mi_activations SET output_applied = 1, updated_at = ?
       WHERE instance_id = ? AND element_id = ? AND occurrence = ? AND output_applied = 0`,
    [input.now, input.instanceId, input.elementId, input.occurrence],
  );
}
