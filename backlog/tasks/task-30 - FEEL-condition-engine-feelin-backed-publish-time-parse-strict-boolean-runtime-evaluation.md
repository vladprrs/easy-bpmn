---
id: TASK-30
title: >-
  FEEL condition engine: feelin-backed publish-time parse + strict-boolean
  runtime evaluation
status: Done
assignee:
  - Claude
created_date: '2026-06-09 20:28'
updated_date: '2026-06-10 17:23'
labels:
  - saga
  - runtime
  - feel
  - tests
milestone: M2
dependencies: []
references:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - 'https://github.com/nikku/feelin'
  - src/runtime
documentation:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - docs/bpmn/03-gateways.md
priority: high
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
M2 resolves the saga-design §9 expression-language open question to FEEL via the `feelin` npm package (M2 design 2026-06-09 §2 decision 1, §7): the BPMN/DMN-ecosystem language (Camunda 8 semantics), pure-JS interpreter (lezer grammar + luxon), no eval/new Function — Workers-compatible — and edited natively by Camunda Modeler, preserving the canonicity/round-trip constitution clause. Add `src/runtime/expressions.ts` wrapping feelin: parseCondition(expr) for publish-time syntax validation (failure → material for a ValidationIssueData, element id attached by the validator caller), and evaluateCondition(expr, variables) → taken only on boolean `true`. FEEL null-tolerance is the standard semantics: a missing variable makes comparisons null → not taken, NOT an error; a hard interpreter error must be distinguishable so the engine can raise a deterministic incident. Evaluation context = the instance's current variables object (same JSON the service-task input uses).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 src/runtime/expressions.ts exposes publish-time parse and runtime evaluate; a flow is taken only when the expression evaluates to boolean true (no truthy coercion of numbers/strings/null — design §7).
- [x] #2 FEEL null-semantics unit tests: a condition referencing a missing variable evaluates to not-taken without raising; comparison, equality, range, and string operations are covered (design §10 scenario 9).
- [x] #3 A hard interpreter error is distinguishable from not-taken (typed result or dedicated throw) so the gateway dispatch can raise a deterministic incident instead of silently skipping the flow.
- [x] #4 Publish-time parse rejects invalid FEEL with a reason string suitable for the existing element-id + reason validation contract.
- [x] #5 Bundle check (R-M2-2): npx wrangler deploy --dry-run passes with feelin + luxon bundled; the resulting Worker bundle size is recorded in the task notes.
- [x] #6 Constitution gate: unit tests (plain vitest, no Workflow runtime needed); npm run test green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: subagent-driven (implementer + spec review + quality review) on branch m2-conditional-sagas.

1. `npm install feelin` (pulls luxon transitively); pin v7.x.
2. New src/runtime/expressions.ts wrapping feelin:
   - parseCondition(expr): publish-time syntax-only check -> { ok: true } | { ok: false, reason } (reason string feeds the validator's element-id+reason ValidationIssue contract; no element id here — caller attaches).
   - evaluateCondition(expr, variables): strict boolean-true contract — taken only on boolean true; numbers/strings/null/undefined are NOT taken. FEEL null-tolerance preserved (missing variable -> comparisons null -> not taken, NOT an error). Hard interpreter throw -> typed ExpressionEvaluationError (distinguishable so gateway dispatch can raise a deterministic incident).
   - Context = instance variables JSON object (same shape service-task input uses).
3. Unit tests (plain vitest, no Workflow runtime): boolean-true strictness; null-semantics matrix (missing var in comparison/equality/range/string ops -> not taken, no throw); parse rejects invalid FEEL with usable reason; hard-error path distinguishable.
4. Bundle check R-M2-2: npx wrangler deploy --dry-run with feelin imported from a shipped module; record bundle size in task notes.
5. npm run test green; typecheck green. Validator integration is TASK-33's job (this task only exposes the API).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented src/runtime/expressions.ts wrapping feelin 7.0.1 (pinned ^7.0.1; pulls luxon + lezer-feel transitively). API: parseCondition(expression) -> { ok: true } | { ok: false, reason } — publish-time syntax-only check via parseExpression lezer tree scan for error nodes (node.type.isError), never executes; reason names the offending expression (truncated at 120 chars) + error position, ready for the validator's element-id+reason ValidationIssueData contract (TASK-33 attaches the id); empty/whitespace-only expressions rejected explicitly. evaluateCondition(expression, variables) -> { taken, value, warnings } — taken strictly value === true (no truthy coercion: 1/"x"/null/lists NOT taken); FEEL null-tolerance preserved (feelin v7 evaluate returns {value, warnings}; missing variable -> value null + NO_VARIABLE_FOUND warning, NOT a throw -> not taken); raw value + warning messages exposed for gatewayDecisionEvaluated diagnostics (design §6). Hard interpreter failure (e.g. feelin SyntaxError) -> dedicated ExpressionEvaluationError (carries .expression, preserves cause) so TASK-34 gateway dispatch raises a deterministic incident.

Bundle check (R-M2-2, AC#5): feelin + all its deps declare sideEffects:false, so an unused import IS tree-shaken (verified: bare `import` and `void parseCondition` both left the bundle byte-identical at 401,770 B). Canary = real usage: GET / status body now includes `feel: parseCondition("true").ok` in src/index.ts (replaced by real validator/engine imports in TASK-33/34). With feelin+luxon bundled: npx wrangler deploy --dry-run passes; Total Upload 854.87 KiB / gzip 175.80 KiB (index.js 875,387 B raw) vs baseline 392.35 KiB / gzip 69.06 KiB (401,770 B) -> feelin+luxon cost ~462 KiB raw / ~107 KiB gzip; comfortably under the 1 MiB-gzip Worker limit.

Tests: tests/unit/expressions.test.ts — 23 unit tests (plain vitest, no SELF.fetch/D1): parse accept/reject matrix incl. position-in-reason + empty + unknown-names-parse-ok; strict boolean-true matrix; comparison/equality/range/between/string-ops (starts with, contains, matches) + nested-context coverage; null-tolerance matrix (missing var in comparison/equality/range/string/compound/nested -> not taken, no throw, warnings surfaced); hard-error distinguishability (typed throw, expression+cause preserved, not-taken never throws). All FEEL semantics verified against feelin's actual behavior first (probed via node). Full suite 159/159 green (136 baseline + 23 new); typecheck green.

Two-stage review done. Spec review: compliant (probed feelin edge cases independently). Quality review: Ready to merge; one Important doc fix applied in dee30f2 (JSON-safety caveat on ConditionEvaluation.value — Range/DateTime/function results must be normalized before persisting). Bundle (R-M2-2): 854.87 KiB raw / 175.80 KiB gzip vs 392.35/69.06 baseline ≈ +462 KiB raw, ample headroom under the 10 MB Workers Paid limit.

Carried forward: TASK-33 — remove the GET / bundle canary in src/index.ts (+ its comment block) once the validator imports parseCondition for real; consider a semantic lint for unary-test-syntax strings (`> 100`, `= "x"`) which parse OK as expressions but evaluate to non-boolean and silently never fire. TASK-34 — normalize evaluation values to JSON-safe before persisting evaluations/diagnostics.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added src/runtime/expressions.ts wrapping feelin ^7.0.1 (FEEL, Camunda 8 semantics, pure-JS, Workers-compatible): parseCondition(expr) — publish-time, execution-free lezer error-node scan returning {ok}|{ok:false,reason} ready for the element-id+reason validator contract; evaluateCondition(expr, variables) — strict boolean-true contract ({taken, value, warnings}), FEEL null-tolerance preserved (missing variable = not taken, no error), hard interpreter failures thrown as typed ExpressionEvaluationError for deterministic incidents. 23 unit tests pin the strict-boolean and null-tolerance contracts against real feelin (comparison/equality/range/string matrices). Bundle verified actually shipped via a GET / canary (feelin is sideEffects:false; bare imports tree-shake): 854.87 KiB raw / 175.80 KiB gzip, dry-run green. Tests 159/159. Commits dd8765c + dee30f2.
<!-- SECTION:FINAL_SUMMARY:END -->
