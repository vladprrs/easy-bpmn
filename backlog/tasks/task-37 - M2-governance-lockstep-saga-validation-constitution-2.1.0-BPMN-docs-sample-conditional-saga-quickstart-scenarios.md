---
id: TASK-37
title: >-
  M2 governance lockstep + saga validation: constitution 2.1.0, BPMN docs,
  sample conditional saga, quickstart scenarios
status: In Progress
assignee:
  - Claude
created_date: '2026-06-09 20:30'
updated_date: '2026-06-11 11:58'
labels:
  - saga
  - governance
  - docs
  - quickstart
  - tests
milestone: M2
dependencies:
  - TASK-33
  - TASK-34
  - TASK-35
  - TASK-36
references:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - .specify/memory/constitution.md
  - docs/bpmn/03-gateways.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - specs/002-saga-orchestrator
documentation:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
priority: high
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The constitution requires amending governance in lockstep with profile widening (CLAUDE.md governance gate; M0 pattern from saga design §7). Bump .specify/memory/constitution.md 2.0.0 → 2.1.0 (MINOR — trim the exclusion list by exactly what M2 ships: exclusiveGateway, FEEL conditions, default flows, cycles; add a Sync Impact Report header with the rationale). Update docs/bpmn/03-gateways.md's easy-bpmn scope section (it currently states "Gateways are entirely out of scope for the MVP") to the M2 reality (XOR + FEEL + default + cycles in; inclusive/parallel/event-based/complex out, with milestone pointers) and align docs/bpmn/09-easy-bpmn-profile.md; npm run check:docs must stay green. Ship a sample conditional-saga BPMN model (XOR split/join + a loop + compensation wiring) alongside the existing samples, and add executable quickstart scenarios covering the M2 exit criteria end-to-end, wired exactly like the M1 quickstart saga scenarios (TASK-24 pattern). Update specs/002-saga-orchestrator artifacts (data-model/contracts deltas for occurrence + gateway_decisions; no /jobs/* API surface change).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 constitution.md is at 2.1.0 with a Sync Impact Report; the exclusion list is trimmed by exactly the M2 construct set; the SAGA/Compensation Integrity principle is untouched.
- [ ] #2 docs/bpmn/03-gateways.md easy-bpmn scope section reflects M2 (XOR + FEEL conditions + default + cycles in; the other four gateway types out, with milestone pointers); 09-easy-bpmn-profile.md aligned; npm run check:docs green.
- [ ] #3 A sample conditional-saga BPMN file (XOR + loop + compensation wiring) ships with the existing samples and publishes against the live validator.
- [ ] #4 Quickstart gains executable M2 scenarios, each mapping to a green integration test: branch-by-data, loop-N-iterations-then-compensate-each, noPath incident, loopLimit incident, decision-replay stability.
- [ ] #5 specs/002-saga-orchestrator data-model/contract artifacts updated for occurrence + gateway_decisions; the /jobs/* worker API surface is unchanged.
- [ ] #6 npm run test green; npx wrangler deploy --dry-run passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: subagent-driven (implementer + spec review + quality review) on branch m2-conditional-sagas. Final M2 task: governance lockstep + saga validation artifacts.

1. .specify/memory/constitution.md 2.0.0 -> 2.1.0 (MINOR): trim the exclusion list by exactly the M2 construct set (exclusiveGateway, FEEL conditionExpression on its outgoing flows, default flows, cycles); Sync Impact Report header with rationale; SAGA/Compensation Integrity principle untouched.
2. docs/bpmn/03-gateways.md easy-bpmn scope section: replace "Gateways are entirely out of scope for the MVP" with M2 reality (XOR + FEEL + default + cycles IN; inclusive/parallel M4, eventBased M3, complex later — match DEFERRED_GATEWAY_REASONS in src/bpmn/profile.ts); align docs/bpmn/09-easy-bpmn-profile.md; npm run check:docs stays green.
3. Sample conditional-saga BPMN file (XOR split/join + loop + compensation wiring) alongside existing samples (examples/); must publish against the live validator (test or scripted check).
4. Quickstart (specs/002-saga-orchestrator/quickstart.md): executable M2 scenarios mapping to green integration tests — branch-by-data, loop-N-iterations-then-compensate-each, noPath incident, loopLimit incident, decision-replay stability.
5. specs/002-saga-orchestrator data-model.md + contracts: occurrence columns, gateway_decisions, output_applied, incidents kinds loopLimit/noPath, gatewayDecisionEvaluated event; /jobs/* surface UNCHANGED (note the pin test).
6. Accumulated doc-correction carries: M2 design doc — step budget is 10k default / 25k max via limits.steps (NOT 25k running, design §5/§11); variablesSnapshotOmitted flag note (§6); retry-after-noPath semantics note (§6). runtime-contracts.md + openapi: /jobs/fail `retryable` is advisory/IGNORED (errorCode is the only business/technical switch; quickstart examples too). compensationCompleted diagnostics lack occurrence — add occurrence to the event OR note asymmetry (small code change allowed if trivial and tested).
7. M3 follow-up notes (record in backlog EPIC M3 or task notes, do NOT implement): honor-or-drop retryable; incident_id filter for setIncidentResolution; advance resolution on cancelled-empty-ledger; conditionFailure incident kind; engine.ts extraction chore.
Constitution gate: npm run test green; npx wrangler deploy --dry-run; check:docs green.
<!-- SECTION:PLAN:END -->
