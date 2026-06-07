# Implementation Plan: BPMN-lite Orchestrator MVP

**Branch**: `001-bpmn-lite-orchestrator-mvp` | **Date**: 2026-06-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-bpmn-lite-orchestrator-mvp/spec.md`

**Note**: This plan is filled by the `/speckit-plan` workflow. Phase 2 task generation is intentionally deferred to `/speckit-tasks`.

## Summary

Deliver the MVP vertical flow where a backend/platform developer can upload BPMN XML, publish an immutable executable version, start a process instance, run the sample Service Task worker, wait for an external business message, complete the instance, and inspect execution history without operating Camunda, Zeebe, a broker, or a workflow cluster.

The approved technical approach is a Workflows-first execution model with explicit product boundaries: Cloudflare Workers expose the HTTP API, one Cloudflare Workflow instance executes each BPMN process instance, a Durable Object correlation broker serializes `messageName + correlationKey` matching and `messageId` deduplication, and D1 stores canonical queryable state, variables, audit history, messages, and incidents.

## Technical Context

**Language/Version**: TypeScript 5.x on Cloudflare Workers runtime with `nodejs_compat`

**Primary Dependencies**: Cloudflare Workers Fetch API, Cloudflare Workflows, Durable Objects with SQLite storage, D1, `bpmn-moddle` for namespace-aware BPMN 2.0 XML parsing (with a small `easy-bpmn` moddle extension descriptor for worker binding/retry metadata), `zod` for request and workflow-event validation, Wrangler for local development and deployment

**Storage**: D1 is canonical queryable persistence for drafts, immutable versions, instances, variables, jobs, messages, history, and incidents. Durable Object SQLite storage is strongly consistent coordination storage per correlation key. Cloudflare Workflow persisted state is runtime execution state only and is not the operator history source of record.

**Testing**: Vitest with `@cloudflare/vitest-pool-workers` for Worker, Workflow, Durable Object, and D1 integration tests; focused contract tests generated from `contracts/openapi.yaml`

**Target Platform**: Cloudflare Workers application using Workflows, Durable Objects, and D1 bindings

**Project Type**: Serverless web service / API with durable workflow runtime

**Performance Goals**: Complete the documented demo flow in under 10 minutes for a new developer; return non-running API responses within 500 ms p95 in local/integration tests; publish duplicate messages without advancing a process more than once; keep message publish path single-hop through the relevant broker object after API validation

**Constraints**: Support only the BPMN-lite profile from the specification; keep early-message TTL fixed at one hour; enforce at most one active eligible subscription per `workspaceId + messageName + correlationKey`; respect the Cloudflare Workflows 1 MiB event payload limit by rejecting larger MVP message/worker payloads with explicit errors; store raw payload snapshots by default in D1 for MVP diagnostics

**Scale/Scope**: MVP supports the product demo and constitution-critical runtime behaviors for a single Cloudflare Workers application: draft/publish/start, one Workflow instance per BPMN process instance, one active Receive Task subscription per correlation key, one sample Service Task worker path, retries/incidents, duplicate handling, early-message buffering, and operator inspection

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Initial Gate

- **BPMN-lite profile**: PASS. Plan keeps execution limited to Start Event, Service Task, Receive Task, End Event, Sequence Flow, and Message correlation; unsupported standard-namespace flow nodes are rejected before publish, while foreign-namespace extensions and Diagram Interchange are tolerated and ignored. Worker binding and retries live in standard `<extensionElements>` under an `easy-bpmn` namespace (additive, ignorable, XSD-valid, round-trippable) — no custom notation, and the worker is routed by a stable task type, not the element id/name.
- **Immutable version binding**: PASS. D1 stores immutable `ProcessDefinitionVersion` rows, and every `ProcessInstance` stores exactly one `definitionVersionId` and one `workflowInstanceId`.
- **Durable idempotency**: PASS. Workflow steps, D1 idempotency rows, and the Durable Object broker combine to make retries, worker callbacks, duplicate message publishes, and replay safe.
- **Receive Task correlation**: PASS. The broker object is keyed by `workspaceId + messageName + correlationKey` and enforces deterministic single-subscription matching plus stable duplicate publish outcomes.
- **Audit and operator clarity**: PASS. D1 is the source of record for business timeline, technical diagnostics, raw payload snapshots, retry history, duplicate handling, message outcomes, and incidents.
- **MVP scope and platform**: PASS. The flow stays upload -> publish -> start -> service task -> receive message -> complete -> history on the Cloudflare-targeted platform.

## Project Structure

### Documentation (this feature)

```text
specs/001-bpmn-lite-orchestrator-mvp/
|-- plan.md
|-- research.md
|-- data-model.md
|-- quickstart.md
|-- contracts/
|   |-- openapi.yaml
|   `-- runtime-contracts.md
`-- tasks.md              # Generated later by /speckit-tasks
```

### Source Code (repository root)

```text
src/
|-- index.ts                         # Worker HTTP API entrypoint and routing
|-- workflows/
|   `-- process-workflow.ts          # WorkflowEntrypoint for one BPMN process instance
|-- durable-objects/
|   `-- correlation-broker.ts        # DO RPC object keyed by workspace/message/correlation
|-- bpmn/
|   |-- parser.ts                    # XML parse and BPMN-lite extraction
|   |-- validator.ts                 # Unsupported element validation
|   `-- profile.ts                   # Supported element/profile constants
|-- persistence/
|   |-- db.ts                        # D1 statements and transaction helpers
|   |-- definitions.ts
|   |-- instances.ts
|   |-- messages.ts
|   `-- history.ts
|-- runtime/
|   |-- service-task.ts              # Sample worker adapter and retry metadata mapping
|   |-- receive-task.ts              # Subscription registration and event wait helpers
|   |-- idempotency.ts
|   `-- errors.ts
|-- contracts/
|   |-- api.ts                       # zod request/response schemas
|   `-- workflow-events.ts           # zod Workflow event schemas
`-- observability/
    `-- logs.ts                      # Structured log helpers

migrations/
`-- 0001_mvp_schema.sql

tests/
|-- contract/
|   |-- api.test.ts
|   `-- runtime-contracts.test.ts
|-- integration/
|   |-- demo-flow.test.ts
|   |-- duplicate-message.test.ts
|   |-- early-message-buffer.test.ts
|   `-- service-task-incident.test.ts
`-- unit/
    |-- bpmn-validator.test.ts
    `-- correlation-broker.test.ts

wrangler.jsonc
package.json
tsconfig.json
vitest.config.ts
```

**Structure Decision**: Use a single Cloudflare Workers TypeScript project. The runtime remains small enough for one deployable Worker script, while Workflows and Durable Objects are split into focused modules. D1 schema lives in `migrations/`; tests mirror constitution-critical behavior rather than UI flows.

## Complexity Tracking

No constitution violations are planned.

## Phase 0 Research Summary

See [research.md](research.md). Research resolves the main technical choice: use a Workflows-first execution model, but keep API, correlation, idempotency, and queryable history outside Workflow internals so the product contract remains BPMN-oriented and operator-visible.

## Phase 1 Design Summary

See [data-model.md](data-model.md), [contracts/openapi.yaml](contracts/openapi.yaml), [contracts/runtime-contracts.md](contracts/runtime-contracts.md), and [quickstart.md](quickstart.md).

### Post-Design Constitution Check

- **BPMN-lite profile**: PASS. Data model stores supported `BPMNElement` records (including the stable Service Task `taskType` read from extension metadata) and validation issues; contracts expose publish rejection for unsupported flow nodes while tolerating ignorable extension content (foreign-namespace extensions, DI, documentation).
- **Immutable version binding**: PASS. The API creates immutable definition versions, and instance start requires a published version.
- **Durable idempotency**: PASS. Contracts require idempotency for start, worker completion/failure, Workflow event delivery, and message publish; D1 and broker data models include idempotency records and stable outcomes.
- **Receive Task correlation**: PASS. The broker contract owns registration, buffering, deduplication, single active subscription enforcement, and `sendEvent` delivery.
- **Audit and operator clarity**: PASS. Every public and runtime transition is represented as a `HistoryEvent` and exposed through inspection contracts.
- **MVP scope and platform**: PASS. Quickstart validates the full demo flow on Cloudflare Workers, Workflows, Durable Objects, and D1 with no external workflow infrastructure.
