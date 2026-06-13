---
id: TASK-52
title: 'M4-L5: Compensation of parallel branches (straggler-catching)'
status: Done
assignee:
  - Vlad Pr
created_date: '2026-06-13 08:56'
updated_date: '2026-06-13 14:45'
labels:
  - saga
  - engine
  - m4
milestone: m-4
dependencies:
  - TASK-51
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
priority: high
ordinal: 21500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-27** (M4 — Concurrency), milestone `m-4`. Layer task M4-L5; do after M4-L4 (TASK-51)._

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
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 L5.1: insertSagaStepStmt/SagaStepRow/SagaStepView/mapSagaStep carry token_id; forward-task completion passes the active token's id; filterLineageQuiesced drops steps whose lineage has a live descendant and is a no-op for token_id IS NULL; the insertSagaStepStmt docstring is corrected to the design §10 wording (deterministic serialized walk-order rank ≡ completion order within a causal chain, not across branches). Regression loop-compensation/saga-orchestration/saga-operator stay green.
- [x] #2 L5.2: tests/helpers.ts exports PARALLEL_SAGA_BPMN (a bpmn:transaction with an AND fork/join, each branch a compensatable service task with compensation boundary→handler, one branch routable to a cancel end via a business error the sample worker can trigger on demand).
- [x] #3 L5.2: tests/integration/parallel-compensation.test.ts scenario 1 passes — a business error in one branch reverse-compensates completed steps across all branches (branch A's step ends compensationStatus 'compensated', not stranded), instance status ∈ {compensated, compensationFailed}, and the live-token frontier (active|waiting|arrivedAtJoin) is empty at the terminal.
- [x] #4 L5.2: ledgerStragglers + the ledger-drained-AND-tokens-terminal quiescence barrier are implemented in runCompensation (§8.3) — a straggler completing after cancel writes its ledger row (INSERT OR IGNORE) and is compensated; the barrier returns 'compensated' only when no scope step needs compensation AND no scope token is live.
- [x] #5 L5.3: jobs.ts adds failLeasedJobConditional (claims a still-locked job failed at/after lease expiry); terminateUnleasableJob no longer early-returns for compensating cohort instances (never-leased DLQ claim fires) and handles a lease-expired locked cohort job; the straggler scan discards cohort tokens whose forward job is now failed; npx vitest run parallel-compensation + saga-dlq-timeout pass (barrier drains; single-token DLQ unaffected).
- [x] #6 L5.4: handleCancelInstance is region-aware — region instances skip eager abandonActiveForwardJobs (leave cohort jobs with terminators armed) and call releaseActiveSubscriptionsForInstance, non-region instances keep eager abandon; parallel-compensation gains a scenario where a late complete after /cancel ledgers branchA (saga_steps row exists, not leaked) + compensates; saga-operator stays green.
- [x] #7 L5.5: parallel-compensation gains the forward-incident edge — a technical incident exhausting one branch's retries leaves status 'incident' with the sibling frozen (no wedge), then operator /cancel drives the cohort to a terminal status ∈ {compensated, compensationFailed, cancelled} (no new code if L5.1–L5.4 are correct).
- [x] #8 L5 gate: npm run typecheck && npm run test && npm run check:docs all pass; straggler-catching compensation works end to end and the single-token suites (loop-compensation, saga-operator, saga-orchestration) remain green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Verified implementation plan (reconciled against current code)

Source of truth: plan §L5 (2134–2431) + design §8/§10. An evidence-map across the 8 touched files
confirmed most assumptions and surfaced concrete gaps the literal plan does NOT cover. Approach = follow
the plan task-by-task (L5.1→L5.5), TDD (failing test first), `…Stmt` builders into `dbBatch`, gated on
`graph.regions` so M1–M3 single-token behaviour is byte-identical. **No new migration** — `saga_steps.token_id`
already exists (0007:57).

### Confirmed
- `applyForwardCompletion(activeTokenId?)` already threaded (forward-task.ts:384); only the hop into the
  insert is missing. `getForwardJobByElement` (instances.ts:336, occ-unaware, ORDER BY occurrence DESC) is
  exactly the token→job lookup `ledgerStragglers` needs. `JobRow` carries input/output/occurrence/status/
  lock_expires_at. `setTokenStatusStmt` is a batch builder. DirectExecutor.deliverJobResult→resumeInline
  re-drives a `compensating` instance (executor.ts:157-169, confirmed by comment). JobScheduler `arm(jobId,when)`
  → alarm → `terminateUnleasableJob` (job-scheduler.ts:28,45). A region branch token's `position_element_id`
  stays at its fan-out entry element (region graphs skip the read-model sync, engine.ts:214) → for single-
  service-task branches position == the service task; `arrivedAtJoin`/failed-routed tokens keep that position.

### Gap-fixes (deviations from the literal plan, all consistent with design §8)
- **G2** no `countScopeStepsNeedingCompensation` → use `(await selectScopeStepsForCompensation(...)).length` (already scope-scoped).
- **G3/R1** jobs carry no token_id → `ledgerStragglers` maps each live in-scope token via `getForwardJobByElement(token.position)`; occurrence read from the job row.
- **G4** `getExecutorReDrive` doesn't exist + static `import {resumeInline} from "./engine"` in forward-task.ts would create engine↔forward-task cycle → use **dynamic** `await import("./engine")` inside the locked-cohort branch.
- **G5** `failLeasedJobConditional` new in jobs.ts; match the `failExpiredLeaseConditional` shape (clear lock_token+lock_expires_at+worker_id; guard `status='locked'`).
- **G6** `JobByIdRow`+`getJobRowById` gain `lock_expires_at`; restructure `terminateUnleasableJob` so the locked-cohort branch runs BEFORE the `created`+attempt0 guard; only delete the `|| compensating` clause from the created-path (saga-dlq-timeout instance is `running` → unaffected).
- **G7** author `releaseActiveSubscriptionsForInstance` (list active message_subscriptions for the instance, best-effort broker supersede, mark superseded).
- **G8** import `loadGraphForInstance` into index.ts.
- **G9/G10/R3** author `PARALLEL_SAGA_BPMN` (transaction wrapping AND fork/join, each branch one compensatable service task with compensation boundary→handler, branch-b error-routed to a cancel end) + add sample workers `branch-a|branch-b|comp-a|comp-b` to service-task.ts honouring `failBranchB` (business errorCode) / `hazardBranchB` (technical exhaustion).
- **EMPTY-LEDGER (new, required for AC#6)**: at operator `/cancel` of a region instance the ledger is empty (A leased-not-completed, B never leased) → the current empty-ledger fast-path goes terminal `cancelled`, so the late complete no-ops and LEAKS. Fix: a region instance with live cohort tokens enters `compensating` (not `cancelled`) so the straggler is caught (design §8.1/§8.3).
- **R5** the lease-expiry alarm + locked-cohort terminator + L5.1 "park on terminators" are Workflow/alarm paths → correct-for-production, exercised only by the manual matrix (vitest is direct-mode). Flagged for the DoD manual gate.

### runCompensation barrier (combined L5.1+L5.2), region-gated:
```
while(true):
  if (graph.regions) await ledgerStragglers(env, id, graph, scopeId)   // §8.3 scan: completed→ledger+consume, failed→discard, arrivedAtJoin→consume, no-job→discard, created/locked→leave live
  steps = selectScopeStepsForCompensation(...)
  live  = graph.regions ? listLiveTokens(id) : []
  if (steps.length===0) return live.length===0 ? "compensated" : "waiting"   // §8.3 ledger-drained AND tokens-terminal
  eligible = filterLineageQuiesced(steps, live)                              // §8.4 no-op when token_id NULL
  if (eligible.length===0) return "waiting"                                  // blocked by a live descendant → park
  step = eligible[0]   // highest seq among eligible
  …existing comp-create/comp-done/comp-fail/wait on step…
```
Single-token: `live=[]`, `ledgerStragglers` skipped, `filterLineageQuiesced` returns steps unchanged ⇒ byte-identical.

### Task order (commit per task)
- **L5.1** token_id on insertSagaStepStmt/Row/View/mapSagaStep + pass `tokenId: activeTokenId ?? null`; `filterLineageQuiesced` in saga.ts; docstring §10 fix. Regression: loop-compensation/saga-orchestration/saga-operator.
- **L5.2** `PARALLEL_SAGA_BPMN` + workers; failing `parallel-compensation.test.ts` scenario 1; `ledgerStragglers` + barrier.
- **L5.3** `failLeasedJobConditional`; `JobByIdRow.lock_expires_at`; restructure `terminateUnleasableJob` (locked-cohort branch + drop compensating clause); `ledgerStragglers` failed→discard; arm lease-expiry terminators on entering compensating. Run parallel-compensation + saga-dlq-timeout.
- **L5.4** region-aware `handleCancelInstance` (skip eager abandon + `releaseActiveSubscriptionsForInstance` + empty-ledger→compensating); late-complete-after-cancel test. saga-operator stays green.
- **L5.5** forward-incident edge test (incident→/cancel→reverse). Full L5 gate: `npm run typecheck && npm run test && npm run check:docs`.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
L5.1 done & committed (28b7a4a): saga_steps.token_id threaded through insertSagaStepStmt/Row/View/mapSagaStep + applyForwardCompletion; filterLineageQuiesced added (no-op when token_id NULL); §10 docstring fixed. No migration (0007 already added the column). Regression green: loop-compensation+saga-orchestration+saga-operator 14/14. filterLineageQuiesced is applied in the L5.2 barrier (kept compensation.ts in one coherent commit).

L5.2 done & committed (3655ff3). DEVIATION on AC#2/fixture: the SESE region validator (design §4.1 rules 4/5) REJECTS a branch boundary that escapes the region to a cancel end ('Concurrent split fork has no matching join') — the plan's literal 'one branch routed to a cancel end' is un-publishable. Faithful valid realization: region fork↔join stays balanced; a POST-JOIN `settle` task carries the error boundary → cancel end (the SAGA_XOR pattern, branches concurrent). Both branch steps still compensate across the cohort; the live produced root token at `settle` is what ledgerStragglers discards. AC#2 met in spirit (worker-triggerable business-error→cancel→compensation parallel saga); AC#3 scenario-1 green. ledgerStragglers+barrier implemented (AC#4 mechanism; straggler-after-cancel verified in L5.4).

L5.3 done & committed (f06f53a): failLeasedJobConditional + JobByIdRow.lock_expires_at + listLockedForwardJobs; terminateUnleasableJob restructured (locked-cohort lease-expiry branch w/ dynamic resumeInline import to dodge the engine<->forward-task cycle; created-path no longer early-returns for compensating); armCohortLeaseExpiryTerminators on entering compensating. AC#5 gate 6/6 (saga-dlq-timeout unaffected). L5.4 done & committed (e850636): region-aware handleCancelInstance — skip eager abandon, releaseActiveSubscriptionsForInstance, and route live-cohort empty-ledger cancels to 'compensating' (the plan-gap fix) instead of terminal 'cancelled' so a late complete is caught. AC#4/#5/#6 met. parallel-compensation+saga-operator 9/9.

L5.5 done & committed (715079b): forward-incident edge (hazardBranchB → whole-instance 'incident' with sibling frozen; operator /cancel → straggler-catching reverse). Needed NO new code beyond L5.1–L5.4 (as the plan predicted). FULL L5 GATE GREEN: npm run typecheck clean, npm run check:docs passed, npm run test = 402/402 across 56 files. AC#7/#8 met. Commits 28b7a4a, 3655ff3, f06f53a, e850636, 715079b on m4-concurrency. Running an adversarial multi-agent review of the diff before final close (project 'review fixes folded in' pattern).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## M4-L5 — Compensation of parallel branches (straggler-catching) — DONE

Makes saga compensation correct under in-instance concurrency: a transaction with live branch tokens now reverse-compensates completed steps across **all** branches, never strands/leaks a "straggler" that completes after cancellation, and holds the terminal until the ledger is drained **AND** every cohort token is terminal. All 8 ACs met; full gate green (`typecheck` + `check:docs` + **402/402** tests across 56 files). Single-token M1–M3 compensation is behaviourally unchanged (everything gated on `graph.regions`).

### What shipped (7 commits on `m4-concurrency`)
- **L5.1 `28b7a4a`** — `saga_steps.token_id` threaded through `insertSagaStepStmt`/`SagaStepRow`/`SagaStepView`/`mapSagaStep` + `applyForwardCompletion`; new `filterLineageQuiesced` (lineage-quiescence reverse order, §8.4 / Principle VI — no-op when `token_id` NULL); §10 docstring fix. No migration (0007 already added the column).
- **L5.2 `3655ff3`** — `PARALLEL_SAGA_BPMN` fixture + sample workers (`branch-a/branch-b/comp-a/comp-b/branch-settle`); `ledgerStragglers` (region-gated cohort scan: completed→ledger+consume, failed→discard, no-job→discard, in-flight→leave for the terminator) + the ledger-drained-AND-tokens-terminal quiescence barrier in `runCompensation` (§8.3).
- **L5.3 `f06f53a`** — `failLeasedJobConditional` + `listLockedForwardJobs` + `JobByIdRow.lock_expires_at`; `terminateUnleasableJob` restructured (locked-cohort lease-expiry branch via a dynamic `import("./engine")` to avoid the engine↔forward-task cycle; created-path no longer early-returns for a compensating instance); `armCohortLeaseExpiryTerminators` on entering compensating (§8.2, blocker 8).
- **L5.4 `e850636`** — region-aware `handleCancelInstance`: skip eager `abandonActiveForwardJobs`, `releaseActiveSubscriptionsForInstance`, and route live-cohort empty-ledger cancels to `compensating` (not terminal `cancelled`) so a late complete is caught (§8.1).
- **L5.5 `715079b`** — forward-incident edge test (technical Hazard → whole-instance `incident`, sibling frozen, no wedge; `/cancel` → straggler-catching reverse). Needed no new code beyond L5.1–L5.4.
- **Review `e0d1f6d`** — adversarial 28-agent diff review; folded two confirmed findings: (CRITICAL) `/cancel` graph-load no longer silently degrades a region instance to the unsafe eager-abandon path; (MEDIUM) `releaseActiveSubscriptionsForInstance` is now per-subscription best-effort so a broker/D1 hiccup can't strand the cancel.

### Deviations from the literal plan (design wins; documented in notes)
1. **Fixture cancel trigger is post-join, not in-branch.** The SESE region validator (design §4.1 rules 4/5) rejects a branch boundary that escapes the region to a cancel end ("Concurrent split fork has no matching join"), so the plan's literal "one branch routed to a cancel end" is un-publishable. The valid faithful shape keeps `fork↔join` balanced and puts the error boundary on a post-join `settle` task — both branches still ledger + compensate across the cohort, and the live produced root token at `settle` is what `ledgerStragglers` discards.
2. **Region empty-ledger `/cancel` → `compensating`.** The pre-existing empty-ledger fast-path went terminal `cancelled`; for a region instance with live cohort tokens that would make a late complete a 0-row no-op and leak the side-effect. Region instances now enter `compensating` and the quiescence barrier holds.
3. Implementation gaps the plan assumed away, all resolved: `getForwardJobByElement` for the token→job map (jobs carry no `token_id`), `(await selectScopeStepsForCompensation).length` instead of a non-existent `countScopeStepsNeedingCompensation`, dynamic `import` for the re-drive (static would cycle).

### Risks / follow-ups
- **Untested-in-CI (manual matrix):** the lease-expiry alarm fire + the locked-cohort `terminateUnleasableJob` branch + the L5.1 "park on terminators" path are Workflow/alarm-driven; vitest is `EXECUTION_MODE=direct` with far-future lease/activation TTLs, so they are correct-for-production but exercised only by the L6 manual matrix (design R5). Worth an explicit manual-validation line in the L6 closure.
- `ledgerStragglers` assumes single-service-task branches (region read-model keeps a branch token's position at its fan-out entry); multi-element branches would need position tracking — out of M4-L5 scope, fine for the current profile.
<!-- SECTION:FINAL_SUMMARY:END -->
