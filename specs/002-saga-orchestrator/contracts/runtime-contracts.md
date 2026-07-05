# Runtime Contracts: SAGA Orchestrator (M1 — Canonical transaction-saga; M2 — Conditional sagas; M3 — Time & failure taxonomy; M4 — Concurrency; M5-L2 — Call activity)

These contracts extend `specs/001-bpmn-lite-orchestrator-mvp/contracts/runtime-contracts.md`. The
Process Workflow, Receive Task, Correlation Broker, and D1 Persistence contracts from the MVP carry
forward unchanged; this document specifies the new pull-worker, compensation, idempotency, and
saga-settlement contracts, plus the M2 conditional-dispatch contract (gateways + occurrence-keyed
loops), the M3 timer/race-decider/failure-taxonomy contract, the M4 concurrency contract (the token
frontier, AND/OR joins, R2 overlay offload, the two new incident kinds, and per-token observability),
and the M5-L2 call-activity contract (the child sub-saga lifecycle, the `errored` child terminal, the
child→parent wake, child compensation, and the cascading drain/retry) at the end.

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
{ "lockToken": "lt_abc", "reason": "shipping carrier rejected", "errorCode": "SHIPPING_REJECTED" }
```

> **`retryable` is HONORED server-side (M3, TASK-40).** For a technical failure (no `errorCode`):
> omitted/`true` → normal backoff retry until the budget (`attempt_count < retries`) exhausts;
> `false` → **immediate exhaustion** — the worker declares the failure permanent, so remaining
> technical retries are skipped and the job goes straight to the terminal exhaustion path. It is
> ignored when `errorCode` is present (a business failure is never retried). **Behavior change:** a
> worker already sending `retryable=false` (legal and ignored before M3) now short-circuits its
> remaining retries instead of being re-leased — called out in the openapi delta / release note.

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

- **Technical failure** — a `fail` with **no `errorCode`** and `retryable` omitted/`true` (see
  above), or a lease-expiry reclaim with retries remaining: the job
  is **parked behind an exponential-with-full-jitter backoff** (`status='locked'`, `lock_token=NULL`,
  `lock_expires_at = now + computeBackoffMs(attempt)`), so the activate gate re-leases it only after
  the delay — reusing the lease gate without a new column, and **distinct from the lease duration**
  (`leaseMs` bounds one in-flight attempt; backoff spaces attempts apart). A **lease-expiry reclaim**
  (a held lock that lapsed, i.e. a crashed/slow worker) is parked the same way by the activate
  reclaim pre-pass before it can be re-handed (so reclaims are spaced, not instant), each re-lease
  counting against `retries`. **Exhaustion routes to the terminal exhaustion path regardless of how
  the budget was spent** (M3, TASK-40): an explicit `/jobs/fail` (or one with `retryable=false`,
  which exhausts immediately) AND a pure lease-expiry reclaim that reaches `attempt_count >= retries`
  both terminate via the same path — the reclaim pre-pass flips the lapsed lease to `failed` (guarded
  on the lapsed-lease predicate, no worker token) and delivers `{outcome:'failed', errorCode:null}`,
  so a job exhausted purely through lease expiry no longer retries forever.
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
  `kind=jobActivationTimeout` + a `jobActivationExpired` history event. A progressed/late/duplicate alarm is an
  idempotent no-op. **Never** compensates.
- **Poison job** — a worker that **completes** with output that cannot be applied (the MERGE into
  instance variables would breach the ~1 MiB event-payload limit) is re-opened up to
  **`POISON_THRESHOLD = 3`** strikes, then terminates with a **distinct** `kind=poison` + a
  `poisonJob` history event. The strike counter is the number of un-applicable **completions**
  (counted from `serviceTaskOutputRejected` history), **not** `attempt_count` — a technical retry
  does not consume the poison budget. (Those strike rows persist across an operator `/retry`, so a
  retry does not grant a fresh poison budget.) The instance does **NOT** enter `compensating` and
  **no** compensation jobs are created.
- **Business error** — `fail` with an `errorCode`: not retried; raises that BPMN error → matched
  against the activity's interrupting error boundaries by **exact `@errorCode`** → else a catch-all
  boundary → else **Hazard**. The matched boundary's outgoing flow routes the token to any token-path
  node in the scope (M3 free routing; routing to a cancel end event triggers the transaction's
  cancel → compensation, the canonical M1 shape). See the M3 Timer/Race-Decider/Failure-Taxonomy
  contract below.
- **Un-guarded wait liveness / hard condition error** — under M4 single-wake (TASK-54) un-guarded
  waits follow **standard BPMN**: a receive-task / message intermediate catch carrying **no modeled
  deadline** waits **indefinitely** (no deadline ⇒ no timeout), and un-guarded **service-task**
  liveness comes from the job-activation DLQ (**`kind=jobActivationTimeout`**), not an engine wait
  cap. The M3 leaf **`waitTimeout`** cap is therefore **retired and now unproduced** (kept as a
  vestigial enum value until the dead-code sweep). A hard FEEL evaluation error raises
  **`kind=conditionFailure`**.

`errorRef`/boundary catching is by the Error's **`@id`** (QName); the worker's `fail.errorCode`
matches the Error's **`@errorCode`** (wire value). Multi-boundary + catch-all routing and richer
incident kinds shipped in M3 (Constitution v2.2.0).

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

## Conditional Dispatch Contract (M2 — exclusiveGateway + FEEL + occurrence-keyed loops)

Design: `docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md`. Constitution v2.1.0.

**The `/jobs/*` worker surface is UNCHANGED.** Forward and compensation workers see exactly the M1
request/response shapes; `occurrence` / `output_applied` never leak into the leased-job payload.
Pinned by `tests/contract/jobs-schema-pin.test.ts` — widening the surface later must amend that pin
deliberately.

**Rules**:

- **The walk is the replay.** The engine re-walks the graph from the start element on every
  resume (both execution modes), counting visits per element id in memory (**occurrence**), and
  fast-forwards through already-applied steps using canonical D1 state. Every Workflow step name
  and persistence key carries the occurrence (`svc-create:el#2`, `wait-job:el#2`, `msg:el#1`,
  `gw:el#0`); applied steps (`output_applied=1`) are **write-free** fast-forward.
- **Gateway dispatch** (one persisted step per visit): an existing `gateway_decisions` row for
  `(instance, gateway, occurrence)` is taken as-is (never re-evaluated). Otherwise: read variables
  from D1 → evaluate non-default outgoing FEEL conditions in **document order** (`feelin`; a
  missing variable makes a comparison `null` → not taken, no error) → first boolean `true` wins →
  else the `default` flow → else terminal incident **`kind=noPath`**. The decision row + transition
  + `gatewayDecisionEvaluated` history event commit in **one `dbBatch`** (persist-before-advance).
- **`gatewayDecisionEvaluated` diagnostics**: `{ chosenFlowId, occurrence, isDefault, evaluations
  [{flowId, expression, result, value, warnings?}], passThrough?, variablesSnapshotOmitted?,
  variablesByteSize? }`. The decision row's `variables_snapshot` is capped by the event-payload
  limit — an oversized context is omitted (`NULL` + the `variablesSnapshotOmitted: true` flag),
  never an error.
- **Failed visits write no decision row** (`noPath`, hard FEEL evaluation error): operator `/retry`
  re-evaluates that visit **fresh**, so a variable patch can re-route it. A recorded (successful)
  decision is permanent for its occurrence.
- **Hazard semantics in a transaction**: `noPath` and `loopLimit` terminate WITHOUT
  auto-compensation; operator `/cancel` compensates the pending ledger (incident resolution
  `open → compensating → compensated`).
- **Loop guard**: a walk-local visit counter exceeding `MAX_ELEMENT_OCCURRENCES = 1000` → terminal
  incident **`kind=loopLimit`** naming the tripping element. Occurrence ≠ attempt: technical
  retries of one iteration never consume the visit cap.
- **Compensation across iterations**: each completed compensatable pass is its own occurrence-keyed
  ledger row; the reverse pass compensates every iteration separately (highest `seq` first), each
  compensation job inheriting its forward occurrence and seeded with **its own** iteration's
  `originalInput` + `capturedOutput`. `compensationStarted`/`compensationCompleted` carry the
  `occurrence` in diagnostics.

## Timer, Race-Decider & Failure-Taxonomy Contract (M3 — timers + eventBasedGateway + error routing)

Design: `docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md`. Constitution v2.2.0.

**The `/jobs/*` worker surface is UNCHANGED** (still pinned by `tests/contract/jobs-schema-pin.test.ts`);
the only behavior change on the surface is that **`retryable` is now honored** (see Failure
Taxonomy). Model timers, `eventBasedGateway`, intermediate catch events, and free error routing are
all standard BPMN — no new extension binding.

**Rules**:

- **Arming (persist-before-advance).** A timer row is written `INSERT OR IGNORE` in the **same
  `dbBatch`** as the wait it guards (the `svc-create` job batch, the subscription-registration
  batch, or the catch/EBG park batch), paired with the `timerArmed` history row on first arm only;
  `fire_at` is computed once in code (`timeDate` as-is; `now + timeDuration`) and snapshotted. A
  rewalk revisiting an `armed` row is a write-free re-park that idempotently re-arms the DO alarm
  (self-healing).
- **One deciding row per race, plain-INSERT, in the transition batch.** Boundary / intermediate-catch
  timers decide on a `timer_outcomes` row; `eventBasedGateway` timers decide on `gateway_decisions`
  (no `timer_outcomes` row). The decider is a **plain `INSERT`** (never `INSERT OR IGNORE`) composed
  into the same `dbBatch` as the loser-visible transition, so a losing contender's **whole batch
  aborts** on the unique-constraint violation and converts to the recorded outcome. This is the
  normative `src/persistence/gateway-decisions.ts` contract; it holds in **both** execution modes
  (Workflow first-event-wins memoization is a second guard, not the primary one).
- **Fire** (`alarm → fireTimer(timerId)`): re-read D1 → no-op unless the instance is non-terminal,
  the row is `armed` with `fire_at <= now`, **and** the timer's visit is still the instance's current
  wait. Then one batch = the decider claim (`fired`) + `status → fired` + abandon the in-flight job /
  supersede the active subscription (status-conditional; a late worker `complete`/`fail` or publish
  gets the stable superseded/buffered no-op) + `timerFired` history + the transition out of the wait.
  A fired model timer is **never** an incident.
- **Every abnormal exit settles the timer.** Normal completion, error-boundary route, retry
  exhaustion, and operator `/cancel` each carry a plain `INSERT … 'cancelled'` decider + the
  `armed → cancelled` flip, so a stray alarm afterwards no-ops (no mid-compensation firing). DO
  disarm is best-effort.
- **`eventBasedGateway` decides on `gateway_decisions`.** Token arrival registers occurrence-keyed
  subscriptions for every message branch + a timer row for the timer branch (best-effort broker
  registrations after the batch, re-registered idempotently on rewalk). Each EBG-branch subscription
  stores the **gateway visit's** wake event type in the existing
  `message_subscriptions.workflow_event_type` column — the delivery path **honors the stored value**
  instead of re-deriving it from the message name (the symmetry contract is relaxed for EBG
  subscriptions). Message wins / timer wins / early-buffered-message-at-registration / two buffered
  branches (model-document-order first hit) are all replay-stable via the single decision row.
- **Free error routing.** An activity may carry multiple interrupting error boundaries with
  **distinct, non-empty `@errorCode`s** plus at most one catch-all (`errorEventDefinition` without
  `errorRef`). Matching on a worker `fail` with `errorCode`: exact `@errorCode` → catch-all →
  (no match) **Hazard** (Constitution VI untouched). The boundary's outgoing flow targets any
  token-path node in the same scope (the M1 "must target a cancel end" rule is lifted). An error
  handled by an alternate path inside a transaction leaves the saga ledger untouched — all completed
  steps stay compensatable until the scope cancels or commits.
- **Modeled-timer wait.** A wait guarded by an armed modeled timer never raises `waitTimeout`;
  in Workflow mode its `waitForEvent` timeout is sized to `fire_at` (a 7-day timer costs O(1) steps)
  and doubles as the lost-alarm backstop — on any wake the engine settles overdue timers
  (`fire_at <= now`) exactly as the alarm would. Un-guarded waits carry **no** engine wait cap: under
  M4 single-wake a receive-task / message-catch wait is **indefinite** (standard BPMN), and un-guarded
  service-task liveness is the DLQ `jobActivationTimeout` — the M3 `waitTimeout` cap is
  retired/unproduced.

## Concurrency Contract (M4 — token frontier + AND/OR joins + branch-local vars)

Design: `docs/superpowers/specs/2026-06-13-m4-concurrency-design.md` (§5/§6/§9/§11). Constitution v2.3.0.
A block-structured (SESE) `parallelGateway` (AND) / `inclusiveGateway` (OR) region runs as a **token
frontier** — multiple concurrent tokens within one Cloudflare Workflow instance. **The `/jobs/*` worker
surface is UNCHANGED** (still pinned by `tests/contract/jobs-schema-pin.test.ts`).

### `GET /instances/{id}` tokens array

`GET /instances/{id}` gains a **`tokens`** array, read from `execution_tokens` (D1, never Workflow state),
present when the instance has materialised token rows; single-token (M1–M3) instances with no token rows
**omit** it. `currentElementId` is retained as the sole live token's position when the frontier has exactly
one token and is **null while >1 token is live** (the `tokens` array is then authoritative). Each item:

```json
{
  "tokenId": "pi_123:fork#0:f1",
  "positionElementId": "reserveStock",
  "status": "waiting",
  "regionId": "fork",
  "regionActivation": 0,
  "branchFlowId": "f1",
  "parentTokenId": "pi_123:#root",
  "variablesOverlay": { "reservationId": "r-9" }
}
```

- `tokenId` — deterministic id: `instanceId:#root` (root) or `instanceId:splitId#activation:branchFlowId`
  (branch).
- `status` — read-model from `execution_tokens`: `active | waiting | arrivedAtJoin | consumed | merged |
  discarded` (live = `active|waiting|arrivedAtJoin`).
- `regionId` / `branchFlowId` / `parentTokenId` — **null** for the root token; `parentTokenId` is
  `instanceId:#root` for a first-level branch token.
- `regionActivation` — the owning split's 0-based occurrence.
- `variablesOverlay` — **always present** (`{}` when the token carries no branch-local delta); the
  column verbatim — an inline JSON object **or** `{"__r2":"<key>"}` for an R2-offloaded large overlay.
  It is **not** rehydrated by the API (the caller follows the R2 reference if needed). The contract
  schema marks it optional, but the inspection endpoint emits it on every token.

`contracts/openapi.yaml` (`TokenView`) and the contract test are kept in lockstep (governance gate).

### New incident kinds (extend the Failure Taxonomy)

Both are **terminal** and added to the `IncidentKind` union (`src/persistence/instances.ts`) **and** the
openapi `Incident.kind` enum simultaneously (`check:docs` guard #7 enforces equality):

- **`concurrencyLimit`** — a split fan-out would exceed `MAX_CONCURRENT_TOKENS = 256` **live**
  (`active|waiting|arrivedAtJoin`) tokens. Counted from the **in-memory reconstructed frontier** during the
  deterministic rewalk (never a live `COUNT` over `execution_tokens`, else it would fire nondeterministically
  on replay); evaluated at each fan-out and claimed once.
- **`stepBudget`** — a per-drive cumulative `runStep`/`waitForEvent` counter crossed
  `STEP_BUDGET_SOFT = 20000`, a **graceful** terminal incident **below** the platform
  `limits.steps = 25000` ceiling (hitting the platform ceiling would produce an opaque errored Workflow,
  violating the view-only-incident invariant). Forward steps of all live tokens, in-region loops, and the
  reverse pass must jointly fit under the three caps (`MAX_CONCURRENT_TOKENS`, `MAX_ELEMENT_OCCURRENCES`,
  step budget).

Like other forward Hazards, neither auto-compensates: inside a transaction the live-token cohort is captured
(generalised cohort capture, design §8.5) so a late `complete` ledgers-but-does-not-advance, and an operator
`POST /instances/{id}/cancel` forces the reverse pass.

- **`scopeReentry`** (M5-L1 follow-up, TASK-71) — the deterministic runtime backstop for a re-descend into a
  scope whose earlier occurrence was **abnormally skipped** (a fired scope-hosted boundary timer, or a nested
  cancelled transaction). Both skips fast-forward past the container **without descending its interior**, so
  re-entering it would restart the interior occurrence namespace and collide with the skipped occurrence's
  persisted rows (a silent desync). The publish-time C1 check rejects **unguarded** re-entry statically; a
  **condition-guarded** loop-back it cannot prove unreachable is caught here. The engine carries a walk-local
  `skippedScopes` set (rebuilt every rewalk from the D1 deciders — `timer_outcomes` fired / `transactionCancelled`
  markers — so it is replay-stable, never derived from surviving in-memory state) and raises the incident at
  scope descend. Terminal + view-only; true re-entry support is deferred to a later M5 layer.

### Variable overlays & the R2 offload

- A token's `variables_overlay` (and the resolved scope chain) live in **D1** (`execution_tokens`), out of
  Workflow `step.do` outputs — payloads crossing the event channel stay **small envelopes** (`messageId`,
  `correlationKey`, a D1/R2 reference); the engine resolves the body inside a `step.do`.
- An overlay whose serialized size exceeds **`OVERLAY_INLINE_MAX_BYTES`** (measured via `payloadByteSize`)
  is written to **R2** under the **deterministic** key `overlays/${instanceId}/${tokenId}.json`, **before**
  the D1 commit (the deterministic key makes a crash-retry byte-identical), and the column holds
  `{"__r2":"<key>"}`. (The R2 binding was introduced in L6; none existed before.)
- **Join-time bound.** At a join the **merged** overlay is checked against **`MAX_EVENT_PAYLOAD_BYTES`**
  (the ~1 MiB event limit) **before** it is written to `process_instances.variables` or delivered; on
  exceed it routes to the existing `serviceTaskOutputRejected` / **poison** incident path — **never** a
  silent truncation.

### Per-token observability & region history events

- History events emitted inside a region carry **`tokenId`**, **`regionId`**, **`regionActivation`**, and a
  per-token **`spanId`** in their `diagnostics` JSON — **no new column** (`history_events` stays globally
  ordered by insertion = deterministic single-threaded rewalk order). Clients reconstruct a per-branch
  timeline by filtering on `diagnostics.tokenId`; the join's merge event records the contributing branch
  token ids.
- Four new free-text `history_events.type` values: **`regionActivated`**, **`branchForked`**,
  **`branchArrivedAtJoin`**, **`joinCompleted`** (no schema change).

### Frontier-wide operator verbs

- **`/cancel` is frontier-wide:** it captures the live-token cohort, arms a per-token terminator for every
  in-flight job (§8.2 — it does **NOT** eagerly fail region-cohort jobs, so a late `complete` lands as a
  ledgered straggler rather than leaking an executed side-effect), cancels every armed timer, and
  **releases every active broker subscription** before entering `compensating` (no live subscription may
  survive a cancel, else the broker key leaks). The reverse pass then runs **per token lineage** in
  descending `seq`, draining stragglers, and settles `compensated` only when the scope ledger is drained
  **and** no scope token remains in a live status.
- **`/retry`** reconstructs the frontier from `execution_tokens` (fast-forwarding applied
  splits/joins/branch steps **write-free**) rather than re-forking any split; the
  `compensationFailed → compensating` edge resumes the reverse pass over the cohort.

## Call-Activity Contract (M5-L2 — reusable sub-sagas)

Design: `docs/superpowers/specs/2026-07-02-m5-l2-callactivity-design.md` (§2–§7). Constitution
**v2.5.0 unchanged** — the M5 amendment accepted the whole composition set up front; this layer only
opens the `callActivity` runtime (governance record:
`specs/002-saga-orchestrator/m5-L2-constitution-check.md`). **The `/jobs/*` worker surface is
UNCHANGED** (still pinned by `tests/contract/jobs-schema-pin.test.ts`) — a child step never creates a
job in either direction.

### Child-instance lifecycle (deterministic id + provenance-gated create/apply)

- **Each `callActivity` visit invokes a REAL child process instance** with its own Cloudflare
  Workflow, bound to the **publish-pinned** `calledDefinitionVersionId` (Principle II:
  `calledElement` resolves at the CALLER's publish to the latest **published** version of the target
  process in the same workspace, `src/bpmn/call-resolution.ts`, and is pinned immutably in the
  caller's stored graph; runtime "latest"/version binding is NOT honored —
  `camunda:calledElementBinding` / `camunda:calledElementVersion` are tolerated-and-ignored foreign
  extension content). Call-tree depth is capped at **`MAX_CALL_DEPTH = 4`** at publish (a validator
  reject over the immutable pinned-version DAG; **not** a runtime incident).
- **Deterministic child id.** The child instance id is `pi-` + the first 24 hex chars of the SHA-256
  of `parentInstanceId:elementId:occurrence:iterationIndex` — an at-least-once re-run of the invoke
  step derives the SAME child id (the idempotent-create key).
- **`child_instances` is the rewalk fast-forward predicate** gating BOTH the child-Workflow create
  and the output apply (statuses `invoked | outputApplied`; the analogue of `gateway_decisions` /
  `output_applied=1`). The invoke batch — provenance row + child instance row +
  `callActivityInvoked` history (+ the call's boundary-timer arm, if any) — commits in ONE `dbBatch`
  **before** the idempotent Workflow start (persist-before-advance).
- **io-mapping is pass-through both ways** (the Zeebe-aligned default; an `easy-bpmn:ioMapping`
  extension is deferred): the parent's (branch-resolved) variables become the child's initial
  variables — a branch token's child sees its resolved overlay chain — and a **completed** child's
  variables merge back into the parent (the branch overlay inside an M4 region, root variables
  otherwise). Input exceeding the ~1 MiB event limit is rejected as an incident **before** the child
  is created.
- **Apply-once.** The apply step is issued only once the child sits in a **forward-consumable
  terminal** (`completed | errored`), so a memoized step result is always final. The `completed`
  apply batch = the `outputApplied` flip + variable merge + advance + the parent's **child ledger
  step** (`saga_steps.child_instance_id`, `compensation_status='pending'` — always compensable) +
  `callActivityCompleted` history; an `outputApplied` row is a pure write-free cursor move
  re-derived from the child's terminal status.
- **A child technical `incident` does NOT notify the parent** — the saga parks on the call and heals
  via the cascading operator `/retry` (below). The notify set is
  `completed | errored | cancelled | compensated | compensationFailed`.

### `errored` — the child-only terminal + parent error routing

- A child's **uncaught error end settles the CHILD `errored`** with the business error code
  (`process_instances.error_code`) + `childErrored` history — **never** a child-local
  `uncaughtError` incident (that branch stays reserved for a ROOT instance, unchanged since M5-L1).
  `errored` is NEVER a valid root-instance status.
- The PARENT routes an `errored` child **exactly like a worker business error thrown at the
  `callActivity`**: exact-`@errorCode` boundary on the call → catch-all → hierarchical bubble up the
  scope chain (the same attachment-chain walk as the worker-task path) → else an `uncaughtError`
  incident **at the parent** (`callActivityErrored` history either way). Guarding boundary timers on
  the call — and on the catching scope — settle `cancelled` atomically with the route; a decider
  conflict (the timer fired first) converts to the timer's boundary path, never a double-advance.

### Child→parent wake (tickle + DO-alarm self-heal + capped backstop)

- The child's terminal drive **tickles the parent through the existing `deliverJobResult` seam** — a
  contentless `bpmn_wake` `sendEvent` with the terminated-Workflow **inline-drive fallback**, in
  both executors — so the parked parent re-reads canonical D1 and applies.
- **Self-heal net 1:** a `JobScheduler` DO **child-notify alarm** (keyed
  `child-notify:<childInstanceId>`, armed BEFORE the tickle so a dropped tickle is always covered)
  re-reads canonical state and re-tickles while the child terminal is unconsumed, at bounded
  backoffs `CHILD_NOTIFY_BACKOFF_MS = 30 s / 2 m / 10 m / 30 m`.
- **Self-heal net 2:** while any visit's child is still `invoked`, the parent's single-wake
  `waitForEvent` backstop is capped at **`CHILD_WAIT_BACKSTOP_MS` = 5 minutes** (instead of the 1 h
  ceiling), so a lost tickle recovers within minutes.

### Compensating a committed callActivity (the child's OWN reverse pass)

- **Step-kind dispatch:** `saga_steps.child_instance_id` `NULL` = worker-task step (the
  compensation-job lane, unchanged); non-`NULL` = **child step** — compensated by driving the
  CHILD's own reverse pass over its retained ledger, **never** a compensation job.
- **Entry is a CAS** `{completed, cancelled} → compensating` (`cancelled` = a drain-interrupted
  child whose committed steps still need reversal), plus an element-less cancel marker so the
  child's resume derives its **process-root** reverse pass; a lost CAS leaves the winner owning the
  reverse (idempotent re-entry).
- **No-op shortcut:** an empty child compensable ledger (with a quiesced token cohort) settles the
  child `compensated` **synchronously** — the parent is never parked on a no-op compensator.
- A child **`compensationFailed`** surfaces as the PARENT's **own** `compensationFailure` incident
  on the `callActivity` element (the parent's child step → `failed`, the parent →
  `compensationFailed`).
- **Root-scope rows are implicit members of the process-root reverse pass:** the process-root pass
  also selects `scope_id = ''` ledger rows, so a **scope-less** parent's committed `callActivity`
  still reverses on operator `/cancel`.

### Cascading drain / cancel (Hazard, depth-first)

- Scope drains (a fired scope- or call-hosted boundary timer, an error-bubble scope exit) and
  operator `/cancel` cascade **depth-first** into every non-terminal descendant (grandchildren
  first; bounded by `MAX_CALL_DEPTH = 4`): abandon in-flight forward jobs, release subscriptions
  (defensive — v1 rejects message waits in a call tree at publish), disarm timers, terminate the
  child Workflow, CAS `{starting, running, waiting, incident} → cancelled` + `instanceCancelled
  {by:"parentDrain"}` history. **Hazard semantics — the cascade NEVER compensates**; the child's
  saga ledger is retained untouched. A terminal or already-`compensating` child short-circuits
  (idempotent re-drive).
- A drain that discards a live token parked on a `callActivity` **retains the child ledger row**, so
  a LATER reverse pass over an enclosing transaction still compensates the child.

### Operator verbs (all control flows through the saga root)

- A direct `POST /instances/{child}/cancel` or `/retry` on a `callActivity` child → **`409
  Conflict`** naming the parent.
- A parent `/retry` **cascades depth-first** into descendant `incident` AND `compensationFailed`
  states before the root's own branch — the operator's variables patch is threaded into every
  retried child — and records `operatorRetry {target:"childSubtree"}`. A successful cascade never
  surfaces as an operator error (a root-branch refusal after healed children is swallowed; the
  parent is still re-driven so the healed child applies).
- A parent `/cancel` is a **process-root drain**: it cascade-cancels non-terminal children first,
  then runs the reverse pass (child steps dispatching into the children's own reverse passes).

### Lineage inspection

- `GET /instances/{id}` gains an **always-present `lineage`** block, read from D1 only: `{ parent:
  { instanceId, elementId } | null, children: [{ elementId, occurrence, childInstanceId, status }] }`
  (a root instance carries `parent: null`).
- `GET /instances?root=true` restricts the list to saga-root instances (`parent_instance_id IS
  NULL`); absent or any other value, children are included (back-compat).
- New free-text `history_events.type` values (no schema change): `callActivityInvoked`,
  `callActivityWaiting`, `callActivityCompleted`, `callActivityErrored` (parent-side),
  `childErrored` (child-side), `instanceCancelled` (`{by:"parentDrain"}`), `operatorRetry`
  (`{target:"childSubtree"}`).

## Observability Contract

- A `traceId` (derived from `instanceId`) plus a per-step `spanId` are propagated into
  activate/complete/fail payloads and recorded in `history_events.diagnostics` and `saga_steps`.
- W3C `traceparent` passthrough is considered so worker-side APM can correlate.
- M1 metrics are named (per-`taskType` job latency, retry counts, compensation outcomes); full
  dashboards are deferred.

## Operator Console Contract (M-UI)

Design: `docs/superpowers/specs/...m-ui-operator-console...`. Constitution v2.4.0. The operator
console is **read-only**: it adds inspection/aggregation/auth endpoints and a live-tail, but **no new
write verb** beyond the existing operator `/cancel` and `/retry`. The `/jobs/*` worker surface and the
existing root API contract are **unchanged**.

**Rules**:

- **All inspection reads D1 (inspection invariant preserved).** Every new endpoint
  (`/projects`, `/attention`, `/sagas`, `/sagas/{sagaId}`, `/sagas/{sagaId}/heatmap`,
  `GET /messages`, `GET /instances/{id}/jobs`, the extended `GET /instances/{id}` `subscriptions` block,
  `GET /definitions/versions/{id}/bpmn`, and the SSE live-tail) reads canonical D1 state only;
  none touches Cloudflare Workflow internals. `workflowInstanceId` is still never required from a
  caller.
- **Session-cookie auth gates the UI namespace only.** `POST /ui/login` validates operator
  credentials and issues the **`ebpmn_session`** cookie — an **HMAC-signed** session token,
  **HttpOnly + Secure + SameSite=Lax** — which the `operatorSession` security scheme requires on the
  gated endpoints; `POST /ui/logout` clears it; `GET /ui/me` is the unauthenticated SPA boot probe
  (`{ authenticated, workspaceId, authConfigured }`, `workspaceId` falling back to
  `UI_DEFAULT_WORKSPACE`). When console auth is **unconfigured** the console runs open
  (`authConfigured=false`) and login returns `400`; bad credentials return `401`. The pre-existing
  worker-credential (`workerCredential`) contract on `/jobs/*` is untouched and orthogonal.
- **SSE live-tail is a bounded delta-tail of D1.** `GET /instances/{id}/stream` (text/event-stream)
  tails `history_events` keyed by **rowid**: each SSE message carries `id:<cursor>`, the stream
  **honors `Last-Event-ID`** to resume after a gap, and the connection is **bounded (~25s)** before
  the client reconnects (or polls `GET /instances/{id}/history?since=<cursor>`, which now returns
  `nextCursor`). It **reads D1 only** — never Workflow state — so it is a pure projection of the
  audit log.
- **`worker_attempts` is now populated on the pull plane** (feeding the Attempts drill-down on
  `GET /instances/{id}/jobs`): a row is created (`createAttempt`) when a job is **leased**
  (`/jobs/activate`) and finished when the worker **completes/fails** it (`/jobs/{id}/complete` |
  `/jobs/{id}/fail`), recording request/response/error and start/finish times. The write is
  **idempotent** — a duplicate/stale callback (0-row `lock_token` update) does not append or
  re-finish an attempt, matching the existing at-least-once worker-callback contract.
- **Attention-set staleness predicate.** The cross-saga attention set (`/attention`, and the
  per-project `attention` count on `/projects`) lists instances in `incident` or `compensationFailed`
  status, **plus** "**stale compensating**" instances — `compensating` **AND** `updated_at` older than
  **5 minutes** — **not** every `compensating` instance (a healthy reverse pass advancing within the
  window is excluded). Each item's `reason` (`incident | compensationFailed | staleCompensating`) and
  `since` (the instance `updated_at`) are surfaced.
- **Per-saga living heatmap.** `GET /sagas/{sagaId}/heatmap` is a per-element live-instance density
  aggregation: live instances for the saga (`draft_id`) grouped by `current_element_id` and status,
  **live statuses only** (`running`/`starting`/`waiting`/`compensating`/`incident`/`compensationFailed`;
  terminal instances no longer sit at a node and are excluded), read-only from D1, powering the aggregate
  "living heatmap" mode. **Edge throughput intensity is derived client-side from node density in v1** (no
  per-edge counter is stored).
