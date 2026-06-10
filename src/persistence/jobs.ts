// Pull-model job persistence: the atomic lease (POST /jobs/activate) and the
// lock_token-conditional complete/fail callbacks. Kept separate from the legacy
// synchronous job helpers in instances.ts.
//
// D1 constraint (design §4.3, live-verified): `UPDATE ... LIMIT n RETURNING`
// does NOT parse on D1 (code 7500). The lease MUST use the IN-subquery form with
// the leasable guard duplicated in BOTH the inner subquery and the outer WHERE.
// D1's single writer serializes activates, so two callers cannot double-claim.

import { stmt } from "./db";
import { parseJson, type JsonObject } from "../util";

/** Columns the lease RETURNING surfaces. */
export interface LeasedJobRow {
  job_id: string;
  instance_id: string;
  element_id: string;
  task_type: string;
  is_compensation: number;
  compensates_element_id: string | null;
  attempt_count: number;
  lock_token: string;
  input_variables: string;
}

/**
 * Atomically lease up to `limit` jobs of `taskType` in `workspaceId`. The
 * workspace scope is enforced by a JOIN to process_instances (service_task_jobs
 * is denormalized but the JOIN is authoritative) so a worker can never lease
 * another tenant's same-taskType jobs. Each leased row → status 'locked', a fresh
 * lock_token, lock_expires_at = leaseUntil, attempt_count incremented.
 */
export async function leaseJobs(
  db: D1Database,
  input: {
    workspaceId: string;
    taskType: string;
    workerId: string;
    lockToken: string;
    leaseUntil: string;
    now: string;
    limit: number;
  },
): Promise<LeasedJobRow[]> {
  // Leasable = a fresh 'created' job OR a PARKED job whose park (backoff or
  // reclaim) has elapsed. A parked job is `status='locked' AND lock_token IS NULL`;
  // a still-held in-flight lease has lock_token SET and is NEVER leased here — an
  // EXPIRED in-flight lease is converted to a backoff-park by the reclaim pre-pass
  // (parkExpiredLeases) before this runs, so the `lock_token IS NULL` guard keeps
  // backoff distinct from instant reclaim (design §4.1 reclaim leg).
  const res = await stmt(
    db,
    `UPDATE service_task_jobs
        SET worker_id = ?, lock_token = ?, lock_expires_at = ?, status = 'locked',
            attempt_count = attempt_count + 1, updated_at = ?
      WHERE job_id IN (
        SELECT j.job_id FROM service_task_jobs j
          JOIN process_instances pi ON pi.instance_id = j.instance_id
         WHERE j.task_type = ? AND pi.workspace_id = ?
           AND (j.status = 'created' OR (j.status = 'locked' AND j.lock_token IS NULL AND j.lock_expires_at < ?))
         ORDER BY j.created_at
         LIMIT ?)
        AND (status = 'created' OR (status = 'locked' AND lock_token IS NULL AND lock_expires_at < ?))
      RETURNING job_id, instance_id, element_id, task_type, is_compensation, compensates_element_id, attempt_count, lock_token, input_variables`,
    [
      input.workerId,
      input.lockToken,
      input.leaseUntil,
      input.now,
      input.taskType,
      input.workspaceId,
      input.now,
      input.limit,
      input.now,
    ],
  ).all<LeasedJobRow>();
  return res.results ?? [];
}

/** An expired in-flight lease (held lock that lapsed) awaiting a backoff reclaim. */
export interface ExpiredLeaseRow {
  job_id: string;
  attempt_count: number;
}

/**
 * Select in-flight leases (lock_token held) whose lease has lapsed, for the given
 * taskType + workspace — the reclaim candidates a crashed/slow worker left behind.
 * The reclaim pre-pass parks each behind backoff (design §4.1) instead of letting
 * the bulk lease re-hand it instantly.
 */
export async function selectExpiredInFlightLeases(
  db: D1Database,
  workspaceId: string,
  taskType: string,
  now: string,
): Promise<ExpiredLeaseRow[]> {
  const res = await stmt(
    db,
    `SELECT j.job_id, j.attempt_count FROM service_task_jobs j
       JOIN process_instances pi ON pi.instance_id = j.instance_id
      WHERE j.task_type = ? AND pi.workspace_id = ?
        AND j.status = 'locked' AND j.lock_token IS NOT NULL AND j.lock_expires_at < ?`,
    [taskType, workspaceId, now],
  ).all<ExpiredLeaseRow>();
  return res.results ?? [];
}

/**
 * Park a lapsed in-flight lease behind backoff: clear its lock_token and set
 * lock_expires_at to the backoff deadline so the bulk lease only re-hands it after
 * the delay. Guarded (WHERE still a lapsed in-flight lease) so a concurrent
 * complete/re-lease is not clobbered. Returns rows changed.
 */
export async function parkExpiredLease(
  db: D1Database,
  jobId: string,
  parkUntil: string,
  now: string,
): Promise<number> {
  const res = await stmt(
    db,
    `UPDATE service_task_jobs
        SET lock_token = NULL, lock_expires_at = ?, worker_id = NULL, updated_at = ?
      WHERE job_id = ? AND status = 'locked' AND lock_token IS NOT NULL AND lock_expires_at < ?`,
    [parkUntil, now, jobId, now],
  ).run();
  return res.meta?.changes ?? 0;
}

export interface JobWithWorkspace {
  job_id: string;
  instance_id: string;
  element_id: string;
  task_type: string;
  status: string;
  retry_limit: number;
  attempt_count: number;
  lock_token: string | null;
  output_variables: string | null;
  error_code: string | null;
  is_compensation: number;
  /** Loop-iteration discriminator (0004); 0 for every pre-loop row. */
  occurrence: number;
  /** Write-free fast-forward marker (0004): 1 once the engine applied the output. */
  output_applied: number;
  /** Authoritative workspace via the JOIN to process_instances. */
  workspace_id: string;
  /** Owning instance status, for the terminal no-op-ack gate. */
  instance_status: string;
}

/**
 * Load a job together with its owning instance's workspace + status. Returns null
 * if the job does not exist OR is not in `workspaceId` — callers MUST treat both
 * as 404 (never confirm a foreign job's existence).
 */
export async function getJobInWorkspace(
  db: D1Database,
  jobId: string,
  workspaceId: string,
): Promise<JobWithWorkspace | null> {
  const row = await stmt(
    db,
    `SELECT j.job_id, j.instance_id, j.element_id, j.task_type, j.status, j.retry_limit,
            j.attempt_count, j.lock_token, j.output_variables, j.error_code, j.is_compensation,
            j.occurrence, j.output_applied,
            pi.workspace_id AS workspace_id, pi.status AS instance_status
       FROM service_task_jobs j
       JOIN process_instances pi ON pi.instance_id = j.instance_id
      WHERE j.job_id = ? AND pi.workspace_id = ?`,
    [jobId, workspaceId],
  ).first<JobWithWorkspace>();
  return row ?? null;
}

export function parseJobOutput(row: { output_variables: string | null }): JsonObject {
  return row.output_variables ? parseJson<JsonObject>(row.output_variables, {}) : {};
}

/** Columns the DLQ alarm re-check needs (no workspace scoping — keyed by job_id). */
export interface JobByIdRow {
  job_id: string;
  instance_id: string;
  element_id: string;
  task_type: string;
  status: string;
  attempt_count: number;
  is_compensation: number;
  activation_expires_at: string | null;
}

/** Load a job purely by id (the JobScheduler alarm holds only the jobId). */
export async function getJobRowById(db: D1Database, jobId: string): Promise<JobByIdRow | null> {
  return (
    (await stmt(
      db,
      `SELECT job_id, instance_id, element_id, task_type, status, attempt_count, is_compensation, activation_expires_at
         FROM service_task_jobs WHERE job_id = ?`,
      [jobId],
    ).first<JobByIdRow>()) ?? null
  );
}

/**
 * Re-open a completed job for another attempt WITHOUT resetting the attempt
 * counter (poison-retry, design §4.3): the worker re-completed with un-applicable
 * output, so the job becomes leasable again. The poison strike counter is NOT
 * `attempt_count` (that is the lease counter, which a technical retry also bumps);
 * strikes are counted from `serviceTaskOutputRejected` history so technical retries
 * never consume the poison budget. NOTE: those history rows persist across an
 * operator `/retry` of a poison incident, so a retry does not grant a fresh poison
 * budget — a still-un-applicable completion re-poisons immediately. Statement form
 * for atomic composition with the park transition.
 */
export function reopenJobKeepAttemptStmt(db: D1Database, jobId: string, now: string): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE service_task_jobs
        SET status = 'created', output_variables = NULL, lock_token = NULL, lock_expires_at = NULL,
            worker_id = NULL, completed_at = NULL, updated_at = ?
      WHERE job_id = ?`,
    [now, jobId],
  );
}

/**
 * DLQ guarded claim (design §4.2): flip a STILL-un-leased forward job
 * (`created`, `attempt_count=0`) to `failed` and return rows changed (1 = this
 * DLQ pass claimed it, 0 = a worker leased/progressed it first). This is the
 * serialization point against a concurrent `/jobs/activate` — D1's single writer
 * guarantees exactly one of {DLQ, lease} wins, so the alarm can never clobber an
 * in-flight job (the TOCTOU the unguarded settle would have allowed).
 */
export async function failUnleasableJobConditional(db: D1Database, jobId: string, now: string): Promise<number> {
  const res = await stmt(
    db,
    `UPDATE service_task_jobs SET status = 'failed', lock_token = NULL, lock_expires_at = NULL, updated_at = ?
      WHERE job_id = ? AND status = 'created' AND attempt_count = 0 AND is_compensation = 0`,
    [now, jobId],
  ).run();
  return res.meta?.changes ?? 0;
}

/**
 * lock_token-conditional completion. Matches only a 'locked' job holding this
 * exact token (a stale/expired/re-leased token matches 0 rows). Clears the token.
 * Returns the number of rows changed (1 = applied, 0 = stale/duplicate).
 */
export async function completeJobConditional(
  db: D1Database,
  input: { jobId: string; lockToken: string; output: JsonObject; now: string },
): Promise<number> {
  const res = await stmt(
    db,
    `UPDATE service_task_jobs
        SET status = 'completed', output_variables = ?, lock_token = NULL, lock_expires_at = NULL,
            completed_at = ?, updated_at = ?
      WHERE job_id = ? AND lock_token = ? AND status = 'locked'`,
    [JSON.stringify(input.output ?? {}), input.now, input.now, input.jobId, input.lockToken],
  ).run();
  return res.meta?.changes ?? 0;
}

/**
 * lock_token-conditional failure. `targetStatus` is 'created' (re-leasable for a
 * technical retry) or 'failed' (business error, or technical retries exhausted).
 * Returns rows changed (1 = applied, 0 = stale/duplicate).
 */
export async function failJobConditional(
  db: D1Database,
  input: {
    jobId: string;
    lockToken: string;
    targetStatus: "created" | "failed";
    errorCode?: string | null;
    now: string;
  },
): Promise<number> {
  const res = await stmt(
    db,
    `UPDATE service_task_jobs
        SET status = ?, error_code = ?, lock_token = NULL, lock_expires_at = NULL, worker_id = NULL, updated_at = ?
      WHERE job_id = ? AND lock_token = ? AND status = 'locked'`,
    [input.targetStatus, input.errorCode ?? null, input.now, input.jobId, input.lockToken],
  ).run();
  return res.meta?.changes ?? 0;
}

/**
 * Backoff park (design §4.1): a retryable technical failure (or a lease-expiry
 * reclaim) parks the job — status stays 'locked' but with NO lock_token and
 * lock_expires_at set to the backoff deadline. The activate gate
 * (`status='locked' AND lock_expires_at < now`) then re-leases it only AFTER the
 * delay, so backoff reuses the lease gate and needs no new column, while staying
 * distinct from `leaseMs` (which bounds one in-flight attempt). lock_token-
 * conditional like complete/fail: a stale/duplicate token matches 0 rows.
 */
export async function parkJobForBackoffConditional(
  db: D1Database,
  input: { jobId: string; lockToken: string; parkUntil: string; now: string },
): Promise<number> {
  const res = await stmt(
    db,
    `UPDATE service_task_jobs
        SET status = 'locked', lock_token = NULL, lock_expires_at = ?, worker_id = NULL,
            error_code = NULL, updated_at = ?
      WHERE job_id = ? AND lock_token = ? AND status = 'locked'`,
    [input.parkUntil, input.now, input.jobId, input.lockToken],
  ).run();
  return res.meta?.changes ?? 0;
}

/**
 * Operator-retry reset: a failed job at (instance, element, kind) becomes
 * leasable again with a fresh attempt budget + a re-snapshotted input (so an
 * operator's variable patch reaches the worker). Returns rows changed.
 */
export async function resetJobForRetry(
  db: D1Database,
  input: { instanceId: string; elementId: string; isCompensation: boolean; inputVariables: string; now: string },
): Promise<number> {
  const res = await stmt(
    db,
    `UPDATE service_task_jobs
        SET status = 'created', attempt_count = 0, lock_token = NULL, lock_expires_at = NULL,
            worker_id = NULL, error_code = NULL, output_variables = NULL, input_variables = ?, completed_at = NULL, updated_at = ?
      WHERE instance_id = ? AND element_id = ? AND is_compensation = ?`,
    [input.inputVariables, input.now, input.instanceId, input.elementId, input.isCompensation ? 1 : 0],
  ).run();
  return res.meta?.changes ?? 0;
}

/** On operator cancel, abandon any in-flight FORWARD job so a late worker callback no-ops. */
export async function abandonActiveForwardJobs(db: D1Database, instanceId: string, now: string): Promise<void> {
  await stmt(
    db,
    `UPDATE service_task_jobs SET status = 'failed', lock_token = NULL, updated_at = ?
      WHERE instance_id = ? AND is_compensation = 0 AND status IN ('created', 'locked')`,
    [now, instanceId],
  ).run();
}
