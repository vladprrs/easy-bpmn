---
id: TASK-40
title: 'M3-L1: Jobs API retry policy — honor retryable, enforce reclaim exhaustion'
status: Done
assignee:
  - Claude
created_date: '2026-06-11 17:17'
updated_date: '2026-06-11 18:59'
labels:
  - saga
  - api
  - workers
milestone: m-3
dependencies:
  - TASK-38
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
modified_files:
  - src/index.ts
  - src/persistence/jobs.ts
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - specs/002-saga-orchestrator/contracts/runtime-contracts.md
  - tests/contract/jobs-schema-pin.test.ts
  - tests/integration/jobs-retryable-reclaim.test.ts
priority: medium
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Design §5.3 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). (1) Honor the /jobs/{id}/fail `retryable` field: retryable=false ⇒ immediate exhaustion (skip remaining attempts) → the standard exhaustion path (Hazard incident inside a transaction). Workers omitting the field are unchanged; a worker already sending retryable=false (legal and IGNORED today per openapi.yaml:857-864) changes behavior — the openapi delta must carry an explicit behavior-change note. (2) Enforce reclaim exhaustion: reclaim re-leases already increment attempt_count (jobs.ts:32-65), but neither leaseJobs nor parkExpiredLease checks retry_limit, so a job exhausted purely through lease expiry retries forever (deferral comment src/index.ts:629-633). Route reclaim exhaustion into the same exhaustion path as fail. (3) The poison budget stays per-(instance, element) across occurrences — the TASK-26 per-occurrence candidate is REJECTED per the deliberate TASK-35 decision (engine.ts:600-606); do not change it. Constitution-neutral (no profile change).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 fail with retryable=false produces an immediate exhaustion incident with no further leases of the job (integration test).
- [x] #2 fail with retryable omitted or true keeps the current backoff-retry behavior (regression test).
- [x] #3 A job exhausted purely through repeated lease expiry terminates via the exhaustion path instead of retrying forever (integration test).
- [x] #4 openapi documents retryable as honored, including the behavior-change note for workers already sending false; contract tests updated.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implementer subagent + two-stage review. (1) Honor /jobs/{id}/fail retryable: body.retryable===false ⇒ willRetry=false ⇒ immediate exhaustion via the standard targetStatus='failed' → deliverJobResult('failed') path (index.ts handleFailJob ~790). Omitted/true unchanged. (2) Enforce reclaim exhaustion: extend selectExpiredInFlightLeases to return retry_limit/instance_id/element_id/is_compensation; in leaseOnce reclaim pre-pass (index.ts ~665), an expired lease with attempt_count>=retry_limit routes to exhaustion (lapsed-lease-guarded transition to 'failed' like parkExpiredLease's WHERE, NOT lock-token-guarded failJobConditional + deliver 'failed') instead of parking forever. (3) Poison budget across-occurrence UNCHANGED (forward-task.ts POISON_THRESHOLD — TASK-35 decision, do not touch). openapi: document retryable as honored + behavior-change note (line 319/864); contract tests updated. Constitution-neutral. TDD first.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done at commits 210d327 + 452b06f (review fix). (1) handleFailJob honors retryable: retryable=body.retryable!==false; willRetry=!isBusiness&&retryable&&attempt<limit → retryable=false short-circuits to the standard exhaustion path. (2) Reclaim exhaustion: selectExpiredInFlightLeases widened (retry_limit/instance_id/element_id/is_compensation); leaseOnce reclaim pre-pass exhausts attempt>=limit via failExpiredLeaseConditional (lapsed-lease-guarded UPDATE mirroring parkExpiredLease, race-safe 0-row→no-deliver) instead of parking forever; compensation jobs route to compensationFailure. (3) Poison budget untouched. Review fix: unified both terminal-failure routes through a shared deliverJobFailed(env,{...}) helper — consistent audit retryable (technical-class exhaustion logs true; only explicit retryable=false/business logs false) + isCompensation in both; regression-locked. 249 tests (+5) / typecheck / check:docs green. Two-stage review passed (spec ✅; code quality Yes-with-fix → applied). FOR L3: deliverJobFailed is the seam the timer-exhaustion route should reuse (one audit convention).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
M3-L1 jobs API retry policy. The /jobs/{id}/fail `retryable` field is now HONORED: retryable=false short-circuits remaining technical retries into the standard exhaustion path (Hazard incident inside a transaction); omitted/true keep the existing backoff behavior. Reclaim exhaustion is enforced — an expired in-flight lease whose attempt_count has reached retry_limit now terminates via the exhaustion path (new race-safe failExpiredLeaseConditional, guard-identical to parkExpiredLease) instead of re-leasing forever; compensation jobs exhausted this way settle to compensationFailure. The across-occurrence poison budget is deliberately unchanged (TASK-35). Both terminal-failure routes (worker fail + reclaim) now share a deliverJobFailed helper with one consistent operator-visible audit convention (technical-class exhaustion logs retryable=true; only an explicit worker retryable=false or a business error logs false), positioning M3-L3's timer-exhaustion route to inherit it. openapi + runtime-contracts.md document retryable as honored with an explicit behavior-change note. 249/249 tests, typecheck, check:docs green; two-stage review + a unification fix all clean. Constitution-neutral."
<!-- SECTION:FINAL_SUMMARY:END -->
