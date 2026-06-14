# easy-bpmn operator console (M-UI)

A **read-only** operator console for `easy-bpmn` — a React SPA served same-origin by the
Worker (Cloudflare Static Assets). It is **one immersive screen, the "Process Stage"**:
it opens directly onto a process's *living* BPMN diagram — saga runs rendered as flowing
current (tokens travel, the path settles green, a stall interrupts coral) — and switching
process, dropping into a run, and finding a transaction are **controls (incl. a ⌘K command
palette), not screens**. The only writes are the existing operator `cancel`/`retry`; all
inspection reads D1 (the constitution inspection invariant).

Visual & UX brief: [`docs/superpowers/specs/2026-06-14-operator-console-visual-design-brief.md`](../docs/superpowers/specs/2026-06-14-operator-console-visual-design-brief.md)
("Living Systems" — flow-as-hero, light, health-is-hero).
Architecture/IA/contracts: [`docs/superpowers/specs/2026-06-14-operator-console-ui-design.md`](../docs/superpowers/specs/2026-06-14-operator-console-ui-design.md)
(its endpoints stand; the brief's §4 flattens its nav into the single stage).

## Stack

React + Vite · React Router · TanStack Query (REST cache) + `EventSource` (live) ·
Zustand (app state) · Tailwind · lucide icons · **bpmn-js** NavigatedViewer +
**bpmn-auto-layout** (synthesizes BPMN DI when the model carries none — a hard
prerequisite, since bpmn-js draws nothing DI-less).

**Typography — a self-hosted trio** (`src/styles/fonts.css`, woff2 under `public/fonts/`):
**Clash Display** (display — headlines, big numbers, the health line) · **General Sans**
(UI/body) · **Commit Mono** (the data layer — ids, keys, timestamps, JSON). All free/OFL,
`font-display: swap`, ~248 KB total.

## Develop

```bash
# from the repo root
npm run dev          # Worker (wrangler dev) on :8787   — terminal 1
npm run dev:ui       # SPA (vite) on :5173, proxying the API to :8787  — terminal 2
```

Open http://localhost:5173. The SPA owns `/` (shell) and `/console/*` (client routes);
all API prefixes (`/ui`, `/projects`, `/sagas`, `/attention`, `/instances`, `/messages`,
`/definitions`, …) are proxied to the Worker in dev and served same-origin in prod.

Routes (all render the one Stage): `/console` (auto-selects the most-relevant run — alive
on load) · `/console/p/:sagaId` (aggregate "living heatmap") ·
`/console/p/:sagaId/i/:instanceId` (single-instance living flow — the permalink) ·
`/console/i/:instanceId` (deep-link; resolves its saga then canonicalises).

## Build & ship

```bash
npm run build:ui     # vite build → spa/dist (served by the Worker via the assets binding)
npm run typecheck:ui # tsc --noEmit
npm run test:ui      # vitest: humanization coverage, flow derivation, element resolver, compensation, guards
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

- `src/api/*` — typed client (incl. `GET /sagas/{id}/heatmap`), wire types, SSE/poll live-tail.
- `src/lib/*` — `humanize` (engine jargon → tone + a narrative voice, with a deterministic
  fallback), `flow` (the pure living-flow derivation: overlay + flow plan + heat plan;
  unit-tested), element resolver, compensation preview, status guard-rails, formatters.
- `src/components/*` — UI primitives, JSON view, status badge, toasts, and **`LivingDiagram`**
  (lazy-loaded; the hero — category tints + runtime markers + the living-flow layer:
  illuminated path, SMIL travelling tokens, settle, reverse-preview; degrades to an
  element list; reduced-motion renders the static illuminated path).
- `src/stage/*` — the Process Stage: `Stage` (orchestrator) · `ChromeBar` · `ProcessSwitcher`
  · `StatsRail` · `InstanceSwitcher` · `AttentionPopover` · `CommandPalette` (⌘K) ·
  `NarrationRibbon` (the spoken timeline + scrubber) · `Drawer` (depth) · `StageHeader` ·
  `IncidentCallout` · `ConfirmCancel` · `primitives` (anchored Popover) · `model`.
- `src/screens/Login.tsx` — the only non-stage screen.
