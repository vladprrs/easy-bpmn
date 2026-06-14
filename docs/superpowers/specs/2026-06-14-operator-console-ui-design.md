# Operator Console UI — Design

- **Date:** 2026-06-14
- **Status:** Draft design. **Blocked on a constitution amendment** before implementation (see §17).
- **Proposed milestone:** **M-UI / Operator Console** — a milestone of its own, *separate* from M5 (composition).
- **Persona:** a single technical operator (platform engineer / developer).
- **Source-of-truth note:** This is a bridge design doc under `docs/superpowers/specs/`. It distills, and does not replace, the specs under `specs/002-saga-orchestrator/` and the constitution. Where this doc proposes API/runtime changes, the authoritative contract is `specs/002-saga-orchestrator/contracts/openapi.yaml`, which must be amended in lockstep.

---

## 1. Summary

A **read-only operator console** for `easy-bpmn`, served entirely from Cloudflare (no external servers). One Worker serves both a React SPA (static assets) and the existing JSON API, same-origin. The console lets a single technical operator do three jobs in one place:

1. **Manage sagas** — find stuck/failed instances and safely steer them to a correct terminal state (`cancel` → compensation, `retry`).
2. **Audit** — read an immutable, humanized timeline of every state transition for any instance, with cross-service `traceId`.
3. **View BPMN** — render any process definition as a diagram (no editing), with live execution state overlaid on the diagram.

The console is strictly read-only except for the two existing operator controls (`cancel`, `retry`). It never exposes Cloudflare Workflow internals and reads only D1 for inspection (constitution invariant).

---

## 2. Persona & scope

**Single technical operator.** Platform engineer / developer who both runs the platform and debugs it. No RBAC, no separate non-technical auditor, no "simplified mode." One set of screens, one credential.

**In scope:** triage, inspection, audit timeline, BPMN viewing with live overlay, compensation preview, `cancel`/`retry`, live updates.

**Out of scope (YAGNI):** BPMN editing/modeling, starting instances from the UI, APM/metrics dashboards, multi-tenant RBAC, mobile-first layout. See §19.

---

## 3. Jobs To Be Done

### Main job
> When a distributed saga across my microservices misbehaves, I want to understand exactly what happened and safely steer it to a correct terminal state — without SSH-ing into databases or stitching together logs from five services.

The product's hire: **make invisible distributed state visible and controllable.**

### Functional sub-jobs (job stories)
1. **Triage** — When I suspect something is wrong, I want to see at a glance which instances are stuck/failed, so I can decide where to spend attention.
2. **Diagnose** — When an instance is in an incident, I want to know *which step* failed, *why* (error + element + `kind`), and *what the data looked like*, so I can choose retry vs cancel.
3. **Understand the model** — When I look at a failing instance, I want to see the BPMN diagram with the failure highlighted, so I can reason about the flow and compensation paths.
4. **Act / remediate** — When I have a diagnosis, I want to cancel (trigger compensation) or retry the step safely and watch it resolve.
5. **Verify compensation** — When a saga rolls back, I want to see the reverse pass step-by-step, so I trust the system undid the right things.
6. **Audit / prove** — When someone asks "what happened to transaction X" (or for compliance), I want an immutable, readable timeline of every transition.

### Emotional jobs
- **Trust the button** — I must believe `cancel` does the right thing and won't make it worse. Compensation must be *legible before* the action.
- **Control under pressure** — on-call: feel in command, not helpless.
- **Reduce the anxiety of the unknown** — distributed sagas are opaque by nature.

### Social jobs
- Be the person who instantly answers "status of order X?" in a channel.
- Hand off / show evidence to a teammate or auditor (link, export).

---

## 4. Customer Journey Map

Spine: "from signal to resolution" (the main saga-management scenario), with audit and BPMN viewing woven in.

| Stage | Trigger / goal | Actions & touchpoints (data) | Emotion | Pain (gap) | Opportunity |
|---|---|---|---|---|---|
| **0. Entry** | Alert (Slack/PagerDuty/log) OR proactive browse OR "what's with order X?" | Open console; deep-link to an instance | 😟 / 🙂 | No deep-link from alert; auth model undefined (**G8**) | Permalink to instance/event; land directly on target |
| **1. Triage** | Find problem instances fast | List filtered by `status`, newest-first, cursor paging (`GET /instances`) | 😬 urgency | Filter is `status`-only; no search by `businessKey`/`correlationKey` (**G2**) | Search by business key; status chips; "N in incident" counters |
| **2. Diagnose** | Understand what/why broke | Instance card: `status`, `currentElementId`, `incident{kind,reason,elementId,retryCount,payloadContext}`, `openIncidents`, `variables`, `saga.phase` (`GET /instances/{id}`) | 🤔 | `variables` raw JSON; `reason` a string; `element_id` ≠ human name (**G6**) | Variable tree/diffs; humanized "what/where/why/next" incident card |
| **3. BPMN view** | See the failure *on the diagram* | Diagram with failing element, traversed path, token frontier, compensation handlers, gateway decisions (BPMN XML + history↔`element_id` + `tokens`/`gateway_decisions`) | 💡 | **BPMN XML not exposed** by API (**G1**); DI often absent → auto-layout needed | `/bpmn` endpoint; bpmn-js + ELK; live overlay |
| **4. Timeline (audit)** | Reconstruct chronology | Event feed: type, element, time, `payloadSnapshot`, `diagnostics`, `traceId` (`GET /instances/{id}/history`) | 🧩 | ~40 event types are internal jargon; feed is long (**G3**) | Humanization layer; grouping/filter; `traceId` → external logs |
| **5. Decide & act** | Choose retry / cancel and apply | Retry (+ optional `variables` patch) or cancel (start compensation); confirm (`POST .../retry`, `POST .../cancel`) | 😰 "won't I make it worse?" | No dry-run preview of what cancel compensates (**G5**) | Reverse-pass preview from `saga` ledger before action; status guard-rails |
| **6. Watch / verify** | Confirm correct resolution | Live: `saga` reverse pass, history tail, final `status` (re-`GET`) | 😌 relief / 😨 `compensationFailed` alarm | No live push (poll only); `compensationFailed` = stuck, needs explicit next action (**G4**) | SSE/poll; explicit "stuck → resume" from `compensationFailed` |
| **7. Close / hand-off** | Document, hand off, answer | Copy `traceId`/link; export timeline | ✅ closure | No permalink/export (**G7**) | Shareable permalink; history export (JSON/markdown) |

**Moments of truth:** MoT-1 triage (find it in seconds) · MoT-2 incident reason (what/where/why/next) · MoT-3 the cancel/retry button (trust the consequence) · MoT-4 watching compensation (see it undo correctly).

---

## 5. Locked decisions

| Decision | Choice |
|---|---|
| Persona | Single technical operator |
| Liveness | **Live** (SSE; poll fallback) |
| BPMN layout | **Auto-layout**, made excellent |
| Write surface | **Read-only** + existing `cancel`/`retry` (no instance start from UI) |
| Where UI lives | **Standalone React SPA** served by the Worker (same-origin) |
| BPMN renderer | **bpmn-js Viewer + elkjs** (synthesize DI when absent) |
| Framework | **React** (Vite) |
| Hosting | **All on Cloudflare** — no external servers |
| Auth | **Simplest:** `login/pass` from env → signed HttpOnly cookie |
| Project (L1) | **= `workspace_id`** (no new table) |
| Saga (L2) | **= business process** ("Order", "Receiving") = `drafts` lineage, version-collapsed |
| Instance (L3) | **= `process_instances`** |

---

## 6. Information Architecture

Three-level navigation spine matching the operator's mental model: *"in **project** Acme, the **saga** Order Fulfillment, this **instance** is stuck."*

```
Project  (= workspace_id)
  └─ Saga  (= business process, e.g. "Order", "Receiving"; version-collapsed)
       ├─ BPMN diagram of the active version        (calm "view BPMN" job)
       ├─ Instances — triage, scoped to this saga   (status chips, search, live counts)
       └─ Versions — secondary tab                  (immutable versions; which instance ran which)
            └─ Instance  (hub: diagram + panels)
```

Breadcrumb on every screen: **Project ▸ Saga ▸ Instance**.

**Key IA principle — "saga without versioning" is an IA decision, not a data-model change.** Immutable versioning is preserved (constitution invariant intact): every instance still shows its bound version. Versions are demoted to a secondary tab inside a saga; the primary axis is the logical business process.

**Cross-saga attention triage at the Project level.** The on-call entry point: a project-wide view (via `GET /attention`, §12) of every instance that needs attention — `incident`, `compensationFailed`, and *stale* `compensating` (a defined staleness predicate, **not** every `compensating` instance — that status is healthy and non-terminal) — across all sagas, so MoT-1 ("find it in seconds") survives the hierarchy.

### Data mapping

| Nav layer | Product name | Existing entity | Backend addition |
|---|---|---|---|
| L1 | Project | `workspace_id` | project list + rollup counters (source of project names) |
| L2 | Saga | `drafts` (`draft_id`, `name`, `latest_published_version_id`) | `GET /sagas?projectId=` + instance rollups |
| (hidden) | Version | `definition_versions` | already exists; demoted in nav |
| L3 | Instance | `process_instances` | `GET /instances?sagaId=<draftId>` (join via versions) |

No new heavy entities. Project = workspace needs only a name source (env default `UI_DEFAULT_WORKSPACE`, or a tiny registry); all other layers are list/aggregation over existing tables.

**Saga display name & identity.** A saga's `sagaId` is the stable `draft_id`, but its display name comes from the **active published version's parsed process name** (immutable, snapshotted at publish), *not* the mutable `drafts.name` working-copy field — otherwise an old instance's saga could surface under a name it never ran. If two drafts share a name, disambiguate by `sagaId`/version in the L2 list. Drafts cannot be deleted today, so orphaned-version sagas can't occur yet; if a draft-delete is ever added, group by `draft_id` with a "deleted draft" placeholder.

---

## 7. Architecture (Cloudflare-only)

One Worker serves **both** the SPA and the JSON API, same-origin → no CORS, no second server. The existing JSON API stays at its current root paths (its published contract is unchanged); the SPA owns the root shell plus a dedicated `/console/*` client-route namespace.

```
Browser (React SPA)
  │  HTTPS, same-origin (bpmn.rntme.com)
  ▼
Cloudflare Worker (src/index.ts) — Static Assets binding + fetch handler
  ├─ Static Assets → built Vite bundle; not_found_handling: single-page-application
  │     serves  /  and  /console/*   (human-facing SPA shell + client routes)
  └─ run_worker_first → these prefixes ALWAYS reach the Worker (any request mode):
        ├─ /ui/*                          NEW: auth (login/logout/me, signed cookie)
        ├─ /projects, /attention          NEW: project rollups + cross-saga on-call list
        ├─ /sagas, /sagas/{id}            NEW: saga (process) list + detail
        ├─ /instances?…                   existing list + NEW status(multi)/search/sagaId
        ├─ /instances/{id}                existing inspection + NEW subscriptions
        ├─ /instances/{id}/history        existing + NEW ?since= cursor
        ├─ /instances/{id}/jobs           NEW: jobs + worker_attempts
        ├─ /instances/{id}/stream         NEW: SSE live-tail of D1 history
        ├─ /instances/{id}/cancel|retry   existing operator controls
        ├─ /messages, /messages/{id}      existing + NEW list/search
        └─ /definitions/versions/{id}[/bpmn]  existing + NEW raw BPMN XML (G1)
              ▼
             D1  (sole inspection source — constitution invariant)
```

ELK layout and bpmn-js run **in the browser** (elkjs in a web worker) → nothing is rendered server-side; "no external servers" is satisfied literally.

**Asset/route precedence (corrected).** Cloudflare Static Assets are **assets-first**: with `main` set plus an `assets` binding, a request is served from assets when it matches and only otherwise reaches the Worker. With `not_found_handling: single-page-application` (and the default `assets_navigation_prefers_asset_serving` behavior for this project's compat date 2026-06-01), an unmatched path is split by request type — *navigation* requests (`Sec-Fetch-Mode: navigate`) get `index.html`, while *non-navigation* requests (fetch/XHR/EventSource) fall through to the Worker. Relying on that heuristic alone is fragile and would make a **browser navigation to an API URL** (e.g. pasting `/instances/{id}` in a tab) return `index.html` instead of the JSON the contract promises. So routing is pinned explicitly:

- **`assets.run_worker_first`** enumerates every API prefix (`/ui/*`, `/projects/*`, `/attention/*`, `/sagas/*`, `/instances/*`, `/messages/*`, `/definitions/*`, `/jobs/*`, `/workers/*`) → those always invoke the Worker regardless of request mode, so the existing root API contract is preserved exactly.
- The SPA owns `/` (shell/login) and **`/console/*`** for all client routes (e.g. the instance-hub permalink is `/console/instances/{id}`, *not* the API path `/instances/{id}`). Human-facing routes and the JSON API stay in disjoint namespaces, so the Sec-Fetch heuristic is never load-bearing.

This is net-new `wrangler.jsonc` config — there is no `assets` block today.

---

## 8. Authentication (simplest)

- Credentials: `UI_USER` / `UI_PASS` in env (Worker secrets). One operator.
- `POST /ui/login` checks against env, sets an **HttpOnly + Secure + SameSite=Lax** cookie holding an HMAC-signed token (`{exp}` signed with `UI_SESSION_SECRET` via Web Crypto `subtle`). ~30 lines, no DB, no external IdP.
- **Why Lax, not Strict:** a deep-link from Slack/PagerDuty (the §4 stage-0 / G8 goal) is a cross-site *top-level navigation*; `Strict` would withhold the cookie on that first hop, `Lax` sends it. Lax still withholds the cookie on cross-site **POST**/subresource requests, so the state-changing operations (`cancel`/`retry`, issued as same-origin XHR by the SPA) keep their CSRF protection.
- **The SPA shell (assets) stays unauthenticated.** `index.html` and static assets are public; auth is enforced only on the API / `/stream` endpoints. The booting SPA calls `GET /ui/me` (same-origin XHR → cookie sent) and redirects to login if unauthenticated. This is what lets external deep-links land on the shell at all; the shell must **not** be gated behind the cookie (no auth middleware over assets).
- Operator endpoints and `/stream` require a valid cookie → else `401`. `EventSource` cannot set custom headers, so the cookie is the correct (and only) auth channel for SSE; same-origin ⇒ it is sent automatically.
- `GET /ui/me` returns session validity + `workspaceId` for SPA boot; `POST /ui/logout` clears the cookie.
- `workspaceId`: env default `UI_DEFAULT_WORKSPACE`; a simple selector if more than one workspace exists.
- **Note:** deliberately minimal — single-credential, not per-user. Acceptable for the pre-stable, single-operator stage; revisit if multi-user is ever needed.

---

## 9. Screens & components

**Stack:** React + Vite, React Router, TanStack Query (REST cache) + `EventSource` (live), Zustand for app state. BPMN render: `bpmn-js` (Viewer) + `elkjs`. Default UI kit: **Tailwind + Radix primitives + lucide icons** (dense, legible operator console, dark-friendly) — a default, easily swapped.

1. **Login** — single login/pass field.
2. **Projects** (top landing) — cards per project with rollup health: # sagas, # running, **# needing attention** (`incident` + `compensationFailed` + *stale* `compensating`; see §12 for the staleness predicate). With Project = workspace and one workspace, this is a thin layer (auto-select).
3. **Project → Sagas** — cards per saga: name, instance counts by status, last activity, mini health bar, attention badge. Click → saga detail.
4. **Saga detail** (version-agnostic) — header (saga name, active version demoted: "v7 — view versions"); **BPMN diagram of the active version** (static viewer — the calm "view BPMN" job); **instances triage table scoped to this saga** (status chips, search, live counts). Secondary **Versions** tab: immutable versions, which instances ran on which.
5. **Instance detail (the hub)** — "diagram + panels" frame:
   - **Header:** `status` badge, ids (instanceId, businessKey, correlationKey), link to definition version, started/updated/completed; **actions** Cancel / Retry / Copy permalink (status guard-rails).
   - **Spine — BPMN diagram** with live overlay (§10).
   - **Panel tabs:** *Timeline* (humanized history, live-appended) · *Variables* (JSON tree + diff across `source` snapshots) · *Waiting on* (active `message_subscriptions`: message name, correlation key, `expires_at`, buffered-message count — present when the instance is `waiting` on a Receive Task / message catch, the most common stuck case) · *Saga* (ledger + reverse-pass preview + live progress — **shown only when the process has a `bpmn:transaction` scope**; see below) · *Incidents* (kind/reason/element/retryCount/payloadContext/resolution + Retry, with an **Attempts** drill-down: per-`worker_attempts` request/response/error and the job's DLQ `activation_expires_at`/lease state) · *Timers & Tokens* (M3/M4 state).
   - **Bidirectional element↔event linking:** clicking a diagram element filters Timeline/Variables to it; clicking an event highlights the element.

**Cross-saga attention view** (Project level): a flat triage table of everything on fire across the project's sagas — the on-call fast path. Backed by `GET /attention` (§12), not a single-status `GET /instances?status=`.

**Not every process is a transaction-saga.** "Saga" is the product label for the business process (the operator's term — "Order", "Receiving"). Linear (M0) and conditional (M2) processes carry no `bpmn:transaction` scope and thus no `saga_steps` ledger: for them the *Saga* tab and the compensation preview (G5) are hidden and replaced by a quiet "no compensation scope in this process" note. The label stays "Saga" at the nav level regardless; only the compensation surfaces are conditional.

**Messages screen** (project-scoped): a list/search over `external_messages` (by message name / correlation key / outcome). This is the only home for a message that **failed to correlate** (`final_outcome ∈ {late, expired, rejected, duplicate}`, `matched_instance_id = NULL`) — such a message belongs to no instance timeline and answers the "why didn't my order message land?" / "status of order X" jobs. Un-correlated late/rejected messages also surface in the project attention view.

---

## 10. BPMN rendering & live overlay (bpmn-js + ELK)

- SPA fetches XML (`/definitions/versions/{id}/bpmn`). If the XML carries DI, render the author layout as-is. If DI is absent (common), run the `bpmn-moddle` tree through **ELK (layered, left-to-right)**, **synthesize `bpmndi` coordinates**, and re-import into bpmn-js. **DI synthesis is a hard prerequisite, not optional polish:** the bpmn-js Viewer draws nothing for a DI-less definition (`importXML` resolves but renders no shapes), and `canvas.addMarker`/overlays require rendered shapes — so without synthesized DI there is no diagram to overlay live state onto. Evaluate **`bpmn-auto-layout`** (the bpmn.io library that does exactly ELK→`bpmndi` synthesis) before hand-rolling.
- **Auto-layout quality** is a first-class concern (its own design-doc section at plan time): LR orientation, correct placement of **boundary events** on their host, dashed **compensation `association`** to handlers, gateway branch routing, SESE region grouping (M4). The `elkjs` worker build (`elk-worker.min.js`, ~1 MB) is instantiated via Vite's `new Worker(new URL(...))` and lazy-loaded off the diagram route (see R5) to keep the UI responsive and the initial bundle small.
- **Live state overlay** via `canvas.addMarker` + bpmn-js overlays, keyed by `element_id` (which matches history `element_id` 1:1): traversed path, current token frontier (M4 — possibly several), failed element (red + reason), gateway decision badges (chosen branch from `gateway_decisions`), armed/fired timers, compensation handlers and their status.
- **Degradation:** if `/bpmn` or ELK fails, fall back to the element list from `GET /definitions/versions/{id}` so the rest of the UI still works.

---

## 11. Live updates (SSE)

- `EventSource('/instances/{id}/stream')`. The Worker tails **D1** `history_events` by cursor (rowid), emitting deltas as SSE events with `id: <cursor>`. The response is a **streamed body** (a `ReadableStream` / `IdentityTransformStream` written incrementally) — a plain await-sleep loop that builds the body before returning would buffer, not stream. Between reads the loop `await`s a short delay (consumes ~0 CPU) and emits periodic `:` comment heartbeats; `Cache-Control: no-cache` + `Content-Type: text/event-stream` are set so the edge does not buffer.
- The connection is **closed after a bounded interval** (~25 s) so `EventSource` auto-reconnects with `Last-Event-ID`. *Rationale (corrected):* this is for **resilience to idle-connection resets / isolate eviction**, not a specific "connection-duration limit" (Cloudflare supports indefinite streaming keep-alives). The CPU-time budget is not a concern because the loop sleeps; the per-invocation subrequest cap was removed (CF, Feb 2026) and the simultaneous-connection limit relaxed (Apr 2026), so neither caps the D1-read loop. A Durable Object alarm is **not** needed for a 25 s tail.
- The loop **must abort on client disconnect** (`request.signal`'s abort event) — otherwise every closed tab keeps querying D1 for up to ~25 s (wasted reads + duration billing).
- Deltas merge into the cached instance state → live re-render of timeline, header status, diagram overlay, and saga progress.
- A "live / reconnecting…" indicator; on loss, manual refresh. **Fallback:** short-poll `GET /instances/{id}/history?since=cursor` with the same delta contract.
- The SSE handler reads only D1 (never Workflow state) — consistent with the inspection invariant.

---

## 12. Backend additions

All new endpoints are read/aggregation (or auth), authenticated by the session cookie, and read D1 only. Each ships with contract tests against `openapi.yaml` (amended in lockstep) and integration tests where it touches the engine path.

| Method · Path | Returns | Notes |
|---|---|---|
| `POST /ui/login` | `{ ok }` + Set-Cookie | Check env creds → signed cookie |
| `POST /ui/logout` | `{ ok }` | Clear cookie |
| `GET /ui/me` | `{ authenticated, workspaceId? }` | SPA boot |
| `GET /projects` | `[{ projectId, name, sagaCount, counts{running,waiting,incident,compensationFailed,…}, attention }]` | Project = workspace; rollup over instances |
| `GET /attention?projectId=` | flat `[{ instanceId, sagaId, status, currentElementId, since, … }]` | NEW: cross-saga on-call list. Expresses the **multi-status** set `{incident, compensationFailed, +stale compensating}` that single-value `GET /instances?status=` cannot — see note below |
| `GET /sagas?projectId=` | `[{ sagaId, name, activeVersionId, versionCount, counts{…by status}, lastActivityAt }]` | Saga = draft lineage; `sagaId` = `draft_id`; name from active version's process name |
| `GET /sagas/{id}` | `{ sagaId, name, activeVersionId, versions:[…] }` | Composes draft + its versions |
| `GET /instances?status=&search=&sagaId=&cursor=&limit=` | existing list shape | NEW filters: `search` (LIKE on `business_key`/`correlation_key`), `sagaId` (join `definition_versions.draft_id`); `status` accepts a comma list for multi-status triage |
| `GET /instances/{id}` | existing inspection **+ `subscriptions`** | EXTEND: add active `message_subscriptions` (message name, correlation key, `expires_at`, buffered count) so a `waiting` instance shows *what* it waits for |
| `GET /instances/{id}/jobs` | `[{ jobId, elementId, status, attemptCount, activationExpiresAt, lockExpiresAt, attempts:[{n, request, response, error, at}] }]` | NEW: jobs + `worker_attempts` per instance — the "what did the worker receive/return" diagnostic |
| `GET /messages?workspaceId=&messageName=&correlationKey=&outcome=` | `[{ externalMessageId, messageName, correlationKey, finalOutcome, matchedInstanceId, reason, receivedAt }]` | NEW: list/search over `external_messages`; the only home for **un-correlated** (no-instance) messages |
| `GET /definitions/versions/{id}/bpmn` | `{ bpmnXml, bpmnXmlHash }` | XML already stored in D1; resolves **G1** |
| `GET /instances/{id}/stream` | `text/event-stream` | SSE delta-tail of `history_events`; resolves **G4** |
| `GET /instances/{id}/history?since=cursor` | `{ events:[…], nextCursor }` | Poll fallback for SSE; `since` is a NEW param on the existing endpoint |

Existing, unchanged: `POST /instances/{id}/cancel`, `POST /instances/{id}/retry`, `GET /definitions/versions/{id}`, `GET /messages/{id}`.

**On "stuck compensating".** `compensating` is a *healthy, non-terminal* status (verified in the engine's terminal-status set) — not a failure. So the attention set is `{incident, compensationFailed}` plus, optionally, a `compensating` instance whose `updated_at` is older than a threshold **or** whose compensation job lease has expired (a defined staleness predicate), **not** all `compensating` instances. A genuinely wedged compensation surfaces as `compensationFailed` on its own.

---

## 13. Cross-cutting modules (UI layer)

- **Event humanization (G3):** a table mapping **all emitted history `type` values (~52, not ~40 — the M4 concurrency events `branchForked`/`branchArrivedAtJoin`/`joinCompleted`/`regionActivated`/`ebgDecision` and the element-category types are easy to miss)** → `{ icon, severity, human template }`, interpolating the element name + `diagnostics`. Built from the actual emitted set (grep `type:`), with a **deterministic fallback** for any unmapped/future type (title-cased text + neutral icon) so a new engine event never regresses to raw jargon. Pure and unit-tested, including a test asserting every emitted `type` has a mapping. The single place that knows engine jargon.
- **Element resolver:** `id → { name, type, taskType }` from the definition metadata / graph; used by the diagram overlay, timeline, and variable views.
- **Compensation preview (G5):** from the `saga` ledger, compute "what cancel will compensate" = steps with `compensationStatus = pending`, ordered by `seq desc`, with compensator type/element. Shown **before** the Cancel click — closes MoT-3. Read-only derivation; no engine call.

---

## 14. Data flow

- **Read:** SPA → REST (projects / sagas / instances / instance / history / bpmn / definition) → Worker → D1.
- **Live:** SPA → SSE `/instances/{id}/stream` → Worker tails D1 history → deltas → merge → re-render.
- **Act:** SPA → `POST cancel|retry` → engine → D1 → next SSE tick reflects the new `status`/history. The UI applies an optimistic status update, then reconciles from the stream.

---

## 15. Error handling & edge cases

- `401` → redirect to login.
- `409` on cancel/retry (status changed under the operator) → toast "state changed, refresh" + refetch. The UI mirrors the server guard-rails (cancel requires `status ∈ {running, waiting, incident}`; retry requires `status ∈ {incident, compensationFailed}`) but treats the server as authoritative.
- `compensationFailed` (terminal "stuck") → explicit banner offering **Resume (retry) only**. There is intentionally no "final cancel" here: the cancel guard-rail is `status ∈ {running, waiting, incident}` (verified, `src/index.ts`), so a cancel from `compensationFailed` would always `409`, and Principle VI defines `compensationFailed` as operator-**resumable**, not abandonable. (A terminal "abandon" verb — `POST /instances/{id}/abandon` → `operatorResolved` — would need its own constitution/openapi amendment and is out of scope for v1.)
- Variable R2 overlay references (`{"__r2":"key"}`) → "large payload stored in R2" placeholder; no rehydration in v1.
- SSE disconnect → backoff reconnect + indicator; fall back to short-poll.
- Graph/`/bpmn` fetch or ELK failure → element-list fallback; the rest of the UI works.
- Long history → virtualized timeline; humanization is lazy per visible row.

---

## 16. Testing strategy

Per the governance gate, API/runtime changes carry contract or integration tests.

- **Unit (UI):** event humanization, element resolver, compensation-preview derivation, status guard-rails.
- **Contract:** every new endpoint vs `openapi.yaml` (`npm run test:contract`).
- **Integration (vitest-pool-workers):** `/bpmn`, `/instances?sagaId=` (+ multi-status), `/sagas`, `/projects`, `/attention`, `/instances/{id}/jobs`, `/messages` search, the extended `/instances/{id}` subscriptions, and `/instances/{id}/history?since=` against seeded D1.
- **SSE:** delta-by-cursor correctness; reconnect with `Last-Event-ID` resumes without gaps or dupes. (Workflow-mode-only paths remain manual per the project's testing note.)
- **Render:** ELK layout snapshot tests on `examples/*.bpmn` (one with DI, one without).
- **E2E:** seed an `incident` instance → compensation preview → cancel → `compensated`; verify the live timeline updates.

---

## 17. Governance & milestone

- The constitution currently **excludes** "advanced Operate-style UI unless this constitution is amended first." Implementation is therefore **blocked on an amendment** that removes this from the Exclusions and adds the milestone. Principle V (Auditability & Operator Clarity) already endorses operator visibility, so this is a scope widening, not a principle change.
- Proposed milestone name: **M-UI / Operator Console**, distinct from M5 (composition). It carries its own entry in `specs/002-saga-orchestrator/` (or a new spec dir) with the endpoint contracts and acceptance scenarios.
- New endpoints + SSE + auth are API/runtime changes ⇒ **must** include contract/integration tests for the constitution-critical behaviors (audit history fidelity, operator-visible errors, inspection-reads-D1).
- `openapi.yaml` and `runtime-contracts.md` are amended in lockstep; `npm run check:docs` must stay green.

---

## 18. Risks & open questions

| # | Risk / question | Mitigation / proposed answer |
|---|---|---|
| R1 | Worker SSE connection-duration limits | Bounded connections (~25 s) + auto-reconnect via `Last-Event-ID`; poll fallback. Validate against Cloudflare limits before commit. |
| R2 | ELK auto-layout quality for boundary events, compensation associations, M4 regions | First-class layout section at plan time; snapshot tests; iterate on the example files. |
| R3 | Project name source (Project = workspace, no table) | `UI_DEFAULT_WORKSPACE` env for the single-operator case; tiny registry only if multiple workspaces appear. |
| R4 | `GET /instances?sagaId=` requires a join `process_instances → definition_versions(draft_id)` | Add an index if needed; or denormalize `draft_id` onto `process_instances`. Decide at plan time. |
| R5 | bpmn-js bundle size in a Worker-served SPA | Code-split the viewer + ELK web worker; lazy-load on the diagram route. |
| R6 | Single-credential auth is weak | Acceptable for pre-stable single operator; flagged for revisit if multi-user. |
| R7 | History/BPMN HTTP responses may be large | Timeline virtualization; lazy payload expansion; paginate history. The ~1 MiB limit is the **Cloudflare Workflows event-payload** limit and does **not** apply to HTTP responses — returning `bpmn_xml` is safe (the engine already reads that exact D1 column to execute). |

---

## 19. Out of scope (YAGNI)

- BPMN editing / modeling (viewer only).
- Starting instances from the UI (instances are started by services via the API).
- APM/metrics (latency graphs, RPS).
- Multi-tenant RBAC, per-user accounts, SSO.
- R2 overlay rehydration in the variable viewer (v1 shows a placeholder).
- **Rich** shareable permalinks / dashboards / saved views (G7). *A minimal timeline export (JSON/markdown) of `GET /instances/{id}/history` IS in v1 — the data is already there and it serves the audit hand-off job; only the richer sharing surface is deferred.*
- A terminal "abandon" operator verb for `compensationFailed` (would need its own constitution/openapi amendment; see §15).

---

## 20. Adversarial review resolutions

This design was hardened by a three-lens adversarial review (Cloudflare feasibility · completeness/invariants · code-grounding) on 2026-06-14. Code-grounding found the doc's code-level claims accurate (schema, routes, guard-rails, bindings). Resolved findings:

- **Asset/API routing (major)** — replaced the incorrect "disjoint prefixes" mechanism with explicit `run_worker_first` over the API prefixes + a `/console/*` SPA namespace (§7).
- **`waiting` instance opacity (major)** — added active `message_subscriptions` to `GET /instances/{id}` + a "Waiting on" panel (§9, §12).
- **Worker attempts invisible (major)** — added `GET /instances/{id}/jobs` + an Attempts drill-down (§9, §12).
- **Un-correlated messages homeless (major)** — added `GET /messages` list/search + a Messages screen (§9, §12).
- **Cross-saga attention data gaps (major)** — added `GET /attention` / multi-status; redefined the attention set (`compensating` is healthy; "stuck" needs a staleness predicate) (§6, §9, §12).
- **`compensationFailed` "final cancel" contradiction (major)** — removed; the guard-rail makes it a guaranteed `409`; resume-only (§15).
- **"Saga" misnomer for non-transaction processes (major)** — Saga/compensation surfaces made conditional on a `bpmn:transaction` scope; defined the N/A state (§9).
- **SSE rationale/impl (minor)** — corrected rationale; streamed body + `request.signal` abort + heartbeats (§11).
- **DI synthesis required (minor)** — bpmn-js renders nothing without DI; evaluate `bpmn-auto-layout` (§10).
- **SameSite Strict→Lax (minor)** — so external deep-links carry the cookie; shell stays public (§8).
- **52 not ~40 event types + fallback (minor)** — (§13).
- **1 MiB category error (minor)** — that limit is Workflows-event-only, not HTTP (§18 R7).
- **Saga name from mutable draft (minor)** — use the active version's process name (§6).
- **Export deferred but listed as a job (minor)** — pulled a minimal timeline export into v1 (§19).
