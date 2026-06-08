---
id: TASK-9
title: 'Validator + profile: accept-and-validate the M1 canonical-saga construct set'
status: Done
assignee: []
created_date: '2026-06-08 08:17'
updated_date: '2026-06-08 12:15'
labels:
  - saga
  - bpmn
  - validator
  - profile
  - governance
  - tests
milestone: m-0
dependencies:
  - TASK-7
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#3-the-canonical-saga-contract-how-a-saga-is-drawn-in-bpmn
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (M1 profile
    subset)
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#1-context-goal
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#7-governance-m0
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#8-phase-roadmap-milestones
    (M0 row)
  - src/bpmn/validator.ts
  - src/bpmn/profile.ts
  - src/bpmn/graph.ts
  - src/bpmn/parser.ts
  - src/bpmn/moddle-extension.ts
  - tests/unit/bpmn-validator.test.ts
  - tests/contract/api.test.ts
  - tests/helpers.ts
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - .specify/memory/constitution.md
modified_files:
  - src/bpmn/validator.ts
  - src/bpmn/profile.ts
  - src/bpmn/graph.ts
  - tests/helpers.ts
  - tests/unit/bpmn-validator.test.ts
  - tests/contract/api.test.ts
  - .specify/memory/constitution.md
  - docs/bpmn/09-easy-bpmn-profile.md
priority: high
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
WHY: easy-bpmn today executes only Start->ServiceTask->ReceiveTask->End; the validator whitelist (src/bpmn/validator.ts, src/bpmn/profile.ts) is the first of the two seams the SAGA work must reopen (design 2026-06-08-saga-orchestrator-design.md §1, §3). This M0 task flips the publish-time profile gate from reject to accept-and-validate for the canonical-saga construct set so the §3 example publishes — with NO runtime/engine change (that is M1).

ACCEPT (design §3 "M1 profile subset"): bpmn:transaction scope (an inner startEvent, supported children, a none endEvent = commit, a cancelEventDefinition endEvent = cancel); boundaryEvent/compensateEventDefinition as a compensation marker (zero outgoing sequenceFlow, exactly one outgoing bpmn:association to an isForCompensation activity in the SAME transaction scope); boundaryEvent/errorEventDefinition on a serviceTask whose errorRef resolves to a declared root bpmn:error; boundaryEvent/cancelEventDefinition only on the transaction; serviceTask isForCompensation="true" (a handler, off the token path); endEvent with cancelEventDefinition only inside a transaction; bpmn:association and root bpmn:error parsing.

KEEP REJECTED with element id + reason: gateways/any >1 token-path split, conditionExpression/default, timer/signal/escalation/conditional events, callActivity/non-transaction subProcess/adHoc/multiInstance, instantiate="true", pools/lanes/collaboration/choreography. Foreign-ns extensions, DI, documentation stay tolerated.

The current validator only walks proc.flowElements (validator.ts:116) and rejects everything not on the 4-node whitelist; it must recurse into transaction scopes and stop false-rejecting compensation handlers and boundary events (which legitimately have no incoming/outgoing sequenceFlow). Governance (constitution 2.0.0, profile doc) ships in lockstep (design §7).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The design §3 canonical order-saga example validates (parseAndValidate returns ok:true with zero error-severity issues) and publishes through the API (POST /definitions/drafts then /publish returns the published version, 201), proving accept-and-validate.
- [x] #2 A compensation boundaryEvent (compensateEventDefinition) is accepted only with zero outgoing sequenceFlow AND exactly one outgoing bpmn:association to an isForCompensation activity in the same transaction scope; each violation (any outgoing sequenceFlow; zero or multiple associations; association target not isForCompensation; association target in a different transaction scope) is rejected with the offending element id + reason (one unit test per case).
- [x] #3 An error boundaryEvent on a serviceTask is accepted only when its errorRef resolves to a declared root bpmn:error; a missing/unresolved errorRef is rejected with element id + reason (unit test).
- [x] #4 A cancelEventDefinition is accepted only in transaction context: a cancel end event only inside a transaction and a cancel boundaryEvent only when attachedToRef is the transaction; a cancel end event outside any transaction and a cancel boundaryEvent on a non-transaction activity are each rejected with element id + reason (unit tests).
- [x] #5 All deferred constructs remain rejected with element id + reason: exclusiveGateway/parallelGateway, conditionExpression/default flow, timer + intermediateCatchEvent, callActivity, non-transaction subProcess, multiInstance/loop characteristics, receiveTask instantiate="true", and pools/lanes/collaboration (existing tests/unit/bpmn-validator.test.ts cases stay green; new saga-adjacent negatives added).
- [x] #6 Ignorable content stays tolerated: the §3 example augmented with foreign-namespace extensionElements (camunda:/zeebe:), Diagram Interchange, and documentation still validates and publishes (unit + contract test).
- [x] #7 CONSTITUTION GATE — a contract/integration test (tests/contract/api.test.ts plus tests/unit/bpmn-validator.test.ts) proves the publish gate end-to-end: the saga example publishes (201) and a deferred-construct draft is blocked at publish (409) with the element id + reason recorded on the draft's validation issues.
- [x] #8 A semantic round-trip test confirms the §3 example re-serializes via bpmn-moddle toXML and re-parses with no loss of standard elements when the easy-bpmn namespace and DI are ignored (design §3 note R3); bpmn-js manual round-trip noted as the operative human check.
- [x] #9 .specify/memory/constitution.md is bumped 1.0.0 -> 2.0.0 with a Sync Impact Report: Principle I rewritten to widen the profile while preserving the no-custom-notation / XSD-valid / round-trippable clause, the MVP Scope exclusion list trimmed to remove only the M1-shipped constructs (transaction, compensation, boundary error/cancel events), and a new 'SAGA / Compensation Integrity' principle added (design §7).
- [x] #10 docs/bpmn/09-easy-bpmn-profile.md is updated to the widened profile AND the stale 'one Durable Object per instance' line (09:154) corrected to one Cloudflare Workflow per instance + single DO correlation broker.
- [x] #11 npm run test:unit and npm run test:contract both pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. profile.ts:7-12 — add "bpmn:Transaction"->"transaction" and "bpmn:BoundaryEvent"->"boundaryEvent" to SUPPORTED_NODE_TYPES; widen NodeType/ElementType unions in graph.ts:3-12 to include transaction, boundaryEvent, association, error (M0: enum + minimal snapshot fields only — the engine-facing scope-aware multi-edge IR + persisted topology is M1 task #2, design §4.1, explicitly out of scope).
2. validator.ts:85-89 — alongside the message id->name map, parse root bpmn:Error elements into an id->errorCode map; collect bpmn:Association artifacts from proc.artifacts and each transaction's artifacts (associations are Artifacts, not flowElements).
3. validator.ts:116 — recurse classification into bpmn:Transaction.flowElements, tracking each node's enclosing scopeId; the transaction is itself a node on the outer token path.
4. validator.ts:148-157 — keep whitelist reject for non-saga flow nodes; classify boundaryEvent by its single eventDefinition (compensate/error/cancel) and serviceTask handlers via el.isForCompensation.
5. validator.ts:175-187 — allow endEvent with cancelEventDefinition only when scopeId is a transaction; reject cancel-end outside a transaction and all other start/end event definitions (none-only elsewhere).
6. validator.ts — add saga structural checks: compensate boundary = 0 outgoing sequenceFlow + exactly 1 association to an isForCompensation activity in the same scopeId; error boundary attachedToRef a serviceTask + errorRef resolving in the error map; cancel boundary attachedToRef the transaction.
7. validator.ts:266-300 — make linearity / no-incoming / no-outgoing + start reachability scope-aware: exempt boundaryEvents and isForCompensation handlers from the incoming/outgoing sequence-flow checks (reached via attachment/association), traverse each transaction's inner subgraph from its inner start, keep >1 token-path outgoing rejected.
8. validator.ts:306-344 — emit a parsed_profile snapshot carrying transaction scope membership, boundary kind + attachedToRef, associations, and errors so publish succeeds (storage only; not consumed by engine.ts in M0).
9. tests/helpers.ts — add SAGA_BPMN (§3 example) + negatives (bad-compensation-boundary variants, cross-scope association, unresolved errorRef, cancel-end-outside-tx, cancel-boundary-on-task, callActivity).
10. Extend tests/unit/bpmn-validator.test.ts (accept + each negative) and tests/contract/api.test.ts (publish 201 saga, 409 + recorded issue for deferred) per the 409/201 pattern at api.test.ts:22,41; add the bpmn-moddle round-trip test.
11. Amend .specify/memory/constitution.md -> 2.0.0 and docs/bpmn/09-easy-bpmn-profile.md (profile widening + fix :154). Run npm run test:unit and npm run test:contract.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Flipped the publish-time profile gate from reject to accept-and-validate for the canonical-saga set, with no engine/runtime change. `src/bpmn/graph.ts`: widened ElementType/NodeType to transaction/boundaryEvent/association/error + added minimal saga snapshot fields (scopeId, isForCompensation, endKind, boundaryKind, attachedToRef, errorRef/errorCode, compensationHandlerId) and ExecutionGraph.transactions/associations/errors. `src/bpmn/profile.ts`: added bpmn:Transaction/bpmn:BoundaryEvent to SUPPORTED_NODE_TYPES + saga type constants. `src/bpmn/parser.ts`: added roundTripBpmnXml() for the semantic round-trip test. `src/bpmn/validator.ts`: rewritten scope-aware — recurses into transaction scopes, parses root bpmn:error + bpmn:association artifacts, classifies boundary events by their single event definition, validates per-scope (one none start, ≥1 none commit end, linearity, BFS reachability over flow+attachment+association edges), and enforces saga structure (compensation boundary = 0 outgoing flow + exactly 1 in-scope association to an isForCompensation handler; error boundary attached to a serviceTask + resolved errorRef + routes to a cancel end; cancel boundary only on the transaction; cancel end only inside a transaction; handlers must live in a transaction). Linear MVP graphs are emitted identically (engine unaffected — full suite still green). `src/contracts/api.ts`: widened BpmnElement.type for the saga element types. Tests: SAGA fixtures + a parametric `sagaBpmn()` builder in tests/helpers.ts; 12 new validator unit tests (accept §3, tolerate ignorable, semantic round-trip, builder accept, + 8 negatives: comp-boundary outgoing/no-assoc/multi-assoc/target-not-handler, cross-scope assoc, unresolved errorRef, cancel-end-outside-tx, cancel-boundary-on-task) and a callActivity reject; 2 new contract tests (saga publishes 201 with transaction/boundaryEvent elements; deferred construct → draft invalid with element id + 409 on publish). Governance shipped in lockstep (constitution 2.0.0 via TASK-7; docs/bpmn/09 via TASK-10). `npm run typecheck`, `test:unit`, `test:contract`, and full suite all green (57/57).
<!-- SECTION:FINAL_SUMMARY:END -->
