---
id: TASK-47
title: >-
  M3-L5: Quickstart gates, sample models, specs/002 deltas, docs sweep, epic
  closure
status: Done
assignee:
  - Vlad Pr
created_date: '2026-06-11 17:20'
updated_date: '2026-06-12 21:29'
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
modified_files:
  - examples/timer-saga.bpmn
  - examples/event-gateway-saga.bpmn
  - tests/integration/sample-m3-models.test.ts
  - specs/002-saga-orchestrator/data-model.md
  - specs/002-saga-orchestrator/quickstart.md
  - specs/002-saga-orchestrator/contracts/runtime-contracts.md
  - CLAUDE.md
priority: medium
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Final M3 layer per design §10 row L5 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Executable quickstart scenarios for every design §7 gate not already covered by the per-layer tasks; two new sample models — a timer saga (boundary timer → cancel end → compensation) and an EBG saga (message-vs-timer race) — each publishing and round-tripping semantically through bpmn-js (R4). specs/002-saga-orchestrator M3 deltas: data-model.md (timers, timer_outcomes, incident kinds), contracts/openapi.yaml + runtime-contracts.md (timers block, retryable, decider protocol), quickstart.md (M3 gates) — the M2 artifact set (spec.md/plan.md stay M1-only per the recorded deviation in design §8). Final docs sweep: docs/bpmn/09 markings all flipped to accepted, 01-events.md consistent, all new check:docs guards green. Close the TASK-26 epic (check its AC#3, final summary).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every design §7 gate exists as an executable scenario and passes in CI (direct mode); the Workflow-mode manual-validation list (sendEvent wake, memoization guard, timer-sized backstop) is documented in quickstart.md.
- [x] #2 Timer saga and EBG saga sample models publish and round-trip semantically through bpmn-js.
- [x] #3 specs/002 data-model/contracts/quickstart carry the M3 deltas; npm run check:docs green.
- [x] #4 TASK-26 AC#3 checked and the epic closed with a final summary referencing all M3 tasks.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Baseline (verified before starting): 359 tests green (46 files), `npm run check:docs` + `npx tsc --noEmit` clean, migration `0006_timers.sql` committed. L0–L4 (TASK-38..46) shipped the runtime + per-gate tests; openapi.yaml already carries the timers/TimerView/retryable/incident-enum M3 deltas; data-model.md/quickstart.md do NOT yet carry the M3 deltas.

L5 deliverables:

1. AC#2 — two new on-disk sample models, each publish-valid against the LIVE validator and semantically round-tripping through bpmn-moddle (`roundTripBpmnXml`, the R3/R4 mechanism):
   - `examples/timer-saga.bpmn` — transaction saga; a boundary timer on a long-running task inside the `transaction` routes to a cancel end event → reverse-order compensation (the canonical "timeout → compensate" shape; design exit criterion 2). Built from the proven SAGA_TIMER_BPMN/order-saga shapes with two compensatable steps.
   - `examples/event-gateway-saga.bpmn` — an `eventBasedGateway` racing a message intermediate-catch vs a timer intermediate-catch (design §4.5 / §7 gate 5), built from the proven TIMER_MSG_EBG shape.
   - New `tests/integration/sample-m3-models.test.ts`: publishes both from disk (live validator, empty validationIssues), round-trips both through `roundTripBpmnXml`, and executes each headline path (timer fires → compensation; EBG message wins / timer wins).

2. AC#3 — specs/002 deltas + check:docs green:
   - `data-model.md`: move `timers` out of "Roadmap stub tables" into a shipped-table section documenting `timers` + `timer_outcomes` per design §4.1 (drop stale "via step.sleep"); note boundaryEvent.kind=timer live, intermediate-catch kinds, eventBasedGateway, the new history event types.
   - `quickstart.md`: retitle M1+M2+M3; setup applies 0001…0006; add M3 scenarios mapping each design §7 gate to its green test; add the Workflow-mode manual-validation list (sendEvent discriminated wake, first-event-wins memoization guard, timer-sized waitForEvent backstop) — AC#1.
   - Verify openapi.yaml + contracts/runtime-contracts.md M3 coverage (timers block ✓, retryable ✓, decider protocol) and fill any gap.
   - Verify docs/bpmn/09 interim markings now read "shipped/accepted" (L3/L4 landed) and check:docs guard-5 already flipped.

3. AC#1 — confirm each design §7 gate has a green executable scenario (already shipped by L1–L4 tests: boundary-timer*, event-gateway, error-routing, intermediate-timer*, message-intermediate-catch, jobs-retryable-reclaim, incident-hygiene, wait-cap-incidents, bpmn-validator matrix) and reference them from quickstart.

4. AC#4 — check TASK-26 AC#3 and close the epic with a final summary referencing TASK-38..47.

Verification gate: `npm run test` (full), `npm run typecheck`, `npm run check:docs`, `npx wrangler deploy --dry-run` all green. Then push branch + apply the D1 migration (0006) per the user's request.

Execution is autonomous through to push+migrate (user authorized "finish, push, migrate"; recorded autonomous-execution preference).
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
M3-L5 — the final M3 layer — shipped; the M3 epic is complete.

**Sample models (AC#2).** Two new on-disk, executable/reference BPMN samples, each publish-valid against the LIVE validator with empty `validationIssues` AND semantically round-tripped through bpmn-moddle (`roundTripBpmnXml`, the R4 canonicity gate):
- `examples/timer-saga.bpmn` — a `bpmn:transaction` with two compensatable forward steps (reserve-stock, charge-card) followed by a long-running `awaitShipment` carrying an interrupting boundary timer (PT30M) → cancel end → reverse-order compensation. The canonical "timeout → compensate" shape (design exit criterion 2), the M3 analogue of order-saga.bpmn — the trip is a drawn boundary timer, not an easy-bpmn attribute (decision #2).
- `examples/event-gateway-saga.bpmn` — an `eventBasedGateway` racing a message intermediate-catch (`ApprovalGranted`) vs a timer intermediate-catch (PT24H), deciding on a single `gateway_decisions` row (design §4.5).
- `tests/integration/sample-m3-models.test.ts` (5 new tests) publishes both from disk, round-trips both, and executes each headline path: timer-saga → compensating → compensated with `compensationStarted` order `[chargeCard, reserveStock]`; EBG message wins → fulfil branch; EBG timer wins → escalate branch + a late publish to the superseded subscription does not advance.

**specs/002 deltas (AC#3).** `data-model.md`: `timers` moved out of the "Roadmap stub tables" stub (dropping the stale "via step.sleep" — design decision #4: `step.sleep` is not used) into a full M3-deltas section documenting the `timers` + `timer_outcomes` tables, the new graph-IR token nodes (boundary/intermediate timers, message intermediate catch, eventBasedGateway), the incident-kind split, the honored-retryable policy, the new history event types, and the inspection `timers` block. `quickstart.md`: retitled M1+M2+M3, setup applies 0001…0006, Scenarios 15–26 map every design §7 gate to its green test, plus the Workflow-mode-only manual-validation list (sendEvent discriminated wake, first-event-wins memoization guard, timer-sized waitForEvent backstop). `contracts/runtime-contracts.md`: new "Timer, Race-Decider & Failure-Taxonomy Contract (M3)" section (arming/firing/decider protocol, EBG delivery, free error routing, wait-cap-vs-modeled-timer) + Failure-Taxonomy business-error bullet de-staled (multi-boundary + catch-all routing, waitTimeout/conditionFailure). openapi.yaml already carried the timers/TimerView/retryable/incident-enum deltas (L1/L3). `npm run check:docs` green.

**§7 gates (AC#1).** Every design §7 gate already exists as a green executable scenario from L1–L4 (boundary-timer + boundary-timer-backstop, event-gateway, error-routing, intermediate-timer + intermediate-timer-backstop, message-intermediate-catch, jobs-retryable-reclaim, incident-hygiene, wait-cap-incidents, service-task-incident, the bpmn-validator accept/reject matrix, fire-timer/job-scheduler/timers-persistence/correlation-broker units), now referenced by name from quickstart Scenarios 15–26; the new sample-m3-models tests add the round-trip + sample-execution gates. The Workflow-mode-only paths are documented as manual validation.

**Docs sweep (AC#3).** docs/bpmn/09 interim markings were already flipped to "shipped" by L4 (TASK-46) and 01-events.md fixed at L2 (TASK-41); CLAUDE.md flipped here from "M3 is the next milestone / interim / rejected-per-layer with reason 'M3 — not yet implemented'" to M3-shipped (M4 is now next), staying in lockstep with constitution v2.2.0 and docs/bpmn/09.

**Epic closure (AC#4).** TASK-26 AC#3 satisfied and the epic closed (separate final summary referencing TASK-38..47).

Verification: `npm run test` 364 passed / 47 files (was 359/46; +5 new); `npm run typecheck` clean; `npm run check:docs` green; `npx wrangler deploy --dry-run` clean (bindings intact). spec.md/plan.md intentionally left M1-only per the recorded design §8 deviation; the M3 Constitution Check lives at specs/002-saga-orchestrator/m3-constitution-check.md (L2).
<!-- SECTION:FINAL_SUMMARY:END -->
