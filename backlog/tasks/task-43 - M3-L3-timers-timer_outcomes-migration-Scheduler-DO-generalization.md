---
id: TASK-43
title: 'M3-L3: timers + timer_outcomes migration, Scheduler DO generalization'
status: Done
assignee: []
created_date: '2026-06-11 17:18'
updated_date: '2026-06-12 07:00'
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
modified_files:
  - migrations/0006_timers.sql
  - src/persistence/timers.ts
  - src/contracts/api.ts
  - src/durable-objects/job-scheduler.ts
  - src/runtime/timers.ts
  - tests/unit/timers-persistence.test.ts
  - tests/unit/fire-timer.test.ts
  - tests/unit/job-scheduler.test.ts
priority: medium
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Infrastructure for model-level timers per design §4.1–4.2 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Migration: `timers` table (timer_id = instanceId:elementId#occurrence; UNIQUE (instance_id, element_id, occurrence); kind boundary|intermediateCatch|eventGateway; fire_at computed once at arm; status armed|fired|cancelled as bookkeeping/read model) + `timer_outcomes` race-decider table (timer_id PK, outcome fired|cancelled, decided_at) — claimed by PLAIN INSERT (never OR IGNORE) composed into the same dbBatch as the transition, so a conflicting batch aborts wholesale (the documented gateway-decisions.ts:70-84 contract; EBG timers decide on gateway_decisions instead and get no timer_outcomes row). Generalize the JobScheduler DO into a one-shot scheduler: existing job DOs keep raw-jobId naming (no re-keying of armed DLQ timers); new timer DOs keyed `timer:<timerId>`; alarm() = re-read D1 → idempotently execute (terminateUnleasableJob | fireTimer) → deleteAll; same JOB_SCHEDULER binding, no DO-namespace migration. Persistence module + zod contracts for timer rows. Arm = INSERT OR IGNORE in the guarded wait's batch; timerArmed history written in the first-arm batch only; every rewalk re-arms armed timers idempotently (self-healing).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Migration applies cleanly on a fresh local DB and on one carrying M1/M2 data; uq_timers_visit and the timer_outcomes PK are enforced.
- [x] #2 Scheduler DO unit tests: arm/re-arm idempotent; a stray alarm against a decided timer no-ops; one-shot storage cleanup after firing; job:<id> vs timer:<id> keying cannot collide.
- [x] #3 Timer persistence unit tests: arm INSERT OR IGNORE idempotency; a batch carrying a conflicting timer_outcomes INSERT aborts wholesale and the loser converts on re-read (plain INSERT semantics, never OR IGNORE).
- [x] #4 npx wrangler deploy --dry-run green (binding unchanged); typecheck green.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Timer infrastructure for M3-L3 per design §4.1–4.2. Pure infra; no construct opened in the validator yet (TASK-44 does that).

**Migration (migrations/0006_timers.sql):** `timers` (deterministic timer_id = instanceId:elementId#occurrence; uq_timers_visit UNIQUE (instance_id, element_id, occurrence); idx_timers_instance_status; kind boundary|intermediateCatch|eventGateway; fire_at snapshotted in code; status armed|fired|cancelled bookkeeping) + `timer_outcomes` race-decider (timer_id PK, outcome fired|cancelled). Additive, IF NOT EXISTS, 0004-style comments.

**Persistence (src/persistence/timers.ts):** row/view types + mapTimer + timerIdFor; insertTimerArmedStmt (INSERT OR IGNORE, idempotent re-park); insertTimerOutcomeStmt (PLAIN INSERT — the race decider, citing the gateway-decisions.ts:70-84 contract); flipTimerFired/Cancelled (armed-guarded); getTimer/getTimerOutcome/listTimersForInstance.

**Contracts:** timerInspectionSchema (zod) for the inspection block TASK-44 populates.

**Scheduler DO (src/durable-objects/job-scheduler.ts):** generalized JobScheduler into a one-shot scheduler — existing arm(jobId) unchanged (raw-jobId naming, no DLQ re-keying); new armTimer(timerId, fireAt) with a distinct marker key; alarm() dispatches job→terminateUnleasableJob / timer→fireTimer then unconditional deleteAll. Binding UNCHANGED (no wrangler.jsonc edit).

**fireTimer (src/runtime/timers.ts):** SEAM per design §4.1 same-batch invariant — only the idempotent guard + no-op paths (no-op if missing/not-armed/already-decided/not-yet-due/terminal-or-missing instance). The winning-fire batch (claim + transition + wake) is TASK-44; the fire-eligible branch throws loudly (unreachable this layer — nothing arms a real timer yet) rather than partially writing a forbidden "fired with no transition" state.

**Tests:** persistence (uq + PK enforcement; arm OR-IGNORE idempotency; the keystone — a conflicting timer_outcomes batch aborts WHOLESALE with collateral rollback + loser converts on re-read), fireTimer (all guards + seam throw), DO (arm/re-arm idempotent; stray-alarm-on-decided no-op + one-shot cleanup; marker non-collision; dispatch; review-added: marker survives the seam throw = deleteAll skipped → alarm re-delivery safe).

**Review:** two-stage (spec ✅, code quality APPROVE). Folded in: the alarm-retry marker-survival assertion (Minor 3) and narrowed TimerOutcomeRow.outcome (Minor 2). Minor 1 (zod-vs-interface inspection convention) deferred to TASK-44 where the inspection block lands.

Full suite green (282), typecheck, wrangler deploy --dry-run (binding unchanged), check:docs all green. Commits c580561 + eb6f9f4.
<!-- SECTION:FINAL_SUMMARY:END -->
