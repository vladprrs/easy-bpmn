---
id: TASK-74
title: 'M5-L1 follow-up: polish sweep — triaged Minor findings from the per-task and final-branch reviews'
status: To Do
assignee: []
created_date: '2026-07-02 00:00'
updated_date: '2026-07-02 00:00'
labels:
  - saga
  - engine
  - bpmn
  - m5
  - follow-up
  - chore
milestone: m-5
dependencies:
  - TASK-70
documentation:
  - .superpowers/sdd/progress.md
priority: low
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Follow-up from the M5-L1 per-task and final whole-branch reviews (PR #4). A bundle of small, independent,
non-blocking triage items — none needed a dedicated task, but they were all explicitly deferred rather
than dropped._

### Comments/dead-code hygiene
- **T9:** stale comment in `forward-task.ts:150-153` understates guard suppression (it says only abnormal
  exits suppress; normal exits do too).
- **T9:** stale `selectScope*` comments in `compensation.ts:133` / `:168`.
- **T9:** import-grouping nit in `forward-task.ts`.
- **T14:** `graph.ts` doc comment still says "boundaryEvent only" (stale since Task 10's dangling-`errorRef`
  fix).
- **T1:** `.specify/templates/plan-template.md` gate prose still enumerates M1–M4 only — extend to M5.

### Test coverage gaps flagged but not required for gate
- **T9:** the heal branch (`audited===0`) in `appliedForwardOutcome`'s idempotent re-drain has no direct
  test (it's seedable in direct mode).
- **T9:** no reachability-inside-`subProcess` validator test.
- **T12:** directed test for the non-cancel-exit fallback path in `drainScopeSubtree`'s
  `resolveForwardJobForToken` (currently rests on the symmetry argument + full-suite green).

### Small correctness/robustness hardening (not bugs, but should be tightened)
- **T2:** `regions.ts` `RegionInput.scopeKind` should gain `"subProcess"` as a literal option and drop the
  call-site cast currently working around its absence.
- **T12:** the `drainScopeSubtree` fallback `.find` picks the most-recent job with no liveness filter —
  correct today under the SESE single-branch invariant, but silently wrong if that invariant is ever
  violated. Prefer a loud assert over silent selection.
- **T9:** `countScopeStepsNeedingCompensation`-equivalent currently does `(await
  selectScopeStepsForCompensation(...)).length` — should be a `COUNT(*)` query instead of materializing
  rows just to count them.
- **T11:** the scope-timer-exit drain's applied-marker check should be a guard (assert/early-return), not
  implicit.
- **T9:** `retainStragglerStmts`'s `?? ""` scope fallback would silently orphan a row if it were ever hit —
  prefer an assert.

### Drift/consistency
- **T13:** `scripts/check-matrix.mjs`'s `rows.length !== 60` sanity warn is now permanently stale (the
  registry is 71 rows after the M5-L1 wave) — update the literal.
- **T14 / final review I5 follow-on:** openapi `boundaryKind` enum is missing `timer` (pre-existing M3
  drift, unrelated to M5-L1 but surfaced during the endKind fix).
- **T11:** protective comment explaining why `drainScopeSubtree` deliberately excludes task-hosted
  descendant timers (pre-existing-safe M3 behavior) — without the comment a future pass may "fix" this
  incorrectly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All listed stale/inaccurate comments corrected (forward-task.ts, compensation.ts, graph.ts, plan-template.md)
- [ ] #2 New targeted tests added for the 3 listed coverage gaps (heal branch, reachability-inside-subProcess, T12 non-cancel-exit fallback)
- [ ] #3 `regions.ts` `RegionInput.scopeKind` gains `"subProcess"`; the compensating call-site cast is removed
- [ ] #4 `drainScopeSubtree`'s fallback `.find` gets a liveness assert instead of silent most-recent selection
- [ ] #5 The ledger-step counting helper uses `COUNT(*)` instead of materializing + counting rows
- [ ] #6 `retainStragglerStmts`'s `?? ""` fallback is replaced with an assert
- [ ] #7 `scripts/check-matrix.mjs` sanity-warn literal updated to the current registry row count
- [ ] #8 openapi `boundaryKind` enum gains `timer`
- [ ] #9 Full suite + typecheck + check:docs + check:matrix stay at their current baseline (no new regressions)
<!-- AC:END -->
