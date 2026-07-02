---
id: TASK-66
title: 'M5-L1: Scope-aware saga ledger + two-tier commit shield (committedLocal/sealed committed) + ledger-write gate'
status: Done
assignee:
  - claude
created_date: '2026-07-02 00:00'
updated_date: '2026-07-02 00:00'
labels:
  - saga
  - persistence
  - m5
milestone: m-5
dependencies:
  - TASK-65
documentation:
  - docs/superpowers/plans/2026-07-02-m5-l1-embedded-scopes.md
  - docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md
priority: high
ordinal: 32200
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer task M5-L1 Tasks 4, 6, 7._

Extends the saga ledger (`src/persistence/saga.ts`) to be scope-aware: `saga_steps` rows carry a `scope_id`,
a per-instance monotonic global `seq` (needed once compensation reverses across nested scopes, not just
branches), and a **two-tier commit shield** — a nested transaction commit is non-terminal
(`committedLocal`), sealed to terminal `committed` only when the *outermost* transaction commits. Also
gates which writes are eligible against transaction ancestry (`eligibleCommittedLocalScopeIds`), and
rewires flat compensation lookups to be ancestry-aware instead of single-scope.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `saga_steps` carries `scope_id` + a per-instance monotonic global `seq`
- [x] #2 A nested transaction commit writes non-terminal `committedLocal`; only the outermost commit seals rows to `committed`
- [x] #3 `eligibleCommittedLocalScopeIds` gates ledger-writes by transaction ancestry (root-relative)
- [x] #4 Flat compensation-wiring lookups are ancestry-aware, not single-scope
- [x] #5 A new validator rule enforces handler ancestry
- [x] #6 M1–M4 legacy suites (loop-compensation, saga-orchestration, saga-operator) stay green — byte-identical for non-nested transactions
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Three commits, all reviewed fresh + Approved with zero findings: **Task 4** `23bf949` (saga ledger —
`committedLocal` status, root-relative subtree cursor, per-instance global `seq`); **Task 6** `5df142a`
(ledger-write gate is transaction-ancestry; flat compensation wiring made ancestry-aware; handler ancestry
validator rule); **Task 7** `a24bede` (two-tier commit shield — nested `committedLocal`, outermost seal).

**Adjudicated deviation (recorded in the ledger for downstream tasks):** `eligibleCommittedLocalScopeIds`
as implemented adds `|| (tx == null && rootScopeId == null)` versus the plan's literal formula — required
by the plan's own test (P included at null root); the implemented code is treated as ground truth per
project convention.
<!-- SECTION:FINAL_SUMMARY:END -->
