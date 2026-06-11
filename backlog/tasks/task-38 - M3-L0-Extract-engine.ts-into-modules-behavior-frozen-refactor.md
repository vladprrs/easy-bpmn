---
id: TASK-38
title: 'M3-L0: Extract engine.ts into modules (behavior-frozen refactor)'
status: Done
assignee:
  - Claude
created_date: '2026-06-11 17:17'
updated_date: '2026-06-11 17:59'
labels:
  - saga
  - engine
  - refactor
milestone: m-3
dependencies: []
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
modified_files:
  - src/runtime/engine.ts
  - src/runtime/engine-shared.ts
  - src/runtime/incidents.ts
  - src/runtime/forward-task.ts
  - src/runtime/compensation.ts
priority: medium
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
src/runtime/engine.ts is 1,422 lines and M3 layers timers, eventBasedGateway and free error routing on top of it. Before any M3 feature lands, extract cohesive modules — node-dispatch registry, service-task visit block, compensation pass, incident helpers — per design §10 row L0 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Pure refactor: no behavior change, no public-API change, no step-name/history/persisted-shape change. This is the flagged TASK-26 note "engine.ts extraction chore".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 All existing unit/contract/integration suites pass without behavioral edits (import-path updates only).
- [x] #2 engine.ts no longer inlines the service-task visit block, compensation pass, and incident helpers; each lives in its own module with explicit exports and engine.ts is reduced to the walk/dispatch core.
- [x] #3 Step names, history event types, persisted shapes, and API responses are unchanged (verified by the unchanged suites).
- [x] #4 npm run typecheck and npm run check:docs are green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Behavior-frozen extraction of src/runtime/engine.ts (1422 lines) into cohesive modules, executed via a fresh implementer subagent + two-stage review (spec compliance, then code quality). Target modules: (1) keep engine.ts as the walk/dispatch core (runInstance, loop, loadGraphForInstance, types, MAX_ELEMENT_OCCURRENCES, scope helpers, resumeInline) and re-export all current public symbols so importers need no change; (2) extract the forward service-task visit block; (3) extract the compensation pass; (4) extract incident helpers. Hard gate: all 236 existing tests green, typecheck green, check:docs green, zero behavior/step-name/history/persisted-shape change. Baseline captured green at commit 19fb9fc.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done at commit 61f5ad0. engine.ts 1422→774 lines; extracted engine-shared.ts (types/consts/loadInst/isTransactionScope), incidents.ts (completeInstance/parkWaiting/createIncident/recordTerminalIncident), forward-task.ts (forward service-task visit + DLQ terminateUnleasableJob), compensation.ts (reverse saga pass). loop() dispatch switch kept in engine.ts; modules return discriminated outcomes routed by the loop (cycle-free DAG). Public façade preserved — zero dependent edits. Verbatim move (spec reviewer confirmed byte-for-byte). 236 tests / typecheck / check:docs green. Two-stage review passed (spec ✅, code quality: Ready to merge=Yes).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
M3-L0 behavior-frozen engine.ts extraction. Split the 1422-line src/runtime/engine.ts into the walk/dispatch core (runInstance/loop/gateway/receive-task/resumeInline, now 774 lines) plus four cohesive siblings: engine-shared.ts, incidents.ts, forward-task.ts, compensation.ts. Modules return discriminated outcomes routed by loop() — an acyclic DAG that lets M3 add timer/EBG node kinds without import cycles. Public symbols re-exported from engine.ts so all dependents (process-workflow, index, executor, job-scheduler, integration tests) import unchanged. Verified behavior-frozen: 236/236 tests, typecheck, check:docs all green; spec reviewer confirmed verbatim relocation (no step-name/history/SQL change). Carried forward to later layers: L1 incident-kind split edits createIncident call-site constants (DLQ→jobActivationTimeout in forward-task.ts, svc/recv wait caps→waitTimeout, gateway hard-FEEL→conditionFailure); consider DRYing errorBoundaryTarget/cancelBoundaryTarget + a shared timers.ts in L3; locate code by symbol (design-doc line refs are now stale post-extraction)."
<!-- SECTION:FINAL_SUMMARY:END -->
