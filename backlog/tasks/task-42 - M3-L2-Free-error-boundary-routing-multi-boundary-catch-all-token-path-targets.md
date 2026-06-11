---
id: TASK-42
title: >-
  M3-L2: Free error-boundary routing (multi-boundary, catch-all, token-path
  targets)
status: To Do
assignee: []
created_date: '2026-06-11 17:18'
labels:
  - saga
  - bpmn
  - engine
  - validator
milestone: m-3
dependencies:
  - TASK-38
  - TASK-41
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
priority: medium
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lift the M1 validator rule "the error boundary's single outgoing flow must target a cancel end event" (src/bpmn/validator.ts:826-840) per design §3 error-routing (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Accept per activity: any number of interrupting error boundaries whose errorRefs resolve to Errors with DISTINCT, NON-EMPTY @errorCode values (duplicate codes rejected — matching is by @errorCode; an errorRef to an Error with no/empty errorCode rejected rather than acting as a hidden catch-all), plus at most one catch-all boundary (errorEventDefinition without errorRef). Targets: any TOKEN-PATH node in the same scope — not a start event, not another boundary event, not an isForCompensation handler (M2 endpoint rules validator.ts:564-595 unchanged). NEW validator rule: boundary events on isForCompensation handlers are rejected (a handler IS a serviceTask; today only flows TARGETING handlers are caught — a boundary's outgoing flow would leak a token out of the compensation lane). Matching precedence: exact @errorCode → catch-all → Hazard (Constitution VI untouched); catch-all catches undeclared codes. An error handled by an alternate path inside a transaction leaves the saga ledger untouched (completed steps stay compensatable). Requires the constitution 2.2.0 amendment (TASK-41) to have landed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Distinct errorCodes on one task route to distinct modeled paths; catch-all catches an undeclared code; an unmatched code without catch-all stays a Hazard (integration tests, §7 gate 7).
- [ ] #2 Error caught into an alternate path inside a transaction, saga continues, later cancel compensates ALL completed forward steps (pre- and post-error) in reverse (integration test, §7 gate 8).
- [ ] #3 Validator accept/reject matrix: duplicate errorCodes, empty-errorCode errorRef, second catch-all, boundary event on a compensation handler, boundary flow into a start event/boundary event/handler — each rejected with element id + reason; tolerate-and-ignore regression green.
- [ ] #4 docs/bpmn/09 error-routing text (09:209, 09:296) updated in lockstep; check:docs green.
<!-- AC:END -->
