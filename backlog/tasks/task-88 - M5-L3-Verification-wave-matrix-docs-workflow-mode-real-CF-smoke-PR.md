---
id: TASK-88
title: 'M5-L3: Verification wave — MI matrix wave, docs lockstep, workflow-mode Layer B, real-CF smoke, PR'
status: To Do
assignee:
  - claude
created_date: '2026-07-06 07:30'
labels:
  - saga
  - bpmn
  - m5
milestone: m-5
dependencies:
  - TASK-87
documentation:
  - tests/matrix/registry.ts
  - scripts/check-matrix.mjs
  - docs/bpmn/09-easy-bpmn-profile.md
  - specs/002-saga-orchestrator/data-model.md
  - specs/002-saga-orchestrator/contracts/runtime-contracts.md
  - tests/workflow-mode/matrix.wf.test.ts
  - CLAUDE.md
priority: high
ordinal: 41800
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. M5-L3 multiInstance layer._

Plan Tasks 13-14: MI-* registry wave (16 valid + 3 rejects, R-MI-SUBPROC-01 repointed to a body-whitelist reject; counts 105/22; MUST_COVER += multiInstance), full docs lockstep sweep (09 SHIPPED block, 02/07 flips, spec.md markers, data-model 0009 section, runtime-contracts MI section, CLAUDE.md), Layer B matrix.wf MI block (@needs-real-cf/@needs-override skips honest), full local gate, PR, remote migration 0009 + real-CF smoke as merge gate, backlog closeout.
<!-- SECTION:DESCRIPTION:END -->
