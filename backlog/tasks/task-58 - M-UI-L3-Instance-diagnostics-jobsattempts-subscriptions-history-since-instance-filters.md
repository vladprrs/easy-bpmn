---
id: TASK-58
title: >-
  M-UI-L3: Instance diagnostics (jobs+attempts, subscriptions, history ?since,
  instance filters)
status: Done
assignee: []
created_date: '2026-06-14 10:08'
updated_date: '2026-06-14 10:54'
labels: []
milestone: m-6
dependencies: []
priority: high
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GET /instances/{id}/jobs (service_task_jobs + worker_attempts per instance). EXTEND GET /instances/{id} with active message_subscriptions (waiting-on). EXTEND GET /instances/{id}/history with ?since=cursor (rowid delta + nextCursor, the SSE poll fallback). EXTEND GET /instances with search (LIKE business_key/correlation_key), sagaId (join definition_versions.draft_id), and comma-list multi-status. Source: §9,§12.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /instances/{id}/jobs returns jobs with attempts[] (request/response/error/at) + lease/DLQ fields
- [x] #2 GET /instances/{id} gains a subscriptions[] block (message name, correlation key, expires_at, buffered count)
- [x] #3 GET /instances/{id}/history?since=cursor returns only newer events + nextCursor with no gaps/dupes
- [x] #4 GET /instances supports search, sagaId, and multi-status; integration tests cover all
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
GET /instances/{id}/jobs (service_task_jobs + per-job worker_attempts, lease/DLQ fields). EXTENDED GET /instances/{id} with a `subscriptions[]` block (listInstanceSubscriptions: message name, correlation key, expires_at, buffered count). EXTENDED GET /instances/{id}/history with ?since=cursor (tailInstanceHistory by rowid → {events, nextCursor}; additive). EXTENDED GET /instances with search (LIKE business/correlation key), sagaId (join definition_versions.draft_id), comma-list multi-status (listInstancesFiltered). ALSO wired worker_attempts population on the pull plane (createAttempt on lease, finishLatestStartedAttempt on complete/fail — idempotent) since the table was previously never written; this makes the Attempts drill-down real. Integration tests cover all; full backend suite 469 GREEN.
<!-- SECTION:FINAL_SUMMARY:END -->
