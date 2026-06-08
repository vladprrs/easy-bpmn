-- SAGA orchestrator (M1) — additive D1 deltas over 0001_mvp_schema.sql.
--
-- Storage substrate for transaction-saga orchestration: the pull-lease columns
-- on service_task_jobs, the saga_steps completed-step ledger (the reverse-order
-- compensation stack), incident remediation linkage, the operator-list index,
-- and per-workspace worker credentials. No runtime behavior lives here.
--
-- ⚠️ CAVEAT (design §5): the relaxed job-uniqueness shape below
-- (instance_id, element_id, is_compensation) is NOT stable past M1. Gateways /
-- loops / multiInstance (M2/M4/M5) re-run the SAME element id within one instance
-- and will need a token/iteration discriminator added to this index.
--
-- Migrations are applied exactly once (tracked by the migration runner), so the
-- ALTER TABLE ... ADD COLUMN statements (which SQLite cannot guard with
-- IF NOT EXISTS) are safe; CREATE statements use IF NOT EXISTS for belt-and-braces.

-- ---------------------------------------------------------------------------
-- service_task_jobs — pull lease + compensation lane + DLQ + business error +
-- denormalized workspace scoping (so the lease query never trusts a body value).
-- ---------------------------------------------------------------------------
ALTER TABLE service_task_jobs ADD COLUMN workspace_id          TEXT;
ALTER TABLE service_task_jobs ADD COLUMN is_compensation       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_task_jobs ADD COLUMN compensates_element_id TEXT;
ALTER TABLE service_task_jobs ADD COLUMN worker_id             TEXT;
ALTER TABLE service_task_jobs ADD COLUMN lock_token            TEXT;
ALTER TABLE service_task_jobs ADD COLUMN lock_expires_at       TEXT;
ALTER TABLE service_task_jobs ADD COLUMN activation_expires_at TEXT;     -- job-level DLQ TTL
ALTER TABLE service_task_jobs ADD COLUMN error_code            TEXT;     -- business error → BPMN error

-- A compensation job carries element_id = the FORWARD (compensated) element id
-- with is_compensation=1 + compensates_element_id set, so uniqueness becomes one
-- forward + one compensation per forward element (a handler may compensate many).
DROP INDEX IF EXISTS uq_jobs_instance_element;
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_instance_element_kind
  ON service_task_jobs (instance_id, element_id, is_compensation);
CREATE INDEX IF NOT EXISTS idx_jobs_leasable
  ON service_task_jobs (task_type, status, lock_expires_at);

-- ---------------------------------------------------------------------------
-- saga_steps — the durable completed-step ledger (reverse-order compensation
-- stack). One row per completed compensatable forward step, written INSERT OR
-- IGNORE at forward completion (atomic with advance) so replay is a no-op.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga_steps (
  step_id                 TEXT PRIMARY KEY,
  instance_id             TEXT NOT NULL,
  scope_id                TEXT NOT NULL,     -- the <transaction> element id
  seq                     INTEGER NOT NULL,  -- monotonic completion order within scope
  element_id              TEXT NOT NULL,     -- forward activity
  forward_job_id          TEXT NOT NULL,
  captured_input          TEXT NOT NULL,     -- JSON
  captured_output         TEXT,              -- JSON
  compensation_element_id TEXT,              -- isForCompensation handler, or NULL (no compensator)
  compensation_task_type  TEXT,
  compensation_job_id     TEXT,
  compensation_status     TEXT NOT NULL,     -- pending|notRequired|compensating|compensated|failed
  trace_id                TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saga_steps_forward ON saga_steps (instance_id, element_id);
CREATE INDEX IF NOT EXISTS idx_saga_steps_scope ON saga_steps (instance_id, scope_id, seq);

-- ---------------------------------------------------------------------------
-- incidents — remediation linkage so an incident can drive/track compensation.
-- ---------------------------------------------------------------------------
ALTER TABLE incidents ADD COLUMN kind       TEXT NOT NULL DEFAULT 'serviceTaskFailure'; -- serviceTaskFailure|compensationFailure|timeout
ALTER TABLE incidents ADD COLUMN resolution TEXT NOT NULL DEFAULT 'open';               -- open|compensating|compensated|operatorResolved

-- ---------------------------------------------------------------------------
-- Operator list index — find stuck / compensating / incident sagas.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_instances_workspace_status ON process_instances (workspace_id, status);

-- ---------------------------------------------------------------------------
-- worker_credentials — per-workspace bearer tokens for the /jobs/* pull plane.
-- Only the SHA-256 hash is stored; the raw token is shown once at mint.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS worker_credentials (
  credential_id TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  label         TEXT,
  created_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_credentials_token ON worker_credentials (token_hash);
CREATE INDEX IF NOT EXISTS idx_worker_credentials_workspace ON worker_credentials (workspace_id);
