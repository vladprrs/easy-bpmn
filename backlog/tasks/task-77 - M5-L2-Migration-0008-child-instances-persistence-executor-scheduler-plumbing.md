---
id: TASK-77
title: 'M5-L2: Migration 0008 (child_instances provenance + parent linkage) + idempotent child create + JobScheduler child-notify marker'
status: Done
assignee:
  - claude
created_date: '2026-07-05 00:00'
updated_date: '2026-07-05 23:10'
labels:
  - saga
  - persistence
  - m5
milestone: m-5
dependencies:
  - TASK-76
documentation:
  - migrations/0008_call_activity.sql
  - src/persistence/child-instances.ts
  - src/persistence/instances.ts
  - src/persistence/saga.ts
  - src/runtime/executor.ts
  - src/durable-objects/job-scheduler.ts
  - tests/integration/migration-0008-call-activity.test.ts
priority: high
ordinal: 33300
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer tasks M5-L2 Tasks 4–5._

Migration `0008_call_activity.sql`: the `child_instances` provenance table (the rewalk fast-forward
predicate gating BOTH the child Workflow create and the output apply; UNIQUE per
`(parent, element, occurrence, iteration)` visit — the at-least-once single-apply guard), the four
`process_instances` parent-linkage/error columns, and `saga_steps.child_instance_id` (step-kind
dispatch: NULL = worker step, non-NULL = child step).

Plumbing: `WorkflowExecutor.start` treats duplicate-id `create()` as success (at-least-once child
creates never auto-id); `RunOptions.suppressParentNotify` threads through the engine
(`DirectExecutor.start` sets it — an inline child start under the parent's held drive lock must not
re-enter the parent); `JobScheduler` gains the third `childNotify` alarm marker with
`CHILD_NOTIFY_BACKOFF_MS = [30s, 2m, 10m, 30m]` (all far under the 1h wake backstop).
<!-- SECTION:DESCRIPTION:END -->

## Final Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped on `m5-l2-call-activity` (PR #5). Commits `0fa9a70` (migration + persistence), `3c9b542`
(executor/scheduler plumbing). Remote D1 migration applied (additive-only) before the real-CF smoke
deploy.
<!-- SECTION:NOTES:END -->
