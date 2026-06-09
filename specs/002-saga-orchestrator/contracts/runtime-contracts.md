# Runtime Contracts: SAGA Orchestrator (M1 — Canonical transaction-saga)

These contracts extend `specs/001-bpmn-lite-orchestrator-mvp/contracts/runtime-contracts.md`. The
Process Workflow, Receive Task, Correlation Broker, and D1 Persistence contracts from the MVP carry
forward unchanged; this document specifies the new pull-worker, compensation, idempotency, and
saga-settlement contracts.

## Process Workflow Contract (delta)

Each BPMN process instance still maps to exactly one Cloudflare Workflow instance, bound to one
definition version for life. Two changes:

- A Service Task is now a durable **async wait** (a per-job `step.waitForEvent`), not a synchronous
  in-process call.
- The Workflow drives a **scope-aware** interpreter: entering a `transaction` pushes a scope frame;
  a cancel end event or error-boundary→cancel runs the compensation pass before taking the
  transaction's cancel-boundary outgoing flow.

**Rules**:
- Retries are driven by **re-lease**, so there is **one** `waitForEvent` per logical job (flat step
  budget), with a timeout `>= retries × (leaseMs + maxBackoff)`. Only the first event consumed wins
  (Workflow step memoization).
- A per-job `waitForEvent` timeout MUST be caught **inside the engine** and routed to the
  technical-failure branch; it MUST NOT reach the `process-workflow.ts` catch-all (which would turn
  a task-level timeout into a terminal incident, bypassing compensation).
- The API MUST NOT leak Workflow internals: no `workflowInstanceId` is required from worker or
  operator callers.

## Pull Worker Contract (forward + compensation share the lane)

A worker leases jobs by `taskType`, runs, then completes or fails with its `lockToken`. Forward and
compensation jobs share one lane; `isCompensation` distinguishes them.

### Job-result discriminated union (`src/contracts/workflow-events.ts`)

The resume payload delivered to the Workflow `waitForEvent` is a discriminated union:

```ts
type JobResult =
  | { outcome: "completed"; output: Record<string, unknown> }
  | { outcome: "failed"; retryable: boolean; errorCode?: string; kind?: "timeout" | "poison"; reason: string };
```

`kind` classifies a runtime-synthesized failure edge: `timeout` = un-leasable-job DLQ (§Failure
Taxonomy), `poison` = un-applicable output. Both terminate with the matching incident kind and
**never compensate** (only a matching `errorCode` does).

### Per-job Workflow event type

- Each logical job waits on event type `bpmn_job_<jobId>`, routed through a
  `workflowEventTypeFor`-style sanitizer: **dot-free**, **≤100 chars**, sanitized (Cloudflare
  Workflows event types forbid dots).

### Activate request → response

```json
// POST /jobs/activate   (Authorization: Bearer <worker credential>)
{ "taskType": "reserve-stock", "workerId": "stock-svc-7", "maxJobs": 5, "leaseMs": 30000, "waitMs": 20000 }
```
```json
{
  "jobs": [
    {
      "jobId": "job_123",
      "instanceId": "pi_123",
      "elementId": "reserveStock",
      "taskType": "reserve-stock",
      "isCompensation": false,
      "attempt": 1,
      "lockToken": "lt_abc",
      "traceId": "trace_pi_123",
      "variables": { "amount": 42 }
    }
  ]
}
```

For a **compensation** job (`isCompensation: true`), the payload additionally carries
`originalInput` (the forward step's captured input) and `capturedOutput` (its captured output), and
`elementId` is the **forward** element id being compensated.

### Atomic lease (D1-verified)

`POST /jobs/activate` claims jobs with the IN-subquery form, the lease guard in **both** the
subquery and the outer `WHERE` (D1 does **not** parse `UPDATE … LIMIT … RETURNING`, code 7500;
D1's single-writer serializes activates so two cannot double-claim):

```sql
UPDATE service_task_jobs
   SET worker_id=?, lock_token=?, lock_expires_at=:leaseUntil, status='locked'
 WHERE job_id IN (
   SELECT job_id FROM service_task_jobs
    WHERE task_type=:t
      AND (status='created' OR (status='locked' AND lock_expires_at < :now))
    ORDER BY created_at LIMIT :n)
   AND (status='created' OR (status='locked' AND lock_expires_at < :now))
RETURNING job_id, instance_id, element_id, is_compensation, attempt_count, input_variables;
```

A per-`taskType` Durable Object is **not** required for M1.

### Complete / fail (lock_token-conditional)

```json
// POST /jobs/{jobId}/complete
{ "lockToken": "lt_abc", "outputVariables": { "reservationId": "r-9" } }
```
```json
// POST /jobs/{jobId}/fail
{ "lockToken": "lt_abc", "reason": "shipping carrier rejected", "errorCode": "SHIPPING_REJECTED", "retryable": false }
```

`complete`/`fail` are `lock_token`-conditional updates (`… WHERE job_id=? AND lock_token=?`) that
rotate/clear the token:

- A **stale** worker (expired lease, job re-leased elsewhere) matches **0 rows** → rejected; its
  forward effect already happened, so the surviving completion's `capturedOutput` is the
  compensation basis.
- A **duplicate** worker (same token re-sent) matches 0 rows → returns the **stable prior outcome**;
  the instance does not advance twice.

**Rules**:
- **Forward workers are at-least-once too.** Lease expiry can run a step twice; therefore forward
  workers MUST be idempotent on `jobId` (the same requirement as compensators).
- Job state is persisted (`created`) and made leasable before any external interaction
  (persist-before-advance); dispatch makes no outbound call.
- On `complete`, the worker output, the `saga_steps` ledger row (for a compensatable step), and the
  transition are written in the **same `dbBatch`** (extend persist-before-advance to include the
  ledger), then `sendEvent(bpmn_job_<jobId>)` is delivered if the instance is live.
- Every activate/complete/fail writes a `WorkerAttempt` and a `HistoryEvent` (`jobActivated`,
  `jobCompleted`, `jobFailed`) with the `traceId`.

## Failure Taxonomy

- **Technical failure** — `fail retryable=true` / no `errorCode`, or a lease-expiry reclaim: the job
  is **parked behind an exponential-with-full-jitter backoff** (`status='locked'`, `lock_token=NULL`,
  `lock_expires_at = now + computeBackoffMs(attempt)`), so the activate gate re-leases it only after
  the delay — reusing the lease gate without a new column, and **distinct from the lease duration**
  (`leaseMs` bounds one in-flight attempt; backoff spaces attempts apart). A **lease-expiry reclaim**
  (a held lock that lapsed, i.e. a crashed/slow worker) is parked the same way by the activate
  reclaim pre-pass before it can be re-handed (so reclaims are spaced, not instant). Counts against
  `retries` via the explicit `/jobs/fail` path. (Terminating a job that exhausts its budget purely
  through repeated lease-expiry — never an explicit `/jobs/fail` — is a per-step timeout, deferred to
  **M3**; M1 only spaces such reclaims.)
  Defaults (`src/runtime/retry-policy.ts`): **`baseMs=1000`, `factor=2`, `maxBackoffMs=30_000`**;
  `computeBackoffMs(n) = round(rand() · min(maxBackoffMs, baseMs·factor^(n-1)))`. Exhaustion
  **inside** a transaction is a **Hazard** → terminal incident (`kind=serviceTaskFailure`); an
  operator may `POST /instances/{id}/cancel` to force compensation. Outside a transaction, exhaustion
  → terminal incident (MVP behavior).
- **Un-leasable job (DLQ)** — a forward job nobody leases within **`ACTIVATION_TTL_MS = 15 min`**
  (`activation_expires_at = created_at + ACTIVATION_TTL_MS`, the lone M1 job-level timer). A per-job
  `JobScheduler` Durable Object alarm armed at job creation fires at expiry, re-reads D1, and if the
  job is still un-leased (`status='created' AND attempt_count=0`) routes a synthetic
  `{ outcome:'failed', retryable:false, kind:'timeout', reason:'un-leasable' }` → terminal incident
  `kind=timeout` + a `jobActivationExpired` history event. A progressed/late/duplicate alarm is an
  idempotent no-op. **Never** compensates.
- **Poison job** — a worker that **completes** with output that cannot be applied (the MERGE into
  instance variables would breach the ~1 MiB event-payload limit) is re-opened up to
  **`POISON_THRESHOLD = 3`** strikes, then terminates with a **distinct** `kind=poison` + a
  `poisonJob` history event. The strike counter is the number of un-applicable **completions**
  (counted from `serviceTaskOutputRejected` history), **not** `attempt_count` — a technical retry
  does not consume the poison budget. (Those strike rows persist across an operator `/retry`, so a
  retry does not grant a fresh poison budget.) The instance does **NOT** enter `compensating` and
  **no** compensation jobs are created.
- **Business error** — `fail` with an `errorCode` matching a model `bpmn:error/@errorCode`: not
  retried; raises that BPMN error → caught by the matching error boundary (`errorRef →
  bpmn:error/@id`) → routed to the cancel end event → transaction cancels → compensation.

`errorRef`/boundary catching is by the Error's **`@id`** (QName); the worker's `fail.errorCode`
matches the Error's **`@errorCode`** (wire value). Richer error catalogs and per-error routing beyond
cancel are M3.

## Compensation Contract

On transaction cancellation the runtime runs the reverse pass:

1. Select the scope's ledger rows in **descending `seq`** with `compensation_status IN
   ('pending','compensating','failed')`.
2. For each row with a compensation handler, create/reuse a **compensation job** (shared lane,
   `is_compensation=1`, `compensates_element_id` = the forward element id) seeded with
   `originalInput` + `capturedOutput`; wait for its callback via the same pull mechanism. A row
   already `compensating` **re-attaches** to its existing `compensation_job_id` (never a second comp
   job) — the replay-recovery rule.
3. **Idempotent + at-least-once:** each compensation job has idempotency key (`scope='compensate'`,
   `instanceId:elementId:compensate`); duplicate callbacks return the stable prior outcome.
4. Runs **sequentially in reverse** in M1 (parallel-branch compensation is M4). A handler that fails
   retries per its own `retries`; on exhaustion → `compensation_status='failed'`, instance status
   `compensationFailed`, history `compensationFailed`, operator alert; the reverse pass **stops** at
   the failed step (the already-compensated suffix stays compensated).
5. On full success → instance status `compensated`, then follow the cancel-boundary outgoing flow to
   the saga-failed end event, settling to a saga-failed terminal state **without** calling the normal
   completion routine.

### Compensation job payload (delta over forward)

```json
{
  "jobId": "job_456",
  "instanceId": "pi_123",
  "elementId": "chargeCard",
  "taskType": "refund-card",
  "isCompensation": true,
  "attempt": 1,
  "lockToken": "lt_def",
  "traceId": "trace_pi_123",
  "originalInput": { "amount": 42 },
  "capturedOutput": { "chargeId": "ch_77" }
}
```

**Rules**:
- Compensation is triggered **only** by transaction Cancel (error boundary → cancel end, or operator
  `cancel`), never by an uncaught Error (Hazard terminates and propagates).
- Compensators MUST be idempotent on `jobId`; the captured output is authoritative even if a stale
  lease ran the forward step twice.

## Idempotency & Terminal-Instance Contract

- `idempotency_records.scope` gains `compensate`; forward `complete`/`fail` use scope
  `workerCallback` keyed by `jobId + lockToken` so a duplicate `fail` returns the prior outcome
  instead of re-counting an attempt.
- The **single-advance guarantee** is Cloudflare Workflow step memoization of the resume step; the
  HTTP-side `lock_token`-conditional update only suppresses a redundant `sendEvent`.
- **`sendEvent` to a terminal / not-running instance throws** → the API MUST gate on D1 first
  (terminal job/instance → ACK without sending) and wrap `sendEvent` so a "not running" / errored
  throw becomes a **200 no-op ack**, never a 500 (else at-least-once workers retry forever →
  permastuck).
- Operator verbs are guarded: `/cancel` is status-conditional (`SET status='compensating' WHERE
  status IN ('running','waiting')`); `/retry` is a conditional reset keyed on the current
  incident/failed status.

## Payload Contract (delta)

**Rules**:
- A `complete` output (or any message/worker payload) exceeding the Cloudflare Workflows ~1 MiB
  event limit is rejected (`assertPayloadWithinLimit`, `payload.ts`) **before** `sendEvent`, with a
  user-visible rejection naming the involved job/element.
- Large worker outputs ride an **R2 reference** (deliver only the reference in the event); keep
  `step.do` results small scalars to respect the ≤1 GB cumulative persisted-state-per-instance
  limit.

## Observability Contract

- A `traceId` (derived from `instanceId`) plus a per-step `spanId` are propagated into
  activate/complete/fail payloads and recorded in `history_events.diagnostics` and `saga_steps`.
- W3C `traceparent` passthrough is considered so worker-side APM can correlate.
- M1 metrics are named (per-`taskType` job latency, retry counts, compensation outcomes); full
  dashboards are deferred.
