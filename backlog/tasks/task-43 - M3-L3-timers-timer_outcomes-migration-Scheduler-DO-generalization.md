---
id: TASK-43
title: 'M3-L3: timers + timer_outcomes migration, Scheduler DO generalization'
status: To Do
assignee: []
created_date: '2026-06-11 17:18'
labels:
  - saga
  - persistence
  - durable-objects
milestone: m-3
dependencies:
  - TASK-41
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
  - src/persistence/gateway-decisions.ts
  - src/durable-objects/job-scheduler.ts
priority: medium
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Infrastructure for model-level timers per design §4.1–4.2 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Migration: `timers` table (timer_id = instanceId:elementId#occurrence; UNIQUE (instance_id, element_id, occurrence); kind boundary|intermediateCatch|eventGateway; fire_at computed once at arm; status armed|fired|cancelled as bookkeeping/read model) + `timer_outcomes` race-decider table (timer_id PK, outcome fired|cancelled, decided_at) — claimed by PLAIN INSERT (never OR IGNORE) composed into the same dbBatch as the transition, so a conflicting batch aborts wholesale (the documented gateway-decisions.ts:70-84 contract; EBG timers decide on gateway_decisions instead and get no timer_outcomes row). Generalize the JobScheduler DO into a one-shot scheduler: existing job DOs keep raw-jobId naming (no re-keying of armed DLQ timers); new timer DOs keyed `timer:<timerId>`; alarm() = re-read D1 → idempotently execute (terminateUnleasableJob | fireTimer) → deleteAll; same JOB_SCHEDULER binding, no DO-namespace migration. Persistence module + zod contracts for timer rows. Arm = INSERT OR IGNORE in the guarded wait's batch; timerArmed history written in the first-arm batch only; every rewalk re-arms armed timers idempotently (self-healing).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Migration applies cleanly on a fresh local DB and on one carrying M1/M2 data; uq_timers_visit and the timer_outcomes PK are enforced.
- [ ] #2 Scheduler DO unit tests: arm/re-arm idempotent; a stray alarm against a decided timer no-ops; one-shot storage cleanup after firing; job:<id> vs timer:<id> keying cannot collide.
- [ ] #3 Timer persistence unit tests: arm INSERT OR IGNORE idempotency; a batch carrying a conflicting timer_outcomes INSERT aborts wholesale and the loser converts on re-read (plain INSERT semantics, never OR IGNORE).
- [ ] #4 npx wrangler deploy --dry-run green (binding unchanged); typecheck green.
<!-- AC:END -->
