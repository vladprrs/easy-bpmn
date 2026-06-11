---
id: TASK-36
title: >-
  Compensation across loop iterations: per-occurrence ledger rows compensated in
  reverse
status: Done
assignee:
  - Claude
created_date: '2026-06-09 20:30'
updated_date: '2026-06-11 11:58'
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
- [x] #1 Loop+cancel integration test: N≥2 completed iterations of a compensatable step followed by a business error → cancel end → the reverse pass creates N compensation jobs in reverse seq order, each seeded with its own iteration's captured input/output.
- [x] #2 Per-occurrence dedup: a duplicate forward completion of one occurrence stays a ledger no-op; a new occurrence inserts a new ledger row.
- [x] #3 compensationFailed mid-reverse-pass stops at the failed iteration (already-compensated suffix stays compensated); operator /retry resumes from exactly that iteration — extends the M1 scenario across occurrences.
- [x] #4 Crash during compensation of iteration k re-attaches to that occurrence's existing compensation job on recovery (no second comp job).
- [x] #5 Constitution gate: integration tests above (vitest-pool-workers); npm run test green.
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
HEADLINE: the design §8 claim PROVEN — the existing reverse pass (ORDER BY seq DESC) compensated every iteration separately with ZERO engine algorithm change; all 4 ACs were green against the existing engine on first run. Only engine change: the carried resolution-lifecycle fix — advanceIncidentResolutionStmt (guarded UPDATE WHERE resolution='compensating') in the settleSagaCompensated dbBatch advances compensating->compensated atomically with the terminal transition; operatorResolved is sticky (asserted); loop-limit pin updated in lockstep.

Two-stage review done. Spec review: compliant (per-job seeding traced through the real /jobs/activate path — getSagaStep by element+occurrence; retry budget real — retryLimit from the handler's retries=5, 5 lease+fail rounds exhaust it exactly; both crash windows faithful; resolution advance covers the ONLY status='compensated' write site; nuance noted: the duplicate /jobs/complete short-circuits at the idempotency layer before the ledger INSERT OR IGNORE — layered dedup, contract satisfied). Quality review: Yes + polish in 58c1344 (lifecycle doc caveats: terminal-'open' incidents on cancelled-empty-ledger instances + setIncidentResolution instance-wide breadth; AC4 timeout; idempotency-key lane comment).

PRE-EXISTING FINDINGS surfaced (carries): (a) /jobs/fail `retryable` field is accepted by the schema but IGNORED server-side — terminality is errorCode or budget exhaustion only; runtime-contracts.md + quickstart.md showcase retryable:false as if it mattered -> TASK-37 must document it as advisory/ignored; M3 decision: honor or drop. (b) setIncidentResolution updates ALL non-operatorResolved incidents (no incident_id filter) — M3: add the filter. (c) compensationStarted diagnostics carry occurrence, compensationCompleted doesn't — TASK-37 candidate. (d) cancelled-empty-ledger incidents stay 'open' forever — M3: advance to operatorResolved in the pending===0 cancel branch. (e) test-helper name collision: saga-pull-jobs/saga-backoff local leaseOne variants — rename to seedAndLease on next touch.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Loop compensation proven and hardened on the auto path: 3 completed reserveItem iterations + business-failed finalize -> Tx_cancel -> auto reverse pass creates one comp job per occurrence in reverse seq order (one in flight at a time), each seeded via the real /jobs/activate path with ITS OWN iteration's originalInput + capturedOutput (chained-input shape asserted); compensationStarted occurrences [2,1,0]; zero incidents on the auto path. Hostile duplicate /jobs/complete = stable prior ack + ledger deep-equal unchanged. compensationFailed mid-reverse stops at the failed iteration (suffix stays compensated); /retry resets the SAME comp job row and resumes from exactly that occurrence -> compensated; operatorResolved sticky. Crash during compensation re-attaches per occurrence in both unleased and leased windows (one comp job per iteration, ever). Incident resolution lifecycle completed: compensating->compensated advanced atomically in the settle batch (the never-written enum member now written); lifecycle + caveats documented at IncidentResolution. leaseOne/leaseAndComplete/rewindBackoff hoisted into tests/helpers.ts (2 files converted; meaningfully-different local variants left, justified). Tests 232/232 ×2. Commits bda2a17 + 58c1344. Engine algorithm changes: zero (design §8 claim held).
<!-- SECTION:FINAL_SUMMARY:END -->
