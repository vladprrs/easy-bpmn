---
id: TASK-81
title: 'M5-L2: Verification wave — lineage/console delta, matrix registry wave, docs lockstep, workflow-mode Layer B, real-CF smoke, PR'
status: Done
assignee:
  - claude
created_date: '2026-07-05 00:00'
updated_date: '2026-07-05 23:10'
labels:
  - saga
  - bpmn
  - m5
  - ui
milestone: m-5
dependencies:
  - TASK-80
documentation:
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - specs/002-saga-orchestrator/contracts/runtime-contracts.md
  - specs/002-saga-orchestrator/data-model.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/02-activities.md
  - tests/matrix/registry.ts
  - tests/workflow-mode/matrix.wf.test.ts
priority: high
ordinal: 33700
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-28** (M5 — Composition), milestone `m-5`. Layer tasks M5-L2 Tasks 11–14; closes
the layer._

Lineage/console delta: `GET /instances/{id}` gains the `lineage` block, `GET /instances?root=true`
filters saga roots, the SPA gains parent/child navigation + the `errored` humanization; openapi in
lockstep. Matrix: 13 `CA-*` scenarios registered (10 dual-mode + 3 publish rejects; later +2 gap
probes = 86 total), `check:matrix` green at phase 3 / 0 warnings. Docs lockstep: 09-profile flipped
to shipped with the full M5-L2 semantics (io pass-through divergence note, publish-time binding,
`MAX_CALL_DEPTH = 4` `check:docs`-synced, message-wait v1 reject, operator-verbs-via-root, `errored`
terminal), 02-activities row corrected, runtime-contracts + data-model M5-L2 sections, CLAUDE.md +
spec.md layer status.

Workflow-mode Layer B: 5 live CA liveness re-runs vs `wrangler dev` (38 passed / 27 skipped overall);
the CA-COMP-* reverse flips join the documented `@needs-real-cf` wake-backstop class;
`CA-INCIDENT-RETRY-01` is `@needs-real-cf` for a verified PRE-EXISTING local gap (miniflare
`sendEvent` to a terminated Workflow silently succeeds, so the inline-fallback seam never fires
locally — reproduced on a plain no-callActivity instance).

Real-CF smoke (the mandatory DoD gate, Worker Version `9eef8161-d94c-49f1-be67-9c2e0e6f471d`,
2026-07-05): (a) forward happy path + dropped-tickle timing + the 5 live CA wf tests re-run green
against production; (b) `SETTLE_REJECTED` cancel → the child's own reverse pass over its terminated
Workflow (child `compensated` +661ms, parent +1027ms, correct order); (c) cascading `/retry` through
a child incident (the seam miniflare cannot exercise) → parent `completed` +1054ms. Remote D1
migration 0008 applied (additive-only) before deploy.
<!-- SECTION:DESCRIPTION:END -->

## Final Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped on `m5-l2-call-activity` (**PR #5**). Commits `b52549f` (lineage/console), `7f3be31`
(matrix wave), `e571fc7` (docs lockstep), `be94304` (workflow-mode CA wave). Full local gate green:
651 tests + 46 matrix + `check:docs` + `check:matrix` (86/0 warnings) + `tsc` (worker + SPA) + SPA
build + `wrangler deploy --dry-run`. Next layer: M5-L3 (`multiInstanceLoopCharacteristics`).
<!-- SECTION:NOTES:END -->
