---
id: TASK-35
title: >-
  Loop guard: MAX_ELEMENT_OCCURRENCES cap with loopLimit incident and Hazard
  semantics
status: To Do
assignee: []
created_date: '2026-06-09 20:30'
labels:
  - saga
  - engine
  - runtime
  - incidents
  - tests
milestone: M2
dependencies:
  - TASK-32
references:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - src/runtime/engine.ts
  - wrangler.jsonc
documentation:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
priority: medium
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
M2 design 2026-06-09 §5 (loop guard), §2 decision 2, risk R-M2-5. With cycles legal, a modeling error or adversarial data can loop forever, burning the Workflow step budget (wrangler limits.steps 25000; ~5 steps per task iteration). Add MAX_ELEMENT_OCCURRENCES = 1000 as an engine constant: when a walk-local visit counter exceeds it, settle a terminal incident kind=loopLimit (element id + occurrence count in diagnostics). Inside a transaction this is Hazard semantics (saga design §4.5): no auto-compensation; operator POST /instances/{id}/cancel stays available to force the reverse pass. The guard counts walk-local visits, NOT lease attempts — technical retries of a single iteration must not consume the cap. Document the per-iteration step cost and the cap rationale next to the limits.steps setting.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A model looping past the cap settles a terminal incident kind=loopLimit carrying the element id and occurrence count; instance status and incident resolution are consistent with the M1 incident lifecycle.
- [ ] #2 Inside a transaction the cap is a Hazard: no auto-compensation; a subsequent operator /cancel runs the reverse pass over the completed iterations (integration test).
- [ ] #3 Technical retries (re-lease, fail retryable=true) of one iteration do not consume the cap — only completed-visit re-entries count.
- [ ] #4 Per-iteration step cost and the 1000-visit cap rationale are documented next to the workflow limits.steps configuration (wrangler config comment or linked doc).
- [ ] #5 Constitution gate: integration test for the loopLimit path; npm run test green.
<!-- AC:END -->
