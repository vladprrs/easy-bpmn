# Feature Specification: SAGA Orchestrator

**Feature Branch**: `002-saga-orchestrator`

**Created**: 2026-06-08

**Status**: Draft

**Input**: User description: "Evolve easy-bpmn from the linear MVP into a full,
orchestration-based SAGA orchestrator for many microservices: a central durable
coordinator drives a sequence of local transactions across distinct remote
microservices and, on failure, executes the compensating transactions for already
completed steps in reverse order, then settles the instance into a defined terminal
state — modeled in canonical BPMN, with pull workers and operator visibility."

This specification covers **Milestone M1 — Canonical transaction-saga
(multi-microservice)**, which alone satisfies the literal "SAGA orchestrator for
multiple microservices" ask. M2 (conditional sagas), M3 (time/failure taxonomy),
and M4 (concurrency) have since shipped — the M4 concurrency section is appended
below; **M5 (composition)** is the current (and last) roadmap milestone, opened by
the constitution v2.5.0 amendment and decomposed into five runtime layers
(M5-L1…L5) — the **M5-L1 (embedded scopes + hierarchical exceptions)** section is
appended below and has since shipped, and **M5-L2 (`callActivity` reusable
sub-sagas)** has likewise shipped (governance record:
`specs/002-saga-orchestrator/m5-L2-constitution-check.md`; design:
`docs/superpowers/specs/2026-07-02-m5-l2-callactivity-design.md`); M5-L3…L5 remain
pending.

## Constitution Alignment *(mandatory)*

**BPMN Profile Impact**: This feature widens the executable profile from the linear
core (None Start Event, Service Task, Receive Task, None End Event, Sequence Flow,
Message) to the **canonical transaction-saga construct set**, as added to Principle I
(Standard BPMN Profile Only) by constitution v2.0.0. It accepts and validates, in
addition to the linear core: `bpmn:transaction` (the saga scope) with a start event,
supported children, a none end event (commit), and a `cancelEventDefinition` end
event; `bpmn:boundaryEvent` with a `compensateEventDefinition` (compensation marker),
an `errorEventDefinition` (interrupting, on a Service Task), or a
`cancelEventDefinition` (interrupting, on the transaction); a `serviceTask
isForCompensation="true"` compensation handler; `bpmn:association` (compensation
wiring); and a root `bpmn:error`.

The widening **preserves the "no custom notation" clause verbatim in intent**: the
only additive binding is `easy-bpmn:taskDefinition` (the Service Task `type` routing
key plus `retries`) carried inside the standard `<bpmn:extensionElements>` escape
hatch — additive, ignorable, introducing no new MODEL-namespace tag, no redefinition
of a standard element's runtime meaning, and no non-standard attribute required to
parse. Every accepted file MUST stay valid against the BPMN 2.0 XSD and round-trip
(semantically) through a standard modeler (bpmn-js / Camunda Modeler) when the
`easy-bpmn` extensions and Diagram Interchange are ignored. Unsupported
standard-namespace flow nodes are rejected before publish with the offending element
id and a user-visible reason; ignorable extension content (foreign-namespace
`<extensionElements>`, Diagram Interchange, `documentation`, text annotations) is
tolerated and ignored, never a reason to reject.

**SAGA / Compensation Impact**: This feature is the realization of Principle VI
(SAGA / Compensation Integrity). When a transaction-saga is cancelled, the
orchestrator compensates the transaction's successfully completed activities **in
reverse completion order**, scoped to that transaction. Each compensating action is
**idempotent** and safe under **at-least-once** delivery (duplicate compensation
callbacks MUST NOT compensate twice), and receives **both** the original step input
and the captured step output. Compensation is triggered **only** by a transaction
Cancel — an error boundary event routing to a cancel end event, or an operator
cancel — and **never** by an uncaught Error: an Error reaching the transaction
boundary uncaught is a **Hazard** that terminates the instance and propagates, it
does not auto-compensate. A compensator that exhausts its own retries settles the
instance into a deterministic, operator-visible terminal state (`compensationFailed`)
with operator-resumable remediation; it never silently blocks forever. Each
meaningful saga transition is written to D1 audit history.

**Definition Versioning Impact**: Published definition versions remain immutable.
Each process instance binds to exactly one version and one Cloudflare Workflow
instance for life, which yields a **deterministic compensation graph** with no
migration ambiguity: an instance that began under v1 compensates via v1's graph even
after v2 is published. Editing a draft creates a new version, never mutating a
published one. The saga construct set adds no migration capability.

**Runtime Idempotency Impact**: Pull-worker job delivery, `complete`/`fail`
callbacks, compensation callbacks, Workflow event delivery, lease expiry/reclaim, and
operator verbs are treated as at-least-once inputs. Forward workers and compensators
MUST both be idempotent on `jobId` (lease expiry can run a step twice). A duplicate
`complete` or `fail` returns the stable prior outcome and advances the instance at
most once; the single-advance guarantee rests on Cloudflare Workflow step
memoization, while the HTTP-side `lock_token`-conditional update suppresses redundant
event delivery. A new `compensate` idempotency scope and a forward `workerCallback`
keying by `jobId + lockToken` prevent a duplicate `fail` from re-counting an attempt.

**Receive Task Correlation Impact**: Unchanged from the MVP. The single Durable
Object correlation broker keyed by `workspaceId + messageName + correlationKey`
remains the coordination atom for any Receive Task in a saga; at most one active
eligible subscription per broker key; early messages buffered for the fixed one-hour
TTL. M1 adds no new correlation semantics — the new pull-worker wait uses per-job
Workflow events, not the broker.

**Audit and Operator Visibility Impact**: History gains saga lifecycle events
(`transactionEntered`, `transactionCancelled`, `compensationStarted`,
`compensationCompleted`, `compensationFailed`, `jobActivated`, `jobCompleted`,
`jobFailed`) plus a `traceId` for cross-service correlation. `GET /instances/{id}`
gains a `saga` block (phase, per-step compensation status, which steps compensated,
traceId). A new filterable `GET /instances` list lets operators discover stuck
`compensating` / `compensationFailed` / `incident` sagas. Operators gain `cancel`,
`retry`, and `list` verbs (the MVP incident view was view-only; FR-025 is relaxed for
sagas).

**Demo Flow Impact**: The original demo flow (upload → publish → start → Service Task
→ receive message → complete → history) is preserved unchanged. This feature adds the
saga demo flow: publish a `transaction` saga, start an instance, have **remote**
microservices pull and run forward jobs, observe a commit on the happy path or a
reverse-order compensation on a business failure, and inspect the saga view and
history. The Service Task changes from a synchronous platform-provided sample call to
an **async pull/lease** model; a sample forward worker and a sample compensation
worker remain provided so the demo runs without bespoke services.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Commit a Multi-Microservice Saga on the Happy Path (Priority: P1)

A backend or platform developer publishes a canonical `transaction` saga whose forward
steps (reserve stock, charge card, confirm shipping) are each a Service Task routed by
`easy-bpmn:taskDefinition type` to a distinct remote microservice. The developer starts
an instance; each microservice leases its job by `taskType`, runs its local
transaction, and completes the job; the transaction reaches its none end event and the
instance commits.

**Why this priority**: This is the core product bet for the scope expansion: a central
durable coordinator drives local transactions across many independent microservices
that the orchestrator does not address directly, with no Camunda/Zeebe operations.

**Independent Test**: Publish the §3 order-saga, start an instance, drive each forward
job to `complete` via the pull API from separate worker identities, and observe the
instance reach `completed` with the saga view showing all steps forward and committed.

**Acceptance Scenarios**:

1. **Given** a published `transaction` saga with three forward Service Tasks, **When**
   the developer starts an instance, **Then** the instance enters the transaction
   (`transactionEntered` recorded) and the first forward job becomes leasable.
2. **Given** a leasable forward job, **When** a worker calls `POST /jobs/activate` with
   the matching `taskType`, **Then** it receives the job with a `lockToken`, `attempt`,
   `traceId`, and input `variables`, and the job becomes `locked`.
3. **Given** a leased forward job, **When** the worker calls `POST /jobs/{jobId}/complete`
   with the valid `lockToken` and output variables, **Then** the output is persisted, a
   `saga_steps` ledger row is written atomically with the advance, and the instance
   advances to the next forward step.
4. **Given** all forward steps completed, **When** the transaction reaches its none end
   event, **Then** the instance status becomes `completed` and the saga view phase is
   `forward` with every step committed.

---

### User Story 2 - Compensate a Failed Saga in Reverse Order (Priority: P1)

A forward step fails with a **business** error (a `fail` carrying an `errorCode` that
matches a modeled `bpmn:error/@errorCode`). The error boundary event routes the single
token to the transaction's cancel end event; the transaction cancels; the orchestrator
runs the compensation handlers for the already-completed steps **in reverse completion
order**; on success the cancel boundary event takes the saga-failed path and the
instance settles to a failed terminal state.

**Why this priority**: Reverse-order compensation is the defining behavior of a saga;
without it the orchestrator is not a saga orchestrator. This is the headline value.

**Independent Test**: Drive `reserveStock` and `chargeCard` to `complete`, then `fail`
`confirmShipping` with `errorCode=SHIPPING_REJECTED`; observe compensation jobs
dispatched for `refundCard` then `releaseStock` (reverse of completion), each carrying
`originalInput` + `capturedOutput` with `isCompensation=true`, then the instance reach
the saga-failed end via the cancel boundary path.

**Acceptance Scenarios**:

1. **Given** completed `reserveStock` and `chargeCard` steps and a `confirmShipping`
   forward job, **When** the worker fails it with `errorCode=SHIPPING_REJECTED`, **Then**
   the modeled error boundary routes to the cancel end event and the instance status
   becomes `compensating` (`transactionCancelled` recorded).
2. **Given** the transaction is cancelling, **When** the compensation pass runs, **Then**
   it selects the scope's ledger rows in descending completion order and dispatches a
   compensation job for `refundCard` **before** one for `releaseStock`.
3. **Given** a dispatched compensation job, **When** it is leased, **Then** its payload
   carries `isCompensation=true`, the forward step's `originalInput`, and its
   `capturedOutput`.
4. **Given** all compensation handlers complete, **When** the reverse pass finishes,
   **Then** the instance status becomes `compensated`, the cancel boundary event takes
   the saga-failed path, and the instance settles to the failed terminal state **without**
   clobbering the `compensated` status into `completed`.

---

### User Story 3 - Remediate a Compensator That Exhausts Its Retries (Priority: P2)

During the reverse pass, a compensation handler itself fails until its own retries are
exhausted. The instance settles into the terminal `compensationFailed` state with an
operator alert; the reverse pass stops at the failed step (the already-compensated
suffix stays compensated). An operator calls `POST /instances/{id}/retry`, which resumes
the reverse pass from the failed step.

**Why this priority**: A saga is only safe if a compensator failure has a deterministic,
operator-visible outcome rather than silently blocking forever (Principle VI).

**Independent Test**: Force `refundCard`'s compensation to exhaust retries; observe the
instance reach `compensationFailed` with `releaseStock` still pending; then `POST /retry`
and observe the reverse pass resume and reach `compensated`.

**Acceptance Scenarios**:

1. **Given** a compensation job that fails repeatedly, **When** its retries are
   exhausted, **Then** the instance status becomes `compensationFailed`, a
   `compensationFailed` history event and an incident (`kind=compensationFailure`) are
   recorded, and the reverse pass stops at that step.
2. **Given** a `compensationFailed` instance, **When** an operator calls
   `POST /instances/{id}/retry`, **Then** the failed compensation job row is reset and the
   instance returns to `compensating` (the one resumable transition).
3. **Given** the resumed reverse pass, **When** the previously-failed compensator now
   succeeds, **Then** the pass continues to the remaining steps and the instance reaches
   `compensated`.

---

### User Story 4 - Tolerate Duplicate and Late Worker Callbacks (Priority: P2)

At-least-once delivery means `complete` and `fail` callbacks, and callbacks to an already
terminal instance, can arrive more than once or too late. The runtime advances at most
once and never permanently sticks.

**Why this priority**: Pull workers and the network are at-least-once; without idempotent
callbacks a duplicate or late delivery would double-advance, double-compensate, or wedge
the instance in a retry loop.

**Independent Test**: Complete a forward job twice with the same `lockToken`; fail a job
twice; then deliver a `complete` to a job whose instance has already terminated — observe
a single advance, a stable repeated outcome, and a 200 no-op acknowledgement for the late
callback.

**Acceptance Scenarios**:

1. **Given** a forward job completed once, **When** the same `complete` with the same
   `lockToken` is sent again, **Then** the response is the stable prior outcome and the
   instance does not advance a second time.
2. **Given** a forward job failed once, **When** the same `fail` is sent again, **Then**
   the prior outcome is returned and the attempt count is not incremented again.
3. **Given** a worker holding a stale `lockToken` (its lease expired and the job was
   re-leased elsewhere), **When** it calls `complete`, **Then** the conditional update
   matches zero rows and the callback is rejected without advancing.
4. **Given** an instance that has already reached a terminal status, **When** a late
   `complete`/`fail` for one of its jobs arrives, **Then** the API gates on D1, returns a
   `200` no-op acknowledgement, and never raises a `500` or wedges the at-least-once
   worker into a permastuck retry loop.

---

### User Story 5 - Reject Cross-Tenant Job Access (Priority: P3)

Each `/jobs/*` call carries a per-workspace worker credential. The server derives
`workspaceId` from the credential and never trusts a body `workspaceId` for job access,
so a worker authenticated for workspace A cannot lease or affect workspace B's jobs.

**Why this priority**: The pull endpoints hand out job payloads (business variables) to
whoever polls; without credential-derived workspace isolation they would be a
cross-tenant exfiltration vector.

**Independent Test**: With a credential for workspace A, call `POST /jobs/activate` for a
`taskType` that only exists in workspace B; observe zero jobs returned (no leakage), and a
forged body `workspaceId` is ignored.

**Acceptance Scenarios**:

1. **Given** a worker credential scoped to workspace A, **When** it activates a `taskType`
   whose only jobs belong to workspace B, **Then** no jobs are returned and no workspace B
   payload is exposed.
2. **Given** a `/jobs/*` request whose body asserts a `workspaceId` different from the
   credential's, **When** the server processes it, **Then** the body `workspaceId` is
   ignored and access is evaluated against the credential-derived workspace only.
3. **Given** a missing or revoked credential, **When** any `/jobs/*` endpoint is called,
   **Then** the request is rejected as unauthorized.

---

### User Story 6 - Compensate a Mid-Saga Instance via Its Bound Version (Priority: P3)

A v1 instance is mid-saga (some forward steps completed) when a v2 of the definition is
published. The in-flight instance must compensate using **v1's** compensation graph, not
v2's, because it is bound to v1 for life.

**Why this priority**: Immutable version binding (Principle II) must hold *through
compensation*, otherwise a republish during an outage could silently change how in-flight
sagas roll back — a correctness and audit hazard.

**Independent Test**: Start an instance on v1, complete one forward step, publish v2 with a
different compensation wiring, then trigger cancellation on the v1 instance; observe it
compensate via v1's handlers and the history reference only v1.

**Acceptance Scenarios**:

1. **Given** a v1 instance with one completed forward step, **When** v2 is published with
   different compensation associations, **Then** the running instance remains bound to v1.
2. **Given** that v1 instance is then cancelled, **When** the reverse pass runs, **Then**
   it uses v1's compensation handlers and `taskType`s, and history/saga view reference only
   the v1 definition version.

### Edge Cases

**Rejected before publish, each with element id + reason** (still unsupported in M1):

- Any gateway (`exclusiveGateway`, `parallelGateway`, `inclusiveGateway`,
  `eventBasedGateway`, `complexGateway`) or any flow node with **more than one outgoing
  sequence flow** (token splitting) — M2/M4.
- `conditionExpression` on a sequence flow, or a `default` flow — M2.
- Timer, signal, escalation, or conditional event definitions (start, boundary,
  intermediate, or end) — M3+.
- `callActivity`, a non-transaction `subProcess`, `adHocSubProcess`, or any
  multi-instance / loop characteristics — M5.
- `instantiate="true"` (or any non-API instantiation path) on a Receive Task or event —
  instances start only via the API.
- Pools / lanes / `collaboration` / `choreography` / `participant` — out of profile.
- A `compensateEventDefinition` boundary event that has any outgoing sequence flow, or
  that lacks exactly one outgoing `<association>` to an `isForCompensation` activity in
  the same transaction scope.
- An `errorEventDefinition` boundary event whose `errorRef` does not resolve to a declared
  root `<bpmn:error>`.
- A `cancelEventDefinition` end event or boundary event **outside** a `bpmn:transaction`
  (cancel events are valid only on transaction scopes).

**Tolerated and ignored, never a reason to reject**:

- Foreign-namespace `<extensionElements>` (`camunda:`, `zeebe:`, …) — read opportunistically
  if present, never required.
- Diagram Interchange (`bpmndi:*`, `omgdc:*`, `omgdi:*`).
- `documentation` elements and text annotations.

**Runtime edge cases**:

- A forward step whose lease expires mid-run is re-leased and may run twice; the stale
  worker's `complete` is rejected by `lock_token` but its effect already happened, so the
  surviving completion's `capturedOutput` is the compensation basis (forward workers MUST
  be idempotent on `jobId`).
- A job whose `taskType` nobody polls expires at its job-level activation TTL → terminal
  incident (`kind=jobActivationTimeout`) + operator alert (the single job-level TTL that exists in M1
  even though general timers are M3).
- A `complete` output (or message/worker payload) exceeding the Cloudflare Workflows
  ~1 MiB event limit is rejected explicitly **before** event delivery, not failed inside
  the runtime; large outputs ride an R2 reference.
- An uncaught technical exhaustion **inside** a transaction is a Hazard → terminal incident,
  NOT auto-compensation; an operator may `POST /instances/{id}/cancel` to force the reverse
  pass. Outside a transaction, exhaustion → terminal incident (MVP behavior).
- An operator `cancel` on an instance with an **empty** ledger (nothing completed yet) goes
  straight to `cancelled` (nothing to compensate).
- A second operator `cancel` on an already-`compensating` instance is a no-op (the verb is
  status-conditional, so only the first call initiates one reverse pass).

### Canonical saga round-trip target

The following file is the M1 canonicity target: it MUST publish, and it MUST round-trip
(semantically) through bpmn-js / Camunda Modeler when the `easy-bpmn` extensions and
Diagram Interchange are ignored. (DI is omitted here, so R3 is a *semantic* round-trip
unless DI is generated.)

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

When `confirmShipping` fails with `errorCode=SHIPPING_REJECTED`, the error boundary routes
to `Tx_cancel`; the transaction cancels; the engine compensates the completed steps in
reverse — `refundCard` then `releaseStock`; the cancel boundary then takes `SagaFailed`. A
production model adds an error boundary → cancel on every compensatable step whose
later-failure should trigger rollback.

## Requirements *(mandatory)*

### Functional Requirements

#### Profile & validation

- **FR-001**: The system MUST validate BPMN XML against the widened M1 profile before
  publishing, parsing it namespace-aware (matched by `{MODEL-ns}localName`, never by
  element prefix) and rejecting input that is not valid BPMN 2.0 XML.
- **FR-002**: The system MUST accept and validate the canonical transaction-saga
  construct set: `bpmn:transaction` (with a start event, supported children, a none end
  event, and a `cancelEventDefinition` end event); `boundaryEvent` with
  `compensateEventDefinition` / `errorEventDefinition` / `cancelEventDefinition`; a
  `serviceTask isForCompensation="true"` handler; `bpmn:association`; and a root
  `bpmn:error`.
- **FR-003**: A `compensateEventDefinition` boundary event MUST be validated as a
  compensation marker: it MUST have **zero** outgoing sequence flow and **exactly one**
  outgoing `<association>` to an `isForCompensation` activity **in the same transaction
  scope**; otherwise it is rejected before publish with the element id and reason.
- **FR-004**: An `errorEventDefinition` boundary event's `errorRef` MUST resolve to a
  declared root `<bpmn:error>`; a `cancelEventDefinition` MUST appear only inside (end
  event) or attached to (boundary event) a `bpmn:transaction`. Violations are rejected
  before publish with element id + reason.
- **FR-005**: The system MUST reject, before publish with element id + reason, every M1
  construct still out of profile: gateways or any flow node with >1 outgoing sequence
  flow; `conditionExpression`/`default`; timer/signal/escalation/conditional events;
  `callActivity`/non-transaction `subProcess`/`adHocSubProcess`/multi-instance;
  `instantiate="true"`; pools/lanes/collaboration/choreography. It MUST NOT silently skip
  them.
- **FR-006**: The system MUST tolerate (accept and ignore, not reject) foreign-namespace
  `<extensionElements>`, Diagram Interchange (`bpmndi:*`), `documentation`, and text
  annotations.
- **FR-007**: Every accepted file MUST remain valid against the BPMN 2.0 XSD and
  round-trip (semantically) through a standard modeler when the `easy-bpmn` extensions and
  DI are ignored; the §3 canonical order-saga MUST publish.

#### Pull worker model

- **FR-008**: The system MUST expose a pull / external-task worker model so remote
  microservices lease jobs by `taskType` without the orchestrator knowing service
  addresses: `POST /jobs/activate` (a bounded long-poll), `POST /jobs/{jobId}/complete`,
  and `POST /jobs/{jobId}/fail`.
- **FR-009**: When a process instance enters a Service Task, the runtime MUST create the
  job row (status `created`) and make it **leasable** before any external interaction
  (persist-before-advance); dispatch makes no outbound call.
- **FR-009a**: `POST /jobs/activate` MUST claim jobs atomically using the IN-subquery
  lease form with the lease guard in both the subquery and the outer `WHERE` (D1 does NOT
  parse `UPDATE … LIMIT … RETURNING`), returning each job with `jobId`, `instanceId`,
  `elementId`, `taskType`, `isCompensation`, `attempt`, `lockToken`, `traceId`,
  `variables`, and (for compensation jobs) `originalInput` + `capturedOutput`.
- **FR-010**: `complete`/`fail` MUST be `lock_token`-conditional: a stale or duplicate
  worker (expired lease re-leased elsewhere, or same token re-sent) matches zero rows and
  is rejected or returns the stable prior outcome, never advancing twice.
- **FR-011**: A Service Task job MUST complete only after the worker output variables and
  the `saga_steps` ledger row (for a compensatable step) are persisted **atomically** with
  the transition that advances the instance.
- **FR-012**: A technical failure (`fail retryable=true` / no `errorCode`, or lease/timeout
  expiry) MUST make the job re-leasable and count against `retries`; a business failure
  (`fail` with an `errorCode` matching a modeled `bpmn:error/@errorCode`) MUST raise that
  BPMN error rather than retry.
- **FR-013**: Forward workers and compensators MUST both be required to be idempotent on
  `jobId`; the runtime documents that lease expiry can run a step twice and that the
  surviving completion's captured output is authoritative.
- **FR-014**: A job whose `taskType` is never polled MUST expire at a job-level activation
  TTL → terminal incident (`kind=jobActivationTimeout`) + operator alert; a per-job `waitForEvent`
  timeout MUST be handled inside the engine (routed to the technical-failure branch), never
  reaching the Workflow catch-all that would turn a task-level timeout into a terminal
  incident bypassing compensation.
- **FR-015**: The system MUST reject a `complete` output (or any message/worker payload)
  exceeding the Cloudflare Workflows ~1 MiB event limit **before** event delivery, with a
  user-visible rejection naming the involved job/element; large outputs ride an R2
  reference.

#### Worker authentication & tenancy

- **FR-016**: Every `/jobs/*` call MUST carry a per-workspace worker credential (bearer
  token); the server MUST derive `workspaceId` from the credential and MUST NOT trust a
  body `workspaceId` for job access.
- **FR-017**: The system MUST reject a `/jobs/*` request with a missing or revoked
  credential as unauthorized, and MUST NOT return or affect any job outside the
  credential's workspace (cross-tenant activate returns zero jobs / is rejected).

#### Compensation

- **FR-018**: On transaction cancellation, the runtime MUST run the scope's compensation
  handlers for completed-compensatable steps **in reverse completion order**, scoped to
  that transaction, selecting ledger rows in descending `seq` with `compensation_status IN
  ('pending','compensating','failed')`.
- **FR-019**: Each compensation job MUST carry `isCompensation=true`, the forward step's
  `originalInput`, and its `capturedOutput`; compensators MUST be idempotent and safe under
  at-least-once delivery (a new `compensate` idempotency scope returns the stable prior
  outcome for a duplicate callback).
- **FR-020**: Compensation MUST be triggered **only** by a transaction Cancel (error
  boundary → cancel end event, or operator `cancel`), and MUST NOT be triggered by an
  uncaught Error; an uncaught Error at the transaction boundary is a Hazard that terminates
  the instance and propagates (terminal incident), not auto-compensation.
- **FR-021**: A compensation job already `compensating` MUST re-attach to its existing
  `compensation_job_id` on replay/recovery, never creating a second compensation job; the
  reverse cursor MUST be re-derivable from the ledger after a crash.
- **FR-022**: A compensator that exhausts its own retries MUST settle the instance into the
  terminal `compensationFailed` state with an operator alert and an incident
  (`kind=compensationFailure`); the reverse pass MUST stop at the failed step, leaving the
  already-compensated suffix compensated.
- **FR-023**: On a fully successful reverse pass, the instance MUST become `compensated` and
  then settle via the cancel-boundary path to the saga-failed terminal state **without**
  calling the normal completion routine (which would clobber `compensated`/
  `compensationFailed` into `completed`).

#### Operator verbs & visibility

- **FR-024**: Operators MUST be able to `POST /instances/{id}/cancel` (operator-triggered
  transaction cancellation → compensation; status-conditional so only the first call
  initiates one reverse pass; an empty ledger goes straight to `cancelled`).
- **FR-025**: Operators MUST be able to `POST /instances/{id}/retry` to retry a failed
  forward step (incident) or resume a `compensationFailed` reverse pass; the verb is
  status-conditional and **resets** the existing job row rather than inserting a new one.
  (This relaxes the MVP view-only incident handling, FR-025 of `001`, for sagas.)
- **FR-026**: Operators MUST be able to `GET /instances?workspaceId=&status=&limit=&cursor=`
  to discover `compensating` / `compensationFailed` / `incident` / running sagas, backed by
  a `(workspace_id, status)` index.
- **FR-027**: `GET /instances/{id}` MUST include a `saga` block: phase
  (`forward|compensating|compensated|compensationFailed`), per-step compensation status
  from the ledger, which steps were compensated, and the `traceId`.
- **FR-028**: A `traceId` (derived from `instanceId`) plus per-step `spanId` MUST be
  propagated into activate/complete/fail payloads and recorded in history diagnostics and
  the ledger; the API MUST NOT leak Workflow internals (no `workflowInstanceId` required
  from worker/operator callers).

#### Status lifecycle & history

- **FR-029**: `process_instances.status` MUST widen to add `compensating`, `compensated`,
  `compensationFailed`, and `cancelled`, governed by an explicit one-way transition table;
  any transition outside the table is rejected.
- **FR-030**: `sendEvent` to a terminal / not-running instance MUST be gated on D1 first
  and wrapped so a "not running" throw is a **200 no-op acknowledgement**, never a `500`,
  so an at-least-once worker is never wedged in a permastuck retry loop.
- **FR-031**: Each meaningful saga transition (`transactionEntered`, `transactionCancelled`,
  `compensationStarted`, `compensationCompleted`, `compensationFailed`, `jobActivated`,
  `jobCompleted`, `jobFailed`) MUST be written to D1 history with the `traceId` in
  diagnostics.

### Key Entities *(include if feature involves data)*

- **Transaction Scope**: A `bpmn:transaction` node carrying its start id, child ids, and a
  compensation map (`activityId → {handlerId, boundaryId}`); the boundary of one saga.
- **Saga Step (ledger row)**: A completed-compensatable forward step's record — scope,
  monotonic completion `seq`, forward element/job, captured input + output, compensation
  handler/task-type/job, and `compensation_status`. The reverse-order compensation stack.
- **Service Task Job (extended)**: Durable pull-worker job state gaining
  `is_compensation`, `compensates_element_id`, `worker_id`, `lock_token`,
  `lock_expires_at`, `activation_expires_at`, and `error_code`; forward and compensation
  jobs share the lane, distinguished by `is_compensation`.
- **Worker Credential**: A per-workspace bearer credential (`workspace_id`, `token_hash`,
  `created_at`, `revoked_at`) from which the server derives `workspaceId` for `/jobs/*`.
- **Incident (extended)**: Gains `kind` (`serviceTaskFailure|compensationFailure|timeout`)
  and `resolution` (`open|compensating|compensated|operatorResolved`) so an incident can
  drive/track remediation instead of dead-ending.
- **Process Instance (extended)**: Gains the widened saga status lifecycle and the saga
  view (phase + per-step compensation status + traceId).
- **Compensation Job**: A job on the shared lane with `is_compensation=true`, carrying the
  forward step's `originalInput` + `capturedOutput`, keyed to the forward element id.
- **Trace Context**: A `traceId` derived from `instanceId` plus per-step `spanId`,
  propagated to workers and recorded in history and the ledger.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can publish the §3 canonical order-saga and drive it to commit
  end-to-end via the pull API using separate worker identities, with no workflow cluster,
  broker, or BPMN engine deployed.
- **SC-002**: A business failure mid-saga compensates exactly the completed steps, in
  strict reverse completion order, and the instance settles to the saga-failed terminal
  state via the cancel-boundary path (status `compensated`, never `completed`).
- **SC-003**: A compensator that exhausts retries deterministically yields
  `compensationFailed` with the already-compensated suffix intact; an operator `retry`
  resumes the reverse pass and reaches `compensated`.
- **SC-004**: In duplicate `complete` and duplicate `fail` tests, the instance advances no
  more than once and no attempt is double-counted; a late callback to a terminal instance
  returns a 200 no-op acknowledgement and never permasticks.
- **SC-005**: A worker credential scoped to workspace A cannot lease or observe any
  workspace B job payload; a forged body `workspaceId` is ignored.
- **SC-006**: An instance started on v1 compensates via v1's graph after v2 is published,
  and its history/saga view reference only v1.
- **SC-007**: 100% of publish attempts containing an M1-unsupported construct are rejected
  before any executable version is created, with the offending element id and a reason; the
  §3 saga and an otherwise-valid file carrying only ignorable content both publish.

### M1 constitution-critical test gates *(named; required by the Constitution Check)*

The following seven integration/contract tests are mandatory gates for M1 (one per
constitution-critical saga behavior; see `quickstart.md` and `plan.md`):

1. **happy-saga-commit** — a multi-microservice saga commits on the happy path (US1, SC-001).
2. **business-error-compensation** — a business error mid-saga compensates completed steps
   in reverse and reaches the failure end (US2, SC-002).
3. **compensator-fail-remediation** — a compensator exhausts retries → `compensationFailed`
   → operator `retry` resumes → `compensated` (US3, SC-003).
4. **duplicate-callback-idempotency** — duplicate `complete` AND duplicate `fail` each
   advance at most once (US4, SC-004).
5. **terminal-instance-noop-ack** — a late callback to a terminal instance is a 200 no-op
   ack, not permastuck (US4, SC-004).
6. **cross-tenant-activate-reject** — a cross-tenant `activate` is rejected / returns no
   jobs (US5, SC-005).
7. **version-binding-during-compensation** — a v1 instance mid-saga compensates via v1's
   graph after v2 publishes (US6, SC-006).

## Assumptions

- M1 keeps the forward path inside a transaction **single-token**: an interrupting error
  boundary event redirects the single token to the cancel end event, which is not a parallel
  split, so the scope-aware engine does not need a concurrent token set until M4.
- The correlation key for any Receive Task in a saga is still supplied via the API at
  instance start (the MVP relaxation), not derived from a model-level subscription
  expression; M1 adds no model-level correlation.
- The transport for the pull worker in M1 is a bounded long-poll on `/jobs/activate`; a
  thin client SDK is either in M1 or a fast-follow (open question, research.md).
- Retry backoff (exponential with jitter: `base`, `factor`, `maxBackoff`) is distinct from
  lease duration; retries are driven by re-lease, not by re-entering `waitForEvent`, so the
  Workflow step budget stays flat (one wait per task).
- A sample forward worker and a sample compensation worker are provided as demo aids, not
  production reference implementations.
- Project/workspace tenancy is assumed; cross-tenant correlation and cross-tenant job
  access are out of scope and actively prevented.
- The expression language (M2), per-step/boundary timeout behavior (M3), CF-Workflows
  concurrency strategy (M4), and the worker SDK shape (M1/fast-follow) are open questions
  recorded in research.md, not resolved here.

---

## M4: Concurrency — Parallel and Inclusive Gateways, Token Frontier, AND/OR Joins

**Constitution**: v2.3.0 (MINOR — amended before any M4 runtime ships)
**Design source**: `docs/superpowers/specs/2026-06-13-m4-concurrency-design.md`
**Shipped layers**: L1 (governance + SESE validator), L2 (token-frontier engine refactor +
0007_tokens.sql), L3 (parallelGateway AND), L4 (inclusiveGateway OR), L5 (parallel-branch
compensation), L6 (caps + R2 offload + observability + docs + closure).

### Constitution Alignment

**BPMN Profile Impact** (Principle I, widened to v2.3.0): M4 widens the executable profile
to accept `bpmn:parallelGateway` (AND split/join) and `bpmn:inclusiveGateway` (OR split/join),
**block-structured (SESE) only** — every split paired with exactly one matching join of the same
type, validated at publish time by the SESE region validator. `complexGateway` and `terminate`
end events remain rejected. The no-custom-notation clause, XSD-validity, and modeler
round-trippability are unchanged: `parallelGateway`/`inclusiveGateway` are standard BPMN 2.0
elements carrying no new MODEL-namespace attributes; every still-unsupported construct is
rejected before publish with element id + reason; ignorable extension content is tolerated.

**SAGA / Compensation Impact** (Principle VI, amended for multi-token): The existing
reverse-order compensation guarantee is refined to **per causal chain (token lineage)**: within
each lineage steps compensate in strict reverse-seq order; order between concurrent branches is
unconstrained (no happens-before relation). A straggler completing after a parallel scope began
compensating is still ledgered (`INSERT OR IGNORE`) and compensated within its lineage before
any causally-earlier step. The quiescence barrier (ledger drained **and** all cohort tokens
terminal) prevents the instance from settling `compensated` while any cohort token remains live.

**Multi-token Completion Rule** (Principle VI amendment): An instance completes only when the
**token frontier is empty** (all tokens in `consumed|merged|discarded` status). A single-token
instance's frontier empties at its end event, preserving M0–M3 behaviour exactly.

**Immutable Version Binding** (Principle II): Unchanged. The compensation graph (region topology,
branch wiring, compensation associations) derives from the instance's bound definition version.

**Durable Idempotency** (Principle III): Fan-out, join arrival, and join completion use
`INSERT OR IGNORE` / plain `INSERT` race discipline (same as `gateway_decisions` and
`saga_steps`). Branch-local `variables_overlay` is made idempotent by the existing
`output_applied` marker. A losing concurrent fan-out or join batch aborts on the PK and re-reads
the already-recorded result.

**Receive Task Correlation** (Principle IV): Unchanged for single-token paths. The
publish-time SESE validator (§4 rule 10 of the design) rejects any model placing two concurrent
catch points with the same message name in the same region, preserving the single-active-
subscription-per-broker-key invariant.

**Audit and Operator Visibility** (Principle V): `GET /instances/{id}` gains a `tokens` array
from `execution_tokens` (D1, never Workflow state). New history event types (`regionActivated`,
`branchForked`, `branchArrivedAtJoin`, `joinCompleted`) carry `tokenId`, `regionId`,
`regionActivation` in `diagnostics`. Operator `/cancel` is frontier-wide; `/retry` reconstructs
the frontier from `execution_tokens`.

### User Scenarios & Testing

#### User Story 7 — Run Two Concurrent Branches and Join (Priority: P1)

A BPMN model fans out at a `parallelGateway` into two or more service-task branches that run
concurrently (both jobs leasable at once by independent workers) and synchronises at the
matching AND join; the instance completes when the token frontier is empty.

**Acceptance Scenarios**:

1. **Given** a `parallelGateway` split with two outgoing branches, **When** the instance fans
   out, **Then** one `execution_tokens` row per branch is written atomically and both branch
   jobs are leasable simultaneously.
2. **Given** both branch jobs completed (in any order), **When** the second `join_arrivals`
   row is inserted, **Then** the `join_completions` plain-INSERT claim fires in the same
   `dbBatch` as the merged overlay and the advance; the instance reaches `completed` on empty
   frontier via the atomic last-token-out conditional UPDATE.

#### User Story 8 — Activate Only True-Condition Branches (OR Gateway) (Priority: P1)

An `inclusiveGateway` split activates only flows whose FEEL conditions are true (or the
`default`); the recorded activation set is replayed verbatim on rewalk. The OR join waits for
exactly the recorded subset. Zero activation with no default raises `noPath`.

**Acceptance Scenarios**:

1. **Given** two conditional flows with one true condition, **When** the split fires, **Then**
   `gateway_decisions.activated_flow_ids` records the singleton; only one branch job becomes
   leasable; the OR join fires when that branch arrives.
2. **Given** no true condition and no `default` flow, **When** the split fires, **Then** a
   terminal `noPath` incident is raised (Hazard inside a transaction; no auto-compensation).

#### User Story 9 — Branch-Local Variables Merge Deterministically (Priority: P1)

Each branch token's `variables_overlay` is isolated from siblings before the join. At the join
the overlays merge in **split out-flow document order**; later-in-order wins on key conflict.

**Acceptance Scenarios**:

1. **Given** two branches each writing to a distinct key, **When** the join fires, **Then**
   both keys are present in the post-join scope.
2. **Given** two branches each writing the same key, **When** the join fires, **Then** the
   value from the later-in-document-order branch out-flow wins.
3. **Given** branch A writes key `x` in-flight, **When** branch B reads `x` before the join,
   **Then** branch B reads the pre-split scope value — branch A's overlay is not visible to
   siblings before merge.

#### User Story 10 — Compensate Parallel Branches with Straggler Handling (Priority: P1)

A scope cancel (business error → cancel end, or operator `/cancel`) captures the live-token
cohort, arms per-token terminators, and holds the quiescence barrier until the ledger is
drained and all cohort tokens are terminal; straggler completes are ledgered and compensated
within their lineage.

**Acceptance Scenarios**:

1. **Given** an in-flight straggler branch at cancel time, **When** the straggler later
   completes, **Then** a `saga_steps` row is written (`INSERT OR IGNORE`) but the instance
   does not advance; the compensating drive ledgers the straggler before the reverse pass.
2. **Given** completed steps on two concurrent branches, **When** compensation runs, **Then**
   within each branch lineage steps compensate in strict descending-seq order; cross-branch
   order is unconstrained.
3. **Given** the last cohort terminator fires and the ledger is drained, **When** the
   quiescence barrier passes, **Then** the instance settles `compensated` exactly once.

### Key Entities (M4)

- **Token (`execution_tokens`)**: A live position in the frontier. `token_id` is deterministic:
  `${instanceId}:#root` for the root token; `${instanceId}:${splitId}#${activation}:${branchFlowId}`
  for a branch token. `position_element_id` and `status` are derived read-models; all fast-forward
  and barrier decisions read the append-only join facts, never mutable token state.
- **Join Arrival (`join_arrivals`)**: Append-only. `(instance_id, join_id, activation,
  branch_flow_id)` recorded via `INSERT OR IGNORE` when a branch token reaches the join.
- **Join Completion (`join_completions`)**: Append-only. `(instance_id, join_id, activation,
  produced_token_id)` claimed by a plain `INSERT` in the same batch as the merge-overlay write
  and the advance. The replay predicate for "this join activation has fired."
- **`MAX_CONCURRENT_TOKENS = 256`**: Walk-local frontier cap (live tokens in
  `active|waiting|arrivedAtJoin`). Exceeding it at a split fan-out settles a terminal
  `concurrencyLimit` incident (never a live SQL COUNT; counted in-memory during the deterministic
  rewalk, like `MAX_ELEMENT_OCCURRENCES = 1000`).
- **`STEP_BUDGET_SOFT = 20000`**: Per-drive cumulative `runStep`/`waitForEvent` cap (the counter
  resets each drive). Exceeding
  it settles a terminal `stepBudget` incident below the platform ceiling (`limits.steps = 25000`
  in `wrangler.jsonc`). The three caps enforce jointly: `MAX_CONCURRENT_TOKENS`,
  `MAX_ELEMENT_OCCURRENCES`, and `STEP_BUDGET_SOFT`.
- **Token Cohort** (compensation): The set of `execution_tokens` live at cancel time. Every cohort
  token gets a per-token terminator; the quiescence barrier holds until all are terminal.

### Success Criteria (M4)

- **SC-008**: A `parallelGateway` AND split fans out concurrently; the AND join waits for all
  activated branches; the instance completes on empty frontier (`completed`).
- **SC-009**: An `inclusiveGateway` OR split activates only true-condition branches (recorded in
  `activated_flow_ids`); the OR join fires for exactly the recorded subset; zero activation with
  no default raises `noPath`.
- **SC-010**: Branch-local variable writes are isolated before the join; the join merge applies
  branches in document order; later-in-order wins on key conflict.
- **SC-011**: A parallel-scope cancel ledgers stragglers, holds the quiescence barrier, compensates
  within each lineage in reverse-seq order, and settles `compensated` exactly once.
- **SC-012**: Exceeding `MAX_CONCURRENT_TOKENS = 256` at fan-out settles a `concurrencyLimit`
  incident; exceeding `STEP_BUDGET_SOFT = 20000` steps in a single drive settles a `stepBudget`
  incident; neither is an opaque errored Workflow.
- **SC-013**: `GET /instances/{id}` surfaces the `tokens` array (live and terminal) from `execution_tokens` (D1);
  history events inside a region carry `tokenId`/`regionId`/`regionActivation` in `diagnostics`.

### M4 constitution-critical test gates

1. **parallel-and-split-join** — AND fan-out, multi-wait race, join, frontier-empty completion
   (`tests/integration/parallel-gateway.test.ts`).
2. **inclusive-or-split-join** — OR activation subset, OR join, zero-activation `noPath`
   (`tests/integration/inclusive-gateway.test.ts`).
3. **branch-local-variable-merge** — token-scoped writes, document-order merge, no sibling leak
   (`tests/integration/parallel-gateway.test.ts`).
4. **parallel-branch-compensation** — straggler ledger, quiescence barrier, lineage-ordered
   reverse, quiesced settle (`tests/integration/parallel-compensation.test.ts`).

## M5-L1: Embedded Scopes + Hierarchical Exceptions

**Constitution**: v2.5.0 (MINOR — the single M5 amendment, accepted whole; this layer opens the M5-L1
runtime subset)
**Design source**: `docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md` (normative for
M5-L1; wins where more specific than the decomposition doc), `docs/superpowers/specs/2026-06-20-m5-composition-design.md`
§6 M5-L1 (decomposition), `specs/002-saga-orchestrator/m5-L1-constitution-check.md` (recorded Constitution
Check)
**Status**: **Shipped** — the M5-L1 runtime layer opened and validated under constitution v2.5.0 (no
further amendment; the M5 set was accepted whole).
Plan: `docs/superpowers/plans/2026-07-02-m5-l1-embedded-scopes.md` (15 tasks, TDD, governance-first).

### Constitution Alignment

**BPMN Profile Impact** (Principle I, widened to v2.5.0, this layer's runtime subset): M5-L1 opens the
validator/runtime for plain embedded `bpmn:subProcess` (one none-start, ≥1 end, shares the parent variable
scope, arbitrary nesting of subProcess/transaction), error and timer `boundaryEvent`s hosted on a
`subProcess`/`transaction`, and the error **end** event (`endEvent` + `errorEventDefinition`). The
`triggeredByEvent="true"` event subprocess, `multiInstanceLoopCharacteristics`, and `callActivity` stay
**interim-rejected** with an M5-L4/L3/L2 roadmap pointer respectively (`callActivity` has **since
shipped** — its M5-L2 layer opened the runtime); `adHocSubProcess` and
`standardLoopCharacteristics` stay permanently rejected. The no-custom-notation clause, XSD-validity, and
modeler round-trippability are unchanged.

**SAGA / Compensation Impact** (Principle VI, generalized to a scope subtree — see §3.1/§3.4 below): a
transaction may now nest inside another scope; commit is non-terminal (`committedLocal`) until the
outermost enclosing transaction commits; the straggler cohort and live-token barrier become
scope-subtree-aware; compensation wiring is legal iff some ancestor scope is a transaction. The
Cancel-only-trigger / Hazard-does-not-compensate / idempotent / at-least-once / `compensationFailed`
clauses are **unchanged**.

**Hierarchical Exception Impact** (Principle VI, thread B — see §5 below): an uncaught error climbs the
scope stack to the nearest enclosing error boundary; unhandled at the process root it is a **Hazard**
(terminate, no auto-compensation — Principle VI verbatim). A non-cancel interrupting boundary on a scope
interrupts **without** compensation; its subtree's completed compensatable effects are **retained**, not
dropped.

**Immutable Version Binding** (Principle II): Unchanged this layer. The scope hierarchy (kind, parent,
depth) is a static property of the immutable definition version, computed at publish and persisted in
`parsed_profile` — later drives never recompute it from a live graph.

**Durable Idempotency** (Principle III): Unchanged this layer (M5-L1 adds no cross-instance execution).
Scope entry/exit are ordinary `runStep`-memoized bookkeeping steps (fast-forward write-free from a landed
history event, exactly like `enterTransaction`); the commit-shield transition and the widened reverse-cursor
CAS keep the existing claim discipline (`INSERT OR IGNORE` / plain `UPDATE` / CAS).

**Receive Task Correlation** (Principle IV): Unchanged — M5-L1 introduces no message or signal construct.

**Audit and Operator Visibility** (Principle V): New history event types `scopeEntered`/`scopeExited`; an
uncaught error end event settles the new incident kind `uncaughtError`. Every rejection states the
offending element id and reason. No SPA change this layer (history-only delta); the read-only/D1-only
invariant is re-affirmed.

### Scope of this layer

**In** (design §1):

- Plain embedded **non-transaction `subProcess`** (one none-start, ≥1 end, shares the parent variable
  space; arbitrary nesting: subProcess-in-tx, tx-in-subProcess, tx-in-tx).
- The **complete generalized-scope model** (decomposition thread A): a typed scope hierarchy in the
  compiled graph, with scope-subtree-aware commit/compensation/straggler/barrier semantics — the three
  §3.1 invariants (below) land here, designed-complete.
- **Hierarchical error propagation** (thread B): an uncaught error climbs the scope stack; Hazard at
  root (Principle VI verbatim — no auto-compensation).
- **Error end event** (`endEvent` + `errorEventDefinition`) — accepted (decomposition §6 M5-L1 decision 4,
  recommended lane taken).
- **Error and timer boundaries on a `subProcess`/`transaction`**, with the Hazard-vs-Cancel semantics: a
  non-cancel interrupting boundary interrupts **without** compensation, ledger retained.
- **`MAX_SCOPE_DEPTH`** cap (publish-time in L1; the numeric value is fixed and `check:docs`-synced when
  the validator lands, not by this governance-opening section).

**Out** (explicit, with interim validator rejects where applicable):

- Event subprocess (`triggeredByEvent="true"`) → M5-L4 (interim reject with roadmap pointer).
- `multiInstanceLoopCharacteristics` on any activity → M5-L3 (interim reject).
- `callActivity` → M5-L2 (**since shipped** — the whitelist reject is lifted: `calledElement` is pinned
  to an immutable published version at the caller's publish and the call tree is capped at
  `MAX_CALL_DEPTH = 4` at publish; see `specs/002-saga-orchestrator/m5-L2-constitution-check.md`).
- `compensateEventDefinition` boundary on a subProcess (compensate-as-unit) → post-M5 (decomposition §6
  M5-L1 decision 6): in L1 a subProcess's completed steps are simply rows in the enclosing transaction's
  ledger.
- Escalation, signal, non-interrupting boundaries → M5-L4/L5.
- Console UI changes → thread G deltas started at M5-L2 as planned (**since shipped**: the `lineage`
  block on instance inspection, the `GET /instances?root=true` filter, console parent/child navigation,
  and the child-only `errored` status); L1 shipped only the new history events.

### The ledger invariant

> A ledger row is **sealed forever only when the outermost transaction enclosing its committing
> transaction commits**. Until then, a locally-committed row remains eligible for exactly the
> compensation roots that are **strict ancestors of its committing transaction** — and for no other
> root, including later occurrences of the same static scope.

`CompensationStatus` gains one non-terminal value, **`committedLocal`**; `committed` keeps its current
meaning (terminal, sealed). A nested transaction's commit flips only its **owned** scopes to
`committedLocal`; only the **outermost** commit (no enclosing transaction) flips a subtree to `committed`
— for a top-level single-scope transaction this reduces byte-for-byte to today's (pre-M5) commit
behavior, the M1–M4 no-op fast path.

### Cursor semantics

The reverse cursor generalizes to a **root-relative subtree cursor**. For compensation root R, a row is
selected iff its `scope_id ∈ subtree(R)` and either its status is `pending|compensating|failed`, or it is
`committedLocal` with `scope_id ∈ eligibleCommittedScopes(R)` (every scope `s ∈ subtree(R)` whose nearest
enclosing transaction is a **strict ancestor** of R), ordered `seq DESC` (global, per-instance-monotonic —
not per-scope, so cross-scope reverse order is well-defined).

| Case | Root R | Row | Outcome |
|---|---|---|---|
| Outer cancel over committed inner tx | outer tx O | `committedLocal`, scope ∈ owned(T), T inside O | `strictAncestor(O, T)` ✓ → compensates, reverse order |
| Self re-entry: T#occ1 cancels after T#occ0 committed | T | `committedLocal`, nearestTx = T | `strictAncestor(T, T)` ✗ → shielded |
| Same, rows in S inside T | T | `committedLocal`, scope = S, nearestTx(S) = T | shielded (the §3.1 counterexample, fixed) |
| Operator `/cancel` | process root | any `committedLocal` | process is a strict ancestor of every tx → eligible |
| Operator `/cancel` vs a committed **top-level** tx | process root | `committed` (sealed at outermost commit) | never selected — current `/cancel` semantics preserved |
| Loop of inner tx inside outer, all iterations committed, outer cancels | O | `committedLocal` occ0..k | all eligible, `seq DESC` runs them newest-first |

The straggler cohort and live-token barrier, previously gated on `isRegion` and skipped entirely outside
the M4 concurrency world, are **un-gated** and run for every graph with subtree-membership filters — for a
single-scope graph `subtree(R) = {R}` and behavior is unchanged. Cancel of scope R is a **two-phase
subtree operation**: (1) interrupt/drain in-flight tokens in `subtree(R)` (completed jobs ledgered,
failed/non-compensatable discarded, `created|locked` jobs drained), the barrier holding until quiesced;
(2) the reverse pass bottom-up via the cursor above.

### Exception semantics

An uncaught error climbs the scope stack: candidates are evaluated bottom-up, first boundaries on the
throwing element, then boundaries attached to each enclosing scope node in turn; exact `@errorCode` match
wins over a catch-all, first match wins. Exhausting the chain at the process root is a **Hazard**: incident,
no auto-compensation. An error **end event** consumes its token and throws from the scope containing the
end event; an uncaught error end at process level settles the new incident kind `uncaughtError`.

When an error is caught by a boundary on scope B (or a scope timer fires — same shape): (1) phase-1 drain
of `subtree(B)` — completed effects **retained** (ledgered, not compensated), in-flight work drained;
(2) **no reverse pass** — a non-cancel boundary interrupts without compensation (Principle VI: no Cancel ⇒
no compensation); (3) the token exits on the boundary's single outgoing flow in B's parent scope.
Remediation needs no new operator surface: a later cancel of an enclosing transaction, or operator
`/cancel` (root = process), reaches retained rows through the subtree cursor above — the concrete
realization of "operator `/cancel` walks exited scopes." Modeling guidance: for timer-triggered *rollback*,
route the boundary's outgoing flow to a **cancel-end inside** the transaction; a timer routed elsewhere is
deliberately Hazard-class.

A **cancel-end inside a nested transaction** T compensates only `subtree(T)`; the instance then
**continues** on T's cancel-boundary failure-path target (a non-terminal settle back to `running`) — see
`m5-L1-constitution-check.md` Complexity Tracking (b) for this refinement of the decomposition doc. Only a
**root-level** cancel (a top-level transaction's cancel-end, or an operator `/cancel`) settles the instance
terminally, as in M1–M4.

### Validator delta

| Rule | Change |
|---|---|
| `bpmn:SubProcess` (plain, embedded) | **Accept**: recurse `classifyContainer` with `scopeKind="subProcess"`; today it falls to the generic whitelist reject |
| `triggeredByEvent="true"` | **Interim reject** with M5-L4 roadmap pointer (element id + reason) |
| `adHocSubProcess` | **Reject** (permanent, element id + reason) |
| `multiInstanceLoopCharacteristics` / `standardLoopCharacteristics` on any activity | **Interim reject** → M5-L3 / permanent reject respectively |
| Error end event | **Accept** (replaces the prior reject); `errorRef` → `bpmn:error/@errorCode` resolution required, dangling/empty rejected |
| Cancel end event | Immediate scope MUST be a transaction (explicit about *immediate* under nesting) |
| Error boundary hosts | serviceTask (existing) **+ subProcess + transaction** |
| Timer boundary hosts | serviceTask/receiveTask (existing) **+ subProcess + transaction** — the M5-deferral reject is removed |
| Cancel boundary hosts | transaction only (**unchanged**) |
| Compensate boundary hosts | serviceTask only (**unchanged**; compensate-subProcess-as-unit deferred post-M5) |
| Compensation association guard | **Unchanged** — boundary and handler must share an immediate scope |
| Handler-in-transaction guard | Becomes the **ancestry check**: legal iff **some ancestor scope is a transaction**; a chain reaching the process root without one is rejected (element id + reason: the handler has no trigger) |
| Boundary count per activity, non-interrupting reject | Unchanged, now also covering scope hosts |
| Flow crossing a scope boundary | Unchanged mechanism, now exercised by nested scopes |
| Per-scope structure (exactly one none-start, ≥1 end, SESE regions per scope) | Unchanged mechanism, applies to subProcess scopes |
| `MAX_SCOPE_DEPTH` | **New publish-time reject** (see Caps below) |
| Nested transaction with a cancel end | **New reject**: MUST carry a cancel boundary, else the failure path has no target |

### Caps

`MAX_SCOPE_DEPTH` — nesting depth of scopes (subProcess-in-subProcess), a **new engine cap**, joining the
three existing caps (`MAX_ELEMENT_OCCURRENCES`, `MAX_CONCURRENT_TOKENS`, `STEP_BUDGET_SOFT`). Deliberate
refinement of decomposition §4 (recorded in `m5-L1-constitution-check.md` Complexity Tracking (a)): in L1
scope depth is **fully static** (no `callActivity`, no `multiInstance`), so the cap is enforced by the
**validator at publish** (element id + reason) — fail-closed, zero runtime surface. The `scopeDepth`
*runtime incident* named by the decomposition doc was anticipated to become reachable once M5-L2
introduced dynamic depth (call chains) — in the event it did **not**: the shipped M5-L2 kept the call
tree fully static too (`calledElement` is resolved and pinned to an immutable version at the caller's
publish, and call-tree depth is capped by `MAX_CALL_DEPTH = 4` at publish via
`src/bpmn/call-resolution.ts`), so no runtime depth incident exists after L2 either; the incident stays
deferred until some layer introduces genuinely dynamic depth. This governance-opening section fixes no
numeric value; the value is defined in `src/runtime/engine.ts` and `check:docs`-synced when the validator
task lands.

### User Scenarios & Testing

#### User Story 11 — Nest a Transaction Inside a SubProcess and Compensate on Outer Cancel (Priority: P1)

A `bpmn:transaction` sits inside a plain `subProcess`, itself inside an outer `bpmn:transaction`. The
inner transaction commits normally; when the outer transaction later cancels, the inner transaction's
(and its subProcess sibling's) completed steps compensate in reverse.

**Acceptance Scenarios**:

1. **Given** `outer-tx > subProcess > inner-tx` where the inner transaction has committed, **When** the
   outer transaction cancels, **Then** the inner transaction's steps compensate in global-`seq` reverse
   order, and the previously `committedLocal` rows are used, not skipped.
2. **Given** a single-scope (non-nested) transaction — the M1–M4 shape — **When** it commits, **Then** its
   rows are marked terminal `committed` exactly as before (byte-for-byte no-op fast path).

#### User Story 12 — Bubble an Uncaught Error to a Scope Boundary or Hazard (Priority: P1)

An error thrown by a service task (or an error end event) inside a `subProcess` climbs the scope stack to
the nearest enclosing error boundary; with no boundary anywhere in the chain, the instance settles a
Hazard incident at the process root.

**Acceptance Scenarios**:

1. **Given** a service task inside a `subProcess` fails with a business error code, **When** no boundary
   is attached to the task itself but one is attached to the enclosing `subProcess`, **Then** the token
   routes to that boundary's target.
2. **Given** no boundary exists anywhere in the scope chain, **When** the error is thrown, **Then** the
   instance settles a Hazard incident (`serviceTaskFailure` for a worker error, `uncaughtError` for an
   error end event) with no auto-compensation.
3. **Given** an error **end event** inside a `subProcess` on a non-service control path, **When** it is
   reached, **Then** it throws exactly as a worker error would, subject to the same bubbling.

#### User Story 13 — Interrupt (Not Compensate) via a Non-Cancel Boundary on a Transaction (Priority: P1)

A timer or error boundary on a `transaction` fires without routing to a cancel end. The transaction is
interrupted, but its completed compensatable effects are retained (not auto-compensated), and an operator
can later force the reverse pass.

**Acceptance Scenarios**:

1. **Given** a timer boundary on a transaction fires (or an error boundary catches a non-cancel-routed
   error), **When** the boundary's target is outside the transaction, **Then** the transaction's completed
   steps stay `pending` (retained), and the token exits without compensation.
2. **Given** the transaction was exited via such a boundary, **When** an operator issues `/cancel`, **Then**
   the retained steps are located (via the root-relative subtree cursor at the process root) and
   compensated in reverse order.

#### User Story 14 — Shield a Committed Nested Transaction from Its Own Re-Entry (Priority: P2)

A nested transaction inside an M2 cycle commits at occurrence 0, then re-enters and cancels at occurrence
1. The occurrence-0 rows (including rows in a child `subProcess`) are shielded from this self-cancel, but
remain eligible for a later ancestor cancel.

**Acceptance Scenarios**:

1. **Given** transaction T commits at occurrence 0 (nested inside an outer scope), re-enters via a cycle,
   and cancels at occurrence 1, **When** the occurrence-1 reverse pass runs, **Then** occurrence-0 rows
   (including rows in T's child subProcess) are untouched.
2. **Given** the same instance, **When** an ancestor of T later cancels, **Then** both occurrences'
   `committedLocal` rows compensate.

#### User Story 15 — Resume the Instance After a Nested Cancel-End Compensates (Priority: P2)

A cancel end inside a **nested** transaction (not the top-level saga) drives the reverse pass over only
that transaction's subtree, then the instance continues running on the cancel boundary's failure-path
target — it does not terminate.

**Acceptance Scenarios**:

1. **Given** a cancel end is reached inside a nested transaction T with a cancel boundary attached,
   **When** T's subtree finishes compensating, **Then** the instance status returns to `running` at the
   cancel boundary's target element (a non-terminal settle), not a terminal `compensated`/`sagaFailed`.
2. **Given** a cancel end is reached inside a **top-level** transaction (or an operator issues `/cancel`
   at the process root), **When** compensation completes, **Then** the instance settles terminally, exactly
   as M1–M4 today.
3. **Given** a nested transaction contains a cancel end but has **no** cancel boundary attached, **When**
   the model is published, **Then** publish is rejected (element id + reason: no failure-path target).

### Key Entities (M5-L1)

- **Scope (`ExecutionGraph.scopes`)**: A static property of the compiled graph — `{ id, kind, parentId,
  depth }`, one entry per non-process scope (`kind ∈ { process, transaction, subProcess }` in L1; the
  `ScopeKind` type carries the full M5 union `process | transaction | subProcess | callActivity | miBody`
  so L2/L3 extend without churn). `GraphNode.scopeId` keeps its existing meaning — the immediate enclosing
  scope, `null` at process level.
- **`committedLocal` (`CompensationStatus`)**: A new non-terminal ledger status — a nested transaction's
  commit shield. `committed` remains the terminal, sealed status. No D1 migration (TEXT column).
- **Compensation root (R)**: The scope a cancel (cancel-end or operator `/cancel`) is rooted at. Drives the
  root-relative subtree cursor, the straggler cohort, and the live-token barrier.
- **`subtree(R)`**: Every scope whose parent chain contains R, including R. For R = process root: every
  scope plus the `null` process level.
- **`nearestEnclosingTx(s)`**: Walking s's parent chain inclusive, the first scope of kind `transaction`;
  `null` if the chain reaches the root without one.
- **`MAX_SCOPE_DEPTH`**: A new publish-time cap on scope nesting depth (see Caps above); joins
  `MAX_ELEMENT_OCCURRENCES`, `MAX_CONCURRENT_TOKENS`, `STEP_BUDGET_SOFT`.
- **`uncaughtError` (`IncidentKind`)**: The new terminal incident kind for an uncaught error **end event**
  reaching the process root (distinct from `serviceTaskFailure`, which stays the kind for an uncaught
  worker error).

### Success Criteria (M5-L1)

- **SC-014**: `outer-tx > subProcess > inner-tx-commits`, then outer cancel compensates the inner steps in
  reverse (global-`seq` order); a single-scope M1–M4 instance is byte-for-byte unaffected (no-op fast
  path).
- **SC-015**: An error thrown by a service task or an error end event inside a `subProcess` bubbles to the
  nearest enclosing scope boundary; with none anywhere, the instance settles a Hazard at root
  (`serviceTaskFailure` or `uncaughtError`).
- **SC-016**: A timer (or non-cancel-routed error) boundary on a transaction interrupts **without**
  compensation, retaining the transaction's completed steps; a later operator `/cancel` drives the reverse
  pass over the retained, exited scope.
- **SC-017**: A committed nested transaction is shielded from its own re-entrant self-cancel
  (`committedLocal` not re-selected by `strictAncestor(T, T)`), but compensates under any strict-ancestor
  cancel.
- **SC-018**: A cancel end inside a **nested** transaction resumes the instance on the cancel boundary's
  failure-path target after its subtree compensates (non-terminal settle); a **root-level** cancel still
  settles the instance terminally, exactly as M1–M4.

### M5-L1 constitution-critical test gates

Planned (this governance-opening section precedes implementation; file paths per the implementation plan,
`docs/superpowers/plans/2026-07-02-m5-l1-embedded-scopes.md`):

1. **scope-tree-compilation** — kinds, parents, depths, `ownedScopes`, `nearestEnclosingTx`, subtree
   closure; `MAX_SCOPE_DEPTH` boundary (`tests/unit/scope-tree.test.ts`).
2. **subprocess-validator-accept-reject** — every §6 validator-delta row, accept/reject pairs, including
   tolerate-and-ignore of foreign-namespace extension content inside a subProcess
   (`tests/unit/bpmn-validator.test.ts`).
3. **subtree-cursor-eligibility** — table-driven over the Cursor semantics case table above, seeded
   directly via `saga_steps` (`tests/integration/saga-subtree-cursor.test.ts`).
4. **nested-commit-shield** — `outer-tx > subProcess > inner-tx-commits` then outer cancel (SC-014); the
   re-entry shield (SC-017) (`tests/integration/nested-compensation.test.ts`).
5. **subprocess-walk** — plain embedded subProcess enter/exit bookkeeping + occurrence fast-forward
   (`tests/integration/subprocess-walk.test.ts`).
6. **scope-error-bubbling** — uncaught task error climbs the scope chain to a subProcess boundary; none
   anywhere → Hazard (SC-015) (`tests/integration/scope-error-bubbling.test.ts`).
7. **error-end-event** — error end throws from a subProcess to the scope boundary; uncaught at root →
   `uncaughtError` incident (`tests/integration/error-end-event.test.ts`).
8. **scope-boundary-timer** — timer boundary on a transaction interrupts without compensation, retained
   ledger, `/cancel` forces the reverse pass (SC-016) (`tests/integration/scope-boundary-timer.test.ts`).
9. **nested-cancel-end-resume** — a cancel end inside a nested transaction resumes the instance
   non-terminally (SC-018); a nested transaction with a cancel end but no cancel boundary rejects at
   publish (`tests/integration/nested-compensation.test.ts`).
10. **no-op regression gate** — the entire existing M1–M4 suite green with zero test edits (single-scope
    fast path byte-compatible), except the deliberately rewritten matrix scenario
    `C-COMP-NESTEDTX-BRANCH-01` (`npm run test:integration && npm run test:unit`).
