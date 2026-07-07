---
id: TASK-83
title: 'M5-L3: MAX_MI_CARDINALITY + bodyStepCost via call resolution + miCardinality incident kind + step-free park'
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
  - TASK-82
documentation:
  - src/runtime/engine.ts
  - src/bpmn/call-resolution.ts
  - src/persistence/instances.ts
  - scripts/check-docs.mjs
  - src/runtime/forward-task.ts
priority: high
ordinal: 41300
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. M5-L3 multiInstance layer._

Plan Tasks 3-4: `MAX_MI_CARDINALITY = 200` (check:docs-synced, override env), body-aware effective cap inputs (publish-time bodyStepCost incl. resolved-child-graph costing in call-resolution.ts), `miCardinality` in IncidentKind + openapi enum; and the design §6 highest-leverage mitigation — svc-park/call-park become step-free on rewalk (timer-catch pattern).
<!-- SECTION:DESCRIPTION:END -->
