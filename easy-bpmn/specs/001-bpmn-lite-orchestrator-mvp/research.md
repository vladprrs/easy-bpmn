# Phase 0 Research: BPMN-lite Orchestrator MVP

## Decision: Use a Workflows-first execution model with explicit API, broker, and persistence boundaries

**Decision**: Execute each BPMN process instance as one Cloudflare Workflow instance, but keep the product-facing API, BPMN correlation broker, and canonical persistence outside Workflow internals.

**Rationale**: Cloudflare Workflows provides durable multi-step execution, per-step retries, `step.waitForEvent`, sleep, status inspection, and long-running process support without user-managed workflow infrastructure. The BPMN product contract still needs semantics that Workflows does not provide by itself: upload/publish/versioning, correlation by `messageName + correlationKey`, stable duplicate `messageId` responses, early-message buffering before a Receive Task becomes eligible, and queryable operator history.

**Alternatives considered**:
- Durable Objects-first runtime: gives maximal state-machine control, but would require building a workflow scheduler, retry system, waits, and runtime lifecycle manually.
- Workflows + D1 only: simpler component count, but unsafe for parallel message publish/correlation races and weaker for deterministic duplicate response storage.
- External BPMN engine/Camunda/Zeebe: rejected by the product promise and constitution.

## Decision: Expose a Workers HTTP API as the product boundary

**Decision**: Use a Cloudflare Worker `fetch` entrypoint for all public endpoints: draft upload, validation status, publish, start instance, publish message, inspect instance, inspect history, and inspect message outcome.

**Rationale**: The product API must remain BPMN-oriented. Callers should not need a Cloudflare Workflow instance ID to publish business events. The Worker API validates payloads, checks D1 state, creates Workflow instances, routes messages to the broker, and returns stable product outcomes.

**Alternatives considered**:
- Direct Cloudflare Workflow API exposure: rejected because it leaks platform identifiers and cannot accept the product's `messageName + correlationKey` correlation contract directly.
- Separate API Worker and runtime Worker in MVP: deferred because one Worker script can host HTTP handlers, Workflow class, and Durable Object class while keeping source modules separated.

## Decision: Create one Cloudflare Workflow instance per BPMN process instance

**Decision**: The Workflow instance ID is derived from or stored with the `ProcessInstance.instanceId`. The Workflow payload includes `workspaceId`, `instanceId`, `definitionVersionId`, and immutable parsed execution metadata.

**Rationale**: One-to-one binding makes lifecycle inspection, idempotency, incident recording, and operator debugging straightforward. It also maps naturally to the MVP's linear process shape and lets `step.do` retries represent Service Task retry behavior.

**Alternatives considered**:
- One Workflow per process definition: rejected because instances would need custom fan-out state and independent waits inside one Workflow.
- One Workflow per BPMN element: rejected because cross-element variable persistence and history become harder, and the MVP does not need that granularity.

## Decision: Use a Durable Object correlation broker keyed by workspace/message/correlation

**Decision**: Create broker object IDs from `workspaceId + messageName + correlationKey`. The broker serializes registration of active Receive Task subscriptions, message publish, duplicate detection, early-message buffering, expiration, and delivery to Workflow `sendEvent`.

**Rationale**: The constitution requires at most one active eligible subscription per key and deterministic outcomes for duplicate, early, late, missing, or ambiguous messages. Durable Objects provide a globally addressable coordination point with strongly consistent attached storage, which fits this concurrency-sensitive "atom" better than D1-only checks.

**Alternatives considered**:
- D1 unique constraints only: useful for persistence but insufficient as the only coordination layer for simultaneous publish/register races.
- A global broker Durable Object: rejected as an unnecessary bottleneck and contrary to designing around the natural coordination atom.
- Queue-based message router: useful later for high-throughput async delivery, but unnecessary for the MVP and less direct for synchronous stable API responses.

## Decision: Use D1 as canonical queryable persistence and audit history

**Decision**: Persist drafts, immutable versions, process instances, workflow bindings, variables, job attempts, external messages, message outcomes, subscriptions, history events, and incidents in D1.

**Rationale**: Operators need queryable state and history independent of Cloudflare Workflow retention. D1's SQLite semantics are a good fit for the relational entities in the MVP and for contract/integration tests that assert exact state transitions.

**Alternatives considered**:
- Workflow state/logs as source of record: rejected because platform runtime state is not the product's long-lived operator history.
- Durable Object storage only: strong for coordination but poor for cross-instance operator queries.
- R2-only payload/history archive: useful for future large payload retention, but too indirect for MVP inspection.

## Decision: Store MVP raw payload snapshots in D1 with a 1 MiB runtime payload cap

**Decision**: Store raw worker and message payload snapshots in D1 JSON/text columns for the MVP, while rejecting payloads larger than the Cloudflare Workflows event payload limit. R2 is a future option for larger snapshots.

**Rationale**: The spec requires raw payload snapshots by default for diagnostics. The MVP demo payloads are small, and keeping snapshots in D1 simplifies operator inspection and tests. The Workflow event limit is a hard design constraint for messages delivered through `sendEvent`.

**Alternatives considered**:
- R2 from day one: adds operational setup and indirection that the MVP does not need.
- No raw payload storage: rejected by the specification and auditability principle.
- Store only in Workflow state: rejected because operator history must outlive runtime retention and be queryable.

## Decision: Use TypeScript, `bpmn-moddle`, and `zod`

**Decision**: Implement the Worker application in TypeScript. Parse BPMN XML with `bpmn-moddle` (namespace-aware BPMN 2.0 model reader/writer), then run the profile whitelist and execution over the resulting typed model. Use `zod` for public request/response and Workflow event validation.

**Rationale**: BPMN 2.0 mandates namespace-aware parsing (match `{MODEL-ns}localName`, not the `bpmn:`/`bpmn2:`/default prefix), reference resolution (`*Ref`), and ignorable Diagram Interchange / foreign-namespace extensions. `bpmn-moddle` solves exactly these — the single biggest source of non-canonical parser bugs — and is a pure parser/serializer that imports no execution semantics, so it does not pull unsupported BPMN behavior into the BPMN-lite profile. It is pure JS and runs on the Workers runtime with `nodejs_compat`. This aligns the implementation with the canonical BPMN reference, which explicitly recommends `bpmn-moddle` over a hand-rolled XML→model mapper.

**Alternatives considered**:
- `fast-xml-parser` + hand-rolled namespace handling (previously selected): rejected. It is a generic XML parser with no BPMN namespace/ref awareness, so it would force re-implementing prefix/default-namespace matching and ref resolution — precisely what the reference warns is the #1 parser gotcha and where canonicity bugs creep in. The earlier rationale conflated *parsing* with *executing*; `bpmn-moddle` parses without importing engine semantics.
- A full BPMN engine package (e.g. `bpmn-engine`): rejected because it would execute semantics we intentionally exclude; we want a parser, not an engine. It remains useful only as a semantic cross-check.
- Schema-only TypeScript types: rejected because runtime payloads need validation at API and Workflow boundaries (kept via `zod`).

## Decision: Test with Vitest and `@cloudflare/vitest-pool-workers`

**Decision**: Use Vitest with Cloudflare's Workers test pool to run unit, contract, and integration tests against Worker bindings, Workflows, Durable Objects, and D1-compatible storage.

**Rationale**: Constitution-critical behavior depends on Cloudflare platform bindings and concurrency semantics. Tests should exercise the runtime shape rather than only pure functions.

**Alternatives considered**:
- Node-only unit tests: useful for parser validation but insufficient for Durable Object, Workflow, and D1 integration behavior.
- Manual quickstart only: insufficient for idempotency, retry, duplicate, and correlation guarantees.

## Decision: Carry worker binding and retry metadata in standard extension elements under an `easy-bpmn` namespace

**Decision**: Service Task worker binding (a stable, author-defined task type) and retry policy are declared inside standard `<bpmn:extensionElements>` under a dedicated `easy-bpmn` namespace. The worker is routed by that task type, never by the BPMN element `id` or `name`. Foreign-namespace extensions (`camunda:`, `zeebe:`), Diagram Interchange, and `documentation` are tolerated and ignored.

**Rationale**: Core BPMN 2.0 has no standard way to bind a `serviceTask` to a worker or set retries, so some binding metadata is unavoidable. `extensionElements` is the BPMN-sanctioned escape hatch every engine uses; using it additively keeps files XSD-valid and round-trippable in standard modelers (bpmn-js / Camunda Modeler), which is the operative test that we did not invent a notation. Routing by a stable task type (rather than the tool-generated element `id`/`name`) matches how canonical engines decouple the worker handle from regenerated ids, so re-drawing a task does not break worker routing.

**Alternatives considered**:
- Reuse the `camunda:`/`zeebe:` external-task vocabulary verbatim: rejected because files would look like Camunda/Zeebe yet not honor their execution semantics (FEEL, ioMapping), implying a compatibility the constitution explicitly excludes and misleading authors. easy-bpmn may still *read* such attributes if present, but never requires them.
- Overload the standard `name`/`id` attribute as the worker handle: rejected as hidden platform-only semantics on a standard attribute — a file would look standard but only run under an undocumented convention, violating the spirit of Principle I.
- A new flow-node tag or attribute in the BPMN MODEL namespace: rejected as literal custom notation.

## Decision: Supply the correlation key via the API in the MVP; defer model-level correlation

**Decision**: The correlation key is supplied via the API at instance start and on message publish. The `<message>` element carries only its name; the key is not derived from a model-level subscription expression in the MVP.

**Rationale**: This keeps the MVP small and is a legitimate engine relaxation (Camunda 7 / Operaton allow API-driven message correlation). It is recorded honestly as a known divergence from canonical model-level correlation rather than implied to be model-derived.

**Alternatives considered**:
- Declare the key in the model now (Zeebe-style `subscription correlationKey` / FEEL over variables): deferred — it pulls in an expression language the MVP does not otherwise need.
- Derive the key implicitly from a fixed variable-name convention: rejected as hidden platform-only semantics.

## Source References

- Cloudflare Workflows API: https://developers.cloudflare.com/workflows/build/workers-api/
- Cloudflare Workflows limits: https://developers.cloudflare.com/workflows/reference/limits/
- Cloudflare Durable Objects concepts: https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
- Cloudflare D1 overview: https://developers.cloudflare.com/d1/
