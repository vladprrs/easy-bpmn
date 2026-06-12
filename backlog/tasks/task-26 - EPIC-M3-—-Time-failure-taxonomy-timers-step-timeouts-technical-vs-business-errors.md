---
id: TASK-26
title: >-
  EPIC M3 — Time & failure taxonomy (timers, step timeouts,
  technical-vs-business errors)
status: Done
assignee: []
created_date: '2026-06-08 08:18'
updated_date: '2026-06-12 21:29'
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
- [x] #3 Timer firing and the technical-vs-business error split are covered by integration tests (per concrete task).
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

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
M3 — Time & failure taxonomy — COMPLETE. Sliced into shippable layers L0–L5 (TASK-38..47) and shipped end to end.

**What shipped:**
- **L0 (TASK-38)** — behavior-frozen `engine.ts` module extraction.
- **L1 (TASK-39, TASK-40)** — incident-taxonomy split (`timeout` → `jobActivationTimeout` + `waitTimeout`; `conditionFailure` added) + incident hygiene (per-incident resolution, open-incident list, empty-ledger close-all); jobs-API retry policy (`retryable` honored, reclaim-exhaustion termination enforced).
- **L2 (TASK-41, TASK-42)** — constitution 2.1.0 → 2.2.0 (full M3 set, full amendment procedure incl. templates + CLAUDE.md pin + recorded Constitution Check) + full docs/bpmn/09 lockstep with interim markings + 01-events.md fix + stale-phrase guards; then free error-boundary routing (multi-boundary distinct-`@errorCode` + catch-all, token-path targets).
- **L3 (TASK-43, TASK-44)** — `0006_timers.sql` (`timers` + `timer_outcomes`) + generalized one-shot `JobScheduler` DO + boundary-timer arm/fire/decider runtime + abnormal-exit settlement + inspection `timers` block.
- **L4 (TASK-45, TASK-46)** — intermediate timer catch + standalone message intermediate catch + `eventBasedGateway` (race deciding on `gateway_decisions`, delivery-path change honoring the stored wake type, document-order tie-break); `check:docs` guard-5 flipped.
- **L5 (TASK-47)** — quickstart M3 gates (Scenarios 15–26) + Workflow-mode manual list; two round-tripping sample models (`examples/timer-saga.bpmn`, `examples/event-gateway-saga.bpmn`); specs/002 data-model/quickstart/runtime-contracts M3 deltas; final docs sweep; this epic closed.

**Exit criteria — all met:** (1) a boundary timer routes the token down its modeled alternate path; (2) a boundary timer inside a `transaction` → cancel end → reverse-order compensation (the canonical "timeout → compensate" shape; `examples/timer-saga.bpmn`); (3) an `eventBasedGateway` race is won deterministically by message-or-timer in both orders (`examples/event-gateway-saga.bpmn`); (4) business-vs-technical failures route distinctly per error code (multi-boundary + catch-all; `retryable=false` short-circuits) and the conflated `timeout` is split into `jobActivationTimeout`/`waitTimeout` plus the fired-model-timer non-incident `timerFired` path.

**AC#3 (timer firing + technical-vs-business split covered by integration tests):** met — boundary-timer + boundary-timer-backstop, event-gateway, intermediate-timer + intermediate-timer-backstop, message-intermediate-catch, error-routing, jobs-retryable-reclaim, incident-hygiene, wait-cap-incidents, service-task-incident, sample-m3-models (round-trip + execution), plus fire-timer / job-scheduler / timers-persistence / correlation-broker units and the bpmn-validator accept/reject matrix.

**Resolved §9 open questions:** timer default-behavior dissolved by canonical-timers-only (a modeled timer always has a modeled path; Hazard principle intact); per-model broker buffer TTL stays fixed at 1h (deferred). Scope expansion vs the original §8 row (eventBasedGateway + intermediate catch + free error routing) absorbed via the L0–L5 shippable-layer slicing.

**Governance:** constitution v2.2.0; the M3 Constitution Check is recorded at specs/002-saga-orchestrator/m3-constitution-check.md (closing the M2 procedural gap). Per the recorded design §8 deviation, specs/002 spec.md/plan.md intentionally stay M1-only (the project's brainstorming-design → backlog-slicing operating mode since M2).

Full suite green at closure: 364 tests / 47 files; typecheck, check:docs, and `wrangler deploy --dry-run` all clean. Next milestone: M4 (concurrency — parallel gateway, token set, AND-join).
<!-- SECTION:FINAL_SUMMARY:END -->

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
