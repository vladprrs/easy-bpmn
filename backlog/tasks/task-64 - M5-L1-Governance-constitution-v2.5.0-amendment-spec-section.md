---
id: TASK-64
title: 'M5-L1: Governance — constitution v2.5.0 amendment + constitution check + spec section'
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
dependencies: []
documentation:
  - .specify/memory/constitution.md
  - specs/002-saga-orchestrator/m5-L1-constitution-check.md
  - specs/002-saga-orchestrator/spec.md
  - docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md
priority: high
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer task M5-L1 Task 1; opens the milestone._

Opens the M5-L1 (embedded scopes + hierarchical exceptions) work by cutting the work branch from `main`
(after merging the `m5-composition-design` decomposition doc), amending the governance constitution to
v2.5.0 to accept the L1 construct set (plain `subProcess` scopes, scope-aware compensation, error
end/bubbling, scope timers), running the Spec Kit constitution check, and adding the M5-L1 spec section
to `specs/002-saga-orchestrator/spec.md`. This is the governance gate every subsequent task builds on.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Work branch `m5-l1-embedded-scopes` cut from `main` after merging the `m5-composition-design` doc (merge commit `8c91665`)
- [x] #2 `.specify/memory/constitution.md` amended to v2.5.0, accepting the L1 construct set with a Sync Impact Report
- [x] #3 `specs/002-saga-orchestrator/m5-L1-constitution-check.md` records the pre-Phase-0 constitution check
- [x] #4 `specs/002-saga-orchestrator/spec.md` gains the M5-L1 section
- [x] #5 `docs/bpmn/09-easy-bpmn-profile.md` "Still deferred" table updated for consistency with the new accepted set
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Governance opened cleanly: constitution bumped to v2.5.0 accepting plain embedded `subProcess` scopes,
scope-aware compensation, hierarchical error bubbling/boundaries, error end events, and scope timers.
Constitution check + spec section landed alongside.

**Commit:** `89c5d05` (docs(m5-l1): constitution v2.5.0 — accept the M5 composition set; L1 constitution
check + spec section), merged to `main` as `8c91665`. Review clean/Approved.

**Minor findings (final review triage, non-blocking):** the `09`-profile "Still deferred" table was
touched beyond the literal "interim markers only" instruction (judged a justified consistency fix); the
Sync Impact Report's Principle IV wording ("message invariant marked verbatim") drifted slightly from the
brief's "additively extended — message invariant unchanged" (cosmetic); `.specify/templates/plan-template.md`
gate prose still enumerates M1–M4 only (implementer-flagged, deferred — folded into TASK-74).
<!-- SECTION:FINAL_SUMMARY:END -->
