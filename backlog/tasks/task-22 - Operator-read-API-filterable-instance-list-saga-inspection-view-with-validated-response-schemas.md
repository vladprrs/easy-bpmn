---
id: TASK-22
title: >-
  Operator read API: filterable instance list + saga inspection view with
  validated response schemas
status: To Do
assignee: []
created_date: '2026-06-08 08:18'
labels:
  - api
  - saga
  - persistence
  - observability
  - tests
milestone: m-1
dependencies:
  - TASK-12
  - TASK-18
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§6 API deltas
    — 'Saga visibility' + GET /instances list bullet)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§5 —
    saga_steps table
  - idx_instances_workspace_status
  - trace_id)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.6 status
    lifecycle — compensating/compensated/compensationFailed/cancelled)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§11 — M1 task
    11)
  - >-
    src/index.ts:203-219 (handleGetInstance / ProcessInstanceInspection
    assembly)
  - 'src/index.ts:406-409 (router /instances branch)'
  - >-
    src/contracts/api.ts:71-112 (ProcessInstance / ProcessInstanceInspection
    interfaces to convert to zod)
  - 'src/persistence/instances.ts:34-48'
  - 96-102 (mapInstance
  - getInstance)
  - 'src/persistence/history.ts:72-82 (listInstanceHistory)'
  - >-
    migrations/0001_mvp_schema.sql:86 (existing single-col
    idx_instances_workspace)
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - docs/bpmn/09-easy-bpmn-profile.md
modified_files:
  - src/index.ts
  - src/contracts/api.ts
  - src/persistence/instances.ts
  - src/persistence/saga-steps.ts
  - tests/contract/instances-read.test.ts
  - tests/integration/saga-inspection.test.ts
  - specs/002-saga-orchestrator/contracts/openapi.yaml
priority: medium
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operators have no way to discover sagas that need attention and no way to see a saga's compensation state. Today GET /instances/{id} returns only the flat ProcessInstanceInspection (src/index.ts:203-219) and there is NO list endpoint — the router handles only GET /instances/{id} and .../history (src/index.ts:406-409). Per design §6 ("Saga visibility" + the list bullet), add the operator read surface for the SAGA orchestrator:

1) GET /instances?workspaceId=&status=&limit=&cursor= — a workspace-scoped, status-filterable, cursor-paginated list so operators can find compensating / compensationFailed / incident sagas. Backed by idx_instances_workspace_status (workspace_id, status) added by the saga migration (M1 task "saga ledger migration…list index", design §5). workspaceId is mandatory so the list cannot enumerate across tenants.

2) Extend GET /instances/{id} with a `saga` block: phase (forward|compensating|compensated|compensationFailed), per-step status read from the saga_steps ledger (§5), which steps were compensated, and traceId. The existing ProcessInstanceInspection fields are retained.

3) Add REAL zod response schemas for these endpoints. Responses today are un-validated TS interfaces (src/contracts/api.ts:71-112); design §6 makes "new endpoints get real response zod schemas" explicit M1 work — closing that gap is part of this task.

4) Surface trace_id from saga_steps / history diagnostics (trace_id is written by the trace-id M1 task; §5/§6).

Scope: read-only. No engine, broker, or write-path changes. Consumes the widened status enum (status-transition-table task) and the saga_steps table + idx_instances_workspace_status (saga-migration task). API must not leak Workflow internals (no workflowInstanceId in the saga block).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 GET /instances?workspaceId=W returns only instance summaries for workspace W; a request omitting workspaceId returns 400 (BadRequestError), never an unscoped/all-tenant list.
- [ ] #2 GET /instances?workspaceId=W&status=compensationFailed returns only instances in that status; invalid status values are rejected with 400; the query is served via idx_instances_workspace_status.
- [ ] #3 GET /instances supports cursor pagination: limit caps page size with an enforced server maximum, the returned cursor fetches the next non-overlapping page, an exhausted list returns no/null cursor, and a malformed cursor returns 400.
- [ ] #4 GET /instances for a workspace with no instances returns 200 with an empty page (not 404).
- [ ] #5 GET /instances/{id} response gains a `saga` block containing phase (forward|compensating|compensated|compensationFailed), an ordered per-step array from saga_steps (elementId, seq, compensationStatus), the compensated steps, and traceId; for a linear (non-saga) instance with no ledger rows the saga block is null (documented).
- [ ] #6 traceId is surfaced on the saga view from saga_steps/history diagnostics and is null when absent; the saga block never exposes workflowInstanceId.
- [ ] #7 GET /instances/{id} for an unknown id still returns 404 (NotFoundError); existing ProcessInstanceInspection fields (status, variables, historySummary, diagnostics, incident) are unchanged.
- [ ] #8 New and extended responses are validated against exported zod response schemas at the boundary (list response, saga step view, saga block, extended inspection) in src/contracts/api.ts; inferred types replace the prior hand-written interfaces.
- [ ] #9 CONSTITUTION GATE — contract test (tests/contract): asserts both endpoints' responses parse against the exported zod schemas, covering the status filter, the 400 missing-workspaceId case, the malformed-cursor case, and the saga-block shape.
- [ ] #10 CONSTITUTION GATE — integration test (tests/integration): seeds saga_steps for a partially-compensated saga and asserts GET /instances/{id} reports the correct phase, per-step statuses, and compensated set, and that GET /instances?status= finds that instance while excluding others.
- [ ] #11 Docs: specs/002-saga-orchestrator/contracts/openapi.yaml documents GET /instances (query params + paginated response) and the extended GET /instances/{id} saga block, with response schemas matching the zod schemas.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Response schemas (src/contracts/api.ts:71-112): replace the ProcessInstance/ProcessInstanceInspection interfaces with zod schemas. Add sagaStepViewSchema ({ elementId, seq, compensationStatus, compensationElementId?, traceId? }), sagaViewSchema ({ phase, steps[], compensatedElementIds[], traceId|null }), processInstanceSummarySchema, instanceListResponseSchema ({ items, nextCursor: string|null }), and extend processInstanceInspectionSchema with `saga: sagaViewSchema|null`. Export z.infer types. (Status enum widening is delivered by the status-transition task; depend on it.)
2. Instance list reader (src/persistence/instances.ts, after getInstance:96-102): add listInstances(db, { workspaceId, status?, limit, cursor }) using dbAll (src/persistence/db.ts:19) — `SELECT * FROM process_instances WHERE workspace_id=? [AND status=?]` with a keyset predicate from the decoded cursor, `ORDER BY started_at DESC, instance_id DESC LIMIT ?` (fetch limit+1 to derive nextCursor). Reuse mapInstance (instances.ts:34-48).
3. Saga reader (new src/persistence/saga-steps.ts): listSagaSteps(db, instanceId) — `SELECT step_id, element_id, seq, compensation_element_id, compensation_status, trace_id FROM saga_steps WHERE instance_id=? ORDER BY seq ASC` (table from §5, created by the saga-migration task). Map rows to sagaStepView.
4. Saga summary derivation: build the saga block from instance.status (running→forward, compensating/compensated/compensationFailed map through) + steps; compensatedElementIds = rows with compensation_status='compensated'; traceId from the latest step / history diagnostics; return null when no ledger rows exist.
5. List handler (src/index.ts): add handleListInstances(env, request) — read query params from URL, require workspaceId (else BadRequestError), validate status against the enum, clamp limit to a max, decode the opaque cursor (base64 of {startedAt, instanceId}; malformed → BadRequestError), call listInstances, build { items, nextCursor }, validate with instanceListResponseSchema, return via json() (src/index.ts:47-52).
6. Extend handleGetInstance (src/index.ts:203-219): call listSagaSteps, build the saga block, attach to the inspection object, validate with processInstanceInspectionSchema before json().
7. Router (src/index.ts:406-409): add `if (seg[0]==='instances' && seg.length===1 && method==='GET') return handleListInstances(env, request)` BEFORE the existing `seg[0]==='instances' && seg[1]` branch so /instances and /instances/{id} both route.
8. Tests: add tests/contract/instances-read.test.ts and tests/integration/saga-inspection.test.ts, reusing tests/helpers.ts + tests/apply-migrations.ts; seed saga_steps directly via env.DB for the integration case.
9. Docs: update specs/002-saga-orchestrator/contracts/openapi.yaml for both endpoints.
<!-- SECTION:PLAN:END -->
