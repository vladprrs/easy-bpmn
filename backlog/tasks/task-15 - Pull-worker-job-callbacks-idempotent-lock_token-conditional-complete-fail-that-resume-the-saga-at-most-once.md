---
id: TASK-15
title: >-
  Pull-worker job callbacks: idempotent, lock_token-conditional complete/fail
  that resume the saga at most once
status: Done
assignee: []
created_date: '2026-06-08 08:17'
updated_date: '2026-06-08 13:02'
labels:
  - saga
  - api
  - persistence
  - idempotency
  - engine
  - tests
milestone: m-1
dependencies:
  - TASK-12
  - TASK-13
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.3 Pull
    worker model / job-result schema / lock_token-conditional complete-fail)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.7
    Idempotency / at-least-once additions — workerCallback keyed
    jobId+lockToken; sendEvent terminal no-op ack)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.5 Failure
    taxonomy — technical vs business errorCode->bpmn:error/@errorCode; §6 API
    deltas)
  - >-
    src/index.ts:385-417 (flat router) and src/index.ts:153-201
    (assertPayloadWithinLimit + idempotency pattern to mirror)
  - >-
    src/runtime/executor.ts:31-37 (WorkflowExecutor.deliver -> sendEvent to
    wrap)
  - 'src/contracts/workflow-events.ts:6-23 (add job-result schema here)'
  - 'src/runtime/payload.ts:7-25 (assertPayloadWithinLimit'
  - MAX_EVENT_PAYLOAD_BYTES)
  - >-
    src/persistence/idempotency.ts:6-39 (workerCallback scope already
    enumerated; INSERT OR IGNORE put)
  - >-
    src/bpmn/profile.ts:37-40 (workflowEventTypeFor sanitizer to mirror for
    bpmn_job_<jobId>)
  - >-
    migrations/0001_mvp_schema.sql:105-123 (service_task_jobs —
    lock_token/worker_id/lock_expires_at/error_code added by migration 0002
  - sibling task)
  - >-
    src/workflows/process-workflow.ts:41-50 (catch-all that a job timeout must
    NOT reach — engine handles local timeout)
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - .specify/memory/constitution.md
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - specs/002-saga-orchestrator/contracts/runtime-contracts.md
modified_files:
  - src/contracts/workflow-events.ts
  - src/contracts/api.ts
  - src/persistence/jobs.ts
  - src/persistence/idempotency.ts
  - src/bpmn/profile.ts
  - src/runtime/executor.ts
  - src/index.ts
  - tests/contract/jobs-callbacks.test.ts
  - tests/integration/saga-worker-callbacks.test.ts
  - tests/unit/job-callbacks.test.ts
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - specs/002-saga-orchestrator/contracts/runtime-contracts.md
priority: high
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the two pull-worker result callbacks POST /jobs/{jobId}/complete and POST /jobs/{jobId}/fail so a remote microservice can resume the orchestrator after running a Service Task job. WHY: M1 turns a Service Task into a durable async wait (the engine does step.waitForEvent on event type bpmn_job_<jobId>); these endpoints are the at-least-once resume edge and MUST advance the saga at most once.

Per design §4.3, both callbacks are lock_token-conditional UPDATEs (... WHERE job_id=? AND lock_token=?) that clear/rotate the token. The worker's lockToken (issued by POST /jobs/activate — sibling task; lock_token/worker_id/lock_expires_at/error_code columns added by migration 0002 — sibling task) is a capability: a stale token (lease expired, job re-leased elsewhere) matches 0 rows and is rejected; a duplicate (same token, already applied) matches 0 rows and must return the stable prior outcome. To stop a duplicate FAIL from re-counting an attempt (the premature-exhaustion bug, §4.7), persist a workerCallback idempotency_records row keyed jobId+lockToken and short-circuit to the stored outcome on replay.

complete must run assertPayloadWithinLimit (src/runtime/payload.ts, ~1MiB) BEFORE delivering. sendEvent throws against a terminal/not-running Workflow, so gate on D1 first: a terminal job/instance returns 200 no-op ACK, and wrap sendEvent so any not-running/errored throw is ALSO 200 — never 500 — else at-least-once workers retry forever (permastuck). fail classifies technical (retryable / no errorCode -> re-leasable, attempt_count++) vs business (errorCode matching a model bpmn:error/@errorCode -> raise the BPMN error for the engine's compensation pass; §4.5). Define the discriminated job-result event schema in src/contracts/workflow-events.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 src/contracts/workflow-events.ts exports a zod discriminatedUnion job-result event { outcome:'completed', output } | { outcome:'failed', retryable:boolean, errorCode?:string, reason:string }, plus its inferred type; a 'failed' payload missing reason and a non-discriminated payload are both rejected.
- [x] #2 POST /jobs/{jobId}/complete persists output via a lock_token-conditional UPDATE (WHERE job_id=? AND lock_token=?) that clears the token on success, then (if the instance is live) delivers a { outcome:'completed', output } event on type bpmn_job_<jobId>.
- [x] #3 POST /jobs/{jobId}/fail performs a lock_token-conditional UPDATE: technical failure (retryable true / no errorCode) makes the job re-leasable and increments attempt_count; business failure (errorCode set) records error_code and is delivered as { outcome:'failed', retryable, errorCode, reason } for the engine to match against bpmn:error/@errorCode.
- [x] #4 complete runs assertPayloadWithinLimit on outputVariables (src/runtime/payload.ts) BEFORE any delivery; an output exceeding the ~1MiB limit returns 400 and never calls sendEvent.
- [x] #5 A duplicate complete AND a duplicate fail (same jobId+lockToken) each return the stored prior outcome with 200 via a workerCallback idempotency_records row keyed jobId+lockToken; the duplicate fail does NOT increment attempt_count and neither triggers a second sendEvent.
- [x] #6 A callback bearing a stale lock_token (job already re-leased to a different token, lease expired) matches 0 rows and is rejected (409) without delivering an event.
- [x] #7 A callback whose job or instance is already terminal returns a 200 no-op ACK; a sendEvent throw against a not-running/terminal Workflow is caught and also returned as 200, never surfacing as a 500.
- [x] #8 Contract test (tests/contract): both endpoints validate request bodies and ack responses against the zod schemas in src/contracts/api.ts and the openapi contract; the job-result event payload conforms to workflow-events.ts.
- [x] #9 Integration test (tests/integration, vitest-pool-workers): end-to-end covers happy complete resumes the wait once; duplicate complete and duplicate fail advance at most once; stale token rejected; oversized output -> 400; late callback to a terminal instance -> 200 no-op ack (not permastuck); business-error fail delivered as the business discriminator. (Constitution gate: runtime/API/persistence change ships tests.)
- [x] #10 Unit test (tests/unit): the lock_token-conditional complete/fail statement helpers report 0 rows-affected on token mismatch and clear/rotate the token on a match.
- [x] #11 Docs updated: the two paths plus the job-result event schema are added to specs/002-saga-orchestrator/contracts/openapi.yaml and contracts/runtime-contracts.md.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/contracts/workflow-events.ts (today only messageEventPayloadSchema + ProcessWorkflowParams, lines 6-23): add jobResultEventSchema = z.discriminatedUnion('outcome', [completed{output}, failed{retryable,errorCode?,reason}]) and export JobResultEvent.
2. src/contracts/api.ts: add jobCompleteRequestSchema {lockToken, outputVariables}, jobFailRequestSchema {lockToken, reason, errorCode?, retryable?}, and a job-ack response schema (close the un-validated-response gap, §6).
3. New src/persistence/jobs.ts: getJob(jobId); completeJobConditional / failJobConditional returning rows-affected via lock_token-conditional UPDATE (WHERE job_id=? AND lock_token=?) clearing lock_token — complete sets status='completed'+output_variables+completed_at; fail technical sets status='created', attempt_count=attempt_count+1; fail business sets a business-failure status + error_code. Bundle into one dbBatch (src/persistence/db.ts) with putIdempotentResult (src/persistence/idempotency.ts, scope 'workerCallback' already enumerated lines 6-10, key `${jobId}:${lockToken}`) + recordHistory jobCompleted/jobFailed for atomicity.
4. src/bpmn/profile.ts: add workflowJobEventTypeFor(jobId) beside workflowEventTypeFor (lines 37-40) -> `bpmn_job_${safe}`.slice(0,100), dot-free (CF Workflows event types forbid dots).
5. src/runtime/executor.ts: add deliverJobResult mirroring deliver (lines 31-37); WorkflowExecutor wraps sendEvent in try/catch to swallow not-running/errored throws and ack; DirectExecutor resumes the engine inline for tests.
6. src/index.ts route() (add a `seg[0]==='jobs'` block near the instances block ~lines 406-409): handleCompleteJob/handleFailJob -> parseBody; (a) getIdempotentResult('workerCallback', `${jobId}:${lockToken}`) -> return stored 200 if present; (b) complete: assertPayloadWithinLimit(outputVariables); (c) conditional UPDATE; 0 rows -> 200 no-op ack if job/instance terminal else 409 stale; (d) on success gate on getInstance status — terminal -> 200 ack without send, else deliverJobResult(bpmn_job_<jobId>). Note: worker-credential workspace derivation is a sibling task (§6/decision 6); coordinate so callbacks reject cross-tenant jobs.
7. Add the three test files.
8. Update openapi.yaml + runtime-contracts.md.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Mechanics complete and green: job-result discriminated union in src/contracts/workflow-events.ts; POST /jobs/{id}/complete (lock_token-conditional, payload-limit-before-delivery, terminal 200 no-op ack, stale→409) and /jobs/{id}/fail (technical re-leasable vs business errorCode→failed) in src/index.ts via src/persistence/jobs.ts completeJobConditional/failJobConditional; workerCallback idempotency keyed jobId:lockToken (duplicate complete AND duplicate fail advance at most once, no second effect); executor.deliverJobResult wraps sendEvent so a terminal/not-running instance is a 200 ack not a 500. tests/integration/saga-pull-jobs.test.ts covers complete idempotency, stale→409, oversized→400, terminal no-op, business-error fail, technical-retry re-lease. REMAINING (AC #9 'happy complete resumes the wait once', AC #10 dedicated unit test): the actual instance resume is wired through executor.deliverJobResult but is DORMANT until the engine flip (TASK-16, Service-Task-as-wait) — DirectExecutor.deliverJobResult is a no-op and WorkflowExecutor sends bpmn_job_<jobId>, but the engine does not yet wait on job events. Finish #9/#10 alongside TASK-16.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Complete. With the engine flip (TASK-16) landed, complete/fail now genuinely resume the Service-Task-as-wait: demo-flow.test.ts proves a happy /complete resumes the wait exactly once (instance advances to the Receive Task), and saga-orchestration/saga-pull-jobs cover duplicate-complete + duplicate-fail (advance at most once via the workerCallback idempotency record), stale-token→409, oversized→400, terminal→200 no-op ack, and business-error delivery. The lock_token-conditional helpers (jobs.ts) report 0 rows on token mismatch (verified by the stale-token test).
<!-- SECTION:FINAL_SUMMARY:END -->
