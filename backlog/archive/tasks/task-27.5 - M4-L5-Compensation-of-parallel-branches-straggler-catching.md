---
id: TASK-27.5
title: 'M4-L5: Compensation of parallel branches (straggler-catching)'
status: To Do
assignee: []
created_date: '2026-06-13 08:49'
updated_date: '2026-06-13 08:52'
labels:
  - saga
  - engine
  - m4
milestone: m-4
dependencies: []
documentation:
  - docs/superpowers/plans/2026-06-13-m4-concurrency.md
  - docs/superpowers/specs/2026-06-13-m4-concurrency-design.md
modified_files:
  - tests/integration/parallel-compensation.test.ts
  - src/runtime/compensation.ts
  - src/runtime/forward-task.ts
  - src/persistence/saga.ts
  - src/persistence/jobs.ts
  - src/index.ts
  - tests/helpers.ts
parent_task_id: TASK-27
priority: high
ordinal: 21500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Outcome & value

Makes **compensation correct under in-instance concurrency**. With M4 parallel/inclusive gateways now executing (L2–L4), a transaction scope can have several live branch tokens at once. When one branch hits a business error routed to a `cancel` end (or an uncaught Hazard, or operator `/cancel`), the engine must reverse-compensate the completed steps across **all** branches — and must not strand or leak a branch that completes *after* cancellation began (a "straggler"). Without this, a parallel saga can leave executed side-effects un-compensated (violating the saga guarantee) or wedge a terminal transition forever.

After this layer ships:
- A parallel transaction whose one branch raises a business error → `cancel` end compensates the completed steps across all branches in **lineage-ordered** reverse.
- A straggler completing **after** cancel still writes its ledger row and is compensated.
- The quiescence barrier holds the terminal status until the ledger is drained **AND** every cohort token is terminal.
- Operator `/cancel` is frontier-wide and does **not** eagerly fail region-cohort jobs (so a late `complete` lands as a straggler, never a leaked side-effect), while still releasing every active broker subscription so no broker key leaks.
- A technical incident on one branch freezes the siblings and leaves the instance `incident` without wedging; operator `/cancel` from there runs the same straggler-catching reverse pass.

## Source of truth (read first)

- Plan: `docs/superpowers/plans/2026-06-13-m4-concurrency.md`, **Phase L5 (lines 2134–2431)**. Implement task-by-task in order; the per-Step code is in the plan — follow it.
- Design (authoritative — **design wins**): `docs/superpowers/specs/2026-06-13-m4-concurrency-design.md`, **§8 (Compensation of parallel branches — L5)**: §8.1 cohort capture & teardown / non-eager operator `/cancel`, §8.2 guaranteed per-token terminator (barrier-hang blocker), §8.3 straggler-ledger-insert in the compensating drive (premature-settle blocker), §8.4 reverse order per causal chain (Principle VI), §8.5 generalised cohort capture. Also §10 (drive serialization / `seq` strict total order) and §5.6 (last-token-out). The §17 roadmap row "M4-L5" is the authoritative scope+blocker list.
- Conventions (plan 13–36): `…Stmt` builders into atomic `dbBatch(...)`; a plain decider-row INSERT in the advance batch is the race claim; keys carry the walk-local occurrence; tests run `EXECUTION_MODE=direct`.

## CRITICAL mode/scope invariant (quote and obey verbatim)

> **Single-token invariant:** every change below is **gated on `graph.regions` being present** (or on `token_id` being non-null). M1–M3 instances have no branch tokens, so the reverse pass behaves **exactly** as today. The existing compensation suite (`loop-compensation`, `saga-operator`, `saga-orchestration`) must stay green throughout.

In practice: `filterLineageQuiesced` is a no-op when `token_id IS NULL`; the non-eager `/cancel` region-abandon path is taken only for region instances (`graph.regions` non-empty) — the single-token (non-region) path **keeps eager `abandonActiveForwardJobs`** (design §8.1). Relaxing `terminateUnleasableJob`'s `compensating` early-return is safe because the atomic `created→failed` claim never regresses a `compensating` instance's status.

Note: `src/durable-objects/job-scheduler.ts` is **re-used as-is** (no code change) — the lease-expiry terminator rides its existing `armTimer`/alarm + the `terminateUnleasableJob` DLQ flow.

## Constituent tasks (work breakdown)

- **L5.1** Carry `token_id` on ledger rows + lineage-quiescence-ordered reverse (blocker 10): thread `tokenId` through `insertSagaStepStmt`/`SagaStepRow`/`SagaStepView`/`mapSagaStep` + the `forward-task.ts` completion call; add `filterLineageQuiesced` (drops steps whose lineage still has a live descendant; `token_id IS NULL` always eligible); apply it in `runCompensation` for region instances; fix the `insertSagaStepStmt` docstring per §10.
- **L5.2** Cohort capture + straggler ledger-insert + quiescence barrier (blockers 8, 9): add `PARALLEL_SAGA_BPMN` fixture (transaction with AND fork/join, each branch a compensatable task, one error-routed to a `cancel` end); add the failing `parallel-compensation.test.ts`; implement `ledgerStragglers` + the ledger-drained-AND-tokens-terminal barrier in `runCompensation` (§8.3).
- **L5.3** Per-token terminators (blocker 8): relax `terminateUnleasableJob`'s `compensating` early-return for cohort jobs (never-leased DLQ alarm must fire → `failed` → token `discarded`); add `failLeasedJobConditional` to `jobs.ts` + the `locked`-cohort lease-expiry terminator branch (re-drive so the straggler scan discards the token); extend the straggler scan to discard cohort tokens whose forward job is now `failed`.
- **L5.4** Operator `/cancel` non-eager region abandon + frontier-wide sweep (§8.1): failing test (late `complete` after `/cancel` must ledger + compensate, not leak); make `handleCancelInstance` region-aware — region instances leave cohort jobs in place with terminators armed and call `releaseActiveSubscriptionsForInstance`, non-region instances keep eager `abandonActiveForwardJobs`.
- **L5.5** Generalised forward-incident cohort capture + L5 gate (§8.5): edge test that a technical incident on one branch leaves the instance `incident` with the sibling frozen (not wedged), then operator `/cancel` runs the straggler-catching reverse over the cohort (should need no new code if L5.1–L5.4 are correct); run the full L5 gate.

## Carried design blockers

- **8** per-token terminators (barrier-hang) · **9** ledger-empty-AND-tokens-terminal quiescence barrier (premature settle) · **10** Principle VI per causal chain (lineage-quiescence-ordered reverse).

**Prerequisite:** L4 (and the L2–L3 token/frontier machinery) merged first.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 L5.1: insertSagaStepStmt/SagaStepRow/SagaStepView/mapSagaStep carry token_id; forward-task completion passes the active token's id; filterLineageQuiesced drops steps whose lineage has a live descendant and is a no-op for token_id IS NULL; the insertSagaStepStmt docstring is corrected to the design §10 wording (deterministic serialized walk-order rank ≡ completion order within a causal chain, not across branches). Regression loop-compensation/saga-orchestration/saga-operator stay green.
- [ ] #2 L5.2: tests/helpers.ts exports PARALLEL_SAGA_BPMN (a bpmn:transaction with an AND fork/join, each branch a compensatable service task with compensation boundary→handler, one branch routable to a cancel end via a business error the sample worker can trigger on demand).
- [ ] #3 L5.2: tests/integration/parallel-compensation.test.ts scenario 1 passes — a business error in one branch reverse-compensates completed steps across all branches (branch A's step ends compensationStatus 'compensated', not stranded), instance status ∈ {compensated, compensationFailed}, and the live-token frontier (active|waiting|arrivedAtJoin) is empty at the terminal.
- [ ] #4 L5.2: ledgerStragglers + the ledger-drained-AND-tokens-terminal quiescence barrier are implemented in runCompensation (§8.3) — a straggler completing after cancel writes its ledger row (INSERT OR IGNORE) and is compensated; the barrier returns 'compensated' only when no scope step needs compensation AND no scope token is live.
- [ ] #5 L5.3: jobs.ts adds failLeasedJobConditional (claims a still-locked job failed at/after lease expiry); terminateUnleasableJob no longer early-returns for compensating cohort instances (never-leased DLQ claim fires) and handles a lease-expired locked cohort job; the straggler scan discards cohort tokens whose forward job is now failed; npx vitest run parallel-compensation + saga-dlq-timeout pass (barrier drains; single-token DLQ unaffected).
- [ ] #6 L5.4: handleCancelInstance is region-aware — region instances skip eager abandonActiveForwardJobs (leave cohort jobs with terminators armed) and call releaseActiveSubscriptionsForInstance, non-region instances keep eager abandon; parallel-compensation gains a scenario where a late complete after /cancel ledgers branchA (saga_steps row exists, not leaked) + compensates; saga-operator stays green.
- [ ] #7 L5.5: parallel-compensation gains the forward-incident edge — a technical incident exhausting one branch's retries leaves status 'incident' with the sibling frozen (no wedge), then operator /cancel drives the cohort to a terminal status ∈ {compensated, compensationFailed, cancelled} (no new code if L5.1–L5.4 are correct).
- [ ] #8 L5 gate: npm run typecheck && npm run test && npm run check:docs all pass; straggler-catching compensation works end to end and the single-token suites (loop-compensation, saga-operator, saga-orchestration) remain green.
<!-- AC:END -->
