---
id: TASK-13
title: >-
  Worker authentication and per-workspace tenant isolation for the /jobs/* pull
  data plane
status: Done
assignee: []
created_date: '2026-06-08 08:17'
updated_date: '2026-06-08 12:33'
labels:
  - saga
  - api
  - persistence
  - security
  - tests
milestone: m-1
dependencies:
  - TASK-12
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#2-locked-decisions
    (decision #6)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#6-api-deltas
    (Worker authentication & workspace isolation)
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#10-risks (R6)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#11-backlog-mapping
    (M1 task 4)
  - 'src/index.ts:385-417 (flat router)'
  - 'src/index.ts:419-429 (errorResponse AppError mapping)'
  - 'src/index.ts:54-66 (parseBody / zod boundary)'
  - 'src/runtime/errors.ts:6-48 (AppError + subclasses)'
  - src/contracts/api.ts (zod request/response schemas)
  - 'src/persistence/db.ts:44-54 (ensureWorkspace'
  - db helpers)
  - src/persistence/idempotency.ts (IdempotencyScope)
  - src/util.ts (sha256Hex
  - newId
  - nowIso)
  - 'migrations/0001_mvp_schema.sql:105-123 (service_task_jobs'
  - no workspace_id)
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - specs/002-saga-orchestrator/contracts/runtime-contracts.md
  - docs/bpmn/09-easy-bpmn-profile.md
modified_files:
  - migrations/0002_worker_credentials.sql
  - src/persistence/worker-credentials.ts
  - src/runtime/worker-auth.ts
  - src/runtime/errors.ts
  - src/contracts/api.ts
  - src/index.ts
  - tests/helpers.ts
  - tests/contract/worker-auth.test.ts
  - tests/integration/worker-workspace-isolation.test.ts
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - specs/002-saga-orchestrator/contracts/runtime-contracts.md
priority: high
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Adds per-workspace worker authentication and tenant isolation for the new pull-based /jobs/* data plane (design §2 decision #6, §6 "Worker authentication & workspace isolation", risk R6 in §10). In the pull/external-task model (decision #2) remote microservices lease jobs by taskType then call complete/fail; with no auth, any caller could lease or complete another tenant's job and exfiltrate its input/output payloads. Decision: every /jobs/* call carries `Authorization: Bearer <token>`; the server DERIVES workspaceId from the credential and NEVER trusts a body-supplied workspaceId for job access; the activate lease and complete/fail ownership checks are scoped to that derived workspace. Credentials live in a new `worker_credentials` table (workspace_id, token_hash, created_at, revoked_at) — only the SHA-256 hash is stored; the raw token is returned once at mint and is never retrievable again.

This task owns: the credential lifecycle (mint + revoke endpoints), the authenticateWorker middleware that resolves a bearer token to a workspaceId, the 401/403 error classes, and the /jobs/* auth gate + workspace-scoping helpers that the sibling activate/complete/fail tasks (design §11 tasks 5–6, §4.3) consume. It MUST land before/with those so they inherit server-derived tenancy.

Grounding: there is no auth anywhere today; management endpoints trust a body workspaceId (src/index.ts handlers) and that convention stays for the management plane (securing it is a separate gap). service_task_jobs (migrations/0001_mvp_schema.sql:105-123) has no workspace_id column, so workspace-scoped leasing needs a join to process_instances.workspace_id or a denormalized column (coordinate with the lease migration). Reuse sha256Hex (src/util.ts), ensureWorkspace (src/persistence/db.ts:44), the flat router (src/index.ts:385) and the generic AppError mapping (src/index.ts:419-429).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A new additive migration creates worker_credentials(credential_id PK, workspace_id, token_hash, label, created_at, revoked_at) with a UNIQUE index on token_hash and an index on workspace_id; no published/existing migration is mutated.
- [x] #2 POST /worker-credentials mints a per-workspace token: a >=256-bit random token is generated, only its sha256 hash is persisted (the raw token is never stored), and the raw token is returned exactly once in the 201 body alongside credentialId, workspaceId, createdAt; the response is validated by a zod schema.
- [x] #3 POST /worker-credentials/{credentialId}/revoke sets revoked_at; revoking an unknown or already-revoked credential is idempotent (no 500); after revoke, any /jobs/* call using that token is rejected 401.
- [x] #4 Every /jobs/* request is authenticated via Authorization: Bearer <token>, matched by sha256 hash against active (revoked_at IS NULL) credentials; missing header, non-Bearer/malformed header, unknown token, and revoked token each return 401 with a stable {error} body and no internal/stack leak.
- [x] #5 The server derives workspaceId from the credential and never trusts a body workspaceId for job access: a /jobs/* body containing a spoofed workspaceId does not change the workspace used for the operation.
- [x] #6 Workspace isolation holds: a credential for workspace A cannot lease, complete, or fail jobs of workspace B — activate returns only the credential-workspace's jobs (a taskType present only in another workspace yields zero jobs), and cross-tenant complete/fail on a foreign jobId returns 404 (foreign existence is not confirmed). The activate lease query and complete/fail ownership checks are scoped by the derived workspaceId.
- [x] #7 New UnauthorizedError (401) and ForbiddenError (403) AppError subclasses map through the existing errorResponse in src/index.ts to stable {error} bodies with no change to the catch-all.
- [x] #8 Constitution gate: tests/contract/worker-auth.test.ts covers the mint->use->revoke lifecycle, all four 401 cases, single-use raw-token exposure, and body-workspaceId-not-trusted.
- [x] #9 Constitution gate: tests/integration/worker-workspace-isolation.test.ts (vitest-pool-workers against D1) proves server-derived workspace resolution and cross-tenant denial (workspace A cannot lease/complete/fail a workspace B job).
- [x] #10 Docs: specs/002-saga-orchestrator/contracts/openapi.yaml gains the bearer security scheme, the worker-credential mint/revoke endpoints, and an explicit note that /jobs/* workspaceId is server-derived (never request-supplied); specs/002-saga-orchestrator/contracts/runtime-contracts.md documents the credential->workspace derivation and isolation rule.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Migration: add migrations/0002_worker_credentials.sql (coordinate the numeric prefix with the sibling saga-ledger migration in design §5): CREATE TABLE worker_credentials(...); CREATE UNIQUE INDEX uq_worker_credentials_token ON worker_credentials(token_hash); CREATE INDEX idx_worker_credentials_workspace ON worker_credentials(workspace_id). Additive only.
2. Persistence: new src/persistence/worker-credentials.ts using db.ts helpers — insertCredential, getActiveByTokenHash (WHERE token_hash=? AND revoked_at IS NULL), revokeCredential (UPDATE SET revoked_at=? WHERE credential_id=? AND revoked_at IS NULL).
3. Errors: extend src/runtime/errors.ts (after ConflictError ~:37) with UnauthorizedError(401) and ForbiddenError(403); they flow through errorResponse (src/index.ts:423) unchanged.
4. Auth module: new src/runtime/worker-auth.ts — generateWorkerToken() (32 random bytes via crypto.getRandomValues, base64url, wct_ prefix); authenticateWorker(request, env): parse Authorization, require 'Bearer ', sha256Hex(token) (src/util.ts), look up active credential, throw UnauthorizedError on any miss, return {workspaceId, credentialId}; assertJobInWorkspace(env, jobId, workspaceId) returning the job row only if it belongs to the workspace (else NotFound — do not confirm foreign existence).
5. Contracts: in src/contracts/api.ts add mintWorkerCredentialRequestSchema ({workspaceId, label?}) plus a zod-validated mint response (token shown once) and a list view (no token); document that /jobs/* request schemas omit workspaceId (server-derived).
6. Router + handlers in src/index.ts: add handleMintWorkerCredential and handleRevokeWorkerCredential; register /worker-credentials (POST) and /worker-credentials/{id}/revoke (POST) in route() (mirroring :394-414). Add a seg[0]==='jobs' branch that calls authenticateWorker FIRST, then dispatches to activate/complete/fail, passing the derived workspaceId in (handler bodies are sibling tasks §11.5-6).
7. Workspace scoping: require service_task_jobs leasing and complete/fail to filter by the derived workspaceId — denormalize workspace_id onto service_task_jobs in the lease migration OR join process_instances.workspace_id; coordinate with §11 task 3/5 (the lease IN-subquery in §4.3 must add AND workspace_id=:ws).
8. Tests: add tests/contract/worker-auth.test.ts and tests/integration/worker-workspace-isolation.test.ts; add a mintWorkerToken/authedPost helper to tests/helpers.ts (over SELF.fetch).
9. Docs: update specs/002-saga-orchestrator/contracts/openapi.yaml (security scheme + endpoints + server-derived-workspaceId note) and runtime-contracts.md (derivation + isolation rule).
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Per-workspace worker auth + tenant isolation for /jobs/*. worker_credentials table (consolidated into migrations/0002_saga.sql) stores only the SHA-256 token hash. src/persistence/worker-credentials.ts (insert/getActiveByTokenHash/getCredential/revoke idempotent). src/runtime/worker-auth.ts: generateWorkerToken() (32-byte base64url, wct_ prefix), authenticateWorker(request,env) parses Bearer → sha256 → active credential → {workspaceId, credentialId}, throwing UnauthorizedError on any miss. src/runtime/errors.ts: UnauthorizedError(401)+ForbiddenError(403) flow through the existing errorResponse. POST /worker-credentials mints (raw token returned once) and POST /worker-credentials/{id}/revoke revokes idempotently. Every /jobs/* handler calls authenticateWorker first and derives workspaceId from the credential — the activate lease JOINs process_instances.workspace_id and complete/fail use getJobInWorkspace (foreign job → 404, never confirms existence); request schemas omit workspaceId so a spoofed body value is stripped by zod. tests/contract/worker-auth.test.ts (mint→use→revoke, four 401 cases, single-use token, spoofed-workspaceId-ignored) + tests/integration/saga-pull-jobs.test.ts (cross-tenant lease returns zero). openapi/runtime-contracts documented in specs/002 (TASK-8). Full suite green (81).
<!-- SECTION:FINAL_SUMMARY:END -->
