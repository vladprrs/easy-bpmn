---
id: TASK-45
title: 'M3-L4: Intermediate timer catch'
status: Done
assignee: []
created_date: '2026-06-11 17:19'
updated_date: '2026-06-12 16:03'
labels:
  - saga
  - engine
  - runtime
milestone: m-3
dependencies:
  - TASK-44
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
modified_files:
  - src/runtime/intermediate-timer.ts
  - src/runtime/timers.ts
  - src/runtime/engine.ts
  - src/runtime/boundary-timer.ts
  - src/bpmn/validator.ts
  - src/bpmn/graph.ts
  - src/bpmn/profile.ts
  - src/contracts/api.ts
  - docs/bpmn/09-easy-bpmn-profile.md
  - tests/integration/intermediate-timer.test.ts
  - tests/integration/intermediate-timer-backstop.test.ts
  - tests/unit/bpmn-validator.test.ts
  - tests/integration/jobs-retryable-reclaim.test.ts
priority: medium
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Delay step on the token path per design §4.4 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). New engine dispatch case (step naming timer:el#occ, own visit occurrence): park batch = timer row + timerArmed (first arm only) + park; arm the Scheduler DO; fire batch = timer_outcomes claim (plain INSERT) + status flip + history timerFired + advance along the single outgoing flow (status-guarded transition, existing pattern). Operator /cancel settles the armed timer via the decider exactly like the boundary case. Workflow mode: waitForEvent on a per-visit event type derived from element_id#occurrence via the existing sanitizer, sized per design §4.2; direct mode parks and resumes inline from fireTimer. Validator opens intermediateCatchEvent + timerEventDefinition: exactly one incoming and one outgoing flow; allowed at process level and inside a transaction (the saga scope stays open across the delay — deliberate); same timerEventDefinition well-formedness rules as boundary timers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Intermediate timer catch delays and advances at process level AND inside a transaction (scope stays open across the delay) — §7 gate 4, via runDurableObjectAlarm.
- [x] #2 Operator /cancel during a catch park settles the timer via the decider; a stray alarm afterwards is a no-op.
- [x] #3 Rewalk fast-forward: a fired catch is a write-free cursor move; an armed catch re-parks and re-arms idempotently.
- [x] #4 Validator accept/reject matrix for the catch rules (flow counts, malformed timerEventDefinition); docs/bpmn/09 marking flipped; check:docs green.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Intermediate timer catch (a delay step on the token path) per design §4.4. Commits 0069bb8 (runtime) + 564a177 (review fix). Reuses the TASK-44 boundary-timer machinery.

**New engine dispatch case (intermediate-timer.ts + engine.ts):** intermediateCatchEvent + timerEventDefinition is a token-path NODE (step timer:el#occ, the catch's OWN visit occurrence), unlike a host-referenced boundary. Park batch = insertTimerArmedStmt (kind intermediateCatch) + timerArmed history (first arm only) + park; then arm the Scheduler DO keyed timer:<timerId>. Fire (planIntermediateCatchFire, opened the intermediateCatch kind in fireTimer): ONE batch = PLAIN INSERT timer_outcomes 'fired' claim + flip + timerFired history + advance along the single outgoing flow — no host job/subscription (the catch IS the wait). Guard = instance non-terminal AND row armed AND fire_at<=now AND the catch is the current park. PK conflict → wholesale abort → no-op/convert.

**Reuse (no copy-paste):** factored timerSizedTimeout out of boundary-timer.ts (boundary wait sizing became a one-line wrapper); reused armTimerDO, isUniqueConstraintViolation, TimerWake, and the kind-agnostic cancelArmedTimersForInstance (operator /cancel settles a catch timer with NO new code). planIntermediateCatchFire / settleOverdueIntermediateCatchOnWake genuinely differ from the boundary versions (no host to abandon) — deliberately not over-shared. intermediate-timer.ts never imports the executor (same cycle-avoidance as boundary-timer.ts).

**Fast-forward:** fired catch = write-free cursor move; armed = idempotent re-park + DO re-arm. Mirrors getGatewayDecision.

**Lost-alarm backstop (§4.2/R5):** settleOverdueIntermediateCatchOnWake settles overdue catches inline on a timeout wake; covered in direct mode via the runInstance timeout-waitFor seam.

**Validator:** event-definition-aware branch — timer catch opens (exactly one incoming + one outgoing; allowed at process level AND inside a transaction, scope stays open across the delay; readTimerTrigger well-formedness). MESSAGE intermediate catch + eventBasedGateway STAY rejected ("M3 — not yet implemented", TASK-46); DEFERRED_GATEWAY_REASONS / check:docs guard-5 untouched. workflowTimerEventTypeFor(elementId, occ) per-visit event type (existing sanitizer). Review fix: readTimerTrigger's empty-definition reason made construct-neutral (no "boundary timer" leak when validating a catch) + pinned by a unit test.

**Docs:** docs/bpmn/09 flips the timer intermediate catch row interim→shipped (supported-set row + rule 15 + Shipped callout); message-catch + EBG left interim.

**Tests:** intermediate-timer.test.ts (gate 4: process-level + in-transaction delay/advance with scope-stays-open assertions via runDurableObjectAlarm; /cancel settles + stray-alarm no-op; rewalk fast-forward exactly-one-row/history), intermediate-timer-backstop.test.ts (overdue→fire-inline, early→repark, decided-cancelled→fallThrough), validator matrix. One out-of-scope assertion in jobs-retryable-reclaim.test.ts (TASK-40) scoped to its own instanceId — the prior global empty-lease-pool check was over-broad vs intent and exposed by vitest re-sharding; reviewer confirmed benign (cannot mask a re-lease regression; TASK-45 is purely additive).

**Review:** two-stage (spec ✅, code quality APPROVE). Full suite green (328), typecheck, check:docs, wrangler deploy --dry-run all green.
<!-- SECTION:FINAL_SUMMARY:END -->
