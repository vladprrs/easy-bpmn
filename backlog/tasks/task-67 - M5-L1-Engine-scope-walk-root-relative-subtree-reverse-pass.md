---
id: TASK-67
title: 'M5-L1: Engine scope walk + root-relative subtree reverse pass (straggler cohort, live-token barrier, nested cancel-end resume)'
status: Done
assignee:
  - claude
created_date: '2026-07-02 00:00'
updated_date: '2026-07-02 00:00'
labels:
  - saga
  - engine
  - m5
milestone: m-5
dependencies:
  - TASK-66
documentation:
  - docs/superpowers/plans/2026-07-02-m5-l1-embedded-scopes.md
  - docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md
priority: high
ordinal: 32300
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer task M5-L1 Tasks 5, 8._

Teaches the rewalk/occurrence engine to walk into and out of embedded `subProcess` scopes (enter/exit
bookkeeping, occurrence fast-forward, mirroring the existing region-frontier walk from M4), then extends
the reverse (compensation) pass to be **root-relative** across the whole scope subtree rather than
single-scope: a subtree cursor + straggler cohort capture (mirroring M4-L5's straggler-catching, TASK-52),
a live-token barrier that holds the terminal until every cohort token settles, and — the key new M5-L1
semantic — a **nested cancel-end resumes the instance** (non-terminal settle) rather than terminating it;
only a root-level cancel is terminal. Operator `/cancel` is redefined as "cancel the process root."
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Engine enter/exit bookkeeping for embedded `subProcess` scopes with occurrence fast-forward on rewalk
- [x] #2 Root-relative reverse pass: a subtree cursor drains the whole scope tree, not just the immediate scope
- [x] #3 Straggler cohort capture under nesting (mirrors M4-L5 straggler-catching for nested scopes)
- [x] #4 Live-token barrier holds the terminal until the ledger is drained AND every cohort token is terminal
- [x] #5 A nested cancel-end resumes the instance (non-terminal); operator `/cancel` = cancel the process root
- [x] #6 M1–M4 single-scope compensation suites stay green (byte-identical when there is no nesting)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
**Task 5** `e4b6294` (engine walks embedded `subProcess` scopes — enter/exit bookkeeping, occurrence
fast-forward), review Approved. Minor: `scopeExited` diagnostics lacks a `kind` field (brief-inherited,
parity nice-to-have with other diagnostic events).

**Task 8** `a2c191e` (root-relative reverse pass — subtree cursor/barrier, nested cancel-end resume,
operator `/cancel` = process root), review Approved on opus.

**Adjudicated divergence surfaced in the PR:** a nested cancel-end resumes the instance (non-terminal
settle); only root-level cancel is terminal — this is a deliberate M5-L1 semantic, not a bug.
<!-- SECTION:FINAL_SUMMARY:END -->
