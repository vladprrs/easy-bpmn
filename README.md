# easy-bpmn — BPMN-lite Saga Orchestrator

Make a **standard** subset of BPMN 2.0 executable on Cloudflare Workers — without
running Camunda/Zeebe, a broker, or a workflow cluster. `easy-bpmn` is a BPMN-lite
**saga orchestrator**: it turns canonical BPMN models into durable, compensating
sagas with pull/external-task workers and operator visibility.

Shipped milestones (M0–M4 + the M-UI operator console); **M5 (composition) is next**:

- **M0** — linear happy path: Start Event → Service Task (remote worker) → Receive Task (await message) → End Event.
- **M1** — canonical transaction-saga: `bpmn:transaction` scope, compensation, error/cancel boundary events, operator cancel/retry.
- **M2** — conditional sagas: `exclusiveGateway`, FEEL `conditionExpression`s, default flows, token-path cycles.
- **M3** — time & failure taxonomy: interrupting boundary/intermediate timers, message intermediate catch, `eventBasedGateway`, free error routing.
- **M4** — concurrency: block-structured (SESE) `parallelGateway` (AND) / `inclusiveGateway` (OR), token frontier, AND/OR-join barrier, branch-local variable merge, parallel-branch compensation.
- **M-UI** — operator console: a **read-only** React SPA (in [`spa/`](spa/)) served same-origin by the Worker (Cloudflare Static Assets), session-cookie auth, project/saga/attention rollups, instance jobs+attempts, message search, raw BPMN XML, an SSE history live-tail, and BPMN viewing with a live execution overlay. Read-only except the existing `cancel`/`retry`; all inspection reads D1. See [`spa/README.md`](spa/README.md).

Governed by [`.specify/memory/constitution.md`](.specify/memory/constitution.md) (v2.4.0).
The active implementation spec is
[`specs/002-saga-orchestrator/`](specs/002-saga-orchestrator/) (`spec.md`, `plan.md`,
`data-model.md`, `quickstart.md`, `contracts/`). `specs/001-bpmn-lite-orchestrator-mvp/`
covers the original linear MVP and is **superseded** for all saga work.

## Architecture

One Cloudflare Worker, separated modules (not separated deployables):

```
HTTP API Worker (src/index.ts)
  → BPMN parse + profile validation (src/bpmn/*, bpmn-moddle, namespace-aware)
  → zod contracts (src/contracts/*)          — validation boundary for untrusted input
  → D1 persistence (src/persistence/*)        — canonical, queryable source of record
  → execution engine (src/runtime/engine.ts)  — the single orchestration truth (rewalk/occurrence model)
       ├─ ProcessWorkflow (src/workflows/*)   — one Cloudflare Workflow per instance (prod)
       └─ DirectExecutor (src/runtime/executor.ts) — deterministic in-process driver (tests)
  → CorrelationBroker DO (src/durable-objects/correlation-broker.ts) — one DO per workspace+message+correlationKey
  → JobScheduler DO (src/durable-objects/job-scheduler.ts) — per-job un-leasable DLQ timer (one DO per service_task_job)
```

The three storage roles are kept distinct:

- **D1** — canonical, queryable store + operator source of record. Inspection
  endpoints always read D1, never Workflow internals.
- **Durable Object broker** — strongly-consistent coordination per correlation key:
  active-subscription uniqueness, publish/register races, `messageId` dedup +
  stable duplicate response, 1-hour early-message buffering, expiry.
- **Cloudflare Workflow state** — runtime execution state only.

### Execution drivers

All orchestration lives in `src/runtime/engine.ts`. Its side effects flow through
a `runStep` port and its waits through a `waitFor` port:

- **`EXECUTION_MODE=workflow`** (default / `wrangler dev` / deploy): `ProcessWorkflow`
  binds `runStep` → `step.do` (durable, replay-safe — every side effect is inside a
  step) and `waitFor` → a single replay-stable `bpmn_wake` `step.waitForEvent` (TASK-54):
  every parked token shares one wake, and each drive re-walks the frontier from the
  start element and reconciles against canonical D1.
- **`EXECUTION_MODE=direct`** (test suite): runs steps inline and resumes the engine
  on message delivery instead of suspending. Same engine, same persistence, same
  invariants — only the durability driver differs. This keeps the integration suite
  deterministic without depending on Workflow runtime timing.

## Deployment

The Worker is **live** at <https://bpmn.rntme.com> (Cloudflare Workers + D1 + Durable
Object correlation broker + Cloudflare Workflow), with GitHub Actions CI/CD at the repo
root. M4 was re-validated GREEN on real Cloudflare Workflows (Worker Version `f194b722`,
2026-06-14).

## Commands

```bash
npm install
npx wrangler d1 migrations apply easy_bpmn --local   # apply D1 schema locally
npm run dev                                           # local Worker at http://localhost:8787
npm test                                              # full suite (Vitest + workers pool)
npm run test:unit                                     # bpmn validator + broker state
npm run test:contract                                 # endpoints vs contracts + runtime events
npm run test:integration                              # D1 + DO + Workflow + Worker scenarios
npm run typecheck                                     # tsc --noEmit
npm run check:docs                                    # docs-consistency guard (CI enforced)
npm run check:matrix                                  # e2e combination-matrix registry guard
npm run test:matrix                                   # e2e combination matrix (direct + Workflow modes)
npm run deploy                                        # wrangler deploy
npx wrangler deploy --dry-run                         # validate bindings/config + bundle
```

Before deploying to Cloudflare, create the D1 database (`wrangler d1 create easy_bpmn`)
and set the real `database_id` in `wrangler.jsonc`.

## API surface

**Definition lifecycle:** `POST /definitions/drafts` · `GET /definitions/drafts/{id}` ·
`POST /definitions/drafts/{id}/publish` · `GET /definitions/versions/{id}` ·
`POST /definitions/versions/{id}/instances`

**Instance inspection + control:** `GET /instances/{id}` · `GET /instances/{id}/history` ·
`POST /instances/{id}/cancel` · `POST /instances/{id}/retry`

**Message correlation:** `POST /messages` · `GET /messages/{id}`

**Pull worker data plane:** `POST /jobs/activate` · `POST /jobs/{id}/complete` · `POST /jobs/{id}/fail`

**Worker credentials:** `POST /workers/credentials` · `DELETE /workers/credentials/{id}`

The API never exposes Cloudflare Workflow internals (`workflowInstanceId` is never
required from external callers); all saga/compensation inspection reads D1. See
[`specs/002-saga-orchestrator/contracts/openapi.yaml`](specs/002-saga-orchestrator/contracts/openapi.yaml)
and [`contracts/runtime-contracts.md`](specs/002-saga-orchestrator/contracts/runtime-contracts.md).

## The `easy-bpmn` binding

The only notation added is `<easy-bpmn:taskDefinition type="…" retries="…"/>` inside
the standard `<bpmn:extensionElements>` of a Service Task — additive and ignorable, so
files stay XSD-valid and round-trip through a standard modeler. Workers are routed by
`type`, never by element id/name.

## Examples

The [`examples/`](examples/) directory ships representative models across the supported subset:

- [`simple-approval.bpmn`](examples/simple-approval.bpmn) — M0 linear happy path (+ `simple-approval-draft.json`).
- [`order-saga.bpmn`](examples/order-saga.bpmn) — M1 transaction-saga with compensation.
- [`conditional-fulfillment-saga.bpmn`](examples/conditional-fulfillment-saga.bpmn) — M2 conditional saga.
- [`event-gateway-saga.bpmn`](examples/event-gateway-saga.bpmn) — M3 `eventBasedGateway`.
- [`timer-saga.bpmn`](examples/timer-saga.bpmn) — M3 interrupting timers.
- [`unsupported-gateway.bpmn`](examples/unsupported-gateway.bpmn) — publish-rejection fixture.

## E2E combination matrix

The **e2e combination matrix** ([design](docs/superpowers/specs/2026-06-13-e2e-combination-matrix-design.md))
is a risk-curated suite of **60 end-to-end scenarios** (49 valid + 11 publish-reject)
covering every supported BPMN construct and the high-risk combination corners, weighted
toward M4 concurrency. Each scenario is driven from one shared BPMN fixture across **two
execution layers**: Layer A direct-mode (`@cloudflare/vitest-pool-workers`,
`EXECUTION_MODE=direct`, CI-gated, proves semantics; the 11 publish-reject scenarios live
here) and Layer B Workflow-mode (`wrangler dev` + a real-Cloudflare smoke gate; proves
suspend/resume, `step.do` memoization, `step.waitForEvent` parking, deterministic replay
and self-heal — asserted **only over the public HTTP API**, never Workflow internals).
`tests/matrix/registry.ts` is the single source of truth; `npm run check:matrix` (a
sibling of `check:docs`) is the CI-gated drift-guard, and `npm run test:matrix` runs the
suites (`tests/matrix` + `tests/integration/matrix`). **Status:** Phase 1 foundation
(scaffold + 60-scenario registry seed + drift-guard + npm scripts) is in place; the Layer
A direct-mode tests and Workflow-mode Phases 2–3 (Phase 3 = the M4-closure gate) are not
yet authored.
