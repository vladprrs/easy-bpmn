---
id: TASK-25
title: >-
  EPIC M2 — Conditional sagas (multi-edge IR, exclusive gateway, condition
  expressions)
status: To Do
assignee: []
created_date: '2026-06-08 08:18'
labels:
  - epic
  - saga
  - bpmn
  - engine
milestone: m-2
dependencies: []
references:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§8 M2
  - §9
  - §5 gateway_decisions stub)
  - docs/bpmn/03-gateways.md
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/03-gateways.md
priority: medium
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Epic placeholder for milestone M2 (design §8). Add data-driven branching to the saga engine: a multi-edge graph IR with PERSISTED sequence-flow conditions; bpmn:exclusiveGateway + default flow; a condition expression engine; and a gateway_decisions audit table for deterministic replay. Open decision (design §9): FEEL (canonical, heavy to embed in a Worker) vs a restricted JSONLogic/JS-subset evaluator — regardless of language, persist the EVALUATED decision for replay/audit. Target semantics: docs/bpmn/03-gateways.md. To be broken into concrete tasks (spec→plan→tasks) when M1 lands; not yet sliced.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A follow-up brainstorming/spec pass slices M2 into concrete tasks before implementation starts.
- [ ] #2 The FEEL-vs-restricted-evaluator decision (design §9) is resolved and recorded before M2 implementation.
- [ ] #3 Branch decisions are persisted in gateway_decisions and replay-deterministic (acceptance defined per concrete task).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Deferred epic. When M1 is complete: (1) resolve the expression-language open question (§9); (2) run a focused spec/plan for the multi-edge IR + exclusiveGateway + gateway_decisions; (3) slice into concrete tasks. This stub tracks the milestone, not a single PR.
<!-- SECTION:PLAN:END -->
