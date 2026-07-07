---
id: TASK-87
title: 'M5-L3: lineage iterationIndex — API/openapi/SPA console delta + operator cascade tests'
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
  - TASK-86
documentation:
  - src/contracts/api.ts
  - src/index.ts
  - spa/src/lib/lineage.ts
  - tests/integration/multi-instance-operator.test.ts
priority: high
ordinal: 41700
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. M5-L3 multiInstance layer._

Plan Task 12: InstanceLineageChild.iterationIndex (API type + openapi + handleGetInstance mapping), SPA lineage sort/label delta, operator cascade regression (/retry into MI children, 409 on direct child verbs), read-only/D1-only invariant re-affirmed (all new MI history events).
<!-- SECTION:DESCRIPTION:END -->
