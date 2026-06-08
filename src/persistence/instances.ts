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

export async function createJob(
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
  },
): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO service_task_jobs
       (job_id, instance_id, element_id, task_type, status, retry_limit, attempt_count, idempotency_key, input_variables, output_variables, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 'created', ?, 0, ?, ?, NULL, ?, ?, NULL)`,
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
    ],
  );
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
    now: string;
  },
): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO message_subscriptions
       (subscription_id, workspace_id, instance_id, element_id, message_name, correlation_key, broker_key, workflow_event_type, status, created_at, expires_at, consumed_at, external_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  );
}

export async function getActiveSubscription(
  db: D1Database,
  instanceId: string,
  elementId: string,
): Promise<SubscriptionRow | null> {
  return dbFirst<SubscriptionRow>(
    db,
    `SELECT * FROM message_subscriptions
       WHERE instance_id = ? AND element_id = ? AND status = 'active'
       ORDER BY rowid DESC LIMIT 1`,
    [instanceId, elementId],
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

export function incidentStmt(
  db: D1Database,
  input: {
    incidentId: string;
    instanceId: string;
    elementId: string;
    reason: string;
    retryCount: number;
    payloadContext?: JsonObject | null;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO incidents (incident_id, instance_id, element_id, reason, status, retry_count, payload_context, created_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
    [
      input.incidentId,
      input.instanceId,
      input.elementId,
      input.reason,
      input.retryCount,
      input.payloadContext ? toJson(input.payloadContext) : null,
      input.now,
    ],
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
    createdAt: row.created_at,
  };
}
