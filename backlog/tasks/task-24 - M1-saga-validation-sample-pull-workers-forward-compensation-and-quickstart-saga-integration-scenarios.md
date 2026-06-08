---
id: TASK-24
title: >-
  M1 saga validation: sample pull workers (forward + compensation) and
  quickstart saga integration scenarios
status: To Do
assignee: []
created_date: '2026-06-08 08:18'
labels:
  - saga
  - tests
  - worker
  - api
  - governance
  - docs
milestone: m-1
dependencies:
  - TASK-16
  - TASK-18
  - TASK-19
  - TASK-20
  - TASK-21
  - TASK-22
  - TASK-23
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§8 M1 exit
    criteria
  - line 332)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§3 canonical
    saga contract + order-saga example
  - lines 46-132)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.3 pull
    worker model / Service-Task-as-wait
  - lines 156-188)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§4.4
    reverse-order compensation
  - lines 189-199; §4.6 status transition table
  - lines 207-222; §4.7 idempotency/terminal no-op ack
  - lines 224-230)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§6 API +
    worker auth/isolation
  - lines 288-307; §11 task 16
  - line 364)
  - >-
    src/runtime/service-task.ts:8-54 (WorkerRequest/WorkerResult shapes +
    steerable sample workers)
  - >-
    tests/helpers.ts:12-80
    (api/post/get/createDraft/publishDraft/startInstance/publishAndStart/publishMessage;
    api() lacks Authorization header support)
  - tests/integration/duplicate-worker-callback.test.ts
  - tests/integration/late-message.test.ts
  - tests/integration/immutable-version.test.ts
  - tests/integration/service-task-incident.test.ts
  - tests/integration/demo-flow.test.ts
  - specs/001-bpmn-lite-orchestrator-mvp/quickstart.md
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - specs/001-bpmn-lite-orchestrator-mvp/quickstart.md
  - specs/002-saga-orchestrator/quickstart.md
  - docs/bpmn/09-easy-bpmn-profile.md
modified_files:
  - tests/saga-helpers.ts
  - tests/helpers.ts
  - tests/integration/saga-happy.test.ts
  - tests/integration/saga-business-error-compensation.test.ts
  - tests/integration/saga-compensator-failure.test.ts
  - tests/integration/saga-duplicate-callbacks.test.ts
  - tests/integration/saga-late-callback-terminal.test.ts
  - tests/integration/saga-cross-tenant-reject.test.ts
  - tests/integration/saga-version-binding-compensation.test.ts
  - examples/order-saga.bpmn
  - examples/sample-saga-worker.ts
  - specs/002-saga-orchestrator/quickstart.md
priority: high
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deliver the M1 validation capstone: sample remote workers (forward + compensation) that exercise the pull/external-task contract, plus the saga integration suite that is the constitution gate for M1 (every runtime/API/persistence change ships a test).

WHY: design decision #2 replaces in-process worker invocation with Zeebe-style pull — services lease jobs via POST /jobs/activate by easy-bpmn:taskDefinition type, then POST /jobs/{id}/complete or /fail with their lockToken. Forward and compensation jobs share one lane; isCompensation distinguishes them; comp jobs carry originalInput + capturedOutput (§4.3, §4.4). Compensation runs in reverse completion order, scoped to the transaction, atomic with advance; a compensator that exhausts its retries -> compensationFailed + operator POST /instances/{id}/retry resumes from there (§4.4, decision #4). Worker auth derives workspaceId from a per-workspace bearer credential; a body workspaceId is never trusted for job access (§6, decision #6). A callback to an already-terminal instance MUST be a 200 no-op ack, never a 500/throw, else at-least-once workers retry forever and permastuck (§4.7). Immutable version binding means a v1 instance mid-saga compensates via v1's graph even after v2 publishes (§2 "what stays").

This task provides a reusable worker loop + the §3 order-saga fixture and the seven §8 M1 exit-criteria scenarios. It depends on M1 tasks 1-15 (graph IR/validator, lease + activate/complete/fail, compensation pass, worker auth, operator verbs) being in place. Mirror the scenario-as-test style of specs/001 quickstart and tests/integration/*.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A reusable sample worker loop (covering forward AND compensation jobs) exists that authenticates with a per-workspace worker bearer credential, polls POST /jobs/activate by taskType, dispatches by jobId/isCompensation, and settles each job via /complete or /fail (errorCode set for a business error); handler behavior is steerable for deterministic tests (force-fail, fail-until-attempt, business-error errorCode, compensator-fail).
- [ ] #2 The canonical order-saga BPMN fixture (the design §3 transaction-saga: reserveStock/releaseStock, chargeCard/refundCard, confirmShipping with error boundary -> cancel end -> cancel boundary -> SagaFailed) is added and publishes successfully under the M1 profile.
- [ ] #3 Integration test (happy saga commit): the forward worker loop completes every step end-to-end, the transaction commits via the none end event, the instance reaches status completed, and the saga_steps ledger shows the compensatable steps recorded but un-compensated with zero compensation jobs created.
- [ ] #4 Integration test (business error mid-saga): a forward step /fail with errorCode matching a bpmn:error/@errorCode raises the BPMN error -> error boundary -> cancel end; the engine compensates completed steps in REVERSE completion order (asserted via saga_steps.seq and/or compensation history events), and the instance settles to the saga-failed terminal state as compensated (NOT completed via completeInstance, per §4.4 step 5).
- [ ] #5 Integration test (compensator failure + remediation): a compensation handler that exhausts its retries drives status compensationFailed plus an incident with kind=compensationFailure; the reverse pass stops at the failed step (already-compensated suffix stays compensated); a subsequent operator POST /instances/{id}/retry resumes the reverse pass from that step and the instance reaches the saga-failed terminal.
- [ ] #6 Integration test (duplicate /complete): a re-delivered complete for the same jobId+lockToken returns the stable prior outcome, advances the instance at most once, and does not write a second saga_steps ledger row.
- [ ] #7 Integration test (duplicate /fail): a re-delivered fail returns the stable prior outcome, advances at most once, and does NOT double-count an attempt against retries (the premature-exhaustion guard, §4.7 workerCallback keying).
- [ ] #8 Integration test (late callback to terminal instance): a /complete or /fail against an already-terminal instance returns HTTP 200 as a no-op ack (never a 500/throw), so an at-least-once worker does not retry forever (no permastuck).
- [ ] #9 Integration test (cross-tenant isolation): activating with workspace-A's credential for a taskType whose jobs belong to workspace-B is rejected / returns no jobs and leaks no job or payload; a body-supplied workspaceId is ignored in favor of the credential-derived workspaceId.
- [ ] #10 Integration test (remote worker drives a step end-to-end): at least one forward step is fully driven by the loop-based external worker via activate -> complete, proving the orchestrator does not invoke workers in-process.
- [ ] #11 Integration test (version binding during compensation): a v1 instance is taken mid-saga, v2 is published from the same draft, then v1 fails and compensates using v1's compensation handlers/taskTypes (asserted), unaffected by v2; new instances can still start from v2.
- [ ] #12 All saga integration tests run under vitest + @cloudflare/vitest-pool-workers (workerd), are wired into `npm run test:integration`, and the full suite is green.
- [ ] #13 Docs: the saga quickstart (specs/002-saga-orchestrator/quickstart.md) documents these scenarios as executable validation targets mapping 1:1 to the integration tests; docs/bpmn/09-easy-bpmn-profile.md saga profile references are consistent with the order-saga fixture.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add ORDER_SAGA_BPMN fixture (design §3, lines 52-112) in a new tests/saga-helpers.ts and drop the same XML as examples/order-saga.bpmn; assert it publishes under the M1 profile.
2. Extend tests/helpers.ts api() (helpers.ts:12-32) to accept an Authorization bearer header (today it only sets content-type), and add waitForStatus(instanceId, predicate) polling — the pull model no longer completes the Service Task synchronously during start (contrast demo-flow.test.ts:29 which asserts immediate "waiting").
3. In tests/saga-helpers.ts add mintWorkerCredential(workspaceId) (using task-4's worker_credentials seam) and runWorker({taskType, token, handle, maxJobs, waitMs}): POST /jobs/activate -> for each job dispatch by isCompensation/elementId -> POST /jobs/{id}/complete (outputVariables) or /fail (reason, errorCode?, retryable?). Reuse the steerable-handler idea from service-task.ts:30-54 (forceFail, failUntilAttempt) plus a businessError(errorCode) variant and a compensator-fail variant; comp handlers read originalInput + capturedOutput.
4. examples/sample-saga-worker.ts: a deployable forward+compensation worker loop sharing the same activate/complete/fail contract (WorkerRequest/WorkerResult lineage, service-task.ts:8-20).
5. saga-happy.test.ts: run the forward loop to commit; assert completed + ledger un-compensated + no comp jobs (mirror demo-flow.test.ts history-type checks).
6. saga-business-error-compensation.test.ts: confirmShipping /fail errorCode=SHIPPING_REJECTED -> cancel; run comp loop; assert reverse order via saga_steps.seq / compensation history; terminal = compensated not completed (§4.4).
7. saga-compensator-failure.test.ts: comp handler exhausts retries -> compensationFailed + incident kind=compensationFailure (mirror service-task-incident.test.ts:11-26); POST /instances/{id}/retry resumes the reverse pass.
8. saga-duplicate-callbacks.test.ts: duplicate /complete and duplicate /fail each return stable prior outcome; assert single advance, no second ledger row, attempt not double-counted (reuse history-count technique from duplicate-worker-callback.test.ts:34-40).
9. saga-late-callback-terminal.test.ts: callback to a terminal instance -> HTTP 200 no-op ack (not 500), per §4.7.
10. saga-cross-tenant-reject.test.ts: workspace-A credential activating workspace-B taskType -> rejected/no jobs; body workspaceId ignored.
11. saga-version-binding-compensation.test.ts: v1 mid-saga; publish v2; fail v1 -> compensates via v1 handlers (mirror immutable-version.test.ts).
12. Author specs/002-saga-orchestrator/quickstart.md saga scenarios mapping 1:1 to the tests; run `npm run test:integration` green; `npx wrangler deploy --dry-run` validates bindings.
<!-- SECTION:PLAN:END -->
