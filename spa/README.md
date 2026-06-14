# easy-bpmn operator console (M-UI)

A **read-only** operator console for `easy-bpmn` — a React SPA served same-origin by
the Worker (Cloudflare Static Assets). One technical operator can triage stuck/failed
saga instances, audit a humanized timeline, view the BPMN diagram with live execution
state overlaid, and safely `cancel`/`retry`. It is read-only except those two existing
operator controls, and all inspection reads D1 (the constitution inspection invariant).

Design: [`docs/superpowers/specs/2026-06-14-operator-console-ui-design.md`](../docs/superpowers/specs/2026-06-14-operator-console-ui-design.md).
Plan: [`docs/superpowers/plans/2026-06-14-operator-console-ui.md`](../docs/superpowers/plans/2026-06-14-operator-console-ui.md).

## Stack

React + Vite · React Router · TanStack Query (REST cache) + `EventSource` (live) ·
Zustand (app state) · Tailwind · lucide icons · **bpmn-js** Viewer + **bpmn-auto-layout**
(synthesizes BPMN DI when the model carries none — a hard prerequisite, since bpmn-js
draws nothing DI-less).

## Develop

```bash
# from the repo root
npm run dev          # Worker (wrangler dev) on :8787   — terminal 1
npm run dev:ui       # SPA (vite) on :5173, proxying the API to :8787  — terminal 2
```

Open http://localhost:5173. The SPA owns `/` (shell) and `/console/*` (client routes);
all API prefixes (`/ui`, `/projects`, `/sagas`, `/attention`, `/instances`, `/messages`,
`/definitions`, …) are proxied to the Worker in dev and served same-origin in prod.

## Build & ship

```bash
npm run build:ui     # vite build → spa/dist (served by the Worker via the assets binding)
npm run typecheck:ui # tsc --noEmit
npm run test:ui      # vitest: humanization coverage, element resolver, compensation, guards
npx wrangler deploy  # ships the Worker + spa/dist together (build the SPA first)
```

The Worker's `wrangler.jsonc` `assets` block (`directory: ./spa/dist`,
`not_found_handling: single-page-application`, `run_worker_first` over the API prefixes)
serves the built SPA. **Build the SPA before deploying** so `spa/dist` is current.

## Auth

The Worker enforces a session cookie on the console endpoints when `UI_USER` /
`UI_PASS` / `UI_SESSION_SECRET` are set (`wrangler secret put …`). Unset ⇒ the console
runs open (single-operator local dev). `UI_DEFAULT_WORKSPACE` selects the boot workspace.

## Layout

- `src/api/*` — typed client, wire types, SSE/poll live-tail.
- `src/lib/*` — humanization (the one place that knows engine jargon, + a deterministic
  fallback), element resolver, compensation preview, status guard-rails, formatters.
- `src/components/*` — primitives, layout/breadcrumb, timeline, JSON view, **BpmnViewer**
  (lazy-loaded; live overlay keyed by `element_id`).
- `src/screens/*` — Login · Projects · Sagas · SagaDetail · Instance (the hub) ·
  Attention · Messages.
