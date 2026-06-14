---
id: TASK-49
title: >-
  M4-L2: Token foundation — schema, persistence, guard migration, drive
  serialization (no behaviour change)
status: Done
assignee:
  - Vlad Pr
created_date: '2026-06-13 08:54'
updated_date: '2026-06-13 10:37'
labels:
  - saga
  - engine
  - m4
milestone: m-4
dependencies:
  - TASK-48
documentation:
  - docs/superpowers/plans/2026-06-13-m4-concurrency.md
  - docs/superpowers/specs/2026-06-13-m4-concurrency-design.md
modified_files:
  - migrations/0007_tokens.sql
  - src/persistence/tokens.ts
  - src/runtime/frontier.ts
  - src/persistence/drive-lock.ts
  - tests/integration/migration-0007-tokens.test.ts
  - tests/unit/tokens.test.ts
  - tests/integration/token-readmodel.test.ts
  - src/runtime/engine.ts
  - src/runtime/incidents.ts
  - src/runtime/intermediate-timer.ts
  - src/runtime/event-gateway.ts
  - src/runtime/forward-task.ts
priority: medium
ordinal: 21200
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-27** (M4 — Concurrency), milestone `m-4`. Layer task M4-L2; do after M4-L1 (TASK-48)._

## Outcome and value

**Phase L2** of M4 (concurrency). Lays the **token foundation** that L3+ build genuine in-instance concurrency on top of — without yet changing any runtime behaviour. Ships:
- `migrations/0007_tokens.sql`: the `execution_tokens` denormalised read-model, the append-only `join_arrivals`/`join_completions` join-fact tables, and additive columns `gateway_decisions.activated_flow_ids` + `saga_steps.token_id`. Additive over `0006_timers.sql`, IF-NOT-EXISTS / additive-ALTER convention (re-apply is a no-op).
- `src/persistence/tokens.ts`: builders + reads for the read-model and the two join-fact tables, plus replay-stable token-id helpers.
- A **root token materialised lazily**: every M1/M2/M3 instance carries exactly one read-model token at its live cursor after each drive.
- The three correctness-critical scalar `current_element_id` staleness guards migrated to **per-token predicates** (keyed on the per-`(element,occurrence)` row, following the existing `boundary-timer.ts` template).
- A D1-backed **per-instance advisory drive lock** serialising concurrent direct-mode drives (CI harness + production inline-resume) that otherwise race `saga_steps.seq`.

Value: the foundations (schema, persistence, frontier seed, per-token guards, drive serialization) that make multi-token driving in L3 correct and replay-safe — delivered as a verifiable, zero-regression change.

## Mode / scope notes (carry verbatim)

- **No-behaviour-change proof (the layer DoD):** the entire existing test suite stays green — this layer changes no observable behaviour. The full suite passing IS the proof.
- **Scope boundary:** L2 establishes the token *foundation* and migrates the guards. It does **not** drive multiple tokens — the engine still walks one path. Multi-token **driving** (DFS fan-out + multi-wait race) lands in **L3**.
- **Read-model vs facts (blocker 11):** `execution_tokens` (`position_element_id`, `status`) is a DENORMALISED READ-MODEL recomputed by the rewalk each drive for inspection + compensation cohort capture — **NEVER** a replay-decision input. The real replay predicates are the append-only join facts: `join_arrivals` via `INSERT OR IGNORE`, `join_completions` via a PLAIN INSERT in the advance batch (the `gateway_decisions` race discipline). `variables_overlay` is authoritative mutable branch state, made idempotent by the existing `output_applied` marker.
- **Per-token guards (blocker 1):** the three guards currently read scalar `inst.current_element_id`; under concurrency a sibling token may have moved the cursor, so that read is stale. Migrate each to the per-`(element,occurrence)` row predicate (template: `boundary-timer.ts` `planBoundaryTimerFire`). Single-token behaviour identical (one token ⇒ exactly one matching row).
- **Frontier seed (blocker 2):** L2 `reconstructFrontier` is the **single-token derivation** (read the instance; one token at `current_element_id`, or `[]` when terminal). L3 replaces the body with the deterministic DFS. Keeping the L2 body single-token is what makes the read-model byte-identical to today.
- **Drive lock (direct vs workflow mode):** workflow mode is already serialised by the single Workflow. Wrap the drive in the lock **only when `waitFor === null`** (direct mode); leave workflow-mode drives unwrapped. On extreme contention proceed unlocked rather than dropping the drive — `seq` monotonicity is best-effort; the `join_completions`/`saga_steps` unique discipline is the real correctness gate. (`new Date()` is allowed: `drive-lock.ts` runs in the Worker/engine runtime, not a Workflow script.)

## References (read before starting)

- Plan: `docs/superpowers/plans/2026-06-13-m4-concurrency.md`, **Phase L2 (lines 870-1393)**; File Structure (39-84); conventions (13-36). Follow the per-task TDD steps + exact code; do not invent schema/helpers/signatures.
- Design (authoritative): `docs/superpowers/specs/2026-06-13-m4-concurrency-design.md` — §5.3 (per-token guards), §5.4 (splits/joins/append-only facts), §5.5 (token id forms), §8.4 (origin of `saga_steps.token_id`), §10 (drive serialization / direct-mode seq collision), §16 (lock mechanism left open), §17 (layer→blocker roadmap).

## Work breakdown (constituent Task L2.Y items)

- **L2.1** Migration `0007_tokens.sql` + migration test.
- **L2.2** `src/persistence/tokens.ts`: builders, reads, token-id helpers.
- **L2.3** Per-token staleness guards (blocker 1): `parkWaiting`, `planIntermediateCatchFire`, `planEventGatewayTimerFire`.
- **L2.4** Frontier seed + root-token read-model (no behaviour change).
- **L2.5** Per-instance drive lock (direct-mode serialization, design §10).
- **L2.6** L2 layer gate (proof of no behaviour change).

## Carried design blockers

- **1** per-token fire-guards · **2** deterministic frontier seed · **5** write-free fast-forward (extended) · **11** read-model vs facts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 L2.1: tests/integration/migration-0007-tokens.test.ts passes — execution_tokens has its read-model columns (token_id, instance_id, region_id, region_activation, parent_token_id, branch_flow_id, position_element_id, status, variables_overlay, created_at, updated_at); join_arrivals + join_completions exist with composite PKs; gateway_decisions.activated_flow_ids + saga_steps.token_id added; the migration is additive/IF-NOT-EXISTS so re-apply is a no-op.
- [x] #2 L2.2: tests/unit/tokens.test.ts passes — rootTokenId('inst1')==='inst1:#root', branchTokenId('inst1','fork',0,'f1')==='inst1:fork#0:f1', parseTokenId round-trips root+branch (design §5.5); tokens.ts exposes upsert/insert-branch/set-status builders, the join-fact builders (INSERT OR IGNORE arrival, PLAIN INSERT completion), and the token reads.
- [x] #3 L2.3: parkWaiting, planIntermediateCatchFire, planEventGatewayTimerFire no longer read scalar inst.current_element_id — each guards on its per-(element,occurrence) row (job/subscription/timer_outcomes/gateway_decisions) per the boundary-timer.ts template; the redundant cursor guard in event-gateway.ts is deleted; the forward-task.ts parkWaiting caller passes occ. vitest intermediate-timer/event-gateway/wait-cap-incidents/saga-pull-jobs pass.
- [x] #4 L2.4: tests/integration/token-readmodel.test.ts passes — a single-token instance carries exactly one non-consumed root token at its live position with token_id `${id}:#root`; the read-model is synced each drive via reconstructFrontier+syncFrontierReadModel (best-effort, non-fatal); demo-flow/saga-orchestration/loop-rewalk are byte-identical.
- [x] #5 L2.5: drive-lock.ts provides acquire/release/withDriveLock (D1 row=lock, INSERT OR IGNORE acquire, DELETE release, stale-steal after TTL, proceed-unlocked past budget); runInstance wraps the drive in withDriveLock only when opts.waitFor===null (direct mode), workflow mode unwrapped, body renamed runInstanceInner; duplicate-worker-callback/duplicate-message/saga-operator pass.
- [x] #6 No docs/profile/constitution change is introduced in L2 (those flips are L1/L6); npm run typecheck passes after every code change.
- [x] #7 L2 gate (no-behaviour-change proof): npm run typecheck && npm run test && npm run check:docs all pass with ZERO regressions.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execute Phase L2 of docs/superpowers/plans/2026-06-13-m4-concurrency.md (lines 870-1393) verbatim, in order, with TDD. Layer DoD = no behaviour change: full suite stays green.

Subtasks (sequential, dependent):
- L2.1 migrations/0007_tokens.sql (execution_tokens read-model + join_arrivals/join_completions append-only facts + gateway_decisions.activated_flow_ids + saga_steps.token_id; additive/IF-NOT-EXISTS) + tests/integration/migration-0007-tokens.test.ts.
- L2.2 src/persistence/tokens.ts (token-id helpers rootTokenId/branchTokenId/parseTokenId, upsert/insert-branch/set-status builders, join-fact builders INSERT-OR-IGNORE arrival + PLAIN-INSERT completion, reads) + tests/unit/tokens.test.ts.
- L2.3 per-token staleness guards (blocker 1): parkWaiting gains occ + guards on live per-(element,occurrence) job/subscription row (incidents.ts); planIntermediateCatchFire guards on timer_outcomes decider (intermediate-timer.ts); planEventGatewayTimerFire drops redundant cursor guard (event-gateway.ts); forward-task.ts caller passes occ.
- L2.4 frontier seed + root-token read-model (frontier.ts reconstructFrontier single-token + syncFrontierReadModel; engine.ts runInstance syncs read-model best-effort after drive) + tests/integration/token-readmodel.test.ts.
- L2.5 per-instance direct-mode drive lock (drive-lock.ts acquire/release/withDriveLock D1 row-lock; engine.ts wraps runInstanceInner only when opts.waitFor===null).
- L2.6 layer gate: npm run typecheck && npm run test && npm run check:docs, zero regressions.

Approach: recon current signatures first (the plan cites line numbers that may have drifted), then TDD each subtask (write failing test → verify red → minimal impl → verify green), then full gate, then adversarial review. No docs/profile/constitution change in L2.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
L2 implemented in 5 TDD slices on branch m4-concurrency, all committed:
- 5e1c7f0 L2.1 0007_tokens migration (+3 tests)
- 7a03a2a L2.2 tokens.ts persistence (+2 unit tests)
- eca57f0 L2.3 per-token guards (parkWaiting+occ, intermediate-timer timer_outcomes guard, event-gateway cursor-guard delete, forward-task caller)
- 9943cd7 L2.4 frontier.ts seed + read-model sync in runInstance (+1 test)
- cfbe4bc L2.5 drive-lock.ts + runInstance direct-mode wrap (runInstanceInner)

Layer gate (L2.6): npm run typecheck (clean) + npm run check:docs (passed) + npm run test = 382/382 passed (51 files), up from 376 (+6 new L2 tests, ZERO regressions = the no-behaviour-change proof).

Verified deviations from plan's literal code: dropped plan's unused `liveById` map in syncFrontierReadModel (dead code, noUnusedLocals risk); used `rows[0]!` in token-readmodel test for strict noUncheckedIndexedAccess. Drive-lock re-entrancy checked: all runInstance callers (process-workflow workflow-mode/unwrapped, executor.ts, resumeInline←index.ts) are top-level drive entries, none nested → no self-contention/deadlock.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## M4-L2: Token foundation (no behaviour change) — DONE

Phase L2 of the M4 concurrency milestone. Lays the token foundation L3+ build genuine in-instance concurrency on, with **zero observable behaviour change** for existing M1/M2/M3 single-token instances (the layer DoD).

### What shipped (6 commits on branch `m4-concurrency`)
- **L2.1 `migrations/0007_tokens.sql`** — `execution_tokens` denormalised read-model + append-only `join_arrivals` (INSERT OR IGNORE) / `join_completions` (PLAIN INSERT) join-fact tables + additive columns `gateway_decisions.activated_flow_ids` and `saga_steps.token_id`. Additive/IF-NOT-EXISTS over 0006 (re-apply is a no-op). Shape test mirrors migration-0004.
- **L2.2 `src/persistence/tokens.ts`** — replay-stable token-id helpers (`rootTokenId`/`branchTokenId`/`parseTokenId`, design §5.5), read-model builders (upsert/insert-branch/set-status) + reads, and the append-only join-fact builders. (L3-only builders present but unused until L3.)
- **L2.3 per-token staleness guards (blocker 1)** — the three scalar `current_element_id` guards migrated to per-`(element,occurrence)` predicates (boundary-timer.ts template): `parkWaiting` gains `occ` + guards on the live job/subscription row; `planIntermediateCatchFire` guards on the `timer_outcomes` decider; `planEventGatewayTimerFire` drops the redundant cursor guard (gateway_decisions is the sole per-token decider); `forward-task.ts` caller passes `occ`.
- **L2.4 `src/runtime/frontier.ts` + `engine.ts`** — `reconstructFrontier` (single-token seed, L3 replaces with DFS) + `syncFrontierReadModel`; `runInstance` syncs the read-model after every drive, best-effort + non-fatal (never a replay input). Root token materialised lazily.
- **L2.5 `src/persistence/drive-lock.ts` + `engine.ts`** — D1-backed per-instance advisory drive lock (INSERT OR IGNORE acquire, DELETE release, stale-steal after 30s TTL, proceed-unlocked past budget). `runInstance` wraps the body (`runInstanceInner`) only when `opts.waitFor===null` (direct mode); workflow mode stays unwrapped (already serialised by its Workflow).

### Verification
- **Layer gate green, zero regressions:** `npm run typecheck` clean · `npm run check:docs` passed · `npm run test` = **382/382** (51 files), up from 376 pre-L2 (+6 new L2 tests). The full pre-existing suite passing IS the no-behaviour-change proof.
- TDD throughout (RED → GREEN per slice).
- **Recon workflow** (6 agents) verified every dependency signature/call-site before coding — no drift.
- **Adversarial review workflow** (4 dimensions × verify): behaviour-equivalence, drive-lock, persistence-schema, plan-fidelity all returned **0 findings**. One P3 confirmed: my EBG cursor-guard deletion left a stale safety comment in `boundary-timer.ts` (reasoning drift, not a behaviour bug — late post-cancel alarms are stopped by `fireTimer` `status!='armed'` + terminal checks). Fixed in commit 7th.
- Drive-lock re-entrancy/deadlock checked: all `runInstance` callers are top-level drive entries (Workflow driver unwrapped, `executor.ts`, `resumeInline`←`index.ts`); none nested.

### Deviations from the plan's literal code (both verified harmless)
- Dropped the plan's unused `liveById` map in `syncFrontierReadModel` (dead code; `noUnusedLocals` risk).
- Used `rows[0]!` in `token-readmodel.test.ts` for strict `noUncheckedIndexedAccess`.

### Scope boundary (intentional)
L2 establishes the foundation only — it does NOT yet drive multiple tokens. Multi-token DFS fan-out + multi-wait race lands in L3 (TASK-50). The L3-only persistence builders/`Token` fields ship now but are unused.

### Follow-up
- Branch `m4-concurrency` should remain open for L3 (TASK-50) to build on; do not merge to main until the milestone integrates.
- The drive-lock's `drive_locks` table is created lazily (not in a migration) per design §16's open-mechanism choice; only direct-mode/operator-resume touches it (prod runs workflow mode = unwrapped).
<!-- SECTION:FINAL_SUMMARY:END -->
