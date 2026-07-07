---
id: TASK-86
title: 'M5-L3: iteration errors + Hazard; MI-callActivity fan-out; per-iteration compensation closure'
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
  - TASK-85
documentation:
  - src/runtime/call-activity.ts
  - src/runtime/compensation.ts
  - src/runtime/boundary-timer.ts
  - tests/integration/multi-instance-call.test.ts
  - tests/integration/multi-instance-errors.test.ts
  - tests/integration/multi-instance-compensation.test.ts
priority: high
ordinal: 41600
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. M5-L3 multiInstance layer._

Plan Tasks 9-11: iteration business error -> abort-settle + drainScopeSubtree(miBody) + route-as-if-MI-threw (boundary/bubble/uncaughtError); timer-Hazard on the MI activity; MI-callActivity iteration-keyed child triad (childInstanceIdFor 4th arg live, N children, child errored -> iteration error, cascade cancel all iterations) + per-iteration child compensation (the flagship exit criterion); serviceTask/subProcess per-iteration compensation closure + straggler/barrier refinements (retainCallStraggler own-iteration row, mi# token job resolution, reconstructFrontier preservation).
<!-- SECTION:DESCRIPTION:END -->
