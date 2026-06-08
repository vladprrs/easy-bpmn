---
id: TASK-27
title: >-
  EPIC M4 — Concurrency (parallel gateway, token set, AND-join, parallel-branch
  compensation)
status: To Do
assignee: []
created_date: '2026-06-08 08:18'
labels:
  - epic
  - saga
  - engine
milestone: m-4
dependencies: []
references:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§8 M4
  - §9
  - §5 execution_tokens stub)
  - docs/bpmn/07-execution-semantics.md
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/07-execution-semantics.md
priority: low
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Epic placeholder for milestone M4 (design §8) — the largest engine change. Replace the single current_element_id scalar cursor with a concurrent token set (execution_tokens table); add bpmn:parallelGateway split/join with an AND-join barrier; and make compensation correct for partially-completed parallel branches. Open decision (design §9): how to express a concurrent token set within ONE Cloudflare Workflow (parallel step.do vs child workflows) while preserving replay-safety and the ≤1 MiB event / ≤1 GB cumulative-state limits. Target semantics: docs/bpmn/07-execution-semantics.md (token lifecycle). To be sliced when M3 lands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A follow-up spec/plan slices M4 into concrete tasks before implementation.
- [ ] #2 The CF-Workflows concurrency strategy (design §9) is resolved and recorded before implementation.
- [ ] #3 Parallel branches run concurrently, join correctly, and a failure compensates all completed branches (per concrete task tests).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Deferred epic. When M3 is complete: resolve the concurrency strategy (§9), spec/plan the execution_tokens model + parallel gateway + AND-join + parallel-branch compensation, then slice into tasks.
<!-- SECTION:PLAN:END -->
