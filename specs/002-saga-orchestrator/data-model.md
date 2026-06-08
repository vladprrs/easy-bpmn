# Data Model: SAGA Orchestrator (M1 — Canonical transaction-saga)

All M1 changes are **additive migrations** (`migrations/0002_saga.sql`); published definition
versions are never mutated. The MVP entities (Workspace, Process Definition Draft, Validation
Issue, Process Definition Version, BPMN Element, Worker Attempt, Message Subscription, External
Message, Variable Snapshot, History Event, Idempotency Record) carry forward from
`specs/001-bpmn-lite-orchestrator-mvp/data-model.md`; only the deltas and new entities are
described here.

## Entity: Transaction Scope (graph IR)

A `bpmn:transaction` node in the parsed graph IR (`src/bpmn/graph.ts`); the boundary of one saga.

**Fields**:
- `scopeId`: The `<transaction>` element id.
- `startId`: The transaction's `startEvent` id.
- `childIds`: Ids of the in-scope child flow nodes.
- `compensations`: Map `activityId -> { handlerId, boundaryId }` (compensation wiring inside the
  scope).
- `cancelEndId`: The `cancelEventDefinition` end event id (commit-cancel boundary).
- `cancelBoundaryId`: The transaction's `cancelEventDefinition` boundary event id (saga-failed
  path).

**Relationships**:
- Contains `serviceTask` (forward and `isForCompensation`), `boundaryEvent`, and `endEvent`
  children.
- Produces `saga_steps` rows for its completed-compensatable children at runtime.

**Validation Rules**:
- Must contain a `startEvent`, supported children, a none `endEvent` (commit), and a
  `cancelEventDefinition` `endEvent`.
- A `compensateEventDefinition` boundary event must have zero outgoing sequence flow and exactly
  one outgoing `<association>` to an `isForCompensation` activity **in the same scope**.
- A `cancelEventDefinition` is valid only inside / attached to a transaction.
- Sequence-flow source/target, associations, and the scope tree are **persisted** (the MVP dropped
  flows at parse time) so topology is queryable and replay-deterministic.

## Entity: Graph Node (graph IR delta)

Delta to the parsed-node IR consumed by the scope-aware engine.

**Fields**:
- `outgoing`: `Flow[]` where `Flow = { flowId, targetId, conditionExpression?, isDefault? }`
  (M1: at most one token-path entry; conditions land in M2).
- `kind`: Node kind, now including `transaction` and `boundaryEvent`.
- `endEvent.kind`: `none | cancel | compensate`.
- `boundaryEvent.kind`: `error | cancel | compensate | timer` (only `error`/`cancel`/`compensate`
  accepted in M1).
- `boundaryEvent.attachedToRef`: The activity/transaction the boundary is attached to.
- `isForCompensation`: Boolean on service-task nodes (handler, off the normal token path).
- `association`: Map `boundaryId -> handlerId`.

**Validation Rules**:
- Any flow node with >1 outgoing token-path flow is rejected before publish (M2/M4).
- `errorRef` on an error boundary must resolve to a root `<bpmn:error>`.

## Entity: Saga Step (the reverse-order ledger)

The completed-step stack a saga compensates against. New table `saga_steps`. A row exists **only
for a completed forward compensatable step**, written **atomically with advance** (same `dbBatch`
as the job-complete + transition), carrying captured input AND captured output — never a
dispatch-time placeholder.

```sql
CREATE TABLE saga_steps (
  step_id                 TEXT PRIMARY KEY,
  instance_id             TEXT NOT NULL,
  scope_id                TEXT NOT NULL,     -- the <transaction> element id
  seq                     INTEGER NOT NULL,  -- monotonic completion order within scope
  element_id              TEXT NOT NULL,     -- forward activity
  forward_job_id          TEXT NOT NULL,
  captured_input          TEXT NOT NULL,     -- JSON
  captured_output         TEXT,              -- JSON
  compensation_element_id TEXT,              -- isForCompensation handler, or NULL (no compensator)
  compensation_task_type  TEXT,
  compensation_job_id     TEXT,
  compensation_status     TEXT NOT NULL,     -- pending|notRequired|compensating|compensated|failed
  trace_id                TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_saga_steps_forward ON saga_steps (instance_id, element_id);  -- INSERT OR IGNORE at completion
CREATE INDEX idx_saga_steps_scope ON saga_steps (instance_id, scope_id, seq);
```

**Fields** (semantics):
- `seq`: Monotonic completion order within the scope; the reverse pass selects `ORDER BY seq DESC`.
- `captured_input` / `captured_output`: The forward step's input and output, seeded into the
  compensation job (`originalInput` + `capturedOutput`).
- `compensation_status`: `pending` (awaiting compensation) | `notRequired` (no handler associated) |
  `compensating` (comp job in flight) | `compensated` (done) | `failed` (compensator exhausted
  retries). Exists only for completed forward steps.

**Validation Rules**:
- Written via **`INSERT OR IGNORE`** against `uq_saga_steps_forward (instance_id, element_id)`, so a
  duplicate completion / replay is a no-op — closing the double-row and the
  advance-then-crash-before-ledger holes.
- The reverse cursor is re-derived from the ledger after a crash:
  `compensation_status IN ('pending','compensating','failed') ORDER BY seq DESC`.
- A row already `compensating` re-attaches to its existing `compensation_job_id` (never a second
  comp job) — the replay-recovery rule.

## Entity: Service Task Job (extended for pull lease + compensation)

The MVP `service_task_jobs` table gains the pull-lease columns and the compensation lane. The MVP
unique index `uq_jobs_instance_element` (one job per element) **blocks** compensation (a second job
per element) and is dropped in favor of a one-forward + one-compensation-per-forward-element index.

```sql
ALTER TABLE service_task_jobs ADD COLUMN is_compensation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_task_jobs ADD COLUMN compensates_element_id TEXT;
ALTER TABLE service_task_jobs ADD COLUMN worker_id TEXT;
ALTER TABLE service_task_jobs ADD COLUMN lock_token TEXT;
ALTER TABLE service_task_jobs ADD COLUMN lock_expires_at TEXT;
ALTER TABLE service_task_jobs ADD COLUMN activation_expires_at TEXT;   -- job-level DLQ TTL
ALTER TABLE service_task_jobs ADD COLUMN error_code TEXT;
DROP INDEX uq_jobs_instance_element;
CREATE UNIQUE INDEX uq_jobs_instance_element_kind ON service_task_jobs (instance_id, element_id, is_compensation);
CREATE INDEX idx_jobs_leasable ON service_task_jobs (task_type, status, lock_expires_at);
```

**Fields** (new semantics):
- `is_compensation`: `0` forward, `1` compensation; forward and compensation jobs share the lane.
- `compensates_element_id`: For a compensation job, the **forward** (compensated) element id. A
  compensation job carries `element_id` = the forward element id with `is_compensation=1`, so
  uniqueness is one-forward + one-compensation per forward element **regardless of handler reuse**
  (one handler may compensate several steps).
- `worker_id` / `lock_token` / `lock_expires_at`: The pull lease (claimer, conditional-update token,
  lease deadline).
- `activation_expires_at`: Job-level DLQ TTL — a job whose `taskType` nobody polls expires here →
  terminal incident (`kind=timeout`).
- `error_code`: The business error code from a `fail` (matched to `bpmn:error/@errorCode`).
- `status`: `created | running | completed | failed`, plus the lease state `locked` (a `created`/
  re-leasable job is leased to `locked` with a `lock_token`).

**Validation Rules**:
- Leasing uses the atomic IN-subquery form with the lease guard in both the subquery and the outer
  `WHERE` (D1 does NOT parse `UPDATE … LIMIT … RETURNING`).
- `complete`/`fail` are `lock_token`-conditional (`… WHERE job_id=? AND lock_token=?`): a stale or
  duplicate worker matches 0 rows.
- **Operator retry RESETS the existing job row** (`status → created`, new `lock_token`, attempt
  accounting) rather than inserting — mirroring the MVP forward-reuse behavior.
- The index shape is **not stable past M1**: gateways/loops/multiInstance (M2/M4/M5) re-break it
  (same element runs N times) and will need a token/iteration discriminator.

## Entity: Worker Credential

Per-workspace pull-worker authentication; the source of the server-derived `workspaceId` for
`/jobs/*`.

```sql
CREATE TABLE worker_credentials (
  workspace_id TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
```

**Fields**:
- `workspace_id`: The workspace the credential authorizes.
- `token_hash`: Hash of the bearer token (the raw token is never stored).
- `created_at` / `revoked_at`: Lifecycle; a non-null `revoked_at` rejects the credential.

**Validation Rules**:
- Every `/jobs/*` call resolves a credential to a workspace; the server derives `workspaceId` from
  it and **never** trusts a body `workspaceId` for job access.
- A missing or revoked credential is rejected as unauthorized; no job outside the credential's
  workspace may be returned or affected.

## Entity: Process Instance (status lifecycle widened)

`process_instances.status` widens to add `compensating`, `compensated`, `compensationFailed`, and
`cancelled`. A new index backs the operator list endpoint.

```sql
CREATE INDEX idx_instances_workspace_status ON process_instances (workspace_id, status);
```

**Status enum**: `starting | running | waiting | completed | incident | compensating |
compensated | compensationFailed | cancelled`.

**State Transitions** (explicit one-way table; anything else is rejected):

```
starting → running
running  ⇄ waiting
running  → completed              (none end event → commit)
running|waiting → compensating    (cancel end event | error boundary→cancel | operator /cancel)
compensating → compensated        (reverse pass fully succeeds)
compensating → compensationFailed (a compensator exhausts retries)
compensationFailed → compensating (operator /retry — the one resumable edge)
compensated|compensationFailed → (terminal saga-failed; settled via the cancel-boundary path,
                                  NOT the normal completion routine)
running|waiting → cancelled        (operator /cancel with an EMPTY ledger — nothing to compensate)
```

**Validation Rules**:
- Settling a compensated / compensation-failed instance to the saga-failed terminal state MUST NOT
  call the normal completion routine (which would clobber `compensated`/`compensationFailed` into
  `completed`).
- Crash-recovery re-derives the reverse cursor from the ledger; a `compensating` row re-attaches to
  its existing `compensation_job_id`.
- The saga view (`GET /instances/{id}`) reads phase (`forward | compensating | compensated |
  compensationFailed`), per-step status, and `traceId` from this row + the ledger.

## Entity: Incident (extended for remediation linkage)

The MVP view-only `incidents` table gains `kind` and `resolution` so an incident can drive/track
compensation instead of dead-ending.

```sql
ALTER TABLE incidents ADD COLUMN kind TEXT;          -- serviceTaskFailure|compensationFailure|timeout
ALTER TABLE incidents ADD COLUMN resolution TEXT;    -- open|compensating|compensated|operatorResolved
```

**Fields** (new):
- `kind`: `serviceTaskFailure` (forward exhaustion / Hazard) | `compensationFailure` (a compensator
  exhausted retries) | `timeout` (un-leasable job hit its activation TTL).
- `resolution`: `open` | `compensating` | `compensated` | `operatorResolved`.

**Validation Rules**:
- A `compensationFailure` incident accompanies a `compensationFailed` instance and is resolvable via
  operator `retry` (which moves resolution toward `compensating` → `compensated`).
- The MVP's view-only constraint is relaxed for sagas: operator `cancel`/`retry` are available.

## Entity: History Event (no schema change — free-text type absorbs saga events)

`history_events.type` is free-text, so it absorbs the new saga events with **zero schema change**:
`transactionEntered`, `transactionCancelled`, `compensationStarted`, `compensationCompleted`,
`compensationFailed`, `jobActivated`, `jobCompleted`, `jobFailed`. The `traceId` is recorded in the
existing `diagnostics` JSON column.

**Validation Rules**:
- Each meaningful saga transition writes a history event with the `traceId` in diagnostics.
- History for an instance references only its bound definition version (immutable binding through
  compensation).

## Entity: Idempotency Record (delta)

`idempotency_records.scope` gains a new value and the forward callback keying is tightened.

**Fields** (delta):
- `scope`: adds `compensate` (alongside the MVP `startInstance | workerCallback | messagePublish |
  workflowEvent`).
- Forward `complete`/`fail` use scope `workerCallback` keyed by `jobId + lockToken` so a duplicate
  `fail` returns the prior outcome **instead of re-counting an attempt** (the premature-exhaustion
  bug). Compensation callbacks use scope `compensate`, keyed `instanceId:elementId:compensate`.

**Validation Rules**:
- The single-advance guarantee is Cloudflare Workflow **step memoization** of the resume step; the
  HTTP-side `lock_token`-conditional update only suppresses a redundant `sendEvent`.
- `sendEvent` to a terminal / not-running instance is gated on D1 first (terminal job/instance → ACK
  without sending) and wrapped so a "not running" throw is a **200 no-op ack**, never a 500.
- Operator verbs are guarded: `/cancel` is a status-conditional transition (`SET
  status='compensating' WHERE status IN ('running','waiting')`) so only the first call initiates one
  reverse pass; `/retry` is a conditional reset keyed on the current incident/failed status.

## Roadmap stub tables (named here; created in later milestones)

Named now for the roadmap; **not** created in `0002_saga.sql`:

- `gateway_decisions` (M2) — deterministic replay of branch choices (persist the *evaluated*
  decision regardless of expression language).
- `timers` (M3) — boundary timers, per-step timeouts, event deadlines (via `step.sleep` / DO
  alarms).
- `execution_tokens` (M4) — the single `current_element_id` becomes one token among many; the
  concurrent token set for parallelism (target semantics:
  `docs/bpmn/07-execution-semantics.md`).
