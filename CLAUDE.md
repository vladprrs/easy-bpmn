# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`easy-bpmn` is a **BPMN-lite Orchestrator MVP**: a single Cloudflare Workers (TypeScript) service that
makes a tiny, *standard* subset of BPMN 2.0 executable without users running Camunda/Zeebe, a broker, or
a workflow cluster. The supported happy path is exactly:

```
Start Event → Service Task (remote worker) → Receive Task (await message) → End Event
```

**The MVP is implemented and deployed.** `src/`, `tests/`, `migrations/`, and `package.json` are on disk
(the Spec Kit feature in `specs/001-bpmn-lite-orchestrator-mvp/`), the test suite is green, and the Worker
is live at `https://bpmn.rntme.com` (Cloudflare Workers + D1 + Durable Object broker + Workflow), with
GitHub Actions CI/CD at the repo root (`.github/workflows/`). The directory layout, commands, and
dependencies described below are the **planned** target from `plan.md`/`quickstart.md`, not yet on disk.

## Source-of-truth hierarchy (read this before changing anything)

Several overlapping document sets exist. When they conflict, this order wins:

1. **`.specify/memory/constitution.md`** — governance. Five principles + MVP scope. Supersedes everything.
2. **`specs/001-bpmn-lite-orchestrator-mvp/`** — the authoritative feature spec (Spec Kit). `spec.md`
   (product behavior), `plan.md` (architecture/tech choices + the planned source layout),
   `research.md` (resolved decisions), `data-model.md` (entities), `contracts/openapi.yaml` +
   `contracts/runtime-contracts.md` (API + runtime contracts), `quickstart.md` (executable validation
   scenarios). **This directory wins over the design doc and the `docs/bpmn/` reference.**
3. **`docs/superpowers/specs/2026-06-07-bpmn-lite-orchestrator-mvp-design.md`** — implementation bridge
   (module seams, decomposition, risk map). Distills #2; does not replace it.
4. **`docs/bpmn/`** — a general BPMN 2.0 reference + the `easy-bpmn` profile (`09-easy-bpmn-profile.md`,
   now the **canonical transaction-saga** profile, in lockstep with constitution v2.0.0).

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

Planned module boundaries (keep responsibilities from leaking across seams):
`src/index.ts` (routing) · `src/bpmn/*` (parse + profile validation, no runtime state) ·
`src/contracts/*` (zod schemas — the validation boundary for untrusted input) · `src/persistence/*`
(D1 statements) · `src/workflows/process-workflow.ts` (drives one instance) ·
`src/durable-objects/correlation-broker.ts` (correlation only) · `src/runtime/*` (service-task adapter,
receive-task helper, idempotency, errors) · `src/observability/*`.

## Non-obvious invariants (enforce these in code and tests)

- **Worker routing is by `easy-bpmn:taskDefinition type`, never by element `id`/`name`.** The `easy-bpmn`
  binding (`xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"`) lives in standard `<bpmn:extensionElements>`;
  it carries the Service Task `type` (routing key) and `retries`. Element ids are audit-only (modelers
  regenerate them when a task is re-drawn).
- **"No custom notation" is a hard, testable rule**: no new MODEL-namespace tags, no redefining a standard
  element's runtime meaning, no non-standard attribute *required to parse*. Every accepted file must stay
  XSD-valid and round-trip through a standard modeler (bpmn-js / Camunda Modeler) when `easy-bpmn`
  extensions and Diagram Interchange are ignored.
- **Reject unsupported *flow nodes* before publish, with element id + reason** (gateways, timers, user
  tasks, subprocesses, conditional/default flows, `instantiate="true"`, etc.). But **tolerate and ignore**
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

## Public API surface (from `contracts/openapi.yaml`)

`POST /definitions/drafts` · `GET /definitions/drafts/{id}` · `POST /definitions/drafts/{id}/publish` ·
`GET /definitions/versions/{id}` · `POST /definitions/versions/{id}/instances` ·
`GET /instances/{id}` · `GET /instances/{id}/history` · `POST /messages` · `GET /messages/{id}`.

The API is the product contract — it must **not** expose Cloudflare Workflow internals (e.g.
`workflowInstanceId` is never required from external message publishers).

## Planned commands (from `quickstart.md` — valid once `src/` + `package.json` exist)

```bash
npm install
npx wrangler d1 migrations apply easy_bpmn --local   # apply D1 schema locally
npm run dev                                            # local Worker at http://localhost:8787
npm run test                                           # full suite
npm run test:unit                                      # bpmn validator, broker state, idempotency
npm run test:contract                                  # endpoints vs contracts/openapi.yaml + runtime events
npm run test:integration                               # D1 + DO + Workflow + Worker (vitest-pool-workers)
npx wrangler deploy --dry-run                          # validate bindings/config
```

Tests use **Vitest with `@cloudflare/vitest-pool-workers`** so D1, Durable Objects, Workflows, and the
Worker run in the workerd runtime. Treat the six `quickstart.md` scenarios as executable validation
targets, not just docs (demo flow, unsupported-BPMN rejection, duplicate publish, early-message buffering,
retry→incident, immutable version binding).

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
  `AGENTS.md` points agents at the active `plan.md`. The next planned step (per the design doc) is
  `writing-plans` / `/speckit-tasks` to turn the decomposition into concrete tasks + tests.
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
