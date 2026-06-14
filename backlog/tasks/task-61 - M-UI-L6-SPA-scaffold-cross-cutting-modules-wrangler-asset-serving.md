---
id: TASK-61
title: 'M-UI-L6: SPA scaffold + cross-cutting modules + wrangler asset serving'
status: Done
assignee: []
created_date: '2026-06-14 10:08'
updated_date: '2026-06-14 10:55'
labels: []
milestone: m-6
dependencies: []
priority: high
ordinal: 38000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Vite + React SPA (React Router, TanStack Query, Zustand, Tailwind + Radix + lucide). API client + SSE client. Cross-cutting modules: event humanization (table over ALL emitted history types + deterministic fallback + a coverage test), element resolver (id→{name,type,taskType}), compensation-preview derivation from the saga ledger, status guard-rails. Build to dist/spa; the Worker serves it via the assets binding with not_found_handling: single-page-application + run_worker_first over API prefixes; /console/* client-route namespace. Source: §7,§9,§13.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Vite React SPA builds to dist/spa; Worker serves it same-origin; API prefixes still reach the Worker
- [x] #2 humanization maps every emitted history type (coverage test) with a deterministic fallback
- [x] #3 element resolver + compensation-preview + guard-rails are pure + unit-tested
- [x] #4 API client + SSE client with optimistic cancel/retry + stream reconcile
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
spa/ Vite + React 18 SPA (React Router 6, TanStack Query 5, Zustand 5, Tailwind 3, lucide). API client (src/api/client.ts: 401→AuthError/redirect, 409→ConflictError/toast) + SSE/poll live-tail (src/api/stream.ts: EventSource with Last-Event-ID reconnect, hard-failure poll fallback). Cross-cutting (src/lib): humanize (table over ALL 42 runtime-emitted history types + deterministic title-case fallback — a coverage test asserts every emitted type maps), element resolver, compensation preview (pending steps, seq desc), status guard-rails. Builds to spa/dist (BpmnViewer code-split, 62KB gzip lazy chunk). `npm run typecheck:ui` clean; `npm run test:ui` 11 GREEN; `npm run build:ui` OK; wrangler dry-run serves spa/dist.
<!-- SECTION:FINAL_SUMMARY:END -->
