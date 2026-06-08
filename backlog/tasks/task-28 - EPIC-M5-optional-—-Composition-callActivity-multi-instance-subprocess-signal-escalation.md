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
