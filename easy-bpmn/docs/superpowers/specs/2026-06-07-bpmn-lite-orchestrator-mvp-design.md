# BPMN-lite Orchestrator MVP Superpowers Design

**Date**: 2026-06-07
**Status**: Approved for implementation planning
**Backlog task**: TASK-6
**Spec Kit source**: `specs/001-bpmn-lite-orchestrator-mvp/`

## Purpose

This document is an implementation-facing design bridge for the BPMN-lite Orchestrator MVP. It does not replace the Spec Kit artifacts. It distills the approved product and architecture decisions into a compact design for the next Superpowers planning step.

The design combines two views:

1. Implementation bridge: architecture, module boundaries, runtime invariants, and validation strategy.
2. Risk/decomposition map: sequencing and failure modes that should shape the implementation plan.

## Source of Truth

The source of truth remains the Spec Kit feature directory:

- Product behavior: `specs/001-bpmn-lite-orchestrator-mvp/spec.md`
- Architecture and technology choices: `plan.md` and `research.md`
- Data and API/runtime contracts: `data-model.md`, `contracts/openapi.yaml`, and `contracts/runtime-contracts.md`
- Validation flow: `quickstart.md`
- Governance: `.specify/memory/constitution.md`

If this document and `specs/001-bpmn-lite-orchestrator-mvp` conflict, `specs/001-bpmn-lite-orchestrator-mvp` wins. One known documentation drift exists outside the Spec Kit source: `docs/bpmn/09-easy-bpmn-profile.md` still contains wording about a Durable Object per instance. For this MVP implementation, the authoritative architecture is one Cloudflare Workflow per process instance plus a Durable Object correlation broker keyed by `workspaceId + messageName + correlationKey`.

## Approaches Considered

### Chosen: Implementation Bridge Plus Risk Map

This approach keeps the Superpowers design compact and implementation-facing. It references Spec Kit for full product detail, while capturing the runtime shape, module seams, invariants, delivery slices, risks, and testing focus needed for implementation planning.

This is the recommended approach because the Spec Kit artifacts are already detailed and internally aligned. Rewriting them would create a second source of truth.

### Alternative: Full Product Spec Rewrite

This would restate user stories, functional requirements, success criteria, contracts, and quickstart behavior in Superpowers format. It would be thorough but redundant, and it would increase the chance that the two specs diverge.

Rejected because it adds little implementation value over the existing Spec Kit artifacts.

### Alternative: Architecture Decision Spec Only

This would focus narrowly on Workflows-first execution, Durable Object correlation, D1 persistence, `bpmn-moddle`, `easy-bpmn:taskDefinition`, and API-supplied correlation keys.

Rejected as too narrow for implementation planning because it would not capture decomposition, risk sequencing, module ownership, or verification strategy.

## Runtime Architecture

The MVP is a single Cloudflare Workers TypeScript service with separated modules, not separated deployables.

Public API requests enter through the Worker `fetch` handler. The API owns request validation, BPMN draft/version endpoints, instance start, message publish, and inspection endpoints. It must not expose Cloudflare Workflow internals as the product contract.

Execution uses one Cloudflare Workflow instance per BPMN process instance. The Workflow drives the BPMN-lite graph: Start Event, Service Task, Receive Task wait, and End Event. It writes every meaningful transition to D1 because Workflow state is runtime state, not the operator source of record.

Message correlation is isolated in a Durable Object broker keyed by `workspaceId + messageName + correlationKey`. The broker serializes subscription registration, publish races, duplicate `messageId` handling, early-message buffering, expiry, and delivery to Workflow events.

D1 is the canonical queryable store for drafts, immutable versions, instances, variables, jobs, attempts, messages, subscriptions, history, incidents, and idempotency records.

```text
HTTP API Worker
  -> BPMN parser/validator
  -> D1 persistence
  -> Cloudflare Workflow per process instance
       -> Service Task adapter
       -> Receive Task registration
            -> DO correlation broker
                 -> Workflow event delivery
  -> D1 inspection/history endpoints
```

## Module Boundaries

The implementation should keep responsibilities explicit:

- `src/index.ts`: Worker HTTP entrypoint and routing.
- `src/bpmn/*`: parse BPMN XML with `bpmn-moddle`, validate the BPMN-lite profile, and extract an immutable execution graph. This layer must not manage runtime state transitions.
- `src/contracts/*`: `zod` schemas for public API payloads, API responses, and Workflow events. This is the validation boundary for untrusted inputs.
- `src/persistence/*`: D1 statements and transaction helpers. D1 remains the canonical inspection and history store.
- `src/workflows/process-workflow.ts`: drive one process instance through the parsed graph. It may call persistence helpers and broker RPC, but should not embed XML parsing or HTTP API concerns.
- `src/durable-objects/correlation-broker.ts`: own correlation-key serialization, active subscription uniqueness, message dedupe, buffering, expiry, and stable duplicate responses.
- `src/runtime/*`: service-task adapter, receive-task helper, idempotency utilities, and runtime errors.
- `src/observability/*`: structured logs and diagnostic helpers.

## Runtime Invariants

The implementation plan must preserve these invariants:

- Published definition versions are immutable.
- Each process instance binds to exactly one definition version and one Workflow instance.
- Worker routing uses `easy-bpmn:taskDefinition type`, never BPMN `id` or `name`.
- Unsupported standard BPMN flow nodes are rejected before publish.
- Foreign-namespace extensions, Diagram Interchange, and `documentation` are tolerated and ignored.
- Service Task job state is persisted before worker execution begins.
- Service Task output variables are persisted before advancing.
- Receive Task message payload is applied atomically with the transition out of wait.
- Duplicate worker callbacks and duplicate message publishes never advance the process twice.
- Duplicate message publish returns the stable prior outcome for the same `workspaceId + messageName + correlationKey + messageId`.
- At most one active eligible subscription exists for a broker key.
- Every operator-relevant transition writes D1 history.
- Workflow state is not the inspection source of truth.
- MVP message and worker payloads that exceed the Workflow event payload limit are rejected explicitly.

## Implementation Decomposition

Implementation should be sliced by risk, not only by file order.

### 1. Project Foundation and Cloudflare Bindings

Establish TypeScript, Wrangler, Worker entrypoint, D1 migrations, Workflow binding, Durable Object binding, and Vitest worker-pool configuration.

This slice should prove that local development can run Worker, Workflow, Durable Object, and D1 integration tests.

### 2. BPMN Parser and Profile Validator

This is the highest product-canonicity risk. Use `bpmn-moddle` for namespace-aware parsing and BPMN reference resolution. Add the `easy-bpmn` moddle extension descriptor for Service Task `taskType` and retry metadata.

Validation must reject unsupported standard-namespace flow nodes and structures while tolerating ignorable foreign extensions, Diagram Interchange, and documentation. Publish-blocking errors should include element id/name/location when available.

### 3. Persistence Model and Contracts

Build the D1 schema and the API/Workflow `zod` contracts before the runtime flow. This locks the product boundary and makes the integration tests less ambiguous.

The schema must cover drafts, validation issues, immutable versions, parsed profile metadata, instances, workflow bindings, variables, jobs, attempts, subscriptions, external messages, history, incidents, and idempotency records.

### 4. Definition Draft, Publish, and Start API

Implement draft upload, validation status, publish, version inspection, and instance start. This proves immutable version creation and process-instance binding before adding complex waits and correlation behavior.

### 5. Workflow Service Task Path

Implement the Workflow path through Start Event and Service Task. Persist job state before worker execution, run the product-provided sample worker, persist output variables, record attempts/history, and handle retry exhaustion by creating a view-only incident.

### 6. Receive Task and Correlation Broker

This is the highest concurrency/idempotency risk. Implement active subscription uniqueness, early-message buffering, duplicate `messageId` handling, stable duplicate response, expiry, and Workflow event delivery through the Durable Object broker.

### 7. Inspection, History, and Quickstart Demo

Expose the operator proof: instance state, current/final element, variables, timeline, diagnostics, incidents, and raw payload snapshots. Validate the full demo flow from upload through completion and history inspection.

## Risk Map

### BPMN Canonicity Drift

The validator could accidentally reject valid ignorable extension content or accept unsupported standard flow nodes. Tests must cover both sides: rejected gateways/timers/user tasks and accepted foreign extensions, DI, and documentation.

### Correlation Races

Message publish and Receive Task subscription registration can race. The Durable Object broker is the serialization point for one broker key, so the implementation should avoid D1-only correlation decisions outside the broker.

### Split-Brain Source of Record

Cloudflare Workflow status is useful runtime data, but D1 is the product source of record. Inspection endpoints should read from D1 and may include synchronized Workflow diagnostics only as supplemental data.

### Idempotency Gaps

Worker callbacks, message publishes, Workflow events, and retries are at-least-once inputs. Idempotency records and stable outcomes must be written before externally visible duplicate-prone effects are considered complete.

### Payload Limit Failures

Workflow events have a hard payload limit. Oversized message and worker payload snapshots should be rejected before event delivery or worker invocation rather than failing inside the runtime.

### Demo Worker Ambiguity

The MVP includes a product-provided sample Service Task worker to prove the demo flow. Custom worker registration is out of scope, but the sample worker path should still use the same job, attempt, retry, idempotency, and history model expected for future workers.

## Error Handling Design

Errors should be product-facing and element-aware:

- BPMN parse/validation errors return draft validation issues with element id/name/location when available.
- Publish rejects unsupported profile content with `409` and creates no immutable version.
- Start rejects unknown, deleted, or unpublished definition versions.
- Broker rejects invariant violations, especially a second active subscription for the same broker key.
- Oversized message and worker payloads are rejected before Workflow event delivery.
- Exhausted Service Task retries create a view-only incident with element, reason, retry count, and payload context.
- Duplicate messages and duplicate worker callbacks return stable prior outcomes and write duplicate-handling history.

## Testing Strategy

Testing should be layered:

- Unit tests for BPMN validator, graph extraction, idempotency helpers, and broker state transitions.
- Contract tests for OpenAPI-shaped endpoints and runtime event payload schemas.
- Worker-pool integration tests for D1, Durable Object, Workflow, and Worker behavior.
- End-to-end demo test for upload -> publish -> start -> sample Service Task -> Receive Task -> message -> complete -> history.
- Focused regression tests for unsupported BPMN rejection, ignored extensions/DI/documentation, duplicate message publish, early message buffering, duplicate worker callback, retry-to-incident, immutable version binding, and payload limit rejection.

The implementation should treat the quickstart scenarios as executable validation targets, not only documentation.

## Explicitly Out of Scope

The MVP scope remains unchanged from Spec Kit:

- Visual BPMN modeling UI.
- Built-in tasklists, BPMN User Task, forms, or assignment.
- Gateways, timers, boundary events, subprocesses, multi-instance, compensation, and process migration.
- Custom worker registration or production worker marketplace behavior.
- Operator recovery actions such as retry, manual completion, incident resolution, or business rollback.
- Model-level correlation expressions or FEEL-based subscription keys.
- Full Camunda/Zeebe compatibility.
- Advanced operations UI.

## Plan Handoff Notes

The next Superpowers step should be `writing-plans`. The implementation plan should keep the decomposition above as the execution order and should translate each slice into concrete tasks with tests. It should not reopen the product scope unless a conflict is found in `specs/001-bpmn-lite-orchestrator-mvp`.
