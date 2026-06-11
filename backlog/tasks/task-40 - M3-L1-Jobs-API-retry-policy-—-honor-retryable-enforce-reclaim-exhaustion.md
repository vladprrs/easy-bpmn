---
id: TASK-40
title: 'M3-L1: Jobs API retry policy — honor retryable, enforce reclaim exhaustion'
status: To Do
assignee: []
created_date: '2026-06-11 17:17'
labels:
  - saga
  - api
  - workers
milestone: m-3
dependencies:
  - TASK-38
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
priority: medium
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Design §5.3 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). (1) Honor the /jobs/{id}/fail `retryable` field: retryable=false ⇒ immediate exhaustion (skip remaining attempts) → the standard exhaustion path (Hazard incident inside a transaction). Workers omitting the field are unchanged; a worker already sending retryable=false (legal and IGNORED today per openapi.yaml:857-864) changes behavior — the openapi delta must carry an explicit behavior-change note. (2) Enforce reclaim exhaustion: reclaim re-leases already increment attempt_count (jobs.ts:32-65), but neither leaseJobs nor parkExpiredLease checks retry_limit, so a job exhausted purely through lease expiry retries forever (deferral comment src/index.ts:629-633). Route reclaim exhaustion into the same exhaustion path as fail. (3) The poison budget stays per-(instance, element) across occurrences — the TASK-26 per-occurrence candidate is REJECTED per the deliberate TASK-35 decision (engine.ts:600-606); do not change it. Constitution-neutral (no profile change).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 fail with retryable=false produces an immediate exhaustion incident with no further leases of the job (integration test).
- [ ] #2 fail with retryable omitted or true keeps the current backoff-retry behavior (regression test).
- [ ] #3 A job exhausted purely through repeated lease expiry terminates via the exhaustion path instead of retrying forever (integration test).
- [ ] #4 openapi documents retryable as honored, including the behavior-change note for workers already sending false; contract tests updated.
<!-- AC:END -->
