// Saga ledger (saga_steps) — the durable completed-step stack the reverse-order
// compensation pass consumes. A row is written INSERT OR IGNORE at forward
// completion, atomically with advance (so replay / duplicate-complete is a no-op
// and never double-compensates). Statement builders only; the engine reverse
// pass lives in the engine.

import { dbAll, dbFirst, stmt } from "./db";
import { parseJson, toJson, type JsonObject } from "../util";
import type { TokenRow } from "./tokens";

export type CompensationStatus =
  | "pending"
  | "notRequired"
  | "compensating"
  | "compensated"
  | "failed"
  // Non-terminal local commit (M5-L1 spec §3.2): a NESTED transaction committed.
  // Shielded from its own scope's re-compensation (incl. later occurrences), but
  // still eligible for compensation roots STRICTLY ABOVE its committing tx.
  | "committedLocal"
  // Terminal/sealed: the OUTERMOST enclosing transaction committed.
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
  // CONDITIONAL (0004) — each completed pass of a looped step is its own row.
  occurrence: number;
  // M4-L5 (0007) — the branch token that produced this row; NULL on the single-
  // token (M1–M3 / root) path. The lineage-quiescence-ordered reverse pass uses it
  // to compensate a step only once its branch lineage has no live token (§8.4).
  token_id: string | null;
  // M5-L2 (0008) — step-kind dispatch for the reverse pass (spec §5): NULL = a
  // worker-task step; non-NULL = compensate by driving this child instance's
  // own reverse pass instead of a compensation job.
  child_instance_id: string | null;
}

export interface SagaStepView {
  stepId: string;
  scopeId: string;
  seq: number;
  elementId: string;
  /** Loop-iteration discriminator (design M2 §8); 0 for non-looped steps. */
  occurrence: number;
  /**
   * The forward job that produced this step, or `null` for a callActivity child
   * step (M5-L2). `saga_steps.forward_job_id` is NOT NULL (migration 0002), so a
   * child step stores the empty-string sentinel `""` at insert; mapSagaStep folds
   * `""` → null here so callers see an honest "no forward job".
   */
  forwardJobId: string | null;
  capturedInput: JsonObject;
  capturedOutput: JsonObject | null;
  compensationElementId: string | null;
  compensationTaskType: string | null;
  compensationJobId: string | null;
  compensationStatus: CompensationStatus;
  traceId: string | null;
  /** M4-L5: the branch token that produced this row; NULL on the root/single-token path. */
  tokenId: string | null;
  /** M5-L2: non-NULL ⇒ compensate via this child instance's own reverse pass. */
  childInstanceId: string | null;
}

export function mapSagaStep(row: SagaStepRow): SagaStepView {
  return {
    stepId: row.step_id,
    scopeId: row.scope_id,
    seq: row.seq,
    elementId: row.element_id,
    occurrence: row.occurrence,
    // M5-L2 sentinel fold: a callActivity child step stores "" (forward_job_id is
    // NOT NULL) — surface it as null so it reads as "no forward job".
    forwardJobId: row.forward_job_id || null,
    capturedInput: parseJson<JsonObject>(row.captured_input, {}),
    capturedOutput: row.captured_output ? parseJson<JsonObject>(row.captured_output, {}) : null,
    compensationElementId: row.compensation_element_id,
    compensationTaskType: row.compensation_task_type,
    compensationJobId: row.compensation_job_id,
    compensationStatus: row.compensation_status as CompensationStatus,
    traceId: row.trace_id,
    tokenId: row.token_id,
    childInstanceId: row.child_instance_id,
  };
}

/**
 * Lineage-quiescence filter (design §8.4 / blocker 10 — Principle VI per causal
 * chain): a completed ledger step is eligible for compensation only once its token
 * lineage has NO live (`active|waiting|arrivedAtJoin`) descendant — so a causally-
 * downstream straggler in the same branch is always compensated before its
 * predecessor. A step is BLOCKED iff some live token is the step's token or a
 * descendant of it. Root-lineage steps (`token_id` NULL — the M1–M3 / single-token
 * path) are NEVER blocked, so this is a pure no-op there (cross-branch order is
 * unconstrained: concurrent branches have no happens-before relation).
 */
export function filterLineageQuiesced(steps: SagaStepView[], liveTokens: TokenRow[]): SagaStepView[] {
  if (liveTokens.length === 0) return steps;
  const parentOf = new Map(liveTokens.map((t) => [t.token_id, t.parent_token_id]));
  const ancestorsOf = (tid: string): Set<string> => {
    const out = new Set<string>();
    let cur: string | null = tid;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      out.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return out;
  };
  const blocked = new Set<string>();
  for (const t of liveTokens) for (const a of ancestorsOf(t.token_id)) blocked.add(a);
  return steps.filter((s) => s.tokenId == null || !blocked.has(s.tokenId));
}

/**
 * INSERT OR IGNORE a completed forward step into the ledger. `seq` is computed
 * atomically as the next monotonic value PER-INSTANCE (M5-L1 spec §3.4 — global,
 * not per-scope, so the root-relative reverse cursor can order across nested
 * scopes with a single `seq DESC`): a deterministic serialized walk-order rank
 * that EQUALS completion order within a causal chain (a token lineage), NOT
 * across concurrent branches (design §10 — the per-instance drive serialization
 * makes it a strict total order with no collisions; cross-branch reverse order
 * is unconstrained, §8.4). A duplicate
 * (instance_id, element_id, occurrence) is ignored — the replay/double-complete
 * no-op, held PER loop iteration (design M2 §8): each completed pass of a looped
 * step is its own ledger row and is compensated separately by the reverse pass.
 * `tokenId` is the branch token that produced the row (NULL on the root/single-
 * token path); the lineage-quiescence filter (§8.4) reads it.
 */
export function insertSagaStepStmt(
  db: D1Database,
  input: {
    stepId: string;
    instanceId: string;
    scopeId: string;
    elementId: string;
    /** The producing forward job id. A callActivity child step (M5-L2) has no
     *  forward job — pass the empty-string sentinel `""` (the column is NOT NULL);
     *  mapSagaStep folds it back to null. */
    forwardJobId: string;
    capturedInput: JsonObject;
    capturedOutput: JsonObject | null;
    compensationElementId: string | null;
    compensationTaskType: string | null;
    /** 'pending' when a compensator exists, else 'notRequired'. */
    compensationStatus: CompensationStatus;
    traceId?: string | null;
    /** CONDITIONAL (0004) — loop-iteration discriminator; defaults to 0. */
    occurrence?: number;
    /** M4-L5 (0007) — producing branch token; NULL on the root/single-token path. */
    tokenId?: string | null;
    /** M5-L2 (0008) — non-NULL ⇒ this step compensates via a child instance's
     *  own reverse pass rather than a compensation job; defaults to NULL. */
    childInstanceId?: string | null;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT OR IGNORE INTO saga_steps
       (step_id, instance_id, scope_id, seq, element_id, forward_job_id, captured_input, captured_output,
        compensation_element_id, compensation_task_type, compensation_job_id, compensation_status, trace_id, created_at, updated_at, occurrence, token_id, child_instance_id)
     SELECT ?, ?, ?,
            COALESCE((SELECT MAX(seq) FROM saga_steps WHERE instance_id = ?), 0) + 1,
            ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?`,
    [
      input.stepId,
      input.instanceId,
      input.scopeId,
      input.instanceId,
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
      input.occurrence ?? 0,
      input.tokenId ?? null,
      input.childInstanceId ?? null,
    ],
  );
}

const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/**
 * Root-relative reverse cursor (M5-L1 spec §3.4). Callers precompute the two
 * scope-id lists from the compiled graph (scope-tree.ts); SQL never walks the
 * hierarchy. Global per-instance `seq DESC` = reverse chronology across nested
 * scopes (bottom-up falls out for free).
 */
export async function selectSubtreeStepsForCompensation(
  db: D1Database,
  instanceId: string,
  subtreeScopeIds: string[],
  eligibleCommittedLocalScopeIds: string[],
): Promise<SagaStepView[]> {
  if (subtreeScopeIds.length === 0) return [];
  const elig = eligibleCommittedLocalScopeIds;
  const rows = await dbAll<SagaStepRow>(
    db,
    `SELECT * FROM saga_steps
       WHERE instance_id = ?
         AND scope_id IN (${placeholders(subtreeScopeIds.length)})
         AND ( compensation_status IN ('pending', 'compensating', 'failed')
            ${elig.length > 0 ? `OR (compensation_status = 'committedLocal' AND scope_id IN (${placeholders(elig.length)}))` : ""} )
       ORDER BY seq DESC`,
    [instanceId, ...subtreeScopeIds, ...elig],
  );
  return rows.map(mapSagaStep);
}

/** Root-relative compensable count (drives the operator-cancel empty-ledger branch). */
export async function countCompensableSteps(
  db: D1Database,
  instanceId: string,
  subtreeScopeIds: string[],
  eligibleCommittedLocalScopeIds: string[],
): Promise<number> {
  return (await selectSubtreeStepsForCompensation(db, instanceId, subtreeScopeIds, eligibleCommittedLocalScopeIds)).length;
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

/**
 * One iteration's ledger row (TASK-32): with loops each completed pass of an
 * element is its own row, so lookups (e.g. seeding a compensation job's
 * originalInput/capturedOutput at lease time) key by (element, occurrence) —
 * the compensation job inherits its forward step's occurrence.
 */
export async function getSagaStep(
  db: D1Database,
  instanceId: string,
  elementId: string,
  occurrence: number,
): Promise<SagaStepView | null> {
  const row = await dbFirst<SagaStepRow>(
    db,
    `SELECT * FROM saga_steps WHERE instance_id = ? AND element_id = ? AND occurrence = ?`,
    [instanceId, elementId, occurrence],
  );
  return row ? mapSagaStep(row) : null;
}

/**
 * The ledger step that invoked a given child instance (M5-L2 spec §5): the
 * reverse-pass dispatch and the child-notify self-heal read it to tell whether
 * the parent has already settled this child's step (compensated | failed). At
 * most one row per (instance, child) — a callActivity visit binds exactly one
 * child instance.
 */
export async function getSagaStepByChildId(
  db: D1Database,
  instanceId: string,
  childInstanceId: string,
): Promise<SagaStepView | null> {
  const row = await dbFirst<SagaStepRow>(
    db,
    `SELECT * FROM saga_steps WHERE instance_id = ? AND child_instance_id = ? LIMIT 1`,
    [instanceId, childInstanceId],
  );
  return row ? mapSagaStep(row) : null;
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
 * Transaction-commit ledger flip (M5-L1 spec §3.2).
 *   seal=false (NESTED commit): owned scopes' pending|compensating → 'committedLocal'.
 *   seal=true  (OUTERMOST commit): subtree's pending|compensating|committedLocal → 'committed' (terminal).
 * For a top-level single-scope transaction seal=true reduces byte-for-byte to the
 * pre-M5 statement (the M1–M4 no-op fast path).
 */
export function markScopeStepsCommittedStmt(
  db: D1Database,
  input: { instanceId: string; scopeIds: string[]; seal: boolean; now: string },
): D1PreparedStatement {
  const from = input.seal ? `('pending', 'compensating', 'committedLocal')` : `('pending', 'compensating')`;
  return stmt(
    db,
    `UPDATE saga_steps SET compensation_status = '${input.seal ? "committed" : "committedLocal"}', updated_at = ?
       WHERE instance_id = ? AND scope_id IN (${placeholders(input.scopeIds.length)}) AND compensation_status IN ${from}`,
    [input.now, input.instanceId, ...input.scopeIds],
  );
}
