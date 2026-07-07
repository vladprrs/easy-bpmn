---
id: TASK-85
title: 'M5-L3: MI runtime core — serviceTask + subProcess iterations, aggregation, completionCondition cancel-remaining'
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
  - TASK-84
documentation:
  - src/runtime/multi-instance.ts
  - src/runtime/engine.ts
  - src/runtime/frontier.ts
  - tests/integration/multi-instance-forward.test.ts
  - tests/integration/multi-instance-subprocess.test.ts
  - tests/integration/multi-instance-condition.test.ts
priority: high
ordinal: 41500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. M5-L3 multiInstance layer._

Plan Tasks 6-8: `driveMultiInstance` (activate -> drive iterations -> settle/apply -> park, every step D1-predicate-gated), parallel+sequential serviceTask MI (@i step names/keys, loopCounter/elementVariable, aggregation by index, N=0, miCardinality/conditionFailure incidents), MI-over-subProcess via mi# iteration tokens + driver body sub-walk over shared driveLeaf (overlay isolation, interior occurrences), completionCondition once-only early settle with NORMAL (non-compensating) cancel-remaining.
<!-- SECTION:DESCRIPTION:END -->
