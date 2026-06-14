---
id: TASK-27.4
title: >-
  M4-L4: inclusiveGateway OR — recorded activation subset, OR-join over the
  subset, default/noPath
status: To Do
assignee: []
created_date: '2026-06-13 08:49'
updated_date: '2026-06-13 08:52'
labels:
  - saga
  - engine
  - m4
milestone: m-4
dependencies: []
documentation:
  - docs/superpowers/plans/2026-06-13-m4-concurrency.md
  - docs/superpowers/specs/2026-06-13-m4-concurrency-design.md
modified_files:
  - tests/integration/inclusive-gateway.test.ts
  - src/persistence/gateway-decisions.ts
  - src/runtime/regions-runtime.ts
  - src/runtime/frontier.ts
  - tests/helpers.ts
parent_task_id: TASK-27
priority: medium
ordinal: 21400
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Outcome & value

**Layer L4 of M4 (concurrency)** for `easy-bpmn`. Builds directly on L3 (parallelGateway AND); implement **only after L1–L3 are merged** — L4 reuses the L3 frontier rewalk, `fanOutSplit`, the `join_arrivals`/`join_completions` claim facts, and `regions-runtime.ts`.

What L4 ships: a published `inclusiveGateway` (OR) model executes end-to-end in direct mode. At an OR split the engine evaluates each non-default out-flow's FEEL condition in document order against the token-resolved scope, **activates exactly the true subset**, falls back to the gateway's `default` flow when none is true, and raises the terminal **`noPath`** incident when there is neither a true branch nor a default (an inclusive split never silently drops its token). The activated subset is **recorded** in `gateway_decisions.activated_flow_ids` (JSON, document order) as part of the same atomic fan-out batch, sharing the fan-out's race claim. The matching OR-join then waits for **exactly that recorded subset, keyed by origin branch** (each token carries the split out-flow it descended from; internal XOR routing/cycles never change it), then merges + fires via the same `join_completions` claim as AND. A FEEL evaluation error at the split raises `conditionFailure`. The OR-join produces its single output token exactly once and never waits for a non-activated branch.

Value: OR concurrency (subset fan-out + subset join) becomes executable while XOR/EBG behaviour is provably unchanged, and replay determinism is preserved (recorded activation reused verbatim on rewalk, never re-evaluated).

## Critical mode/scope notes (carry verbatim)

- **Backward-compat for XOR/EBG (L4.1).** Every existing `insertGatewayDecisionStmt` caller — XOR in `engine.ts`, EBG in `event-gateway.ts` — omits `activatedFlowIds`, so it binds `null` (the column default). **No behaviour change for XOR/EBG.** `activated_flow_ids` is NULL for XOR/EBG, a JSON document-order array only for inclusive splits.
- **Rewalk discipline = never re-evaluate (design §6.1).** On rewalk, if a `gateway_decisions` row exists for `(instance, split, occurrence)`, its recorded `activatedFlowIds` is reused verbatim as a fast-forward predicate — conditions are **never** re-evaluated even if variables changed (same contract as `exclusiveGateway` in M2). The recorded activation row is part of the fan-out batch, so the activation record + branch tokens commit atomically (plain-INSERT race claim: a losing fan-out aborts wholesale and re-reads).
- **Zero-activation is unreachable-by-construction at runtime (L4.3, design §6.4).** §6.4 says "an OR-join whose recorded activated subset is empty produces its single output token immediately." But the L1 validator requires a `default` or the split raises `noPath`, so **a fanned-out OR region always yields ≥1 branch — the empty-subset path is unreachable by construction and needs no special case.** `joinBarrierSatisfied([])` already returns `true` should a future relaxation allow empty activation; confirm + document this with an in-line comment rather than a dedicated code branch.

## References (read before starting)

- Plan: `docs/superpowers/plans/2026-06-13-m4-concurrency.md`, **Phase L4 (lines 1953-2133)**. Conventions: 13-36. File Structure: 39-84.
- Design (authoritative — design wins): `docs/superpowers/specs/2026-06-13-m4-concurrency-design.md` — **§6 "Inclusive (OR) gateway specifics (L4)"** (split activation, schema, OR-join, zero-activation), §5.4 (split fan-out / origin-branch barrier facts), §7 (the `activated_flow_ids` column itself lands in L2's `0007_tokens.sql`; L4 reads/writes it), and the §6 origin-branch-keyed barrier note resolving **blocker 7**.

Follow the per-step plan instructions verbatim (statement-builder shape, `resolveActivatedFlows`/`requiredFlowsFor`, the DFS-driver `recordStmts`→`fanOutSplit` `extraStmts` wiring). Do not re-derive.

## Work breakdown (constituent Task L4.Y items)

- **L4.1** Add `activated_flow_ids` read/write to `src/persistence/gateway-decisions.ts` (INSERT column + input field, `GatewayDecisionRow`/`GatewayDecisionView`/`mapGatewayDecision`); preserve XOR/EBG NULL-binding backward-compat.
- **L4.2** OR activation + OR-join-over-the-subset in `src/runtime/regions-runtime.ts` (`resolveActivatedFlows`, `requiredFlowsFor`); wire activation `recordStmts` into the DFS driver's `fanOutSplit` `extraStmts` (`frontier.ts`); add `INCLUSIVE_BPMN` fixture to `tests/helpers.ts`; write the failing→passing OR integration tests.
- **L4.3** Single-produce / non-activated-branch-isolation guard test; document the unreachable-by-construction empty-subset path; run the L4 layer gate.

## Carried design blockers

- **7** origin-branch keyed barrier (OR-join waits for the recorded activated subset keyed by `branch_flow_id`, not by incoming flow).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 L4.1: insertGatewayDecisionStmt accepts an optional activatedFlowIds?: string[]|null bound into a new activated_flow_ids column; GatewayDecisionRow, GatewayDecisionView and mapGatewayDecision round-trip it (JSON array ⇄ string[], NULL ⇒ null); npm run typecheck passes.
- [ ] #2 L4.1 backward-compat: existing XOR (engine.ts) and EBG (event-gateway.ts) callers omit activatedFlowIds and bind NULL; no XOR/EBG behaviour change (existing exclusiveGateway and eventBasedGateway integration tests still pass).
- [ ] #3 L4.2: resolveActivatedFlows for an OR region reuses the recorded activatedFlowIds verbatim when a gateway_decisions row exists for (instance,split,occurrence) (never re-evaluates); else evaluates each non-default out-flow's FEEL condition in document order vs the token-resolved scope, falls back to default when the true set is empty, and returns recordStmts (a plain INSERT of the decision row carrying activatedFlowIds) for atomic commit inside the fan-out batch.
- [ ] #4 L4.2: an OR split with no true condition and no default raises terminal noPath; a FEEL evaluation error at the split raises conditionFailure; both bail the branch (no token silently dropped). requiredFlowsFor returns the recorded subset filtered to region.branchFlowIds in stored document order (AND returns all branchFlowIds); the OR-join waits for exactly that subset keyed by origin branch (blocker 7).
- [ ] #5 L4.2: the DFS driver (frontier.ts) wires resolveActivatedFlows' recordStmts into fanOutSplit's extraStmts so the activation record + branch tokens commit in one atomic batch, and bails the branch when incident is true; tests/integration/inclusive-gateway.test.ts passes three scenarios on INCLUSIVE_BPMN (added to tests/helpers.ts): email-only ⇒ activatedFlowIds===['f_email']; email+sms ⇒ sorts to ['f_email','f_sms']; neither ⇒ ['f_def'] (default); all complete.
- [ ] #6 L4.3: a guard test asserts the OR-join produces exactly one output token and never forks a non-activated branch (wantsSms=false ⇒ no send-sms job appears in instance history); instance completes.
- [ ] #7 L4.3: the empty-recorded-subset path is documented as unreachable-by-construction (validator guarantees default-or-noPath, so a fanned-out OR region always yields ≥1 branch) with an in-line comment confirming joinBarrierSatisfied([]) returns true for any future relaxation — no dedicated empty-subset code branch is added.
- [ ] #8 L4 gate: npm run typecheck && npm run test && npm run check:docs all PASS; OR concurrency runs end-to-end (recorded activation, subset join, default, noPath, conditionFailure, no double-produce).
<!-- AC:END -->
