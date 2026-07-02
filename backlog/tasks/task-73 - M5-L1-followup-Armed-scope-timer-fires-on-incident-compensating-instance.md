---
id: TASK-73
title: 'M5-L1 follow-up: armed scope timer fires on an incident/compensating instance, silently unfreezing it'
status: Done
assignee: []
created_date: '2026-07-02 00:00'
updated_date: '2026-07-02 18:40'
labels:
  - saga
  - engine
  - m5
  - follow-up
milestone: m-5
dependencies:
  - TASK-70
documentation:
  - docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md
priority: medium
ordinal: 32900
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Follow-up from the M5-L1 final whole-branch review (PR #4) Important finding #4, reviewer-sanctioned._

A scope timer, once armed at scope entry (TASK-69), is disarmed on every scope *exit* path the engine
walk knows about — but an instance can be moved out of `running` (into `incident` or `compensating`) by a
path the timer-arming logic doesn't observe: an unrelated sibling's technical incident, or an operator
`/cancel`. The timer's alarm is unaware of instance status and can still fire while the instance is
frozen, and the current fire handler does not check status before acting — it silently unfreezes/
interrupts a scope on an instance the operator or engine had deliberately parked, which is surprising and
could race with an in-flight operator action (e.g. a concurrent `/cancel`/`/retry`).

**Needs a policy decision before implementation** (per the reviewer, this is a design choice, not a bug
fix with one obvious answer):
- **Option A — skip:** the fire handler checks instance status; if not `running`, it no-ops (leaves the
  timer's ledger/audit trail showing "fired but suppressed") and does nothing further. Simple, but the
  timer effectively vanishes — does the scope still get interrupted later, or never?
- **Option B — Hazard-escape with atomic incident resolution:** the fire is still recorded, but folded
  into whatever terminal/incident-resolution flow is already in progress atomically (e.g. as an additional
  cause on the existing incident) rather than driving its own independent transition.

Whichever is chosen, document the decision in the design doc and `docs/bpmn/09-easy-bpmn-profile.md`, then
implement + test both host kinds (transaction + subProcess) with a concurrent-incident and a concurrent-
`/cancel` scenario.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Policy decided (Option A skip vs Option B atomic Hazard-escape, or a documented alternative) and recorded in the design doc
- [x] #2 `docs/bpmn/09-easy-bpmn-profile.md` documents the chosen timer-vs-frozen-instance policy
- [x] #3 The scope-timer fire handler checks instance status before acting, per the chosen policy
- [x] #4 Integration test: a scope timer armed on a branch fires while the instance is already `incident` (sibling technical failure) — behavior matches the documented policy, no silent unfreeze
- [x] #5 Integration test: a scope timer fires concurrently with an operator `/cancel` — no race/double-transition
- [x] #6 Full suite stays green
<!-- AC:END -->
