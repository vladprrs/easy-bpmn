---
id: TASK-26
title: >-
  EPIC M3 — Time & failure taxonomy (timers, step timeouts,
  technical-vs-business errors)
status: To Do
assignee: []
created_date: '2026-06-08 08:18'
updated_date: '2026-06-11 17:20'
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
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/01-events.md
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
priority: medium
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Epic placeholder for milestone M3 (design §8). Add a timers table (boundary timer, per-step timeout, event deadline) driven by step.sleep / DO alarms; a technical-vs-business error catalog; configurable timeout behavior (incident / alternate BPMN path / compensation); and optionally a per-model configurable buffer TTL (today the broker hard-codes 1h). Note: M1 already ships a single job-level activation TTL as the lone M1 exception to 'timers are M3'. Target semantics: docs/bpmn/01-events.md. To be sliced into concrete tasks when M2 lands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A follow-up spec/plan slices M3 into concrete tasks before implementation.
- [x] #2 Timeout behavior (incident / alt-path / compensation) and the buffer-TTL configurability decision (design §9) are resolved and recorded.
- [ ] #3 Timer firing and the technical-vs-business error split are covered by integration tests (per concrete task).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Sliced 2026-06-11 via the brainstorming/spec pass (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md, hardened by a 4-lens adversarial review). Decisions locked: full construct set (interrupting boundary timer + intermediate timer/message catch + eventBasedGateway — lifts M3 from L toward XL); canonical timers only (no easy-bpmn timeout attributes — resolves the design-§9 timeout-behavior question by construction: a boundary timer always has a modeled path; un-guarded waits keep safety-net incidents per the Hazard principle); per-model buffer TTL DEFERRED (resolves the second §9 question); DO-alarm-first firing on a generalized JobScheduler (D1 `timers` canonical; testable in direct mode via runDurableObjectAlarm); race deciders are plain-INSERT rows batch-composed with transitions (gateway-decisions.ts contract; new timer_outcomes table; EBG decides on gateway_decisions); free error-boundary routing (distinct errorCodes + catch-all, token-path targets); incident kind split (jobActivationTimeout/waitTimeout/conditionFailure) + hygiene; retryable honored + reclaim exhaustion enforced; per-occurrence poison budget REJECTED (TASK-35 rationale). Concrete tasks (dependency order): TASK-38 (L0 engine.ts extraction) → TASK-39 (L1 incident taxonomy+hygiene) and TASK-40 (L1 jobs-API retry policy); TASK-41 (L2 constitution 2.2.0 + full docs lockstep) → TASK-42 (L2 free error routing), TASK-43 (L3 timers/timer_outcomes migration + Scheduler DO) → TASK-44 (L3 boundary timer runtime — the critical path) → TASK-45 (L4 intermediate timer catch), TASK-46 (L4 message catch + EBG) → TASK-47 (L5 quickstart gates + samples + specs/002 deltas + epic closure). AC#3 is delivered per concrete task; this epic closes with TASK-47. Note: the specs/002 M3 deltas + recorded Constitution Check are owed by TASK-41/TASK-47 (the design doc records the M2 procedural deviation M3 closes).
<!-- SECTION:PLAN:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-06-11 17:20
---
M3 sliced into TASK-38..TASK-47 (2026-06-11). Both design-§9 open questions resolved and recorded in the design doc: timer default behavior dissolved by the canonical-timers-only decision (a modeled timer always has a modeled path; no auto-compensation default — Hazard principle intact); broker buffer TTL stays fixed at 1h (deferred). Scope expansion vs the original §8 row: eventBasedGateway + intermediate catch + free error routing are in (user decision), lifting M3 from L toward XL — mitigated by the L0–L5 shippable-layer slicing.
---
<!-- COMMENTS:END -->

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
