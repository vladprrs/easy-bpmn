# Implementation Plan: SAGA Orchestrator (M1 — Canonical transaction-saga)

**Branch**: `002-saga-orchestrator` | **Date**: 2026-06-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-saga-orchestrator/spec.md`

**Note**: This plan is filled by the `/speckit-plan` workflow. Phase 2 task generation is intentionally deferred to `/speckit-tasks`. This plan covers Milestone M1 only; M2–M5 each require their own constitution amendment and plan.

## Summary

Evolve the live linear MVP into a canonical-BPMN **transaction-saga orchestrator for many
microservices**. A central durable coordinator (one Cloudflare Workflow per instance) drives
a sequence of local transactions across distinct remote microservices that lease work by
`taskType` over a **pull / external-task** API (`/jobs/activate` long-poll, `/complete`,
`/fail`), and on a business failure runs the **compensating** transactions for the
already-completed steps in **reverse completion order**, then settles the instance into a
defined terminal state (`completed` on commit; `compensated` / `compensationFailed` /
`cancelled` on the saga-failed path). The MVP substrate is reused: one Cloudflare Workflow
per instance, D1 as the canonical queryable store, the single Durable Object correlation
broker keyed by `workspaceId + messageName + correlationKey`, immutable version binding, and
persist-before-advance.

The two seams the MVP locked are reopened: the validator whitelist flips from *reject* to
*accept-and-validate* for the saga construct set, and the linear single-token interpreter
becomes a **scope-aware graph interpreter** with a compensation pass. The Service Task
changes from a synchronous in-process call to a durable **async wait** driven by the pull
workers, with lease-driven retries and a per-job Workflow event.

## Technical Context

**Language/Version**: TypeScript 5.x on the Cloudflare Workers runtime with `nodejs_compat`

**Primary Dependencies**: Cloudflare Workers Fetch API, Cloudflare Workflows
(`step.do` / `step.waitForEvent` / `step.sleep`), Durable Objects with SQLite storage, D1,
`bpmn-moddle` for namespace-aware BPMN 2.0 parsing (extended with the `easy-bpmn` moddle
descriptor plus the saga constructs: `transaction`, `boundaryEvent` event definitions,
`association`, `error`, `isForCompensation`), `zod` for request, response, and
workflow-event validation, Wrangler for local development and deployment

**Storage**: D1 is the canonical queryable store (drafts, immutable versions, instances,
variables, jobs/attempts, the new `saga_steps` ledger, worker credentials, subscriptions,
messages, history, incidents, idempotency). Durable Object SQLite storage is strongly
consistent coordination per correlation key (unchanged). Cloudflare Workflow persisted state
is runtime execution state only and is never the operator history source of record.

**Testing**: Vitest with `@cloudflare/vitest-pool-workers` so D1, Durable Objects,
Workflows, and the Worker run in the workerd runtime; contract tests generated from
`contracts/openapi.yaml` and `contracts/runtime-contracts.md`

**Target Platform**: A single Cloudflare Workers application using Workflows, Durable
Objects, and D1 bindings (Workers **Paid** — Durable Objects already force Paid; the Free
plan's 1,024 Workflow steps is inadequate for long saga + reverse pass)

**Project Type**: Serverless web service / API with a durable workflow runtime and a pull
worker contract

**Performance Goals**: Drive the §3 canonical order-saga to commit (and, on a forced
business failure, to a reverse-order compensated terminal state) end-to-end in local /
integration tests; keep `/jobs/activate` long-poll bounded by `waitMs`; keep the Workflow
step budget flat (one `waitForEvent` per task, retries via re-lease)

**Constraints**: Support only the M1 saga profile; D1 does **not** parse `UPDATE … LIMIT …
RETURNING` (code 7500) so job leasing uses the atomic IN-subquery form with the lease guard
in both the subquery and the outer `WHERE`; respect the Cloudflare Workflows ≤1 MiB per-event
payload limit (reject oversized outputs before `sendEvent`, push large outputs to R2
references) and the ≤1 GB cumulative persisted state per instance (keep `step.do` results
small scalars); set the Workflow `limits.steps` headroom (~25000) for a long saga plus
reverse pass; keep the early-message broker TTL fixed at one hour

**Scale/Scope**: M1 delivers the canonical transaction-saga for a single Cloudflare Workers
application: publish/validate the saga subset; one Workflow per instance; pull workers with
per-workspace auth/isolation; Service Task as an async wait with lease-driven retries; the
`transaction` scope; compensation boundary/handler/association; error boundary → cancel end →
cancel boundary; reverse-order scoped compensation with an atomic ledger; `compensationFailed`
+ operator remediation; operator `cancel`/`retry`/`list`; the saga view + `traceId`; the
widened status enums + transition table. **No** gateways, parallelism, or general timers
(only the single job-level activation TTL); single-token forward path.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

For each gate, mark PASS, FAIL, or N/A with rationale. Any FAIL requires an entry in
Complexity Tracking before implementation planning may continue. Checked against constitution
**v2.0.0**.

### Initial Gate *(before Phase 0 research)*

- **BPMN profile** (Principle I, widened): **PASS**. M1 executes only the linear core plus
  the canonical transaction-saga set (`bpmn:transaction`, compensation/error/cancel boundary
  events, `isForCompensation` handler, `bpmn:association`, cancel end event, root
  `bpmn:error`). The only additive binding stays `easy-bpmn:taskDefinition` inside standard
  `<extensionElements>`; files stay XSD-valid and modeler-round-trippable (semantically) when
  easy-bpmn extensions + DI are ignored; every still-unsupported standard-namespace flow node
  (gateways/>1 outgoing flow, conditions, timer/signal/escalation/conditional events,
  callActivity/non-transaction subProcess/multiInstance, `instantiate="true"`,
  pools/lanes/collaboration) is rejected before publish with element id + reason; ignorable
  extension content is tolerated.
- **SAGA / Compensation integrity** (Principle VI): **PASS**. Compensation runs in reverse
  completion order, scoped to its transaction, idempotent + at-least-once (the `saga_steps`
  ledger written atomically with advance via `INSERT OR IGNORE`; compensators receive
  `originalInput` + `capturedOutput`); compensation is triggered only by transaction Cancel
  (error boundary → cancel end, or operator `cancel`), never by an uncaught Error (Hazard →
  terminal incident); a compensator exhausting retries settles to `compensationFailed` with
  operator-resumable remediation, never blocking forever.
- **Immutable version binding** (Principle II): **PASS**. Definition versions stay immutable;
  each instance binds to one version + one Workflow instance for life, yielding a
  deterministic compensation graph (US6 / version-binding-during-compensation gate). Editing
  a draft creates a new version. No runtime migration.
- **Durable idempotency** (Principle III): **PASS**. Pull-worker callbacks are
  `lock_token`-conditional; the single-advance guarantee is Workflow step memoization;
  duplicate `complete`/`fail` return the stable prior outcome; the new `compensate` scope and
  forward `workerCallback` keying (`jobId + lockToken`) prevent a duplicate `fail` from
  re-counting an attempt; `sendEvent` to a terminal instance is a 200 no-op ack, never a 500.
- **Receive Task correlation** (Principle IV): **N/A for new correlation semantics, PASS for
  preservation**. M1 adds no new message-correlation behavior; the broker keyed by
  `workspaceId + messageName + correlationKey` (single active subscription, one-hour
  buffering) is preserved unchanged. The new pull-worker wait uses per-job Workflow events,
  not the broker.
- **Audit and operator clarity** (Principle V): **PASS**. Every saga transition writes D1
  history with a `traceId`; `GET /instances/{id}` exposes the saga view; `GET /instances`
  lets operators discover stuck sagas; `cancel`/`retry` give actionable remediation.
- **MVP scope and platform**: **PASS**. The linear demo flow is preserved; the saga flow runs
  on the same Cloudflare Workers + Workflows + Durable Objects + D1 platform with no external
  workflow infrastructure.

**Constitution-critical tests mandated by this gate** (named M1 gates; failure to ship any is
a constitution violation): `happy-saga-commit`, `business-error-compensation`,
`compensator-fail-remediation`, `duplicate-callback-idempotency`, `terminal-instance-noop-ack`,
`cross-tenant-activate-reject`, `version-binding-during-compensation`. Each maps to a
constitution-critical behavior (compensation ordering, saga state transitions, remote worker
contract, manual remediation, idempotency/retry, worker auth/isolation, immutable binding
through compensation).

## Project Structure

### Documentation (this feature)

```text
specs/002-saga-orchestrator/
|-- plan.md
|-- research.md
|-- data-model.md
|-- quickstart.md
|-- contracts/
|   |-- openapi.yaml
|   `-- runtime-contracts.md
|-- checklists/
|   `-- requirements.md
`-- tasks.md              # Generated later by /speckit-tasks
```

### Source Code (repository root)

The layout extends the existing live MVP source tree (paths below are real on disk except the
new files this milestone adds).

```text
src/
|-- index.ts                          # HTTP router — adds /jobs/* + operator verbs + list
|-- bpmn/
|   |-- parser.ts                     # XML parse + BPMN extraction
|   |-- moddle-extension.ts           # easy-bpmn moddle descriptor (+ saga constructs)
|   |-- graph.ts                      # Graph IR — multi-edge outgoing[] + scope + boundary/association
|   |-- validator.ts                  # reject -> accept-and-validate for the M1 saga set
|   `-- profile.ts                    # supported-construct constants (widened)
|-- contracts/
|   |-- api.ts                        # zod request/response (new /jobs/* + operator + saga view)
|   `-- workflow-events.ts            # zod job-result discriminated union + per-job event type
|-- persistence/
|   |-- db.ts                         # D1 statements (atomic IN-subquery lease, ledger, credentials)
|   |-- definitions.ts
|   |-- instances.ts                  # widened status + saga view + list
|   |-- messages.ts
|   |-- idempotency.ts                # + compensate scope, workerCallback keying
|   `-- history.ts
|-- runtime/
|   |-- engine.ts                     # scope-aware interpreter + compensation pass
|   |-- service-task.ts               # pull/lease worker model (activate/complete/fail)
|   |-- executor.ts                   # DirectExecutor test harness (kept)
|   |-- payload.ts                    # assertPayloadWithinLimit (1 MiB)
|   |-- errors.ts
|   `-- broker-types.ts
|-- durable-objects/
|   `-- correlation-broker.ts         # unchanged (correlation only)
|-- workflows/
|   `-- process-workflow.ts           # drives one instance (per-job waitForEvent)
`-- observability/
    `-- logs.ts                       # + traceId / spanId structured fields

migrations/
|-- 0001_mvp_schema.sql               # unchanged (history)
`-- 0002_saga.sql                     # saga_steps, jobs ALTERs, worker_credentials, incident kind/resolution, indexes

tests/
|-- contract/
|   |-- api.test.ts                   # + /jobs/*, operator verbs, list, saga view vs openapi.yaml
|   `-- runtime-contracts.test.ts     # + job-result union, lease SQL, comp-job contract, no-op ack
|-- integration/
|   |-- happy-saga-commit.test.ts
|   |-- business-error-compensation.test.ts
|   |-- compensator-fail-remediation.test.ts
|   |-- duplicate-callback-idempotency.test.ts
|   |-- terminal-instance-noop-ack.test.ts
|   |-- cross-tenant-activate-reject.test.ts
|   `-- version-binding-during-compensation.test.ts
`-- unit/
    |-- bpmn-validator.test.ts        # + saga accept/reject cases
    |-- graph-scope.test.ts           # scope nesting + compensation map
    `-- compensation-order.test.ts    # reverse-order ledger selection

wrangler.jsonc                        # workflow limits.steps headroom (~25000)
package.json
tsconfig.json
vitest.config.ts
```

**Structure Decision**: Keep the single Cloudflare Workers TypeScript project; M1 adds files
rather than splitting deployables. The two reopened seams are isolated: `src/bpmn/graph.ts`
gains the multi-edge IR + scope; `src/runtime/engine.ts` becomes scope-aware with a node-kind
dispatch registry (the extension seam every later milestone plugs into); `src/runtime/service-task.ts`
becomes the pull/lease model. The correlation broker is untouched. Migrations stay additive
(`0002_saga.sql`); tests mirror the seven constitution-critical saga behaviors rather than UI
flows.

## Complexity Tracking

No constitution violations are planned; every Initial- and Post-Design-gate item is PASS (the
Receive Task gate is N/A only for *new* correlation semantics, which M1 does not add, while the
MVP broker behavior is preserved). No Complexity Tracking rows are required.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_  | _(none)_   | _(none)_                            |

## Phase 0 Research Summary

See [research.md](research.md). Research records the seven locked design decisions
(canonical-BPMN saga modeling; pull/external-task workers; compensation triggered only by
transaction Cancel never by an uncaught Error/Hazard; compensator exhaustion →
`compensationFailed` + remediation; compensators receive original input + captured output and
must be idempotent; per-workspace worker credential with server-derived `workspaceId`;
governance → 2.0.0), the four deferred open questions (M2 expression language; M3 timeout
behavior; M4 CF-Workflows concurrency strategy; M1 worker SDK shape), and the verified platform
constraints (D1 cannot parse `UPDATE … LIMIT … RETURNING`; CF Workflows ≤1 MiB per event and
≤1 GB cumulative state; `limits.steps` headroom; Workers Free step budget inadequate).

## Phase 1 Design Summary

See [data-model.md](data-model.md), [contracts/openapi.yaml](contracts/openapi.yaml),
[contracts/runtime-contracts.md](contracts/runtime-contracts.md), and
[quickstart.md](quickstart.md).

### Post-Design Constitution Check *(after Phase 1 design)*

Re-checked against constitution **v2.0.0** after the data model, contracts, and quickstart.

- **BPMN profile** (Principle I): **PASS**. `data-model.md` persists the topology
  (sequence-flow source/target, associations, scope) so the graph is queryable and replay
  deterministic; `contracts` expose publish rejection for the M1-unsupported set with element
  id + reason while tolerating ignorable content; the §3 canonical saga is the documented
  round-trip target in `spec.md` and `quickstart.md`.
- **SAGA / Compensation integrity** (Principle VI): **PASS**. The `saga_steps` ledger
  (`uq_saga_steps_forward` INSERT-OR-IGNORE, `idx_saga_steps_scope`) is the single
  reverse-order source of truth, written atomically with advance; the compensation job lane
  carries `originalInput` + `capturedOutput` with `is_compensation=1`; the status transition
  table encodes `compensating → compensated | compensationFailed` and the single resumable
  `compensationFailed → compensating` edge; the runtime contract specifies Hazard-vs-Cancel and
  the no-op ack to a terminal instance.
- **Immutable version binding** (Principle II): **PASS**. Migrations are additive and never
  mutate published versions; the instance stays bound to one version, so the compensation graph
  is the bound version's (the `version-binding-during-compensation` gate).
- **Durable idempotency** (Principle III): **PASS**. `idempotency_records.scope` gains
  `compensate`; forward callbacks key by `jobId + lockToken`; the lease SQL + `lock_token`
  conditional updates make stale/duplicate callbacks no-ops; `sendEvent` to a terminal instance
  is a gated 200 no-op ack.
- **Receive Task correlation** (Principle IV): **PASS (preserved), N/A (new semantics)**. The
  broker contract is carried over unchanged; M1 introduces no new correlation behavior.
- **Audit and operator clarity** (Principle V): **PASS**. `history_events.type` (free-text)
  absorbs the saga events; the saga view, list endpoint, and operator verbs are specified in
  the contracts; incidents gain `kind`/`resolution` to drive remediation.
- **MVP scope and platform**: **PASS**. Quickstart validates the saga flow on Cloudflare
  Workers + Workflows + Durable Objects + D1 with the seven named gates and no external workflow
  infrastructure.

**Mandated M1 contract/integration test gates (re-affirmed):** `happy-saga-commit`,
`business-error-compensation`, `compensator-fail-remediation`, `duplicate-callback-idempotency`,
`terminal-instance-noop-ack`, `cross-tenant-activate-reject`,
`version-binding-during-compensation`. Each ships with the corresponding runtime/persistence/API
change; none may be deferred past M1 without a constitution violation entry.
