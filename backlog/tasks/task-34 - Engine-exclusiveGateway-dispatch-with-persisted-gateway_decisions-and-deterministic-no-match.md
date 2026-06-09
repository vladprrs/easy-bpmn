---
id: TASK-34
title: >-
  Engine: exclusiveGateway dispatch with persisted gateway_decisions and
  deterministic no-match
status: To Do
assignee: []
created_date: '2026-06-09 20:30'
labels:
  - saga
  - engine
  - runtime
  - gateway
  - tests
milestone: M2
dependencies:
  - TASK-29
  - TASK-30
  - TASK-32
  - TASK-33
references:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - src/runtime/engine.ts
  - src/persistence
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
documentation:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - docs/bpmn/03-gateways.md
priority: high
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
M2 design 2026-06-09 §6. Add exclusiveGateway to the engine's node-kind dispatch (src/runtime/engine.ts). Inside one persisted step (gw:${elementId}#${occurrence}): (1) if a gateway_decisions row exists for (instance_id, element_id, occurrence) → take its chosen_flow_id, never re-evaluate, no writes (rewalk fast-forward); (2) else read instance variables from D1 and evaluate the NON-default outgoing conditions in document order via the FEEL module (TASK-30) — first boolean true wins; none true → the default flow; no default → terminal incident kind=noPath (inside a transaction this is a Hazard per the saga design §4.5: no auto-compensation, operator POST /instances/{id}/cancel stays available); a hard FEEL interpreter error → deterministic incident; (3) persist the decision row (evaluations JSON in document order; variables_snapshot capped by the existing payload limit) + applyTransition to the chosen target + a gatewayDecisionEvaluated history event in ONE dbBatch (persist-before-advance). An XOR join (N-in/1-out) is a pass-through. The engine never reads .next on gateway nodes. No new public endpoint — operator visibility is the history event (design §6, YAGNI).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Data-driven branch: an integration test publishes a conditional saga and starts two instances with different variables; each takes the correct path; gateway_decisions rows record chosen_flow_id plus per-flow evaluations in document order.
- [ ] #2 The default flow is taken when no condition is true, with is_default recorded in the decision row.
- [ ] #3 Multiple true conditions select the first in document order — pinned by test.
- [ ] #4 No-match without default → terminal incident kind=noPath; inside a transaction: Hazard semantics — no auto-compensation, and a subsequent operator /cancel compensates (integration test).
- [ ] #5 Decision replay: crash/resume at a gateway reuses the persisted decision — proven by mutating variables between resume attempts and asserting the original branch is kept (both execution modes).
- [ ] #6 Decision write, transition, and gatewayDecisionEvaluated history event ({chosenFlowId, occurrence, evaluations} in diagnostics) are one dbBatch; variables_snapshot is size-capped by the existing payload limit.
- [ ] #7 Constitution gate: contract/integration tests above; npm run test green.
<!-- AC:END -->
