# easy-bpmn — BPMN-lite Orchestrator MVP

Make a tiny, **standard** subset of BPMN 2.0 executable on Cloudflare Workers —
without running Camunda/Zeebe, a broker, or a workflow cluster. The supported
happy path is exactly:

```
Start Event → Service Task (remote worker) → Receive Task (await message) → End Event
```

This is the implementation of
[`docs/superpowers/specs/2026-06-07-bpmn-lite-orchestrator-mvp-design.md`](docs/superpowers/specs/2026-06-07-bpmn-lite-orchestrator-mvp-design.md),
whose source of truth is the Spec Kit feature in
[`specs/001-bpmn-lite-orchestrator-mvp/`](specs/001-bpmn-lite-orchestrator-mvp/).

## Architecture

One Cloudflare Worker, separated modules (not separated deployables):

```
HTTP API Worker (src/index.ts)
  → BPMN parse + profile validation (src/bpmn/*, bpmn-moddle, namespace-aware)
  → zod contracts (src/contracts/*)          — validation boundary for untrusted input
  → D1 persistence (src/persistence/*)        — canonical, queryable source of record
  → execution engine (src/runtime/engine.ts)  — the single orchestration truth
       ├─ ProcessWorkflow (src/workflows/*)   — one Cloudflare Workflow per instance (prod)
       └─ DirectExecutor (src/runtime/executor.ts) — deterministic in-process driver (tests)
  → CorrelationBroker DO (src/durable-objects/*) — one DO per workspace+message+correlationKey
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
a `runStep` port and its Receive Task waits through a `waitFor` port:

- **`EXECUTION_MODE=workflow`** (default / `wrangler dev` / deploy): `ProcessWorkflow`
  binds `runStep` → `step.do` (durable, replay-safe — every side effect is inside a
  step) and `waitFor` → `step.waitForEvent`.
- **`EXECUTION_MODE=direct`** (test suite): runs steps inline and resumes the engine
  on message delivery instead of suspending. Same engine, same persistence, same
  invariants — only the durability driver differs. This keeps the integration suite
  deterministic without depending on Workflow runtime timing.

## Commands

```bash
npm install
npx wrangler d1 migrations apply easy_bpmn --local   # apply D1 schema locally
npm run dev                                           # local Worker at http://localhost:8787
npm test                                              # full suite (Vitest + workers pool)
npm run test:unit                                     # bpmn validator + broker state
npm run test:contract                                 # endpoints vs contracts + runtime events
npm run test:integration                              # the six quickstart scenarios
npm run typecheck                                     # tsc --noEmit
npx wrangler deploy --dry-run                         # validate bindings/config + bundle
```

Before deploying to Cloudflare, create the D1 database (`wrangler d1 create easy_bpmn`)
and set the real `database_id` in `wrangler.jsonc`.

## API surface

`POST /definitions/drafts` · `GET /definitions/drafts/{id}` ·
`POST /definitions/drafts/{id}/publish` · `GET /definitions/versions/{id}` ·
`POST /definitions/versions/{id}/instances` · `GET /instances/{id}` ·
`GET /instances/{id}/history` · `POST /messages` · `GET /messages/{id}`

See [`specs/001-bpmn-lite-orchestrator-mvp/contracts/openapi.yaml`](specs/001-bpmn-lite-orchestrator-mvp/contracts/openapi.yaml).

## The `easy-bpmn` binding

The only notation added is `<easy-bpmn:taskDefinition type="…" retries="…"/>` inside
the standard `<bpmn:extensionElements>` of a Service Task — additive and ignorable, so
files stay XSD-valid and round-trip through a standard modeler. Workers are routed by
`type`, never by element id/name. See [`examples/simple-approval.bpmn`](examples/simple-approval.bpmn).
