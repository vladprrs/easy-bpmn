---
id: TASK-33
title: >-
  Validator/profile: accept-and-validate exclusiveGateway, FEEL conditions,
  default flows, and cycles
status: In Progress
assignee:
  - Claude
created_date: '2026-06-09 20:29'
updated_date: '2026-06-10 18:02'
labels:
  - saga
  - bpmn
  - validator
  - tests
milestone: M2
dependencies:
  - TASK-30
  - TASK-31
references:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - src/bpmn/validator.ts
  - src/bpmn/profile.ts
documentation:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - docs/bpmn/03-gateways.md
  - docs/bpmn/09-easy-bpmn-profile.md
priority: high
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
M2 reopens the validator whitelist for data-driven branching (design 2026-06-09 §3). Flip reject→accept-and-validate in src/bpmn/validator.ts + src/bpmn/profile.ts: bpmn:exclusiveGateway at process level and inside transactions — split (1-in/N-out) and join (N-in/1-out, pass-through). On a split: every NON-default outgoing flow MUST carry a conditionExpression; the `default` flow MUST NOT carry one and MUST reference one of the gateway's own outgoing flows; a 1-out gateway is a pass-through needing no conditions. All conditions are FEEL-parsed at publish via the expressions module (TASK-30); parse failure rejects with element id + reason. Cycles on the token path become legal (reachability is already BFS-based; remove any acyclicity assumption). Still rejected with element id + reason: conditionExpression on any flow not leaving an exclusiveGateway (design §2 decision 3 — implicit conditional splits on activities are inclusive-split semantics, M4); >1 outgoing flow on a non-gateway node (validator.ts:491-497 stays for non-gateways); boundary events attached to a gateway (invalid BPMN); inclusiveGateway/parallelGateway/eventBasedGateway/complexGateway (M3/M4); the whole M1 reject list. Keep tolerate-and-ignore for foreign-namespace extensionElements/DI/documentation (constitution).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A saga model with an XOR split (FEEL conditions + default) and an XOR join publishes successfully, at process level and inside a transaction.
- [ ] #2 Reject matrix (each with element id + reason): invalid FEEL; condition on a non-gateway flow; default referencing a missing/foreign flow; non-default condition-less split flow; condition on the default flow; boundary event attached to a gateway; inclusive/parallel/eventBased/complex gateways.
- [ ] #3 A cyclic token path (loop back through an XOR gateway) passes validation; a >1-outgoing non-gateway node still rejects.
- [ ] #4 bpmn-js semantic round-trip test (R3 pattern) covers a conditional saga model with gateway, conditions, and default.
- [ ] #5 Foreign-namespace extensionElements, Diagram Interchange, and documentation are still tolerated on conditional models.
- [ ] #6 Constitution gate: unit/contract tests for the accept + reject matrix; npm run test green; M0/M1 accepted fixtures still publish (regression).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: subagent-driven (implementer + spec review + quality review) on branch m2-conditional-sagas.

1. profile.ts: add exclusiveGateway to SUPPORTED_NODE_TYPES (process level + inside transaction).
2. validator.ts flips: remove the unconditional exclusiveGateway reject; allow conditionExpression ONLY on flows leaving an exclusiveGateway (everywhere else keeps the M1 reject with element id+reason); allow `default` attr ONLY on exclusiveGateway and only referencing one of its own outgoing flows; split rules (every non-default outgoing flow MUST carry a condition; default MUST NOT carry one; 1-out gateway = pass-through needs nothing); FEEL-parse all conditions at publish via parseCondition (TASK-30) -> reject with element id + reason; boundary events attached to a gateway -> reject; inclusive/parallel/eventBased/complex gateways stay rejected; multi-out non-gateway stays rejected; cycles legal (BFS reachability already handles them — verify no acyclicity assumption).
3. Remove the GET / feel bundle canary in src/index.ts (+ comment block) — validator now imports parseCondition for real.
4. Tests: accept matrix (XOR split+default publishes at process level and in transaction; cyclic token path publishes; XOR join passes); reject matrix per AC#2 (each with element id + reason); tolerate-and-ignore regression on conditional models (foreign extensionElements/DI/documentation); bpmn-js (bpmn-moddle round-trip per existing R3 pattern) semantic round-trip for a conditional saga model; M0/M1 fixtures still publish.
Carried from reviews: default-referencing-foreign-flow must reject (builder keeps isDefault:false); empty condition == condition-less (reject bucket for non-default split flows).
<!-- SECTION:PLAN:END -->
