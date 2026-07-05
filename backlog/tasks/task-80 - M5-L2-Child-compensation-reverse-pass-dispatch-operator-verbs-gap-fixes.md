---
id: TASK-80
title: 'M5-L2: Child compensation (reverse-pass dispatch, CAS entry, no-op shortcut, compensationFailed) + operator verbs + probe-gap fixes'
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
  - TASK-79
documentation:
  - src/runtime/compensation.ts
  - src/runtime/call-activity.ts
  - src/persistence/saga.ts
  - src/index.ts
  - tests/integration/call-activity-compensation.test.ts
  - tests/integration/call-activity-operator.test.ts
  - tests/integration/matrix/call-activity.test.ts
priority: high
ordinal: 33600
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer tasks M5-L2 Tasks 9–10 + the
Task-12 probe-gap fixes._

Compensating a committed callActivity (Principle VI): `runCompensation` dispatches on
`saga_steps.child_instance_id` — a child step is compensated by CAS-ing the child
`{completed,cancelled} → compensating` (element-less cancel marker → the child's resume derives the
PROCESS-ROOT reverse pass) and driving the CHILD's OWN reverse pass over its retained ledger; an
empty child compensable ledger settles `compensated` immediately (no-op shortcut); a child
`compensationFailed` surfaces as the PARENT's own `compensationFailure` incident on the call element.
Every step issuance is gated on child-status reads outside the step (memoization safety).

Operator verbs: direct child `/cancel`/`/retry` → 409 naming the parent; `handleRetryInstance`
cascades depth-first into child `incident` AND `compensationFailed` (`retryChildSubtree` +
the extracted `retryInstanceCore`), with `operatorRetry {target:"childSubtree"}` history.

Probe-gap fixes (found by the Task-12 adversarial probes, fixed in the completion wave):
**GAP A** — `drainScopeSubtree` retains a live callActivity token via `retainCallStraggler`
(Hazard-cancel + ledger + consume; an errored child retains `notRequired`), so a later enclosing
reverse pass still compensates the drained child. **GAP B** — the process-root reverse pass and
`handleCancelInstance`'s count treat root scope (`''`) as an implicit subtree member
(`includeRootScope`), so a scope-less parent whose only compensable content is the callActivity
visit actually reverses the child on operator cancel.
<!-- SECTION:DESCRIPTION:END -->

## Final Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped on `m5-l2-call-activity` (PR #5). Commits `178bd3e` (compensation), `89b710b` (operator
verbs), `45a5ea0` (review fixes), `2cd0e29` (GAP A + GAP B, probes unskipped as
`CA-DRAIN-RETAIN-01` / `CA-ROOTSCOPE-CANCEL-01`). Real-CF smoke scenario (b): child `compensated`
+661ms after `release-stock`, parent `compensated` +1027ms after `refund-card` (correct order, pure
tickles); scenario (c): cascading retry through a terminated child Workflow green (Worker Version
`9eef8161`).
<!-- SECTION:NOTES:END -->
