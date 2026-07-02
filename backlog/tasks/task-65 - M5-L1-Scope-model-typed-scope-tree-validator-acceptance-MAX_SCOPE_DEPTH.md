---
id: TASK-65
title: 'M5-L1: Scope model — typed scope tree, validator acceptance of embedded subProcess, MAX_SCOPE_DEPTH=8'
status: Done
assignee:
  - claude
created_date: '2026-07-02 00:00'
updated_date: '2026-07-02 00:00'
labels:
  - saga
  - engine
  - bpmn
  - m5
milestone: m-5
dependencies:
  - TASK-64
documentation:
  - docs/superpowers/plans/2026-07-02-m5-l1-embedded-scopes.md
  - docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md
priority: high
ordinal: 32100
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer task M5-L1 Tasks 2–3._

Builds the foundation the rest of L1 sits on: a typed scope-tree module computing hierarchy math (parent/
ancestor/depth) over the compiled graph, then teaches the BPMN validator to accept plain (non-transaction)
embedded `subProcess` nodes, compiles the scope map at publish time, and enforces a new
`MAX_SCOPE_DEPTH = 8` publish-time cap (mirroring the existing `MAX_ELEMENT_OCCURRENCES`/
`MAX_CONCURRENT_TOKENS`/`STEP_BUDGET_SOFT` cap pattern in `src/runtime/engine.ts`).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A scope-tree module computes typed scope hierarchy (kind, parent, ancestors, depth) over the compiled graph
- [x] #2 The validator accepts a plain (non-transaction) embedded `subProcess` as a flow node instead of rejecting it
- [x] #3 A scope map is compiled and attached to the graph at publish time
- [x] #4 `MAX_SCOPE_DEPTH = 8` enforced as a publish-time reject (one error per over-limit scope)
- [x] #5 Full `test:unit` suite (211/211) stays green
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
**Task 2 (`dc7884c`, review Approved).** Scope-tree module authored — typed scope hierarchy math over the
compiled graph. Two Important review findings resolved by the controller: full `test:unit` re-run
211/211 green, and a formula deviation from the plan's literal text was adjudicated correct (implemented
code is ground truth per the ledger convention).

**Task 3 (`a3327ba`, review Approved).** Validator now accepts embedded `subProcess`; scope-map compilation
and the `MAX_SCOPE_DEPTH = 8` publish gate wired in.

Both tasks reviewed fresh-implementer + task-scoped review, zero unresolved findings beyond the one
adjudicated formula deviation.
<!-- SECTION:FINAL_SUMMARY:END -->
