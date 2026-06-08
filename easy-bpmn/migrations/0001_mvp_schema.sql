-- BPMN-lite Orchestrator MVP — canonical D1 schema.
--
-- D1 is the canonical, queryable source of record (see plan.md / runtime-contracts.md):
-- drafts, immutable versions, parsed profile metadata, instances, variables, jobs,
-- attempts, subscriptions, external messages, history, incidents, and idempotency.
-- JSON-shaped values are stored as TEXT and (de)serialized in src/persistence.

-- ---------------------------------------------------------------------------
-- Workspaces — tenancy scope for deterministic correlation uniqueness.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Definition drafts — editable BPMN XML before publish.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drafts (
  draft_id                     TEXT PRIMARY KEY,
  workspace_id                 TEXT NOT NULL,
  name                         TEXT NOT NULL,
  bpmn_xml                     TEXT NOT NULL,
  status                       TEXT NOT NULL,          -- draft | valid | invalid
  validation_issues            TEXT NOT NULL,          -- JSON array of ValidationIssue
  latest_published_version_id  TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_workspace ON drafts (workspace_id);

-- ---------------------------------------------------------------------------
-- Immutable definition versions — published, executable snapshots.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS definition_versions (
  definition_version_id TEXT PRIMARY KEY,
  draft_id              TEXT NOT NULL,
  workspace_id          TEXT NOT NULL,
  version_number        INTEGER NOT NULL,
  bpmn_xml              TEXT NOT NULL,
  bpmn_xml_hash         TEXT NOT NULL,
  parsed_profile        TEXT NOT NULL,                 -- JSON ExecutionGraph
  status                TEXT NOT NULL,                 -- published
  published_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_draft ON definition_versions (draft_id);
CREATE INDEX IF NOT EXISTS idx_versions_workspace ON definition_versions (workspace_id);

-- ---------------------------------------------------------------------------
-- BPMN elements — supported elements extracted from a published version.
-- elementId is audit-only; serviceTask routing uses task_type, never the id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bpmn_elements (
  definition_version_id TEXT NOT NULL,
  element_id            TEXT NOT NULL,
  type                  TEXT NOT NULL,                 -- startEvent|serviceTask|receiveTask|endEvent|sequenceFlow|message
  name                  TEXT,
  task_type             TEXT,                          -- serviceTask worker routing key
  message_name          TEXT,                          -- receiveTask / message
  retries               INTEGER,
  metadata              TEXT,                          -- JSON
  PRIMARY KEY (definition_version_id, element_id)
);

-- ---------------------------------------------------------------------------
-- Process instances — one execution of a published version.
-- Workflow Instance Binding fields are inlined (1:1 with the instance).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS process_instances (
  instance_id           TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  definition_version_id TEXT NOT NULL,
  workflow_instance_id  TEXT NOT NULL,
  workflow_status       TEXT,
  business_key          TEXT,
  correlation_key       TEXT NOT NULL,
  status                TEXT NOT NULL,                 -- starting|running|waiting|completed|incident
  current_element_id    TEXT,
  variables             TEXT NOT NULL,                 -- JSON object
  started_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  completed_at          TEXT,
  last_synced_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_instances_workspace ON process_instances (workspace_id);
CREATE INDEX IF NOT EXISTS idx_instances_version ON process_instances (definition_version_id);

-- ---------------------------------------------------------------------------
-- Variable snapshots — historical variable state by source.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS variable_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  source      TEXT NOT NULL,                           -- start | serviceTask | message
  source_id   TEXT,
  variables   TEXT NOT NULL,                           -- JSON object
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_var_snapshots_instance ON variable_snapshots (instance_id);

-- ---------------------------------------------------------------------------
-- Service Task jobs — durable execution state, persisted before worker runs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_task_jobs (
  job_id           TEXT PRIMARY KEY,
  instance_id      TEXT NOT NULL,
  element_id       TEXT NOT NULL,
  task_type        TEXT NOT NULL,
  status           TEXT NOT NULL,                      -- created|running|completed|failed
  retry_limit      INTEGER NOT NULL,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  idempotency_key  TEXT NOT NULL,
  input_variables  TEXT NOT NULL,                      -- JSON object
  output_variables TEXT,                               -- JSON object
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_instance ON service_task_jobs (instance_id);
-- One job per (instance, element): guards persist-before-advance idempotency.
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_instance_element
  ON service_task_jobs (instance_id, element_id);

-- ---------------------------------------------------------------------------
-- Worker attempts — one delivery of a job to the worker.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS worker_attempts (
  attempt_id         TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL,
  instance_id        TEXT NOT NULL,
  attempt_number     INTEGER NOT NULL,
  workflow_step_name TEXT,
  status             TEXT NOT NULL,                    -- started|succeeded|failed
  request_payload    TEXT,                             -- JSON
  response_payload   TEXT,                             -- JSON
  error              TEXT,
  started_at         TEXT NOT NULL,
  finished_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_job ON worker_attempts (job_id);

-- ---------------------------------------------------------------------------
-- Message subscriptions — durable Receive Task wait state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_subscriptions (
  subscription_id     TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  instance_id         TEXT NOT NULL,
  element_id          TEXT NOT NULL,
  message_name        TEXT NOT NULL,
  correlation_key     TEXT NOT NULL,
  broker_key          TEXT NOT NULL,
  workflow_event_type TEXT NOT NULL,
  status              TEXT NOT NULL,                   -- active|consumed|expired|cancelled
  created_at          TEXT NOT NULL,
  expires_at          TEXT,
  consumed_at         TEXT,
  external_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_subs_instance ON message_subscriptions (instance_id);
CREATE INDEX IF NOT EXISTS idx_subs_broker ON message_subscriptions (broker_key);

-- ---------------------------------------------------------------------------
-- External messages — business events submitted by external systems.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS external_messages (
  external_message_id   TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  message_name          TEXT NOT NULL,
  correlation_key       TEXT NOT NULL,
  message_id            TEXT NOT NULL,
  payload               TEXT NOT NULL,                 -- JSON object
  payload_hash          TEXT NOT NULL,
  outcome               TEXT NOT NULL,                 -- public outcome at insert time
  final_outcome         TEXT NOT NULL,                 -- correlated|buffered|duplicate|expired|late|rejected|invariantViolation
  reason                TEXT,                          -- operator-visible reason for late/rejected outcomes
  original_response     TEXT,                          -- JSON stable response
  matched_instance_id   TEXT,
  matched_subscription_id TEXT,
  duplicate_of          TEXT,
  received_at           TEXT NOT NULL,
  expires_at            TEXT,
  correlated_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_dedup
  ON external_messages (workspace_id, message_name, correlation_key, message_id);

-- ---------------------------------------------------------------------------
-- History events — operator-visible audit + technical diagnostics.
-- Ordering is by insertion (SQLite rowid).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS history_events (
  history_event_id    TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  instance_id         TEXT,
  external_message_id TEXT,
  element_id          TEXT,
  type                TEXT NOT NULL,
  business_time       TEXT NOT NULL,
  technical_time      TEXT NOT NULL,
  payload_snapshot    TEXT,                            -- JSON
  diagnostics         TEXT NOT NULL                    -- JSON
);
CREATE INDEX IF NOT EXISTS idx_history_instance ON history_events (instance_id);
CREATE INDEX IF NOT EXISTS idx_history_message ON history_events (external_message_id);

-- ---------------------------------------------------------------------------
-- Incidents — view-only terminal runtime problems.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
  incident_id     TEXT PRIMARY KEY,
  instance_id     TEXT NOT NULL,
  element_id      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL,                       -- open
  retry_count     INTEGER NOT NULL DEFAULT 0,
  payload_context TEXT,                                -- JSON
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_instance ON incidents (instance_id);

-- ---------------------------------------------------------------------------
-- Idempotency records — stable results for at-least-once inputs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_records (
  scope           TEXT NOT NULL,                       -- startInstance|workerCallback|messagePublish|workflowEvent
  idempotency_key TEXT NOT NULL,
  result          TEXT NOT NULL,                       -- JSON
  created_at      TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);
