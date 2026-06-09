---
id: TASK-31
title: >-
  Graph IR: exclusiveGateway node kind + live document-order conditional edges
  persisted in topology
status: To Do
assignee: []
created_date: '2026-06-09 20:29'
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
- [ ] #1 NodeType/ElementType include exclusiveGateway; parsing a model with an XOR split/join yields a gateway node whose outgoing Flows carry flowId/targetId/conditionExpression/isDefault in document order.
- [ ] #2 default-attribute resolution: Flow.isDefault is true exactly for the flow referenced by the gateway's default attribute, false elsewhere.
- [ ] #3 bpmn_elements sequenceFlow rows persist condition_expression and is_default; getVersionElements returns them; parsed_profile carries the same data.
- [ ] #4 The getVersionGraph deep-equal-vs-fresh-parse replay test is green for a published conditional model, covering conditions and outgoing-edge order.
- [ ] #5 Constitution gate: unit + integration coverage of the above; npm run test green; linear MVP and M1 saga fixtures parse unchanged (regression).
<!-- AC:END -->
