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

## Notes

<!-- SECTION:NOTES:BEGIN -->
M3 candidates from M2 reviews (recorded by TASK-37; decide/slice when this epic is planned):

1. Honor-or-drop /jobs/fail `retryable` — the field is accepted by the schema but IGNORED server-side (terminality = errorCode or retry-budget exhaustion only; documented as advisory in runtime-contracts.md + openapi.yaml under TASK-37). Either make it semantic or remove it from the schema + pin.
2. setIncidentResolution lacks an incident_id filter — it updates ALL non-operatorResolved incidents of an instance; add the per-incident filter.
3. Cancelled-empty-ledger instances leave their incident resolution 'open' forever — advance to operatorResolved in the pending===0 /cancel branch.
4. Dedicated `conditionFailure` incident kind — a hard FEEL evaluation error currently reuses kind=serviceTaskFailure (decideGateway); a distinct kind makes the operator surface honest.
5. engine.ts section extraction — split gateway dispatch / compensation / receive-task helpers into modules (the file has grown past comfortable review size); pure chore, no behavior change.
6. Revisit the per-occurrence poison budget — poison strikes are counted from serviceTaskOutputRejected history per element (not per occurrence); decide whether a loop iteration should get a fresh budget or keep the shared one.
<!-- SECTION:NOTES:END -->
