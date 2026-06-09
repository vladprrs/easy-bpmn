---
id: TASK-23
title: >-
  Service Task failure-edge policies: retry backoff, un-leasable-job DLQ TTL,
  poison-job termination
status: Done
assignee: []
created_date: '2026-06-08 08:18'
updated_date: '2026-06-09 06:50'
labels:
  - saga
  - engine
  - persistence
  - runtime
  - tests
milestone: m-1
dependencies:
  - TASK-14
  - TASK-15
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#43-pull-worker-model-service-task-becomes-an-async-wait
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#45-failure-taxonomy-m1-minimal-full-in-m3
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#46-status-lifecycle-explicit-transition-table
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#5-data-model-deltas
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#11-backlog-mapping
    (M1 task #15)
  - 'src/runtime/engine.ts:215-365 (runServiceTask synchronous for-loop'
  - no backoff)
  - 'src/runtime/engine.ts:273-362 (totalAttempts retry loop)'
  - 'src/runtime/engine.ts:367-403 (createServiceTaskIncident — no kind today)'
  - >-
    src/workflows/process-workflow.ts:41-50 (catch-all that must NOT swallow
    task-level timeouts)
  - 'src/persistence/instances.ts:217-247 (createJob)'
  - 'src/persistence/instances.ts:469-495 (incidentStmt — add kind)'
  - src/runtime/payload.ts (assertPayloadWithinLimit
  - MAX_EVENT_PAYLOAD_BYTES)
  - src/contracts/workflow-events.ts (job-result discriminator)
  - >-
    migrations/0001_mvp_schema.sql:105-123 (service_task_jobs — no
    lease/activation columns)
  - 'migrations/0001_mvp_schema.sql:211-221 (incidents — status only ''open'')'
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/01-events.md
modified_files:
  - src/runtime/retry-policy.ts
  - src/runtime/engine.ts
  - src/persistence/instances.ts
  - src/contracts/workflow-events.ts
  - src/index.ts
  - wrangler.jsonc
  - migrations/0002_saga.sql
  - tests/unit/retry-backoff.test.ts
  - tests/integration/saga-dlq-timeout.test.ts
  - tests/integration/saga-poison-job.test.ts
  - tests/contract/runtime-contracts.test.ts
  - docs/bpmn/09-easy-bpmn-profile.md
priority: medium
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
In M1's pull-worker model a Service Task becomes a durable async wait (design §4.3): the job is made leasable, the engine does one step.waitForEvent per logical job, and retries are driven by RE-LEASE, not by re-entering the wait. This task implements the three failure-edge policies that govern that wait (§4.3 steps 5 & 8, §4.5):

1) Retry backoff — when a worker fails retryable (no errorCode) or its lease expires, the job must NOT be instantly re-leasable; it becomes leasable only after an exponential-with-jitter delay (base, factor, maxBackoff), capped at maxBackoff. Backoff is DISTINCT from lease duration: leaseMs bounds one in-flight attempt; backoff spaces attempts apart. The per-job wait timeout budget is >= retries × (leaseMs + maxBackoff).

2) Un-leasable-job DLQ TTL — a job whose taskType nobody polls must not hang forever. At creation it gets a job-level activation TTL (service_task_jobs.activation_expires_at). On expiry while still never leased → terminal incident kind=timeout + operator alert. This one job-level timer exists in M1 even though general timers are M3.

3) Poison job — a worker that repeatedly completes with output that cannot be applied → terminal incident, DISTINCT from a business-error→cancel: poison does NOT trigger compensation (only a fail with a matching bpmn:error/@errorCode does, §4.5).

Today retries are a synchronous for-loop with no delay (engine.ts:273-362) and incidents carry no kind (0001_mvp_schema.sql:211-221). Depends on task #3 for the lease/activation_expires_at/error_code columns and incidents.kind/resolution.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 computeBackoffMs(attempt) returns an exponential value min(maxBackoff, base*factor^(attempt-1)) with bounded jitter, monotonically non-decreasing in cap, and never exceeding maxBackoff — covered by a unit test over attempts 1..N and a jitter-bounds assertion.
- [x] #2 After a retryable fail (or a lease-expiry reclaim) at attempt n, POST /jobs/activate does NOT return that job before now+computeBackoffMs(n) and DOES return it (with attempt incremented) after the delay elapses — integration test asserting both the negative (too-early) and positive (after-delay) lease.
- [x] #3 Backoff is independent of lease duration: a test shows changing leaseMs leaves the re-lease delay unchanged, and changing the backoff config leaves an active lease's lock_expires_at unchanged.
- [x] #4 A job whose taskType is never polled reaches activation_expires_at and yields a terminal incident with kind='timeout', the instance settles to a terminal status, and a jobActivationExpired/operator-alert history_event is written; a job leased before activation_expires_at is NOT timed out (negative case).
- [x] #5 A worker that repeatedly completes with un-applicable output is retried up to the poison threshold, then yields a terminal incident distinct from cancel: the instance does NOT enter 'compensating' and NO compensation jobs are created (asserted explicitly).
- [x] #6 DLQ-timeout and poison terminations are produced through the engine's job-result/resume path and do NOT fall through to the process-workflow.ts:41-50 catch-all — a test asserts the incident kind and a specific reason, not a generic 'Workflow terminated:' reason.
- [x] #7 A duplicate retryable fail for the same jobId+lockToken does not double-count the attempt nor re-arm backoff twice (returns the stable prior outcome) — idempotency edge covered by integration test (constitution gate: workerCallback scope).
- [x] #8 Required integration tests added under tests/integration/ (un-leasable DLQ timeout; poison-job termination) and a unit test for the backoff function under tests/unit/ — all green via npm run test (constitution gate: every runtime/persistence change ships a test).
- [x] #9 src/contracts/workflow-events.ts job-result discriminator and its contract test cover the non-retryable failed result carrying the timeout/poison classification; the activate-response zod schema validates the backoff-gated empty result.
- [x] #10 Docs updated: the backoff (default base/factor/maxBackoff), activation-TTL default, and poison-threshold policy are documented in the specs/002-saga-orchestrator runtime contract, and the un-leasable + poison scenarios are added to the saga quickstart; docs/bpmn/09-easy-bpmn-profile.md notes the single M1 job-level activation TTL as the lone M1 exception to 'timers are M3'.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add src/runtime/retry-policy.ts: export RETRY_POLICY defaults {baseMs, factor, maxBackoffMs}, ACTIVATION_TTL_MS, POISON_THRESHOLD, and pure computeBackoffMs(attempt, policy) (exponential + full jitter, capped). Keep pure/unit-testable per R1 (design §10).
2. Backoff enforcement (re-lease path): on /jobs/fail retryable and on lease-expiry reclaim, park the job until now+computeBackoffMs(attempt) by setting status='locked', lock_token=NULL, lock_expires_at=parkUntil — reusing the §4.3 activate gate (status='locked' AND lock_expires_at < now) so backoff stays distinct from leaseMs WITHOUT a new column. Coordinate with task #5/#6 who own activate/fail.
3. DLQ TTL: when the job is created (today engine.ts:250-262 via createJob, instances.ts:217-247), set activation_expires_at = created_at + ACTIVATION_TTL_MS (column from task #3's 0002_saga.sql; add it here if #3 unmerged). Add a sweep (wrangler.jsonc cron / scheduled handler in src/index.ts, or DO alarm) selecting jobs status='created' AND attempt_count=0 AND activation_expires_at < now and delivering a synthetic non-retryable job-result {outcome:'failed',retryable:false,kind:'timeout',reason:'un-leasable'} via sendEvent(bpmn_job_<jobId>), preserving the engine's single-wait budget.
4. Engine Service-Task-as-wait (replacing the for-loop at engine.ts:215-365): on consuming a job-result, branch completed→apply; failed+retryable→park+re-lease; failed+!retryable+kind=timeout→terminal incident kind=timeout; errorCode→raise BPMN error (task #8 owns).
5. Poison detection: when applying a completed result, if un-applicable (merge/validation/post-delivery limit via payload.ts), count it; at POISON_THRESHOLD call createServiceTaskIncident (engine.ts:367-403) with kind set — never enter compensating.
6. Extend incidentStmt (instances.ts:469-495) + createServiceTaskIncident to accept kind (column from task #3). Emit free-text history_events (0001:193): jobActivationExpired, poisonJob.
7. Add tests (tests/unit/retry-backoff.test.ts, tests/integration/saga-dlq-timeout.test.ts, tests/integration/saga-poison-job.test.ts) + workflow-events contract case; update docs.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
NOT YET IMPLEMENTED — the one remaining M1 refinement. The core saga works without it (retries currently re-lease immediately, no backoff; un-leasable jobs sit harmlessly). Scope when picked up: (1) Retry backoff — on a technical fail set status='locked' + lock_token=NULL + lock_expires_at=now+expBackoff(attempt) (instead of status='created'), so the existing leasable predicate reclaims it only after the backoff; NOTE this breaks drainSampleWorkers' immediate-release assumption, so the test driver must advance time / set lock_expires_at to the past. (2) DLQ TTL — activation_expires_at column already exists; a job nobody leases before it expires → terminal incident (kind='timeout'); needs a cron/alarm sweep (wrangler triggers + a scheduled() handler — new infra, none today). (3) Poison-job — output repeatedly un-applicable → terminal incident distinct from a business-error→cancel. Deferred from this session to avoid backoff-aware test churn + cron infra late in a long session.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: claude
created: 2026-06-08 19:09
---
M1 closeout (design 2026-06-08-m1-closeout-design.md §4): no new D1 columns (0002_saga.sql already shipped activation_expires_at/error_code/incidents.kind). Implementing: (1) retry backoff via src/runtime/retry-policy.ts computeBackoffMs(attempt) — park retryable fails as status='locked', lock_token=NULL, lock_expires_at=now+backoff (reuses the activate lease gate, distinct from leaseMs, no new column); (2) un-leasable-job DLQ via a NEW per-job Durable Object JobScheduler (wrangler tag v2) armed at forward-job creation; alarm() re-reads D1 and routes a synthetic timeout via terminateUnleasableJob → terminal incident kind='timeout'; (3) poison job: un-applicable completion (merged output exceeds payload limit) re-opens the job up to POISON_THRESHOLD, then terminal incident kind='poison' (distinct from cancel — NO compensation). drainSampleWorkers helper updated to fast-forward backoff parks so existing retry/hazard tests stay green; saga-pull-jobs re-lease assertion updated for backoff.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## TASK-23 — Service-Task failure-edge policies (M1 closeout)

No new D1 columns (0002_saga.sql already shipped `activation_expires_at`/`error_code`/`incidents.kind`). Three mechanisms, three trigger natures.

**1. Retry backoff (`src/runtime/retry-policy.ts`, `index.ts`, `jobs.ts`)**
- Pure `computeBackoffMs(attempt, policy, rand)` = full jitter over `min(maxBackoffMs, baseMs·factor^(attempt-1))`; defaults base 1s / ×2 / cap 30s; `ACTIVATION_TTL_MS=15min`, `POISON_THRESHOLD=3`.
- A retryable `/jobs/fail` **parks** the job (`status='locked', lock_token=NULL, lock_expires_at=now+backoff`) reusing the activate lease gate — distinct from `leaseMs`, no new column. Idempotent on duplicate fail.
- **Lease-expiry reclaim** (design §4.1 reclaim leg, added in review): the bulk lease now excludes held in-flight leases (`lock_token IS NULL` guard); a reclaim pre-pass in `leaseOnce` parks *expired* in-flight leases behind backoff before re-lease. (Terminating a reclaim once retries exhaust is a per-step timeout → deferred to M3.)

**2. Un-leasable-job DLQ (`src/durable-objects/job-scheduler.ts`, `wrangler.jsonc` tag v2, engine.ts)**
- New per-job `JobScheduler` Durable Object, armed at forward-job creation (`activation_expires_at = created + 15min`). `alarm()` → `terminateUnleasableJob`, which re-reads D1 (D1 canonical; DO holds no state) and, if still un-leased, settles a terminal incident `kind='timeout'` + `jobActivationExpired` history. Idempotent; no-op on a progressed/late job.
- **Concurrency-hardened (review)**: a guarded CAS claim (`failUnleasableJobConditional`, `WHERE status='created' AND attempt_count=0`) is the serialization point vs a racing lease/complete; the instance settle (incident + history + **guarded** transition `running/waiting→incident`) is one atomic `dbBatch` so an `incident` status can never exist without its incident row and a concurrent cancel is never regressed.

**3. Poison job (engine.ts `applyForwardCompletion`)**
- An un-applicable completion (merge would breach the ~1 MiB event limit) re-opens the job up to `POISON_THRESHOLD` strikes, then terminal `kind='poison'` + `poisonJob` history. Strikes count un-applicable **completions** (from `serviceTaskOutputRejected` history), NOT lease attempts — a technical retry never consumes the poison budget. Poison **never** compensates (verified with a transaction-scoped test: `reserveStock` + its compensation boundary → incident, not `compensating`, no `release-stock` job).

**Contract/tests/docs**
- `jobResultEventSchema` failed variant gains `kind?: 'timeout'|'poison'`; contract test covers it + the backoff-gated empty activate response. openapi `Incident.kind` gains `poison`.
- New tests: `tests/unit/retry-backoff.test.ts`, `tests/integration/saga-backoff.test.ts` (incl. reclaim leg), `saga-dlq-timeout.test.ts` (incl. TOCTOU guard + no-regress), `saga-poison-job.test.ts` (incl. transaction-scoped + strike-count semantics). `drainSampleWorkers` fast-forwards backoff parks so all pre-existing retry/hazard tests stay green; one `saga-pull-jobs` reclaim assertion updated for backoff.
- Docs: `specs/002` runtime-contracts (failure taxonomy + defaults), quickstart (Scenarios 8 & 9), `docs/bpmn/09` (the lone M1 job-level activation TTL as the M1 exception to "timers are M3").

**Review:** three adversarial multi-agent rounds (P2 DLQ TOCTOU + atomicity → P3 docs → P3 audit-noise); all confirmed findings addressed, residuals (best-effort DLQ crash window, reclaim-exhaustion termination) documented. Full suite green (120 tests); `tsc`, `check:docs`, `wrangler deploy --dry-run` all pass.

**Follow-ups (not done):** per-step timeout to terminate a reclaim that exhausts retries via lease-expiry (M3); fresh poison budget on operator `/retry` (currently strikes persist across retry — documented).
<!-- SECTION:FINAL_SUMMARY:END -->
