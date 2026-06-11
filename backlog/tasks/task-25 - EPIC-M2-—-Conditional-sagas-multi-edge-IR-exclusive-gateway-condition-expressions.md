---
id: TASK-25
title: >-
  EPIC M2 — Conditional sagas (multi-edge IR, exclusive gateway, condition
  expressions)
status: To Do
assignee: []
created_date: '2026-06-08 08:18'
updated_date: '2026-06-09 20:31'
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
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/03-gateways.md
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
priority: medium
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Epic placeholder for milestone M2 (design §8). Add data-driven branching to the saga engine: a multi-edge graph IR with PERSISTED sequence-flow conditions; bpmn:exclusiveGateway + default flow; a condition expression engine; and a gateway_decisions audit table for deterministic replay. Open decision (design §9): FEEL (canonical, heavy to embed in a Worker) vs a restricted JSONLogic/JS-subset evaluator — regardless of language, persist the EVALUATED decision for replay/audit. Target semantics: docs/bpmn/03-gateways.md. To be broken into concrete tasks (spec→plan→tasks) when M1 lands; not yet sliced.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A follow-up brainstorming/spec pass slices M2 into concrete tasks before implementation starts.
- [x] #2 The FEEL-vs-restricted-evaluator decision (design §9) is resolved and recorded before M2 implementation.
- [ ] #3 Branch decisions are persisted in gateway_decisions and replay-deterministic (acceptance defined per concrete task).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Sliced 2026-06-09 via the brainstorming/spec pass (docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md, commit 233af4f). Decisions locked: FEEL via feelin (resolves design §9); cycles INCLUDED in M2 via an occurrence discriminator + rewalk-from-start resume ("the walk is the replay"); conditions only on exclusiveGateway outgoing flows; no-match → noPath Hazard. Concrete tasks (execute in dependency order): TASK-29 (migration 0004 + contracts) and TASK-30 (FEEL module) → TASK-31 (graph IR conditional edges) → TASK-33 (validator accept-and-validate) and TASK-32 (engine occurrence/rewalk — the critical path) → TASK-34 (gateway dispatch + gateway_decisions), TASK-35 (loop guard), TASK-36 (loop compensation) → TASK-37 (governance lockstep + quickstart). This epic tracks the milestone; AC #3 is delivered by TASK-34.
<!-- SECTION:PLAN:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-06-09 20:31
---
M2 sliced into TASK-29..TASK-37 (2026-06-09). Expression language resolved: FEEL via feelin. Scope expansion vs the original §8 row: cycles are in (user decision), which adds the occurrence discriminator + rewalk-resume work (TASK-32) and lifts M2 from L toward XL.
---
<!-- COMMENTS:END -->
