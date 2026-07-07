---
id: TASK-84
title: 'M5-L3: Migration 0009 — mi_activations decider + iteration_index on service_task_jobs/saga_steps'
status: Done
assignee:
  - claude
created_date: '2026-07-06 07:30'
updated_date: '2026-07-06 23:00'
labels:
  - saga
  - bpmn
  - m5
milestone: m-5
dependencies:
  - TASK-83
documentation:
  - migrations/0009_multi_instance.sql
  - src/persistence/mi-activations.ts
  - src/persistence/saga.ts
  - src/persistence/instances.ts
priority: high
ordinal: 41400
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. M5-L3 multiInstance layer._

Plan Task 5: the `mi_activations` table (cardinality pinned once; settled_kind/settled_count early-settle decider; output_applied apply-once CAS), `iteration_index INTEGER NOT NULL DEFAULT 0` on jobs + saga_steps with widened unique indexes, iteration-defaulted statement/lookup signatures threaded through forward-task/compensation (all existing call sites pass 0 — byte-identical behavior).
<!-- SECTION:DESCRIPTION:END -->
