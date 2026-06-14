---
id: TASK-48
title: 'M4-L1: Governance, profile flip, SESE region validator (publish-time only)'
status: Done
assignee:
  - Vlad Pr
created_date: '2026-06-13 08:53'
updated_date: '2026-06-13 10:00'
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
  - tests/contract/api.test.ts
priority: medium
ordinal: 21100
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-27** (M4 — Concurrency), milestone `m-4`. One of six layer tasks M4-L1…L6 (implement in order; governance first)._

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
- [x] #1 L1.1: constitution.md header is 2.3.0 with a prepended Sync Impact Report (MINOR); Principle I accepts parallelGateway(AND)+inclusiveGateway(OR) as SESE-only validated-at-publish (complexGateway + terminate end still excluded, no-custom-notation/XSD/round-trip clause unchanged); Principle VI redefined per causal chain + multi-token frontier-empty completion rule added; the MVP-scope line no longer lists parallel/inclusive (still lists complex).
- [x] #2 L1.1: specs/002-saga-orchestrator/m4-constitution-check.md exists mirroring m3-constitution-check.md — a Before-Phase-0 gate vs v2.2.0, an After-Phase-1 gate vs v2.3.0, per-principle I–VI lines, and a Complexity-Tracking note that SESE block-structure is the rejected-simpler-alternative to free concurrency.
- [x] #3 L1.2: graph.ts ElementType and NodeType both include parallelGateway/inclusiveGateway; RegionInfo (splitId, joinId, type 'and'|'or', branchFlowIds in document order, enclosingScopeId) is exported; ExecutionGraph has optional regions?: Record<string,RegionInfo>; npm run typecheck passes.
- [x] #4 L1.3/L1.4: src/bpmn/regions.ts is a pure module (no moddle/runtime) exporting validateRegions; tests/unit/regions.test.ts passes — accepts a balanced AND region (branchFlowIds doc order); rejects no-matching-join, mismatched join type, a none-end inside the region, uncontrolled merge (2 incoming), boundary-redirect escape (blocker 13), and partial region overlap (laminar nesting).
- [x] #5 L1.6: profile.ts moves bpmn:ParallelGateway/InclusiveGateway out of DEFERRED_GATEWAY_REASONS into SUPPORTED_NODE_TYPES (ComplexGateway stays deferred); validator.ts classifies them (rejects instantiate=true), allows >1 outgoing, generalises the XOR condition/default rules to the inclusive split, runs validateRegions per scope, runs the same-message rejection pass (blocker 14), writes regions into the graph + marks gateways next:null.
- [x] #6 L1.5: tests/helpers.ts exports PARALLEL_BPMN, INCLUSIVE_BPMN, PARALLEL_DEADLOCK_BPMN, PARALLEL_MISMATCH_BPMN, PARALLEL_SAME_MESSAGE_BPMN; the M4 describe in tests/unit/bpmn-validator.test.ts passes — PARALLEL_BPMN accepted with regions['fork']={joinId:'join',type:'and',branchFlowIds:['f1','f2']}; INCLUSIVE_BPMN accepted type 'or'; complexGateway/deadlock/mismatch/same-message all rejected; no existing validator test regresses.
- [x] #7 L1.7: docs/bpmn/{03-gateways,07-execution-semantics,09-easy-bpmn-profile}.md move parallel/inclusive to the supported set with origin-branch join wording (design §6); scripts/check-docs.mjs guard flips to a positive supported-set check that also asserts they are not marked deferred; npm run check:docs passes.
- [x] #8 L1 gate: npm run typecheck && npm run test && npm run check:docs all pass; publish accepts block-structured parallel/inclusive (region map recorded) and rejects non-SESE/mismatched/same-message with element ids; no new runtime (no test starts a parallel instance in L1).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Approach — execute plan Phase L1 (L1.1→L1.8) verbatim; design wins on conflict

Source of truth: docs/superpowers/plans/2026-06-13-m4-concurrency.md Phase L1 (lines 87-869) + design §4.1/§6/§7/§12/§13/§17. ZERO RUNTIME this layer — publish accept/reject + graph-IR `regions` only. TDD (failing tests first). Tests run EXECUTION_MODE=direct. Run autonomously through all 8 sub-tasks (no inter-subtask pauses), commit per sub-task with repo-style messages.

### L1.1 — Governance (commit: docs(m4): constitution 2.3.0 …)
- `.specify/memory/constitution.md`: 2.2.0→2.3.0; prepend Sync Impact Report (MINOR); Principle I accepts parallelGateway(AND)+inclusiveGateway(OR) SESE-only validated-at-publish (complex + terminate still excluded; no-custom-notation/XSD/round-trip clause unchanged); Principle VI → reverse-order per causal chain (token lineage), between-branch order unconstrained, straggler still ledgered; add multi-token frontier-empty completion rule; trim parallel/inclusive from MVP-scope gateway line (keep complex).
- Create `specs/002-saga-orchestrator/m4-constitution-check.md` mirroring m3: Before-Phase-0 vs v2.2.0, After-Phase-1 vs v2.3.0, per-principle I–VI lines, Complexity-Tracking note (SESE = rejected-simpler-alternative to free concurrency).

### L1.2 — Graph IR types (compile-time only) (commit: feat(m4): graph IR …)
- `src/bpmn/graph.ts`: add `parallelGateway`/`inclusiveGateway` to ElementType + NodeType; export `RegionInfo {splitId, joinId, type:'and'|'or', branchFlowIds[], enclosingScopeId}`; add optional `ExecutionGraph.regions?: Record<string,RegionInfo>`. typecheck must pass.

### L1.3/L1.4 — Pure SESE validator, TDD (commit: feat(m4): pure SESE region validator …)
- Create failing `tests/unit/regions.test.ts` (plan §L1.3 verbatim), then `src/bpmn/regions.ts` (plan §L1.4 verbatim): CFG + virtual SOURCE/SINK + boundary edges, Cooper–Harvey–Kennedy dominators/post-dominators, split→ipdom match (same-type, single-entry, bijection), region members, rule 6 (uncontrolled merge), rule 5 (branch confinement), rule 7 (laminar nesting). Pure — no moddle/runtime.

### L1.5/L1.6 — Validator wiring, TDD (commit: feat(m4): validator opens parallel/inclusive …)
- Add fixtures to `tests/helpers.ts` (PARALLEL/INCLUSIVE/DEADLOCK/MISMATCH/SAME_MESSAGE); add failing "M4 concurrency profile" describe to `tests/unit/bpmn-validator.test.ts`.
- `src/bpmn/profile.ts`: move Parallel/InclusiveGateway → SUPPORTED_NODE_TYPES (Complex stays deferred); update DEFERRED doc comment.
- `src/bpmn/validator.ts`: classify parallel/inclusive (reject instantiate=true; inclusive carries default); add to >1-out allow-list; generalise XOR split condition/default rules + the "conditions only leave exclusiveGateway" rule to the inclusive split; add region pass per scope (validateRegions) + same-message rejection pass (blocker 14); buildGraph: widen defaultFlowByGateway + gateway next:null to parallel/inclusive; emit `regions`.

### L1.7 — Docs flip + check:docs guard (commit: docs(m4): flip parallel/inclusive to shipped …)
- `docs/bpmn/03-gateways.md`, `07-execution-semantics.md`, `09-easy-bpmn-profile.md`: move parallel/inclusive to supported set; amend join wording per design §6 (origin-branch keyed); keep canonical markers.
- `scripts/check-docs.mjs`: flip guard #5 from `[parallelGateway,M4]/[inclusiveGateway,M4]` same-line pointer to a positive supported-set check + assert NOT marked deferred (regex on 03-gateways.md); delete unused gatewayLines.

### L1.8 — Layer gate
- `npm run typecheck && npm run test && npm run check:docs` all green. No test starts a parallel/inclusive instance (publish-only this layer).
- Final adversarial review (Workflow) of SESE algorithm correctness, governance wording, and regression surface before declaring the gate passed.

## Under-specified regressions found during review (must fix for the L1.8 gate)
The profile flip makes a 1-in/1-out parallel/inclusive gateway a VALID pass-through (validateRegions only flags >1-out splits). Two existing tests assume rejection:
1. `tests/unit/bpmn-validator.test.ts:727` it.each — drop the parallelGateway/inclusiveGateway rows (now accepted), keep complexGateway. (file IS in the task list; plan prose implies this.)
2. `tests/contract/api.test.ts:30` "unsupported draft … 409" uses `deferredGatewayBpmn("parallelGateway")` — switch fixture to a still-rejected type (`complexGateway`) + update comment. (file NOT in the task's modified-files list → scope clarification needed.)
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
L1.1–L1.4 committed (3568638 governance/templates, 2a56316 graph IR + api.ts union, 7f94891 SESE validator + unit tests). Two design-faithful deviations from the plan's verbatim L1.4 code/test (design §4.1 wins over plan): (1) regions.ts Rule 6 exempts ALL gateways (not just exclusiveGateway) so a nested matched parallel/inclusive join is not mis-flagged as an uncontrolled merge — unmatched multi-incoming gateways still rejected by the bijection 'other half' check; (2) the uncontrolled-merge unit-test regex broadened to /incoming|merge|matching join/i because an all-branch merge makes the merge node the post-dominator, so the model is rejected at rule 3 ('no matching join') not rule 6 — still a rejection with element id. Also two mandatory compile-time propagations beyond the listed files: src/contracts/api.ts BpmnElement.type union widened (no openapi element-type enum exists to sync) and the lockstep Spec-Kit template updates (.specify/templates/{plan,spec}-template.md) required by the constitution's Governance 'review dependent templates' clause. All recorded in the Sync Impact Report. regions.test.ts: 7/7 green; typecheck green.

L1.5–L1.7 committed (22a32de validator/profile flip + regression fixes, ac0e5a1 docs flip + check:docs guard). L1.8 layer gate GREEN: npm run typecheck clean, npm run test 375/375 (48 files), npm run check:docs passed. No test starts a parallel/inclusive instance (publish-only). Running a 4-lens adversarial review workflow (SESE soundness / wiring-regression / governance / completeness) with per-finding skeptic verification before checking AC#8 and finalizing.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-06-13 09:11
---
Scope clarification approved by operator (2026-06-13): tests/contract/api.test.ts is added to Modified files. The profile flip makes deferredGatewayBpmn("parallelGateway") a valid pass-through, so the api.test.ts "unsupported draft → 409" case is repointed to a still-rejected type (complexGateway) inline in L1.6 to keep the L1.8 full-suite gate green.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## M4-L1 — Governance, profile flip, SESE region validator (publish-time only) — DONE

First layer of milestone M4 (in-instance concurrency). `bpmn:parallelGateway` (AND) and `bpmn:inclusiveGateway` (OR) are now **accepted-and-validated at publish** when block-structured (single-entry/single-exit), and **rejected with element id + reason** otherwise. **Zero runtime** — no engine handler for parallel/inclusive ships in L1 (runtime is L2–L5); only publish accept/reject and the graph-IR `regions` map change.

### What changed (6 commits on `m4-concurrency`)
- **3568638** `docs(m4)` — constitution **2.2.0 → 2.3.0** (MINOR): Principle I accepts parallel/inclusive (SESE-only, validated at publish; complex + terminate still excluded; no-custom-notation/XSD/round-trip clause unchanged); Principle VI redefined per **causal chain (token lineage)** + between-branch order unconstrained + straggler clause; **multi-token frontier-empty completion** rule added; MVP-scope trims parallel/inclusive (complex stays). New `specs/002-saga-orchestrator/m4-constitution-check.md` (two-gate record). Lockstep Spec-Kit template updates (constitution Governance mandates template review).
- **2a56316** `feat(m4)` — graph IR: `parallelGateway`/`inclusiveGateway` in `ElementType`+`NodeType`; exported `RegionInfo`; optional `ExecutionGraph.regions`; contract `BpmnElement.type` union widened in lockstep.
- **7f94891** `feat(m4)` — pure `src/bpmn/regions.ts` (`validateRegions`): CFG + virtual SOURCE/SINK + boundary edges, Cooper–Harvey–Kennedy dominators/post-dominators, split→ipdom matching (same-type, single-entry, bijection), region members, uncontrolled-merge (rule 6), branch confinement (rule 5), laminar nesting (rule 7). No moddle/runtime. 7 unit tests.
- **22a32de** `feat(m4)` — profile flip (parallel/inclusive → SUPPORTED_NODE_TYPES; complex stays deferred); validator classifies them (instantiate=true rejected; inclusive carries default), >1-out allow-list, inclusive split reuses the XOR condition/default rules, the SESE region pass per scope, the same-message rejection pass (blocker 14), buildGraph emits `regions` + marks gateways `next:null`. M4 fixtures + "M4 concurrency profile" describe.
- **ac0e5a1** `docs(m4)` — docs/bpmn/03+07+09 flip parallel/inclusive to the supported set with origin-branch join wording (design §6); `check:docs` guard 5 flipped to a positive supported-set check + asserts not-deferred.
- **5daf24a** `fix(m4)` — adversarial-review fixes (below).

### Carried design blockers resolved
6 (strong single-exit via post-dominators + virtual SINK), 13 (branch confinement), 14 (concurrent same-message rejection).

### Adversarial review (4 lenses, per-finding skeptic verification)
No blockers/majors; **no false-accepts or false-rejects** of SESE regions; **zero regressions**. Three confirmed MINOR findings, all fixed in 5daf24a: (1) rule 6 no longer exempts `eventBasedGateway` (it is a split, not a synchronising join, and isn't caught by the bijection check — a multi-incoming EBG inside a region is a genuine uncontrolled merge; +regression test); (2) the complexGateway reject message now lists the real accepted set (Principle V); (3) `09-easy-bpmn-profile.md` opening aligned to constitution v2.3.0 + M4.

### Deviations from the plan's verbatim code (design wins, all documented)
- regions.ts rule 6 exempts the matching join + exclusiveGateway merge (not all gateways, and not EBG) — design §4.1.
- The uncontrolled-merge unit-test regex broadened: an all-branch merge makes the merge node the post-dominator, so the model is rejected at rule 3 ("no matching join"), not rule 6 — still a rejection with element id.
- Beyond the originally-listed files (all mandatory/approved): `src/contracts/api.ts` (type-union propagation), `.specify/templates/{plan,spec}-template.md` (constitution-mandated lockstep), `tests/contract/api.test.ts` (operator-approved: repointed the "unsupported draft" fixture from parallelGateway → complexGateway).

### Verification
`npm run typecheck` clean · `npm run test` **376/376** (48 files) · `npm run check:docs` green. Layer-gate guard honoured: no test starts a parallel/inclusive instance (publish-only).

### Follow-ups (not started)
M4-L2 (TASK-49, token foundation + `0007_tokens.sql` + frontier refactor) is next; the `regions` map this layer records is consumed by L3+. Manual Workflow-mode validation matrix is a DoD gate before L3/L5 close (design §14).
<!-- SECTION:FINAL_SUMMARY:END -->
