# Operator Console (M-UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only operator console for `easy-bpmn` — a React SPA served same-origin by the existing Worker, plus the read/aggregation/auth/SSE endpoints it needs — so a single technical operator can triage, diagnose, audit, view BPMN, and safely cancel/retry sagas.

**Architecture:** One Worker serves both the JSON API (root paths, unchanged contract) and the SPA (static assets via the Cloudflare `assets` binding with `run_worker_first` over the API prefixes and `/console/*` for client routes). New endpoints are read/aggregation over D1 (the inspection invariant), guarded by an HMAC session cookie. BPMN render + ELK auto-layout run in the browser. Live updates via an SSE tail of D1 `history_events`.

**Tech Stack:** TypeScript Cloudflare Workers (manual segment router, zod, D1, Web Crypto HMAC, streamed SSE). SPA: React + Vite + React Router + TanStack Query + Zustand + Tailwind + Radix + lucide + bpmn-js + elkjs. Tests: Vitest + `@cloudflare/vitest-pool-workers`.

Source design: `docs/superpowers/specs/2026-06-14-operator-console-ui-design.md`. Constitution unblocked at **v2.4.0** (M-UI exclusion removed). Backlog: TASK-55…TASK-63 under milestone **m-6**.

---

## Source-of-truth facts (grounded in the current code)

- **Router** is a manual segment dispatch in `src/index.ts` `route(request, env)` (≈ line 1042): `const seg = url.pathname.split("/").filter(Boolean)`. New routes = new `if` blocks. A UI sub-router is wired in by ONE call near the top.
- **Response/error helpers**: `json(data, status)` (index.ts:111), error envelope `{ error, details? }` via `AppError` subclasses in `src/runtime/errors.ts` (`BadRequestError` 400, `UnauthorizedError` 401, `NotFoundError` 404, `ConflictError` 409). Re-use a local `json` in the UI module.
- **Env** (`src/env.ts`): `DB: D1Database` (binding `DB`), DOs, `PROCESS_WORKFLOW`, `OVERLAYS`, `EXECUTION_MODE`. Add `UI_USER`, `UI_PASS`, `UI_SESSION_SECRET`, `UI_DEFAULT_WORKSPACE` (all optional strings).
- **DB helpers** (`src/persistence/db.ts`): `dbAll<T>(db, sql, params)`, `dbFirst<T>(db, sql, params)`. SQLite `rowid` is the history cursor (`history_events` has no explicit seq column; ordering is by rowid).
- **Existing endpoints stay open** (no cookie) so the published contract + worker data-plane + existing tests are untouched. ONLY the new `/ui/*`, `/projects`, `/attention`, `/sagas/*`, `/instances/{id}/jobs`, `/instances/{id}/stream`, `GET /messages` (list), `GET /definitions/versions/{id}/bpmn` require the cookie, and only when `UI_SESSION_SECRET` is configured.
- **Key tables/columns** (verbatim): `workspaces(workspace_id,name)`, `drafts(draft_id,workspace_id,name,latest_published_version_id,...)`, `definition_versions(definition_version_id,draft_id,workspace_id,version_number,bpmn_xml,bpmn_xml_hash,parsed_profile,published_at)`, `process_instances(instance_id,workspace_id,definition_version_id,status,current_element_id,business_key,correlation_key,variables,started_at,updated_at,completed_at)` — **no denormalized `draft_id`** (sagaId filtering joins `definition_versions`), `history_events(history_event_id,workspace_id,instance_id,element_id,type,business_time,technical_time,payload_snapshot,diagnostics)`, `message_subscriptions(... message_name,correlation_key,expires_at,status ...)`, `external_messages(... message_name,correlation_key,final_outcome,matched_instance_id,reason,received_at,workspace_id ...)`, `service_task_jobs(... element_id,status,attempt_count,activation_expires_at,lock_expires_at ...)`, `worker_attempts(attempt_id,job_id,attempt_number,status,request_payload,response_payload,error,started_at,finished_at)`, `saga_steps(... seq,compensation_status,compensation_element_id,compensation_task_type ...)`, `incidents(... kind,reason,element_id,retry_count,resolution ...)`.

## File Structure (created / modified)

**Backend (new):**
- `src/ui/http.ts` — `json()`, `noContent()`, SSE response helpers (UI-local copy to avoid refactoring index.ts).
- `src/ui/session.ts` — HMAC sign/verify of `{exp}` token (Web Crypto), cookie build/parse, `requireSession(request, env)`, `currentSession()`.
- `src/contracts/ui.ts` — zod schemas + response types for all UI endpoints.
- `src/persistence/ui-queries.ts` — aggregation queries: projects rollup, attention list, saga list/detail, instance jobs+attempts, message search, history-since, version XML, instance subscriptions view.
- `src/ui/handlers.ts` — handler functions for `/ui/*`, `/projects`, `/attention`, `/sagas/*`, `/instances/{id}/jobs`, `GET /messages`, `GET /definitions/versions/{id}/bpmn`.
- `src/ui/stream.ts` — SSE `/instances/{id}/stream` handler (streamed `ReadableStream`, rowid tail, heartbeats, `signal` abort, bounded ~25 s).
- `src/ui/router.ts` — `handleUiRoute(request, env, seg, method, url): Promise<Response | null>` (null ⇒ not a UI route).

**Backend (modified):**
- `src/env.ts` — add UI_* vars.
- `src/index.ts` — one import + one dispatch call to `handleUiRoute` at the top of `route()`; extend `handleGetInstance` (subscriptions block), `handleGetInstanceHistory` (`?since`), `handleListInstances` (search/sagaId/multi-status).
- `wrangler.jsonc` — `assets` block + `run_worker_first` (API prefixes) + UI_* dev vars.
- `vitest.config.ts` — miniflare UI_* test bindings.
- `specs/002-saga-orchestrator/contracts/openapi.yaml` + `runtime-contracts.md` — new paths/schemas (lockstep).

**Frontend (new) under `spa/`:** `package.json` (workspace), `vite.config.ts`, `index.html`, `tailwind.config.js`, `postcss.config.js`, `src/main.tsx`, `src/app.tsx` (router), `src/api/client.ts`, `src/api/types.ts`, `src/api/stream.ts`, `src/lib/humanize.ts`, `src/lib/elements.ts`, `src/lib/compensation.ts`, `src/lib/guards.ts`, `src/lib/bpmn-render.ts`, `src/components/*`, `src/screens/{Login,Projects,Sagas,SagaDetail,Instance,Attention,Messages}.tsx`.

---

## Phase 0 — Governance & scaffold (TASK-55) ✅ as work proceeds

- [x] Amend `constitution.md` → v2.4.0 (remove the Operate-style-UI exclusion + Sync Impact Report).
- [x] Backlog milestone m-6 + TASK-55…63.
- [x] This plan doc.
- [ ] `wrangler.jsonc` assets binding + `run_worker_first` + UI_* dev vars; `src/env.ts` UI_* vars; `vitest.config.ts` test bindings.
- [ ] openapi.yaml + runtime-contracts.md amendments (after the endpoints exist, in lockstep); `npm run check:docs` green.

## Phase 1 — Backend endpoints (TASK-56…60)

**Order (TDD per group):** session → ui-queries → handlers → router wire → instance extensions → SSE. Each group: write the integration/contract test, run red, implement, run green, commit.

1. **Session (TASK-56):** `signSession({exp})`/`verifySession()` HMAC-SHA256 over `${exp}` with `UI_SESSION_SECRET`; cookie `ebpmn_session=<b64url(exp)>.<b64url(sig)>`; `Set-Cookie: …; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=…`. `requireSession` → 401 if absent/expired/bad sig (no-op pass-through when `UI_SESSION_SECRET` unset, so the worker boots without secrets in dev). Handlers `POST /ui/login` (timing-safe compare vs `UI_USER`/`UI_PASS`), `POST /ui/logout` (clear cookie), `GET /ui/me`.
2. **Aggregation (TASK-57):** `/projects`, `/attention?projectId=`, `/sagas?projectId=`, `/sagas/{id}`. Attention set = `status IN ('incident','compensationFailed')` OR (`status='compensating'` AND `updated_at < now-STALE_COMPENSATING_MS`), `STALE_COMPENSATING_MS = 5*60*1000`. Saga name from the active version's parsed process name (`parsed_profile.name`/graph), falling back to `drafts.name`.
3. **Instance diagnostics (TASK-58):** `/instances/{id}/jobs` (jobs + attempts); extend `GET /instances/{id}` with `subscriptions[]`; extend `GET /instances/{id}/history?since=` (rowid delta + `nextCursor`); extend `GET /instances` (`search` LIKE, `sagaId` join, comma `status`).
4. **Messages + BPMN (TASK-59):** `GET /messages?…` search; `GET /definitions/versions/{id}/bpmn` → `{bpmnXml, bpmnXmlHash}`.
5. **SSE (TASK-60):** `/instances/{id}/stream` streamed body; emit each new `history_events` row as `id: <rowid>\ndata: <json>\n\n`; `:` heartbeat each tick; `await` short delay between D1 reads; close after ~25 s; abort on `request.signal`; honor `Last-Event-ID`. Reads D1 only.

## Phase 2 — SPA (TASK-61…63)

1. **Scaffold + cross-cutting (TASK-61):** Vite/React/Tailwind; `api/client.ts` (fetch wrapper, 401→login, 409→refresh); `api/stream.ts` (`EventSource` + reconnect + poll fallback); `lib/humanize.ts` (map EVERY emitted `type` — built from `grep "type:"` on the runtime — + deterministic title-case fallback; a coverage unit test asserts every emitted type maps); `lib/elements.ts`; `lib/compensation.ts` (pending steps, `seq desc`); `lib/guards.ts` (cancel∈{running,waiting,incident}; retry∈{incident,compensationFailed}).
2. **Screens (TASK-62):** Login, Projects, Sagas, Saga detail, Instance hub (+ Attention, Messages). Breadcrumb Project ▸ Saga ▸ Instance. Saga/compensation surfaces conditional on a `bpmn:transaction` scope. Minimal timeline export.
3. **BPMN render (TASK-63):** `lib/bpmn-render.ts` — bpmn-js Viewer; if no DI, synthesize via `bpmn-auto-layout`/elkjs; overlay via `canvas.addMarker` + overlays keyed by `element_id`. Lazy-load elk worker off the diagram route. Element-list fallback.

## Phase 3 — Lockstep docs + verification

- openapi.yaml + runtime-contracts.md final pass; `npm run check:docs`, `npm run check:matrix`, `npm run typecheck`, `npm run test` all green; `npx wrangler deploy --dry-run`.

## Test strategy

- **Unit (UI):** humanization coverage, element resolver, compensation preview, guard-rails, session sign/verify.
- **Contract:** every new endpoint shape vs openapi.yaml.
- **Integration (vitest-pool-workers):** `/bpmn`, `/instances?sagaId=`(+multi-status, search), `/sagas`, `/projects`, `/attention`, `/instances/{id}/jobs`, `/messages` search, `/instances/{id}` subscriptions, `/instances/{id}/history?since=`, session-gated 401s.
- **SSE:** delta-by-cursor correctness; reconnect with `Last-Event-ID` resumes without gaps/dupes.
- **Render:** ELK snapshot on `examples/simple-approval.bpmn` (DI) + `examples/order-saga.bpmn` (DI-less).

## Self-review notes

- Spec coverage: every §12 endpoint, §8 auth, §10 render, §11 SSE, §13 cross-cutting modules, §15 error handling map to a task above.
- Invariants preserved: inspection reads D1 only; no Workflow internals exposed; existing contract paths unchanged; immutable versioning intact (saga is an IA collapse, not a data-model change).
- Risk R4 (sagaId join): join `definition_versions.draft_id`; existing `idx_versions_draft` + `idx_instances_version` cover it; no new column needed for v1.
