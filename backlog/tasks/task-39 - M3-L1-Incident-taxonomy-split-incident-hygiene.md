---
id: TASK-39
title: 'M3-L1: Incident taxonomy split + incident hygiene'
status: Done
assignee:
  - Claude
created_date: '2026-06-11 17:17'
updated_date: '2026-06-11 18:30'
labels:
  - saga
  - runtime
  - api
milestone: m-3
dependencies:
  - TASK-38
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
modified_files:
  - src/persistence/instances.ts
  - src/runtime/forward-task.ts
  - src/runtime/engine.ts
  - src/runtime/retry-policy.ts
  - src/contracts/api.ts
  - src/index.ts
  - scripts/check-docs.mjs
  - docs/bpmn/09-easy-bpmn-profile.md
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - specs/002-saga-orchestrator/contracts/runtime-contracts.md
  - tests/integration/wait-cap-incidents.test.ts
  - tests/integration/incident-hygiene.test.ts
  - tests/integration/saga-dlq-timeout.test.ts
  - tests/integration/xor-gateway.test.ts
  - tests/contract/api.test.ts
priority: medium
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Split the overloaded incident kind `timeout` (design §5.1, docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md): `jobActivationTimeout` for the un-leasable DLQ site (engine.ts:564) and `waitTimeout` for the un-guarded svc/recv wait caps (engine.ts:442-445, 1232-1237). The compensation-wait cap is NOT a timeout site — it writes compensationFailure + compensationFailed and must stay that way. Add `conditionFailure` for hard FEEL errors (today masked as serviceTaskFailure, engine.ts:918-927 — deferred from TASK-34). Legacy `timeout` value retained in the API enum (documented as legacy), never written by new code. Hygiene (design §5.2): setIncidentResolution gains an incident_id filter (today flips ALL non-operatorResolved rows, instances.ts:748-753); inspection exposes the list of open incidents (replaces the LIMIT 1 latest-only read); operator /cancel with an empty ledger closes ALL open incidents as operatorResolved. Docs lockstep: update the docs/bpmn/09:29-31 M1-exception bullet (kind=timeout → jobActivationTimeout) and add an incident-kind enum sync guard to check:docs. Constitution-neutral (no profile change; passes the Check against 2.1.0).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 DLQ expiry produces kind=jobActivationTimeout; un-guarded service-task and receive-task wait caps produce waitTimeout; a hard FEEL error produces conditionFailure (integration tests).
- [x] #2 Compensation-wait timeout still produces compensationFailure + status compensationFailed (regression test).
- [x] #3 openapi incident-kind enum extended additively with legacy `timeout` retained and documented; contract tests updated.
- [x] #4 setIncidentResolution updates only the targeted incident_id; instance inspection lists all open incidents; empty-ledger /cancel leaves no open incidents (tests).
- [x] #5 docs/bpmn/09 M1-exception bullet updated; check:docs incident-kind sync guard added and green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implementer subagent + two-stage review. Split incident kind `timeout` into jobActivationTimeout (DLQ, forward-task.ts terminateUnleasableJob) and waitTimeout (un-guarded svc wait cap forward-task.ts + recv wait cap engine.ts); add conditionFailure for hard FEEL errors (engine.ts decideGateway ExpressionEvaluationError catch, today serviceTaskFailure). Keep legacy `timeout` in the enum (documented, never written by new code). Compensation-wait cap stays compensationFailure (NOT a timeout site). Hygiene: setIncidentResolution gains incident_id filter; inspection lists all open incidents; empty-ledger /cancel closes all open incidents as operatorResolved. Docs: 09 M1-exception bullet kind=timeout→jobActivationTimeout + new check:docs incident-kind sync guard. openapi enum extended additively. Constitution-neutral (passes Check vs 2.1.0). TDD: failing integration tests first.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done at commits ffd8694 + ad6bc76 (review fixes). Split timeout→jobActivationTimeout (DLQ) / waitTimeout (un-guarded svc+recv caps); conditionFailure for hard FEEL; legacy timeout retained (never written). Compensation-wait cap untouched (compensationFailure). Hygiene: resolveIncident(required id) / resolveAllOpenIncidents(empty-ledger cancel) replacing the optional-id footgun; getOpenIncidentsForInstance + inspection openIncidents array; empty-ledger /cancel closes all. check:docs incident-kind sync guard (IncidentKind union ↔ openapi enum, set-equal, comment-hardened). Incident.kind type-linked to single-source IncidentKind. 244 tests (+8) / typecheck / check:docs green. Two-stage review passed (spec ✅ clean scope; code quality: Ready-with-fixes → fixes applied & verified). NOTE for L3: keep wait-outcome axis ({kind:'timeout'}) separate from incident-kind axis — fired timers need a NEW outcome variant (timerFired), NOT overloading timeout. specs/002 spec.md edits were stale-ref corrections only (M3 feature deltas still owed by L5/TASK-47).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
M3-L1 incident taxonomy split + hygiene. The overloaded incident kind `timeout` now splits into jobActivationTimeout (un-leasable-job DLQ) and waitTimeout (un-guarded service-task + receive-task wait caps); conditionFailure added for hard FEEL evaluation errors (was masked as serviceTaskFailure); legacy `timeout` kept in the enum, documented, never written by new code. The compensation-wait cap deliberately stays compensationFailure (regression-guarded). Hygiene: incident resolution is now id-targeted (resolveIncident) with an explicit resolveAllOpenIncidents only for the empty-ledger cancel; instance inspection exposes an openIncidents array; empty-ledger /cancel closes all open incidents as operatorResolved. A new check:docs guard keeps the IncidentKind union, the openapi enum, and (via type-link) the Incident.kind API type in lockstep. 244/244 tests, typecheck, check:docs green. Two-stage review + a review-fix pass (api.ts type-link, resolution-by-id split) all clean. Constitution-neutral (validator/profile/constitution untouched; passes the Check vs 2.1.0)."
<!-- SECTION:FINAL_SUMMARY:END -->
