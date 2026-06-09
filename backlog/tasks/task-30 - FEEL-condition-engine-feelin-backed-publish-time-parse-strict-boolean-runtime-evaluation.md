---
id: TASK-30
title: >-
  FEEL condition engine: feelin-backed publish-time parse + strict-boolean
  runtime evaluation
status: To Do
assignee: []
created_date: '2026-06-09 20:28'
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
- [ ] #1 src/runtime/expressions.ts exposes publish-time parse and runtime evaluate; a flow is taken only when the expression evaluates to boolean true (no truthy coercion of numbers/strings/null — design §7).
- [ ] #2 FEEL null-semantics unit tests: a condition referencing a missing variable evaluates to not-taken without raising; comparison, equality, range, and string operations are covered (design §10 scenario 9).
- [ ] #3 A hard interpreter error is distinguishable from not-taken (typed result or dedicated throw) so the gateway dispatch can raise a deterministic incident instead of silently skipping the flow.
- [ ] #4 Publish-time parse rejects invalid FEEL with a reason string suitable for the existing element-id + reason validation contract.
- [ ] #5 Bundle check (R-M2-2): npx wrangler deploy --dry-run passes with feelin + luxon bundled; the resulting Worker bundle size is recorded in the task notes.
- [ ] #6 Constitution gate: unit tests (plain vitest, no Workflow runtime needed); npm run test green.
<!-- AC:END -->
