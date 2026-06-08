---
id: TASK-21
title: >-
  M1: Operator remediation verbs — POST /instances/{id}/cancel and /retry
  (status-guarded)
status: Done
assignee: []
created_date: '2026-06-08 08:18'
updated_date: '2026-06-08 13:03'
labels:
  - saga
  - api
  - engine
  - persistence
  - governance
  - tests
milestone: m-1
dependencies:
  - TASK-18
  - TASK-20
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.2
    Hazard-vs-cancel
  - §4.4 compensation algorithm/re-attach
  - §4.6 status transition table
  - §4.7 guarded operator verbs
  - §5 job-row reset + incidents kind/resolution
  - §6 operator verbs + response schemas
  - §8 M1 exit criteria
  - '§11 task #10)'
  - 'src/index.ts:203-219 (handleGetInstance)'
  - 'src/index.ts:406-409 (instances router block)'
  - 'src/runtime/engine.ts:367-403 (createServiceTaskIncident terminal incident)'
  - ':250 (forward job reuse)'
  - ':564-585 (completeInstance must not clobber saga terminals)'
  - 'src/runtime/executor.ts:16-61 (Executor seam: start/deliver'
  - WorkflowExecutor.sendEvent
  - DirectExecutor)
  - 'src/contracts/api.ts:71-112 (ProcessInstance.status union'
  - ProcessInstanceInspection)
  - 'src/persistence/instances.ts:104-148 (applyTransition[Stmt])'
  - ':205-302 (job rows)'
  - ':469-526 (incidents)'
  - >-
    src/persistence/db.ts:28-34 (dbRun returns void — needs a meta.changes
    variant)
  - 'specs/001-bpmn-lite-orchestrator-mvp/spec.md:294 (FR-025 view-only)'
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - docs/bpmn/09-easy-bpmn-profile.md
  - specs/001-bpmn-lite-orchestrator-mvp/spec.md
modified_files:
  - src/index.ts
  - src/contracts/api.ts
  - src/persistence/instances.ts
  - src/persistence/db.ts
  - src/runtime/executor.ts
  - src/runtime/engine.ts
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - docs/bpmn/09-easy-bpmn-profile.md
  - tests/contract/operator-verbs.test.ts
  - tests/integration/operator-remediation.test.ts
priority: high
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add two operator remediation endpoints so stuck sagas can be driven, relaxing the MVP view-only terminal incident (specs/001 FR-025; design §6). Today an instance dead-ends at `incident` with no recovery (engine.ts:367-403 terminal incident; index.ts router exposes no operator verbs).

POST /instances/{id}/cancel = operator-triggered transaction cancellation. Per design §4.7 it is a status-conditional UPDATE (`SET status='compensating' WHERE status IN ('running','waiting')`): D1's single writer guarantees only the first call matches (read meta.changes), so exactly one reverse compensation pass launches; repeat calls are no-op acks returning current state (at-least-once safe). If the scope's saga ledger is empty (nothing to compensate) it settles to terminal `cancelled` instead (§4.6 table). Reconcile the guard with §4.2, which also lets operators force-compensate a Hazard terminal `incident` inside a transaction.

POST /instances/{id}/retry = the one resumable edge (§4.6), guarded on `incident` (forward failure) or `compensationFailed`. It RESETS the existing job row (status→created, new lock_token, attempt accounting; §5 line 252) rather than inserting (mirrors the forward reuse at engine.ts:250), making it re-leasable, then resumes: incident→running (re-arm the forward wait); compensationFailed→compensating (resume reverse pass from the failed step, re-attaching to the existing compensation_job_id, never duplicating; §4.4).

Both verbs get zod request+response schemas (§6) and must not leak Workflow internals (no workflowInstanceId). Depends on tasks: #3 (lock_token/lock_expires_at/incidents.resolution columns), #6 (Service-Task-as-wait + terminal no-op ack), #7 (compensation pass), #9/#12 (widened status enum + transition table).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 POST /instances/{id}/cancel on a running|waiting instance with a non-empty saga ledger atomically transitions status to `compensating` exactly once (status-conditional UPDATE; verified via rows-affected) and triggers the reverse compensation pass; the response returns the updated instance/saga state.
- [ ] #2 POST /instances/{id}/cancel on a running|waiting instance with an EMPTY saga ledger settles to terminal `cancelled` and does NOT start a compensation pass (§4.6 transition table).
- [ ] #3 A repeated/concurrent POST /instances/{id}/cancel after the first is an idempotent no-op that returns current state and never launches a second reverse pass (at-least-once safe).
- [ ] #4 POST /instances/{id}/cancel is rejected with 409 when the instance status is outside the allowed guard set (e.g. already `completed`/`compensated`/`cancelled`); behavior for a Hazard terminal `incident` inside a transaction is explicitly decided per §4.2 (force-compensate) vs §4.7 (running|waiting only) and covered by a test.
- [ ] #5 POST /instances/{id}/retry on an `incident` instance resets the failed forward job row (status→created, new lock_token, lock_expires_at cleared, attempt budget reset) making it re-leasable, transitions the instance back to `running`, and re-arms execution; the prior terminal incident no longer blocks progress.
- [ ] #6 POST /instances/{id}/retry on a `compensationFailed` instance resets the failed compensation job row and transitions to `compensating`, resuming the reverse pass from the failed step; the already-compensated suffix stays compensated and it re-attaches to the existing compensation_job_id (never creates a duplicate comp job).
- [ ] #7 POST /instances/{id}/retry is rejected with 409 when status is not `incident` or `compensationFailed`; a repeated /retry is idempotent (no stacked resets, no duplicate jobs/attempts) and returns current state.
- [ ] #8 Both endpoints return 404 for an unknown instance id and validate any request body via zod; responses are zod-validated and contain no Workflow internals (workflowInstanceId not required or echoed).
- [ ] #9 Each operator action writes an audit history event (e.g. operatorCancelRequested/transactionCancelled, operatorRetryRequested) with operator-visible reason and element context (history_events.type is free-text per §5).
- [ ] #10 REQUIRED contract test (constitution gate): tests/contract covering both verbs' request/response schema conformance, the status guards, idempotent repeat calls, 404, and the 409 rejections.
- [ ] #11 REQUIRED integration test (constitution gate): an end-to-end scenario where (a) a compensator exhausts retries → `compensationFailed`, operator /retry resumes and the reverse pass completes → `compensated`; and (b) /cancel on a mid-saga running instance drives reverse-order compensation to the failure end (matches §8 M1 exit criteria).
- [ ] #12 Docs updated: the two operator endpoints (+ response schemas) are added to specs/002-saga-orchestrator/contracts/openapi.yaml and the FR-025 view-only relaxation for sagas is noted in the spec/profile (docs/bpmn/09-easy-bpmn-profile.md).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Router (src/index.ts route(), instances block at :406-409): add `seg.length===3 && seg[2]==='cancel' && POST` → handleCancelInstance and `seg[2]==='retry' && POST` → handleRetryInstance; 404 if instance missing (mirror handleGetInstance :203-205).
2. Contracts (src/contracts/api.ts): widen ProcessInstance.status (:78) with compensating|compensated|compensationFailed|cancelled; add optional request body schema ({reason?}) and zod response schemas for both verbs.
3. Guarded-transition helper (src/persistence/instances.ts, mirror applyTransitionStmt :105-141): `UPDATE process_instances SET status=?, updated_at=? WHERE instance_id=? AND status IN (...)`. dbRun (db.ts:28-34) returns void, so add a helper that runs `.run()` and returns meta.changes to detect whether the guard matched (0 ⇒ no-op).
4. handleCancelInstance: load instance (404 if absent); count compensatable saga_steps for the scope; if >0 try-transition running|waiting→compensating then call executor.cancel(); if 0 try-transition →cancelled; if 0 rows changed return current state; recordHistory(operatorCancelRequested/transactionCancelled).
5. handleRetryInstance: load instance; branch on status — incident → find failed forward job at current_element_id (getJobByElement :205); compensationFailed → find failed comp job via saga_steps.compensation_job_id. Add resetJobForRetry(jobId) (UPDATE ... status='created', lock_token=?, lock_expires_at=NULL, attempt accounting WHERE job_id=? AND status='failed' — idempotent); mark incidents.resolution; try-transition (incident→running | compensationFailed→compensating) then executor.resume(); else 409.
6. Executor seam (src/runtime/executor.ts): add cancel(instanceId)/resume(instanceId) to Executor; WorkflowExecutor sends a sanitized dot-free control event via sendEvent wrapped so a not-running/terminal throw is a no-op ack (§4.7); DirectExecutor invokes the engine compensation/resume entrypoint inline (mirror start/deliver :45-56).
7. Engine (src/runtime/engine.ts): consume/expose the compensation-pass and forward-resume entrypoints (from tasks #7/#6) so the direct path can drive them.
8. Tests: tests/contract/operator-verbs.test.ts + tests/integration/operator-remediation.test.ts (pattern: tests/contract/service-task-incident.test.ts; vitest-pool-workers).
9. Docs: add both endpoints to specs/002-saga-orchestrator/contracts/openapi.yaml; note FR-025 relaxation in spec/profile.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Operator verbs in index.ts (status-guarded via transitionStatusGuarded). POST /instances/{id}/cancel: abandons in-flight forward jobs (late callbacks no-op), then either running|waiting→cancelled (empty ledger) or →compensating + resumeInline to drive the reverse pass; only the first call initiates one pass. POST /instances/{id}/retry: accepts an optional variables patch (operator fixes the downstream condition); for compensationFailed it resets the failed step (→pending) + re-snapshots/re-leases its comp job + resolves the incident + compensationFailed→compensating + resume; for incident it resets the forward job + incident→running + resume from the element. Verified by saga-operator.test.ts (cancel mid-saga→compensated, cancel empty→cancelled, retry compensationFailed+fix→compensated, cancel-terminal→409).
<!-- SECTION:FINAL_SUMMARY:END -->
