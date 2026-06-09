# Quickstart: SAGA Orchestrator (M1) Validation

This guide describes the end-to-end validation scenarios for the M1 transaction-saga
implementation plan. It is written as the target validation flow for the implementation generated
from this feature. The seven scenarios are the named M1 constitution-critical test gates.

## Prerequisites

- Node.js 22+ (Wrangler 4.x requires Node ≥22)
- Wrangler installed through project dependencies
- Cloudflare local development support for Workers, Workflows, Durable Objects, and D1
- A Workers **Paid** plan target (Durable Objects force Paid; Workflow `limits.steps` headroom
  ~25000)

## Setup

```bash
npm install
npx wrangler d1 migrations apply easy_bpmn --local   # applies 0001 + 0002_saga.sql
npm run test
npm run dev
```

Expected setup outcome:

- Unit, contract, and integration tests pass (including the seven saga gates).
- Local Worker API is available at `http://localhost:8787`.
- Local D1 database has the MVP schema plus the saga ledger, jobs lease/DLQ columns, worker
  credentials, incident `kind`/`resolution`, and the `(workspace_id, status)` list index.
- Workflow and Durable Object bindings are available in local development.

## Scenario 1: Happy Saga Commits (gate: happy-saga-commit)

1. Publish the §3 canonical order-saga (a `bpmn:transaction` with three forward Service Tasks each
   routed by `easy-bpmn:taskDefinition type` to a distinct microservice).

```bash
curl -sS http://localhost:8787/definitions/drafts \
  -H 'Content-Type: application/json' \
  -d @examples/order-saga-draft.json
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
  -d '{ "lockToken": "{lockToken}", "reason": "carrier rejected", "errorCode": "SHIPPING_REJECTED", "retryable": false }'
```

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

## Validation Commands

```bash
npm run test:unit          # bpmn validator (saga accept/reject), graph scope, reverse-order ledger, retry backoff curve
npm run test:contract      # /jobs/* + operator verbs + list + saga view vs contracts/openapi.yaml; job-result union (incl. timeout/poison kind); lease SQL
npm run test:integration   # the nine saga gates above (D1 + DO + Workflow + pull workers)
npx wrangler deploy --dry-run
```

Expected validation outcome:

- The §3 canonical order-saga publishes; each still-unsupported construct is rejected with element
  id + reason; foreign-ns / DI / `documentation` are tolerated.
- The nine integration gates pass: happy commit; business-error reverse compensation;
  compensator-fail remediation; duplicate complete/fail idempotency; terminal-instance no-op ack;
  cross-tenant activate reject; version binding through compensation; un-leasable-job DLQ timeout;
  poison-job termination.
- No external workflow infrastructure (Camunda/Zeebe/broker/cluster) is deployed.
