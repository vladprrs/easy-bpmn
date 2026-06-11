---
id: TASK-39
title: 'M3-L1: Incident taxonomy split + incident hygiene'
status: To Do
assignee: []
created_date: '2026-06-11 17:17'
labels:
  - saga
  - runtime
  - api
milestone: m-3
dependencies:
  - TASK-38
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
priority: medium
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Split the overloaded incident kind `timeout` (design §5.1, docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md): `jobActivationTimeout` for the un-leasable DLQ site (engine.ts:564) and `waitTimeout` for the un-guarded svc/recv wait caps (engine.ts:442-445, 1232-1237). The compensation-wait cap is NOT a timeout site — it writes compensationFailure + compensationFailed and must stay that way. Add `conditionFailure` for hard FEEL errors (today masked as serviceTaskFailure, engine.ts:918-927 — deferred from TASK-34). Legacy `timeout` value retained in the API enum (documented as legacy), never written by new code. Hygiene (design §5.2): setIncidentResolution gains an incident_id filter (today flips ALL non-operatorResolved rows, instances.ts:748-753); inspection exposes the list of open incidents (replaces the LIMIT 1 latest-only read); operator /cancel with an empty ledger closes ALL open incidents as operatorResolved. Docs lockstep: update the docs/bpmn/09:29-31 M1-exception bullet (kind=timeout → jobActivationTimeout) and add an incident-kind enum sync guard to check:docs. Constitution-neutral (no profile change; passes the Check against 2.1.0).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 DLQ expiry produces kind=jobActivationTimeout; un-guarded service-task and receive-task wait caps produce waitTimeout; a hard FEEL error produces conditionFailure (integration tests).
- [ ] #2 Compensation-wait timeout still produces compensationFailure + status compensationFailed (regression test).
- [ ] #3 openapi incident-kind enum extended additively with legacy `timeout` retained and documented; contract tests updated.
- [ ] #4 setIncidentResolution updates only the targeted incident_id; instance inspection lists all open incidents; empty-ledger /cancel leaves no open incidents (tests).
- [ ] #5 docs/bpmn/09 M1-exception bullet updated; check:docs incident-kind sync guard added and green.
<!-- AC:END -->
