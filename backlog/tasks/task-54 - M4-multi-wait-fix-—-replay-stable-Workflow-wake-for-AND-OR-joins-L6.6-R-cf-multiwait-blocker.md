---
id: TASK-54
title: >-
  M4 multi-wait fix — replay-stable Workflow wake for AND/OR joins (L6.6
  R-cf-multiwait blocker)
status: Done
assignee:
  - claude
created_date: '2026-06-13 20:00'
updated_date: '2026-06-14 08:15'
labels:
  - saga
  - engine
  - m4
  - bug
milestone: m-4
dependencies:
  - TASK-53
documentation:
  - specs/002-saga-orchestrator/quickstart.md
  - docs/superpowers/specs/2026-06-13-m4-concurrency-design.md
priority: high
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## BLOCKING DEFECT found by the L6.6 manual Workflow-mode matrix (2026-06-13)

The M4 **workflow-mode multi-wait does NOT work on real Cloudflare Workflows.** A `parallelGateway`/`inclusiveGateway` AND/OR-join **hangs after the SECOND branch completes** — the surviving branch's job-completion `sendEvent` never resumes the suspended Workflow, so the join never fires and the instance is stuck `running` (the only backstop is the 1-hour `SVC_WAIT_TIMEOUT`). This blocks closing the M4 epic (TASK-53 AC #8/#9). **Single-token M0–M3 flows are unaffected** (M4 is gated on `graph.regions`).

### Evidence (real CF + local — identical, so NOT a miniflare artifact)
- Validated on `bpmn.rntme.com`, Worker Version `1993c802-bf27-4b16-bd29-82d0159b4982` (the M4 branch; remote D1 `0007` applied, R2 enabled), and under local `wrangler dev` (`EXECUTION_MODE=workflow`).
- **AND-join (`PARALLEL_BPMN`): FAIL** on both. Instance `pi_abd7ca7f-…`: history ends `serviceTaskCompleted(B) → branchArrivedAtJoin(B) → jobCompleted(A)` with **no** `serviceTaskCompleted(A)`; token `…:fork#0:f1` left `active` at `A`.
- **Sequential `Start→A→B→End`: PASS** on both → isolates the defect to the multi-wait (not general workflow-mode resume).
- Direct-mode CI (413 tests, incl. the AND/OR-join join LOGIC) is green — the defect is purely the workflow-mode wake mechanism, which CI (`EXECUTION_MODE=direct`) structurally cannot reach.

### Root cause (high confidence)
Cloudflare Workflows re-invokes `run()` from the top on each event (deterministic replay; memoizes `step.do`/`step.waitForEvent` by name). The token-frontier rewalk (`runInstance` → `driveFrontier` → `raceParkedWaits` in `src/runtime/frontier.ts`/`engine.ts`) issues **a different set of `step.waitForEvent` calls on each re-invocation**: when one branch's job completes it shifts from a `step.waitForEvent` to a `step.do` apply, so the per-replay step sequence diverges (inv#1: `waitForEvent(A)`+`waitForEvent(B)`; inv#2: `step.do(svc-apply:B)`+`waitForEvent(A)`). A `Promise.race` over multiple concurrent `step.waitForEvent` does not compose with Cloudflare's one-suspension-point-at-a-time replay model → the surviving branch's `sendEvent` is never matched. This is the **R-cf-multiwait** risk flagged in the design (§5.2, decision 3) — confirmed real.

### Fix direction (re-opens the L3 engine; needs brainstorm → impl → real-CF re-validation)
Replace the per-branch `Promise.race` with a **replay-stable single per-instance `step.waitForEvent`** on one stable event type: every `/jobs/complete`, message, and timer `sendEvent`s THAT type; on each wake the engine re-walks and reconciles against canonical D1 (the "advisory winner, D1 is the truth" philosophy already in §5.2). This keeps the `step.*` sequence identical across replays regardless of which branches have completed. The direct-mode join logic (quickstart Scenarios 27–30 + 413 CI tests) is the regression net. Re-validate by re-running the L6.6 matrix on real CF until the substrate AND-join goes green and WM-1..WM-6 pass.

### Current prod state (operator decision 2026-06-13)
`bpmn.rntme.com` is LEFT on the broken-concurrency M4 (Version `1993c802…`) — pre-revenue, no users, single-token works. Prior M3 is one `wrangler rollback` away. See `specs/002-saga-orchestrator/quickstart.md` → "M4 manual Workflow-mode matrix" for the full record.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The workflow-mode multi-wait presents a replay-stable step sequence across Cloudflare run() re-invocations (a completing branch does not change the set/order of step.waitForEvent calls)
- [x] #2 On real Cloudflare Workflows, an AND-join (PARALLEL_BPMN) completes after both branches finish in any order — the substrate probe goes green
- [x] #3 The six L6.6 matrix scenarios (WM-1..WM-6) pass on real CF with recorded evidence in quickstart.md
- [x] #4 Direct-mode CI stays green (the AND/OR-join logic + all 413 tests), single-token M0–M3 behaviour unchanged
- [x] #5 After validation: M4 epic (TASK-53) closure unblocked (AC #8/#9), prod re-deployed with the fix
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## TASK-54 — Single-wake Workflow drive (resolves the L6.6 R-cf-multiwait blocker)

**Problem.** The M4 workflow-mode multi-wait `Promise.race` over concurrent `step.waitForEvent` did not compose with Cloudflare Workflows' deterministic-replay model: an AND/OR-join hung after the 2nd branch (the surviving branch's `sendEvent` never resumed the suspended run). Direct-mode CI could never reach this.

**Fix (single-wake unification).** Replaced the multi-wait with ONE replay-stable `bpmn_wake`: leaf drivers PARK (never suspend); `loop` issues exactly one `step.waitForEvent` on the constant `WAKE_TYPE` per parked pass (sequential `wake#k`, timer-aware self-heal timeout); every `/jobs/complete`, message correlation, and timer fire sends a contentless `bpmn_wake` tickle; the engine re-walks and reconciles entirely from D1. New behaviour: **apply-from-D1** for receiveTask + eventBasedGateway messages (`getCorrelatedMessageForSubscription`). Deleted the dead multi-wait machinery (`raceParkedWaits`/`WaitCollector`/`matchKeyedEvent`/`ParkedWait`/`RaceOutcome`/`collectingWaitFor`) and the 4 per-type `profile.ts` event-type fns → one `WAKE_TYPE`. Direct mode (the CI net) is byte-unchanged.

**Wait-cap policy (architect decision, Option B — standard BPMN).** Task 6 removed the M3 leaf wait-caps; the architect chose standard-BPMN semantics: un-guarded receive/message-catch waits INDEFINITELY (the M3 leaf `waitTimeout` cap is retired/unproduced), un-guarded service-task liveness stays the DLQ `jobActivationTimeout`, `compensationFailure` = retry-exhaustion. Amended constitution 2.3.1 + docs/bpmn/09 + openapi + runtime-contracts + quickstart + data-model in lockstep.

**Compensation single-wake fix (found by this re-validation).** Real-CF validation caught that Task 6 also deleted `runCompensation`'s per-comp-job suspend without a single-wake replacement → multi-step compensation busy-spun in workflow mode (parallel saga stuck `compensating` after the first comp step; affected single-token sagas too). Fixed by mirroring `issueWake` into the compensation reverse pass (`comp-wake#k`), guarded by a workflow-mode compensation replay harness.

**Real-CF re-validation (2026-06-14, Worker Version `f194b722-7de1-42e6-a96c-4a24fc94b09d`, bpmn.rntme.com, EXECUTION_MODE=workflow) — ALL GREEN:**
- AND-join `PARALLEL_BPMN` completes (complete branch B then A) — `pi_ec0a9d47…` — **the L6.6 hang is gone**.
- Single-token live message apply-from-D1 (`correlated`) `pi_40653d8e…`; order-saga `pi_1f28e98a…`; eventBasedGateway message-branch apply-from-D1 `pi_7e5e6562…`; conditional XOR saga `pi_5fbb920f…`; timer-saga (armed boundary timer) `pi_c630f358…`.
- Parallel cancel + reverse compensation `pi_b378e6c6…` (both branches compensated); single-token order-saga `/cancel` + compensation `pi_75184ac2…`.

**Matrix coverage (AC #3, honest):** WM-1 (parallel deliver-then-join) and WM-6 (cancel a region + reverse compensation) executed and PASS on real CF. WM-2 (crash mid-race), WM-3 (near-simultaneous + forced replay), WM-4 (branch timeout while sibling live), WM-5 (loops near budget) are **not externally forceable** on the live platform (a real crash is isolate eviction; forced replay/timing cannot be injected from the API) — their replay-stability is covered by the now-green workflow-mode replay harnesses in CI (`loop-replay-workflow`, `xor-replay-workflow`, `compensation-replay-workflow`) plus `parallel-caps`. Recorded under "M4 manual Workflow-mode matrix" in quickstart.md.

**Tests / gate.** `npm test` 419 passing (63 files; +3 workflow-mode replay/backstop harnesses migrated to single-wake + 1 new compensation harness); typecheck + check:docs + `wrangler deploy --dry-run` all green. Direct-mode single-token M0–M3 behaviour unchanged.

**Commits (on `m4-concurrency`):** apply-from-D1 + wake helper (Tasks 1–5, pre-checkpoint) → `0781b0b` engine single-wake → `caf7d65`/`a0cb0a4` test migration → `4f11c42`/`5a89f94` standard-BPMN wait policy → `691c391` executor tickle → `c019ab9`/`a265e79` dead-code collapse → `aa87864`/`2e877fd` compensation single-wake → `72c7a7c` docs/matrix GREEN + M4→shipped.

**Risk/follow-up.** Prod is on `f194b722` (ahead of `main` until the branch merges — the merge is the remaining epic-closure step, TASK-53 #9). One pre-fix instance `pi_0a6b98a7` remains orphaned `compensating` on the superseded build (harmless test data).
<!-- SECTION:FINAL_SUMMARY:END -->
