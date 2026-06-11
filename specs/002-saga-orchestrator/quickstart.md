# Quickstart: SAGA Orchestrator Validation (M1 + M2)

This guide describes the end-to-end validation scenarios for the transaction-saga implementation:
scenarios 1–9 are the named M1 constitution-critical gates; scenarios 10–14 are the M2
conditional-saga gates (exclusiveGateway + FEEL + cycles), each mapping to a green integration
test named next to it.

## Prerequisites

- Node.js 22+ (Wrangler 4.x requires Node ≥22)
- Wrangler installed through project dependencies
- Cloudflare local development support for Workers, Workflows, Durable Objects, and D1
- A Workers **Paid** plan target (Durable Objects force Paid). Workflows step budget: **10,000
  steps per instance by default**, raisable to **25,000** via `limits.steps` — see the verified
  budget analysis in `wrangler.jsonc` (the M2 loop guard `MAX_ELEMENT_OCCURRENCES = 1000` trips
  well inside the default for single-element loops).

## Setup

```bash
npm install
npx wrangler d1 migrations apply easy_bpmn --local   # applies 0001 … 0005 (MVP, saga, topology, conditional, backfill)
npm run test
npm run dev
```

Expected setup outcome:

- Unit, contract, and integration tests pass (including the M1 + M2 gates).
- Local Worker API is available at `http://localhost:8787`.
- Local D1 database has the MVP schema plus the saga ledger, jobs lease/DLQ columns, worker
  credentials, incident `kind`/`resolution`, the `(workspace_id, status)` list index, the M2
  `occurrence`/`output_applied` columns, conditional topology columns, and `gateway_decisions`.
- Workflow and Durable Object bindings are available in local development.

## Scenario 1: Happy Saga Commits (gate: happy-saga-commit)

1. Publish the §3 canonical order-saga (a `bpmn:transaction` with three forward Service Tasks each
   routed by `easy-bpmn:taskDefinition type` to a distinct microservice; on disk as
   `examples/order-saga.bpmn`).

```bash
curl -sS http://localhost:8787/definitions/drafts \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile xml examples/order-saga.bpmn \
        '{workspaceId: "default", name: "order saga", bpmnXml: $xml}')"
curl -sS -X POST http://localhost:8787/definitions/drafts/{draftId}/publish
```

Expected: draft `valid` with empty `validationIssues`; publish returns `201` with an immutable
`definitionVersionId` whose elements include the transaction, boundary events, association,
compensation handlers, and root error.

2. Start an instance.

```bash
curl -sS http://localhost:8787/definitions/versions/{definitionVersionId}/instances \
  -H 'Content-Type: application/json' \
  -d '{ "workspaceId": "default", "correlationKey": "order-001", "variables": { "amount": 42 } }'
```

Expected: `201`; the instance enters `Tx_order` (`transactionEntered` recorded) and the
`reserve-stock` forward job becomes leasable.

3. Each microservice leases and completes its forward job (separate worker identities).

```bash
curl -sS http://localhost:8787/jobs/activate \
  -H 'Authorization: Bearer <workspace-default-worker-token>' \
  -H 'Content-Type: application/json' \
  -d '{ "taskType": "reserve-stock", "workerId": "stock-svc", "leaseMs": 30000, "waitMs": 20000 }'
# -> { "jobs": [ { "jobId": "...", "lockToken": "...", "attempt": 1, "traceId": "...", "variables": {...} } ] }
curl -sS http://localhost:8787/jobs/{jobId}/complete \
  -H 'Authorization: Bearer <workspace-default-worker-token>' \
  -H 'Content-Type: application/json' \
  -d '{ "lockToken": "{lockToken}", "outputVariables": { "reservationId": "r-9" } }'
```

Repeat activate/complete for `charge-card` then `confirm-shipping`.

Expected outcome:

- Each `complete` persists output and writes a `saga_steps` ledger row atomically with the advance.
- After the last forward step the transaction reaches its none end event and the instance status
  becomes `completed`.
- `GET /instances/{id}` shows the `saga` block phase `forward` with every step committed.

## Scenario 2: Business Error Mid-Saga → Reverse-Order Compensation (gate: business-error-compensation)

Complete `reserve-stock` and `charge-card`, then fail `confirm-shipping` with a business error.

```bash
curl -sS http://localhost:8787/jobs/{confirmShippingJobId}/fail \
  -H 'Authorization: Bearer <workspace-default-worker-token>' \
  -H 'Content-Type: application/json' \
  -d '{ "lockToken": "{lockToken}", "reason": "carrier rejected", "errorCode": "SHIPPING_REJECTED" }'
```

> Note: the `errorCode` alone makes this a business failure. A `retryable` field is accepted but
> **advisory/ignored server-side** — terminality is decided only by `errorCode` (business) or
> retry-budget exhaustion (technical); see the runtime contracts.

Expected outcome:

- The modeled error boundary routes the token to the cancel end event; the instance status becomes
  `compensating` (`transactionCancelled` recorded).
- Compensation jobs are dispatched in **reverse completion order**: `refund-card` (undo charge)
  **before** `release-stock` (undo reserve).
- Each compensation activate returns `isCompensation: true`, the forward step's `originalInput`, and
  its `capturedOutput`.
- After both compensators complete, the instance status becomes `compensated`, the cancel boundary
  takes the `SagaFailed` path, and the instance settles to the saga-failed terminal state — status
  stays `compensated`, never clobbered to `completed`.

## Scenario 3: Compensator Fails → compensationFailed → Operator Retry Resumes (gate: compensator-fail-remediation)

Force `refund-card`'s compensation to fail until its retries are exhausted.

Expected outcome:

- The instance status becomes `compensationFailed`; a `compensationFailed` history event and an
  incident (`kind=compensationFailure`) are recorded; the reverse pass **stops** at `refund-card`,
  leaving `release-stock` still pending.
- An operator discovers and resumes it:

```bash
curl -sS 'http://localhost:8787/instances?workspaceId=default&status=compensationFailed'
curl -sS -X POST http://localhost:8787/instances/{instanceId}/retry
```

- `retry` resets the failed compensation job and returns the instance to `compensating` (the one
  resumable transition).
- When the previously-failed compensator now succeeds, the reverse pass continues and the instance
  reaches `compensated`.

## Scenario 4: Duplicate Complete AND Duplicate Fail Each Advance At Most Once (gate: duplicate-callback-idempotency)

Send `complete` twice for one forward job with the same `lockToken`; separately send `fail` twice
for another job.

Expected outcome:

- The second `complete` returns the stable prior outcome; the instance does not advance a second
  time (Workflow step memoization).
- The second `fail` returns the prior outcome and does **not** re-count the attempt (forward
  `workerCallback` keyed by `jobId + lockToken`).
- A worker holding a stale `lockToken` (its lease expired and the job was re-leased) matches zero
  rows on `complete` and is rejected without advancing.

## Scenario 5: Late Callback to a Terminal Instance → 200 No-op Ack (gate: terminal-instance-noop-ack)

Drive an instance to a terminal state, then deliver a late `complete`/`fail` for one of its jobs.

Expected outcome:

- The API gates on D1, finds the instance terminal, and returns a **200 no-op acknowledgement**.
- `sendEvent` is never attempted against the not-running instance; no `500` is raised and the
  at-least-once worker is not wedged in a permastuck retry loop.

## Scenario 6: Cross-Tenant Activate Rejected (gate: cross-tenant-activate-reject)

Using a worker credential scoped to workspace A, activate a `taskType` whose only jobs belong to
workspace B.

```bash
curl -sS http://localhost:8787/jobs/activate \
  -H 'Authorization: Bearer <workspace-A-worker-token>' \
  -H 'Content-Type: application/json' \
  -d '{ "taskType": "reserve-stock", "workerId": "a-svc", "workspaceId": "B" }'
```

Expected outcome:

- Zero jobs returned; no workspace B payload is exposed.
- The forged body `workspaceId: "B"` is ignored; access is evaluated against the credential-derived
  workspace (A) only.
- A missing or revoked credential is rejected as unauthorized.

## Scenario 7: v1 Instance Mid-Saga Compensates via v1's Graph After v2 Publishes (gate: version-binding-during-compensation)

Start an instance on v1, complete one forward step, publish v2 with different compensation
associations, then trigger cancellation on the v1 instance.

```bash
curl -sS -X POST http://localhost:8787/instances/{v1InstanceId}/cancel
```

Expected outcome:

- The running instance remains bound to v1; v2 does not affect it.
- The reverse pass uses **v1's** compensation handlers and `taskType`s.
- History and the saga view reference only the v1 definition version.

## Scenario 8: Un-leasable Job → DLQ Timeout (gate: unleasable-job-dlq-timeout)

Start an instance whose first Service Task `taskType` no worker ever polls. The job is created with
`activation_expires_at = created_at + 15 min` and a per-job `JobScheduler` Durable Object alarm is
armed. At expiry the alarm re-reads D1 and, the job still un-leased, terminates it.

Expected outcome:

- The instance settles to a **terminal incident** with `kind=timeout`; a `jobActivationExpired`
  history event is written and the reason is specific (`un-leasable`), **not** the
  `process-workflow` catch-all `Workflow terminated:`.
- A job that was **leased before** `activation_expires_at` is **not** timed out (the alarm no-ops).
- The DLQ never compensates.

## Scenario 9: Poison Job → Terminal `kind=poison` (no compensation) (gate: poison-job-termination)

A worker repeatedly **completes** with output that cannot be applied — here a ~0.6 MiB output that,
merged with ~0.6 MiB of instance variables, breaches the ~1 MiB event-payload limit.

Expected outcome:

- The job is re-opened up to `POISON_THRESHOLD = 3` strikes, then terminates with a **distinct**
  `kind=poison` + a `poisonJob` history event.
- The instance does **NOT** enter `compensating` and **no** compensation jobs are created (poison is
  distinct from a business-error → cancel, the only compensating path).

---

The M2 scenarios below use the shipped sample model
`examples/conditional-fulfillment-saga.bpmn` (XOR split/join + a loop + compensation wiring) or its
test-fixture siblings (`tests/helpers.ts`: `SAGA_XOR_BPMN`, `SAGA_XOR_NODEFAULT_BPMN`,
`SAGA_LOOP_BPMN`, `LOOP_XOR_BPMN`). The sample itself is publish-validated from disk by
`tests/integration/sample-conditional-saga.test.ts`.

## Scenario 10: Branch by Data (gate: branch-by-data — `tests/integration/xor-gateway.test.ts`)

Publish the sample and start an instance; complete `reserve-item` with
`{ "moreItems": false, "paymentMethod": "card" }`.

```bash
curl -sS http://localhost:8787/definitions/drafts \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile xml examples/conditional-fulfillment-saga.bpmn \
        '{workspaceId: "default", name: "conditional saga", bpmnXml: $xml}')"
```

Expected outcome (tests: `"routes by data: evaluations recorded in document order…"`,
`"takes the default flow when no condition is true…"`,
`"multiple true conditions → the FIRST in document order wins…"`):

- The token leaves `GW_method` on `Flow_pay_card` (FEEL `paymentMethod = "card"`); a `paymentMethod`
  of anything else takes the gateway-owned `default` flow instead.
- A `gateway_decisions` row records the chosen flow + per-flow evaluations in **document order**
  (short-circuited at the first `true`); the `gatewayDecisionEvaluated` history event is the
  operator surface.
- The XOR join (`GW_paid`) is a pass-through decision; exactly one job exists, on the chosen branch.

## Scenario 11: Loop N Iterations, Then Compensate Each (gate: loop-compensation — `tests/integration/loop-compensation.test.ts`)

Complete `reserve-item` three times (worker output `moreItems: true` twice, then `false`), then fail
the post-loop step with its model business error (e.g. `FINALIZE_FAILED` on `SAGA_LOOP_BPMN`).

Expected outcome (test: `"3 iterations + business-failed finalize → 3 comp jobs in reverse seq
order…"`):

- Each iteration is its own occurrence-keyed job + `saga_steps` ledger row (occurrences 0..2).
- The error boundary → cancel end cancels the transaction; the reverse pass creates **one
  compensation job per iteration, highest occurrence first**, each seeded with **its own
  iteration's** `originalInput` + `capturedOutput`.
- `compensationStarted` AND `compensationCompleted` history events carry the iteration's
  `occurrence`; the instance settles `compensated` via the cancel-boundary path.

## Scenario 12: No Path → `noPath` Incident, Hazard `/cancel` (gate: nopath-hazard — `tests/integration/xor-gateway.test.ts`)

Publish `SAGA_XOR_NODEFAULT_BPMN` (both gateway flows carry conditions, no default) and start an
instance whose variables match **neither** condition.

Expected outcome (tests: `"no condition true + no default → noPath incident…"`, `"operator /retry
with a variable patch re-evaluates the failed visit FRESH…"`):

- The gateway visit raises a **terminal incident `kind=noPath`** (the recorded evaluations in the
  diagnostics); inside the transaction this is a **Hazard** — NO auto-compensation.
- `POST /instances/{id}/cancel` then compensates the pending ledger (the operator remediation).
- Alternatively `POST /instances/{id}/retry` re-evaluates the failed visit **fresh** (no decision
  row was written for the failed visit), so a variable patch can route the saga forward.

## Scenario 13: Loop Limit → `loopLimit` Incident (gate: loop-limit — `tests/integration/loop-limit.test.ts`)

Drive a model into a hot cycle (the `f_spin` self-loop in `SAGA_LOOP_BPMN` / `LOOP_XOR_BPMN`'s
gateway cycle) past `MAX_ELEMENT_OCCURRENCES = 1000`.

Expected outcome (tests: `"loop guard — MAX_ELEMENT_OCCURRENCES trips a terminal loopLimit
incident"`, `"loop guard inside a transaction — Hazard semantics"`, `"technical retries do not
consume the cap"`):

- The walk terminates with incident `kind=loopLimit` naming the tripping element; inside a
  transaction this is Hazard semantics (no auto-compensation; operator `/cancel` available, and the
  incident resolution advances `compensating → compensated` when the pass settles).
- Technical retries of one iteration do **not** consume the visit cap (occurrence ≠ attempt).

## Scenario 14: Decision-Replay Stability (gate: decision-replay — `tests/integration/xor-gateway.test.ts`, `tests/integration/xor-replay-workflow.test.ts`, `tests/integration/loop-replay-workflow.test.ts`, `tests/integration/loop-rewalk.test.ts`)

Crash/resume an instance after a gateway decision committed, then mutate its variables and resume.

Expected outcome (tests: `"mutating variables between resumes never re-routes a recorded decision"`
(direct rewalk), `"crash after the decision committed (memo lost) + variables mutated → the replay
keeps the recorded branch"` (Workflow memoization), `"rewalk fast-forward is write-free…"`):

- A recorded `(instance, gateway, occurrence)` decision is **reused, never re-evaluated**, in BOTH
  execution modes — the walk is the replay.
- Rewalk fast-forward over applied steps is **write-free** (no duplicate jobs, history events, or
  variable merges); resuming mid-loop lands on the exact frontier occurrence.

## Validation Commands

```bash
npm run test:unit          # bpmn validator (saga + conditional accept/reject, FEEL parse/null semantics), graph scope, reverse-order ledger, retry backoff curve
npm run test:contract      # /jobs/* + operator verbs + list + saga view vs contracts/openapi.yaml; job-result union (incl. timeout/poison kind); lease SQL; the M2 /jobs/* schema pin (tests/contract/jobs-schema-pin.test.ts)
npm run test:integration   # the nine M1 gates + the five M2 gates above (D1 + DO + Workflow + pull workers)
npm run check:docs         # docs/bpmn/ consistency guard
npx wrangler deploy --dry-run
```

Expected validation outcome:

- The §3 canonical order-saga AND the conditional sample publish; each still-unsupported construct
  is rejected with element id + reason (deferred gateways with their milestone pointers);
  foreign-ns / DI / `documentation` are tolerated.
- The nine M1 integration gates pass: happy commit; business-error reverse compensation;
  compensator-fail remediation; duplicate complete/fail idempotency; terminal-instance no-op ack;
  cross-tenant activate reject; version binding through compensation; un-leasable-job DLQ timeout;
  poison-job termination.
- The five M2 gates pass: branch-by-data; loop-N-iterations-then-compensate-each; noPath Hazard +
  operator remediation; loopLimit guard; decision-replay stability.
- No external workflow infrastructure (Camunda/Zeebe/broker/cluster) is deployed.
