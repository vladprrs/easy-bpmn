---
id: TASK-78
title: 'M5-L2: Forward runtime — call-activity idempotency triad, apply-once decider, child→parent wake + DO-alarm self-heal'
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
  - TASK-77
documentation:
  - src/runtime/call-activity.ts
  - src/runtime/engine.ts
  - src/runtime/wake.ts
  - tests/integration/call-activity-forward.test.ts
  - tests/integration/call-activity-fixtures.ts
priority: high
ordinal: 33400
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer task M5-L2 Task 6 — the risk
apex of the layer._

`src/runtime/call-activity.ts` + the engine `driveLeaf` dispatch: deterministic content-addressed
child id (`childInstanceIdFor`, SHA-256 of parent:element:occurrence:iteration); `invokeChild`
commits provenance + child row + `callActivityInvoked` (+ boundary-timer arm) in ONE
persist-before-advance batch, then issues the idempotent Workflow start (direct mode runs the child
fully inline under `suppressParentNotify`); the apply step is issued ONLY when the child sits in a
forward-consumable terminal (`completed`|`errored`) so a memoized step result is always final (the
`svc-create`/`svc-apply` memoization discipline); `outputApplied` rows fast-forward write-free.
io pass-through both ways (branch overlay inside M4 regions); the child ledger step is ALWAYS
compensable (`saga_steps.child_instance_id`).

Child→parent wake: the post-drive notify hook tickles the parent through the `deliverJobResult`
seam (terminated-Workflow inline fallback included), the child-notify DO alarm is armed BEFORE the
tickle (a dropped tickle recovers in ≤30s, not the 1h backstop), and `wakeBackstop` is capped at
`CHILD_WAIT_BACKSTOP_MS = 5min` while any visit's child is `invoked`.
<!-- SECTION:DESCRIPTION:END -->

## Final Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped on `m5-l2-call-activity` (PR #5). Commit `5b5b854`. Matrix `CA-FWD-01` +
`CA-IDEMP-REDRIVE-01` (both modes; real-CF green — tickle timing well inside the hang-detector
deadline, Worker Version `9eef8161`).
<!-- SECTION:NOTES:END -->
