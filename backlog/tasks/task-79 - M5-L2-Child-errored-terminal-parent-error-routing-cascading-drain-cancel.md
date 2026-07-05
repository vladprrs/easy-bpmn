---
id: TASK-79
title: 'M5-L2: Child errored terminal + parent error routing; cascading drain/cancel (timer Hazard, subtree drain, operator cancel)'
status: Done
assignee:
  - claude
created_date: '2026-07-05 00:00'
updated_date: '2026-07-05 23:10'
labels:
  - saga
  - engine
  - m5
milestone: m-5
dependencies:
  - TASK-78
documentation:
  - src/runtime/call-activity.ts
  - src/runtime/child-cascade.ts
  - src/runtime/compensation.ts
  - src/runtime/boundary-timer.ts
  - tests/integration/call-activity-errors.test.ts
  - tests/integration/call-activity-drain.test.ts
priority: high
ordinal: 33500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer tasks M5-L2 Tasks 7–8._

`errored` (child-only terminal): a CHILD's uncaught error end settles `status='errored'` +
`error_code` (history `childErrored`) instead of a child-local `uncaughtError` incident; the parent
routes it exactly like a worker business error at the callActivity — the call's own error boundary →
M5-L1 hierarchical bubble → `uncaughtError` incident at the parent (`callActivityErrored` history;
guarding boundary timers settle `cancelled` atomically with the route). A child technical `incident`
does NOT notify the parent.

Cascading drain/cancel: `cancelChildCascade` (depth-first Hazard interrupt of non-terminal children —
abandon jobs, release subscriptions, cancel timers, terminate Workflow, CAS → `cancelled` +
`instanceCancelled {by:"parentDrain"}`, ledger retained, never regresses a terminal/compensating
child) + `cancelChildrenInSubtree` hooked into `drainScopeSubtree`, the callActivity-host timer fire,
and operator `/cancel`.
<!-- SECTION:DESCRIPTION:END -->

## Final Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped on `m5-l2-call-activity` (PR #5). Commits `88f98cc` (errored + routing), `0ef4407`
(cascade). Matrix `CA-ERR-BOUNDARY-01` + `CA-HAZARD-TIMER-01` (both modes; real-CF green, real PT3S
DO alarm). Drain test [4]'s "never regress" assertion was later corrected by the GAP-B fix
(`2cd0e29`): a completed child is never *cancelled*, but IS properly `compensated` on parent cancel.
<!-- SECTION:NOTES:END -->
