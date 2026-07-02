---
id: TASK-28
title: >-
  EPIC M5 (optional) — Composition (callActivity, multi-instance, subprocess,
  signal/escalation)
status: To Do
assignee: []
created_date: '2026-06-08 08:18'
labels:
  - epic
  - saga
  - bpmn
milestone: m-5
dependencies: []
references:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§8 M5)
  - docs/bpmn/02-activities.md
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/02-activities.md
priority: low
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Optional epic placeholder for milestone M5 (design §8) — the remaining 'full BPMN' pieces, demand-driven: bpmn:callActivity (reusable sub-saga), nested non-transaction subProcess, multiInstance (parallel over a collection, each instance compensated), and signal/escalation events. Target semantics: docs/bpmn/02-activities.md. Sliced only if a concrete need appears after M4.

**M5-L1 status (2026-07-02):** the demand appeared and M5 was sliced into 5 layers (L1 embedded scopes/
exceptions · L2 callActivity risk-apex · L3 multiInstance · L4 escalation · L5 signal — decomposition on
`docs/superpowers/specs/2026-06-20-m5-composition-design.md`). **L1 (embedded scopes + hierarchical
exceptions) has SHIPPED** via PR #4 (branch `m5-l1-embedded-scopes`): plain `subProcess` scopes, scope-aware
compensation (two-tier `committedLocal`/`committed` shield, root-relative reverse pass), hierarchical error
bubbling + boundaries + error end event (`uncaughtError` incident), and Hazard-vs-Cancel timer boundaries
on scopes. Constitution amended to **v2.5.0** to cover the full five-layer M5 set. Backlog: TASK-64..70
(Done). Follow-ups from the final-review fix wave: TASK-71 (runtime re-entry backstop for a residual
guarded-loop-back gap), TASK-72 (drain doesn't release message subscriptions/broker keys), TASK-73 (armed
scope timer can fire on an incident/compensating instance), TASK-74 (polish sweep). **L2 (callActivity) is
next.**
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Implemented only if a concrete product need appears; otherwise remains an explicitly-deferred option.
- [ ] #2 If pursued, a follow-up spec/plan slices it into concrete tasks with integration tests (reusable sub-saga invoked; multi-instance fan-out compensates each instance).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Deferred/optional epic. Revisit after M4; slice into tasks only on concrete demand.
<!-- SECTION:PLAN:END -->
