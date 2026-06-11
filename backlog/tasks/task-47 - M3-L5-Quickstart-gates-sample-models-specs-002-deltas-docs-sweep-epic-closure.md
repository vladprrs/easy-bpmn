---
id: TASK-47
title: >-
  M3-L5: Quickstart gates, sample models, specs/002 deltas, docs sweep, epic
  closure
status: To Do
assignee: []
created_date: '2026-06-11 17:20'
labels:
  - saga
  - docs
  - tests
milestone: m-3
dependencies:
  - TASK-40
  - TASK-42
  - TASK-44
  - TASK-45
  - TASK-46
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
  - specs/002-saga-orchestrator/quickstart.md
priority: medium
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Final M3 layer per design §10 row L5 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Executable quickstart scenarios for every design §7 gate not already covered by the per-layer tasks; two new sample models — a timer saga (boundary timer → cancel end → compensation) and an EBG saga (message-vs-timer race) — each publishing and round-tripping semantically through bpmn-js (R4). specs/002-saga-orchestrator M3 deltas: data-model.md (timers, timer_outcomes, incident kinds), contracts/openapi.yaml + runtime-contracts.md (timers block, retryable, decider protocol), quickstart.md (M3 gates) — the M2 artifact set (spec.md/plan.md stay M1-only per the recorded deviation in design §8). Final docs sweep: docs/bpmn/09 markings all flipped to accepted, 01-events.md consistent, all new check:docs guards green. Close the TASK-26 epic (check its AC#3, final summary).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every design §7 gate exists as an executable scenario and passes in CI (direct mode); the Workflow-mode manual-validation list (sendEvent wake, memoization guard, timer-sized backstop) is documented in quickstart.md.
- [ ] #2 Timer saga and EBG saga sample models publish and round-trip semantically through bpmn-js.
- [ ] #3 specs/002 data-model/contracts/quickstart carry the M3 deltas; npm run check:docs green.
- [ ] #4 TASK-26 AC#3 checked and the epic closed with a final summary referencing all M3 tasks.
<!-- AC:END -->
