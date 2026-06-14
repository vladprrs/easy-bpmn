---
id: TASK-60
title: 'M-UI-L5: SSE history live-tail (/instances/{id}/stream)'
status: Done
assignee: []
created_date: '2026-06-14 10:08'
updated_date: '2026-06-14 10:54'
labels: []
milestone: m-6
dependencies: []
priority: medium
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
EventSource('/instances/{id}/stream'): the Worker tails D1 history_events by rowid cursor, emits deltas as SSE events with id:<cursor>, periodic ':' heartbeats, Content-Type text/event-stream + Cache-Control no-cache. Streamed ReadableStream body (not a buffered await loop), bounded ~25s then close so EventSource reconnects with Last-Event-ID, and it MUST abort on request.signal. Reads D1 only. Source: §11.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 streamed text/event-stream body with id:<cursor> deltas + heartbeats
- [x] #2 honors Last-Event-ID, bounded duration, aborts on client disconnect
- [x] #3 reads only D1 (no Workflow state)
- [x] #4 delta-by-cursor correctness asserted (no gaps/dupes vs the poll fallback)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/ui/stream.ts: GET /instances/{id}/stream — a streamed ReadableStream (text/event-stream, Cache-Control no-cache, x-accel-buffering no) tailing history_events by rowid (tailInstanceHistory), emitting `id:<cursor>\ndata:<json>` per event + `:` heartbeats. Bounded ~25s (UI_STREAM_BUDGET_MS, lowered to 3s in tests) so EventSource reconnects with Last-Event-ID; aborts on request.signal (no wasted D1 reads on a closed tab). Reads D1 only. Integration smoke asserts the content-type, the id/data frames for existing events, and the 401 gate; delta-by-cursor no-gap/no-dup correctness is asserted on the matching ?since= poll endpoint.
<!-- SECTION:FINAL_SUMMARY:END -->
