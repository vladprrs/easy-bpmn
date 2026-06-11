---
id: TASK-44
title: >-
  M3-L3: Boundary timer runtime — arm/fire/races, abnormal-exit settlement,
  inspection
status: To Do
assignee: []
created_date: '2026-06-11 17:19'
labels:
  - saga
  - engine
  - runtime
  - validator
milestone: m-3
dependencies:
  - TASK-39
  - TASK-43
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
priority: medium
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The core timer runtime per design §4.3 + §4.2 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Engine: interrupting boundary timer on serviceTask/receiveTask. Visit batch arms the timer; EVERY exit of a timer-guarded visit settles the decider (plain INSERT timer_outcomes outcome='cancelled' + bookkeeping flip) in its own batch — all four paths: normal completion (svc-apply), business error → error-boundary route, retry exhaustion → Hazard incident, operator /cancel (which also settles timers of abandoned visits). fireTimer: guard = instance non-terminal AND row armed AND fire_at<=now AND the timer's visit is still the current wait (job/subscription check, mirroring abandonActiveForwardJobs); then ONE batch = timer_outcomes INSERT 'fired' (the claim) + status flip + job abandon (late worker callback → existing stable no-op ack) / subscription supersede for receiveTask hosts + history timerFired + transition; on decider conflict the whole batch aborts and fireTimer converts (no-op). Loser-converts also on the completion side: deliverJobResult re-reads and acks the superseded no-op. Wake: Workflow sendEvent {outcome:'timerFired', timerId} on the wait's event type (job → workflowJobEventTypeFor; recv → subscription's stored workflow_event_type); direct → resumeInline. Timer-guarded waits NEVER raise waitTimeout; Workflow waitForEvent sized to max(SVC_WAIT_TIMEOUT, fire_at−now+slack) → O(1) steps for long timers, doubles as lost-alarm backstop with overdue settling on any wake. Validator opens boundary timers: interrupting only (cancelActivity=false → 'M4' reason; non-interrupting ERROR boundary → 'invalid BPMN' reason, never M4), at most one timer boundary per activity, not on transaction (M5) or isForCompensation handlers, timerEventDefinition well-formedness (exactly one of timeDate|timeDuration, parseable static ISO-8601; timeCycle/FEEL/zero-or-two children rejected). API: GET /instances/{id} gains the timers block (D1-read). Docs: 09 interim marking flipped to accepted for boundary timers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Boundary timer on a service task fires → alternate path taken; late worker callback gets the stable no-op ack (§7 gate 1).
- [ ] #2 Boundary timer on a task inside a transaction → cancel end → reverse compensation of completed steps (§7 gate 2 / exit criterion 2).
- [ ] #3 Timer-vs-completion race in BOTH orders: the loser's batch aborts on the timer_outcomes conflict and converts (§7 gate 3), driven via runDurableObjectAlarm in direct mode.
- [ ] #4 Boundary timer on a receive task supersedes the active subscription; a late publish gets the stable buffered/no-match outcome (§7 gate 6).
- [ ] #5 Abnormal-exit settlement: error-boundary exit, retry exhaustion, and operator /cancel each cancel the armed timer; a stray alarm afterwards is a no-op — no mid-compensation firing (§7 gate 10).
- [ ] #6 A wait guarded by a modeled timer never raises waitTimeout; an un-guarded wait still does (regression).
- [ ] #7 Validator accept/reject matrix for every boundary-timer rule with element id + reason; inspection timers block in openapi + contract tests; docs/bpmn/09 markings flipped; check:docs green.
<!-- AC:END -->
