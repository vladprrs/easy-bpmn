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
    source: "start" | "serviceTask" | "message";
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
 * The FORWARD job for one specific iteration of an element (design M2 §5): the
 * occurrence-aware lookup the loop-capable rewalk uses. No row → the iteration
 * has not run; a row with un-applied output → the resume frontier.
 */
export async function getForwardJob(
  db: D1Database,
  instanceId: string,
  elementId: string,
  occurrence: number,
): Promise<JobRow | null> {
  return dbFirst<JobRow>(
    db,
    `SELECT * FROM service_task_jobs
       WHERE instance_id = ? AND element_id = ? AND is_compensation = 0 AND occurrence = ?`,
    [instanceId, elementId, occurrence],
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
): Promise<JobRow | null> {
  return dbFirst<JobRow>(
    db,
    `SELECT * FROM service_task_jobs
       WHERE instance_id = ? AND element_id = ? AND is_compensation = 1 AND occurrence = ?`,
    [instanceId, elementId, occurrence],
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
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO service_task_jobs
       (job_id, instance_id, element_id, task_type, status, retry_limit, attempt_count, idempotency_key, input_variables, output_variables, created_at, updated_at, completed_at,
        workspace_id, is_compensation, compensates_element_id, activation_expires_at, occurrence, output_applied)
     VALUES (?, ?, ?, ?, 'created', ?, 0, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, 0)`,
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

export async function createSubscription(
  db: D1Database,
  input: {
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
  },
): Promise<void> {
  await dbRun(
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
  | "timeout"
  | "poison"
  // CONDITIONAL (M2 §9) — loop-iteration cap exceeded | XOR with no true condition and no default.
  | "loopLimit"
  | "noPath";
/**
 * Incident remediation lifecycle (one-way):
 *
 *   open → compensating       operator /cancel of a Hazard initiates the reverse pass
 *   compensating → compensated  the reverse pass settles (engine settle batch, TASK-36)
 *   open|compensating → operatorResolved  operator /retry — STICKY, never overwritten
 *                                          (setIncidentResolution guards on it; the settle
 *                                          advance is keyed on 'compensating' only)
 *
 * The AUTO-compensation path (business error → cancel end) raises no incident,
 * so 'compensating'/'compensated' resolutions only ever appear on operator-
 * cancelled Hazards.
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

/** Set an incident's remediation resolution (operator retry / compensation). */
export async function setIncidentResolution(
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
  const row = await dbFirst<{
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
  }>(
    db,
    `SELECT * FROM incidents WHERE instance_id = ? ORDER BY rowid DESC LIMIT 1`,
    [instanceId],
  );
  if (!row) return null;
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
