---
id: TASK-36
title: >-
  Compensation across loop iterations: per-occurrence ledger rows compensated in
  reverse
status: In Progress
assignee:
  - Claude
created_date: '2026-06-09 20:30'
updated_date: '2026-06-11 07:41'
labels:
  - saga
  - engine
  - compensation
  - persistence
  - tests
milestone: M2
dependencies:
  - TASK-29
  - TASK-32
references:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - src/runtime/engine.ts
  - src/persistence/saga.ts
documentation:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
priority: high
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
M2 design 2026-06-09 §8. Each completed pass of a compensatable step becomes its own saga_steps row (occurrence column, TASK-29), so the existing reverse pass (ORDER BY seq DESC) compensates every iteration separately with zero algorithm change — this task proves and hardens that property. Forward completion in iteration k writes its ledger row with occurrence=k atomically with the advance (INSERT OR IGNORE per (instance_id, element_id, occurrence)); a compensation job inherits its forward step's occurrence (job uniqueness (instance_id, element_id, is_compensation, occurrence)) and is seeded with THAT iteration's originalInput + capturedOutput; the M1 replay-recovery rule (a `compensating` ledger row re-attaches to its existing compensation_job_id, never creates a second comp job) must hold per occurrence; compensationFailed stops the reverse pass at the failed iteration and operator /retry resumes from it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Loop+cancel integration test: N≥2 completed iterations of a compensatable step followed by a business error → cancel end → the reverse pass creates N compensation jobs in reverse seq order, each seeded with its own iteration's captured input/output.
- [ ] #2 Per-occurrence dedup: a duplicate forward completion of one occurrence stays a ledger no-op; a new occurrence inserts a new ledger row.
- [ ] #3 compensationFailed mid-reverse-pass stops at the failed iteration (already-compensated suffix stays compensated); operator /retry resumes from exactly that iteration — extends the M1 scenario across occurrences.
- [ ] #4 Crash during compensation of iteration k re-attaches to that occurrence's existing compensation job on recovery (no second comp job).
- [ ] #5 Constitution gate: integration tests above (vitest-pool-workers); npm run test green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: subagent-driven (implementer + spec review + quality review) on branch m2-conditional-sagas. Much of the plumbing pre-landed: saga_steps.occurrence + per-occurrence INSERT OR IGNORE (TASK-29), comp jobs inherit forward occurrence end-to-end incl. /jobs/activate seeding by (element, occurrence) (TASK-32), SAGA_LOOP_BPMN fixture + the operator-/cancel reverse pass over 2 occurrences already pinned (TASK-35). This task proves and hardens the remaining contract on the AUTO-compensation path and the failure/recovery matrix:

1. AC1 loop+cancel-end: SAGA_LOOP_BPMN — drive f_more for N>=2 completed reserveItem iterations, then business-fail finalize (FINALIZE_FAILED error boundary -> Tx_cancel cancel end) -> AUTO reverse pass creates N comp jobs in reverse seq order, each seeded with ITS iteration's originalInput + capturedOutput (assert per-job seeding, not just count/order).
2. AC2 per-occurrence dedup: duplicate forward completion of one occurrence = ledger no-op; new occurrence = new row (persistence-level test exists from TASK-29 — extend to the engine path if not covered: duplicate /jobs/complete within an iteration).
3. AC3 compensationFailed mid-reverse stops at the failed iteration (already-compensated suffix stays compensated); operator /retry resumes from EXACTLY that iteration — extends the M1 scenario across occurrences.
4. AC4 crash during compensation of iteration k re-attaches to that occurrence's existing compensation job (no second comp job) — the M1 'compensating ledger row re-attaches to compensation_job_id' rule per occurrence.
5. Carried: resolve the never-written incident resolution 'compensated' (advance it at compensation settle OR drop the enum member; update the loop-limit pin in lockstep, justified). Hoist a parameterized leaseOne/leaseAndComplete into tests/helpers.ts (3+ per-file copies exist).
Constitution gate: integration tests (vitest-pool-workers); npm run test green.
<!-- SECTION:PLAN:END -->
