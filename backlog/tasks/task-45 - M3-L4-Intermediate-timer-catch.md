---
id: TASK-45
title: 'M3-L4: Intermediate timer catch'
status: To Do
assignee: []
created_date: '2026-06-11 17:19'
labels:
  - saga
  - engine
  - runtime
milestone: m-3
dependencies:
  - TASK-44
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
priority: medium
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Delay step on the token path per design §4.4 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). New engine dispatch case (step naming timer:el#occ, own visit occurrence): park batch = timer row + timerArmed (first arm only) + park; arm the Scheduler DO; fire batch = timer_outcomes claim (plain INSERT) + status flip + history timerFired + advance along the single outgoing flow (status-guarded transition, existing pattern). Operator /cancel settles the armed timer via the decider exactly like the boundary case. Workflow mode: waitForEvent on a per-visit event type derived from element_id#occurrence via the existing sanitizer, sized per design §4.2; direct mode parks and resumes inline from fireTimer. Validator opens intermediateCatchEvent + timerEventDefinition: exactly one incoming and one outgoing flow; allowed at process level and inside a transaction (the saga scope stays open across the delay — deliberate); same timerEventDefinition well-formedness rules as boundary timers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Intermediate timer catch delays and advances at process level AND inside a transaction (scope stays open across the delay) — §7 gate 4, via runDurableObjectAlarm.
- [ ] #2 Operator /cancel during a catch park settles the timer via the decider; a stray alarm afterwards is a no-op.
- [ ] #3 Rewalk fast-forward: a fired catch is a write-free cursor move; an armed catch re-parks and re-arms idempotently.
- [ ] #4 Validator accept/reject matrix for the catch rules (flow counts, malformed timerEventDefinition); docs/bpmn/09 marking flipped; check:docs green.
<!-- AC:END -->
