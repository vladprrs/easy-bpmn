---
id: TASK-32
title: >-
  Engine: occurrence discriminator + rewalk-from-start resume ("the walk is the
  replay")
status: Done
assignee:
  - Claude
created_date: '2026-06-09 20:29'
updated_date: '2026-06-11 01:16'
labels:
  - saga
  - engine
  - runtime
  - architecture
  - tests
milestone: M2
dependencies:
  - TASK-29
references:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - src/runtime/engine.ts
  - src/runtime/executor.ts
  - src/workflows/process-workflow.ts
  - src/persistence
documentation:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - docs/bpmn/07-execution-semantics.md
priority: high
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The load-bearing M2 change (design 2026-06-09 §5; risk R-M2-1). Cycles break two M1 assumptions: (1) getForwardJobByElement(instanceId, elementId) (src/runtime/engine.ts:241) — re-entering an element finds the prior iteration's completed job and silently fast-forwards past the step; (2) Workflow step-name memoization — names like svc-create:${elementId} (:251), wait-job:${elementId} (:264), msg:${elementId} (:729) make a second iteration return the first iteration's memoized result. One mechanism fixes both: occurrence = WALK-LOCAL visit counter; the engine always re-walks the graph from the start element, fast-forwarding WRITE-FREE through applied steps using canonical D1 state; direct mode switches from resume-at-current_element_id to the same rewalk. Every step name and persistence key gains the occurrence (svc-create:el#2, wait-job:el#2, msg:el#1). Job lookup becomes (instanceId, elementId, occurrence): no row → create (new iteration); row with un-applied output → apply (resume frontier); output_applied=1 (set in the SAME dbBatch as the advance) → in-memory cursor move with NO writes — re-applying would re-merge an old iteration's output over newer variables (regression), rewrite the cursor backwards, and duplicate history events. Receive-task subscriptions are occurrence-keyed; the broker key (workspaceId+messageName+correlationKey) is unchanged. Occurrence MUST NOT be derived from live D1 row counts — during a Workflow replay those reads see post-crash state and would desynchronize step names from the original execution. The /jobs/* worker contract and process-workflow.ts are unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The engine resolves jobs, subscriptions, and step names by (elementId, walk-local occurrence) identically in DirectExecutor and Workflow modes; runStep/waitFor port signatures (engine.ts:50-55) unchanged; process-workflow.ts not edited.
- [x] #2 A loop model executes N iterations of the same serviceTask producing N distinct job rows (occurrence 0..N-1) and N waits, each with a unique step name and a unique bpmn_job_<jobId> event type.
- [x] #3 Rewalk fast-forward is write-free for applied steps: resuming mid-loop (direct mode) and replaying (workflow mode) produces no duplicate jobs, no variable regression, no duplicate history events, and lands on the live frontier — integration test for BOTH modes (design §10.6).
- [x] #4 output_applied is set atomically (same dbBatch) with the advance; a crash window between worker completion and apply still resumes correctly — apply-once proven by test.
- [x] #5 Receive task inside a loop: the second iteration re-subscribes (occurrence-keyed) and correlates independently; duplicate complete/fail within one iteration advances at most once per occurrence (design §10.8).
- [x] #6 Constitution gate: the existing test suite stays green; any test edited because resume semantics changed is individually justified in the task notes; npm run test green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: subagent-driven (implementer + spec review + quality review) on branch m2-conditional-sagas. The heart of M2 (design §5, risk R-M2-1): occurrence = walk-local visit counter; engine always re-walks from the start element fast-forwarding WRITE-FREE through applied steps using canonical D1 state; direct mode switches from resume-at-current_element_id to the same rewalk.

1. Engine: walk-local occurrence counters (in-memory Map elementId→count during the walk; NEVER derived from D1 row counts); every step name + persistence key gains #occ (svc-create:el#2, wait-job:el#2, msg:el#1, recv:el#k, tx:el#k, gw-guard stays per TASK-33 until TASK-34).
2. Job lookup -> getForwardJob(instanceId, elementId, occurrence): no row -> create (new iteration); row with un-applied output -> apply (resume frontier); output_applied=1 -> write-free fast-forward (cursor move only). output_applied set in the SAME dbBatch as the advance. Widen idempotencyKey to include is_compensation+occurrence (carried from TASK-29 review). Migrate engine call sites off deprecated getForwardJobByElement; add occurrence-aware compensation job lookup + fix the @deprecated pointer on getCompensationJobByElement.
3. Receive: subscriptions occurrence-keyed (TASK-29 column); broker key unchanged; sequential re-subscription per iteration.
4. Fast-forward predicates per node kind derived from canonical D1 state (jobs: output_applied; receive: subscription consumed/correlated + transition applied; start/tx/end: position-relative — no writes, no duplicate history when pre-frontier). Hardest design point — implementer designs predicates from actual engine code.
5. Tests (loop WITHOUT gateway dependency — TASK-34 not landed): cyclic graph injected via createVersion direct insert (bypasses publish gate's end-reachability), cycle Start→TaskA→Recv→TaskA so each iteration PARKS at the receive task giving the test full iteration control; N messages -> N+1 job rows occ 0..N, unique step names/event types, N+1 subscriptions. Replay determinism BOTH modes: direct = re-enter runInstance via deliverJobResult/deliverMessage mid-loop; workflow = memoizing runStep harness driving runInstance with simulated crash/replay (real CF Workflow runtime not testable under vitest EXECUTION_MODE=direct — harness simulates step memoization semantics). Duplicate complete/fail within an iteration advances at most once per occurrence. M1 suite stays green; any edited test individually justified.
runStep/waitFor port signatures unchanged; process-workflow.ts NOT edited.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Two-stage review done (deep). Spec review: engine core compliant (determinism audit: no D1 read influences a step name; write-free fast-forward verified per predicate; contracts untouched) + 2 defects found and fixed in 41b929e: (1) migration 0005 backfill predicate replaced with the exact variable_snapshots witness (M1 wrote the snapshot unconditionally, source='serviceTask', source_id=job_id — even for empty outputs; poison paths have no witness); old per-instance status!='incident' predicate was wrong in both directions. (2) resetJobForRetry widened back to include created/locked unapplied jobs (workflow-mode svc-timeout/comp-timeout lanes; M1 had no status filter). Plus: appliedForwardOutcome defensive branch now throws (invariant violation) instead of silently zombifying.

Quality review: With fixes -> 42195f3 + 8174f51: occurrence stamped into the 3 visit-marker history events + visitApplied switched from count>occ to existence-per-occurrence (COALESCE for legacy M1 markers => occurrence 0) — duplicate concurrent walks now only duplicate audit, never corrupt later visits; MARKER comments at all 4 write sites; executor deliverJobResult catches now recordTerminalIncident (mode parity — silent stalls violated operator-visible-errors); resetJobForRetry clears stale activation_expires_at; 0005 header states deploy ordering. HARNESS FLAKE FIXED (8174f51): drainSampleWorkers jitter window (lock_expires_at > fresh-Date bind) removed — saga-operator flake root-caused and closed; 213/213 ×3 clean.

Live-migration choreography for bpmn.rntme.com: apply 0004+0005 remotely BEFORE deploying the rewalk engine (step names changed to #occ for ALL steps; predicate-guarded bodies make in-flight Workflow replays write-free; re-armed waits keep occurrence-free event types so pending sendEvents land; deploy at a quiet moment — narrow receive-task window needs manual republish if hit).

Carried into TASK-34: gateway predicate must use gateway_decisions EXISTS (NOT marker counts); fix stale 'counted by' wording in the 4 MARKER comments; gw-guard arm + xor-engine-guard.test.ts get replaced. Carried into TASK-35/36: poison strikes are per (instance, element) ACROSS occurrences (a loop shares one poison budget — pre-existing, review whether per-occurrence is wanted); loop guard (MAX_ELEMENT_OCCURRENCES=1000, loopLimit) landed here as groundwork — TASK-35 owes tests/Hazard/docs. M3 hardening idea: inline drives have no retry layer before recordTerminalIncident (transient D1 errors are operator-recoverable noise).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The walk is the replay: engine always re-walks from the start element with walk-local in-memory occurrence counters (never D1-derived); every step/wait name and persistence key carries #occurrence; direct mode abandoned resume-at-current_element_id. Frontier emerges from per-node-kind applied-predicates inside idempotent step bodies: serviceTask 4-state via output_applied (marked in the SAME dbBatch as the advance; markFailedJobHandledStmt for routed failures), receiveTask 3-state via occurrence-keyed subscriptions (consumed/active/none; duplicate events dropped by externalMessageId), bookkeeping via occurrence-stamped marker history events (existence predicate, legacy-M1 markers fold to occ 0). Compensation inherits forward occurrence end-to-end; idempotencyKey widened to instance:element:isComp:occ; deprecated lookups retired from the engine; MAX_ELEMENT_OCCURRENCES=1000 loopLimit guard landed as groundwork. Migration 0005 backfills output_applied via the exact variable_snapshots witness (live-migration safety for bpmn.rntme.com; apply 0004+0005 before deploy). Mode parity: inline-drive errors now settle operator-visible incidents. Tests: loop-rewalk (injected cyclic graph, full-D1-snapshot write-freedom proof, apply-once crash window, per-occurrence idempotency, legacy markers) + loop-replay-workflow (memoizing step.do harness incl. committed-but-unmemoized window) + 0005 backfill matrix + reset-matcher matrix; drainSampleWorkers jitter-window flake fixed at the root. 213/213 ×3. Commits 3cf36c4, 41b929e, 42195f3, 8174f51. Existing tests edited: zero.
<!-- SECTION:FINAL_SUMMARY:END -->
