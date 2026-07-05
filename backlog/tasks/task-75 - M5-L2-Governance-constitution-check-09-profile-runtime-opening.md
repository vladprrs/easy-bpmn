---
id: TASK-75
title: 'M5-L2: Governance — per-layer constitution check + 09-profile runtime-opening marker'
status: Done
assignee:
  - claude
created_date: '2026-07-05 00:00'
updated_date: '2026-07-05 23:10'
labels:
  - saga
  - bpmn
  - m5
milestone: m-5
dependencies:
  - TASK-71
  - TASK-72
  - TASK-73
documentation:
  - specs/002-saga-orchestrator/m5-L2-constitution-check.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/superpowers/specs/2026-07-02-m5-l2-callactivity-design.md
  - docs/superpowers/plans/2026-07-02-m5-l2-callactivity.md
priority: high
ordinal: 33100
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer task M5-L2 Task 1; opens the layer._

Opens the M5-L2 (`callActivity` reusable sub-saga) layer after the TASK-71..73 prerequisite gate:
cuts `m5-l2-call-activity` from `main`, records the per-layer Constitution Check (no constitution
version bump — v2.5.0 accepted the whole M5 composition set up front; the M5-L1 precedent), and flips
the `docs/bpmn/09` interim marker for `callActivity` only. The two deliberate v1 narrowings are
recorded as scope entries, not deviations: the message-wait call-tree publish reject (design §7) and
the direct-child-operator-verb 409 (design §6).
<!-- SECTION:DESCRIPTION:END -->

## Final Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped on `m5-l2-call-activity` (PR #5). Commit `b41274d` (constitution check + marker flip); the
closing docs lockstep (`e571fc7`, layer task TASK-81) later flipped the same markers to **shipped**.
<!-- SECTION:NOTES:END -->
