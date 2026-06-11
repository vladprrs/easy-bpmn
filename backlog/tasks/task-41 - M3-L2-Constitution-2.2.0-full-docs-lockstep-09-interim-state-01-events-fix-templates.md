---
id: TASK-41
title: >-
  M3-L2: Constitution 2.2.0 + full docs lockstep (09 interim state, 01-events
  fix, templates)
status: Done
assignee:
  - Claude
created_date: '2026-06-11 17:18'
updated_date: '2026-06-11 19:12'
labels:
  - saga
  - governance
  - docs
milestone: m-3
dependencies: []
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
  - .specify/memory/constitution.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/01-events.md
modified_files:
  - .specify/memory/constitution.md
  - .specify/templates/plan-template.md
  - .specify/templates/spec-template.md
  - CLAUDE.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/01-events.md
  - scripts/check-docs.mjs
  - specs/002-saga-orchestrator/m3-constitution-check.md
priority: medium
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Governance opener of M3 — must land before any M3 construct ships (design §8, docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Amend constitution 2.1.0 → 2.2.0 for the FULL M3 construct set with the complete procedure (constitution.md:215-218): updated constitution + Sync Impact Report + semver reasoning + review of .specify/templates/plan-template.md and spec-template.md (both re-list the accepted construct set; both changed for M2) + the CLAUDE.md lockstep line (pinned to v2.1.0 today). Exact text targets: accepted set in Principle I (:55-67, milestone sentence :82-83); MVP-scope exclusions (:169-179) — drop `event-based` from the gateway line (:170), REQUALIFY (not delete) the events line (:171-172: timer START events and non-catch message events stay excluded), milestone parenthetical (:178-179), in-scope recap (:181-187). Update docs/bpmn/09 FULLY with explicit interim markings ("amended in v2.2.0; validator opens at L3/L4, until then rejects with reason 'M3 — not yet implemented'"): version pin 09:4, deferred table 09:249-250, preamble 09:244, lockstep sentence 09:383-384. Fix the stale 01-events.md scope section (:123-134 — already false for shipped M1/M2) and add check:docs stale-phrase patterns so it cannot regress (M2 precedent: commit 4d25d3a). Record an explicit Constitution Check for M3 (against 2.2.0, this design doc as spec source), noting the M2 procedural deviation (no spec.md/plan.md deltas, no recorded check) that M3 closes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Constitution at 2.2.0 with a Sync Impact Report enumerating every changed file; semver reasoning recorded; .specify templates and the CLAUDE.md lockstep line updated in the same change.
- [x] #2 docs/bpmn/09 reflects v2.2.0 with the explicit interim state for not-yet-shipped constructs; npm run check:docs green.
- [x] #3 01-events.md scope section corrected for M1/M2/M3 reality; new stale-phrase guards fail when the old wording is reintroduced.
- [x] #4 A recorded Constitution Check for M3 exists and is referenced from this task, noting the M2 deviation it closes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Governance opener (docs only, no runtime behavior change). Implementer subagent + two-stage review. Amend constitution 2.1.0→2.2.0 for the FULL M3 set (interrupting boundary timer on serviceTask/receiveTask, timer/message intermediateCatchEvent, eventBasedGateway, free error-boundary routing) with the complete procedure: Sync Impact Report + semver reasoning + Principle I accepted-set addition (55-67) + milestone sentence (82-83) + MVP-scope exclusions requalified (169-187, drop event-based, keep timer-START + non-catch message excluded) + version footer. Update .specify/templates/plan-template.md (47-51) + spec-template.md (19-27). CLAUDE.md lockstep v2.1.0→v2.2.0 (lines 29,103). docs/bpmn/09 FULLY with interim markings (version pin :4, move M3 constructs from deferred table to interim 'amended in v2.2.0; validator opens at L3/L4, until then rejects "M3 — not yet implemented"', preamble, lockstep sentence 383-384). Fix 01-events.md scope (123-134, false for M1/M2) + add check:docs stale-phrase patterns. Record an explicit M3 Constitution Check (vs 2.2.0, design doc as source, noting the M2 deviation). DO NOT touch profile.ts/DEFERRED_GATEWAY_REASONS, 03-gateways EBG→M3 pointer, or check:docs guard 5 (L4/TASK-46). DO NOT touch the validator (free error routing is TASK-42). Gate: check:docs + full suite green.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Governance opener of M3 — docs/governance only, ZERO runtime change.

- Constitution 2.1.0 -> 2.2.0: new Sync Impact Report (enumerates every changed file + semver reasoning); Principle I accepted-set gains the M3 bullet (interrupting boundary timer on serviceTask/receiveTask, timer/message intermediateCatchEvent, eventBasedGateway, free error routing; static ISO-8601 timeDate/timeDuration only) with the per-layer interim note; milestone sentence -> "(parallelism, composition)"; MVP-scope exclusions requalified (dropped event-based from gateways; events line keeps timer START / non-interrupting boundary timers / timeCycle / signal/escalation/conditional / non-catch message excluded); milestone parenthetical + in-scope recap extended; version footer 2.2.0.
- .specify templates: plan-template BPMN-profile gate + spec-template BPMN Profile Impact prompt now list the M3 set + interim state.
- CLAUDE.md: both lockstep refs (lines 29, 103/106) -> v2.2.0 + M3-accepted-but-staged.
- docs/bpmn/09: version pin -> v2.2.0; NEW "Accepted in v2.2.0, opened per validator layer" interim table (boundary timer L3; timer/message intermediate catch + eventBasedGateway L4; free error routing L2); deferred table requalified into "Still deferred (need a future amendment)" (keeps parallel/inclusive/complex gateways, EBG noted as M3-accepted-interim); lockstep sentence + roadmap line define the interim state.
- docs/bpmn/01-events.md scope section rewritten for M1/M2/M3 reality; two stale-phrase guards added to scripts/check-docs.mjs (verified: fire on the OLD wording, pass on the new).
- specs/002-saga-orchestrator/m3-constitution-check.md: recorded M3 Constitution Check (vs v2.2.0, design doc as spec source, both gate checks, principles I-VI confirmed, M2 procedural deviation closed). Referenced from 09.

UNTOUCHED (other tasks / later layers): src/bpmn/profile.ts DEFERRED_GATEWAY_REASONS, docs/bpmn/03-gateways.md EBG->M3 pointers, check:docs guard 5, all src/ runtime + validator (free error routing runtime is TASK-42).

Gate: npm run check:docs green; npm run typecheck clean; npm run test 249/249 (unchanged).
<!-- SECTION:NOTES:END -->
