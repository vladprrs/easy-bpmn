---
id: TASK-12
title: >-
  Saga persistence foundation: D1 migration 0002 (ledger, compensation job lane,
  lease/DLQ, incidents) + statement builders
status: To Do
assignee: []
created_date: '2026-06-08 08:17'
labels:
  - saga
  - persistence
  - d1-migration
  - tests
milestone: m-1
dependencies: []
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§5 Data model
    deltas)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.4
    Compensation algorithm)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.6 Status
    lifecycle)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.7
    Idempotency / at-least-once additions)
  - migrations/0001_mvp_schema.sql
  - src/persistence/instances.ts
  - src/persistence/db.ts
  - tests/apply-migrations.ts
  - vitest.config.ts
  - wrangler.jsonc
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - specs/002-saga-orchestrator/data-model.md
modified_files:
  - migrations/0002_saga.sql
  - src/persistence/instances.ts
  - src/persistence/saga.ts
  - src/persistence/credentials.ts
  - tests/integration/migration-0002-saga.test.ts
  - specs/002-saga-orchestrator/data-model.md
priority: high
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one additive D1 migration (migrations/0002_saga.sql) plus matching persistence statement builders give M1 the storage substrate for transaction-saga orchestration. No engine/runtime behavior changes here; later M1 tasks (pull leasing, compensation pass, operator verbs, worker auth) build on this schema.

WHY (design 2026-06-08 §5): the MVP schema blocks saga work in three places. (1) uq_jobs_instance_element (0001:122-123) forbids a second job per element, so a compensation job cannot coexist with its forward job. Relax uniqueness to (instance_id, element_id, is_compensation): a compensation job carries element_id = the FORWARD element with is_compensation=1 and compensates_element_id set, so one shared handler can compensate several steps. CAVEAT (carry in the migration header): this relaxed shape is NOT stable past M1 — gateways/loops/multiInstance (M2/M4/M5) re-run the same element and will need a token/iteration discriminator. (2) No completed-step ledger exists; the reverse-order compensation pass needs saga_steps (the durable completed-step stack), written INSERT OR IGNORE on uq_saga_steps_forward at forward completion so replay/duplicate-complete is a no-op — closes the double-compensation hole (§4.4). (3) incidents are view-only with no remediation linkage; add kind + resolution so an incident can drive/track compensation. Also add pull-lease/DLQ columns (worker_id, lock_token, lock_expires_at, activation_expires_at, error_code) + idx_jobs_leasable, idx_instances_workspace_status (backs the new operator list endpoint), and worker_credentials (per-workspace bearer tokens; the auth middleware itself is a separate M1 task). Additive only — never mutate published versions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 migrations/0002_saga.sql applies cleanly on top of 0001 in the vitest workerd runtime (applyD1Migrations via tests/apply-migrations.ts) with no error; statements use IF EXISTS / IF NOT EXISTS guards so re-application is safe.
- [ ] #2 service_task_jobs gains is_compensation (NOT NULL DEFAULT 0), compensates_element_id, worker_id, lock_token, lock_expires_at, activation_expires_at, error_code; existing forward-job inserts continue to succeed without supplying the new columns.
- [ ] #3 The single-column job uniqueness is removed and replaced by (instance_id, element_id, is_compensation): two FORWARD jobs for the same (instance_id, element_id) are rejected, while a forward job plus a compensation job (is_compensation=1) for that same element are BOTH accepted.
- [ ] #4 saga_steps ledger table exists with the design §5 columns (step_id, instance_id, scope_id, seq, element_id, forward_job_id, captured_input, captured_output, compensation_element_id, compensation_task_type, compensation_job_id, compensation_status, trace_id, created_at, updated_at) plus a unique (instance_id, element_id) index and idx_saga_steps_scope (instance_id, scope_id, seq).
- [ ] #5 Inserting a duplicate completed step for the same (instance_id, element_id) via INSERT OR IGNORE leaves exactly one row (no double-compensation), asserted by test.
- [ ] #6 idx_jobs_leasable (task_type, status, lock_expires_at) and idx_instances_workspace_status (workspace_id, status) both exist.
- [ ] #7 incidents gains kind and resolution columns; the existing incidentStmt insert still succeeds and getIncidentForInstance returns the new fields.
- [ ] #8 worker_credentials table exists with workspace_id, token_hash, created_at, revoked_at (token_hash uniquely resolvable to a workspace).
- [ ] #9 Persistence statement builders are updated and compile under tsc: JobRow + createJob carry the new job columns (forward defaults: is_compensation=0, compensates_element_id NULL) with optional params so existing callers are unchanged; a new saga ledger module exposes INSERT-OR-IGNORE, a reverse-order (seq DESC) scope select filtered to compensation_status IN ('pending','compensating','failed'), and a compensation-status update; incident builders carry kind/resolution.
- [ ] #10 REQUIRED constitution persistence gate: a new integration test (tests/integration/migration-0002-saga.test.ts) runs in the workerd pool against env.DB and asserts (a) presence of every new table/column/index via PRAGMA, (b) the two job-uniqueness behaviors, and (c) the saga_steps INSERT OR IGNORE idempotency; the full existing suite (npm run test) stays green with no regressions.
- [ ] #11 Docs: specs/002-saga-orchestrator/data-model.md records the new entities/columns/indexes, and the migration header documents the §5 'relaxed index not stable past M1' caveat.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add migrations/0002_saga.sql after migrations/0001_mvp_schema.sql; vitest.config.ts readD1Migrations("./migrations") + tests/apply-migrations.ts pick it up automatically (no test wiring change). Header comment carries the §5 "not stable past M1" caveat.
2. In 0002, ALTER TABLE service_task_jobs (cf 0001:105-119) ADD COLUMN is_compensation INTEGER NOT NULL DEFAULT 0, compensates_element_id TEXT, worker_id TEXT, lock_token TEXT, lock_expires_at TEXT, activation_expires_at TEXT, error_code TEXT.
3. DROP INDEX IF EXISTS uq_jobs_instance_element (0001:122-123); CREATE UNIQUE INDEX uq_jobs_instance_element_kind (instance_id, element_id, is_compensation); CREATE INDEX idx_jobs_leasable (task_type, status, lock_expires_at).
4. CREATE TABLE saga_steps with the §5 columns; CREATE UNIQUE INDEX uq_saga_steps_forward (instance_id, element_id); CREATE INDEX idx_saga_steps_scope (instance_id, scope_id, seq).
5. ALTER TABLE incidents (0001:211-220) ADD COLUMN kind TEXT, resolution TEXT; CREATE INDEX idx_instances_workspace_status (workspace_id, status) (composite, alongside existing idx_instances_workspace at 0001:86); CREATE TABLE worker_credentials (credential_id PK, workspace_id, token_hash UNIQUE, created_at, revoked_at).
6. src/persistence/instances.ts: extend JobRow (189-203) and createJob INSERT (217-247) with the new job columns via optional params (forward default is_compensation=0, compensates_element_id NULL) so engine.ts:250 caller is unchanged.
7. src/persistence/instances.ts: extend incidentStmt (469-495) + getIncidentForInstance (497-526) for kind/resolution.
8. New src/persistence/saga.ts: SagaStepRow + mapSagaStep + insertSagaStepStmt (INSERT OR IGNORE, §4.4) + selectScopeStepsForCompensation (seq DESC, compensation_status IN (...)) + updateCompensationStatusStmt. Statement builders only — the engine reverse pass is a separate task.
9. New src/persistence/credentials.ts: insertWorkerCredentialStmt + findWorkspaceByTokenHash (revoked_at IS NULL) — schema seam only; auth middleware is the worker-auth task.
10. Add tests/integration/migration-0002-saga.test.ts (env.DB, PRAGMA table_info/index_list + insert assertions). Run npm run test.
<!-- SECTION:PLAN:END -->
