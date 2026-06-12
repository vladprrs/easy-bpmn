---
id: TASK-42
title: >-
  M3-L2: Free error-boundary routing (multi-boundary, catch-all, token-path
  targets)
status: Done
assignee:
  - Claude
created_date: '2026-06-11 17:18'
updated_date: '2026-06-12 06:28'
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
modified_files:
  - src/bpmn/validator.ts
  - src/runtime/forward-task.ts
  - tests/unit/bpmn-validator.test.ts
  - tests/integration/error-routing.test.ts
  - docs/bpmn/09-easy-bpmn-profile.md
priority: medium
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lift the M1 validator rule "the error boundary's single outgoing flow must target a cancel end event" (src/bpmn/validator.ts:826-840) per design §3 error-routing (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). Accept per activity: any number of interrupting error boundaries whose errorRefs resolve to Errors with DISTINCT, NON-EMPTY @errorCode values (duplicate codes rejected — matching is by @errorCode; an errorRef to an Error with no/empty errorCode rejected rather than acting as a hidden catch-all), plus at most one catch-all boundary (errorEventDefinition without errorRef). Targets: any TOKEN-PATH node in the same scope — not a start event, not another boundary event, not an isForCompensation handler (M2 endpoint rules validator.ts:564-595 unchanged). NEW validator rule: boundary events on isForCompensation handlers are rejected (a handler IS a serviceTask; today only flows TARGETING handlers are caught — a boundary's outgoing flow would leak a token out of the compensation lane). Matching precedence: exact @errorCode → catch-all → Hazard (Constitution VI untouched); catch-all catches undeclared codes. An error handled by an alternate path inside a transaction leaves the saga ledger untouched (completed steps stay compensatable). Requires the constitution 2.2.0 amendment (TASK-41) to have landed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Distinct errorCodes on one task route to distinct modeled paths; catch-all catches an undeclared code; an unmatched code without catch-all stays a Hazard (integration tests, §7 gate 7).
- [x] #2 Error caught into an alternate path inside a transaction, saga continues, later cancel compensates ALL completed forward steps (pre- and post-error) in reverse (integration test, §7 gate 8).
- [x] #3 Validator accept/reject matrix: duplicate errorCodes, empty-errorCode errorRef, second catch-all, boundary event on a compensation handler, boundary flow into a start event/boundary event/handler — each rejected with element id + reason; tolerate-and-ignore regression green.
- [x] #4 docs/bpmn/09 error-routing text (09:209, 09:296) updated in lockstep; check:docs green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implementer + two-stage review, TDD. Validator (src/bpmn/validator.ts:813-841 error-boundary rule): (a) lift the "single outgoing flow must target a cancel end event" restriction → target must be any dispatchable token-path node in the SAME scope (not startEvent/boundaryEvent/handler; boundary+handler already covered by M2 endpoint rules 564-595; add start-event + same-scope + keep exactly-one-outgoing); (b) catch-all support — an error boundary with NO errorRef is a catch-all (allowed, ≤1 per activity); an errorRef present MUST resolve to an Error with NON-EMPTY errorCode (reject empty/missing); (c) per-activity aggregation: distinct non-empty errorCodes (reject duplicates), ≤1 catch-all; (d) NEW general rule: a boundary event attached to an isForCompensation handler is rejected (handler IS a serviceTask). Engine (forward-task.ts:45 errorBoundaryTarget): exact @errorCode match → catch-all (errorCode==null) → null(→Hazard); target is node.next (any token-path node); cancel-end target still triggers compensation via the loop, alternate-path target continues with ledger intact. Docs/bpmn/09: flip supported-set table (:218), rule 11 (:328-329), prose (:92-93,:170-176), update interim row :269 to shipped. Requires constitution 2.2.0 (TASK-41 done). Gates: full suite + new accept/reject matrix + §7 gates 7-8 + check:docs green.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Lifted the M1 "an error boundary's single outgoing flow must target a cancel end event" restriction, implementing free error-boundary routing per design §3.

**Validator (src/bpmn/validator.ts):**
- Error boundary's single outgoing flow may now target ANY token-path node in the same scope (no longer cancel-end-only). Forbidden targets (start event, another boundary event, compensation handler, cross-scope) are rejected by the per-flow endpoint rules; only the exactly-one-outgoing degree is checked on the boundary.
- NEW general rule: a boundary event attached to an isForCompensation handler is rejected (a handler IS a serviceTask, so the per-kind "must attach to a service task" check would otherwise pass it). Placed before per-kind checks with `continue` so exactly one accurate reason fires.
- NEW general rule: a sequence flow targeting a start event is rejected (added generally so L3 timer boundaries inherit it).
- errorRef handling: a coded boundary's errorRef must resolve to a <bpmn:error> with a NON-EMPTY @errorCode (empty/missing → rejected as a hidden catch-all); a dangling errorRef (dropped by bpmn-moddle) is recovered from parser warnings keyed by the owning boundary id and rejected, not silently treated as a catch-all. A boundary with NO errorRef is the catch-all (errorCode stays null).
- NEW per-activity aggregation: coded boundaries must have DISTINCT @errorCodes (duplicates rejected) and at most ONE catch-all per activity (second catch-all rejected), each naming the offending boundary by id.

**Engine (src/runtime/forward-task.ts):** errorBoundaryTarget precedence is exact @errorCode → catch-all (errorCode==null) → null (→ Hazard), deterministic regardless of node-iteration order. After validation a null errorCode unambiguously means catch-all, so it catches any business code including undeclared ones. Alternate-path targets continue the saga with the ledger intact; a cancel-end target still triggers compensation via the existing loop.

**Docs (docs/bpmn/09):** supported-set Error-Boundary row, rule 11, single-token note, and prose updated in lockstep; the interim/deferred-table row moved to a "Shipped" callout. check:docs green.

**Tests:** tests/unit/bpmn-validator.test.ts accept/reject matrix (multi-boundary+catch-all accept; duplicate code, empty-code errorRef, second catch-all, boundary-on-handler, flow-into-start/boundary/handler reject; tolerate-and-ignore regression). tests/integration/error-routing.test.ts §7 gates 7-8 (matching precedence incl. undeclared→catch-all and unmatched→Hazard; alternate-path leaves ledger intact → operator /cancel compensates pre- AND post-error steps in reverse).

**Review:** two-stage (spec compliance ✅, code quality APPROVE). Folded in code-quality polish: removed a dead presence flag in errorBoundaryTarget, added a CAUTION comment naming the pin test for the moddle-warning coupling (matching the sibling bpmn:default block), and pinned the single-reason guarantee on the handler-boundary test with toHaveLength(1).

Full suite green (263 tests), typecheck clean, check:docs green. Completes M3-L2 (governance landed in TASK-41).
<!-- SECTION:FINAL_SUMMARY:END -->
