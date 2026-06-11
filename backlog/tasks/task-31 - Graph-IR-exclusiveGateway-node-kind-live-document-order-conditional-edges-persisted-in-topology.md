---
id: TASK-31
title: >-
  Graph IR: exclusiveGateway node kind + live document-order conditional edges
  persisted in topology
status: Done
assignee:
  - Claude
created_date: '2026-06-09 20:29'
updated_date: '2026-06-10 18:02'
labels:
  - saga
  - bpmn
  - graph-ir
  - persistence
  - tests
milestone: M2
dependencies:
  - TASK-29
references:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - src/bpmn/graph.ts
  - src/bpmn/validator.ts
  - migrations/0003_topology.sql
documentation:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - docs/bpmn/03-gateways.md
  - docs/bpmn/04-flows-and-data.md
priority: high
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The M1 closeout (TASK-11, commit b6ba5fb) shipped GraphNode.outgoing: Flow[] with dormant conditionExpression/isDefault hooks (src/bpmn/graph.ts:40-52, always null/false). M2 (design 2026-06-09 §4) makes them live. Add "exclusiveGateway" to NodeType/ElementType in src/bpmn/graph.ts; in the parser/builder (src/bpmn/validator.ts) populate Flow.conditionExpression from the sequenceFlow's tFormalExpression body and Flow.isDefault from the gateway's `default` attribute; guarantee outgoing[] preserves DOCUMENT ORDER (= condition evaluation order, design §2 decision 5) and make that explicit in the Flow doc comment. Persist condition_expression/is_default into bpmn_elements rows and parsed_profile (columns land in the migration task TASK-29); getVersionElements reads them back; the getVersionGraph deep-equal-vs-fresh-parse replay test extends to conditions and edge order. GraphNode.next stays derived (outgoing[0]) for non-gateway nodes; the IR makes no .next promise for gateway nodes (branch selection owns it — engine gateway-dispatch task).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 NodeType/ElementType include exclusiveGateway; parsing a model with an XOR split/join yields a gateway node whose outgoing Flows carry flowId/targetId/conditionExpression/isDefault in document order.
- [x] #2 default-attribute resolution: Flow.isDefault is true exactly for the flow referenced by the gateway's default attribute, false elsewhere.
- [x] #3 bpmn_elements sequenceFlow rows persist condition_expression and is_default; getVersionElements returns them; parsed_profile carries the same data.
- [x] #4 The getVersionGraph deep-equal-vs-fresh-parse replay test is green for a published conditional model, covering conditions and outgoing-edge order.
- [x] #5 Constitution gate: unit + integration coverage of the above; npm run test green; linear MVP and M1 saga fixtures parse unchanged (regression).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: subagent-driven (implementer + spec review + quality review) on branch m2-conditional-sagas.

1. src/bpmn/graph.ts: add "exclusiveGateway" to NodeType + ElementType; document on Flow that outgoing[] order = document order = condition evaluation order; document that .next is meaningless for gateway nodes (branch selection owns it).
2. src/bpmn/validator.ts (builder part only — accept/reject matrix is TASK-33): populate Flow.conditionExpression from the sequenceFlow tFormalExpression body and Flow.isDefault from the gateway's `default` attribute when building the graph + GraphElement rows; preserve document order in outgoing[].
3. Persistence already landed in TASK-29 (bpmn_elements condition_expression/is_default columns + definitions.ts read/write). Wire validator-produced values into createVersion rows and parsed_profile.
4. Tests: parse a model with XOR split/join -> gateway node with ordered conditional Flows; default-attribute resolution exact; bpmn_elements rows persist conditions; getVersionElements returns them; getVersionGraph deep-equal-vs-fresh-parse replay test extended to conditions + edge order; regression: linear MVP + M1 saga fixtures parse unchanged.
NOTE: at this point the validator still REJECTS gateways/conditions at publish (untouched reject matrix) — tests exercise the parser/builder directly (parseAndValidate internals or graph-construction unit level), full publish-path acceptance lands in TASK-33.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Two-stage review done. Spec review: compliant (adversarial probes on document order, best-effort graph consumers, publish gate). Quality review: With fixes -> fixed in a0fe676: (1) per-gateway default ownership — global defaultFlowIds Set replaced with Map<gatewayId,defaultFlowId> + isDefaultFlow predicate at BOTH consumption sites (outgoing edges + bpmn_elements list); foreign default ref now stays isDefault:false (probe test added); (2) tx-scoped XOR persistence round-trip test; (3) condition body stored trimmed + NOTE documenting empty/whitespace->null normalization. Re-review: approved. 171/171 green.

Key design choices: gateway nodes carry next:null (fail-fast vs accidental linear advance); ValidationResult.graph is now attached BEST-EFFORT even on ok:false (publish gate is `ok`, unchanged — verified consumers); document-order guarantee pinned by scrambled-outgoing-refs fixture at 3 layers.

Carried into TASK-33: reject default referencing missing/foreign flow (builder keeps it isDefault:false but the model must reject); empty <conditionExpression> normalizes to null -> falls in the condition-less reject bucket; remove the GET / feel canary in src/index.ts; optional semantic lint for unary-test-syntax conditions (`> 100`) which parse but never fire; consider extracting buildGraph to src/bpmn/graph-builder.ts if validator.ts crosses ~1000 lines. Carried into TASK-34: engine token loop currently SILENTLY COMPLETES on a gateway node (fallthrough) — must become explicit dispatch/incident.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Graph IR now speaks exclusiveGateway: ElementType/NodeType extended; Flow.conditionExpression (trimmed tFormalExpression body) and Flow.isDefault (per-gateway default-attr ownership via Map+predicate) are live; outgoing[] document-order = condition evaluation order, pinned by a fixture that scrambles <bpmn:outgoing> refs vs sequenceFlow element order and asserted at builder/D1/deep-equal layers. Gateway nodes carry next:null (no .next promise; engine guard lands in TASK-34). Graph building restructured into a throw-safe best-effort buildGraph closure that runs even on ok:false (publish gate `ok` unchanged — gateway models still 409). bpmn_elements rows + parsed_profile persist condition_expression/is_default via the TASK-29 plumbing; getVersionGraph deep-equal-vs-fresh-parse extended to conditions + edge order, incl. a transaction-scoped XOR. +12 tests (171/171 green). Commits e17cd33 + a0fe676.
<!-- SECTION:FINAL_SUMMARY:END -->
