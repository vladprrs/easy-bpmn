// child_instances (M5-L2 callActivity, migration 0008) — the child-idempotency
// provenance table + parent linkage. It is the rewalk fast-forward predicate
// gating BOTH the child Workflow create and the output apply (the analogue of
// gateway_decisions / output_applied=1); the UNIQUE index on
// (parent_instance_id, parent_element_id, occurrence, iteration_index) is the
// at-least-once single-apply guard. Statement builders only; the engine reads
// this table to decide whether a callActivity visit already has a bound child
// and whether that child's output was already merged.

import { dbAll, dbFirst, stmt } from "./db";

export interface ChildInstanceRow {
  parent_instance_id: string;
  parent_element_id: string;
  occurrence: number;
  iteration_index: number;
  child_instance_id: string;
  status: "invoked" | "outputApplied";
  created_at: string;
  updated_at: string;
}

/**
 * INSERT the provenance row for a callActivity visit — composed into the SAME
 * batch as the child instance create (createChildInstanceStmt, instances.ts)
 * and the parent's transition into the wait (persist-before-advance). Always
 * starts at `status = 'invoked'`; markChildOutputAppliedStmt is the only path
 * to 'outputApplied'.
 */
export function insertChildInstanceStmt(
  db: D1Database,
  input: {
    parentInstanceId: string;
    parentElementId: string;
    occurrence: number;
    iterationIndex: number;
    childInstanceId: string;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO child_instances
       (parent_instance_id, parent_element_id, occurrence, iteration_index, child_instance_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'invoked', ?, ?)`,
    [
      input.parentInstanceId,
      input.parentElementId,
      input.occurrence,
      input.iterationIndex,
      input.childInstanceId,
      input.now,
      input.now,
    ],
  );
}

/**
 * The provenance row for one callActivity VISIT (design mirrors
 * getSubscriptionForVisit / getForwardJob): no row → the visit has not
 * created its child yet; `invoked` → the child is running, the parent is the
 * wait frontier; `outputApplied` → the write-free fast-forward past this
 * visit.
 */
export async function getChildInstanceForVisit(
  db: D1Database,
  parentInstanceId: string,
  parentElementId: string,
  occurrence: number,
  iterationIndex = 0,
): Promise<ChildInstanceRow | null> {
  return dbFirst<ChildInstanceRow>(
    db,
    `SELECT * FROM child_instances
       WHERE parent_instance_id = ? AND parent_element_id = ? AND occurrence = ? AND iteration_index = ?`,
    [parentInstanceId, parentElementId, occurrence, iterationIndex],
  );
}

/** Reverse lookup: the provenance row that bound a given child instance id. */
export async function getChildInstanceByChildId(
  db: D1Database,
  childInstanceId: string,
): Promise<ChildInstanceRow | null> {
  return dbFirst<ChildInstanceRow>(
    db,
    `SELECT * FROM child_instances WHERE child_instance_id = ?`,
    [childInstanceId],
  );
}

/**
 * Mark a callActivity visit's child output as applied — composed into the
 * SAME batch as the parent's variable merge + transition out of the wait
 * (persist-before-advance), the child-instance twin of
 * markJobOutputAppliedStmt (instances.ts). Guarded by `status = 'invoked'` so
 * a duplicate child-completion event (at-least-once) or a replay flips 0 rows
 * the second time — the single-apply guard.
 */
export function markChildOutputAppliedStmt(
  db: D1Database,
  input: {
    parentInstanceId: string;
    parentElementId: string;
    occurrence: number;
    iterationIndex: number;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE child_instances SET status = 'outputApplied', updated_at = ?
       WHERE parent_instance_id = ? AND parent_element_id = ? AND occurrence = ? AND iteration_index = ? AND status = 'invoked'`,
    [input.now, input.parentInstanceId, input.parentElementId, input.occurrence, input.iterationIndex],
  );
}

/**
 * Every child of a parent instance, joined to the child's own current status
 * + error_code (operator inspection: a parent's callActivity children surface
 * their live/terminal state without a second round trip).
 */
export async function listChildrenOfInstance(
  db: D1Database,
  parentInstanceId: string,
): Promise<Array<ChildInstanceRow & { child_status: string; child_error_code: string | null }>> {
  return dbAll<ChildInstanceRow & { child_status: string; child_error_code: string | null }>(
    db,
    `SELECT ci.*, pi.status AS child_status, pi.error_code AS child_error_code
       FROM child_instances ci
       JOIN process_instances pi ON pi.instance_id = ci.child_instance_id
      WHERE ci.parent_instance_id = ?
      ORDER BY ci.occurrence, ci.iteration_index`,
    [parentInstanceId],
  );
}
