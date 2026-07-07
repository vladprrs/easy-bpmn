// Process instances and their child entities: variable snapshots, Service Task
// jobs, worker attempts, message subscriptions, and incidents.
//
// Functions returning a D1PreparedStatement (…Stmt) are composed into atomic
// dbBatch() transitions by the engine (persist-before-advance, atomic apply).

import { dbAll, dbFirst, dbRun, stmt } from "./db";
import { newId, parseJson, toJson, type JsonObject } from "../util";
import type { Incident, ProcessInstance } from "../contracts/api";

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export interface InstanceRow {
  instance_id: string;
  workspace_id: string;
  definition_version_id: string;
  workflow_instance_id: string;
  workflow_status: string | null;
  business_key: string | null;
  correlation_key: string;
  status: string;
  current_element_id: string | null;
  variables: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  last_synced_at: string | null;
  // M5-L2 (0008) — parent linkage (NULL for root instances) + the child-only
  // errored terminal's business error code (spec §4).
  parent_instance_id: string | null;
  parent_element_id: string | null;
  parent_occurrence: number | null;
  error_code: string | null;
}

export type InstanceStatus = ProcessInstance["status"];

export function mapInstance(row: InstanceRow): ProcessInstance {
  return {
    instanceId: row.instance_id,
    workspaceId: row.workspace_id,
    definitionVersionId: row.definition_version_id,
    workflowInstanceId: row.workflow_instance_id,
    businessKey: row.business_key,
    correlationKey: row.correlation_key,
    status: row.status as InstanceStatus,
    currentElementId: row.current_element_id,
    variables: parseJson<JsonObject>(row.variables, {}),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    parentInstanceId: row.parent_instance_id ?? null,
    errorCode: row.error_code ?? null,
  };
}

export async function createInstance(
  db: D1Database,
  input: {
    instanceId: string;
    workspaceId: string;
    definitionVersionId: string;
    workflowInstanceId: string;
    businessKey?: string | null;
    correlationKey: string;
    startElementId: string;
    variables: JsonObject;
    now: string;
  },
): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO process_instances
       (instance_id, workspace_id, definition_version_id, workflow_instance_id, workflow_status,
        business_key, correlation_key, status, current_element_id, variables, started_at, updated_at, completed_at, last_synced_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'starting', ?, ?, ?, ?, NULL, NULL)`,
    [
      input.instanceId,
      input.workspaceId,
      input.definitionVersionId,
      input.workflowInstanceId,
      input.businessKey ?? null,
      input.correlationKey,
      input.startElementId,
      toJson(input.variables),
      input.now,
      input.now,
    ],
  );
}

/** Batchable child-instance INSERT (M5-L2): same shape as createInstance but a
 *  statement (it must commit in the SAME batch as the child_instances provenance
 *  row — persist-before-advance), with the parent linkage columns. */
export function createChildInstanceStmt(db: D1Database, input: {
  instanceId: string; workspaceId: string; definitionVersionId: string;
  correlationKey: string; startElementId: string; variables: JsonObject;
  parentInstanceId: string; parentElementId: string; parentOccurrence: number; now: string;
}): D1PreparedStatement {
  return stmt(db,
    `INSERT INTO process_instances
       (instance_id, workspace_id, definition_version_id, workflow_instance_id, workflow_status,
        business_key, correlation_key, status, current_element_id, variables, started_at, updated_at,
        completed_at, last_synced_at, parent_instance_id, parent_element_id, parent_occurrence)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, 'starting', ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    [input.instanceId, input.workspaceId, input.definitionVersionId, input.instanceId,
     input.correlationKey, input.startElementId, toJson(input.variables), input.now, input.now,
     input.parentInstanceId, input.parentElementId, input.parentOccurrence]);
}

export async function getInstanceRow(
  db: D1Database,
  instanceId: string,
): Promise<InstanceRow | null> {
  return dbFirst<InstanceRow>(
    db,
    `SELECT * FROM process_instances WHERE instance_id = ?`,
    [instanceId],
  );
}

export async function getInstance(
  db: D1Database,
  instanceId: string,
): Promise<ProcessInstance | null> {
  const row = await getInstanceRow(db, instanceId);
  return row ? mapInstance(row) : null;
}

/** UPDATE statement applying a transition (variables + current element + status). */
export function applyTransitionStmt(
  db: D1Database,
  input: {
    instanceId: string;
    variables?: JsonObject;
    currentElementId: string | null;
    status: InstanceStatus;
    completedAt?: string | null;
    now: string;
  },
): D1PreparedStatement {
  if (input.variables !== undefined) {
    return stmt(
      db,
      `UPDATE process_instances
         SET variables = ?, current_element_id = ?, status = ?, updated_at = ?,
             completed_at = COALESCE(?, completed_at)
       WHERE instance_id = ?`,
      [
        toJson(input.variables),
        input.currentElementId,
        input.status,
        input.now,
        input.completedAt ?? null,
        input.instanceId,
      ],
    );
  }
  return stmt(
    db,
    `UPDATE process_instances
       SET current_element_id = ?, status = ?, updated_at = ?,
           completed_at = COALESCE(?, completed_at)
     WHERE instance_id = ?`,
    [input.currentElementId, input.status, input.now, input.completedAt ?? null, input.instanceId],
  );
}

export async function applyTransition(
  db: D1Database,
  input: Parameters<typeof applyTransitionStmt>[1],
): Promise<void> {
  await applyTransitionStmt(db, input).run();
}

/** Status-conditional transition statement (only when current status is in `from`). */
export function transitionStatusGuardedStmt(
  db: D1Database,
  instanceId: string,
  from: InstanceStatus[],
  to: InstanceStatus,
  now: string,
): D1PreparedStatement {
  const placeholders = from.map(() => "?").join(", ");
  return stmt(
    db,
    `UPDATE process_instances SET status = ?, updated_at = ? WHERE instance_id = ? AND status IN (${placeholders})`,
    [to, now, instanceId, ...from],
  );
}

/** Status-conditional transition: applies only when current status is in `from`. Returns rows changed. */
export async function transitionStatusGuarded(
  db: D1Database,
  instanceId: string,
  from: InstanceStatus[],
  to: InstanceStatus,
  now: string,
): Promise<number> {
  const res = await transitionStatusGuardedStmt(db, instanceId, from, to, now).run();
  return res.meta?.changes ?? 0;
}

/**
 * Guarded terminal completion (M4-L3 last-token-out, design §5.6): flips
 * running/waiting → completed AND stamps completed_at, only while the instance is
 * still live. Returns rows changed — the single non-zero return is the one drive
 * that emits the terminal (belt-and-braces under concurrent region drives even
 * with the per-instance drive lock). Idempotent: a replay/late drive changes 0 rows.
 */
export async function completeInstanceGuarded(db: D1Database, instanceId: string, now: string): Promise<number> {
  const res = await stmt(
    db,
    `UPDATE process_instances SET status = 'completed', completed_at = ?, updated_at = ?
       WHERE instance_id = ? AND status IN ('running', 'waiting')`,
    [now, now, instanceId],
  ).run();
  return res.meta?.changes ?? 0;
}

/** Merge a variables patch into the instance (operator remediation). */
export async function mergeInstanceVariables(
  db: D1Database,
  instanceId: string,
  patch: JsonObject,
  now: string,
): Promise<void> {
  const row = await getInstanceRow(db, instanceId);
  if (!row) return;
  const merged = { ...parseJson<JsonObject>(row.variables, {}), ...patch };
  await dbRun(db, `UPDATE process_instances SET variables = ?, updated_at = ? WHERE instance_id = ?`, [toJson(merged), now, instanceId]);
}

export interface InstanceListItem {
  instanceId: string;
  status: string;
  currentElementId: string | null;
  correlationKey: string;
  businessKey: string | null;
  startedAt: string;
  updatedAt: string;
}

/** Filterable operator list (rowid-cursor pagination, newest first). */
export async function listInstances(
  db: D1Database,
  input: { workspaceId: string; status?: string; limit: number; cursor?: number },
): Promise<{ items: InstanceListItem[]; nextCursor: number | null }> {
  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [input.workspaceId];
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  if (input.cursor != null) {
    where.push("rowid < ?");
    params.push(input.cursor);
  }
  params.push(input.limit + 1);
  const rows = await dbAll<InstanceListItem & { rowid: number }>(
    db,
    `SELECT rowid, instance_id AS instanceId, status, current_element_id AS currentElementId,
            correlation_key AS correlationKey, business_key AS businessKey, started_at AS startedAt, updated_at AS updatedAt
       FROM process_instances WHERE ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`,
    params,
  );
  const hasMore = rows.length > input.limit;
  const items = rows.slice(0, input.limit);
  const nextCursor = hasMore ? items[items.length - 1]!.rowid : null;
  return { items: items.map(({ rowid, ...rest }) => rest), nextCursor };
}

export async function setWorkflowStatus(
  db: D1Database,
  instanceId: string,
  workflowStatus: string,
  now: string,
): Promise<void> {
  await dbRun(
    db,
    `UPDATE process_instances SET workflow_status = ?, last_synced_at = ? WHERE instance_id = ?`,
    [workflowStatus, now, instanceId],
  );
}

// ---------------------------------------------------------------------------
// Variable snapshots
// ---------------------------------------------------------------------------

export function variableSnapshotStmt(
  db: D1Database,
  input: {
    instanceId: string;
    source: "start" | "serviceTask" | "message" | "callActivity";
    sourceId?: string | null;
    variables: JsonObject;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO variable_snapshots (snapshot_id, instance_id, source, source_id, variables, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId("vs"), input.instanceId, input.source, input.sourceId ?? null, toJson(input.variables), input.now],
  );
}

// ---------------------------------------------------------------------------
// Service Task jobs
// ---------------------------------------------------------------------------

export interface JobRow {
  job_id: string;
  instance_id: string;
  element_id: string;
  task_type: string;
  status: string;
  retry_limit: number;
  attempt_count: number;
  idempotency_key: string;
  input_variables: string;
  output_variables: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  // SAGA (0002) — pull lease + compensation lane + DLQ + workspace scoping.
  workspace_id: string | null;
  is_compensation: number;
  compensates_element_id: string | null;
  worker_id: string | null;
  lock_token: string | null;
  lock_expires_at: string | null;
  activation_expires_at: string | null;
  error_code: string | null;
  // CONDITIONAL (0004) — loop-iteration discriminator + fast-forward marker.
  /** Walk-local visit counter (design M2 §5). 0 for every pre-loop row/call site. */
  occurrence: number;
  /** 1 once the engine merged this job's output + advanced — rewalk skips it write-free. */
  output_applied: number;
  // M5-L3 (0009) — the MI iteration this job serves; 0 on every non-MI (pre-L3)
  // path. Widens the (instance, element, kind, occurrence) forward key so an MI
  // activity's per-iteration forward jobs are distinct rows.
  iteration_index: number;
}

export async function getJobByElement(
  db: D1Database,
  instanceId: string,
  elementId: string,
): Promise<JobRow | null> {
  return dbFirst<JobRow>(
    db,
    `SELECT * FROM service_task_jobs WHERE instance_id = ? AND element_id = ?`,
    [instanceId, elementId],
  );
}

/**
 * The FORWARD job for an element (is_compensation = 0). Occurrence-unaware:
 * once loops exist an element may have one row per iteration, so this orders
 * by `occurrence DESC` to deterministically return the LATEST iteration
 * instead of whichever row D1 happens to yield first.
 *
 * @deprecated prefer the occurrence-aware getForwardJob (TASK-32 migrates call sites)
 */
export async function getForwardJobByElement(
  db: D1Database,
  instanceId: string,
  elementId: string,
): Promise<JobRow | null> {
  return dbFirst<JobRow>(
    db,
    `SELECT * FROM service_task_jobs
       WHERE instance_id = ? AND element_id = ? AND is_compensation = 0
       ORDER BY occurrence DESC`,
    [instanceId, elementId],
  );
}

/**
 * Every FORWARD (non-compensation) job row for an instance, most-recent first
 * (M5-L1 Task 12): used by the straggler scan's scope-subtree fallback (a region
 * branch token's `execution_tokens.position_element_id` is a one-time write at
 * fan-out — the flow target right after the split — never advanced as the branch
 * descends through non-split/join hops, so a branch that enters a plain subProcess
 * before its first task/wait leaves the position on the subProcess container,
 * which never gets its own job row).
 */
export async function listForwardJobsForInstance(db: D1Database, instanceId: string): Promise<JobRow[]> {
  const res = await dbAll<JobRow>(
    db,
    `SELECT * FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 0 ORDER BY created_at DESC, rowid DESC`,
    [instanceId],
  );
  return res;
}

/**
 * The FORWARD job for one specific iteration of an element (design M2 §5): the
 * occurrence-aware lookup the loop-capable rewalk uses. No row → the iteration
 * has not run; a row with un-applied output → the resume frontier.
 */
export async function getForwardJob(
  db: D1Database,
  instanceId: string,
  elementId: string,
  occurrence: number,
  iterationIndex = 0,
): Promise<JobRow | null> {
  return dbFirst<JobRow>(
    db,
    `SELECT * FROM service_task_jobs
       WHERE instance_id = ? AND element_id = ? AND is_compensation = 0 AND occurrence = ? AND iteration_index = ?`,
    [instanceId, elementId, occurrence, iterationIndex],
  );
}

/**
 * The COMPENSATION job for one specific iteration of a forward element
 * (design M2 §8): a compensation job inherits its forward step's occurrence,
 * so the reverse pass keys its lookups by (element, occurrence).
 */
export async function getCompensationJob(
  db: D1Database,
  instanceId: string,
  elementId: string,
  occurrence: number,
  iterationIndex = 0,
): Promise<JobRow | null> {
  return dbFirst<JobRow>(
    db,
    `SELECT * FROM service_task_jobs
       WHERE instance_id = ? AND element_id = ? AND is_compensation = 1 AND occurrence = ? AND iteration_index = ?`,
    [instanceId, elementId, occurrence, iterationIndex],
  );
}

/**
 * The COMPENSATION job for a forward element (is_compensation = 1).
 * Occurrence-unaware: orders by `occurrence DESC` so once loops exist it
 * deterministically returns the latest iteration's compensation job.
 *
 * @deprecated prefer the occurrence-aware getCompensationJob (TASK-32 migrated the engine)
 */
export async function getCompensationJobByElement(
  db: D1Database,
  instanceId: string,
  elementId: string,
): Promise<JobRow | null> {
  return dbFirst<JobRow>(
    db,
    `SELECT * FROM service_task_jobs
       WHERE instance_id = ? AND element_id = ? AND is_compensation = 1
       ORDER BY occurrence DESC`,
    [instanceId, elementId],
  );
}

export function createJobStmt(
  db: D1Database,
  input: {
    jobId: string;
    instanceId: string;
    elementId: string;
    taskType: string;
    retryLimit: number;
    idempotencyKey: string;
    inputVariables: JsonObject;
    now: string;
    // SAGA (0002) — optional; forward jobs default is_compensation=0.
    workspaceId?: string | null;
    isCompensation?: boolean;
    compensatesElementId?: string | null;
    activationExpiresAt?: string | null;
    // CONDITIONAL (0004) — optional; pre-loop callers default to occurrence 0.
    occurrence?: number;
    // M5-L3 (0009) — the MI iteration this job serves; optional, pre-L3 callers
    // default to 0. Widens the (instance, element, kind, occurrence) forward key.
    iterationIndex?: number;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO service_task_jobs
       (job_id, instance_id, element_id, task_type, status, retry_limit, attempt_count, idempotency_key, input_variables, output_variables, created_at, updated_at, completed_at,
        workspace_id, is_compensation, compensates_element_id, activation_expires_at, occurrence, output_applied, iteration_index)
     VALUES (?, ?, ?, ?, 'created', ?, 0, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?)`,
    [
      input.jobId,
      input.instanceId,
      input.elementId,
      input.taskType,
      input.retryLimit,
      input.idempotencyKey,
      toJson(input.inputVariables),
      input.now,
      input.now,
      input.workspaceId ?? null,
      input.isCompensation ? 1 : 0,
      input.compensatesElementId ?? null,
      input.activationExpiresAt ?? null,
      input.occurrence ?? 0,
      input.iterationIndex ?? 0,
    ],
  );
}

/**
 * Mark a completed job's output as applied (design M2 §5): composed into the
 * SAME dbBatch as the variable merge + transition, so the rewalk-from-start
 * treats the step as write-free fast-forward and never re-merges an old
 * iteration's output over newer variables. Guarded by `status = 'completed'` —
 * output can only be "applied" for a completed job; flipping the marker on a
 * created/running/failed job affects 0 rows.
 */
export function markJobOutputAppliedStmt(
  db: D1Database,
  jobId: string,
  now: string,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE service_task_jobs SET output_applied = 1, updated_at = ?
       WHERE job_id = ? AND status = 'completed'`,
    [now, jobId],
  );
}

/**
 * Mark a FAILED job's outcome as applied (TASK-32): the business-error branch
 * (errorCode → boundary route) composes this into the SAME dbBatch as the
 * `businessErrorCaught` history + the transition to the boundary target, so a
 * rewalk fast-forwards the visit (re-deriving the deterministic boundary target
 * from the graph + the persisted error_code) instead of re-routing — which
 * would duplicate history and rewrite the cursor backwards. Guarded by
 * `status = 'failed'` (the failure-routing twin of markJobOutputAppliedStmt).
 */
export function markFailedJobHandledStmt(
  db: D1Database,
  jobId: string,
  now: string,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE service_task_jobs SET output_applied = 1, updated_at = ?
       WHERE job_id = ? AND status = 'failed'`,
    [now, jobId],
  );
}

export async function createJob(
  db: D1Database,
  input: Parameters<typeof createJobStmt>[1],
): Promise<void> {
  await createJobStmt(db, input).run();
}

export async function setJobStatus(
  db: D1Database,
  jobId: string,
  status: "created" | "running" | "completed" | "failed",
  now: string,
): Promise<void> {
  await dbRun(
    db,
    `UPDATE service_task_jobs SET status = ?, updated_at = ? WHERE job_id = ?`,
    [status, now, jobId],
  );
}

/** Atomically bump the attempt counter and return the new value. */
export async function incrementJobAttempt(
  db: D1Database,
  jobId: string,
  now: string,
): Promise<number> {
  await dbRun(
    db,
    `UPDATE service_task_jobs SET attempt_count = attempt_count + 1, status = 'running', updated_at = ? WHERE job_id = ?`,
    [now, jobId],
  );
  const row = await dbFirst<{ attempt_count: number }>(
    db,
    `SELECT attempt_count FROM service_task_jobs WHERE job_id = ?`,
    [jobId],
  );
  return row?.attempt_count ?? 0;
}

export function jobCompleteStmt(
  db: D1Database,
  jobId: string,
  outputVariables: JsonObject,
  now: string,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE service_task_jobs
       SET status = 'completed', output_variables = ?, updated_at = ?, completed_at = ?
     WHERE job_id = ?`,
    [toJson(outputVariables), now, now, jobId],
  );
}

export async function failJob(db: D1Database, jobId: string, now: string): Promise<void> {
  await dbRun(
    db,
    `UPDATE service_task_jobs SET status = 'failed', updated_at = ? WHERE job_id = ?`,
    [now, jobId],
  );
}

// ---------------------------------------------------------------------------
// Worker attempts
// ---------------------------------------------------------------------------

export async function createAttempt(
  db: D1Database,
  input: {
    jobId: string;
    instanceId: string;
    attemptNumber: number;
    workflowStepName?: string | null;
    requestPayload: JsonObject;
    now: string;
  },
): Promise<string> {
  const attemptId = newId("att");
  await dbRun(
    db,
    `INSERT INTO worker_attempts
       (attempt_id, job_id, instance_id, attempt_number, workflow_step_name, status, request_payload, response_payload, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, 'started', ?, NULL, NULL, ?, NULL)`,
    [
      attemptId,
      input.jobId,
      input.instanceId,
      input.attemptNumber,
      input.workflowStepName ?? null,
      toJson(input.requestPayload),
      input.now,
    ],
  );
  return attemptId;
}

export async function finishAttempt(
  db: D1Database,
  input: {
    attemptId: string;
    status: "succeeded" | "failed";
    responsePayload?: JsonObject | null;
    error?: string | null;
    now: string;
  },
): Promise<void> {
  await dbRun(
    db,
    `UPDATE worker_attempts
       SET status = ?, response_payload = ?, error = ?, finished_at = ?
     WHERE attempt_id = ?`,
    [
      input.status,
      input.responsePayload ? toJson(input.responsePayload) : null,
      input.error ?? null,
      input.now,
      input.attemptId,
    ],
  );
}

/**
 * Finish the most recent still-`started` attempt of a job (M-UI §9 audit
 * enrichment). Best-effort + idempotent: a duplicate worker callback finds no open
 * attempt (the first finished it) and no-ops, so it never double-records. Populates
 * the per-attempt request/response/error the operator console's Attempts drill-down
 * reads via GET /instances/{id}/jobs.
 */
export async function finishLatestStartedAttempt(
  db: D1Database,
  jobId: string,
  input: { status: "succeeded" | "failed"; responsePayload?: JsonObject | null; error?: string | null; now: string },
): Promise<void> {
  const row = await dbFirst<{ attempt_id: string }>(
    db,
    `SELECT attempt_id FROM worker_attempts WHERE job_id = ? AND status = 'started' ORDER BY rowid DESC LIMIT 1`,
    [jobId],
  );
  if (!row) return;
  await finishAttempt(db, {
    attemptId: row.attempt_id,
    status: input.status,
    responsePayload: input.responsePayload ?? null,
    error: input.error ?? null,
    now: input.now,
  });
}

// ---------------------------------------------------------------------------
// Message subscriptions
// ---------------------------------------------------------------------------

export interface SubscriptionRow {
  subscription_id: string;
  workspace_id: string;
  instance_id: string;
  element_id: string;
  message_name: string;
  correlation_key: string;
  broker_key: string;
  workflow_event_type: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  consumed_at: string | null;
  external_message_id: string | null;
  // CONDITIONAL (0004) — a Receive Task in a loop re-subscribes per visit.
  occurrence: number;
}

interface CreateSubscriptionInput {
  subscriptionId: string;
  workspaceId: string;
  instanceId: string;
  elementId: string;
  messageName: string;
  correlationKey: string;
  brokerKey: string;
  workflowEventType: string;
  status: "active" | "consumed";
  expiresAt: string;
  consumedAt?: string | null;
  externalMessageId?: string | null;
  /** CONDITIONAL (0004) — keys the subscription to its loop iteration; defaults to 0. */
  occurrence?: number;
  now: string;
}

/**
 * INSERT statement for one message subscription row. The statement form lets an
 * eventBasedGateway compose ALL its branch subscriptions into the SAME park batch
 * as the timer arm + transition (M3-L4, TASK-46, design §4.5.1 — persist-before-
 * advance, atomic so a parked EBG always has its full subscription set).
 */
export function createSubscriptionStmt(db: D1Database, input: CreateSubscriptionInput): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO message_subscriptions
       (subscription_id, workspace_id, instance_id, element_id, message_name, correlation_key, broker_key, workflow_event_type, status, created_at, expires_at, consumed_at, external_message_id, occurrence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.subscriptionId,
      input.workspaceId,
      input.instanceId,
      input.elementId,
      input.messageName,
      input.correlationKey,
      input.brokerKey,
      input.workflowEventType,
      input.status,
      input.now,
      input.expiresAt,
      input.consumedAt ?? null,
      input.externalMessageId ?? null,
      input.occurrence ?? 0,
    ],
  );
}

export async function createSubscription(db: D1Database, input: CreateSubscriptionInput): Promise<void> {
  await createSubscriptionStmt(db, input).run();
}

/**
 * The subscription row for one VISIT of a Receive Task (design M2 §5): the
 * latest row at (instance, element, occurrence). The caller branches on its
 * status — `consumed` means this iteration's message was already applied
 * atomically with the transition (the write-free fast-forward predicate),
 * `active` means this visit is the live wait frontier; anything else (or no
 * row) means the visit still needs to register.
 */
export async function getSubscriptionForVisit(
  db: D1Database,
  instanceId: string,
  elementId: string,
  occurrence: number,
): Promise<SubscriptionRow | null> {
  return dbFirst<SubscriptionRow>(
    db,
    `SELECT * FROM message_subscriptions
       WHERE instance_id = ? AND element_id = ? AND occurrence = ?
       ORDER BY rowid DESC LIMIT 1`,
    [instanceId, elementId, occurrence],
  );
}

export function subscriptionConsumedStmt(
  db: D1Database,
  subscriptionId: string,
  externalMessageId: string,
  now: string,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE message_subscriptions
       SET status = 'consumed', consumed_at = ?, external_message_id = ?
     WHERE subscription_id = ?`,
    [now, externalMessageId, subscriptionId],
  );
}

/**
 * Supersede the ACTIVE subscription guarding a receive-task visit when its
 * boundary timer fires (M3-L3): a status-conditional flip `active → superseded`
 * composed into the winning fireTimer batch, so the rewalk's getSubscriptionForVisit
 * no longer treats it as the live wait. Distinct from `consumed` (which the engine
 * fast-forwards down the NORMAL path) — a superseded subscription resolved via the
 * timer path instead. Paired with a best-effort broker supersede so a late publish
 * to the broker key gets the stable buffered/no-match outcome.
 */
export function subscriptionSupersededStmt(
  db: D1Database,
  subscriptionId: string,
  now: string,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE message_subscriptions
       SET status = 'superseded', consumed_at = ?
     WHERE subscription_id = ? AND status = 'active'`,
    [now, subscriptionId],
  );
}

/** Every ACTIVE subscription of an instance — the cohort broker keys an operator
 * `/cancel` of a region must release so no broker key leaks (M4-L5, design §8.1). */
export async function listActiveSubscriptionsForInstance(
  db: D1Database,
  instanceId: string,
): Promise<SubscriptionRow[]> {
  return dbAll<SubscriptionRow>(
    db,
    `SELECT * FROM message_subscriptions WHERE instance_id = ? AND status = 'active'`,
    [instanceId],
  );
}

export async function markSubscriptionExpired(
  db: D1Database,
  subscriptionId: string,
  now: string,
): Promise<void> {
  await dbRun(
    db,
    `UPDATE message_subscriptions SET status = 'expired', consumed_at = ? WHERE subscription_id = ?`,
    [now, subscriptionId],
  );
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export type IncidentKind =
  | "serviceTaskFailure"
  | "compensationFailure"
  // LEGACY (M1) — the overloaded original timeout kind. Retained in the persisted
  // taxonomy + API enum for backward compatibility, but NEVER written by current
  // code: M3-L1 (TASK-39) split it into jobActivationTimeout + waitTimeout below.
  | "timeout"
  | "poison"
  // CONDITIONAL (M2 §9) — loop-iteration cap exceeded | XOR with no true condition and no default.
  | "loopLimit"
  | "noPath"
  // TIME / FAILURE TAXONOMY (M3-L1 §, TASK-39):
  //   jobActivationTimeout — an un-leasable forward job parked past its activation
  //     TTL by the per-job JobScheduler DLQ.
  //   waitTimeout — an un-guarded service-task OR receive-task durable-wait CAP
  //     elapsed (no worker completed / no message correlated). NOT the
  //     compensation-wait cap, which stays compensationFailure (a Hazard, not a timeout).
  //   conditionFailure — a hard FEEL evaluation error on an exclusiveGateway flow
  //     (previously masked as serviceTaskFailure).
  | "jobActivationTimeout"
  | "waitTimeout"
  | "conditionFailure"
  // CONCURRENCY (M4-L6 §9). concurrencyLimit — a split fan-out would exceed
  // MAX_CONCURRENT_TOKENS live tokens (counted from the in-memory frontier, never
  // a live SQL COUNT). stepBudget — the per-drive cumulative runStep/waitForEvent
  // count crossed STEP_BUDGET_SOFT (a graceful incident BELOW the platform step
  // ceiling, so a hot parallel×loop shape never becomes an opaque errored Workflow).
  | "concurrencyLimit"
  | "stepBudget"
  // COMPOSITION (M5-L1 spec §5.1): an error END EVENT reached the process root
  // uncaught (worker-task uncaught errors keep serviceTaskFailure).
  | "uncaughtError"
  // COMPOSITION (M5-L1 follow-up, TASK-71) — the walk re-descended into a scope
  // whose earlier occurrence was abnormally skipped (fired scope timer / nested
  // cancel) — a deterministic backstop instead of a silent occurrence desync. The
  // static C1 validator rejects UNGUARDED re-entry, this catches the residual
  // CONDITION-GUARDED loop-back the static BFS cannot prove unreachable.
  | "scopeReentry"
  // COMPOSITION (M5-L3 design §6) — a multiInstance activation whose evaluated
  // cardinality exceeds the body-aware cap min(MAX_MI_CARDINALITY,
  // floor(STEP_BUDGET_SOFT / (bodyStepCost * 4))). Cardinality is data, so this
  // is a graceful RUNTIME incident at activation — never an opaque errored Workflow.
  | "miCardinality";
/**
 * Incident remediation lifecycle (one-way):
 *
 *   open → compensating       operator /cancel of a Hazard initiates the reverse pass
 *   compensating → compensated  the reverse pass settles (engine settle batch, TASK-36)
 *   open|compensating → operatorResolved  operator /retry — STICKY, never overwritten
 *                                          (resolveIncident / resolveAllOpenIncidents
 *                                          guard on it; the settle advance is keyed on
 *                                          'compensating' only)
 *
 * The AUTO-compensation path (business error → cancel end) raises no incident,
 * so 'compensating'/'compensated' resolutions only ever appear on operator-
 * cancelled Hazards.
 *
 * Empty-ledger cancel (FIXED M3-L1, TASK-39): /cancel of an incident instance
 * with an EMPTY ledger (nothing compensatable, e.g. a noPath or gateway-only
 * loopLimit Hazard) settles the instance 'cancelled'. The pending===0 cancel
 * branch now closes ALL open incidents as 'operatorResolved' so none is left
 * dangling 'open' on a terminal instance.
 *
 * Targeted resolution (FIXED M3-L1, TASK-39): resolveIncident below takes a
 * REQUIRED incidentId — an operator /retry flips ONLY the targeted incident, so
 * with multiple incidents (a Hazard 'compensating' + a later compensationFailure
 * 'open') the Hazard still reaches its natural 'compensated' instead of being
 * collaterally flipped. The unfiltered form is the separate, explicit
 * resolveAllOpenIncidents, reserved for the empty-ledger cancel above, where
 * closing every open incident IS correct. (The two were split from a single
 * optional-id function to remove the silent "missing id ⇒ flip ALL" footgun.)
 */
export type IncidentResolution = "open" | "compensating" | "compensated" | "operatorResolved";

export function incidentStmt(
  db: D1Database,
  input: {
    incidentId: string;
    instanceId: string;
    elementId: string;
    reason: string;
    retryCount: number;
    payloadContext?: JsonObject | null;
    kind?: IncidentKind;
    resolution?: IncidentResolution;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO incidents (incident_id, instance_id, element_id, reason, status, retry_count, payload_context, kind, resolution, created_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    [
      input.incidentId,
      input.instanceId,
      input.elementId,
      input.reason,
      input.retryCount,
      input.payloadContext ? toJson(input.payloadContext) : null,
      input.kind ?? "serviceTaskFailure",
      input.resolution ?? "open",
      input.now,
    ],
  );
}

/**
 * Advance an incident's resolution as a BATCHABLE statement, guarded on the
 * exact prior value — the compensation settle path uses it to complete the
 * cancel-path lifecycle ('compensating' → 'compensated') atomically with the
 * terminal transition, without ever touching 'open' or the sticky
 * 'operatorResolved'. A 0-row match (no cancel-path incident) is a no-op.
 */
export function advanceIncidentResolutionStmt(
  db: D1Database,
  input: { instanceId: string; from: IncidentResolution; to: IncidentResolution },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE incidents SET resolution = ? WHERE instance_id = ? AND resolution = ?`,
    [input.to, input.instanceId, input.from],
  );
}

/**
 * Resolve ONE incident's remediation lifecycle by REQUIRED id (M3-L1, TASK-39) —
 * an operator /retry or a cancel-from-Hazard flips ONLY the targeted incident,
 * so a sibling Hazard mid-compensation is never collaterally moved. Always
 * filtered; never overwrites the sticky 'operatorResolved'. (Split from the old
 * optional-id setIncidentResolution so a missing id can no longer silently fall
 * through to flipping ALL incidents — see resolveAllOpenIncidents for that.)
 */
export async function resolveIncident(
  db: D1Database,
  instanceId: string,
  incidentId: string,
  resolution: IncidentResolution,
  now: string,
): Promise<void> {
  await dbRun(
    db,
    `UPDATE incidents SET resolution = ? WHERE instance_id = ? AND incident_id = ? AND resolution != 'operatorResolved'`,
    [resolution, instanceId, incidentId],
  );
}

/**
 * Resolve EVERY not-yet-resolved incident of an instance (M3-L1, TASK-39) — the
 * explicit "all" form, reserved for the empty-ledger /cancel terminal cleanup
 * where closing every open incident IS correct (none should be left dangling
 * 'open' on a terminal instance). Never overwrites the sticky 'operatorResolved'.
 */
export async function resolveAllOpenIncidents(
  db: D1Database,
  instanceId: string,
  resolution: IncidentResolution,
  now: string,
): Promise<void> {
  await dbRun(
    db,
    `UPDATE incidents SET resolution = ? WHERE instance_id = ? AND resolution != 'operatorResolved'`,
    [resolution, instanceId],
  );
}

export async function getIncidentForInstance(
  db: D1Database,
  instanceId: string,
): Promise<Incident | null> {
  const row = await dbFirst<IncidentRow>(
    db,
    `SELECT * FROM incidents WHERE instance_id = ? ORDER BY rowid DESC LIMIT 1`,
    [instanceId],
  );
  if (!row) return null;
  return rowToIncident(row);
}

interface IncidentRow {
  incident_id: string;
  instance_id: string;
  element_id: string;
  reason: string;
  status: string;
  retry_count: number;
  payload_context: string | null;
  kind: string | null;
  resolution: string | null;
  created_at: string;
}

function rowToIncident(row: IncidentRow): Incident {
  return {
    incidentId: row.incident_id,
    instanceId: row.instance_id,
    elementId: row.element_id,
    reason: row.reason,
    status: "open",
    retryCount: row.retry_count,
    payloadContext: row.payload_context ? parseJson(row.payload_context, {}) : undefined,
    kind: (row.kind as IncidentKind | null) ?? "serviceTaskFailure",
    resolution: (row.resolution as IncidentResolution | null) ?? "open",
    createdAt: row.created_at,
  };
}

/**
 * All not-yet-resolved incidents of an instance, newest-first (M3-L1, TASK-39).
 * "Open" = resolution IN ('open','compensating') — i.e. NOT a terminal
 * 'operatorResolved' / 'compensated'. Surfaced by instance inspection so an
 * operator sees every live incident, not just the latest (LIMIT 1) one.
 */
export async function getOpenIncidentsForInstance(
  db: D1Database,
  instanceId: string,
): Promise<Incident[]> {
  const rows = await dbAll<IncidentRow>(
    db,
    `SELECT * FROM incidents
       WHERE instance_id = ? AND resolution IN ('open', 'compensating')
       ORDER BY rowid DESC`,
    [instanceId],
  );
  return rows.map(rowToIncident);
}
