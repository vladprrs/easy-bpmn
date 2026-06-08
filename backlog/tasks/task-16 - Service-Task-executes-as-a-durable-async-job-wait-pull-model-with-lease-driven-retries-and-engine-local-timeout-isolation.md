---
id: TASK-16
title: >-
  Service Task executes as a durable async job wait (pull model) with
  lease-driven retries and engine-local timeout isolation
status: To Do
assignee: []
created_date: '2026-06-08 08:18'
labels:
  - saga
  - engine
  - runtime
  - workflows
  - idempotency
  - contracts
  - tests
milestone: m-1
dependencies:
  - TASK-11
  - TASK-15
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.3 Pull
    worker model — Service Task becomes an async wait)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.7
    Idempotency / at-least-once additions — single-advance via step memoization
  - terminal no-op ack)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.2
    scope-aware engine
  - §4.5 failure taxonomy
  - §11 task 6)
  - >-
    src/runtime/engine.ts:215-365 (runServiceTask synchronous loop to rewrite);
    :50-55 (RunStep/WaitForEvent ports); :213 (ServiceTaskOutcome); :118-129
    (serviceTask dispatch in loop)
  - >-
    src/workflows/process-workflow.ts:24-50 (waitForEvent wiring + catch-all
    that must not absorb the job timeout)
  - 'src/runtime/service-task.ts:8-20 (WorkerRequest/WorkerResult shapes)'
  - >-
    src/runtime/executor.ts:40-57 (DirectExecutor test harness + deliver resume
    path)
  - >-
    src/bpmn/profile.ts:37-40 (workflowEventTypeFor sanitizer to mirror for
    jobs)
  - >-
    src/contracts/workflow-events.ts:6-14 (event-payload zod boundary; add
    job-result schema)
  - >-
    src/persistence/instances.ts:217-247 (createJob — already inserts status
    'created'
  - attempt_count 0)
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/runtime-contracts.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/07-execution-semantics.md
modified_files:
  - src/runtime/engine.ts
  - src/contracts/workflow-events.ts
  - src/bpmn/profile.ts
  - src/runtime/retry-policy.ts
  - src/workflows/process-workflow.ts
  - src/runtime/executor.ts
  - src/runtime/service-task.ts
  - tests/unit/job-event-type.test.ts
  - tests/unit/job-wait-timeout.test.ts
  - tests/contract/job-result-event.test.ts
  - tests/integration/service-task-wait.test.ts
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/runtime-contracts.md
priority: high
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Turn the Service Task from a synchronous in-engine retry loop into a durable async wait — the foundation of the SAGA pull/external-task model (design §4.3; decision #2). Today runServiceTask (src/runtime/engine.ts:215-365) calls invokeSampleWorker in a for-loop and returns {next}|{incident}, coupling the orchestrator to worker addresses and burning one Workflow step for the whole retry budget.

New behavior: persist-before-advance creates the service_task_jobs row as a leasable 'created' job (no outbound call), then the engine issues exactly ONE step.waitForEvent per logical job on event type bpmn_job_<jobId> (sanitized, dot-free, <=100 chars, mirroring workflowEventTypeFor at profile.ts:37-40). Timeout >= retries x (leaseMs + maxBackoff) so technical retries are driven by re-lease on the HTTP side, NOT by re-entering waitForEvent (flat 1-wait-per-task budget). Resume payload is a discriminated job-result {outcome:'completed',output}|{outcome:'failed',retryable,errorCode?,reason}; the engine branches on it and the FIRST event wins (CF Workflow step memoization = single-advance guarantee, §4.7).

Crux: the per-job waitForEvent timeout MUST be caught inside the engine and routed to the technical-failure branch; it must NOT reach the process-workflow.ts:41-50 catch-all (which would make a task-level timeout a terminal 'Workflow terminated' incident, bypassing later compensation). Lease expiry can run a worker twice, so forward workers are at-least-once — document idempotency-on-jobId as normative (§4.3).

Engine subset of M1 task (6); depends on the lease-column migration (task 3) + activate/complete/fail endpoints that send the job event (task 5/6); business-error->boundary->cancel routing is task 8 (here, only surface the business discriminant).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 runServiceTask no longer calls invokeSampleWorker: entering a Service Task persists a service_task_jobs row with status 'created' and attempt_count 0 BEFORE any external interaction, and the instance reaches a durable wait with no synchronous worker execution (persist-before-advance preserved).
- [ ] #2 The engine issues exactly ONE waitForEvent per logical job, on an event type produced by a job-scoped sanitizer (e.g. workflowJobEventTypeFor) that is dot-free, <=100 chars, and matches the CF event-type regex ^[A-Za-z0-9_][A-Za-z0-9-_]*$; a unit test asserts sanitization for a job id containing dots/spaces and for a >100-char input.
- [ ] #3 A discriminated job-result schema {outcome:'completed',output} | {outcome:'failed',retryable:boolean,errorCode?:string,reason:string} is added to src/contracts/workflow-events.ts; a contract test asserts both arms parse and that a malformed/unknown-discriminant payload is rejected.
- [ ] #4 The waitForEvent timeout for a job is computed as >= retries x (leaseMs + maxBackoff) from the documented lease/backoff constants; a unit test asserts the computed CF-duration timeout for representative retries values (e.g. retries=1 and retries=3).
- [ ] #5 Integration test (vitest-pool-workers): a 'completed' job-result event resumes the waiting instance, the worker output is persisted (job completed + variable snapshot) before the transition, and the instance advances to the next element.
- [ ] #6 Integration test: two duplicate 'completed' events for the same job advance the instance at most once (first-event-wins via Workflow step memoization); the second delivery is a no-op (no double variable apply, no double transition).
- [ ] #7 Integration test: a 'failed' job-result with retryable=true / no errorCode (representing technical exhaustion) routes to the technical-failure branch and produces a terminal incident whose reason is the task-level technical failure, NOT the process-workflow.ts catch-all 'Workflow terminated' message.
- [ ] #8 Integration test (local-timeout isolation — headline invariant): when the per-job waitForEvent times out, the timeout is handled inside the engine and routed to the technical-failure branch; it does NOT propagate to the process-workflow.ts:41-50 catch-all (assert the incident is the engine-routed task timeout, not a 'Workflow terminated' incident).
- [ ] #9 A 'failed' job-result carrying an errorCode is surfaced as a business-error outcome distinct from a technical failure (it does NOT create a technical incident); full error-boundary->cancel routing is out of scope (M1 task 8), but a test asserts the engine emits the business-error discriminant rather than a technical incident.
- [ ] #10 The DirectExecutor test harness (src/runtime/executor.ts:40-57) can resume a Service Task wait by delivering a job-result event (mirroring the Receive Task deliver path), so the new wait is testable without the Cloudflare Workflow runtime.
- [ ] #11 Forward-worker idempotency-on-jobId is documented as a normative at-least-once requirement (§4.3) in contracts/runtime-contracts.md AND as a code/contract comment in src/contracts/workflow-events.ts (or src/runtime/service-task.ts).
- [ ] #12 The existing Receive Task wait path and its 1-hour-timeout->terminal-incident behavior are unchanged, and the full existing suite (npm run test) stays green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add the job-result discriminated union to src/contracts/workflow-events.ts (next to messageEventPayloadSchema:6-12): jobResultEventSchema = z.discriminatedUnion('outcome', [...completed, ...failed]); export JobResultEvent. Add a contract comment stating forward workers must be idempotent on jobId.
2. Add workflowJobEventTypeFor(jobId) to src/bpmn/profile.ts mirroring workflowEventTypeFor (37-40): `bpmn_job_${jobId.replace(/[^A-Za-z0-9_-]/g,'_')}`.slice(0,100). Add a small retry-policy helper (new src/runtime/retry-policy.ts): LEASE_MS, MAX_BACKOFF_MS constants + computeJobWaitTimeout(retries) returning a CF-duration string >= retries*(leaseMs+maxBackoff).
3. In src/runtime/engine.ts add a WaitForJob port alongside WaitForEvent (50-55): (args:{jobId,elementId,workflowEventType,timeout}) => Promise<JobResultEvent | {outcome:'timeout'}>. Thread it through RunOptions (62-67) and runInstance (86-94).
4. Rewrite runServiceTask (215-365): KEEP the completed-job idempotency short-circuit (227-233), the oversized-input guard (236-238), and createJob (250-262; status already 'created'/attempt 0 per instances.ts:234) + serviceTaskJobCreated history. DELETE the for-loop (275-362) incl. incrementJobAttempt/createAttempt/invokeSampleWorker/finishAttempt (attempt accounting moves to the HTTP activate/complete/fail endpoints — sibling task). Issue one waitForJob on workflowJobEventTypeFor(jobId) with computeJobWaitTimeout(retryLimit).
5. Branch on the job-result: completed -> reuse the completion dbBatch (322-341: jobCompleteStmt + variableSnapshotStmt + history + applyTransitionStmt); failed with errorCode -> return a new businessError ServiceTaskOutcome arm (extend type at 213) for the dispatch layer; failed technical OR {outcome:'timeout'} -> createServiceTaskIncident (367-403). Handle the new outcome arm in loop (118-129).
6. Wire the port in src/workflows/process-workflow.ts: add waitForJob calling step.waitForEvent(`wait:job:${jobId}`, {type,timeout}), try/catch the CF timeout rejection and return {outcome:'timeout'} so it never reaches the catch-all (41-50). Verify the actual CF step.waitForEvent timeout semantics (throws vs resolves) and adapt the wrapper.
7. Wire src/runtime/executor.ts DirectExecutor (40-57): add a deliver-style job-result injection + a runInstance resume (startAt + incoming job event) mirroring the message deliver path (49-56).
8. Add tests: unit (sanitizer + timeout calc) under tests/unit; contract (job-result schema) under tests/contract; integration (completed, duplicate-completed, technical-incident, local-timeout isolation, business-vs-technical) under tests/integration.
9. Docs: document forward-worker idempotency-on-jobId in contracts/runtime-contracts.md and align the §4.3 wait semantics.
<!-- SECTION:PLAN:END -->
