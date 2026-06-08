# SAGA Orchestrator — Design (easy-bpmn → canonical SAGA orchestrator for many microservices)

**Date:** 2026-06-08
**Status:** Approved design (brainstorming output), hardened by a 4-lens adversarial review (BPMN-canonicity, Cloudflare-Workflows feasibility, persistence/idempotency, completeness). Source artifact for Spec Kit feature `specs/002-saga-orchestrator` and the Backlog.md milestones M0–M5.
**Supersedes for SAGA scope:** the MVP exclusion list in `.specify/memory/constitution.md` (amended to 2.0.0 as part of this work).

---

## 1. Context & goal

`easy-bpmn` today executes exactly one deterministic linear path — `Start → Service Task → Receive Task → End` — on Cloudflare Workers + D1 + a Durable Object correlation broker + one Cloudflare Workflow per instance. The MVP is implemented, tested, and live at `bpmn.rntme.com`.

The goal is to evolve it into a **full, orchestration-based SAGA orchestrator for many microservices**: a central durable coordinator per instance drives a sequence of local transactions across distinct remote microservices and, on failure, executes the **compensating** transactions for already-completed steps in **reverse order**, then settles the instance into a defined terminal state — plus conditional branching, parallelism, timeouts, and operator visibility. This is a **major scope expansion**, deliberately phased so each milestone is independently shippable.

### What stays (strong substrate — keep it)

- **One Cloudflare Workflow per instance** — the canonical durable per-instance coordinator (`step.do` replay-safe side effects, `step.waitForEvent` for external callbacks, `step.sleep` for timers later). `src/workflows/process-workflow.ts`.
- **D1 as canonical, queryable store** — never Workflow state for inspection. `migrations/`, `src/persistence/*`.
- **Single DO correlation broker** keyed by `workspaceId + messageName + correlationKey`. `src/durable-objects/correlation-broker.ts`.
- **Immutable definition versions** — instance bound to one version for life ⇒ a deterministic compensation graph, no migration ambiguity.
- **persist-before-advance** + atomic `dbBatch` transitions — the durable, ordered completed-step log a SAGA needs.
- **`easy-bpmn:taskDefinition type` routing** (the "topic"), never element id/name — reused for compensation handlers and pull dispatch.
- **At-least-once everywhere + idempotency records** — makes at-least-once compensation safe.

### What must reopen (the two seams the MVP locked)

1. **The validator whitelist** (`src/bpmn/validator.ts`, `src/bpmn/profile.ts`) — `validator.ts:271-277` rejects >1 outgoing flow; `:136-143` conditionExpression; boundary/error/compensation/cancel events. Flip from *reject* to *accept-and-validate* for the chosen construct set.
2. **The linear single-token interpreter** (`src/runtime/engine.ts`) — scalar cursor `cur` over `node.next!` (`engine.ts:105-178`), `ServiceTaskOutcome = {next}|{incident}` (`:213`), terminal incidents (`:367-403`). Becomes a **scope-aware graph interpreter** with a compensation pass.

---

## 2. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Saga modeling style** | **Canonical BPMN**: `transaction` subProcess + `compensateEventDefinition` boundary + `isForCompensation` handler + `Association` + `cancelEventDefinition`. Only additive binding is `easy-bpmn:taskDefinition type`. Files stay XSD-valid and round-trip in Camunda Modeler / bpmn-js. |
| 2 | **Worker model** | **Pull / external-task** (Zeebe-style): services lease jobs by `taskType`, then `complete`/`fail`. Orchestrator does not know service addresses. **Transport for M1: bounded long-poll on `/jobs/activate`.** |
| 3 | **Compensation trigger** | **Transaction cancellation only**: a `cancel end event` inside the `<transaction>` (reached via an explicit `error boundary event` on a failing step) cancels it; the engine auto-compensates the scope's completed activities in reverse; a `cancel boundary event` on the transaction continues the "saga failed" path. Compensation is **never** triggered by an uncaught error (that is a BPMN *Hazard* → terminate, see §4.5). |
| 4 | **Compensator failure** | Retry per the handler's own policy → on exhaustion, terminal **`compensationFailed`** + operator alert + operator-resumable remediation via API. Never silently block forever. |
| 5 | **Compensation context** | The compensating action receives **both** the original step input and the captured step output. Compensators **must be idempotent** (at-least-once). |
| 6 | **Worker auth / tenancy** | Each `/jobs/*` call carries a **per-workspace worker credential** (bearer token); the server **derives `workspaceId` from the credential** and never trusts a body `workspaceId` for job access. Prevents cross-tenant job/payload exfiltration. |
| 7 | **Governance** | New Spec Kit feature `specs/002-saga-orchestrator`; constitution → **2.0.0** with a Sync Impact Report + a new "SAGA / Compensation Integrity" principle. `specs/001` retained as MVP history. |

---

## 3. The canonical saga contract (how a saga is drawn in BPMN)

A saga is a `<bpmn:transaction>`. Each forward step is a `serviceTask` with an `easy-bpmn:taskDefinition type` (pull topic). Each compensatable step carries a **compensation boundary event** associated (via `<bpmn:association>`) to an `isForCompensation="true"` handler. A business failure is caught by an **error boundary event** routing to a **cancel end event**; cancelling the transaction triggers reverse-order compensation; a **cancel boundary event** on the transaction takes the failure path.

> **BPMN crux (spec §10.5.5, "Transaction"):** when a transaction is **cancelled**, the engine **automatically** compensates the transaction's successfully-completed activities **in reverse completion order**, then throws Cancel to the transaction's cancel boundary event. **Do NOT add a compensate-throw event inside the transaction** — cancellation triggers compensation automatically; a redundant throw would double-fire. An Error that reaches the transaction boundary *uncaught* is a **Hazard**: it terminates the transaction and propagates — it does **not** auto-compensate. Hence every compensatable failure must be modeled as `error boundary → cancel end`.

```xml
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
                  targetNamespace="http://easy-bpmn/example/order-saga">
  <bpmn:error id="Err_shipping" name="Shipping rejected" errorCode="SHIPPING_REJECTED"/>

  <bpmn:process id="OrderSaga" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx_order" name="Place order">
      <bpmn:startEvent id="Tx_start"/>

      <!-- step 1: reserve stock (compensate: release) -->
      <bpmn:serviceTask id="reserveStock" name="Reserve stock">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="reserve-stock" retries="3"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="reserveStock_comp" attachedToRef="reserveStock">
        <bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="releaseStock" name="Release stock" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="release-stock" retries="5"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="a1" associationDirection="One" sourceRef="reserveStock_comp" targetRef="releaseStock"/>

      <!-- step 2: charge card (compensate: refund) -->
      <bpmn:serviceTask id="chargeCard" name="Charge card">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="charge-card" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="chargeCard_comp" attachedToRef="chargeCard">
        <bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="refundCard" name="Refund card" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="refund-card" retries="5"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="a2" associationDirection="One" sourceRef="chargeCard_comp" targetRef="refundCard"/>

      <!-- step 3: confirm shipping — its failure cancels the tx, so steps 1 & 2 compensate in reverse -->
      <bpmn:serviceTask id="confirmShipping" name="Confirm shipping">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="confirm-shipping" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="shipping_err" attachedToRef="confirmShipping">
        <bpmn:errorEventDefinition errorRef="Err_shipping"/></bpmn:boundaryEvent>

      <bpmn:endEvent id="Tx_ok"/>                                  <!-- normal end → commit -->
      <bpmn:endEvent id="Tx_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>

      <bpmn:sequenceFlow id="f1" sourceRef="Tx_start"     targetRef="reserveStock"/>
      <bpmn:sequenceFlow id="f2" sourceRef="reserveStock" targetRef="chargeCard"/>
      <bpmn:sequenceFlow id="f3" sourceRef="chargeCard"   targetRef="confirmShipping"/>
      <bpmn:sequenceFlow id="f4" sourceRef="confirmShipping" targetRef="Tx_ok"/>
      <bpmn:sequenceFlow id="f5" sourceRef="shipping_err" targetRef="Tx_cancel"/>
    </bpmn:transaction>

    <bpmn:boundaryEvent id="Tx_cancelled" attachedToRef="Tx_order">
      <bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:endEvent id="SagaFailed"/>
    <bpmn:endEvent id="SagaDone"/>

    <bpmn:sequenceFlow id="g1" sourceRef="Start"        targetRef="Tx_order"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx_order"     targetRef="SagaDone"/>
    <bpmn:sequenceFlow id="g3" sourceRef="Tx_cancelled" targetRef="SagaFailed"/>
  </bpmn:process>
</bpmn:definitions>
```

If `confirmShipping` fails with `errorCode=SHIPPING_REJECTED`, the error boundary routes to `Tx_cancel`; the transaction cancels; the engine compensates the completed steps in reverse — `refundCard` (undo charge) then `releaseStock` (undo reserve); the cancel boundary then takes `SagaFailed`. (A real model adds an error boundary → cancel on *every* compensatable step whose later-failure should trigger rollback.)

**Why this is canonical, not custom notation.** Every element is standard BPMN 2.0. The only addition is `easy-bpmn:taskDefinition` inside the standard `<extensionElements>` escape hatch — additive, ignorable, round-trippable through any standard modeler (the operative test from `09-easy-bpmn-profile.md`). Cancel events are valid only on transaction subprocesses — exactly the saga boundary. (The example omits `<bpmndi:BPMNDiagram>`; R3 round-trip is therefore a *semantic* round-trip unless DI is generated. Sequence flows carry ids for clean tooling.)

### M1 profile subset (what the validator must accept)

In addition to the existing 4 node types:
- `bpmn:transaction` (the saga scope) with a `startEvent`, supported children, a `none endEvent` (commit), and a `cancelEventDefinition` `endEvent`.
- `bpmn:boundaryEvent` with `compensateEventDefinition` — a **compensation marker**: it is *neither interrupting nor non-interrupting* (the `cancelActivity` axis does not apply), MUST have **zero outgoing sequenceFlow**, and MUST have **exactly one outgoing `<association>`** to an `isForCompensation` activity **in the same transaction scope**.
- `bpmn:boundaryEvent` with `errorEventDefinition` (interrupting) on a service task, routing to a `cancelEventDefinition` end event; `errorRef` MUST resolve to a declared `<bpmn:error>`.
- `bpmn:boundaryEvent` with `cancelEventDefinition` on the `transaction` (interrupting), routing to the failure path.
- `serviceTask isForCompensation="true"` — a handler; not on the normal token path; reachable only via compensation.
- `endEvent` with `cancelEventDefinition` (allowed **only** inside a `transaction`).
- `bpmn:association` (compensation wiring) and `bpmn:error` (root).

Still **rejected** in M1 (deferred, with element id + reason): gateways and any token-splitting >1 outgoing flow (M2/M4), `conditionExpression`/`default` (M2), timer/signal/escalation/conditional events (M3+), `callActivity`/non-transaction `subProcess`/`adHocSubProcess`/multi-instance (M5), `instantiate="true"`, pools/lanes/collaboration/choreography.

> **M1 keeps single-token:** the forward path inside the transaction is linear. An interrupting error boundary event *redirects* the single token to the cancel end event — it is not a parallel split — so the scalar-cursor engine survives M1. Data-driven XOR is M2; true parallelism is M4.

---

## 4. Architecture evolution

### 4.1 Graph IR (`src/bpmn/graph.ts`)

- `GraphNode.outgoing: Flow[]` where `Flow = { flowId, targetId, conditionExpression?, isDefault? }` (M1: ≤1 token-path entry; conditions land in M2).
- New node kinds: `transaction`, `boundaryEvent`; event discriminators: `endEvent.kind: "none"|"cancel"|"compensate"`, `boundaryEvent.kind: "error"|"cancel"|"compensate"|"timer"`, `boundaryEvent.attachedToRef`.
- Scope nesting: a `transaction` node carries `scope: { startId, childIds[], compensations: Record<activityId,{handlerId,boundaryId}> }`.
- `isForCompensation: boolean` on service-task nodes; an `association` map (boundaryId → handlerId).
- **Sequence-flow source/target (and later conditions) and associations become persisted** (today dropped at `validator.ts:331-333`) so topology is queryable and replay-deterministic (§5).

### 4.2 Engine (`src/runtime/engine.ts`) — scope-aware interpreter

Replace the scalar-cursor `loop` (`engine.ts:96-179`) with a scope-aware interpreter:
- A **scope frame** is pushed on entering a `transaction`; it holds the in-scope slice of the saga ledger (§5).
- Forward execution within a scope is single-token in M1.
- **Node dispatch** becomes a registry keyed by node kind (the extension seam every later phase plugs into), not the hard-coded if-chain.
- **Cancel end event** inside a transaction → scope `cancelling` → compensation pass (§4.4) → take the transaction's cancel-boundary outgoing flow.
- **Error boundary event** (interrupting) on a service task → abandon normal continuation, follow the boundary's outgoing flow (per profile → a cancel end event).
- **Uncaught technical exhaustion inside a transaction = Hazard** → terminal incident (NOT auto-compensate); operators may `POST /instances/{id}/cancel` to force compensation. Outside a transaction, exhaustion → terminal incident (today's behavior).

### 4.3 Pull worker model — Service Task becomes an async wait

Largest M1 runtime change. Today `runServiceTask` (`engine.ts:215-365`) calls `invokeSampleWorker` synchronously in a `for` loop. In the pull model a Service Task gains a durable wait state, like a Receive Task:

1. **Persist-before-advance:** create the `service_task_jobs` row (status `created`) before anything external.
2. **Dispatch = make the job leasable** (status `created`, no lock). No outbound call.
3. **Wait = one `step.waitForEvent`** per *logical job* on event type `bpmn_job_<jobId>` (routed through a `workflowEventTypeFor`-style sanitizer; dot-free, ≤100 chars), with timeout `>= retries × (leaseMs + maxBackoff)` so **retries are driven by re-lease**, not by re-entering `waitForEvent` (flat step budget: 1 wait per task). The resume payload is a **discriminated job-result** (below); only the first event consumed wins (Workflow step memoization).
4. A worker leases via `POST /jobs/activate` (bounded long-poll by `taskType`), runs, then `POST /jobs/{jobId}/complete` or `/fail` with its `lockToken`.
5. **Retry (technical):** `fail` with `retryable=true` / no `errorCode`, or **lease expiry** → the job becomes re-leasable; another `activate` hands it out (attempt++). **Business error:** `fail` with an `errorCode` matching a model `bpmn:error/@errorCode` → raise that BPMN error → caught by the error boundary → cancel. Default retry backoff: exponential with jitter (`base`, `factor`, `maxBackoff`), **distinct from lease duration**.
6. **Payload limit:** reject `complete` output exceeding the CF Workflows ~1 MiB event limit *before* `sendEvent` (`assertPayloadWithinLimit`, `payload.ts`). Large outputs ride an R2 reference (deliver only the reference in the event); keep `step.do` results small scalars.
7. **Local timeout handling:** the per-job `waitForEvent` timeout is caught **inside the engine** and routed to the technical-failure branch — it must **not** reach the `process-workflow.ts:41-50` catch-all (which would turn a task-level timeout into a terminal incident, bypassing compensation).
8. **Un-leasable jobs (DLQ):** a job whose `taskType` nobody polls gets a **job-level activation TTL**; on expiry → terminal incident (`kind=timeout`) + operator alert (this single job-level TTL exists in M1 even though general timers are M3). Poison jobs (output repeatedly un-applicable) → terminal incident, distinct from a business-error→cancel.

**Job-result event schema** (`src/contracts/workflow-events.ts`): `{ outcome: "completed", output } | { outcome: "failed", retryable: boolean, errorCode?: string, reason: string }`.

**Job leasing (verified D1-compatible).** `UPDATE...LIMIT n RETURNING` does **not** parse on D1 (live-verified, code 7500). Use the IN-subquery form, with the lease guard in **both** the subquery and the outer `WHERE` (D1's single-writer serializes activates so two cannot double-claim):
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
A per-`taskType` Durable Object is **not** required for M1. `complete`/`fail` are **`lock_token`-conditional updates** (`... WHERE job_id=? AND lock_token=?`) that rotate/clear the token: a stale worker (expired lease, re-leased elsewhere) matches 0 rows and is rejected; a duplicate (same token) matches 0 rows and returns the stable prior outcome.

> **Forward workers are at-least-once too.** Lease expiry can run a step twice (A's lease expires mid-run, B re-leases and runs). `lock_token` rejects A's stale `complete`, but A's *effect* already happened. Therefore **forward workers MUST be idempotent on `jobId`** (same requirement as compensators), and the surviving completion's `capturedOutput` is the compensation basis.

The `WorkerRequest`/`WorkerResult` shapes (`service-task.ts:8-20`) become the HTTP activate/complete/fail contract (§6), gaining `isCompensation`, `errorCode?`, `lockToken`, `traceId`, and (for compensation) `originalInput` + `capturedOutput`.

### 4.4 Compensation algorithm (reverse-order, scoped, crash-safe)

**Ledger write is atomic with advance.** A `saga_steps` row for a completed-compensatable step is written in the **same `dbBatch`** as `jobCompleteStmt` + `applyTransition` (extend persist-before-advance to include the ledger), created **only at forward completion**, carrying `captured_input` AND `captured_output` — never a dispatch-time placeholder. The write is **`INSERT OR IGNORE`** against `uq_saga_steps_forward (instance_id, element_id)`, so a duplicate completion / replay is a no-op (no double-compensation). This closes the orphaned-effect hole (advance-then-crash-before-ledger) and the double-row hole.

On transaction cancellation:
1. Select the scope's ledger rows in **descending `seq`** (reverse completion order) with `compensation_status IN ('pending','compensating','failed')`.
2. For each row with a compensation handler: create/reuse a **compensation job** (separate lane, §5) seeded with `originalInput` + `capturedOutput`; wait for its callback (same pull mechanism, `isCompensation=true`). A row already `compensating` **re-attaches to its existing `compensation_job_id`** (never creates a second comp job) — the replay-recovery rule.
3. **Idempotent + at-least-once:** each compensation job has idempotency key (`scope='compensate'`, `instanceId:elementId:compensate`); duplicate callbacks return the stable prior outcome.
4. Runs **sequentially in reverse** in M1 (parallel-branch compensation is M4). A handler that itself fails retries per its own `retries`; on exhaustion → status `compensationFailed`, history `compensationFailed`, operator alert; the reverse pass **stops** at the failed step (the already-compensated suffix stays compensated; the ledger shows exactly how far it got). Operator remediation (`/retry`) resumes from there.
5. On full success → status `compensated`, then follow the cancel-boundary outgoing flow to the failure end event — settling to a **saga-failed terminal status WITHOUT calling `completeInstance`** (which would clobber `compensated`/`compensationFailed` into `completed`, `engine.ts:583`).

### 4.5 Failure taxonomy (M1 minimal, full in M3)

- **Technical failure** (`fail retryable=true` / no `errorCode`, or lease/timeout): retryable via re-lease; counts against `retries`. Exhaustion inside a transaction = **Hazard** → terminal incident (operator may `/cancel` to compensate). Outside → terminal incident.
- **Business error** (`fail` with `errorCode` matching `bpmn:error/@errorCode`): not retried; raises the BPMN error → the error boundary (matched by `errorRef → bpmn:error/@id`) → cancel end → compensation.

`errorRef`/boundary catching is by the Error's **`@id`** (QName); the worker's `fail.errorCode` matches the Error's **`@errorCode`** (wire value). Richer error catalogs and per-error routing beyond cancel are M3.

### 4.6 Status lifecycle (explicit transition table)

`process_instances.status` widens to add `compensating`, `compensated`, `compensationFailed`, `cancelled`. Allowed one-way transitions (anything else is rejected):

```
starting → running
running  ⇄ waiting
running  → completed            (none end event → commit)
running|waiting → compensating  (cancel end event | error boundary→cancel | operator /cancel)
compensating → compensated      (reverse pass fully succeeds)
compensating → compensationFailed (a compensator exhausts retries)
compensationFailed → compensating (operator /retry — the one resumable edge)
compensated|compensationFailed → (terminal saga-failed; settled via the cancel-boundary path, NOT completeInstance)
running|waiting → cancelled      (operator /cancel with an EMPTY ledger — nothing to compensate)
```
Crash-recovery: the reverse cursor is re-derived from the ledger (`compensation_status IN ('pending','compensating','failed') ORDER BY seq DESC`); a `compensating` row re-attaches to its existing `compensation_job_id`.

### 4.7 Idempotency / at-least-once additions

- New `idempotency_records.scope` value: `compensate`. Forward `complete`/`fail` use scope `workerCallback` keyed by `jobId+lockToken` so a duplicate `fail` returns the prior outcome **instead of re-counting an attempt** (the premature-exhaustion bug).
- **Single-advance guarantee** is Cloudflare Workflow **step memoization** of the resume step — the HTTP-side `lock_token`-conditional update only suppresses redundant `sendEvent`.
- **`sendEvent` to a terminal/not-running instance throws** → gate on D1 first (terminal job/instance → ACK without sending) and wrap `sendEvent` so a "not running"/errored throw is a **200 no-op ack**, never a 500 (else at-least-once workers retry forever → permastuck).
- **Operator verbs are guarded:** `/cancel` is a status-conditional transition (`SET status='compensating' WHERE status IN ('running','waiting')`) so only the first call initiates one reverse pass; `/retry` is a conditional reset keyed on the current incident/failed status.

---

## 5. Data model deltas (D1 — `migrations/0002_saga.sql`+)

Additive migrations; never mutate published versions.

**Relax the compensation blocker + add the pull lease.** `uq_jobs_instance_element` (`0001:122-123`) forbids a second job per element — it blocks compensation. A **compensation job carries `element_id` = the *forward* (compensated) element id** with `is_compensation=1` and `compensates_element_id` set, so uniqueness is one-forward + one-compensation per forward element **regardless of handler reuse** (one handler may compensate several steps):
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
> Note: gateways/loops/multiInstance (M2/M4/M5) re-break this index (same element runs N times) and will need a token/iteration discriminator — this shape is **not** stable past M1.

**Operator retry RESETS the existing job row** (`status→created`, new `lock_token`, attempt accounting) rather than inserting (mirroring the forward reuse at `engine.ts:250`).

**The saga ledger (completed-step stack):**
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
  compensation_status     TEXT NOT NULL,     -- pending|notRequired|compensating|compensated|failed (exists only for completed forward steps)
  trace_id                TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_saga_steps_forward ON saga_steps (instance_id, element_id);  -- INSERT OR IGNORE at completion
CREATE INDEX idx_saga_steps_scope ON saga_steps (instance_id, scope_id, seq);
```

**Incidents gain remediation linkage:** add `kind` (`serviceTaskFailure|compensationFailure|timeout`) and `resolution` (`open|compensating|compensated|operatorResolved`) so an incident can drive/track compensation instead of dead-ending.

**Instance listing:** add `idx_instances_workspace_status (workspace_id, status)` to back the new list endpoint (find stuck/compensating sagas).

**`history_events.type`** is free-text (`0001:199`) — absorbs `transactionEntered`, `compensationStarted/Completed/Failed`, `transactionCancelled`, `jobActivated`, `jobCompleted/Failed`, `traceId` in `diagnostics` with zero schema change.

**Stub tables (created in M2–M4 migrations; named here for the roadmap):** `gateway_decisions` (M2 — deterministic replay of branch choices), `timers` (M3), `execution_tokens` (M4 — the single `current_element_id` becomes one token among many; implement against the token lifecycle in `docs/bpmn/07-execution-semantics.md`).

---

## 6. API deltas

Added to the flat router (`index.ts route()`, `:385-417`). **All** request bodies zod-validated; new endpoints get real response zod schemas (today responses are un-validated interfaces — closing that gap is M1 work).

**Worker authentication & workspace isolation.** Every `/jobs/*` call carries a per-workspace worker credential (e.g. `Authorization: Bearer <token>`). The server **derives `workspaceId` from the credential** and rejects `taskType` claims outside that workspace — the body never carries a trusted `workspaceId` for job access. Credentials live in a new `worker_credentials` table (`workspace_id, token_hash, created_at, revoked_at`).

**Pull worker (forward + compensation share the lane; `isCompensation` distinguishes):**
- `POST /jobs/activate` — `{ taskType, workerId, maxJobs?, leaseMs?, waitMs? }` (bounded long-poll up to `waitMs`) → `{ jobs: [{ jobId, instanceId, elementId, taskType, isCompensation, attempt, lockToken, traceId, variables, originalInput?, capturedOutput? }] }`. Atomic IN-subquery claim (§4.3).
- `POST /jobs/{jobId}/complete` — `{ lockToken, outputVariables }` → `lock_token`-conditional → (if instance live) `sendEvent(bpmn_job_<jobId>)`, else no-op ack. Idempotent; payload-limit checked.
- `POST /jobs/{jobId}/fail` — `{ lockToken, reason, errorCode?, retryable? }` → technical retry vs business error (§4.5). Idempotent via `workerCallback` record.

**Operator verbs (relax the view-only terminal incident, FR-025):**
- `POST /instances/{id}/cancel` — operator-triggered transaction cancellation → compensation. Status-guarded (§4.7).
- `POST /instances/{id}/retry` — retry a failed forward step (incident) or a `compensationFailed` step. Status-guarded; resets the job row.
- `GET /instances?workspaceId=&status=&limit=&cursor=` — **filterable list** so operators can find `compensating` / `compensationFailed` / `incident` sagas (the headline operator story has no discovery path today). Backed by `idx_instances_workspace_status`.

**Saga visibility:** `GET /instances/{id}` extended with a `saga` block: phase (`forward|compensating|compensated|compensationFailed`), per-step status from `saga_steps`, which steps were compensated, and the `traceId`. Existing `ProcessInstanceInspection` is retained.

**Cross-service observability:** a `traceId` (derived from `instanceId`) + per-step `spanId` are propagated into activate/complete/fail payloads and recorded in `history_events.diagnostics` + `saga_steps`. Consider W3C `traceparent` passthrough so worker-side APM correlates. M1 metrics named (per-`taskType` job latency, retry counts, compensation outcomes); full dashboards deferred.

The API must still **not** leak Workflow internals (no `workflowInstanceId` from worker/operator callers).

---

## 7. Governance (M0)

Per the constitution's versioning policy ("MAJOR = expand product scope in a way that invalidates existing governance"), this is **1.0.0 → 2.0.0**.

- **Amend `.specify/memory/constitution.md`:**
  - Rewrite **Principle I** to widen the profile to the SAGA construct set **while preserving** the "no custom notation / XSD-valid / round-trippable" clause (the reason decision #1 is canonical BPMN, not an extension hack).
  - Trim the **MVP Scope** exclusion list to remove only the constructs each *shipped* phase adds.
  - Add a principle (mirroring III/IV): **SAGA / Compensation Integrity** — compensation MUST run in reverse completion order, be idempotent + at-least-once, scope to its transaction, and have a deterministic outcome when a compensator fails (`compensationFailed` + operator remediation); compensation is triggered only by transaction Cancel, never by an uncaught Error (Hazard).
  - Add a **Sync Impact Report** header + version-bump rationale; propagate to `.specify/templates/*`.
- **Open Spec Kit feature `specs/002-saga-orchestrator`** (`spec/plan/research/data-model/contracts`). Each plan passes the Constitution Check before Phase 0 and after Phase 1. Every runtime/persistence/API change ships contract/integration tests for the constitution-critical behaviors (compensation ordering, saga state transitions, remote worker contract, manual remediation, worker auth/isolation).
- **Update `docs/bpmn/09-easy-bpmn-profile.md`** to the new profile and **fix the stale "one Durable Object per instance"** line. Cite the target semantics per later phase: M2 → `03-gateways.md`, M3 → `01-events.md`, M4 → `07-execution-semantics.md`, M5 → `02-activities.md`.

---

## 8. Phase roadmap (milestones)

Each milestone is independently shippable. **M1 alone satisfies the literal "SAGA orchestrator for multiple microservices" ask.**

| Milestone | Scope | Difficulty | Exit criteria (integration tests) |
|-----------|-------|------------|-----------------------------------|
| **M0 Governance & profile widening** | Constitution 2.0.0 + Sync Impact + new principle; spec `002`; validator reject→accept-and-validate for the M1 set; `profile.ts` widening; docs/bpmn/09 update (+ fix DO-per-instance). No runtime behavior. | M | The §3 example **publishes**; each still-unsupported construct rejected with element id + reason; foreign-ns/DI/`documentation` tolerated; §3 example round-trips (semantic) through bpmn-js. |
| **M1 Canonical transaction-saga (multi-microservice)** | Pull workers + `activate/complete/fail` + **auth/isolation**; Service Task as async wait (lease-driven retries, local timeout, job-result discriminator); `transaction` scope; compensation boundary/handler/association; error boundary → cancel end → cancel boundary; reverse-order scoped compensation (ledger atomic with advance); `compensationFailed`; operator `cancel`/`retry`/**list**; saga view + `traceId`; widened status enums + transition table; saga ledger + compensation job lane + incidents kind/resolution + response schemas + DLQ TTL/backoff. **No** gateways/parallel/timers; single-token. | **XL** | Happy saga commits; a business error mid-saga compensates completed steps in reverse and reaches the failure end; compensator failure → `compensationFailed` + operator retry resumes; duplicate `complete` AND duplicate `fail` advance at most once; late callback to a terminal instance is a no-op ack (not permastuck); a cross-tenant `activate` is rejected; a remote worker drives a step end-to-end; **a v1 instance mid-saga compensates via v1's graph after v2 publishes**. |
| **M2 Conditional sagas** | Multi-edge IR + persisted conditions; `exclusiveGateway` + `default`; condition expression engine; `gateway_decisions` audit + deterministic replay. (Target semantics: `docs/bpmn/03-gateways.md`.) | L | Data-driven branch selects the right path; decisions replay-stable; ambiguous/no-match deterministic. |
| **M3 Time & failure taxonomy** | `timers` (boundary timer, per-step timeout, event deadline) via `step.sleep`/DO alarms; technical-vs-business error catalog; timeout behavior (incident / alt-path / compensation); optional per-model buffer TTL. (`docs/bpmn/01-events.md`.) | L | A step timeout fires the configured path; a boundary timer interrupts and compensates; business vs technical errors route distinctly. |
| **M4 Concurrency** | `parallelGateway` split/join; concurrent token set (`execution_tokens`); AND-join barrier; compensation for partially-completed parallel branches; CF-Workflows concurrency strategy. (`docs/bpmn/07-execution-semantics.md`.) | XL | Parallel branches run concurrently and join; failure in one branch compensates all completed branches correctly. |
| **M5 (optional) Composition** | `callActivity`, nested non-transaction `subProcess`, `multiInstance` (parallel over a collection), `signal`/`escalation`. (`docs/bpmn/02-activities.md`.) | XL | Reusable sub-saga invoked; multi-instance fan-out compensates each instance. |

---

## 9. Open questions (deferred, tracked — not dropped)

- **M2 — expression language:** standard **FEEL** (portable, canonical, heavy to embed) vs a restricted JSONLogic/JS-subset evaluator (light, non-standard). Regardless of language, persist the *evaluated* decision in `gateway_decisions` for deterministic replay/audit.
- **M3 — timeout behavior:** when a per-step/boundary timer fires, default to an alternate BPMN path if modeled, else compensation; whether the broker's fixed 1h buffering TTL becomes per-model configurable.
- **M4 — concurrency strategy on CF Workflows:** how to express a concurrent token set within one Workflow (parallel `step.do` vs child workflows) while keeping replay-safety and the ≤1 MiB event / ≤1 GB cumulative state limits.
- **M1 — worker SDK shape:** M1 ships the long-poll HTTP contract + a sample worker loop; whether a thin client SDK is in M1 or a fast-follow.

---

## 10. Risks

- **R1 — Engine rewrite blast radius (M1):** the scope-aware interpreter + Service-Task-as-wait touches the heart of `engine.ts`. Keep the `runStep`/`waitFor` ports (`engine.ts:50-55`) + the `DirectExecutor` test harness (`executor.ts:40-57`) so every primitive stays unit-testable inline; node-kind dispatch registry isolates each construct.
- **R2 — Compensation correctness:** reverse order, idempotency, partial-failure are easy to get subtly wrong. The `saga_steps` ledger (written atomically with advance, `INSERT OR IGNORE`) is the single source of truth; integration tests per failure shape; adversarial review.
- **R3 — Canonicity drift:** the §3 example must round-trip (semantically) through bpmn-js as a publish-time test (the operative test).
- **R4 — Pull lease races:** atomic IN-subquery claim + `lock_token` validation on `complete`/`fail` + lease-expiry reclaim (`lock_expires_at < now`).
- **R5 — CF Workflows limits:** ≤1 MiB per event; **≤1 GB cumulative persisted state per instance** (every `waitForEvent` payload + `step.do` result persists for the instance's life) — keep step results small, push large worker outputs to R2 references; set `wrangler.jsonc` workflow `limits.steps` headroom (e.g. 25000) for long saga + reverse pass; note Workers Free (1,024 steps) is inadequate (DOs already force Paid).
- **R6 — Cross-tenant exfiltration via pull endpoints:** mitigated by per-workspace worker credentials with server-derived `workspaceId` (§6, decision #6).

---

## 11. Backlog mapping (Backlog.md milestones → tasks)

- **Milestones:** `M0`–`M5` (created).
- **Detailed tasks now:** M0 + M1, each with acceptance criteria and a required contract/integration test (constitution gate).
- **M1 task set** (≈16): (1) profile/validator accept-and-validate saga subset + bpmn:error/association/boundary/cancel parsing; (2) graph-IR multi-edge + scope + boundary/association + persist topology; (3) saga ledger migration + relaxed unique index + lease/DLQ columns + incidents kind/resolution + list index; (4) pull worker auth/credentials + workspace isolation; (5) `POST /jobs/activate` long-poll + atomic IN-subquery lease; (6) `complete`/`fail` idempotent (lock_token-conditional) + job-result schema + Service-Task-as-wait engine change + local timeout + terminal no-op ack; (7) compensation pass (reverse, scoped, atomic ledger, replay recovery); (8) cancel/error boundary execution + Hazard vs Cancel; (9) `compensationFailed` policy + status transition table; (10) operator `cancel`/`retry` verbs (guarded); (11) `GET /instances` list + saga view on `GET /instances/{id}` + response zod schemas; (12) widened status enums + contracts; (13) idempotency `compensate` scope + forward `workerCallback` keying; (14) trace-id propagation + saga history events; (15) retry backoff + un-leasable-job DLQ TTL + poison-job handling; (16) sample forward + compensation workers + quickstart saga scenarios (happy, business-error→compensate, compensator-fail, duplicate callbacks, cross-tenant reject, version-binding-during-compensation).
- **M2–M5:** one epic stub task each, linking the relevant gap, §8 row, and the cited `docs/bpmn` target semantics.

**Next step after backlog:** `specs/002-saga-orchestrator` Spec Kit spec + `writing-plans` for M1.
