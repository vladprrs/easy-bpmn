# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`easy-bpmn` is a **BPMN-lite saga orchestrator**: a single Cloudflare Workers (TypeScript) service that
makes a standard subset of BPMN 2.0 executable without Camunda/Zeebe. Implemented milestones:

- **M0** — governance, profile, linear happy path (Start → Service Task → Receive Task → End)
- **M1** — canonical transaction-saga (pull/external-task workers, `bpmn:transaction` scope, compensation, error/cancel boundaries, operator cancel/retry)
- **M2** — conditional sagas (`exclusiveGateway`, FEEL conditions via `feelin`, default flows, token-path cycles with per-occurrence ledger rows)

- **M3** — time & failure taxonomy (interrupting boundary/intermediate timers, message intermediate catch, `eventBasedGateway`, free error routing, the `timeout` incident-kind split + honored `retryable`) — **shipped** (constitution v2.2.0; the runtime opened per validator layer, now complete).
- **M4** — concurrency (block-structured `parallelGateway` AND / `inclusiveGateway` OR (SESE), the token frontier, AND/OR-join barrier, branch-local variable merge, parallel-branch compensation) — **shipped** (constitution v2.3.0 added the construct set, with the single-wake un-guarded-wait semantics recorded in the v2.3.1 PATCH; the single-wake engine, TASK-54, **re-validated GREEN on real Cloudflare Workflows 2026-06-14**, Worker Version `f194b722` — the L6.6 multi-wait defect is resolved).
- **M-UI** — operator console: a **read-only** React SPA (in `spa/`) served same-origin by the Worker via Cloudflare Static Assets, session-cookie auth (`/ui/login|logout|me`), read/aggregation endpoints (`/projects`, `/attention`, `/sagas`, `/instances/{id}/jobs`, `GET /messages` search, `/definitions/versions/{id}/bpmn`, `/instances/{id}/stream` SSE), plus `GET /instances` search/sagaId/multi-status, a `subscriptions` block on instance inspection, and a `?since=` history delta — **shipped** (constitution **v2.4.0** removed the "advanced Operate-style UI" exclusion). The only write surface is still the existing `cancel`/`retry`; all inspection reads D1 (the invariant is preserved). Backend in `src/ui/*` + `src/persistence/ui-queries.ts`; contract/integration in `tests/integration/ui-console.test.ts` + `tests/unit/ui-session.test.ts`.
- **M5-L1** — embedded scopes + hierarchical exceptions (non-transaction embedded `subProcess`, the typed scope tree, the two-tier `committedLocal`/`committed` commit shield, the root-relative subtree reverse pass, hierarchical error bubbling with error boundaries on scopes, the error end event with the `uncaughtError` incident kind, timer boundaries on scopes with Hazard-vs-Cancel interrupt-without-compensation semantics, and the publish-time `MAX_SCOPE_DEPTH` cap) — **shipped** (constitution **v2.5.0** accepted the whole five-layer M5 composition set up front; the runtime opens per layer, and M5-L1 is the first to open). M5-L2 (`callActivity`) through M5-L5 (`signal`) remain accepted-in-governance, interim-rejected at publish, until their own layers open.

**M5-L2 (`callActivity`) is the next layer.** The Worker is live at `https://bpmn.rntme.com`
(Cloudflare Workers + D1 + Durable Object broker + Workflow), with GitHub Actions CI/CD at the repo root.

## Source-of-truth hierarchy (read this before changing anything)

Several overlapping document sets exist. When they conflict, this order wins:

1. **`.specify/memory/constitution.md`** — governance. Five principles + MVP scope. Supersedes everything.
2. **`specs/002-saga-orchestrator/`** — the active implementation spec (M1–M5). `spec.md`, `plan.md`,
   `data-model.md`, `contracts/openapi.yaml` + `contracts/runtime-contracts.md`, `quickstart.md`.
   **This directory wins over the design docs and `docs/bpmn/`.** (`specs/001-bpmn-lite-orchestrator-mvp/`
   covers the original linear MVP and is superseded for all saga work.)
3. **`docs/superpowers/specs/`** — implementation bridge documents (module seams, M2 design, risk maps).
   Distill the specs; do not replace them.
4. **`docs/bpmn/`** — a general BPMN 2.0 reference + the `easy-bpmn` profile (`09-easy-bpmn-profile.md`,
   the **canonical transaction-saga + M2 conditional-saga + M3 time-&-failure-taxonomy + M4 concurrency** profile (the M3
   set — boundary/intermediate timers, message intermediate catch, `eventBasedGateway`, free error
   routing — was **accepted in constitution v2.2.0 and has now fully shipped**; no construct remains in
   the interim per-layer state in `09`; the M4 concurrency set was accepted in v2.3.0 and
   likewise fully shipped, in lockstep with constitution v2.3.1)).

### Architecture is Workflow-per-instance + DO-broker (not DO-per-instance)

The authoritative architecture is **one Cloudflare Workflow per process instance**, plus a **single
Durable Object correlation broker** keyed by `workspaceId + messageName + correlationKey`. (The old
"one Durable Object per instance" drift in `docs/bpmn/09`/`08` was corrected in M0 — those docs now state
the correct mapping; a CI guard, `npm run check:docs`, fails if the stale phrasing reappears under
`docs/bpmn/`.)

## Architecture (the big picture)

One Worker, separated modules, **not** separated deployables. Request flow:

```
HTTP API Worker (src/index.ts)
  → BPMN parser/validator (bpmn-moddle, namespace-aware)
  → D1 persistence (canonical source of record)
  → Cloudflare Workflow, one instance per process instance
       → Service Task adapter (calls the sample worker, routed by taskType)
       → Receive Task registers a subscription, then waitForEvent
            → Durable Object correlation broker (serializes one broker key)
                 → delivers Workflow event
  → D1 inspection/history endpoints
```

The three storage roles are distinct and must not be conflated:

- **D1** is the *canonical, queryable* store and the operator source of record (drafts, immutable
  versions, instances, variables, jobs/attempts, subscriptions, messages, history, incidents, idempotency).
- **Durable Object (broker)** is *strongly-consistent coordination* per correlation key — the single
  serialization point for subscription registration, publish races, dedup, buffering, and expiry.
- **Cloudflare Workflow state** is *runtime execution state only*. It is **never** the inspection source
  of truth; inspection endpoints read D1. Every meaningful transition must also be written to D1 history.

Module boundaries (keep responsibilities from leaking across seams):
`src/index.ts` (routing) · `src/bpmn/*` (parse + profile validation, no runtime state) ·
`src/contracts/*` (zod schemas — the validation boundary for untrusted input) · `src/persistence/*`
(D1 statements, including `saga.ts` for the saga ledger) · `src/workflows/process-workflow.ts` (drives one
instance) · `src/durable-objects/correlation-broker.ts` (correlation only) ·
`src/durable-objects/job-scheduler.ts` (per-job un-leasable DLQ timer — one DO per service_task_job) ·
`src/runtime/engine.ts` (the rewalk/occurrence execution engine) ·
`src/runtime/executor.ts` (WorkflowExecutor vs DirectExecutor seam) ·
`src/runtime/*` (service-task, retry-policy, expressions, payload, errors) · `src/observability/*`.

## Engine: rewalk/occurrence model (M2 — critical, non-obvious)

Every engine drive **re-walks the graph from the start element**. A walk-local, in-memory visit counter
assigns each visit of an element an **occurrence** (0-based). Occurrence is never derived from live D1 row
counts — during a Workflow replay those reads see post-crash state and would desynchronize step names.

- Every step name and persistence key carries the occurrence: `svc-create:el#2`, `wait-job:el#2`, `gw:el#1`.
- Already-applied visits **fast-forward write-free** from D1: a completed job with `output_applied=1`, a
  consumed subscription, or a bookkeeping node whose history event landed are pure cursor moves.
- **Gateway decisions are persisted once and never re-evaluated**: an existing `gateway_decisions` row for
  `(instance, gateway, occurrence)` is the rewalk fast-forward predicate; the recorded branch is reused
  even if variables changed since.
- `MAX_ELEMENT_OCCURRENCES = 1000` (in `src/runtime/engine.ts`) caps visits per element; exceeding it
  triggers a `loopLimit` incident. M4 adds two further caps in the same file: `MAX_CONCURRENT_TOKENS = 256`
  (a `concurrencyLimit` incident on the token frontier) and `STEP_BUDGET_SOFT = 20000` (a `stepBudget`
  incident). M5-L1 adds `MAX_SCOPE_DEPTH = 8` (also in `src/runtime/engine.ts`) — a **publish-time**
  validator reject on scope nesting depth (not a runtime incident: in M5-L1 the scope tree is fully
  static). `npm run check:docs` enforces that every copy of each of these constants in
  `docs/bpmn/` and `specs/002-saga-orchestrator/` matches the engine source.

## Non-obvious invariants (enforce these in code and tests)

- **Worker routing is by `easy-bpmn:taskDefinition type`, never by element `id`/`name`.** The `easy-bpmn`
  binding (`xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"`) lives in standard `<bpmn:extensionElements>`;
  it carries the Service Task `type` (routing key) and `retries`. Element ids are audit-only (modelers
  regenerate them when a task is re-drawn).
- **"No custom notation" is a hard, testable rule**: no new MODEL-namespace tags, no redefining a standard
  element's runtime meaning, no non-standard attribute *required to parse*. Every accepted file must stay
  XSD-valid and round-trip through a standard modeler (bpmn-js / Camunda Modeler) when `easy-bpmn`
  extensions and Diagram Interchange are ignored.
- **Reject unsupported *flow nodes* before publish, with element id + reason** (complex gateways, non-block-structured (non-SESE) parallel/inclusive
  gateways, user tasks, event subprocesses (`triggeredByEvent="true"`) and ad-hoc subprocesses,
  `callActivity`, `multiInstanceLoopCharacteristics`, conditional/default flows not leaving an
  `exclusiveGateway`, `instantiate="true"`, etc. — `exclusiveGateway` + FEEL conditions + default flows +
  token-path cycles are IN since M2 / constitution v2.1.0; the **M3 set** — interrupting boundary/
  intermediate timers, message intermediate catch, `eventBasedGateway`, free error routing — is **IN since
  M3 / constitution v2.2.0** (accepted-and-validated; the runtime opened per validator layer and is now
  complete — see `docs/bpmn/09-easy-bpmn-profile.md`); block-structured (SESE) `parallelGateway` (AND) +
  `inclusiveGateway` (OR) are **IN since M4 / constitution v2.3.0**; plain embedded (non-transaction)
  `subProcess`, scope-hosted error/timer boundaries, and the error end event are **IN since M5-L1 /
  constitution v2.5.0** — `callActivity`, `multiInstanceLoopCharacteristics`, escalation, signal, and the
  event subprocess remain interim-rejected until their own M5 layers open). But
  **tolerate and ignore**
  *ignorable extension content* — foreign-namespace `<extensionElements>` (`camunda:`/`zeebe:`/…), Diagram
  Interchange, and `documentation`. Rejecting a file merely for carrying those is itself non-canonical.
  Both sides need test coverage.
- **Definition versions are immutable**; each process instance binds to exactly one version and one
  Workflow instance for life. Editing a draft creates a new version, never mutates a published one.
- **Persist-before-advance**: Service Task job state is persisted before the worker runs; worker output
  variables are persisted before advancing; Receive Task payload is applied *atomically* with the
  transition out of wait.
- **Everything is at-least-once**: worker callbacks, message publishes, Workflow events, retries. Duplicate
  worker callbacks and duplicate message publishes must never advance twice; duplicate publish returns the
  *stable prior outcome* for the same `workspaceId + messageName + correlationKey + messageId`.
- **At most one active subscription per broker key.** Early messages are buffered for **1 hour** (fixed TTL).
- **Respect the Cloudflare Workflows ~1 MiB event payload limit**: reject oversized message/worker payloads
  *explicitly* before event delivery rather than failing inside the runtime.
- The correlation key is **supplied via the API** at instance start (MVP), not derived from a model-level
  subscription expression. The `<message>` element carries only its name.

## Public API surface (from `specs/002-saga-orchestrator/contracts/openapi.yaml`)

**Definition lifecycle**: `POST /definitions/drafts` · `GET /definitions/drafts/{id}` ·
`POST /definitions/drafts/{id}/publish` · `GET /definitions/versions/{id}` ·
`POST /definitions/versions/{id}/instances`

**Instance inspection + control**: `GET /instances/{id}` · `GET /instances/{id}/history` ·
`POST /instances/{id}/cancel` · `POST /instances/{id}/retry`

**Message correlation**: `POST /messages` · `GET /messages/{id}`

**Pull worker data plane**: `POST /jobs/activate` (long-poll lease) · `POST /jobs/{id}/complete` ·
`POST /jobs/{id}/fail`

**Worker credentials**: `POST /workers/credentials` · `DELETE /workers/credentials/{id}`

The API must **not** expose Cloudflare Workflow internals (`workflowInstanceId` is never required from
external callers). All saga/compensation inspection reads D1, never Workflow state.

## Development commands

```bash
npm install
npx wrangler d1 migrations apply easy_bpmn --local   # apply D1 schema locally
npm run dev                                            # local Worker at http://localhost:8787
npm run test                                           # full suite
npm run test:unit                                      # bpmn validator, broker state, idempotency
npm run test:contract                                  # endpoints vs openapi.yaml + runtime contracts
npm run test:integration                               # D1 + DO + Workflow + Worker (vitest-pool-workers)
npx vitest run tests/integration/demo-flow.test.ts     # single test file
npm run typecheck                                      # tsc --noEmit
npm run check:docs                                     # docs consistency guard (CI enforced)
npm run check:matrix                                   # e2e combination-matrix registry guard
npm run test:matrix                                    # e2e combination matrix (direct + Workflow mode)
npm run dev:ui                                          # M-UI operator console (Vite :5173, proxies API to :8787)
npm run build:ui                                        # build the console SPA → spa/dist (served by the Worker)
npm run test:ui                                         # SPA unit tests (humanization coverage, resolver, guards, compensation)
npm run typecheck:ui                                    # SPA tsc --noEmit
npx wrangler deploy --dry-run                          # validate bindings/config (reads spa/dist — build:ui first)
```

The **e2e combination matrix** ([design](docs/superpowers/specs/2026-06-13-e2e-combination-matrix-design.md)) is a risk-curated suite of 60 end-to-end scenarios (49 valid + 11 publish-reject) covering every supported construct, weighted toward M4 concurrency, run in **both** execution modes: Layer A direct-mode (`vitest-pool-workers`, CI-gated semantics; the 11 rejects live here) and Layer B Workflow-mode (`wrangler dev` + real-CF smoke gate, asserted only over the public HTTP API). `tests/matrix/registry.ts` is the single source of truth; `npm run check:matrix` (sibling of `check:docs`, CI-gated) is the drift-guard — it fails when a registered scenario at/below the active `MATRIX_PHASE` lacks a `[<id>]` marker in its declared test file, when a must-cover construct tag is unreferenced, or when fewer than 11 reject scenarios are registered. `npm run test:matrix` runs the suites (`tests/matrix` + `tests/integration/matrix`). Phase 1 (scaffold + registry seed + drift-guard + npm scripts) is in place; the Layer A direct-mode tests and Workflow-mode Phases 2-3 are not yet authored.

Tests use **Vitest with `@cloudflare/vitest-pool-workers`** — D1, Durable Objects, Workflows, and the
Worker run in the workerd runtime (miniflare). The vitest config (`vitest.config.ts`) always overrides
`EXECUTION_MODE=direct`, so **Workflow-mode-only paths** (step memoization across suspend/resume, operator
resume after Workflow termination) are tested manually or via `wrangler dev`. See
`tests/integration/demo-flow.test.ts` and the other quickstart scenarios as executable validation targets.

## Governance gate (Spec Kit constitution check)

Plans MUST pass the Constitution Check **before Phase 0 research and again after Phase 1 design**. Any
deviation goes in the plan's Complexity Tracking with a reason and a rejected simpler alternative.
Runtime/API/persistence changes MUST include contract or integration tests for the relevant
constitution-critical behavior (BPMN subset validation, immutable version binding, Service Task worker
contract, Receive Task correlation, idempotency/retry, audit history, operator-visible errors). When you
amend the profile or scope, amend `constitution.md` in lockstep and keep `docs/bpmn/09-easy-bpmn-profile.md`
aligned.

## Meta-tooling

This project is driven by two systems whose state lives in the repo:

- **Spec Kit** (`.specify/`, plus `.agents/skills/speckit-*`): the spec→plan→tasks→implement workflow.
  `AGENTS.md` and `.specify/feature.json` point at the active plan `specs/002-saga-orchestrator/plan.md`
  for the M1–M5 saga work; `specs/001-bpmn-lite-orchestrator-mvp/plan.md` is the superseded original MVP.
- **Backlog.md MCP** (`backlog/`): all task and project management. Use it before creating tasks — the
  workflow is described below and is not summarized here.

<!-- BACKLOG.MD MCP GUIDELINES START -->

<CRITICAL_INSTRUCTION>

## BACKLOG WORKFLOW INSTRUCTIONS

This project uses Backlog.md MCP for all task and project management activities.

**CRITICAL GUIDANCE**

- If your client supports MCP resources, read `backlog://workflow/overview` to understand when and how to use Backlog for this project.
- If your client only supports tools or the above request fails, call `backlog.get_backlog_instructions()` to load the tool-oriented overview. Use the `instruction` selector when you need `task-creation`, `task-execution`, or `task-finalization`.

- **First time working here?** Read the overview resource IMMEDIATELY to learn the workflow
- **Already familiar?** You should have the overview cached ("## Backlog.md Overview (MCP)")
- **When to read it**: BEFORE creating tasks, or when you're unsure whether to track work

These guides cover:
- Decision framework for when to create tasks
- Search-first workflow to avoid duplicates
- Links to detailed guides for task creation, execution, and finalization
- MCP tools reference

You MUST read the overview resource to understand the complete workflow. The information is NOT summarized here.

</CRITICAL_INSTRUCTION>

<!-- BACKLOG.MD MCP GUIDELINES END -->
