---
id: TASK-34
title: >-
  Engine: exclusiveGateway dispatch with persisted gateway_decisions and
  deterministic no-match
status: Done
assignee:
  - Claude
created_date: '2026-06-09 20:30'
updated_date: '2026-06-11 06:40'
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
- [x] #1 Data-driven branch: an integration test publishes a conditional saga and starts two instances with different variables; each takes the correct path; gateway_decisions rows record chosen_flow_id plus per-flow evaluations in document order.
- [x] #2 The default flow is taken when no condition is true, with is_default recorded in the decision row.
- [x] #3 Multiple true conditions select the first in document order — pinned by test.
- [x] #4 No-match without default → terminal incident kind=noPath; inside a transaction: Hazard semantics — no auto-compensation, and a subsequent operator /cancel compensates (integration test).
- [x] #5 Decision replay: crash/resume at a gateway reuses the persisted decision — proven by mutating variables between resume attempts and asserting the original branch is kept (both execution modes).
- [x] #6 Decision write, transition, and gatewayDecisionEvaluated history event ({chosenFlowId, occurrence, evaluations} in diagnostics) are one dbBatch; variables_snapshot is size-capped by the existing payload limit.
- [x] #7 Constitution gate: contract/integration tests above; npm run test green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: subagent-driven (implementer + spec review + quality review) on branch m2-conditional-sagas.

1. Replace the TASK-33 gw-guard arm in engine.ts with real exclusiveGateway dispatch inside one persisted step gw:${elementId}#${occ}:
   (a) decision row exists for (instance, element, occurrence) -> take chosen_flow_id, NO writes (rewalk/replay fast-forward; predicate = gateway_decisions row, NOT marker counts);
   (b) else read instance variables from D1 -> evaluate NON-default outgoing conditions in document order via evaluateCondition -> first boolean true wins -> else default -> else terminal incident kind=noPath (inside a transaction = Hazard: no auto-compensation, operator /cancel available); hard ExpressionEvaluationError -> deterministic incident;
   (c) persist decision row (plain INSERT; unique violation -> re-read and follow recorded branch, never re-evaluate) + applyTransition + gatewayDecisionEvaluated history event ({chosenFlowId, occurrence, evaluations} in diagnostics) in ONE dbBatch.
2. 1-out gateway (join/pass-through) = pass-through; do NOT evaluate any condition on its single outgoing flow (design §6; validator accepts such conditions). N-in is irrelevant (no waiting).
3. Evaluations JSON [{flowId, expression, result}] in document order; normalize FEEL values to JSON-safe before persisting (Range/DateTime/function -> representation); variables_snapshot capped by the existing payload limit (reuse the M1 check; on overflow store null/truncated marker, not an error).
4. Engine never reads .next on gateway nodes (next is null there) — chosen flow drives the cursor.
5. Tests (integration, direct mode + memoizing-harness replay): branch-by-data (two instances, different variables, different paths, decision rows with per-flow evaluations in document order); default taken + is_default recorded; first-true-wins pinned; noPath terminal incident + Hazard-in-transaction + subsequent /cancel compensates; decision replay (mutate variables between resumes -> original branch kept, BOTH modes); dbBatch atomicity; loop-through-gateway now works end-to-end (LOOP_XOR_BPMN publishes and executes N iterations -> exits via condition).
6. Replace xor-engine-guard.test.ts; fix stale 'counted by' wording in 4 MARKER comments. npm run test green; deploy dry-run.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Gateway dispatch landed as one persisted step per visit (gw:el#occ) replacing the TASK-33 gw-guard arm. Inside the idempotent body: (1) gateway_decisions row EXISTENCE for (instance, element, occurrence) is the fast-forward predicate — recorded branch followed with zero writes, never re-evaluated (proven with variables MUTATED between resumes in BOTH modes); (2) else non-default outgoing conditions evaluated in document order via evaluateCondition, first boolean true wins (short-circuit: only actually-evaluated flows are recorded in evaluations — the never-evaluated default and post-winner flows are absent by design); none true → default; no default → terminal kind=noPath (Hazard in a transaction: no auto-compensation, /cancel compensates — full chain integration-tested on a SAGA_XOR_NODEFAULT_BPMN fixture derived from SAGA_XOR_BPMN); the FIRST hard ExpressionEvaluationError aborts evaluation → deterministic incident naming flow + FEEL failure (kind=serviceTaskFailure, the established generic kind; reason text distinguishes from noPath); (3) decision row (plain INSERT) + gatewayDecisionEvaluated history + applyTransition in ONE dbBatch. Unique-violation catch re-reads and follows the winner (tested via exported decideGateway raced under Promise.all — both check-first SELECTs dispatch before either batch; loser's batch abort proven atomic: 1 row + 1 history event); /UNIQUE/i match + confirmed-winner guard keeps other batch failures propagating.

PASS-THROUGH (1-out) decision: uniform decision row (single flow chosen, evaluations [], snapshot null), NOT a cheaper marker — the occurrence-keyed row is exactly the per-visit rewalk predicate a cycle needs (pinned by a cycle-through-1-out-join test: each visit fast-forwards its own row), one code path + one race contract for split and join, uniform audit invariant. Conditions on a single flow are never evaluated (pinned with a false condition).

FEEL values normalized JSON-safe before persisting (booleans/strings/finite numbers/null as-is; else [feel:Type] tag — Range pinned by test). variables_snapshot capped by the M1 payload limit: oversized context stored as NULL + variablesSnapshotOmitted diagnostics flag, never an error (tested at 1.1MB via injected instance). Engine never reads .next on gateways. 4 stale MARKER comments reworded to existence-based phrasing. xor-engine-guard.test.ts deleted, replaced by xor-gateway.test.ts (12 tests) + xor-replay-workflow.test.ts (memoizing-harness crash-after-commit-at-gateway replay). LOOP_XOR_BPMN now publishes AND executes end-to-end (2 loop iterations, exit via default).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
exclusiveGateway dispatch (design §6): one persisted step per visit; gateway_decisions row existence = replay predicate (never re-evaluate — proven with mutated variables in both direct-rewalk and workflow-memoization modes); document-order first-true-wins with short-circuited evaluations trace; default → is_default; no default → terminal noPath Hazard (no auto-compensation; operator /cancel compensates, full chain tested); hard FEEL error → deterministic operator-visible incident naming the flow. Decision + history + transition in one dbBatch; plain-INSERT race absorbed by re-read-and-follow (raced deterministically in test). Pass-through (1-out) = uniform decision row, condition ignored, cycle-safe per occurrence. FEEL values JSON-safe-normalized; variables_snapshot payload-capped to NULL+flag. Suite: 225/225 ×2 (213 baseline − 1 replaced guard test + 13 new); typecheck + wrangler dry-run clean. Existing tests edited: zero (guard test deleted as planned).
<!-- SECTION:FINAL_SUMMARY:END -->
