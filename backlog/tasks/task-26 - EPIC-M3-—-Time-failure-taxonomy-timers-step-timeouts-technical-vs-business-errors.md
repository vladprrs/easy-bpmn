---
id: TASK-26
title: >-
  EPIC M3 — Time & failure taxonomy (timers, step timeouts,
  technical-vs-business errors)
status: To Do
assignee: []
created_date: '2026-06-08 08:18'
labels:
  - epic
  - saga
  - engine
  - runtime
milestone: m-3
dependencies: []
references:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§8 M3
  - §4.5
  - §9
  - §5 timers stub)
  - docs/bpmn/01-events.md
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/01-events.md
priority: medium
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Epic placeholder for milestone M3 (design §8). Add a timers table (boundary timer, per-step timeout, event deadline) driven by step.sleep / DO alarms; a technical-vs-business error catalog; configurable timeout behavior (incident / alternate BPMN path / compensation); and optionally a per-model configurable buffer TTL (today the broker hard-codes 1h). Note: M1 already ships a single job-level activation TTL as the lone M1 exception to 'timers are M3'. Target semantics: docs/bpmn/01-events.md. To be sliced into concrete tasks when M2 lands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A follow-up spec/plan slices M3 into concrete tasks before implementation.
- [ ] #2 Timeout behavior (incident / alt-path / compensation) and the buffer-TTL configurability decision (design §9) are resolved and recorded.
- [ ] #3 Timer firing and the technical-vs-business error split are covered by integration tests (per concrete task).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Deferred epic. When M2 is complete: spec/plan the timers table + step.sleep/DO-alarm firing + error taxonomy, resolve the §9 timeout/TTL questions, then slice into tasks.
<!-- SECTION:PLAN:END -->
