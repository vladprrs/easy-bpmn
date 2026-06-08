---
id: TASK-17
title: >-
  Engine: scope-aware interpreter with transaction scopes and per-node-kind
  dispatch
status: To Do
assignee: []
created_date: '2026-06-08 08:18'
labels:
  - saga
  - engine
  - runtime
  - bpmn
  - architecture
  - tests
milestone: m-1
dependencies:
  - TASK-11
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#42-engine-srcruntimeenginets--scope-aware-interpreter
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#41-graph-ir-srcbpmngraphts
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#10-risks
  - src/runtime/engine.ts
  - src/runtime/executor.ts
  - src/workflows/process-workflow.ts
  - src/bpmn/graph.ts
  - src/persistence/instances.ts
  - migrations/0001_mvp_schema.sql
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/07-execution-semantics.md
  - docs/bpmn/09-easy-bpmn-profile.md
modified_files:
  - src/runtime/engine.ts
  - src/persistence/saga.ts
  - tests/unit/engine-interpreter.test.ts
  - tests/integration/transaction-scope.test.ts
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
priority: high
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
M1 turns easy-bpmn from a linear MVP into a transaction-saga orchestrator (design §1, §8 M1; risk R1 §10). Today the engine drives an instance with a scalar-cursor if-chain loop (src/runtime/engine.ts:96-179): one `cur` walks `node.next` through a hard-coded if/else per node.type. That structure blocks every saga construct (transaction scope, boundary/cancel/compensate events, later parallelism).

This task delivers only the structural seam (design §4.2): replace the if-chain with a scope-aware interpreter whose node handling is a registry keyed by node kind — the single extension point that sibling M1 tasks (Service-Task-as-wait, compensation pass, cancel/error boundary) and M2–M4 plug into. Entering a bpmn:transaction pushes a scope frame holding that scope's in-scope saga-ledger slice (saga_steps for scope_id, §5); a none endEvent inside the transaction commits, pops the frame, and follows the transaction node's outgoing flow. Forward execution stays single-token in M1 (design §3: an interrupting boundary redirects the one token, it is not a split).

Hard constraint (R1): keep the runStep/waitFor ports (engine.ts:50-55) and the DirectExecutor inline harness (executor.ts:40-57) intact so primitives stay unit-testable without the Workflow runtime and process-workflow.ts (step.do/step.waitForEvent) needs no edit. Compensation/cancel semantics are delegated to registered handlers built in the sibling tasks; this task is structural and must not regress the live linear flow. Depends on the graph-IR scope/boundary fields and the saga_steps migration.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The `loop` in src/runtime/engine.ts:96-179 is replaced by a dispatch registry keyed by node kind; each supported kind (startEvent, serviceTask, receiveTask, endEvent, transaction, boundaryEvent) resolves to a registered handler returning a discriminated outcome (advance | wait | enterScope | commitScope | incident). No hard-coded if/else chain on node.type remains.
- [ ] #2 Entering a bpmn:transaction pushes a scope frame onto an explicit frame stack carrying scope_id and the in-scope saga-ledger slice (saga_steps rows for instance_id+scope_id, design §4.2/§5) and writes a `transactionEntered` history event; a none endEvent inside the transaction commits the scope, pops the frame, and advances the token along the transaction node's outgoing sequence flow.
- [ ] #3 The RunStep/WaitForEvent port signatures (engine.ts:50-55) and the runInstance signature (engine.ts:86) are unchanged; both drivers still wire them unchanged — ProcessWorkflow via step.do/step.waitForEvent (src/workflows/process-workflow.ts:21-39) and DirectExecutor via the inline step (src/runtime/executor.ts:43-56); process-workflow.ts is not edited.
- [ ] #4 An unsupported/unregistered node kind reaching the interpreter raises a deterministic incident carrying the element id and reason, instead of the current silent `return {status:"completed"}` fallthroughs (engine.ts:110 and :177).
- [ ] #5 Forward execution remains single-token inside and outside the transaction (design §3, 'M1 keeps single-token'); no parallel/concurrent token set is introduced.
- [ ] #6 Constitution gate (integration test): a new vitest @cloudflare/vitest-pool-workers test (tests/integration/transaction-scope.test.ts) runs a definition with a bpmn:transaction whose linear forward body reaches a none end event, and asserts the scope frame is pushed on entry, a `transactionEntered` history row is recorded, the none end commits/pops the frame, and the token then follows the transaction's outgoing flow to the outer end. A DirectExecutor unit test (tests/unit/engine-interpreter.test.ts) exercises registry dispatch for every node kind inline (no Workflow runtime).
- [ ] #7 Regression + docs: `npm run test` stays green — the live linear Start→ServiceTask→ReceiveTask→End flow and the quickstart MVP demo scenario are unchanged through the new interpreter; the engine.ts module doc (lines 1-11) and design doc §4.2 are updated to describe the implemented dispatch-registry + scope-frame contract.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Prereqs (other M1 tasks): graph-IR scope/boundary fields in src/bpmn/graph.ts (§4.1 — transaction.scope{startId,childIds,compensations}, boundaryEvent.kind/attachedToRef, GraphNode.outgoing) and migrations/0002_saga.sql saga_steps (§5). If unmerged, gate reads behind the new node-kind enum.
2. In src/runtime/engine.ts define `NodeOutcome = {advance:next} | {wait} | {enterScope:txId} | {commitScope} | {incident}` and `NodeHandler = (ctx)=>Promise<NodeOutcome>`; build a `Record<NodeKind,NodeHandler>` registry. Move each if-branch body (engine.ts:112-175) into a handler: startEvent→enterStart; serviceTask→runServiceTask (keep ServiceTaskOutcome mapping at :213); receiveTask→register/wait/applyMessage; endEvent→completeInstance.
3. Replace `loop` (engine.ts:96-179) with an interpreter holding {cur, pending, frames:ScopeFrame[]}; per iteration resolve graph.nodes[cur] kind → registry → apply outcome (advance sets cur=next via runStep; wait calls waitFor; enterScope pushes a frame; commitScope pops + sets cur to the transaction node's outgoing target).
4. Add the transaction handler: on enter push ScopeFrame{scopeId, ledgerSlice} loaded from saga_steps via a new read in src/persistence/saga.ts, write `transactionEntered` history (§5), descend to scope.startId. Register a boundaryEvent slot that delegates to handlers owned by the compensation / cancel-boundary tasks (seam only — no compensation logic here).
5. Replace the silent `return {status:"completed"}` fallthroughs (engine.ts:110 and :177) with an explicit unsupported-kind → createServiceTaskIncident(elementId, reason).
6. Keep RunStep/WaitForEvent (engine.ts:50-55), runInstance (:86) and executor.ts/process-workflow.ts wiring untouched; confirm the DirectExecutor inline step drives every kind.
7. Tests: tests/unit/engine-interpreter.test.ts (registry dispatch + scope push/pop via DirectExecutor); tests/integration/transaction-scope.test.ts (commit path); run `npm run test` for regression.
8. Update engine.ts module doc (lines 1-11) and design §4.2 to match the final handler-outcome contract.
<!-- SECTION:PLAN:END -->
