---
id: TASK-57
title: >-
  M-UI-L2: Project/saga aggregation endpoints (/projects, /attention, /sagas,
  /sagas/{id})
status: Done
assignee: []
created_date: '2026-06-14 10:08'
updated_date: '2026-06-14 10:54'
labels: []
milestone: m-6
dependencies: []
priority: high
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Read/aggregation over existing tables. GET /projects (per-workspace rollups: sagaCount, counts by status, attention). GET /attention?projectId= (flat cross-saga on-call list: {incident, compensationFailed} + stale compensating via a defined staleness predicate). GET /sagas?projectId= (draft lineage; name from active version's process name; counts by status; lastActivityAt). GET /sagas/{id} (draft + its versions). All read D1 only. Source: §6,§9,§12.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /projects returns per-workspace rollups incl. an attention count
- [x] #2 GET /attention expresses the multi-status set incl. stale compensating (staleness predicate, NOT all compensating)
- [x] #3 GET /sagas + /sagas/{id} compose draft lineage + versions; saga name from the active version, not the mutable draft name
- [x] #4 integration tests against seeded D1 for each endpoint
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/persistence/ui-queries.ts + src/ui/handlers.ts: GET /projects (per-workspace rollups: sagaCount, status counts, attention), GET /attention?projectId= (flat list with the multi-status set {incident, compensationFailed} + stale compensating via STALE_COMPENSATING_MS=5min predicate — NOT all compensating), GET /sagas?projectId= (draft lineage; name from the active version's immutable processId, not the mutable drafts.name; counts; lastActivityAt; hasTransaction), GET /sagas/{id} (draft + versions with instance counts). All read D1 only. Integration tests assert the attention staleness predicate (fresh compensating excluded), hasTransaction true/false, and saga/version composition.
<!-- SECTION:FINAL_SUMMARY:END -->
