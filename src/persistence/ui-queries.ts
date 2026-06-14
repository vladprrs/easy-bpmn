// M-UI read/aggregation queries (design §12). Every query reads D1 only — the
// constitution inspection invariant — and returns operator-console view shapes.
// Saga = draft lineage (version-collapsed); a saga's stable id is its draft_id and
// its display name is the ACTIVE published version's process id (immutable), never
// the mutable drafts.name working copy (design §6, §20).

import { dbAll, dbFirst } from "./db";
import { parseJson } from "../util";
import type {
  AttentionItem,
  InstanceJobView,
  MessageSearchItem,
  ProjectRollup,
  SagaDetail,
  SagaSummary,
  StatusCounts,
  SubscriptionView,
  WorkerAttemptView,
} from "../contracts/ui";

/** Compensating instances idle longer than this are "stale" (design §12 predicate). */
export const STALE_COMPENSATING_MS = 5 * 60 * 1000;

/** Immutable saga display name: the active version's process id, else the draft name. */
function processIdOf(parsedProfile: string | null, fallback: string): string {
  const graph = parseJson<{ processId?: string } | null>(parsedProfile, null);
  return graph?.processId || fallback;
}

function hasTransactionScope(parsedProfile: string | null): boolean {
  const graph = parseJson<{ transactions?: Record<string, unknown> } | null>(parsedProfile, null);
  return Boolean(graph?.transactions && Object.keys(graph.transactions).length > 0);
}

// ---- Projects (= workspaces) ----------------------------------------------

export async function listProjects(db: D1Database, staleBeforeIso: string): Promise<ProjectRollup[]> {
  const workspaces = await dbAll<{ workspace_id: string; name: string }>(
    db,
    `SELECT workspace_id, name FROM workspaces ORDER BY workspace_id`,
  );
  const statusRows = await dbAll<{ workspace_id: string; status: string; n: number }>(
    db,
    `SELECT workspace_id, status, COUNT(*) AS n FROM process_instances GROUP BY workspace_id, status`,
  );
  const sagaRows = await dbAll<{ workspace_id: string; n: number }>(
    db,
    `SELECT workspace_id, COUNT(DISTINCT draft_id) AS n FROM definition_versions GROUP BY workspace_id`,
  );
  const attentionRows = await dbAll<{ workspace_id: string; n: number }>(
    db,
    `SELECT workspace_id, COUNT(*) AS n FROM process_instances
       WHERE status IN ('incident','compensationFailed')
          OR (status = 'compensating' AND updated_at < ?)
       GROUP BY workspace_id`,
    [staleBeforeIso],
  );

  const counts = new Map<string, StatusCounts>();
  for (const r of statusRows) {
    const c = counts.get(r.workspace_id) ?? {};
    c[r.status] = r.n;
    counts.set(r.workspace_id, c);
  }
  const sagaCount = new Map(sagaRows.map((r) => [r.workspace_id, r.n]));
  const attention = new Map(attentionRows.map((r) => [r.workspace_id, r.n]));

  return workspaces.map((w) => ({
    projectId: w.workspace_id,
    name: w.name,
    sagaCount: sagaCount.get(w.workspace_id) ?? 0,
    counts: counts.get(w.workspace_id) ?? {},
    attention: attention.get(w.workspace_id) ?? 0,
  }));
}

// ---- Cross-saga attention (on-call fast path) -----------------------------

export async function listAttention(
  db: D1Database,
  workspaceId: string,
  staleBeforeIso: string,
): Promise<AttentionItem[]> {
  const rows = await dbAll<{
    instance_id: string;
    status: string;
    current_element_id: string | null;
    business_key: string | null;
    correlation_key: string;
    updated_at: string;
    draft_id: string;
    parsed_profile: string | null;
  }>(
    db,
    `SELECT pi.instance_id, pi.status, pi.current_element_id, pi.business_key,
            pi.correlation_key, pi.updated_at, dv.draft_id, dv.parsed_profile
       FROM process_instances pi
       JOIN definition_versions dv ON pi.definition_version_id = dv.definition_version_id
      WHERE pi.workspace_id = ?
        AND ( pi.status IN ('incident','compensationFailed')
              OR (pi.status = 'compensating' AND pi.updated_at < ?) )
      ORDER BY pi.updated_at DESC`,
    [workspaceId, staleBeforeIso],
  );
  return rows.map((r) => ({
    instanceId: r.instance_id,
    sagaId: r.draft_id,
    sagaName: processIdOf(r.parsed_profile, r.draft_id),
    status: r.status,
    currentElementId: r.current_element_id,
    businessKey: r.business_key,
    correlationKey: r.correlation_key,
    reason:
      r.status === "incident"
        ? "incident"
        : r.status === "compensationFailed"
          ? "compensationFailed"
          : "staleCompensating",
    since: r.updated_at,
  }));
}

// ---- Sagas (draft lineage) -------------------------------------------------

export async function listSagas(db: D1Database, workspaceId: string): Promise<SagaSummary[]> {
  const drafts = await dbAll<{
    draft_id: string;
    name: string;
    latest_published_version_id: string | null;
  }>(
    db,
    `SELECT draft_id, name, latest_published_version_id FROM drafts
      WHERE workspace_id = ? AND latest_published_version_id IS NOT NULL
      ORDER BY updated_at DESC`,
    [workspaceId],
  );
  if (drafts.length === 0) return [];

  const versionCounts = new Map<string, number>(
    (
      await dbAll<{ draft_id: string; n: number }>(
        db,
        `SELECT draft_id, COUNT(*) AS n FROM definition_versions WHERE workspace_id = ? GROUP BY draft_id`,
        [workspaceId],
      )
    ).map((r) => [r.draft_id, r.n]),
  );

  // Counts + last activity per saga (instances → versions → draft).
  const instanceRows = await dbAll<{ draft_id: string; status: string; n: number; last: string }>(
    db,
    `SELECT dv.draft_id, pi.status, COUNT(*) AS n, MAX(pi.updated_at) AS last
       FROM process_instances pi
       JOIN definition_versions dv ON pi.definition_version_id = dv.definition_version_id
      WHERE pi.workspace_id = ?
      GROUP BY dv.draft_id, pi.status`,
    [workspaceId],
  );
  const counts = new Map<string, StatusCounts>();
  const lastActivity = new Map<string, string>();
  for (const r of instanceRows) {
    const c = counts.get(r.draft_id) ?? {};
    c[r.status] = r.n;
    counts.set(r.draft_id, c);
    const prev = lastActivity.get(r.draft_id);
    if (!prev || r.last > prev) lastActivity.set(r.draft_id, r.last);
  }

  // Active-version process id + transaction scope, one lookup per active version.
  const activeIds = drafts.map((d) => d.latest_published_version_id!).filter(Boolean);
  const activeProfiles = new Map<string, string | null>();
  if (activeIds.length > 0) {
    const placeholders = activeIds.map(() => "?").join(",");
    const rows = await dbAll<{ definition_version_id: string; parsed_profile: string | null }>(
      db,
      `SELECT definition_version_id, parsed_profile FROM definition_versions
        WHERE definition_version_id IN (${placeholders})`,
      activeIds,
    );
    for (const r of rows) activeProfiles.set(r.definition_version_id, r.parsed_profile);
  }

  return drafts.map((d) => {
    const profile = d.latest_published_version_id
      ? (activeProfiles.get(d.latest_published_version_id) ?? null)
      : null;
    return {
      sagaId: d.draft_id,
      name: processIdOf(profile, d.name),
      activeVersionId: d.latest_published_version_id,
      versionCount: versionCounts.get(d.draft_id) ?? 0,
      hasTransaction: hasTransactionScope(profile),
      counts: counts.get(d.draft_id) ?? {},
      lastActivityAt: lastActivity.get(d.draft_id) ?? null,
    };
  });
}

export async function getSagaDetail(db: D1Database, draftId: string): Promise<SagaDetail | null> {
  const draft = await dbFirst<{
    draft_id: string;
    name: string;
    latest_published_version_id: string | null;
  }>(db, `SELECT draft_id, name, latest_published_version_id FROM drafts WHERE draft_id = ?`, [draftId]);
  if (!draft) return null;

  const versions = await dbAll<{ definition_version_id: string; version_number: number; published_at: string }>(
    db,
    `SELECT definition_version_id, version_number, published_at FROM definition_versions
      WHERE draft_id = ? ORDER BY version_number DESC`,
    [draftId],
  );
  const instanceCounts = new Map<string, number>(
    (
      await dbAll<{ definition_version_id: string; n: number }>(
        db,
        `SELECT pi.definition_version_id, COUNT(*) AS n
           FROM process_instances pi
           JOIN definition_versions dv ON pi.definition_version_id = dv.definition_version_id
          WHERE dv.draft_id = ?
          GROUP BY pi.definition_version_id`,
        [draftId],
      )
    ).map((r) => [r.definition_version_id, r.n]),
  );

  let profile: string | null = null;
  if (draft.latest_published_version_id) {
    const row = await dbFirst<{ parsed_profile: string | null }>(
      db,
      `SELECT parsed_profile FROM definition_versions WHERE definition_version_id = ?`,
      [draft.latest_published_version_id],
    );
    profile = row?.parsed_profile ?? null;
  }

  return {
    sagaId: draft.draft_id,
    name: processIdOf(profile, draft.name),
    activeVersionId: draft.latest_published_version_id,
    hasTransaction: hasTransactionScope(profile),
    versions: versions.map((v) => ({
      definitionVersionId: v.definition_version_id,
      versionNumber: v.version_number,
      publishedAt: v.published_at,
      instanceCount: instanceCounts.get(v.definition_version_id) ?? 0,
    })),
  };
}

// ---- Instance jobs + worker attempts ("what did the worker receive/return") -

export async function listInstanceJobs(db: D1Database, instanceId: string): Promise<InstanceJobView[]> {
  const jobs = await dbAll<{
    job_id: string;
    element_id: string;
    task_type: string;
    status: string;
    is_compensation: number;
    attempt_count: number;
    activation_expires_at: string | null;
    lock_expires_at: string | null;
    error_code: string | null;
    created_at: string;
    updated_at: string;
  }>(
    db,
    `SELECT job_id, element_id, task_type, status, is_compensation, attempt_count,
            activation_expires_at, lock_expires_at, error_code, created_at, updated_at
       FROM service_task_jobs WHERE instance_id = ? ORDER BY created_at ASC, rowid ASC`,
    [instanceId],
  );
  const attemptRows = await dbAll<{
    job_id: string;
    attempt_number: number;
    status: string;
    request_payload: string | null;
    response_payload: string | null;
    error: string | null;
    started_at: string;
    finished_at: string | null;
  }>(
    db,
    `SELECT job_id, attempt_number, status, request_payload, response_payload, error, started_at, finished_at
       FROM worker_attempts WHERE instance_id = ? ORDER BY attempt_number ASC, rowid ASC`,
    [instanceId],
  );
  const byJob = new Map<string, WorkerAttemptView[]>();
  for (const a of attemptRows) {
    const list = byJob.get(a.job_id) ?? [];
    list.push({
      attemptNumber: a.attempt_number,
      status: a.status,
      request: a.request_payload ? parseJson(a.request_payload, null) : null,
      response: a.response_payload ? parseJson(a.response_payload, null) : null,
      error: a.error,
      startedAt: a.started_at,
      finishedAt: a.finished_at,
    });
    byJob.set(a.job_id, list);
  }
  return jobs.map((j) => ({
    jobId: j.job_id,
    elementId: j.element_id,
    taskType: j.task_type,
    status: j.status,
    isCompensation: j.is_compensation === 1,
    attemptCount: j.attempt_count,
    activationExpiresAt: j.activation_expires_at,
    lockExpiresAt: j.lock_expires_at,
    errorCode: j.error_code,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    attempts: byJob.get(j.job_id) ?? [],
  }));
}

// ---- Waiting-on subscriptions (the most common stuck case) ----------------

export async function listInstanceSubscriptions(
  db: D1Database,
  instanceId: string,
): Promise<SubscriptionView[]> {
  const subs = await dbAll<{
    subscription_id: string;
    workspace_id: string;
    element_id: string;
    message_name: string;
    correlation_key: string;
    status: string;
    expires_at: string | null;
  }>(
    db,
    `SELECT subscription_id, workspace_id, element_id, message_name, correlation_key, status, expires_at
       FROM message_subscriptions WHERE instance_id = ? AND status = 'active'`,
    [instanceId],
  );
  const out: SubscriptionView[] = [];
  for (const s of subs) {
    const buffered = await dbFirst<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM external_messages
        WHERE workspace_id = ? AND message_name = ? AND correlation_key = ? AND final_outcome = 'buffered'`,
      [s.workspace_id, s.message_name, s.correlation_key],
    );
    out.push({
      subscriptionId: s.subscription_id,
      elementId: s.element_id,
      messageName: s.message_name,
      correlationKey: s.correlation_key,
      status: s.status,
      expiresAt: s.expires_at,
      bufferedCount: buffered?.n ?? 0,
    });
  }
  return out;
}

// ---- Message search (the only home for un-correlated messages) ------------

export async function searchMessages(
  db: D1Database,
  input: {
    workspaceId: string;
    messageName?: string;
    correlationKey?: string;
    outcome?: string;
    cursor?: number;
    limit: number;
  },
): Promise<{ items: MessageSearchItem[]; nextCursor: number | null }> {
  const where = ["workspace_id = ?"];
  const params: unknown[] = [input.workspaceId];
  if (input.messageName) {
    where.push("message_name = ?");
    params.push(input.messageName);
  }
  if (input.correlationKey) {
    where.push("correlation_key = ?");
    params.push(input.correlationKey);
  }
  if (input.outcome) {
    where.push("final_outcome = ?");
    params.push(input.outcome);
  }
  if (input.cursor != null) {
    where.push("rowid < ?");
    params.push(input.cursor);
  }
  params.push(input.limit + 1);
  const rows = await dbAll<{
    rowid: number;
    external_message_id: string;
    message_name: string;
    correlation_key: string;
    final_outcome: string;
    matched_instance_id: string | null;
    reason: string | null;
    received_at: string;
  }>(
    db,
    `SELECT rowid, external_message_id, message_name, correlation_key, final_outcome,
            matched_instance_id, reason, received_at
       FROM external_messages WHERE ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`,
    params,
  );
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const nextCursor = hasMore ? page[page.length - 1]!.rowid : null;
  return {
    items: page.map((r) => ({
      externalMessageId: r.external_message_id,
      messageName: r.message_name,
      correlationKey: r.correlation_key,
      finalOutcome: r.final_outcome,
      matchedInstanceId: r.matched_instance_id,
      reason: r.reason,
      receivedAt: r.received_at,
    })),
    nextCursor,
  };
}

// ---- Raw BPMN XML (resolves G1 so the SPA can render the diagram) ----------

export async function getVersionXml(
  db: D1Database,
  versionId: string,
): Promise<{ bpmnXml: string; bpmnXmlHash: string } | null> {
  const row = await dbFirst<{ bpmn_xml: string; bpmn_xml_hash: string }>(
    db,
    `SELECT bpmn_xml, bpmn_xml_hash FROM definition_versions WHERE definition_version_id = ?`,
    [versionId],
  );
  return row ? { bpmnXml: row.bpmn_xml, bpmnXmlHash: row.bpmn_xml_hash } : null;
}

// ---- Extended instance list (search / sagaId / multi-status) --------------

export interface InstanceListItemRow {
  instanceId: string;
  status: string;
  currentElementId: string | null;
  correlationKey: string;
  businessKey: string | null;
  startedAt: string;
  updatedAt: string;
}

export async function listInstancesFiltered(
  db: D1Database,
  input: {
    workspaceId: string;
    statuses?: string[];
    search?: string;
    sagaId?: string;
    limit: number;
    cursor?: number;
  },
): Promise<{ items: InstanceListItemRow[]; nextCursor: number | null }> {
  const where = ["pi.workspace_id = ?"];
  const params: unknown[] = [input.workspaceId];
  if (input.statuses && input.statuses.length > 0) {
    where.push(`pi.status IN (${input.statuses.map(() => "?").join(",")})`);
    params.push(...input.statuses);
  }
  if (input.search) {
    where.push("(pi.business_key LIKE ? OR pi.correlation_key LIKE ?)");
    const like = `%${input.search}%`;
    params.push(like, like);
  }
  // sagaId = draft_id; join through the bound version (no denormalized draft_id).
  const join = input.sagaId
    ? "JOIN definition_versions dv ON pi.definition_version_id = dv.definition_version_id"
    : "";
  if (input.sagaId) {
    where.push("dv.draft_id = ?");
    params.push(input.sagaId);
  }
  if (input.cursor != null) {
    where.push("pi.rowid < ?");
    params.push(input.cursor);
  }
  params.push(input.limit + 1);
  const rows = await dbAll<InstanceListItemRow & { rowid: number }>(
    db,
    `SELECT pi.rowid AS rowid, pi.instance_id AS instanceId, pi.status AS status,
            pi.current_element_id AS currentElementId, pi.correlation_key AS correlationKey,
            pi.business_key AS businessKey, pi.started_at AS startedAt, pi.updated_at AS updatedAt
       FROM process_instances pi ${join}
      WHERE ${where.join(" AND ")} ORDER BY pi.rowid DESC LIMIT ?`,
    params,
  );
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const nextCursor = hasMore ? page[page.length - 1]!.rowid : null;
  return { items: page.map(({ rowid, ...rest }) => rest), nextCursor };
}
