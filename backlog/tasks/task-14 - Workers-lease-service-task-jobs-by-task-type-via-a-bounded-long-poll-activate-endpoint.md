---
id: TASK-14
title: >-
  Workers lease service-task jobs by task type via a bounded long-poll activate
  endpoint
status: Done
assignee: []
created_date: '2026-06-08 08:17'
updated_date: '2026-06-08 12:33'
labels:
  - saga
  - api
  - persistence
  - engine
  - tests
milestone: m-1
dependencies:
  - TASK-12
  - TASK-13
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.3 Pull
    worker model — Service Task becomes an async wait; the verified IN-subquery
    lease SQL)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§6 API deltas
    — POST /jobs/activate request/response
  - worker auth & workspace isolation
  - 'decision #6)'
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§5 Data model
    deltas — lease/DLQ columns
  - idx_jobs_leasable
  - saga_steps ledger
  - comp job element_id == forward element id)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.4
    compensation context originalInput+capturedOutput; §11 M1 task set item 5;
    R4/R6 risks)
  - >-
    src/index.ts (router :385-417; parseBody :54-66; json :47-52;
    handlePublishMessage as handler pattern)
  - >-
    src/persistence/instances.ts (JobRow :189-203; jobCompleteStmt :281-294;
    createJob :217-247)
  - src/persistence/db.ts (stmt/dbAll positional ? binds
  - undefined->null coercion
  - dbBatch)
  - src/contracts/api.ts (zod request schemas + response interfaces to extend)
  - >-
    migrations/0001_mvp_schema.sql (service_task_jobs :105-119;
    uq_jobs_instance_element :122-123; idx_instances_workspace :86)
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/openapi.yaml
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/runtime-contracts.md
  - docs/bpmn/09-easy-bpmn-profile.md
modified_files:
  - src/index.ts
  - src/contracts/api.ts
  - src/persistence/instances.ts
  - tests/integration/job-lease.test.ts
  - tests/contract/jobs-activate.test.ts
  - tests/helpers.ts
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/openapi.yaml
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/runtime-contracts.md
priority: high
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
WHY: M1 turns the Service Task from a synchronous in-Worker call into a durable pull/external-task model (design §4.3, decision #2 in §2). Remote microservices must be able to claim work without the orchestrator knowing their addresses. This task delivers the claim half of that contract: POST /jobs/activate, a bounded long-poll that atomically leases jobs by taskType. complete/fail, the Service-Task-as-wait engine change, the compensation pass, and operator verbs are SEPARATE M1 tasks; this is task (5) of the §11 M1 set.

HANDOFF CONTEXT (independent engineer — no prior conversation):
- Today there is no /jobs route; the flat router lives in src/index.ts route() at lines 385-417 and dispatches to handler functions (see handlePublishMessage). parseBody (src/index.ts:54-66) is the zod validation boundary; json() (:47-52) wraps responses. Add a `seg[0] === "jobs"` branch + a handleActivateJobs handler.
- CRITICAL D1 constraint (live-verified, design §4.3): `UPDATE ... LIMIT n RETURNING` does NOT parse on D1 (error code 7500). The atomic claim MUST use the IN-subquery form with the lease guard duplicated in BOTH the inner subquery AND the outer WHERE. D1's single-writer serializes activates so two callers cannot double-claim. A per-taskType Durable Object is NOT needed.
- Leasable predicate (reclaim included): `status='created' OR (status='locked' AND lock_expires_at < now)`. Leased rows move to status='locked' with worker_id, a fresh lock_token, lock_expires_at = now+leaseMs; attempt_count is bumped and returned as `attempt` (re-lease after expiry/fail naturally increments — re-lease drives retries, §4.3 step 5). complete/fail (sibling task) compare attempt against retry_limit.
- TENANCY (decision #6, §6): each /jobs/* call carries a per-workspace worker credential (Authorization: Bearer). The server DERIVES workspaceId from the credential and never trusts a body workspaceId. service_task_jobs has no workspace_id column (migration 0001:105-119), so the lease subquery MUST JOIN process_instances to filter by workspace — otherwise a worker in workspace B could lease workspace A's same-taskType jobs (R6 exfiltration).
- The lease/DLQ columns (is_compensation, worker_id, lock_token, lock_expires_at, compensates_element_id, error_code, activation_expires_at), the relaxed unique index, idx_jobs_leasable, and the saga_steps ledger are added by the sibling migration task (§5, migrations/0002_saga.sql). This task DEPENDS on that migration and on the worker-auth task (worker_credentials + an authenticateWorker seam). For compensation jobs (is_compensation=1) the response surfaces originalInput/capturedOutput sourced from the saga_steps ledger (captured_input/captured_output) for the compensated forward element — comp job element_id equals the forward element id (§5), uq_saga_steps_forward is on (instance_id, element_id).
- traceId is derived from instanceId (§6). The response must NOT leak Workflow internals (no workflowInstanceId). New endpoints get REAL response zod schemas (closing the un-validated-interface gap, §6).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 POST /jobs/activate exists in src/index.ts route() and accepts {taskType, workerId, maxJobs?, leaseMs?, waitMs?} validated by a new zod request schema in src/contracts/api.ts; an invalid/malformed body returns 400 with parse issues (via parseBody).
- [x] #2 workspaceId is derived from the per-workspace worker credential (Authorization: Bearer), never from the body; a request with no/invalid credential is rejected (401/403); the lease is scoped to that workspace via a JOIN to process_instances.
- [x] #3 The atomic claim uses the IN-subquery UPDATE...RETURNING form with the leasable guard present in BOTH the inner subquery and the outer WHERE; the naive UPDATE...LIMIT n RETURNING form is NOT used (it fails on D1 with code 7500).
- [x] #4 Leasable predicate is status='created' OR (status='locked' AND lock_expires_at < now); a leased row transitions to status='locked' with worker_id set, a fresh unique lock_token, lock_expires_at = now + leaseMs, attempt_count incremented; the response 'attempt' reflects the post-increment value.
- [x] #5 Response is {jobs:[{jobId,instanceId,elementId,taskType,isCompensation,attempt,lockToken,traceId,variables,originalInput?,capturedOutput?}]} validated by a new response zod schema; it never includes workflowInstanceId or any Workflow-internal field; traceId is derived from instanceId.
- [x] #6 For a leased compensation job (is_compensation=1) originalInput and capturedOutput are populated from the saga_steps row of the compensated forward element; forward jobs omit both fields and carry job input_variables as 'variables'.
- [x] #7 Bounded long-poll: when no job is immediately leasable the handler polls until waitMs elapses (waitMs capped to a safe max well under the Workers request budget) then returns {jobs:[]} with 200; when a leasable job exists it returns promptly without waiting the full waitMs; maxJobs is capped to a max and defaulted to 1.
- [x] #8 REQUIRED integration test (vitest-pool-workers + real D1, tests/integration/job-lease.test.ts) covers: single created job leased exactly once (status->locked, lockToken present); two concurrent activates for one eligible job hand it to exactly one worker; an expired-lease (lock_expires_at<now) job is reclaimed and attempt increments; a worker credential for workspace B gets zero jobs for workspace A's same-taskType job; a compensation job surfaces originalInput/capturedOutput from saga_steps; long-poll returns empty {jobs:[]} after waitMs when nothing is leasable. (constitution gate)
- [x] #9 REQUIRED contract test (tests/contract/jobs-activate.test.ts) asserts the request and response conform to the activate schema and matches the openapi contract entry.
- [x] #10 Docs updated: POST /jobs/activate added to the contracts openapi (specs/002-saga-orchestrator/contracts/openapi.yaml, or specs/001-bpmn-lite-orchestrator-mvp/contracts/openapi.yaml until 002 is scaffolded) and the lease/reclaim/tenancy semantics noted in contracts/runtime-contracts.md.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. PREREQS (sibling tasks — verify present before coding): the saga migration (migrations/0002_saga.sql) adding is_compensation, worker_id, lock_token, lock_expires_at, compensates_element_id, activation_expires_at to service_task_jobs, idx_jobs_leasable (task_type,status,lock_expires_at), and the saga_steps table (§5); the worker-auth task exposing authenticateWorker(env, request) -> {workspaceId} backed by worker_credentials. If the auth seam is not yet merged, stub it behind a single helper so this endpoint has one integration point.
2. Contracts (src/contracts/api.ts, currently ends ~:141): add activateJobsRequestSchema = z.object({ taskType: z.string().min(1), workerId: z.string().min(1), maxJobs: z.number().int().positive().optional(), leaseMs: z.number().int().positive().optional(), waitMs: z.number().int().nonnegative().optional() }) and a leasedJobSchema + activateJobsResponseSchema (real zod, per §6) with fields jobId,instanceId,elementId,taskType,isCompensation,attempt,lockToken,traceId,variables,originalInput?,capturedOutput?. Export inferred types.
3. Persistence (src/persistence/instances.ts): extend JobRow (:189-203) with the new lease columns. Add leaseJobs(db, {workspaceId, taskType, workerId, leaseMs, maxJobs, now}) -> LeasedJobRow[] using the IN-subquery form. Use POSITIONAL ? binds only (src/persistence/db.ts stmt() coerces undefined->null and binds positionally; the design doc's :named placeholders are illustrative) — `now` is referenced 3x (subquery guard, outer guard, lock_expires_at base) so bind it three times; compute lock_expires_at in TS and bind it. SQL skeleton: UPDATE service_task_jobs SET worker_id=?, lock_token=?, lock_expires_at=?, status='locked', attempt_count=attempt_count+1, updated_at=? WHERE job_id IN (SELECT j.job_id FROM service_task_jobs j JOIN process_instances pi ON pi.instance_id=j.instance_id WHERE j.task_type=? AND pi.workspace_id=? AND (j.status='created' OR (j.status='locked' AND j.lock_expires_at < ?)) ORDER BY j.created_at LIMIT ?) AND (status='created' OR (status='locked' AND lock_expires_at < ?)) RETURNING job_id, instance_id, element_id, task_type, is_compensation, compensates_element_id, attempt_count, lock_token, input_variables;  Generate lock_token via newId('lock'). Run via stmt(...).all(); RETURNING is supported by D1.
4. Compensation enrichment: add a helper to load saga_steps captured_input/captured_output (and optionally trace_id) for the (instance_id, element_id) of each is_compensation=1 row (uq_saga_steps_forward, §5). For forward rows leave originalInput/capturedOutput undefined; map input_variables JSON -> variables. Derive traceId from instanceId (§6) when no ledger trace_id.
5. Handler (src/index.ts): add async handleActivateJobs(env, request): authenticate -> workspaceId; parseBody(activateJobsRequestSchema); clamp maxJobs (default 1) and waitMs (default e.g. 0, cap e.g. 25000 to stay under the Workers request budget) and leaseMs (default e.g. 30000); loop: call leaseJobs; if rows>0 break; else if elapsed<waitMs await a short delay (setTimeout-based) and retry; else return empty. Validate the result against activateJobsResponseSchema before json(...). Record a 'jobActivated' history event per leased job (history_events.type is free-text, §5) including traceId in diagnostics.
6. Routing (src/index.ts:411 area, mirror the messages branch): add `if (seg[0] === 'jobs') { if (seg.length===2 && seg[1]==='activate' && method==='POST') return handleActivateJobs(env, request); }` ahead of the NotFound throw at :416.
7. Tests: write tests/integration/job-lease.test.ts (vitest-pool-workers, real D1 via tests/apply-migrations.ts + helpers in tests/helpers.ts — add a factory that inserts an instance + a leasable service_task_jobs row, and a saga_steps row for the compensation case) covering all integration acceptance bullets, including the two-concurrent-activates single-claim case (Promise.all of two activate calls). Write tests/contract/jobs-activate.test.ts for schema conformance.
8. Docs: add the POST /jobs/activate path + schemas to the contracts openapi and document lease/reclaim/tenancy in runtime-contracts.md.
9. Verify: npm run test:integration && npm run test:contract green; npx wrangler deploy --dry-run to confirm bindings unaffected.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
POST /jobs/activate (src/index.ts handleActivateJobs + leaseOnce): authenticates → server-derived workspaceId, parseBody(activateJobsRequestSchema), clamps maxJobs(≤50, default 1)/leaseMs(≤5min, default 30s)/waitMs(≤25s, default 0). src/persistence/jobs.ts leaseJobs uses the verified atomic IN-subquery UPDATE…RETURNING form (NOT UPDATE…LIMIT…RETURNING) with the leasable guard `status='created' OR (status='locked' AND lock_expires_at < now)` duplicated in BOTH the inner subquery and outer WHERE, JOINed to process_instances for workspace scoping; leased rows → status 'locked', fresh lock_token, lock_expires_at, attempt_count++. Response validated by activateJobsResponseSchema {jobs:[{jobId,instanceId,elementId,taskType,isCompensation,attempt,lockToken,traceId,variables,originalInput?,capturedOutput?}]} — no Workflow internals; traceId = trace_<instanceId>. Compensation jobs (is_compensation=1) are enriched with originalInput+capturedOutput from the saga_steps ledger row of compensates_element_id. Bounded long-poll re-claims every 250ms until waitMs. Each lease writes a jobActivated history event. tests/integration/saga-pull-jobs.test.ts: lease-exactly-once, cross-tenant zero, expired-lease reclaim + attempt bump, two-concurrent-activates single-claim, compensation enrichment, long-poll empty. Full suite green (81).
<!-- SECTION:FINAL_SUMMARY:END -->
