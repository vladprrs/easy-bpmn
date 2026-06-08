---
id: TASK-18
title: >-
  Engine: reverse-order scoped saga compensation with ledger written atomically
  on advance
status: Done
assignee: []
created_date: '2026-06-08 08:18'
updated_date: '2026-06-08 13:03'
labels:
  - saga
  - compensation
  - engine
  - persistence
  - idempotency
  - tests
milestone: m-1
dependencies:
  - TASK-17
  - TASK-12
  - TASK-16
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#44-compensation-algorithm-reverse-order-scoped-crash-safe
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#46-status-lifecycle-explicit-transition-table
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#5-data-model-deltas-d1--migrations0002_sagasql
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#43-pull-worker-model--service-task-becomes-an-async-wait
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#47-idempotency--at-least-once-additions
  - src/runtime/engine.ts
  - src/persistence/instances.ts
  - src/persistence/history.ts
  - src/persistence/idempotency.ts
  - src/persistence/db.ts
  - src/runtime/executor.ts
  - migrations/0001_mvp_schema.sql
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/07-execution-semantics.md
modified_files:
  - src/runtime/engine.ts
  - src/runtime/compensation.ts
  - src/persistence/saga.ts
  - src/persistence/instances.ts
  - src/persistence/idempotency.ts
  - tests/integration/saga-compensation.test.ts
  - tests/unit/compensation.test.ts
  - docs/bpmn/09-easy-bpmn-profile.md
priority: high
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Core of M1 (canonical transaction-saga). Implements design §4.4 (compensation algorithm), §4.6 (status lifecycle), §5 (saga_steps ledger).

WHY: a saga must undo already-completed local transactions in REVERSE completion order when a transaction is cancelled. Correctness depends on a crash-safe completed-step log written atomically with advance, and on replay-safe, at-least-once-safe compensation.

Two parts.

(1) Ledger atomic with advance. When a compensatable forward step (a serviceTask inside a <transaction> that has an associated compensation boundary + isForCompensation handler, per the graph-IR scope.compensations map) completes, write ONE saga_steps row in the SAME dbBatch as jobCompleteStmt + applyTransition (today src/runtime/engine.ts:322-341; under the pull-worker task this batch relocates to the /jobs/{id}/complete callback). The row carries captured_input AND captured_output (never a dispatch-time placeholder), compensation_status='pending', via INSERT OR IGNORE on uq_saga_steps_forward, so a duplicate completion / Workflow replay is a no-op. Closes the advance-then-crash orphan hole and the double-row hole.

(2) Reverse pass on transaction cancel. Select the scope's rows DESC by seq where compensation_status IN (pending,compensating,failed). For each row that has a handler, create/reuse a compensation job (lane: is_compensation=1, element_id=the FORWARD element id, compensates_element_id set, task_type=handler's taskType) seeded with originalInput (captured_input) + capturedOutput; then wait for its callback via the same pull/waitForEvent mechanism. Idempotency scope 'compensate', key instanceId:elementId:compensate. Runs SEQUENTIALLY in M1. A row already 'compensating' re-attaches to its existing compensation_job_id on replay — never a 2nd job (also guarded by uq_jobs_instance_element_kind). Compensator exhaustion → row 'failed', instance compensationFailed, pass STOPS. Never settle via completeInstance (clobbers to 'completed', engine.ts:583).

Depends on: saga_steps migration + comp-job columns/index, Service-Task-as-wait + job callbacks, cancel/error-boundary trigger, graph-IR scope map, widened status enums.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On forward completion of a compensatable step inside a transaction, exactly ONE saga_steps row is inserted in the SAME dbBatch as the job-complete + applyTransition statements, with captured_input and captured_output both populated and compensation_status='pending'.
- [ ] #2 The ledger insert uses INSERT OR IGNORE against uq_saga_steps_forward (instance_id, element_id): a duplicate forward completion or Workflow replay neither inserts a second row nor mutates the existing captured_input/captured_output (verified by an integration test that re-drives the completed step).
- [ ] #3 A completed forward step with NO associated compensation handler is not enrolled in the reverse pass (no compensation job is created; it is recorded as notRequired/skipped) — covered by a negative test.
- [ ] #4 On transaction cancellation the reverse pass selects scope rows DESC by seq where compensation_status IN (pending,compensating,failed) and creates compensation jobs in strictly reverse completion order (asserted against the forward completion order, e.g. reserve→charge forward yields refund→release compensation).
- [ ] #5 Each compensation job is persisted with is_compensation=1, element_id=the forward element id, compensates_element_id set, task_type=the handler's taskType, and a seeded payload carrying BOTH originalInput (the forward captured_input) and capturedOutput.
- [ ] #6 Compensation runs sequentially in M1: the next reverse step's compensation job is not created until the prior compensation job's callback has been applied (asserted by ordering, not parallel dispatch).
- [ ] #7 Replay/crash-recovery: a saga_steps row already in compensation_status='compensating' re-attaches to its existing compensation_job_id and re-derives the same wait — no second compensation job row is created (also enforced by uq_jobs_instance_element_kind); covered by an integration test that re-drives an instance mid-compensation.
- [ ] #8 Duplicate compensation callbacks are idempotent: a second callback under idempotency scope 'compensate' (key instanceId:elementId:compensate) returns the stable prior outcome and does NOT advance the reverse cursor twice.
- [ ] #9 A full successful reverse pass sets every enrolled row's compensation_status='compensated' and settles the instance toward 'compensated' WITHOUT calling completeInstance (asserted: status is not clobbered to 'completed').
- [ ] #10 A compensator that exhausts its own retries sets that row's compensation_status='failed', writes a compensationFailed history event, transitions the instance to compensationFailed, and STOPS the reverse pass — the already-compensated suffix stays compensated and remaining pending rows are untouched (negative/edge integration test).
- [ ] #11 History events compensationStarted / compensationCompleted / compensationFailed are written to history_events (free-text type) for the audit timeline.
- [ ] #12 Constitution gate — required test: an integration test under @cloudflare/vitest-pool-workers (D1 + DO + Workflow) drives the §3 order-saga where a business error mid-saga triggers reverse-order compensation of the completed steps, AND asserts the duplicate-callback no-double-advance case AND the compensator-exhaustion → compensationFailed case.
- [ ] #13 Constitution gate — required test: a unit test (via the DirectExecutor harness in src/runtime/executor.ts) covers ledger INSERT OR IGNORE no-op on replay and the 'compensating'-row re-attach (no second job).
- [ ] #14 Docs updated: the specs/002-saga-orchestrator runtime-contracts/data-model docs describe ledger-atomic-with-advance, the reverse-pass selection rule, replay re-attach, and the new 'compensate' idempotency scope; docs/bpmn/09-easy-bpmn-profile.md compensation note kept aligned.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add 'compensate' to IdempotencyScope (src/persistence/idempotency.ts:6-10).
2. New src/persistence/saga.ts: sagaStepStmt() → INSERT OR IGNORE into saga_steps (carrying scope_id, seq, element_id, forward_job_id, captured_input, captured_output, compensation_element_id, compensation_task_type, compensation_status='pending') against uq_saga_steps_forward; selectScopeStepsDesc(instanceId, scopeId) WHERE compensation_status IN ('pending','compensating','failed') ORDER BY seq DESC; attachCompensationJobStmt()/setCompensationStatusStmt(); getSagaStep() for re-attach. (Table + index land in migrations/0002_saga.sql, owned by the ledger-migration task — confirm present.)
3. In engine.ts forward-completion batch (currently runServiceTask success, engine.ts:322-341; relocates to the /jobs/{id}/complete callback under the pull-worker task): when graph-IR scope.compensations[elementId] exists, append sagaStepStmt() so the ledger row commits atomically with jobCompleteStmt (instances.ts:281-294) + applyTransitionStmt. Compute seq as a monotonic per-scope counter.
4. Add createCompensationJob() (extend createJob, instances.ts:217) writing is_compensation=1, element_id=forward id, compensates_element_id, task_type=handler taskType, input_variables = {originalInput: captured_input, capturedOutput} — reusing the existing job row on retry (mirror engine.ts:250 reuse).
5. New compensation pass (in engine.ts, or new src/runtime/compensation.ts driven by the engine): on transaction-cancel trigger, loop selectScopeStepsDesc rows; for each with a handler — if compensation_status='compensating' AND compensation_job_id set, re-attach to that job (no new job); else create the comp job + set status 'compensating' + compensation_job_id + history compensationStarted in one dbBatch. Then await the job callback via the same waitForEvent/job-result path as Service-Task-as-wait. Guard the callback with idempotency scope 'compensate', key instanceId:elementId:compensate.
6. On comp success: status 'compensated' + history compensationCompleted; advance to next row. On comp exhaustion: status 'failed' + history compensationFailed + instance→compensationFailed; STOP. On full success: instance→compensated (do NOT call completeInstance, engine.ts:564-585). Then hand back to the cancel-boundary outgoing flow (boundary-execution task).
7. Tests: tests/integration/saga-compensation.test.ts (vitest-pool-workers) — happy reverse compensation, duplicate callback no-double-advance, compensator-exhaustion→compensationFailed, mid-compensation replay re-attach; tests/unit/compensation.test.ts via DirectExecutor (executor.ts:40-57) — INSERT OR IGNORE no-op + re-attach.
8. Update specs/002 runtime-contracts/data-model docs + keep docs/bpmn/09-easy-bpmn-profile.md aligned.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Reverse-order scoped compensation in engine.ts (runCompensation, createCompensationJob, markStepCompensated/Failed). On forward completion of a compensatable step, applyForwardCompletion writes the saga_steps ledger row INSERT-OR-IGNORE atomically with advance (captured input+output, compensation wiring, status 'pending'/'notRequired'). On cancel, runCompensation selects the scope's steps seq DESC and compensates each via a pull comp job (is_compensation=1, seeded with originalInput+capturedOutput from the ledger), sequentially in reverse; a replay re-attaches to the existing comp job (getCompensationJobByElement) — no second comp job. On a compensator's retry-exhaustion the pass STOPS (status compensationFailed); the compensated suffix stays compensated. Verified by saga-orchestration.test.ts (reverse order chargeCard→reserveStock) + saga-operator (operator-driven).
<!-- SECTION:FINAL_SUMMARY:END -->
