---
id: TASK-36
title: >-
  Compensation across loop iterations: per-occurrence ledger rows compensated in
  reverse
status: To Do
assignee: []
created_date: '2026-06-09 20:30'
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
