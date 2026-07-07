---
id: TASK-82
title: 'M5-L3: Governance opening + validator multiInstance acceptance (sources, rejects, miBody scopes, body whitelist)'
status: Done
assignee:
  - claude
created_date: '2026-07-06 07:30'
updated_date: '2026-07-06 23:00'
labels:
  - saga
  - bpmn
  - m5
milestone: m-5
dependencies:
  []
documentation:
  - docs/superpowers/specs/2026-07-06-m5-l3-multiinstance-design.md
  - docs/superpowers/plans/2026-07-06-m5-l3-multiinstance.md
  - src/bpmn/validator.ts
  - src/bpmn/moddle-extension.ts
  - tests/unit/validator-multi-instance.test.ts
priority: high
ordinal: 41200
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. M5-L3 multiInstance layer._

Plan Tasks 1-2: branch `m5-l3-multi-instance`, per-layer Constitution Check (`m5-L3-constitution-check.md`), 09-profile runtime-opening marker; MultiInstanceSpec graph type + `easy-bpmn:multiInstance` moddle binding; validator accepts MI (parallel+sequential) on serviceTask/subProcess/callActivity with FEEL-parsed loopCardinality/completionCondition, emits miBody ScopeMeta (incl. synthetic leaf scopes), and rejects: standardLoop (own message), MI data bindings, no/both cardinality sources, non-All behavior, MI on transaction/receiveTask, compensate-boundary-on-MI, isForCompensation, and the v1 MI-subProcess body whitelist.
<!-- SECTION:DESCRIPTION:END -->
