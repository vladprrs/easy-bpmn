---
id: TASK-69
title: 'M5-L1: Timer boundaries on scopes — Hazard-vs-Cancel interrupt-without-compensation'
status: Done
assignee:
  - claude
created_date: '2026-07-02 00:00'
updated_date: '2026-07-02 00:00'
labels:
  - saga
  - engine
  - m5
milestone: m-5
dependencies:
  - TASK-68
documentation:
  - docs/superpowers/plans/2026-07-02-m5-l1-embedded-scopes.md
  - docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md
priority: high
ordinal: 32500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer task M5-L1 Task 11._

Extends M3's interrupting boundary timers to plain `subProcess` scopes: a timer boundary is **armed at
scope entry** and **disarmed at every exit** (normal completion, error bubbling, another timer firing).
The key M5-L1 semantic decision is **Hazard, not Cancel**: an interrupting scope timer fires as a
technical incident that interrupts the scope **without triggering compensation** — the completed steps
inside stay in the ledger untouched (a deferred, idempotent subtree drain), and only a later operator
`/cancel` drives the reverse pass over them. Nested scope timers under an ancestor's own drain needed an
explicit disarm to avoid a stale-timer race.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A timer boundary on a plain `subProcess` scope arms at scope entry
- [x] #2 The timer disarms at every scope exit path (normal completion, error bubbling, sibling timer firing)
- [x] #3 An interrupting scope timer fires as a Hazard (technical incident) that interrupts the scope WITHOUT compensating the completed steps inside it
- [x] #4 The subtree drain triggered by a timer fire is deferred and idempotent
- [x] #5 A nested scope timer is disarmed when an ancestor scope drains (no stale-timer race)
- [x] #6 `tests/integration/scope-nested-timer-drain.test.ts` covers the nested-timer-under-ancestor-drain gap
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Commit `bde29ee` (timer boundaries on scopes — arm at entry, disarm at every exit, interrupt-without-
compensation fire) + fix `b848b70`, review Approved after one fix loop on opus: an Important
nested-scope-timer-under-ancestor-drain gap was closed at both ends — `settleDrainedScopeTimer` added
inside `drainScopeSubtree`, plus a plan-time `ancestorScopeExitedAfterEntry` guard. New
`tests/integration/scope-nested-timer-drain.test.ts` (2 tests). Full suite after the fix: integration 227,
unit 231, typecheck clean.

**Minor follow-ups (final-review triage, non-blocking, folded into TASK-74):** the subProcess-host runtime
fire/disarm path is only validator-accept-tested, not integration-tested (transaction-host is); the scope-
timer fire batch doesn't supersede the inner live wait (a deferred-drain window, asymmetric vs the M3
`receiveTask` host — comment-worthy); `drainScopeSubtree` settles descendant timers post-drain
non-atomically (documented, safe via the ancestor-exit guard); the drain excludes task-hosted descendant
timers (pre-existing-safe M3 behavior, worth a protective comment); one nested-timer test simulates the
fired-first race via direct DB mutation rather than a real race.
<!-- SECTION:FINAL_SUMMARY:END -->
