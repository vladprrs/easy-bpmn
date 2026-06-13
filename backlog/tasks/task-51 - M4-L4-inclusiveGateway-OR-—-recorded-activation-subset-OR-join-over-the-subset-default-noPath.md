---
id: TASK-51
title: >-
  M4-L4: inclusiveGateway OR — recorded activation subset, OR-join over the
  subset, default/noPath
status: Done
assignee:
  - Vlad Pr
created_date: '2026-06-13 08:55'
updated_date: '2026-06-13 13:33'
labels:
  - saga
  - engine
  - m4
milestone: m-4
dependencies:
  - TASK-50
documentation:
  - docs/superpowers/plans/2026-06-13-m4-concurrency.md
  - docs/superpowers/specs/2026-06-13-m4-concurrency-design.md
modified_files:
  - tests/integration/inclusive-gateway.test.ts
  - src/persistence/gateway-decisions.ts
  - src/runtime/regions-runtime.ts
  - src/runtime/frontier.ts
  - tests/helpers.ts
priority: medium
ordinal: 21400
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-27** (M4 — Concurrency), milestone `m-4`. Layer task M4-L4; do after M4-L3 (TASK-50)._

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
- [x] #1 L4.1: insertGatewayDecisionStmt accepts an optional activatedFlowIds?: string[]|null bound into a new activated_flow_ids column; GatewayDecisionRow, GatewayDecisionView and mapGatewayDecision round-trip it (JSON array ⇄ string[], NULL ⇒ null); npm run typecheck passes.
- [x] #2 L4.1 backward-compat: existing XOR (engine.ts) and EBG (event-gateway.ts) callers omit activatedFlowIds and bind NULL; no XOR/EBG behaviour change (existing exclusiveGateway and eventBasedGateway integration tests still pass).
- [x] #3 L4.2: resolveActivatedFlows for an OR region reuses the recorded activatedFlowIds verbatim when a gateway_decisions row exists for (instance,split,occurrence) (never re-evaluates); else evaluates each non-default out-flow's FEEL condition in document order vs the token-resolved scope, falls back to default when the true set is empty, and returns recordStmts (a plain INSERT of the decision row carrying activatedFlowIds) for atomic commit inside the fan-out batch.
- [x] #4 L4.2: an OR split with no true condition and no default raises terminal noPath; a FEEL evaluation error at the split raises conditionFailure; both bail the branch (no token silently dropped). requiredFlowsFor returns the recorded subset filtered to region.branchFlowIds in stored document order (AND returns all branchFlowIds); the OR-join waits for exactly that subset keyed by origin branch (blocker 7).
- [x] #5 L4.2: the DFS driver (frontier.ts) wires resolveActivatedFlows' recordStmts into fanOutSplit's extraStmts so the activation record + branch tokens commit in one atomic batch, and bails the branch when incident is true; tests/integration/inclusive-gateway.test.ts passes three scenarios on INCLUSIVE_BPMN (added to tests/helpers.ts): email-only ⇒ activatedFlowIds===['f_email']; email+sms ⇒ sorts to ['f_email','f_sms']; neither ⇒ ['f_def'] (default); all complete.
- [x] #6 L4.3: a guard test asserts the OR-join produces exactly one output token and never forks a non-activated branch (wantsSms=false ⇒ no send-sms job appears in instance history); instance completes.
- [x] #7 L4.3: the empty-recorded-subset path is documented as unreachable-by-construction (validator guarantees default-or-noPath, so a fanned-out OR region always yields ≥1 branch) with an in-line comment confirming joinBarrierSatisfied([]) returns true for any future relaxation — no dedicated empty-subset code branch is added.
- [x] #8 L4 gate: npm run typecheck && npm run test && npm run check:docs all PASS; OR concurrency runs end-to-end (recorded activation, subset join, default, noPath, conditionFailure, no double-produce).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Implementation plan (TDD; design §6, plan Phase L4 lines 1953-2133)

Ground truth verified against the shipped L3 code:
- `migrations/0007_tokens.sql:52` ALREADY adds `gateway_decisions.activated_flow_ids` (column exists).
- `tests/helpers.ts:819` `INCLUSIVE_BPMN` ALREADY exists (fork: f_email `wantsEmail=true`, f_sms `wantsSms=true`, f_def default → Email/Sms/Log → OR join → E).
- `src/bpmn/regions.ts:218` builds `branchFlowIds` from ALL split out-flows incl. default (filter works for the default case).
- `src/runtime/forward-task.ts:279` records `diagnostics.taskType` for serviceTask (AC#6 guard is robust).
- GAP: sample workers `send-email`/`send-sms`/`log-only` are NOT registered → `drainSampleWorkers` would fail them. Add three trivial completer sample workers (test stand-in, mirrors `release-stock`).

### TDD cycles
1. **RED** — create `tests/integration/inclusive-gateway.test.ts` with 4 tests (email-only→['f_email']; email+sms→['f_email','f_sms']; neither→['f_def']; guard: wantsSms=false ⇒ no send-sms in history, single produce). All fail (L3 OR stub throws).
2. **GREEN**
   - **L4.1** `src/persistence/gateway-decisions.ts`: add `activatedFlowIds?: string[]|null` to `insertGatewayDecisionStmt` input + `activated_flow_ids` column; `GatewayDecisionRow.activated_flow_ids`, `GatewayDecisionView.activatedFlowIds`, `mapGatewayDecision` round-trip (JSON⇄string[], NULL⇒null). XOR(engine.ts)/EBG(event-gateway.ts) callers omit it ⇒ bind NULL (no behaviour change).
   - **L4.2** `src/runtime/regions-runtime.ts`: rewrite `resolveActivatedFlows` → returns `{activated, recordStmts, incident?}`, accepts `activeTokenId`; reuse recorded `activatedFlowIds` verbatim (never re-evaluate) else evaluate non-default out-flow FEEL in doc order vs token-resolved scope, default fallback, `noPath`/`conditionFailure` terminal incidents; emit `recordStmts` (plain INSERT of the decision row carrying `activatedFlowIds`). `requiredFlowsFor` → recorded subset filtered to `branchFlowIds` in stored order.
   - `src/runtime/frontier.ts`: wire `recordStmts` into `fanOutSplit` `extraStmts` (atomic batch); bail branch when `incident`.
   - `src/runtime/service-task.ts`: register `send-email`/`send-sms`/`log-only` completer workers (test infra).
3. **REFACTOR / L4.3** — in-line comment documenting empty-subset unreachable-by-construction (`joinBarrierSatisfied([])`===true); L4 gate `npm run typecheck && npm run test && npm run check:docs`.

### Scope note
Adding 3 trivial sample workers to `service-task.ts` is beyond the task's listed modified_files but is test-support infra required to drive the OR integration tests via `drainSampleWorkers` (the plan's test code). Flagged here, not silently expanded.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
GREEN (TDD): implemented L4.1 (gateway-decisions.ts activated_flow_ids read/write), L4.2 (regions-runtime.ts resolveActivatedFlows→{activated,recordStmts,incident}, requiredFlowsFor recorded-subset filter, fanOutSplit extraStmts; frontier.ts driver wiring incl. incident bail), L4.3 (joinBarrierSatisfied empty-subset comment), + 3 trivial sample workers (send-email/send-sms/log-only). Tests: tests/integration/inclusive-gateway.test.ts — 6 passing (email-only→['f_email']; email+sms→['f_email','f_sms']; neither→['f_def']/isDefault; single-produce guard; noPath via published no-default fixture; conditionFailure via injected OR graph). Gate: npm run typecheck ✓; npm run test 55 files / 398 tests ✓ (XOR/EBG unchanged); npm run check:docs ✓. Running a 3-lens adversarial review workflow before commit.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## TASK-51 (M4-L4 inclusiveGateway OR) — complete

A published `inclusiveGateway` (OR) model now executes end-to-end in direct mode: subset fan-out, OR-join over the recorded subset, default fallback, and the terminal `noPath`/`conditionFailure` incidents — XOR/EBG behaviour provably unchanged, replay determinism preserved.

### Shipped (commits 6d317df, 0da21e7)
- **L4.1** `src/persistence/gateway-decisions.ts` — `activated_flow_ids` read/write: `insertGatewayDecisionStmt` optional `activatedFlowIds`, `GatewayDecisionRow`/`GatewayDecisionView`/`mapGatewayDecision` round-trip (JSON⇄string[], NULL⇒null). XOR(engine.ts)/EBG(event-gateway.ts) omit it ⇒ bind NULL. (Column itself was added in L2's `0007_tokens.sql`.)
- **L4.2** `src/runtime/regions-runtime.ts` — `resolveActivatedFlows` → `{activated, recordStmts, incident}`: recorded-verbatim fast-forward (never re-evaluate, §6.1); else doc-order FEEL eval vs token-resolved scope, default fallback, `noPath`/`conditionFailure` terminal-incident bail; `recordStmts` = plain INSERT of the decision row (activatedFlowIds + size-capped resolved `variables_snapshot`). `requiredFlowsFor` → recorded subset filtered to `branchFlowIds` in stored doc order. `fanOutSplit` gains `extraStmts` so the activation record commits atomically with the branch tokens (shared race claim). `joinBarrierSatisfied` empty-subset note (unreachable-by-construction; `[].every`===true).
- `src/runtime/frontier.ts` — DFS driver split handler: passes the active token as eval scope, bails the branch on a split incident, wires `recordStmts` → `fanOutSplit`.
- `src/runtime/service-task.ts` — `send-email`/`send-sms`/`log-only` sample completers (test stand-in; flagged scope addition).

### Tests — `tests/integration/inclusive-gateway.test.ts` (7, all green)
email-only⇒['f_email']; email+sms⇒['f_email','f_sms']; neither⇒['f_def']/isDefault; single-produce + non-activated-branch isolation guard; **rewalk-never-re-evaluate** (variables mutated after the split decided ⇒ subset unchanged); **noPath** (published no-default fixture); **conditionFailure** (injected OR graph).

### Verification
- TDD: 7 tests written RED (OR stub threw), implemented to GREEN.
- Gate (AC #8): `npm run typecheck` ✓ · `npm run test` 55 files / **399 tests** ✓ (XOR/EBG/parallel unchanged) · `npm run check:docs` ✓.
- 3-lens adversarial review (replay-determinism / AC-conformance / edge-compat, 7 agents, independent per-finding verification): **0 blockers, 0 majors**. 3 confirmed minor/nit findings all folded in — (1) record the size-capped resolved `variables_snapshot` for OR splits (audit parity, §5.7); (2) correct the false "validator forces a default" comment (default is OPTIONAL; zero activation bails as a terminal incident before fan-out); (3) added the rewalk-never-re-evaluate determinism test.

### Blocker 7 (origin-branch keyed barrier)
Resolved: each branch token carries its `branch_flow_id` for the region's life; `requiredFlowsFor` filters the recorded subset by `branchFlowIds`, and the join waits on `join_arrivals` keyed by `branch_flow_id` — not by incoming flow.

### Scope note
Added 3 trivial sample workers to `src/runtime/service-task.ts` (beyond the listed modified_files) as test-support infra to drive the OR integration tests via `drainSampleWorkers`. Two commits not pushed (feature branch `m4-concurrency`); not L4's job to push.
<!-- SECTION:FINAL_SUMMARY:END -->
