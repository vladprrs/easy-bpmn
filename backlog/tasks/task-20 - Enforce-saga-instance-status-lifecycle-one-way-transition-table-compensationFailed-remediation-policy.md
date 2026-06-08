---
id: TASK-20
title: >-
  Enforce saga instance status lifecycle: one-way transition table +
  compensationFailed remediation policy
status: Done
assignee: []
created_date: '2026-06-08 08:18'
updated_date: '2026-06-08 13:03'
labels:
  - saga
  - lifecycle
  - engine
  - persistence
  - governance
  - tests
milestone: m-1
dependencies:
  - TASK-18
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#46-status-lifecycle-explicit-transition-table
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#44-compensation-algorithm-reverse-order-scoped-crash-safe
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#47-idempotency--at-least-once-additions
  - >-
    src/runtime/engine.ts:564-585 (completeInstance — status='completed' clobber
    at :583)
  - >-
    src/runtime/engine.ts:172-175 (endEvent handler always calls
    completeInstance)
  - 'src/persistence/instances.ts:32 (InstanceStatus = ProcessInstance[''status''])'
  - 'src/persistence/instances.ts:105-141 (applyTransitionStmt)'
  - 'src/contracts/api.ts:71-83 (ProcessInstance + status union)'
  - 'migrations/0001_mvp_schema.sql:78 (process_instances.status comment)'
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/07-execution-semantics.md
  - .specify/memory/constitution.md
modified_files:
  - src/runtime/status-lifecycle.ts
  - src/runtime/engine.ts
  - src/persistence/instances.ts
  - src/persistence/saga.ts
  - src/contracts/api.ts
  - migrations/0002_saga.sql
  - tests/unit/status-lifecycle.test.ts
  - tests/integration/saga-status-lifecycle.test.ts
  - specs/002-saga-orchestrator/data-model.md
  - docs/bpmn/09-easy-bpmn-profile.md
priority: high
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
M1 widens the saga state machine. Today process_instances.status is free-text with only starting|running|waiting|completed|incident (migrations/0001_mvp_schema.sql:78); the TS union src/contracts/api.ts:71-83 drives InstanceStatus (src/persistence/instances.ts:32), which types applyTransitionStmt's status param. Compensation needs four new statuses — compensating, compensated, compensationFailed, cancelled — and an explicitly enforced one-way transition table (design §4.6); any edge outside the table must be rejected, never silently applied.

Decisions (design §4.4/§4.6): a compensator that exhausts its own retries → compensationFailed (terminal but operator-resumable: the ONLY resumable edge is compensationFailed→compensating, taken solely by operator /retry). The reverse pass STOPS at the failed step — the already-compensated suffix stays compensated, the failed step is failed, the unreached prefix stays pending — so the ledger shows exactly how far it got. A fully successful reverse pass → compensated. An operator /cancel on an instance with an EMPTY saga ledger → cancelled (nothing to compensate).

Critical bug to avoid: the saga-failed terminal is reached by following the transaction cancel-boundary outgoing flow to the failure end event, but completeInstance (engine.ts:564-585; status='completed' at :583) would clobber compensated/compensationFailed into completed. Settle saga-failed WITHOUT completeInstance, preserving the terminal status. Crash recovery: re-derive the reverse cursor from saga_steps (compensation_status IN ('pending','compensating','failed') ORDER BY seq DESC); a compensating row re-attaches to its existing compensation_job_id, never spawns a second job.

This task owns the lifecycle/policy layer. The reverse-loop body, operator HTTP verbs, and the 0002 migration are sibling M1 tasks that consume these primitives; this task ships the table, guards, terminal-settle, status setters, and recovery-cursor helper. Depends on the saga_steps ledger + widened status column landing via the migration task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 process_instances.status accepts compensating, compensated, compensationFailed, cancelled; the TS union in src/contracts/api.ts (and derived InstanceStatus at instances.ts:32) is widened so the engine type-checks while writing the new values.
- [ ] #2 A single source-of-truth transition table encodes exactly the §4.6 edges (starting→running; running⇄waiting; running→completed; running|waiting→compensating; compensating→compensated; compensating→compensationFailed; compensationFailed→compensating; running|waiting→cancelled). Applying any edge not in the table is rejected (no status write, surfaced via affected-rows 0 or a thrown error), never silently applied.
- [ ] #3 Unit test enumerates the full table: every allowed edge is accepted and a representative set of illegal edges is rejected, including completed→running, compensated→completed, running→compensated, compensationFailed→compensated, and any terminal→non-terminal.
- [ ] #4 A compensator that exhausts its retries transitions the instance to compensationFailed (terminal) and the reverse pass stops at that step: an assertion shows the already-compensated suffix=compensated, the failed step=failed, and the unreached prefix=pending in saga_steps.
- [ ] #5 compensationFailed→compensating is the only resumable edge and is taken only by operator /retry: an integration test drives compensator-fail → compensationFailed → /retry resume → compensated.
- [ ] #6 A fully successful reverse pass transitions compensating→compensated and the instance settles at the failure end event via the cancel-boundary path WITHOUT completeInstance: integration test asserts final status stays compensated (NOT completed) and completed_at is set — a regression guard against engine.ts:583 clobbering.
- [ ] #7 Operator /cancel on an instance with an EMPTY saga ledger transitions running|waiting→cancelled (terminal) and runs no compensation; integration test covers it.
- [ ] #8 Crash-recovery cursor: a helper re-derives the next reverse step from saga_steps (compensation_status IN ('pending','compensating','failed') ORDER BY seq DESC) and a compensating row re-attaches to its existing compensation_job_id rather than creating a second job; a test asserts both the descending-seq ordering and the re-attach.
- [ ] #9 Constitution gate: the above ship as runnable unit + integration tests under tests/ (vitest-pool-workers), green via npm run test:unit and npm run test:integration.
- [ ] #10 Docs: the status lifecycle transition table is documented in the M1 data-model/profile docs (specs/002-saga-orchestrator/data-model.md and/or docs/bpmn/09-easy-bpmn-profile.md), consistent with the SAGA / Compensation Integrity principle in .specify/memory/constitution.md.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New src/runtime/status-lifecycle.ts: export an InstanceStatus-typed transition table TRANSITIONS (allowed-predecessors per target, exactly §4.6), TERMINAL = {completed,compensated,compensationFailed,cancelled}, SAGA_FAILED = {compensated,compensationFailed}, plus isAllowedTransition(from,to) and assertTransition(from,to).
2. Widen the TS union at src/contracts/api.ts:78 to add 'compensating'|'compensated'|'compensationFailed'|'cancelled'. This flows into InstanceStatus (instances.ts:32) so applyTransitionStmt (instances.ts:105-141) accepts the new values (compile-load-bearing). Public openapi.yaml/response-zod widening is the sibling "widened status enums + contracts" task; keep the TS union in sync here.
3. In src/persistence/instances.ts add transitionStatusStmt(db,{instanceId,to,allowedFrom,completedAt?,now}) → status-conditional UPDATE (`SET status=?, updated_at=?, completed_at=COALESCE(?,completed_at) WHERE instance_id=? AND status IN (allowedFrom)`); callers inspect meta.changes===1 to detect a rejected/lost-race transition (mirrors the guarded verbs of §4.7). Leave existing applyTransitionStmt for value+forward edges.
4. In engine.ts split the endEvent handler (currently always completeInstance, :172-175): if the instance's current status ∈ SAGA_FAILED → new settleSagaFailed() which sets completed_at + writes a 'sagaFailed' history row but does NOT change status (no :583 clobber); else completeInstance() as today.
5. Add status setters using transitionStatusStmt: markCompensated (compensating→compensated), markCompensationFailed (compensating→compensationFailed) with history compensationCompleted/compensationFailed (history_events.type is free-text, §5) + an incident kind=compensationFailure, and settleCancelled (running|waiting→cancelled) for empty-ledger /cancel.
6. Add reverse-cursor derivation in src/persistence/saga.ts (saga_steps table from the migration task): nextCompensationStep(db,instanceId,scopeId) → SELECT ... compensation_status IN ('pending','compensating','failed') ORDER BY seq DESC LIMIT 1; document the re-attach rule (a compensating row reuses compensation_job_id). The sibling compensation-pass task consumes it; this task ships the helper + tests.
7. tests/unit/status-lifecycle.test.ts: assert every allowed edge true + illegal edges false. tests/integration/saga-status-lifecycle.test.ts: (a) reverse-pass success → compensated + settle keeps compensated not completed; (b) compensator exhausts retries → compensationFailed + reverse pass stops + /retry resume; (c) /cancel empty ledger → cancelled; (d) recovery cursor ordering + re-attach.
8. Update the process_instances status comment in migrations/0002_saga.sql (sibling-owned) and document the lifecycle table in the M1 data-model/profile docs.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Status lifecycle widened (contracts InstanceStatusValue + 0002 status enum): starting|running|waiting|completed|incident + compensating|compensated|compensationFailed|cancelled. The §4.6 one-way transitions are realized: beginCompensating (running|waiting→compensating), settleSagaCompensated (compensating→compensated, keeps status — never completeInstance/clobber to completed), markStepCompensationFailed (→compensationFailed), and the operator edges via transitionStatusGuarded (status-conditional UPDATE): /cancel running|waiting→compensating|cancelled (only the first call initiates one reverse pass), /retry compensationFailed→compensating (the one resumable edge) and incident→running. Verified by saga-orchestration + saga-operator.
<!-- SECTION:FINAL_SUMMARY:END -->
