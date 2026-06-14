---
id: TASK-27.1
title: 'M4-L1: Governance, profile flip, SESE region validator (publish-time only)'
status: To Do
assignee: []
created_date: '2026-06-13 08:46'
labels:
  - saga
  - engine
  - m4
milestone: m-4
dependencies: []
references:
  - .specify/memory/constitution.md
  - specs/002-saga-orchestrator/m3-constitution-check.md
documentation:
  - docs/superpowers/plans/2026-06-13-m4-concurrency.md
  - docs/superpowers/specs/2026-06-13-m4-concurrency-design.md
modified_files:
  - src/bpmn/regions.ts
  - tests/unit/regions.test.ts
  - specs/002-saga-orchestrator/m4-constitution-check.md
  - .specify/memory/constitution.md
  - src/bpmn/profile.ts
  - src/bpmn/graph.ts
  - src/bpmn/validator.ts
  - docs/bpmn/03-gateways.md
  - docs/bpmn/07-execution-semantics.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - scripts/check-docs.mjs
  - tests/helpers.ts
  - tests/unit/bpmn-validator.test.ts
parent_task_id: TASK-27
priority: medium
ordinal: 21100
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Outcome & value

First layer of milestone **M4 (in-instance concurrency)** for the `easy-bpmn` saga orchestrator. After this layer ships, a published BPMN file using `bpmn:parallelGateway` (AND) or `bpmn:inclusiveGateway` (OR) is **accepted-and-validated** when its concurrent region is block-structured (single-entry / single-exit, SESE), and **rejected with element-id + reason** when it is not (no matching join, mismatched join type, branch escaping the region, uncontrolled merge inside the region, non-laminar nesting, or two concurrent branches awaiting the same message name). The validator records a `regions` map into the graph IR (`parsed_profile`) so later layers never recompute split↔join matching or branch order at runtime.

Value: widens the publish profile and the governing constitution to the M4 accepted-set, and lands the load-bearing pure publish-time analysis every later concurrency layer depends on — **without touching the runtime**.

## Critical mode / scope notes (honour verbatim)

- **ZERO RUNTIME this layer.** The engine rejects nothing it accepted before and runs nothing new — no `parallelGateway`/`inclusiveGateway` engine handler yet. Only *publish* accept/reject and the graph-IR `regions` record change.
- **Governance first (the M3 ordering rule).** The constitution gates publish-profile scope, so `.specify/memory/constitution.md` and the profile docs MUST be amended **before** the validator flip ships. Do tasks in order (L1.1 → L1.8).
- **Layer-gate guard (plan L1.8):** do **not** start an instance of a parallel/inclusive model in any test until layer L3. L1 only validates publish.
- **TDD:** the SESE validator is a pure function — write failing unit tests (L1.3) before implementing the module (L1.4); same for validator-wiring tests (L1.5) before wiring (L1.6). Tests run `EXECUTION_MODE=direct`.
- **Algorithm subtlety (plan §L1.4 note):** rule 8 (no region-crossing cycle) is *subsumed* by branch confinement; rule 10 (concurrent same-message rejection, blocker 14) needs message names and spans regions, so it is a **separate** validator pass (L1.6 Step 5), not part of the per-region CFG analysis.

## Source-of-truth

- Plan: `docs/superpowers/plans/2026-06-13-m4-concurrency.md`, **Phase L1, lines 87-869** (Tasks L1.1–L1.8). Conventions: lines 13-36; File Structure: lines 39-84. Follow the plan's exact steps/code/fixtures/commit messages — do not re-derive.
- Design (authoritative — when plan and design disagree, **design wins**): `docs/superpowers/specs/2026-06-13-m4-concurrency-design.md` — §4.1 (the load-bearing SESE region validator, rules 1–11), §6 (origin-branch join wording), §7 (region map persisted in graph IR), §12 (governance & docs), §13 (blockers 6/13/14), §17 (layer↔blocker roadmap).

## Work breakdown (constituent Task L1.Y items — implement in order)

- **L1.1** Constitution 2.3.0 + M4 two-gate constitution-check record.
- **L1.2** Widen graph IR node types (compile-time only): `parallelGateway`/`inclusiveGateway` in `ElementType`+`NodeType`; export `RegionInfo`; optional `ExecutionGraph.regions`.
- **L1.3** Pure SESE region validator — failing unit tests first (`tests/unit/regions.test.ts`).
- **L1.4** Implement `validateRegions` in `src/bpmn/regions.ts` (CFG + Cooper–Harvey–Kennedy dominators/post-dominators, split→ipdom matching, §4.1 rules, region map). No moddle, no runtime.
- **L1.5** Profile flip + classification + region pass — failing tests first (M4 fixtures in `tests/helpers.ts`; M4 describe in `tests/unit/bpmn-validator.test.ts`).
- **L1.6** Validator wiring: flip `profile.ts`; classify parallel/inclusive; multi-out allow-list; generalise XOR split condition/default rules to the inclusive split; SESE region pass per scope; same-message rejection (blocker 14); write `regions` + mark gateways `next: null` + widen `defaultFlowByGateway`.
- **L1.7** Docs flip + `check:docs` gateway-pointer guard (three `docs/bpmn` files; flip guard #5 to a positive supported-set check).
- **L1.8** L1 layer gate.

## Carried design blockers

- **6** strong single-exit · **13** branch confinement · **14** concurrent same-message rejection.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 L1.1: constitution.md header is 2.3.0 with a prepended Sync Impact Report (MINOR); Principle I accepts parallelGateway(AND)+inclusiveGateway(OR) as SESE-only validated-at-publish (complexGateway + terminate end still excluded, no-custom-notation/XSD/round-trip clause unchanged); Principle VI redefined per causal chain + multi-token frontier-empty completion rule added; the MVP-scope line no longer lists parallel/inclusive (still lists complex).
- [ ] #2 L1.1: specs/002-saga-orchestrator/m4-constitution-check.md exists mirroring m3-constitution-check.md — a Before-Phase-0 gate vs v2.2.0, an After-Phase-1 gate vs v2.3.0, per-principle I–VI lines, and a Complexity-Tracking note that SESE block-structure is the rejected-simpler-alternative to free concurrency.
- [ ] #3 L1.2: graph.ts ElementType and NodeType both include parallelGateway/inclusiveGateway; RegionInfo (splitId, joinId, type 'and'|'or', branchFlowIds in document order, enclosingScopeId) is exported; ExecutionGraph has optional regions?: Record<string,RegionInfo>; npm run typecheck passes.
- [ ] #4 L1.3/L1.4: src/bpmn/regions.ts is a pure module (no moddle/runtime) exporting validateRegions; tests/unit/regions.test.ts passes — accepts a balanced AND region (branchFlowIds doc order); rejects no-matching-join, mismatched join type, a none-end inside the region, uncontrolled merge (2 incoming), boundary-redirect escape (blocker 13), and partial region overlap (laminar nesting).
- [ ] #5 L1.6: profile.ts moves bpmn:ParallelGateway/InclusiveGateway out of DEFERRED_GATEWAY_REASONS into SUPPORTED_NODE_TYPES (ComplexGateway stays deferred); validator.ts classifies them (rejects instantiate=true), allows >1 outgoing, generalises the XOR condition/default rules to the inclusive split, runs validateRegions per scope, runs the same-message rejection pass (blocker 14), writes regions into the graph + marks gateways next:null.
- [ ] #6 L1.5: tests/helpers.ts exports PARALLEL_BPMN, INCLUSIVE_BPMN, PARALLEL_DEADLOCK_BPMN, PARALLEL_MISMATCH_BPMN, PARALLEL_SAME_MESSAGE_BPMN; the M4 describe in tests/unit/bpmn-validator.test.ts passes — PARALLEL_BPMN accepted with regions['fork']={joinId:'join',type:'and',branchFlowIds:['f1','f2']}; INCLUSIVE_BPMN accepted type 'or'; complexGateway/deadlock/mismatch/same-message all rejected; no existing validator test regresses.
- [ ] #7 L1.7: docs/bpmn/{03-gateways,07-execution-semantics,09-easy-bpmn-profile}.md move parallel/inclusive to the supported set with origin-branch join wording (design §6); scripts/check-docs.mjs guard flips to a positive supported-set check that also asserts they are not marked deferred; npm run check:docs passes.
- [ ] #8 L1 gate: npm run typecheck && npm run test && npm run check:docs all pass; publish accepts block-structured parallel/inclusive (region map recorded) and rejects non-SESE/mismatched/same-message with element ids; no new runtime (no test starts a parallel instance in L1).
<!-- AC:END -->
