---
id: TASK-38
title: 'M3-L0: Extract engine.ts into modules (behavior-frozen refactor)'
status: To Do
assignee: []
created_date: '2026-06-11 17:17'
labels:
  - saga
  - engine
  - refactor
milestone: m-3
dependencies: []
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
priority: medium
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
src/runtime/engine.ts is 1,422 lines and M3 layers timers, eventBasedGateway and free error routing on top of it. Before any M3 feature lands, extract cohesive modules — node-dispatch registry, service-task visit block, compensation pass, incident helpers — per design §10 row L0 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Pure refactor: no behavior change, no public-API change, no step-name/history/persisted-shape change. This is the flagged TASK-26 note "engine.ts extraction chore".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All existing unit/contract/integration suites pass without behavioral edits (import-path updates only).
- [ ] #2 engine.ts no longer inlines the service-task visit block, compensation pass, and incident helpers; each lives in its own module with explicit exports and engine.ts is reduced to the walk/dispatch core.
- [ ] #3 Step names, history event types, persisted shapes, and API responses are unchanged (verified by the unchanged suites).
- [ ] #4 npm run typecheck and npm run check:docs are green.
<!-- AC:END -->
