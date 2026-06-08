// Saga ledger (saga_steps) — the durable completed-step stack the reverse-order
// compensation pass consumes. A row is written INSERT OR IGNORE at forward
// completion, atomically with advance (so replay / duplicate-complete is a no-op
// and never double-compensates). Statement builders only; the engine reverse
// pass lives in the engine.

import { dbAll, dbFirst, stmt } from "./db";
import { parseJson, toJson, type JsonObject } from "../util";

export type CompensationStatus =
  | "pending"
  | "notRequired"
  | "compensating"
  | "compensated"
  | "failed"
  // Terminal: the enclosing transaction committed, so the step is no longer
  // compensatable (it drops out of the reverse-pass cursor + the pending count).
  | "committed";

export interface SagaStepRow {
  step_id: string;
  instance_id: string;
  scope_id: string;
  seq: number;
  element_id: string;
  forward_job_id: string;
  captured_input: string;
  captured_output: string | null;
  compensation_element_id: string | null;
  compensation_task_type: string | null;
  compensation_job_id: string | null;
  compensation_status: string;
  trace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SagaStepView {
  stepId: string;
  scopeId: string;
  seq: number;
  elementId: string;
  forwardJobId: string;
  capturedInput: JsonObject;
  capturedOutput: JsonObject | null;
  compensationElementId: string | null;
  compensationTaskType: string | null;
  compensationJobId: string | null;
  compensationStatus: CompensationStatus;
  traceId: string | null;
}

export function mapSagaStep(row: SagaStepRow): SagaStepView {
  return {
    stepId: row.step_id,
    scopeId: row.scope_id,
    seq: row.seq,
    elementId: row.element_id,
    forwardJobId: row.forward_job_id,
    capturedInput: parseJson<JsonObject>(row.captured_input, {}),
    capturedOutput: row.captured_output ? parseJson<JsonObject>(row.captured_output, {}) : null,
    compensationElementId: row.compensation_element_id,
    compensationTaskType: row.compensation_task_type,
    compensationJobId: row.compensation_job_id,
    compensationStatus: row.compensation_status as CompensationStatus,
    traceId: row.trace_id,
  };
}

/**
 * INSERT OR IGNORE a completed forward step into the ledger. `seq` is computed
 * atomically as the next monotonic value within (instance_id, scope_id), so the
 * reverse pass walks steps in true completion order. A duplicate (instance_id,
 * element_id) is ignored — the replay/double-complete no-op.
 */
export function insertSagaStepStmt(
  db: D1Database,
  input: {
    stepId: string;
    instanceId: string;
    scopeId: string;
    elementId: string;
    forwardJobId: string;
    capturedInput: JsonObject;
    capturedOutput: JsonObject | null;
    compensationElementId: string | null;
    compensationTaskType: string | null;
    /** 'pending' when a compensator exists, else 'notRequired'. */
    compensationStatus: CompensationStatus;
    traceId?: string | null;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT OR IGNORE INTO saga_steps
       (step_id, instance_id, scope_id, seq, element_id, forward_job_id, captured_input, captured_output,
        compensation_element_id, compensation_task_type, compensation_job_id, compensation_status, trace_id, created_at, updated_at)
     SELECT ?, ?, ?,
            COALESCE((SELECT MAX(seq) FROM saga_steps WHERE instance_id = ? AND scope_id = ?), 0) + 1,
            ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?`,
    [
      input.stepId,
      input.instanceId,
      input.scopeId,
      input.instanceId,
      input.scopeId,
      input.elementId,
      input.forwardJobId,
      toJson(input.capturedInput),
      input.capturedOutput ? toJson(input.capturedOutput) : null,
      input.compensationElementId,
      input.compensationTaskType,
      input.compensationStatus,
      input.traceId ?? null,
      input.now,
      input.now,
    ],
  );
}

/**
 * The reverse-order compensation cursor: a scope's ledger rows still needing
 * compensation, in descending completion order. Drives the reverse pass and its
 * crash-recovery re-derivation (a `compensating` row re-attaches to its job).
 */
export async function selectScopeStepsForCompensation(
  db: D1Database,
  instanceId: string,
  scopeId: string,
): Promise<SagaStepView[]> {
  const rows = await dbAll<SagaStepRow>(
    db,
    `SELECT * FROM saga_steps
       WHERE instance_id = ? AND scope_id = ?
         AND compensation_status IN ('pending', 'compensating', 'failed')
       ORDER BY seq DESC`,
    [instanceId, scopeId],
  );
  return rows.map(mapSagaStep);
}

export async function getSagaStepsForInstance(
  db: D1Database,
  instanceId: string,
): Promise<SagaStepView[]> {
  const rows = await dbAll<SagaStepRow>(
    db,
    `SELECT * FROM saga_steps WHERE instance_id = ? ORDER BY scope_id, seq`,
    [instanceId],
  );
  return rows.map(mapSagaStep);
}

export async function getSagaStep(
  db: D1Database,
  instanceId: string,
  elementId: string,
): Promise<SagaStepView | null> {
  const row = await dbFirst<SagaStepRow>(
    db,
    `SELECT * FROM saga_steps WHERE instance_id = ? AND element_id = ?`,
    [instanceId, elementId],
  );
  return row ? mapSagaStep(row) : null;
}

/** How many steps still need compensation (drives the cancel empty-ledger branch). */
export async function countPendingSteps(db: D1Database, instanceId: string): Promise<number> {
  const row = await dbFirst<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM saga_steps WHERE instance_id = ?
       AND compensation_status IN ('pending', 'compensating', 'failed')`,
    [instanceId],
  );
  return row?.n ?? 0;
}

/** The step whose compensator exhausted retries (operator-retry target). */
export async function getFailedStep(db: D1Database, instanceId: string): Promise<SagaStepView | null> {
  const row = await dbFirst<SagaStepRow>(
    db,
    `SELECT * FROM saga_steps WHERE instance_id = ? AND compensation_status = 'failed' ORDER BY seq DESC LIMIT 1`,
    [instanceId],
  );
  return row ? mapSagaStep(row) : null;
}

/** Mark a step `compensating` and bind its compensation job (replay re-attaches). */
export function attachCompensationJobStmt(
  db: D1Database,
  input: { stepId: string; compensationJobId: string; now: string },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE saga_steps
       SET compensation_status = 'compensating', compensation_job_id = ?, updated_at = ?
     WHERE step_id = ?`,
    [input.compensationJobId, input.now, input.stepId],
  );
}

/** Update a step's compensation status (compensated | failed | …). */
export function updateCompensationStatusStmt(
  db: D1Database,
  input: { stepId: string; status: CompensationStatus; now: string },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE saga_steps SET compensation_status = ?, updated_at = ? WHERE step_id = ?`,
    [input.status, input.now, input.stepId],
  );
}

/**
 * On transaction commit, terminalize the scope's still-pending steps → 'committed'
 * so a later operator /cancel of a DIFFERENT scope does not re-compensate them
 * (they drop out of countPendingSteps + selectScopeStepsForCompensation).
 */
export function markScopeStepsCommittedStmt(
  db: D1Database,
  input: { instanceId: string; scopeId: string; now: string },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE saga_steps SET compensation_status = 'committed', updated_at = ?
       WHERE instance_id = ? AND scope_id = ? AND compensation_status IN ('pending', 'compensating')`,
    [input.now, input.instanceId, input.scopeId],
  );
}
