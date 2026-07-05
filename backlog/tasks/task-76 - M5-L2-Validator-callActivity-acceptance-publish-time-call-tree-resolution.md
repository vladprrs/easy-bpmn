---
id: TASK-76
title: 'M5-L2: Validator callActivity acceptance + publish-time call-tree resolution (version binding, MAX_CALL_DEPTH, rejects)'
status: Done
assignee:
  - claude
created_date: '2026-07-05 00:00'
updated_date: '2026-07-05 23:10'
labels:
  - saga
  - bpmn
  - m5
milestone: m-5
dependencies:
  - TASK-75
documentation:
  - src/bpmn/validator.ts
  - src/bpmn/call-resolution.ts
  - src/runtime/engine.ts
  - tests/unit/validator-call-activity.test.ts
  - tests/integration/call-activity-publish.test.ts
priority: high
ordinal: 33200
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer tasks M5-L2 Tasks 2–3._

The pure validator accepts `callActivity` as a LEAF node (document-local rules: `calledElement`
required; same-document non-process target — e.g. `bpmn:globalTask` — gets its own explicit reject;
`multiInstanceLoopCharacteristics` on a call rejects with the M5-L3 roadmap pointer;
`camunda:calledElementBinding`/`calledElementVersion` tolerated-and-ignored; error/timer boundaries
attach). `InstanceStatusValue` + `TERMINAL_INSTANCE_STATUSES` gain the child-only `errored` terminal.

Publish-time call-tree resolution (`src/bpmn/call-resolution.ts`, Principle II): every call binds to
the **latest published** version of its target process in the same workspace and is pinned immutably
(`calledDefinitionVersionId`); the resolved (immutable-DAG) tree is walked enforcing
`MAX_CALL_DEPTH = 4` (`src/runtime/engine.ts`, `check:docs`-synced), a defensive cycle check, and the
v1 reject of any `receiveTask`/message `intermediateCatchEvent` anywhere in the tree (a child
correlates on the technical `child:<id>` key — no correlation-key source). Self-reference pins the
previous version (no cycle by construction).
<!-- SECTION:DESCRIPTION:END -->

## Final Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped on `m5-l2-call-activity` (PR #5). Commits `6c22c23` (validator + errored enum), `ac2b73c`
(call resolution), `4327b06` (contract deferred-construct fixture swap). Matrix rejects
`CA-REJECT-MSG-01` / `CA-REJECT-DEPTH-01` / `CA-REJECT-UNRESOLVED-01`.
<!-- SECTION:NOTES:END -->
