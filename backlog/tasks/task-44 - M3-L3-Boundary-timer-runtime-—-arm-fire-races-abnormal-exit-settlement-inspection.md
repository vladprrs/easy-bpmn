---
id: TASK-44
title: >-
  M3-L3: Boundary timer runtime — arm/fire/races, abnormal-exit settlement,
  inspection
status: Done
assignee: []
created_date: '2026-06-11 17:19'
updated_date: '2026-06-12 08:23'
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
modified_files:
  - src/runtime/boundary-timer.ts
  - src/runtime/timers.ts
  - src/runtime/iso8601.ts
  - src/runtime/forward-task.ts
  - src/runtime/engine.ts
  - src/runtime/executor.ts
  - src/bpmn/validator.ts
  - src/bpmn/graph.ts
  - src/bpmn/profile.ts
  - src/contracts/workflow-events.ts
  - src/contracts/api.ts
  - src/index.ts
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - docs/bpmn/09-easy-bpmn-profile.md
  - tests/integration/boundary-timer.test.ts
  - tests/integration/boundary-timer-backstop.test.ts
  - tests/integration/wait-cap-incidents.test.ts
  - tests/unit/bpmn-validator.test.ts
  - tests/unit/fire-timer.test.ts
  - tests/unit/job-scheduler.test.ts
priority: medium
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The core timer runtime per design §4.3 + §4.2 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Engine: interrupting boundary timer on serviceTask/receiveTask. Visit batch arms the timer; EVERY exit of a timer-guarded visit settles the decider (plain INSERT timer_outcomes outcome='cancelled' + bookkeeping flip) in its own batch — all four paths: normal completion (svc-apply), business error → error-boundary route, retry exhaustion → Hazard incident, operator /cancel (which also settles timers of abandoned visits). fireTimer: guard = instance non-terminal AND row armed AND fire_at<=now AND the timer's visit is still the current wait (job/subscription check, mirroring abandonActiveForwardJobs); then ONE batch = timer_outcomes INSERT 'fired' (the claim) + status flip + job abandon (late worker callback → existing stable no-op ack) / subscription supersede for receiveTask hosts + history timerFired + transition; on decider conflict the whole batch aborts and fireTimer converts (no-op). Loser-converts also on the completion side: deliverJobResult re-reads and acks the superseded no-op. Wake: Workflow sendEvent {outcome:'timerFired', timerId} on the wait's event type (job → workflowJobEventTypeFor; recv → subscription's stored workflow_event_type); direct → resumeInline. Timer-guarded waits NEVER raise waitTimeout; Workflow waitForEvent sized to max(SVC_WAIT_TIMEOUT, fire_at−now+slack) → O(1) steps for long timers, doubles as lost-alarm backstop with overdue settling on any wake. Validator opens boundary timers: interrupting only (cancelActivity=false → 'M4' reason; non-interrupting ERROR boundary → 'invalid BPMN' reason, never M4), at most one timer boundary per activity, not on transaction (M5) or isForCompensation handlers, timerEventDefinition well-formedness (exactly one of timeDate|timeDuration, parseable static ISO-8601; timeCycle/FEEL/zero-or-two children rejected). API: GET /instances/{id} gains the timers block (D1-read). Docs: 09 interim marking flipped to accepted for boundary timers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Boundary timer on a service task fires → alternate path taken; late worker callback gets the stable no-op ack (§7 gate 1).
- [x] #2 Boundary timer on a task inside a transaction → cancel end → reverse compensation of completed steps (§7 gate 2 / exit criterion 2).
- [x] #3 Timer-vs-completion race in BOTH orders: the loser's batch aborts on the timer_outcomes conflict and converts (§7 gate 3), driven via runDurableObjectAlarm in direct mode.
- [x] #4 Boundary timer on a receive task supersedes the active subscription; a late publish gets the stable buffered/no-match outcome (§7 gate 6).
- [x] #5 Abnormal-exit settlement: error-boundary exit, retry exhaustion, and operator /cancel each cancel the armed timer; a stray alarm afterwards is a no-op — no mid-compensation firing (§7 gate 10).
- [x] #6 A wait guarded by a modeled timer never raises waitTimeout; an un-guarded wait still does (regression).
- [x] #7 Validator accept/reject matrix for every boundary-timer rule with element id + reason; inspection timers block in openapi + contract tests; docs/bpmn/09 markings flipped; check:docs green.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Interrupting boundary-timer runtime per design §4.1–4.3, §4.6, §5.1. Commits 525c941 (runtime) + a6fc248 (R5 backstop fix) + ee336c0 (backstop test).

**Validator (validator.ts/graph.ts/profile.ts/iso8601.ts):** accept-and-validate boundaryEvent + timerEventDefinition — interrupting only (cancelActivity=false → M4 reason), on serviceTask/receiveTask (never transaction → M5, never isForCompensation handler — TASK-42's general rule covers it), ≤1 timer boundary per activity, exactly one outgoing flow (TASK-42 endpoint rules reused), timerEventDefinition well-formedness (exactly one of static ISO-8601 timeDate|timeDuration; timeCycle/FEEL/zero-or-two/non-parsing rejected). 15-case accept/reject matrix, each reason names element id. New iso8601.ts parses durations/datetimes (gates publish + computes fire_at).

**Arm:** insertTimerArmedStmt + timerArmed history composed into the host's visit batch (first-arm only), then armTimer on the JobScheduler DO keyed timer:<timerId>. Occurrence = host activity's visit occurrence.

**Fire (boundary-timer.ts/timers.ts):** the winning batch = PLAIN INSERT timer_outcomes 'fired' claim + status flip + abandon in-flight job / supersede active subscription + timerFired history + transition, all in ONE dbBatch. On decider PK conflict the whole batch aborts → convertOnFire re-reads + routes the loser to the recorded outcome (no double-advance). Wakes via Executor.wakeTimer (direct: resumeInline; workflow: sendEvent {outcome:'timerFired'}).

**Four-exit decider settlement:** normal completion, business-error route, message-apply each splice the cancel-claim atomically into their transition batch (conflict → convert); retry-exhaustion Hazard + operator /cancel settle in their own batch. A stray alarm after any exit no-ops (gate 10).

**Fast-forward:** timer_outcomes='fired' checked at the top of driveForwardServiceTask/driveReceiveTask — write-free advance to boundary.next; 'cancelled' falls through to normal handling. Mirrors getGatewayDecision; a fired-with-no-transition state cannot exist.

**Wait cap (§4.2/R5):** a timer-guarded wait never raises waitTimeout; the Workflow-mode waitForEvent is sized to max(SVC_WAIT_TIMEOUT, fire_at−now+slack) and doubles as the lost-alarm backstop — settleOverdueBoundaryTimerOnWake settles overdue timers inline on any wake (no executor call → no import cycle; the wake path returns the next step to the drive loop). Un-guarded waits still raise waitTimeout.

**API/docs:** GET /instances/{id} gains a timers block (D1-read via listTimersForInstance); openapi TimerView schema + contract test; docs/bpmn/09 flips boundary timers interim→shipped (rule 14 + supported-set row + Shipped callout). Job-result union gained {outcome:'timerFired'}.

**Tests:** integration gates 1 (alt path + late no-op ack), 2 (in-transaction → cancel end → reverse compensation), 3 (both race orders via runDurableObjectAlarm), 6 (receive-task supersede → late publish buffered), 10 (all 3 abnormal exits + stray-alarm no-op); wait-cap-incidents regression (guarded never raises waitTimeout, un-guarded still does); boundary-timer-backstop (the R5 wake-settle path in direct mode via timeout-waitFor — mutation-verified: reverting the fix fails the overdue case); validator matrix; contract test; TASK-43 seam tests updated to drive real fires.

**Review:** two-stage. Spec ✅ (race-decider discipline R2 verified across all 4 exits + both race orders; one gap found = the R5 backstop, fixed in a6fc248). Code quality APPROVE (verified the a6fc248 refactor is behavior-preserving/byte-identical alarm batch + import-cycle boundary sound; Issue 1 = backstop test debt, closed in ee336c0).

Workflow-mode-only paths verified by reading (sendEvent timerFired wake, timer-sized waitForEvent) per the M1/M2 precedent; CI forces EXECUTION_MODE=direct. Full suite green (309), typecheck, check:docs, wrangler deploy --dry-run all green. Completes M3-L3 (exit criteria 1-2).
<!-- SECTION:FINAL_SUMMARY:END -->
