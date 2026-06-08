---
id: TASK-11
title: >-
  Graph IR and BPMN builder: multi-edge, transaction scope,
  boundary/association, persisted queryable topology
status: To Do
assignee: []
created_date: '2026-06-08 08:17'
labels:
  - saga
  - bpmn
  - graph-ir
  - persistence
  - m1
  - tests
milestone: m-1
dependencies:
  - TASK-9
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#41-graph-ir-srcbpmngraphts
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#3-the-canonical-saga-contract-how-a-saga-is-drawn-in-bpmn
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#5-data-model-deltas
  - 'src/bpmn/graph.ts:26-48'
  - 'src/bpmn/validator.ts:116-144'
  - 'src/bpmn/validator.ts:265-300'
  - 'src/bpmn/validator.ts:306-336'
  - 'src/bpmn/profile.ts:7-14'
  - 'src/persistence/definitions.ts:106-202'
  - 'migrations/0001_mvp_schema.sql:36-64'
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/04-flows-and-data.md
  - docs/bpmn/06-xml-serialization.md
  - specs/002-saga-orchestrator/data-model.md
modified_files:
  - src/bpmn/graph.ts
  - src/bpmn/validator.ts
  - src/bpmn/profile.ts
  - src/persistence/definitions.ts
  - src/contracts/api.ts
  - migrations/0002_topology.sql
  - tests/unit/bpmn-validator.test.ts
  - tests/integration/saga-topology.test.ts
priority: high
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the canonical BPMN transaction-saga of design §3 parses into a structured, scope-aware execution graph whose topology is persisted both as the parsed_profile JSON and as queryable D1 rows. This is the prerequisite for the scope-aware compensation engine (design §4.2); without it the engine cannot derive the reverse-order compensation graph deterministically.

Today the IR is strictly linear: GraphNode carries only `next: string|null` (src/bpmn/graph.ts:32-34); the builder rejects >1 outgoing flow (src/bpmn/validator.ts:271-277) and takes only the first successor at :316; and crucially sequence-flow source/target plus ALL association wiring are DROPPED — validator.ts:331-333 writes sequenceFlow elements with no refs and definitions.ts:137-155 never persists them. Topology is therefore non-queryable and replay-nondeterministic.

Per design §4.1 the IR must gain (no runtime/engine behavior change in this task): GraphNode.outgoing: Flow[] where Flow={flowId,targetId,conditionExpression?,isDefault?} (M1 keeps ≤1 token-path successor); node kinds `transaction` and `boundaryEvent` (kind error|cancel|compensate + attachedToRef); endEvent.kind none|cancel|compensate; isForCompensation on service-task nodes; an association map (boundaryId→handlerId); and per-transaction scope {startId, childIds[], compensations: Record<activityId,{handlerId,boundaryId}>}. Compensation boundaries and isForCompensation handlers must NOT sit on the token path. Sequence-flow source/target and associations become persisted (both in parsed_profile and as bpmn_elements rows). Depends on M0 having flipped the validator whitelist to accept the M1 saga set; this task owns producing the structured IR and persisting topology.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/bpmn/graph.ts: GraphNode exposes `outgoing: Flow[]` (Flow={flowId,targetId,conditionExpression?,isDefault?}); ElementType/NodeType widened with `transaction`, `boundaryEvent`, `association`, `error`; endEvent.kind ('none'|'cancel'|'compensate'), boundaryEvent.kind ('error'|'cancel'|'compensate') + attachedToRef, and isForCompensation are present; ExecutionGraph carries an `associations` map and each transaction node a `scope {startId, childIds[], compensations}`. `npm run build`/tsc is green with all callers updated.
- [ ] #2 For the design §3 order-saga XML, a unit test asserts the built graph: forward nodes' outgoing[] carry the correct flowId+targetId (f1..f4, g1..g3); the Tx_order transaction node's scope.childIds includes Tx_start/reserveStock/chargeCard/confirmShipping/Tx_ok/Tx_cancel and the comp boundaries+handlers; scope.compensations maps reserveStock→{handlerId:releaseStock,boundaryId:reserveStock_comp} and chargeCard→{handlerId:refundCard,boundaryId:chargeCard_comp}; boundaryEvent nodes carry kind+attachedToRef (reserveStock_comp/chargeCard_comp=compensate, shipping_err=error, Tx_cancelled=cancel); isForCompensation is true on releaseStock/refundCard; endEvent kinds are none(Tx_ok)/cancel(Tx_cancel).
- [ ] #3 Compensation boundary events (reserveStock_comp, chargeCard_comp) and isForCompensation handlers (releaseStock, refundCard) are NOT placed on any node's token-path outgoing[] and are NOT flagged unreachable by the reachability walk (validator.ts:278-300) despite having no incoming sequenceFlow — covered by an explicit unit assertion.
- [ ] #4 Negative/edge unit cases: a compensate boundary event carrying an outgoing sequenceFlow is rejected with element id + reason; a compensate boundary with zero or >1 outgoing <association> is rejected with element id + reason; an <association> whose targetRef is not an isForCompensation activity in the same transaction scope is rejected with element id + reason.
- [ ] #5 Integration (constitution persistence gate): publishing the §3 saga then reading back persists topology — sequenceFlow rows expose sourceRef/targetRef and association rows expose source/target (boundaryId→handlerId), no longer NULL/dropped (verifies the validator.ts:331-333 + definitions.ts:137-155 gap is closed).
- [ ] #6 Integration (replay determinism): getVersionGraph (definitions.ts:170-177) on the published version returns a parsed_profile ExecutionGraph whose nodes[].outgoing[], per-transaction scope, and associations exactly match the freshly-parsed graph (deep-equal round-trip).
- [ ] #7 The topology persistence migration is additive and idempotent, never mutates published versions, and applies cleanly via `npx wrangler d1 migrations apply easy_bpmn --local`; its sequence number does not collide with the saga-ledger migration (M1 task #3).
- [ ] #8 Docs updated: the realized IR shape (outgoing[]/scope/associations + persisted topology) is documented in specs/002-saga-orchestrator/data-model.md (or design §4.1 if 002 is not yet scaffolded), and docs/bpmn/04-flows-and-data.md / 09-easy-bpmn-profile.md reflect that sequence-flow refs and compensation associations are now retained.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/bpmn/graph.ts: add `Flow` interface; give GraphNode `outgoing: Flow[]` (drop scalar `next` or expose it as a derived convenience and update every reader); widen ElementType/NodeType with transaction|boundaryEvent|association|error; add endEvent.kind, boundaryEvent {kind,attachedToRef}, isForCompensation (service-task nodes); add `associations: Record<flowId,{boundaryId,handlerId}>` to ExecutionGraph and a `scope` field on transaction nodes.
2. src/bpmn/profile.ts: register bpmn:Transaction + bpmn:BoundaryEvent; add ASSOCIATION_TYPE and event-definition local-name helpers (Compensate/Cancel/Error) used to discriminate boundary/end kinds.
3. src/bpmn/validator.ts — the IR builder (parser.ts needs no change; bpmn-moddle already parses these standard types):
   - Read bpmn:Error from rootElements (mirror messageNamesById at :85-89) into an errorsById catalog.
   - Recurse ONE level into the transaction container: its children are in transaction.flowElements and its wiring in transaction.artifacts (associations are Artifacts, NOT in flowElements — note :116 only reads proc.flowElements; boundaryEvent IS a flowElement).
   - Classify boundaryEvent by eventDefinitions[0].$type; set attachedToRef from el.attachedToRef; classify endEvent.kind from its eventDefinition.
   - Build outgoing[] from the collected flows (replace the single `[0]` successor at :316).
   - Build scope.childIds and scope.compensations by joining boundary(attachedToRef=activity) → association(sourceRef=boundary, targetRef=handler).
   - Exclude compensation boundaries/handlers from token-path outgoing[] and from the reachability walk (:278-300) so isForCompensation handlers aren't reported unreachable.
4. Persistence: emit sequenceFlow elements with sourceRef/targetRef and association elements (replace bare push at :331-336). Add additive migration migrations/000N_topology.sql adding source_ref/target_ref to bpmn_elements (0001:54-64 has only an unused metadata col); coordinate the number with the saga-ledger migration. Update definitions.ts createVersion INSERT (:141-153) to write the refs and getVersionElements SELECT+mapper (:179-201) to read them back.
5. Add tests/unit (saga IR shape + negatives) and tests/integration/saga-topology.test.ts (publish→readback + getVersionGraph round-trip). Update docs.
<!-- SECTION:PLAN:END -->
