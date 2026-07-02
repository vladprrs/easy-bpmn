---
id: TASK-70
title: 'M5-L1: Verification wave — straggler/barrier gates, matrix registry wave, docs/contracts lockstep, real-CF smoke, final-review fix wave'
status: Done
assignee:
  - claude
created_date: '2026-07-02 00:00'
updated_date: '2026-07-02 00:00'
labels:
  - saga
  - bpmn
  - m5
milestone: m-5
dependencies:
  - TASK-69
documentation:
  - docs/superpowers/plans/2026-07-02-m5-l1-embedded-scopes.md
  - docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md
  - specs/002-saga-orchestrator/quickstart.md
priority: high
ordinal: 32600
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer task M5-L1 Tasks 12–15; closes the
milestone and ships PR #4._

Closes out M5-L1: deep-scope straggler/barrier gate tests plus the full-suite no-op gate (M1–M4 tests pass
byte-unedited), the e2e combination-matrix registry wave (adds the M5-L1 must-cover scenarios and rewrites
one M4-inverted scenario), docs/contracts lockstep (`docs/bpmn/09`, openapi, quickstart, `constitution.md`
cross-references), a real-CF workflow-mode smoke test, and — the bulk of this task's weight — the **final
whole-branch review fix wave**: a fresh reviewer ran a full-branch pass (not just per-task), found 2
Critical + 3 Important issues, and a 3-commit fix wave resolved them before the re-review verdict of
"Ready to merge: Yes" and PR #4 was opened.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Deep-scope straggler + live-token barrier gates pass under nesting (Task 12)
- [x] #2 Full M1–M4 suite passes with zero pre-existing test edits (the no-op gate)
- [x] #3 e2e combination-matrix registry gains the M5-L1 must-cover wave + the inverted `C-COMP-NESTEDTX-BRANCH-01` scenario is rewritten (M4 "inner commit survives outer cancel" → M5-L1 commit-shield re-compensates)
- [x] #4 `docs/bpmn/09-easy-bpmn-profile.md` + openapi + quickstart + `data-model.md` are in lockstep with the shipped scope/error/timer semantics
- [x] #5 Real-CF workflow-mode smoke: a nested-commit saga drives inner `committedLocal` → root trip → cancel → ordered undo → terminal `compensated`
- [x] #6 Final whole-branch review: all Critical/Important findings resolved, re-review verdict Ready-to-merge Yes, PR #4 opened
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
**Task 12** `025c770`, review Approved on opus. The gate test itself exposed and forward-fixed a **real
straggler-leak bug**: a stale region-token position on a `subProcess` container caused
`resolveForwardJobForToken` to miss it — fixed via a subtree fallback + `retainStragglerStmts` re-keyed
off `job.element_id` + a `listForwardJobsForInstance` addition in `instances.ts`. Full suite 526/526, a
runtime fix landed inside a planned-test-only task (brief-authorized, surfaced in the PR).

**Task 13** `ced7ff7`, review Approved — matrix rows added verbatim, markers judgment-placed, 5 real reject
tests traced to validator strings. `check:matrix` baseline moved 31→30 per controller adjudication (the
plan's "Expected: PASS" for ~25 never-authored phase-1 test files was unreachable).

**Task 14** `9468d86`, review Approved — all 6 adjudicated plan/implementation divergences verified
accurate against runtime source; the `MAX_SCOPE_DEPTH` docs-check-sync rule confirmed real;
`committedLocal` + the pre-existing-missing `committed` added to the openapi `compensationStatus` enum.

**Task 15 (smoke), no separate commit.** Real-CF GREEN: Worker Version
`4c230c0d-e09a-40ca-970a-587700adb7a4` on bpmn.rntme.com, instance
`pi_92419ac2-5d78-460f-accc-74101238748f` drove NESTED_COMMIT — stepA/stepB → inner commit
(`committedLocal`) → root trip (retryable=false) → cancel end → undoB then undoA (order verified via
history) → terminal **`compensated`**. Local final verification 531/531 + typecheck + check:docs green.
One harmless orphaned prod test instance left (`pi_759bad74-…`, incident).

**Final whole-branch review (fable, range `8c91665..9468d86`): NOT ready on first pass.** Must-fix: **C1**
occurrence-desync on re-entry after an abnormally-skipped scope exit (fixed with a fail-closed validator
reject of scope-reachable-from-its-own-abnormal-boundary-path + a flipped RE_ENTRY regression test, both
host kinds) — `5dd9aa9`; **C2** commit/`exitScope` disarm+marker keyed by the end-element's occurrence
instead of the scope's entry occurrence (2 call sites) — `baaa357`; **I5** openapi `endKind` enum missing
`error` — `54f8af0` (also added a protective drain comment). Re-review verdict: **Ready to merge: Yes**.
539/539 green. PR #4 opened.

**Reviewer-sanctioned follow-up backlog (all filed as TASK-71..74):** the C1 fix leaves a residual dynamic
gap (a condition-guarded loop-back can still re-enter after an abnormal skip) — runtime backstop needed;
drain doesn't release message subscriptions/broker keys; a scope timer can fire on an incident/compensating
instance; a polish sweep of ~10 small triaged items.
<!-- SECTION:FINAL_SUMMARY:END -->
