---
id: TASK-19
title: 'Engine: error/cancel boundary execution and Cancel-vs-Hazard failure routing'
status: To Do
assignee: []
created_date: '2026-06-08 08:18'
labels:
  - saga
  - engine
  - bpmn
  - runtime
  - tests
  - m1
milestone: m-1
dependencies:
  - TASK-17
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md §2 (decision
    row 3)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md §3 (BPMN crux
    + M1 profile subset)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md §4.2
    (scope-aware engine)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md §4.4
    (compensation algorithm)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md §4.5 (failure
    taxonomy)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md §4.6 (status
    transition table)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md §8 (M1 exit
    criteria)
  - 'src/runtime/engine.ts:96-179 (loop)'
  - 'src/runtime/engine.ts:213 (ServiceTaskOutcome)'
  - 'src/runtime/engine.ts:367-403 (createServiceTaskIncident)'
  - 'src/runtime/engine.ts:564-585 (completeInstance'
  - 'clobber at :583)'
  - src/bpmn/graph.ts (GraphNode IR
  - scope fields target)
  - 'src/workflows/process-workflow.ts:41-50 (catch-all to bypass)'
  - 'src/runtime/executor.ts:40-57 (DirectExecutor test harness)'
  - 'src/persistence/instances.ts:104-139 (applyTransitionStmt)'
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/07-execution-semantics.md (token lifecycle)
  - .specify/memory/constitution.md (SAGA / Compensation Integrity principle)
modified_files:
  - src/runtime/engine.ts
  - src/bpmn/graph.ts
  - src/contracts/workflow-events.ts
  - src/workflows/process-workflow.ts
  - tests/integration/saga-business-error-compensate.test.ts
  - tests/integration/saga-hazard-terminal.test.ts
  - tests/contract/runtime-contracts.test.ts
  - docs/bpmn/09-easy-bpmn-profile.md
priority: high
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The M1 engine becomes a scope-aware interpreter (design 2026-06-08-saga-orchestrator-design.md §4.2), replacing the scalar-cursor loop in src/runtime/engine.ts:96-179. This task implements boundary-event execution and the failure-classification that routes a failed or cancelled step to the correct BPMN outcome.

Per the locked compensation-trigger decision (§2 row 3, the §3 BPMN crux, §4.5):
- An interrupting ERROR boundary event on a service task abandons normal continuation and redirects the single token to the boundary's outgoing flow; in the M1 profile that target is a cancel end event.
- A CANCEL end event inside a <transaction> drives the scope into `compensating`, runs the reverse-order compensation pass over the saga ledger, then takes the transaction's cancel boundary outgoing flow to the saga-failed end — settled WITHOUT completeInstance (which would clobber compensated/compensationFailed into completed, engine.ts:583,564).
- A BUSINESS error (worker `fail` whose errorCode matches a declared bpmn:error/@errorCode) raises that BPMN error, caught by the boundary's errorRef -> bpmn:error/@id, and is NOT retried.
- An UNCAUGHT technical exhaustion inside a transaction is a BPMN HAZARD: terminal incident, NO auto-compensation; operators force compensation later via POST /instances/{id}/cancel. Outside a transaction, exhaustion stays today's terminal incident.

This is the canonicity crux: cancellation triggers compensation automatically (no compensate-throw inside the tx), and an uncaught Error is never auto-compensated. Depends on graph-IR boundary/scope fields (§4.1) and the Service-Task-as-wait job-result discriminator (§4.3); it invokes the compensation-pass primitive (sibling tasks). Core files: src/runtime/engine.ts, src/bpmn/graph.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An interrupting error boundary event whose attached service task raises a matching business error abandons normal continuation and routes the single token along the boundary's single outgoing flow (per profile, to the cancel end event).
- [ ] #2 A cancel end event reached inside a <transaction> transitions the instance to `compensating`, invokes the reverse-order compensation pass, and on completion takes the transaction cancel boundary's outgoing flow to the saga-failed end WITHOUT calling completeInstance (final status stays compensated/compensationFailed, never completed).
- [ ] #3 A worker `fail` with errorCode matching a declared bpmn:error/@errorCode is NOT retried and is matched to its error boundary by errorRef -> bpmn:error/@id.
- [ ] #4 An uncaught technical exhaustion inside a transaction produces a terminal incident (kind=serviceTaskFailure) and does NOT trigger compensation: saga_steps compensation_status rows remain untouched; a subsequent POST /instances/{id}/cancel then drives compensation.
- [ ] #5 Technical exhaustion OUTSIDE a transaction remains a terminal incident (regression coverage that existing service-task-incident behavior is preserved).
- [ ] #6 Edge case: a worker `fail` whose errorCode matches NO declared bpmn:error and has no catching boundary is treated as an uncaught error escaping the transaction (Hazard -> terminal incident) — never a silent advance and never auto-compensation.
- [ ] #7 Edge case: a local Service-Task waitForEvent timeout is classified as a technical failure inside the engine and does NOT reach the process-workflow.ts:41-50 catch-all (which would bypass Hazard/compensation semantics).
- [ ] #8 Required integration test (constitution gate): the §8 M1 exit scenario 'business error mid-saga compensates completed steps in reverse and reaches the failure end' passes end-to-end via the DirectExecutor harness.
- [ ] #9 Required integration test (constitution gate): a Hazard scenario asserts an uncaught technical exhaustion inside a transaction yields a terminal incident with no compensation, then operator /cancel forces compensation.
- [ ] #10 Required contract test (constitution gate): the job-result discriminator (completed | failed{retryable,errorCode?,reason}) and its business-vs-technical classification are asserted against tests/contract/runtime-contracts.
- [ ] #11 Only allowed status transitions are emitted (running|waiting -> compensating; -> incident for Hazard) and any illegal transition is rejected; covered by a test.
- [ ] #12 Audit history events are written and queryable in D1 for each path (transactionCancelled, error-boundary redirect, Hazard incidentCreated).
- [ ] #13 Docs updated: docs/bpmn/09-easy-bpmn-profile.md states that transaction cancellation auto-compensates in reverse order and that an uncaught Error is a Hazard (no compensate-throw inside the tx), citing design §4.2/§4.5.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. In src/runtime/engine.ts, replace the hard-coded if-chain loop (engine.ts:108-178) with a node-kind dispatch registry keyed by GraphNode kind (design §4.2) so boundaryEvent nodes and endEvent.kind handlers plug in without a growing if-chain.
2. Widen ServiceTaskOutcome (engine.ts:213) from `{next}|{incident}` to a discriminated union adding `{raiseError: errorCode}` and `{hazard: reason}` alongside advance/incident, driven by the job-result discriminator (src/contracts/workflow-events.ts; defined by the Service-Task-as-wait sibling task).
3. Add classifyJobResult: completed -> advance; failed with errorCode matching a declared bpmn:error/@errorCode -> raiseError; failed retryable / lease-or-wait timeout -> re-lease until retries exhausted, then in-transaction -> hazard, outside-transaction -> terminal incident.
4. On raiseError, resolve the interrupting error boundary on the element via the graph scope boundary/association map (src/bpmn/graph.ts scope fields, §4.1) matching errorRef -> bpmn:error/@id; if found set cur = boundary outgoing target (the cancel end event); if none -> treat as Hazard.
5. Implement endEvent.kind handling: 'none' -> completeInstance (engine.ts:564, unchanged); 'cancel' inside a transaction -> set status compensating, invoke the compensation-pass primitive (sibling task #7), then take the transaction cancel boundary outgoing flow to the saga-failed end WITHOUT completeInstance (avoid the clobber at engine.ts:583).
6. Implement Hazard via createServiceTaskIncident (engine.ts:367) with kind=serviceTaskFailure; assert no saga ledger compensation rows are written/triggered.
7. Ensure the local waitForEvent timeout is caught inside the engine and fed into classifyJobResult, never reaching process-workflow.ts:41-50.
8. Gate every status write through the allowed transition table at applyTransitionStmt (src/persistence/instances.ts:104-139); reject illegal transitions.
9. Tests: add tests/integration/saga-business-error-compensate.test.ts and tests/integration/saga-hazard-terminal.test.ts using the DirectExecutor harness (src/runtime/executor.ts:40-57); extend tests/contract/runtime-contracts.test.ts for job-result classification.
10. Update docs/bpmn/09-easy-bpmn-profile.md per §7 alignment.
<!-- SECTION:PLAN:END -->
