---
id: TASK-41
title: >-
  M3-L2: Constitution 2.2.0 + full docs lockstep (09 interim state, 01-events
  fix, templates)
status: To Do
assignee: []
created_date: '2026-06-11 17:18'
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
priority: medium
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Governance opener of M3 — must land before any M3 construct ships (design §8, docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Amend constitution 2.1.0 → 2.2.0 for the FULL M3 construct set with the complete procedure (constitution.md:215-218): updated constitution + Sync Impact Report + semver reasoning + review of .specify/templates/plan-template.md and spec-template.md (both re-list the accepted construct set; both changed for M2) + the CLAUDE.md lockstep line (pinned to v2.1.0 today). Exact text targets: accepted set in Principle I (:55-67, milestone sentence :82-83); MVP-scope exclusions (:169-179) — drop `event-based` from the gateway line (:170), REQUALIFY (not delete) the events line (:171-172: timer START events and non-catch message events stay excluded), milestone parenthetical (:178-179), in-scope recap (:181-187). Update docs/bpmn/09 FULLY with explicit interim markings ("amended in v2.2.0; validator opens at L3/L4, until then rejects with reason 'M3 — not yet implemented'"): version pin 09:4, deferred table 09:249-250, preamble 09:244, lockstep sentence 09:383-384. Fix the stale 01-events.md scope section (:123-134 — already false for shipped M1/M2) and add check:docs stale-phrase patterns so it cannot regress (M2 precedent: commit 4d25d3a). Record an explicit Constitution Check for M3 (against 2.2.0, this design doc as spec source), noting the M2 procedural deviation (no spec.md/plan.md deltas, no recorded check) that M3 closes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Constitution at 2.2.0 with a Sync Impact Report enumerating every changed file; semver reasoning recorded; .specify templates and the CLAUDE.md lockstep line updated in the same change.
- [ ] #2 docs/bpmn/09 reflects v2.2.0 with the explicit interim state for not-yet-shipped constructs; npm run check:docs green.
- [ ] #3 01-events.md scope section corrected for M1/M2/M3 reality; new stale-phrase guards fail when the old wording is reintroduced.
- [ ] #4 A recorded Constitution Check for M3 exists and is referenced from this task, noting the M2 deviation it closes.
<!-- AC:END -->
