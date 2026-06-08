---
id: TASK-7
title: Amend governance constitution to 2.0.0 authorizing canonical SAGA scope
status: To Do
assignee: []
created_date: '2026-06-08 08:17'
labels:
  - governance
  - constitution
  - saga
  - bpmn
  - docs
  - speckit
  - m0
milestone: m-0
dependencies: []
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#7-governance-m0
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#2-locked-decisions
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#3-the-canonical-saga-contract
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#44-compensation-algorithm
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#45-failure-taxonomy
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#46-status-lifecycle
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md#8-phase-roadmap-milestones
  - .specify/memory/constitution.md
  - .specify/templates/plan-template.md
  - .specify/templates/spec-template.md
  - .specify/templates/tasks-template.md
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/08-engines-and-extensions.md
  - docs/bpmn/02-activities.md
modified_files:
  - .specify/memory/constitution.md
  - .specify/templates/plan-template.md
  - .specify/templates/spec-template.md
  - .specify/templates/tasks-template.md
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Bump .specify/memory/constitution.md from 1.0.0 to 2.0.0 so governance permits the SAGA orchestrator expansion. The current 1.0.0 explicitly forbids it: the MVP Scope exclusion list (constitution.md:103-105) bans compensation, boundary events, and subprocesses. Per the versioning policy (constitution.md:138-143) and design §7, this is a MAJOR bump — it expands product scope in a way that invalidates existing governance. Governance/docs only; no runtime behavior (design §8, M0 row).

Three substantive edits, all grounded in the SAGA design doc (docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md):
1) Rewrite Principle I (constitution.md:31-41) to widen the accepted set from the 4-node linear profile to the canonical-saga set — bpmn:transaction, compensate/error/cancel boundaryEvent, isForCompensation handler, bpmn:association, cancel endEvent, bpmn:error — WHILE preserving verbatim the hard clause: no custom notation, XSD-valid, round-trips through a standard modeler when easy-bpmn extensions+DI are ignored, unsupported flow nodes rejected before publish with element id + reason (design §3 "Why this is canonical", decision #1 in §2).
2) Trim the MVP Scope exclusion list to remove ONLY what the shipped saga phase (M1) adds — compensation, transaction subprocess, the saga boundary events — keeping gateways, timers, non-transaction subprocesses, multi-instance, user task/forms, migration, full Zeebe/Camunda compat, and visual modeler excluded until their own later amendments.
3) Add a new principle "SAGA / Compensation Integrity" (design §4.4-4.6, decisions #3/#4/#5): reverse completion order, idempotent + at-least-once, scoped to its transaction, deterministic compensator-fail outcome (compensationFailed + operator remediation, never silently blocked), triggered ONLY by transaction Cancel, never by an uncaught Error (Hazard terminates).

Also refresh the Sync Impact Report header + version rationale and propagate to .specify/templates/*. The docs/bpmn/09 profile update and the specs/002 Spec Kit feature are sibling M0 tasks, not this one.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 constitution.md version footer reads `**Version**: 2.0.0` with `Last Amended`: 2026-06-08, and the Sync Impact Report states the MAJOR-bump rationale (scope expansion that invalidates existing governance, per the versioning policy at constitution.md:138-143).
- [ ] #2 Principle I lists the canonical-saga construct set (bpmn:transaction, compensate/error/cancel boundaryEvent, isForCompensation handler, bpmn:association, cancel endEvent, bpmn:error) in addition to the existing Start/ServiceTask/ReceiveTask/End/SequenceFlow/Message, AND still contains the requirement: no custom notation, XSD-valid, round-trippable through a standard modeler when easy-bpmn extensions + Diagram Interchange are ignored, and unsupported flow nodes rejected before publish with element id + reason.
- [ ] #3 The MVP Scope exclusion list (was constitution.md:103-105) no longer names compensation, transaction subprocess, or the saga boundary events, and still excludes gateways, timers, non-transaction subprocesses, multi-instance, BPMN User Task/forms/tasklists, process migration, full Zeebe/Camunda compatibility, and a visual BPMN modeler.
- [ ] #4 A new principle titled 'SAGA / Compensation Integrity' exists and asserts all five invariants: (a) reverse completion order, (b) idempotent + at-least-once, (c) scoped to its transaction, (d) deterministic compensator-fail outcome (compensationFailed + operator remediation, never silently blocked forever), (e) compensation triggered only by transaction Cancel, never by an uncaught Error (Hazard terminates and propagates).
- [ ] #5 The Sync Impact Report comment block enumerates the version change 1.0.0->2.0.0, the modified Principle I, the added SAGA principle, the trimmed MVP Scope section, and the three updated .specify/templates files, with no remaining bracket/TODO/placeholder tokens.
- [ ] #6 .specify/templates/plan-template.md Constitution Check is updated: the BPMN-profile gate (plan-template.md:46-48) reflects the widened saga profile, and a new SAGA/Compensation-integrity gate is added (reverse-order, idempotent/at-least-once, Cancel-not-Error trigger); .specify/templates/spec-template.md 'BPMN Profile Impact' prompt (spec-template.md:19-20) covers saga/compensation constructs; .specify/templates/tasks-template.md constitution-critical test list (tasks-template.md:12-14) adds compensation ordering, saga state transitions, worker auth/workspace isolation, and operator remediation.
- [ ] #7 Constitution-gate test requirement is explicitly recorded as N/A with rationale (governance/docs-only change touching no runtime/API/persistence/state-transition behavior — design §8 M0 row), AND a consistency check (speckit constitution validation, or a grep asserting version=2.0.0, exclusion list free of the removed items, and Sync Impact Report matching the actual diff) passes.
- [ ] #8 Negative/edge: constructs deferred to later milestones (gateways, conditionExpression/default flows, timer/signal/escalation events, parallel gateway, multi-instance, callActivity, non-transaction subProcess, instantiate=true) are NOT added to Principle I's accepted set and remain in the exclusion list, so M2-M5 each still require their own future amendment.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Update the Sync Impact Report comment block (constitution.md:1-25): set version change to 1.0.0 -> 2.0.0; record modified Principle I, the added 'SAGA / Compensation Integrity' principle, the modified 'MVP Scope and Platform Constraints' section; mark all three .specify/templates/*.md as updated.
2. Rewrite Principle I (constitution.md:31-41): drop the MVP-only framing of the accepted list; enumerate the widened set (existing 4 node types + Sequence Flow/Message PLUS transaction, compensate/error/cancel boundaryEvent, isForCompensation handler, association, cancel endEvent, bpmn:error); keep verbatim the no-custom-notation / XSD-valid / round-trip / reject-unsupported-flow-node-with-element-id-and-reason clause (source: design §3 'Why this is canonical', decision #1 §2).
3. Trim the MVP Scope MUST-NOT list (constitution.md:103-105): remove compensation, transaction subprocess, and the saga boundary events; leave gateways/timers/non-transaction subprocess/multi-instance/user-task/forms/migration/visual-modeler excluded.
4. Append a new principle 'VI. SAGA / Compensation Integrity' after Principle V (after constitution.md:88), capturing the five invariants from design §4.4-4.6 and decisions #3/#4/#5 (§2). Append rather than renumber I-V to minimize diff churn and avoid breaking references.
5. Bump the version footer (constitution.md:150) to `**Version**: 2.0.0 | **Ratified**: 2026-06-07 | **Last Amended**: 2026-06-08`.
6. Propagate to templates: plan-template.md (gate at :46-48 -> saga profile wording + new SAGA/Compensation gate); spec-template.md ('BPMN Profile Impact' at :19-20 -> mention saga/compensation constructs); tasks-template.md (constitution-critical list at :12-14 -> add compensation ordering, saga state transitions, worker auth/isolation, operator remediation).
7. Validate: run the speckit constitution check (or grep) confirming no placeholder tokens remain, version reads 2.0.0 in footer + Sync Impact Report, the exclusion list no longer contains 'compensation', and the Report enumerates the actual diff.
<!-- SECTION:PLAN:END -->
