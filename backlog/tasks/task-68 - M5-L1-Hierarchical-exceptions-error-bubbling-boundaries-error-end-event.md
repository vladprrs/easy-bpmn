---
id: TASK-68
title: 'M5-L1: Hierarchical exceptions — error bubbling, error boundaries on scopes, error end event + uncaughtError'
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
  - TASK-67
documentation:
  - docs/superpowers/plans/2026-07-02-m5-l1-embedded-scopes.md
  - docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md
priority: high
ordinal: 32400
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer task M5-L1 Tasks 9–10._

Extends M3's free error routing to scope hierarchies: a business/technical error raised inside a nested
scope now **bubbles** up the attachment chain (walk the ancestor scopes looking for an error boundary) if
the immediate scope has no matching boundary, driving an abnormal-exit drain of the raising scope's
subtree as it goes. Adds error boundaries directly on plain `subProcess` scopes (not just transactions).
Adds the standard BPMN **error end event** — publishing it is accepted, throwing it inside a scope bubbles
like any other error, and an error that reaches the process root with no boundary to catch it becomes a
new `uncaughtError` incident kind.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 An error raised in a nested scope walks the attachment chain (ancestor scopes) looking for a matching error boundary
- [x] #2 Error boundaries are accepted on plain `subProcess` scopes, not only `bpmn:transaction`
- [x] #3 An unmatched bubbling error drives an abnormal-exit drain of the raising scope's subtree
- [x] #4 Error end event: publish acceptance + throw semantics + bubbling like any other error
- [x] #5 An error reaching the process root uncaught becomes a new `uncaughtError` incident kind
- [x] #6 A crashed-away scope-exit drain self-heals: `appliedForwardOutcome` re-drains idempotently, `scopeExited` audit existence-guarded
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
**Task 9** `ef5e497` + fix `73aa8b4` (hierarchical error bubbling — attachment-chain walk, error boundaries
on scopes, abnormal-exit drain), review Approved after one fix loop: a replay-hole Important finding
(a crash mid-drain could leave the scope-exit un-applied) was fixed via idempotent re-drain in
`appliedForwardOutcome` + an existence guard on the `scopeExited` audit row.

**Two adjudicated divergences from the plan (surfaced in the PR):** (1) `beginCompensating` stamps the
*transaction's* entry occurrence (walk-local `scopeEntryOcc` map), not the cancel-end's — the plan's
literal instruction breaks gate-4 re-entry; (2) empty-ledger `/cancel` `liveCohort` kept `isRegion`-gated
— the plan's "unfiltered" version regressed 4 legacy tests, so the no-op-gate invariant outranked it.

**Task 10** `fdc2759` (error end event — publish acceptance, scope throw + bubbling, `uncaughtError`
incident kind), review Approved, **zero findings**. The implementer reported and ignored a
prompt-injection-style instruction pressuring an out-of-scope `graph.ts` edit; the reviewer independently
verified `graph.ts` was untouched. Bonus fix: a real pre-existing dangling-`errorRef` bug (boundary-event-
only match) was fixed additively.

**Minor follow-ups (non-blocking, triaged into TASK-74):** stale comments in `forward-task.ts:150-153`
understating guard suppression; no direct test for the heal branch (`audited===0`); a new
forward-task↔compensation circular import (function-body-only, safe today); several stale/inaccurate
comments in `compensation.ts` and `graph.ts`.
<!-- SECTION:FINAL_SUMMARY:END -->
