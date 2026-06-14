# Data Model: SAGA Orchestrator (M1 — Canonical transaction-saga; M2 — Conditional sagas; M3 — Time & failure taxonomy; M4 — Concurrency)

All M1 changes are **additive migrations** (`migrations/0002_saga.sql`); published definition
versions are never mutated. The MVP entities (Workspace, Process Definition Draft, Validation
Issue, Process Definition Version, BPMN Element, Worker Attempt, Message Subscription, External
Message, Variable Snapshot, History Event, Idempotency Record) carry forward from
`specs/001-bpmn-lite-orchestrator-mvp/data-model.md`; only the deltas and new entities are
described here. The **M2 deltas** (occurrence discriminator, conditional topology,
`gateway_decisions` — migrations `0004_conditional.sql` + `0005_output_applied_backfill.sql`) are
described in their own section, followed by the **M3 deltas** (model-level timers + the
technical-vs-business incident-kind split — migration `0006_timers.sql`), and finally the **M4 deltas**
(the token-frontier read-model + the append-only join facts that make in-instance concurrency replayable —
migration `0007_tokens.sql`).

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
  flows at parse time) so topology is queryable and replay-deterministic. As built (TASK-11
  closeout): the parsed-profile graph carries `GraphNode.outgoing: Flow[]`, and `bpmn_elements`
  rows for `sequenceFlow`/`association` carry `source_ref`/`target_ref` (additive migration
  `0003_topology.sql`).

## Entity: Graph Node (graph IR delta)

Delta to the parsed-node IR consumed by the scope-aware engine.

**Fields**:
- `outgoing`: `Flow[]` where `Flow = { flowId, targetId, conditionExpression?, isDefault? }`
  (M1: at most one token-path entry; `conditionExpression`/`isDefault` always `null`/`false` until
  M2). `GraphNode.next` is kept as the derived convenience `outgoing[0]?.targetId` so the
  single-token engine is unchanged (M1 reads `.next`; the M2 migration is to *select* among
  `outgoing[]`). Compensation boundaries + `isForCompensation` handlers carry `outgoing: []`.
- `kind`: Node kind, now including `transaction` and `boundaryEvent`.
- `endEvent.kind`: `none | cancel | compensate`.
- `boundaryEvent.kind`: `error | cancel | compensate | timer` (`error`/`cancel`/`compensate`
  accepted in M1; the **interrupting** `timer` boundary on a `serviceTask`/`receiveTask` accepted in
  M3 — see the M3 deltas).
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
  terminal incident (`kind=jobActivationTimeout`).
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
- The index shape was **not stable past M1**: loops re-run the same element N times. **Resolved in
  M2** — the `occurrence` discriminator (see "M2 Deltas" below) widens the unique index to
  `(instance_id, element_id, is_compensation, occurrence)`.

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

## M2 Deltas (Conditional Sagas — `0004_conditional.sql` + `0005_output_applied_backfill.sql`)

All additive. Design: `docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md` §4–§9.

> **The `/jobs/*` worker API surface is UNCHANGED by M2.** `occurrence` and `output_applied` are
> persistence-internal; a deployed M1 pull worker keeps working against an M2 orchestrator with
> zero changes. This compatibility contract is **pinned by
> `tests/contract/jobs-schema-pin.test.ts`** (exact request/response key sets; the leased-job shape
> never surfaces `occurrence`/`outputApplied`) — widening it later must amend that pin deliberately.

### Occurrence discriminator (loops: the same element runs N times)

- `service_task_jobs` + `occurrence INTEGER NOT NULL DEFAULT 0` and
  `output_applied INTEGER NOT NULL DEFAULT 0`; unique index recreated as
  `uq_jobs_instance_element_kind (instance_id, element_id, is_compensation, occurrence)` — one
  forward + one compensation job **per iteration**. A compensation job inherits its forward step's
  occurrence.
- `saga_steps` + `occurrence INTEGER NOT NULL DEFAULT 0`; `uq_saga_steps_forward` recreated as
  `(instance_id, element_id, occurrence)` — each completed pass of a compensatable step is its own
  ledger row (the `INSERT OR IGNORE` dedup contract preserved per iteration), so the reverse pass
  compensates every iteration separately with zero algorithm change.
- `message_subscriptions` + `occurrence INTEGER NOT NULL DEFAULT 0` — a Receive Task in a loop
  re-subscribes per visit; the broker key (`workspaceId + messageName + correlationKey`) is
  unchanged.
- `output_applied` marks a completed job whose output the engine already merged + advanced past,
  set **in the same `dbBatch` as the advance**, so the rewalk-from-start treats applied steps as
  write-free fast-forward. Migration `0005` backfills it for jobs applied under the M1 engine
  (predicate: the job's `variable_snapshots` row with `source='serviceTask'`), and MUST be applied
  before deploying the rewalk engine.
- Every `DEFAULT 0` keeps each existing M1 row and call site at its exact prior semantics.

### Entity: Gateway Decision (new table `gateway_decisions`)

Deterministic replay of branch choices: one row per gateway **visit**, written atomically with the
transition (persist-before-advance). An existing row for `(instance, gateway, occurrence)` is
**reused, never re-evaluated** — crash/replay takes the recorded branch in both execution modes.
No row is written for a **failed** visit (`noPath` / evaluation error), so an operator `/retry`
re-evaluates that visit fresh. `evaluations` is the **evaluation trace**, not the flow list:
selection short-circuits at the first `true` condition, so only actually-evaluated flows appear —
flows after the winner and the never-evaluated `default` are absent by design.

```sql
CREATE TABLE gateway_decisions (
  decision_id        TEXT PRIMARY KEY,
  instance_id        TEXT NOT NULL,
  element_id         TEXT NOT NULL,     -- the exclusiveGateway
  occurrence         INTEGER NOT NULL,
  chosen_flow_id     TEXT NOT NULL,
  is_default         INTEGER NOT NULL DEFAULT 0,
  evaluations        TEXT NOT NULL,     -- JSON [{flowId, expression, result, value?, warnings?}] in document order
  variables_snapshot TEXT,              -- evaluation context; NULL for pass-through joins / oversized contexts
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_gateway_decisions ON gateway_decisions (instance_id, element_id, occurrence);
```

**Validation Rules**:
- `variables_snapshot` is size-capped by the existing event-payload limit: an oversized context is
  **omitted** (`NULL` + a `variablesSnapshotOmitted: true` flag with `variablesByteSize` in the
  history diagnostics), never an error — the decision itself is unaffected.
- A losing concurrent walk's unique violation aborts its whole batch; the loser re-reads and
  follows the **recorded** branch.

### Conditional topology (`bpmn_elements`)

`+ condition_expression TEXT`, `+ is_default INTEGER NOT NULL DEFAULT 0` — a `sequenceFlow` leaving
an `exclusiveGateway` persists its FEEL condition (document order = evaluation order) or the
gateway's `default` marker; `NULL`/`0` on all other rows. `getVersionGraph` replay stays
deep-equal with a fresh parse, conditions included.

### Incident (kind values widened)

`incidents.kind` (unconstrained TEXT — contracts-level change only) gains:

- `loopLimit` — a walk-local visit counter exceeded `MAX_ELEMENT_OCCURRENCES = 1000`; Hazard
  semantics inside a transaction (no auto-compensation; operator `/cancel` available, resolution
  advancing `compensating → compensated` when the pass settles).
- `noPath` — an exclusiveGateway found no `true` condition and has no default; Hazard semantics
  inside a transaction; operator `/retry` re-evaluates the visit fresh (no decision row exists for
  the failed visit).

Full enum after M2 (zod + openapi): `serviceTaskFailure | compensationFailure | timeout | poison |
loopLimit | noPath`. **M3** splits the overloaded `timeout` and adds `conditionFailure` — see the
M3 deltas below.

### History Event (free-text type absorbs the M2 event)

- `gatewayDecisionEvaluated` — per gateway visit, carrying `{ chosenFlowId, occurrence, isDefault,
  evaluations, passThrough?, variablesSnapshotOmitted?, variablesByteSize? }` in `diagnostics`; the
  operator surface for branch decisions (no new public endpoint in M2).
- `compensationStarted` **and** `compensationCompleted` diagnostics carry the iteration's
  `occurrence` so each loop iteration's rollback is auditable.

## M3 deltas (time & failure taxonomy — migration `0006_timers.sql`)

Additive over the M2 schema; published versions are never mutated. Source design:
`docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md` (§4.1 tables, §5 taxonomy).

### Entity: Timer (graph IR + runtime)

New token nodes accepted by the validator at **process level and inside a `transaction`** (the only
extension binding is still `easy-bpmn:taskDefinition` on tasks — nothing new):

- **Interrupting boundary timer** — `boundaryEvent` + `timerEventDefinition` (`cancelActivity`
  absent/`true`), attachable to a `serviceTask`/`receiveTask`, **at most one per activity**, exactly
  one outgoing flow; never on a `transaction` (would terminate the scope without compensation) nor on
  an `isForCompensation` handler. The canonical "saga timeout → compensate" shape is a boundary timer
  on a task *inside* the transaction routing to the cancel end event.
- **`intermediateCatchEvent` + `timerEventDefinition`** — a delay step on the token path (one
  incoming, one outgoing).
- **`intermediateCatchEvent` + `messageEventDefinition`** — identical wait/correlation/resume
  semantics to a `receiveTask` (same subscription machinery), but an *event*, not an activity.
- **`eventBasedGateway`** — ≥2 outgoing flows, each targeting an `intermediateCatchEvent` (timer or
  message) whose only incoming flow is from the gateway; at most one timer branch; message branches
  reference distinct messages; no `instantiate="true"`/`eventGatewayType="Parallel"`.

**Timer triggers:** exactly one of `timeDate`|`timeDuration`, each a static ISO-8601 literal
(`timeCycle`, FEEL expressions, zero/two children → rejected pre-publish with element id + reason).
`fire_at` is computed **once at arm time in code** (`timeDate` as-is; `now + timeDuration`) and
snapshotted in D1, never recomputed in SQL — so a rewalk re-park and a Workflow replay see the same
deadline (replay-safety; the foundation for later FEEL-expression triggers).

### `timers` (canonical, queryable source of record)

One row per armed model timer. The PK is **deterministic** (`instanceId:elementId#occurrence`),
`occurrence` is the **arming visit's** occurrence — the host activity's visit for a boundary timer,
the catch's own visit for an intermediate catch, the gateway's visit for an `eventGateway` timer
branch — never derived from live D1 counts (the M2 rewalk rule). Arming is `INSERT OR IGNORE` in the
same `dbBatch` as the wait it guards, so a rewalk that revisits an `armed` row is a write-free
re-park. `status` is bookkeeping / read-model only; the authoritative race outcome lives in
`timer_outcomes` (boundary / intermediate-catch timers) or `gateway_decisions` (`eventGateway`
timers).

```sql
CREATE TABLE timers (
  timer_id        TEXT PRIMARY KEY,   -- deterministic: instanceId:elementId#occurrence
  instance_id     TEXT NOT NULL,
  element_id      TEXT NOT NULL,      -- the timer-event element (boundary | catch | EBG branch)
  occurrence      INTEGER NOT NULL,   -- the arming visit's occurrence
  kind            TEXT NOT NULL,      -- boundary | intermediateCatch | eventGateway
  attached_to_ref TEXT,               -- boundary: host activity element id
  gateway_id      TEXT,               -- eventGateway: owning gateway element id
  fire_at         TEXT NOT NULL,      -- snapshotted at arm time (timeDate as-is; now + timeDuration)
  status          TEXT NOT NULL,      -- armed | fired | cancelled  (bookkeeping/read model)
  fired_at        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_timers_visit ON timers (instance_id, element_id, occurrence);
CREATE INDEX idx_timers_instance_status ON timers (instance_id, status);
```

### `timer_outcomes` (the race decider for boundary / intermediate-catch timers)

Every race has exactly **one deciding row**, claimed by a **plain `INSERT`** (never
`INSERT OR IGNORE`) composed into the same `dbBatch` as the loser-visible transition: the loser's
whole batch aborts on the unique-constraint violation and converts to the recorded outcome (the
documented `gateway_decisions` contract, `src/persistence/gateway-decisions.ts`). `eventGateway`
timers decide on `gateway_decisions` instead and have **no** `timer_outcomes` row.

```sql
CREATE TABLE timer_outcomes (
  timer_id   TEXT PRIMARY KEY,
  outcome    TEXT NOT NULL,           -- fired | cancelled
  decided_at TEXT NOT NULL
);
```

**Firing & validation rules:**
- DO-alarm-first: a per-timer alarm on the generalized one-shot `JobScheduler` DO (timer DOs keyed
  `timer:<timerId>`, same `JOB_SCHEDULER` binding — no DO-namespace migration) fires it; `step.sleep`
  is **not** used. Arming is best-effort at write time; every rewalk re-arms `armed` timers it walks
  past (self-healing). Direct mode tests fire via `runDurableObjectAlarm`.
- A timer-guarded wait never raises `waitTimeout`; in Workflow mode its `waitForEvent` timeout is
  sized to `fire_at` and doubles as the lost-alarm backstop (overdue settling on any wake).
- A **fired model timer is not an incident** — it is a modeled path (history `timerFired`). Every
  abnormal exit (normal completion, error-boundary route, retry exhaustion, operator `/cancel`)
  settles the armed timer `cancelled` via the decider, so a stray alarm afterwards no-ops.

### Incident kinds (the `timeout` split)

The overloaded M1/M2 `timeout` kind splits; full enum after M3 (zod + openapi):
`serviceTaskFailure | compensationFailure | conditionFailure | jobActivationTimeout | waitTimeout |
poison | loopLimit | noPath` (+ legacy `timeout`, retained for compatibility, never written by new
code).

- `jobActivationTimeout` — nobody leases the `taskType` before `activation_expires_at` (the DLQ
  expiry; the lone M1 job-level timer).
- `waitTimeout` — **retired and now unproduced under M4 single-wake (TASK-54):** un-guarded waits
  follow standard BPMN — a receive-task / message-catch wait with no modeled deadline is
  **indefinite**, and un-guarded service-task liveness is the DLQ `jobActivationTimeout`, not an
  engine wait cap. Kept as a vestigial enum value (above) until the dead-code sweep.
- `conditionFailure` — a hard FEEL evaluation error (deferred from M2; previously masked as
  `serviceTaskFailure`).

**Incident hygiene (M3):** `setIncidentResolution` takes an `incident_id` filter (no longer flips
*all* of an instance's open incidents); instance inspection exposes the **list of open incidents**
(not only the latest); operator `/cancel` on an empty ledger closes all open incidents as
`operatorResolved` and settles armed timers.

### Jobs API retry policy (M3)

`retryable` is **honored**: a `fail` with `retryable=false` (or a technical failure that exhausts its
retry budget, including a reclaim re-lease that reaches `retry_limit`) routes to the standard
exhaustion path (Hazard incident inside a transaction). The request schema is unchanged; this is a
behavior change for a worker already sending `retryable=false` (legal and ignored before M3). The
poison budget stays per-(instance, element) across occurrences (the deliberate TASK-35 decision).

### History Event (free-text type; no migration)

New event types: `timerArmed`, `timerFired`, `timerCancelled`, `eventBasedGatewayWaiting`,
`ebgDecision`. A fired model timer emits `timerFired` (no incident).

### Inspection (`GET /instances/{id}`)

Gains a `timers` block (armed/fired/cancelled with `fire_at`/`fired_at`) read from D1 and the
**list** of open incidents; Cloudflare Workflow internals stay hidden. No new operator verbs.

## M4 deltas (Concurrency — token frontier + join facts — migration `0007_tokens.sql`)

Additive over the M3 schema (latest shipped was `0006_timers.sql`); published versions are never mutated.
Source design: `docs/superpowers/specs/2026-06-13-m4-concurrency-design.md` (§5 engine, §7 persistence).
Constitution v2.3.0. Existing M1–M3 instances need **no backfill**: each has a single implicit root token,
materialised lazily on its next drive.

> **The `/jobs/*` worker API surface is UNCHANGED by M4** (still pinned by
> `tests/contract/jobs-schema-pin.test.ts`). Branch tokens, variable overlays, and join facts are
> persistence-internal; a deployed M1–M3 pull worker keeps working against an M4 orchestrator unchanged.

### Entity: Execution Token (the frontier read-model — new table `execution_tokens`)

The set of live token positions inside **one** instance. `execution_tokens` is a **denormalised
read-model**: `position_element_id` and `status` are recomputed by the deterministic rewalk each drive (for
operator inspection + compensation cohort capture) and are **NEVER read as a replay-decision input** —
occurrence assignment, join-fire, and split fan-out all derive from the static graph + the append-only join
facts below. `variables_overlay` is authoritative mutable branch state, made idempotent by the existing
`output_applied` marker exactly like `process_instances.variables`.

```sql
CREATE TABLE execution_tokens (
  token_id            TEXT PRIMARY KEY,                 -- root: '<inst>:#root'; branch: '<inst>:<split>#<activation>:<branchFlow>'
  instance_id         TEXT NOT NULL,
  region_id           TEXT,                             -- enclosing split id; NULL for root
  region_activation   INTEGER NOT NULL DEFAULT 0,       -- split's walk-local occurrence; 0 for root
  parent_token_id     TEXT,                             -- token consumed at the split; NULL for root
  branch_flow_id      TEXT,                             -- split out-flow taken; NULL for root/produced
  position_element_id TEXT NOT NULL,                    -- DERIVED read-model; not a replay input
  status              TEXT NOT NULL DEFAULT 'active',   -- active|waiting|arrivedAtJoin|consumed|merged|discarded
  variables_overlay   TEXT NOT NULL DEFAULT '{}',       -- JSON delta over parent; or {"__r2":"<key>"}
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_tokens_instance_status ON execution_tokens (instance_id, status);
CREATE INDEX idx_tokens_region          ON execution_tokens (instance_id, region_id, region_activation, status);
```

**Fields** (semantics):
- `token_id`: replay-stable PK in one of **three forms** — **root** `${instanceId}:#root`; **branch**
  `${instanceId}:${splitId}#${activation}:${branchFlowId}`; a **produced (post-join)** token re-uses its
  `parent_token_id` (a SESE region consumes the parent at the split and returns the frontier to exactly one
  token at the join).
- `region_activation`: the split gateway's **walk-local occurrence** at the moment the walk entered the
  region (the same in-memory counter as `MAX_ELEMENT_OCCURRENCES`, never a `COUNT` over this table); it
  increments on each loop re-entry of the region. It is a **separate axis** from a branch element's own
  occurrence — a cycle inside a branch makes the element's occurrence exceed `region_activation`; the two
  are never conflated in any key.
- `parent_token_id` / `region_id` / `branch_flow_id`: the lineage, enclosing split, and split out-flow this
  token descended from. Branch identity is a **stack of `(region_id, region_activation, branch_flow_id)`
  frames** — entering a split pushes a frame, the matching join pops that activation's frames — so a nested
  region's join output satisfies its enclosing branch at the outer join.
- `position_element_id`: a **DERIVED** read-model cursor; never a replay input.
- `status`: `active | waiting | arrivedAtJoin | consumed | merged | discarded`. The `MAX_CONCURRENT_TOKENS
  = 256` cap counts only the **live** subset (`active|waiting|arrivedAtJoin`), and from the **in-memory
  reconstructed frontier**, never a live `COUNT` over this table (else the cap fires nondeterministically on
  replay).
- `variables_overlay`: a JSON **delta over the parent scope**; reads resolve the overlay chain (token →
  ancestors → root `process_instances.variables`, nearest wins) and writes go to the token's own overlay.
  An overlay exceeding `OVERLAY_INLINE_MAX_BYTES` is offloaded to R2 (deterministic key
  `overlays/${instanceId}/${tokenId}.json`) and the column holds `{"__r2":"<key>"}` (§9.1; see
  `contracts/runtime-contracts.md`).

**Validation Rules**:
- The read-model is **never** a replay predicate; all fast-forward / barrier / fan-out decisions consult the
  static graph + the append-only join facts. A duplicate concurrent fan-out aborts wholesale on the
  `token_id` PK and re-reads.
- **Element-disjointness invariant.** SESE guarantees every element id belongs to at most one branch of at
  most one enclosing region, so two concurrent tokens can never visit the same element. M4 therefore adds
  **no token discriminator** to `uq_jobs_instance_element_kind`, `uq_saga_steps_forward`, or
  `uq_timers_visit` — each element's own walk-local occurrence remains sufficient.

### Entity: Join Arrival / Join Completion (the append-only join facts — the real replay predicates)

The AND/OR join barrier decides on these append-only tables, **never** on the `execution_tokens`
read-model. Mirrors the `gateway_decisions` plain-INSERT race discipline
(`src/persistence/gateway-decisions.ts`).

```sql
CREATE TABLE join_arrivals (
  instance_id    TEXT NOT NULL,
  join_id        TEXT NOT NULL,
  activation     INTEGER NOT NULL,
  branch_flow_id TEXT NOT NULL,
  arrived_at     TEXT NOT NULL,
  PRIMARY KEY (instance_id, join_id, activation, branch_flow_id)             -- INSERT OR IGNORE
);
CREATE TABLE join_completions (
  instance_id       TEXT NOT NULL,
  join_id           TEXT NOT NULL,
  activation        INTEGER NOT NULL,
  produced_token_id TEXT NOT NULL,
  decided_at        TEXT NOT NULL,
  PRIMARY KEY (instance_id, join_id, activation)                            -- PLAIN INSERT in the advance batch
);
```

**Fields / Rules**:
- **`join_arrivals`** records a branch reaching its join via **`INSERT OR IGNORE`** (duplicate arrival =
  no-op). The traversal **halts** on that branch — the join node is NOT entered and nothing downstream is
  walked from it — so the join and the post-region path are visited exactly **once per activation**
  (`join.occurrence == region_activation`).
- **`join_completions`** claims the join fire with a single **plain `INSERT`** composed into the **same
  `dbBatch`** as the merged-overlay write, the source tokens' transition to `status='merged'`, the produced
  token row, and the advance onto the join's out-flow. A losing concurrent arrival's batch **aborts on the
  PK** and re-reads the recorded `produced_token_id`.
- The **required arrival count** is read from persisted state — **AND** = `count(split.outgoing)`; **OR** =
  the recorded `gateway_decisions.activated_flow_ids` subset — **never** a live `COUNT`.

### Entity: Gateway Decision (delta — inclusive-split activation set)

`gateway_decisions` gains an `activated_flow_ids` column so an OR split's multi-branch activation is
replayable (a single `chosen_flow_id` cannot represent a subset):

```sql
ALTER TABLE gateway_decisions ADD COLUMN activated_flow_ids TEXT;   -- JSON array, document order; NULL for XOR/EBG/parallel
```

- For an **inclusive split** it holds the activated out-flows in **document order**; `chosen_flow_id` holds
  the document-order-first activated flow as a sentinel. **NULL** for XOR / `eventBasedGateway` / parallel
  (which always activates all). On rewalk the OR-join's wait set is the recorded `activated_flow_ids`, reused
  verbatim and never re-evaluated (same contract as `exclusiveGateway`).

### Entity: Saga Step (delta — producing branch token for lineage-ordered reverse)

```sql
ALTER TABLE saga_steps ADD COLUMN token_id TEXT;   -- producing branch token; NULL on the single-token (M1–M3 / root) path
```

- `token_id` is the **branch token that produced the ledger row**. The lineage-quiescence-ordered reverse
  pass (Principle VI **per causal chain**) compensates a step only once its token lineage (via
  `parent_token_id`) has **no live (`active|waiting|arrivedAtJoin`) descendant token** — so a causally-downstream straggler
  is always compensated before its predecessor; cross-branch order is unconstrained. `seq` stays an
  **ordering field only** (assigned once at `INSERT OR IGNORE`) and MUST NOT appear in any step name or key.

### Entity: Process Instance (delta — `current_element_id` becomes derived)

`process_instances.current_element_id` becomes a **nullable, denormalised representative position**: the
sole live token's position when the frontier has exactly one token, **NULL** otherwise. It is **not
authoritative for any wake decision** — every former `current_element_id` staleness guard
(`planIntermediateCatchFire`, `planEventGatewayTimerFire`, `parkWaiting`) is re-expressed as a **per-token
predicate** (M4-L2, before any split is enabled). No new instance status is added (`running|waiting|
compensating|compensated|compensationFailed|cancelled|completed|incident` suffice); only the **completion
rule** changes — an instance completes when its **frontier is empty** (§5.6). Inspection surfaces the
frontier from `execution_tokens` as the `GET /instances/{id}` `tokens` array (see
`contracts/runtime-contracts.md`).

### Region map (publish-time topology, on the immutable version)

The publish-time SESE pass persists the region map `{ splitId → { joinId, type: 'and'|'or', branchFlowIds[]
(document order), enclosingScopeId } }` alongside the element topology in the immutable version's graph IR
(`parsed_profile`), so the deterministic merge order and the OR-join wait set are **never recomputed from
the live graph** at runtime.

## Roadmap stub tables (named here; created in later milestones)

- `execution_tokens` (M4) — **SHIPPED** in migration `0007_tokens.sql` (see the **M4 deltas** above): the
  single `current_element_id` is now one token among many in the frontier read-model, with the
  `join_arrivals`/`join_completions` append-only join facts as the replay predicates. Parallelism target
  semantics: `docs/bpmn/07-execution-semantics.md`.
- No further roadmap stub tables are named yet — M5 (composition: `callActivity`, non-transaction
  `subProcess`, `multiInstance`, `signal`/`escalation`) will name its own when the constitution is amended.
