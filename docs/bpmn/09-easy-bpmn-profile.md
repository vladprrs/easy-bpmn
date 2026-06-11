# 09 — The `easy-bpmn` BPMN Profile

This is the **contract** between the BPMN standard and what `easy-bpmn` actually executes. It is the
operational reading of the [constitution](../../.specify/memory/constitution.md) (now **v2.1.0**, with
the widened **Principle I — "Standard BPMN Profile Only"** covering the M2 conditional set and
**Principle VI — "SAGA / Compensation Integrity"**). When in doubt, the constitution wins. The
authoritative designs are
[`2026-06-08-saga-orchestrator-design.md`](../superpowers/specs/2026-06-08-saga-orchestrator-design.md)
(M1) and
[`2026-06-09-m2-conditional-sagas-design.md`](../superpowers/specs/2026-06-09-m2-conditional-sagas-design.md)
(M2); the Spec Kit feature is [`specs/002-saga-orchestrator`](../../specs/002-saga-orchestrator).

> **Core principle (constitution I):** execute *only* standard BPMN 2.0 elements from this profile;
> introduce **no** custom notation or platform-only semantics; and **reject unsupported standard-namespace
> flow nodes before publish with the offending element id + a user-visible reason.**

The profile grows one milestone at a time, each guarded by a constitution amendment:

- **M0/M1: the canonical transaction-saga** — the linear core *plus* `bpmn:transaction`,
  compensation/error/cancel boundary events, an `isForCompensation` handler, `bpmn:association`, a cancel
  end event, and root `bpmn:error`. Documented here.
- **M2 (current): conditional sagas** — `bpmn:exclusiveGateway` (XOR split + pass-through join), FEEL
  `conditionExpression` (via `feelin`) on flows leaving an exclusiveGateway, the gateway-owned `default`
  flow, and **cycles on the token path** (occurrence-discriminated iterations). Documented here;
  execution semantics in [`03-gateways.md`](./03-gateways.md).
- **M3 → time & failure taxonomy** (timers, per-step timeouts, error catalog):
  [`01-events.md`](./01-events.md). **One M1 exception:** a single **job-level activation TTL**
  (`service_task_jobs.activation_expires_at`, default 15 min) backs the un-leasable-job DLQ — a job
  nobody leases in time settles to a terminal incident `kind=jobActivationTimeout` via a per-job `JobScheduler`
  Durable Object alarm. It is *not* a model-level timer (no BPMN timer event); general timers remain
  M3. Retry backoff (exponential + jitter, base 1s / factor 2 / cap 30s) and poison-job termination
  (`kind=poison`, no compensation) ship in M1 too.
- **M4 → concurrency** (`parallelGateway`, token set, AND-join):
  [`07-execution-semantics.md`](./07-execution-semantics.md).
- **M5 → composition** (`callActivity`, non-transaction `subProcess`, `multiInstance`,
  `signal`/`escalation`): [`02-activities.md`](./02-activities.md).

## What "no custom notation" means (precisely)

The constraint is testable, not vibes. `easy-bpmn` MUST NOT:

1. introduce **new element or shape types** in the BPMN `MODEL` namespace;
2. **redefine the runtime meaning** of a standard element; or
3. **require a non-standard attribute** on a standard element for a file to *parse*.

What **is** allowed (and is *not* "custom notation"): carrying binding metadata in the standard
`<bpmn:extensionElements>` escape hatch under a dedicated `easy-bpmn` namespace. `extensionElements` is
part of BPMN 2.0 precisely so engines can attach implementation details; every engine (Camunda, Zeebe,
Flowable) does this. Using it additively is standard, not an invention.

**This holds for the saga constructs too.** A transaction-saga is drawn in **canonical BPMN** —
`bpmn:transaction`, `compensateEventDefinition`/`errorEventDefinition`/`cancelEventDefinition` boundary
events, `isForCompensation`, `bpmn:association`, `bpmn:error` are all standard OMG elements. The **only**
additive binding remains `easy-bpmn:taskDefinition` (the Service Task `type` + `retries`) inside
`<extensionElements>`. Cancel events are valid only on transaction subprocesses — exactly the saga
boundary — so nothing is overloaded.

**The operative test.** Every accepted file MUST stay valid against the BPMN 2.0 XSD and **round-trip
through a standard modeler** (bpmn-js / Camunda Modeler) unchanged even when `easy-bpmn` extensions and
Diagram Interchange are ignored. If a modeler can open, render, and re-save the file (forward path *and*
the compensation handlers, boundary events, and associations) without losing the diagram, we did not
invent a notation. The automated semantic round-trip lives in the validator's unit tests
(`tests/unit/bpmn-validator.test.ts`); bpmn-js is the operative human check.

**Persisted topology.** At publish, sequence-flow `sourceRef`/`targetRef` and compensation-`association`
`sourceRef`/`targetRef` are **retained**, not dropped — stored in the parsed-profile graph
(`GraphNode.outgoing: Flow[]`, `next` derived) and as queryable `bpmn_elements.source_ref`/`target_ref`
rows (migration `0003_topology.sql`). Topology is therefore queryable and replay-deterministic.

## The supported execution shapes

### Linear core (the original MVP happy path)

```text
○ Start Event ──→ ⚙ Service Task ──→ ✉ Receive Task ──→ ● End Event
   (none)          (remote worker)     (await message)     (none)
```

### Canonical transaction-saga (M1)

A saga is a `<bpmn:transaction>`. Each forward step is a `serviceTask` with an `easy-bpmn:taskDefinition`
`type`. Each compensatable step carries a **compensation boundary event** wired (via `<bpmn:association>`)
to an `isForCompensation` handler. A business failure is caught by an **error boundary event** routing to
a **cancel end event**; cancelling the transaction triggers **reverse-order compensation** of the
completed steps; a **cancel boundary event** on the transaction takes the "saga failed" path.

> **BPMN crux (spec §10.5.5 "Transaction"):** when a transaction is **cancelled**, the engine
> **automatically** compensates the transaction's successfully-completed activities **in reverse
> completion order**, then throws Cancel to the cancel boundary event. Do **NOT** add a compensate-throw
> event inside the transaction — cancellation triggers compensation automatically. An Error that reaches
> the transaction boundary *uncaught* is a **Hazard**: it terminates the transaction and propagates — it
> does **not** auto-compensate. Hence every compensatable failure is modeled as
> `error boundary → cancel end`.

This is the **single canonical accept fixture** (it is the exact BPMN consumed by the validator's
accept + semantic round-trip test, so this doc and the constitution-critical validator test cannot
drift):

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

If `confirmShipping` fails with `errorCode=SHIPPING_REJECTED`, the error boundary routes to `Tx_cancel`;
the transaction cancels; the engine compensates the completed steps in reverse — `refundCard` then
`releaseStock`; the cancel boundary then takes `SagaFailed`. (A real model adds an error boundary →
cancel on *every* compensatable step whose later-failure should trigger rollback.)

> **The engine stays single-token through M2.** An interrupting error boundary event *redirects* the
> single token to the cancel end event — it is **not** a parallel split — and an XOR gateway routes
> the single token down exactly one outgoing flow. True parallelism (multiple concurrent tokens) is M4.

### Conditional saga (M2)

The forward path may branch through an **`exclusiveGateway`** (XOR) and **loop back** through one:

```text
                          ┌─[ method = "card" ]──→ ⚙ payCard ──┐
⚙ reserveFunds ──→ ( X )──┤                                    ├──→ ( X join ) ──→ ● Tx_ok
                          └─[ default ]──────────→ ⚙ payWire ──┘
```

- A **split** evaluates its non-default outgoing FEEL conditions in **document order**; the first
  boolean `true` wins; none true → the `default` flow; no default either → terminal incident
  `kind=noPath` (a Hazard inside a transaction — no auto-compensation, operator `/cancel` available).
- A **join** is a pass-through (no waiting — there is only one token).
- **Cycles** are legal: each re-visit of an element is a distinct **occurrence** (its own job row,
  ledger row, message subscription, and decision row). A walk-local visit counter exceeding
  `MAX_ELEMENT_OCCURRENCES = 1000` → terminal incident `kind=loopLimit` (Hazard semantics inside a
  transaction). Compensation in a loop compensates **every completed iteration**, in reverse
  completion order (per-occurrence ledger rows; Principle VI is unchanged).
- Every gateway visit persists a **`gateway_decisions`** row (chosen flow + per-flow evaluations)
  atomically with the transition; crash/replay **reuses the recorded branch, never re-evaluates**.
- The canonical executable example ships as
  [`examples/conditional-fulfillment-saga.bpmn`](../../examples/conditional-fulfillment-saga.bpmn)
  (XOR split/join + a loop + compensation wiring), publish-validated by
  `tests/integration/sample-conditional-saga.test.ts`.

## Supported element set (the whitelist)

| BPMN element | XML tag | Constraints |
|--------------|---------|-------------|
| **None Start Event** | `startEvent` (no child event definition) | Exactly one per scope; no message/timer/signal trigger. Instances start via the API. |
| **Service Task** | `serviceTask` | A remote (pull) worker, bound by a stable **`taskType`** in `<extensionElements>` (`easy-bpmn` namespace) — **not** by id/name. Output variables persisted before advancing. |
| **Receive Task** | `receiveTask` (with `messageRef`) | Durable wait state; resumed by a correlated external message. `instantiate="true"` is **rejected**. |
| **None End Event** | `endEvent` (no child event definition) | Plain completion. A transaction's none end = **commit**. |
| **Sequence Flow** | `sequenceFlow` | Plain everywhere **except** leaving an `exclusiveGateway` split: there every non-default flow carries a FEEL `conditionExpression`, and the gateway's `default` flow carries none. Must connect nodes in the **same scope**. Cycles on the token path are legal. |
| **Exclusive Gateway** | `exclusiveGateway` | XOR **split** (1 in, N out): non-default outgoing flows carry FEEL conditions (`tFormalExpression`; parsed at publish via `feelin`), evaluated in document order, first `true` wins, else the `default` flow, else terminal `noPath`. XOR **join** (N in, 1 out): pass-through, no waiting. No boundary events may attach to a gateway. |
| **Message** | `message` (root) | Declares the message **name** a Receive Task waits for. Correlation key is supplied via the **API** at start. |
| **Transaction** | `transaction` | The **saga scope**: a none start event, supported children, a none end (commit), and optionally a cancel end. Compensation of its completed activities runs in reverse order on cancel. |
| **Compensation Boundary Event** | `boundaryEvent` + `compensateEventDefinition` | A **compensation marker**: it is **neither interrupting nor non-interrupting** (the `cancelActivity` axis does not apply). MUST have **zero outgoing `sequenceFlow`** and **exactly one** outgoing `<association>` to an `isForCompensation` activity **in the same transaction scope**. |
| **Error Boundary Event** | `boundaryEvent` + `errorEventDefinition` | **Interrupting**; attached to a `serviceTask`; routes to a **cancel end event**. Its `errorRef` MUST resolve to a declared root `<bpmn:error>`. Catching is by the Error's `@id`; the worker's `fail.errorCode` matches the Error's `@errorCode`. |
| **Cancel Boundary Event** | `boundaryEvent` + `cancelEventDefinition` | **Interrupting**; attached **only to the `transaction`**; its single outgoing flow is the "saga failed" path. |
| **Compensation Handler** | `serviceTask isForCompensation="true"` | A handler off the token path, reached **only** via compensation (the association from a compensation boundary). Bound by its own `easy-bpmn:taskDefinition type`. Must live inside a transaction. |
| **Cancel End Event** | `endEvent` + `cancelEventDefinition` | Allowed **only inside a `transaction`**. Reaching it cancels the transaction → reverse-order compensation. |
| **Association** | `association` | Compensation wiring only: a compensation boundary → its `isForCompensation` handler. |
| **Error** | `error` (root) | Declares a business error (`@id`, `@name`, `@errorCode`) referenced by an error boundary's `errorRef`. |

Supporting machinery (not drawn shapes, but required):
- **Process variables** — initial variables at start; service-task output; message payload; the captured
  step input/output a compensator receives.
- **Correlation key** — message name + correlation key → exactly one waiting instance, supplied via the
  API at instance start.
- **`easy-bpmn` extension binding** — Service Task worker `type` and `retries` (additive, ignorable).
- **DI** (`bpmndi:*`) — accepted, ignored for execution, preserved on the stored snapshot.

### The `easy-bpmn` extension (the only binding we add)

```xml
<bpmn:serviceTask id="reserveStock" name="Reserve stock">
  <bpmn:extensionElements>
    <easy-bpmn:taskDefinition type="reserve-stock" retries="3" />
  </bpmn:extensionElements>
</bpmn:serviceTask>
```

with `xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"` on `<definitions>`. Notes:
- `type` is the **stable worker routing key** (the "topic"). Pull workers lease by `type`; the element
  `id` is audit-only. Compensation handlers carry their own `type` too.
- `retries` is the per-task retry limit (constitution III).
- This mirrors the Zeebe/Camunda external-task pattern but under **our own** namespace — we do **not**
  require or honor `camunda:`/`zeebe:` semantics. A file with these extensions still round-trips in any
  standard modeler that ignores the `easy-bpmn` namespace — the operative test above.

## Explicitly out of scope (must be rejected before publish)

Still deferred to later milestones; each requires its own constitution amendment first:

| Category | Rejected elements |
|----------|-------------------|
| Tasks | abstract `task`, `userTask`, `sendTask`, `manualTask`, `scriptTask`, `businessRuleTask` |
| Events | timer / signal / escalation / conditional / message / link event definitions; **non-saga** boundary events (timer/signal/…); all `intermediateCatchEvent`/`intermediateThrowEvent`; terminate end; a non-cancel end-event definition |
| Gateways | `parallelGateway` (M4 — concurrent tokens), `inclusiveGateway` (M4 — multi-branch activation), `eventBasedGateway` (M3 — timers & events), `complexGateway` (not on the roadmap), and any **implicit split (>1 outgoing sequence flow on a non-gateway node)** — pointers in lockstep with `DEFERRED_GATEWAY_REASONS` (`src/bpmn/profile.ts`) |
| Flow | `conditionExpression` on any flow **not leaving an `exclusiveGateway`**, a `default` attribute on a non-gateway node, `messageFlow`, a sequence flow crossing a transaction boundary |
| Structure | non-transaction `subProcess`, `adHocSubProcess`, `callActivity`, `collaboration`, `participant` (pools), `laneSet`/`lane`, `choreography` |
| Loops/data | `multiInstanceLoopCharacteristics`, `standardLoopCharacteristics` (the activity **markers** — distinct from the accepted M2 cycles drawn as sequence flows through a gateway), `dataObject`/`dataStore`/`dataInput`/`dataOutput` |
| Model instantiation | `receiveTask instantiate="true"` (or any non-none instantiation path) |
| Platform | built-in tasklist, forms/assignment, process migration, full Zeebe/Camunda compatibility, visual modeler, advanced Operate-style UI |

> **No silent skips — for *flow elements*.** Encountering any unsupported **standard-namespace flow node
> or structure** above is a *validation failure with the element id + a reason*, not "ignore the bits we
> don't understand." That is the Principle-I guarantee. It does **not** apply to *ignorable extension
> content*: foreign-namespace `<extensionElements>` (`camunda:`/`zeebe:`/…), Diagram Interchange,
> `documentation`, and text annotations are **tolerated and ignored**, because BPMN 2.0 requires
> conformant tools to ignore unknown extensions. Rejecting a file merely for carrying such a block would
> itself be non-canonical.

## Validation rules (publish-time gate)

A BPMN document is accepted for publish only if **all** hold:

1. **Parses** as namespace-aware BPMN 2.0 XML — matched by `{MODEL-ns}localName`, never by prefix
   (`bpmn-moddle`; see [`06`](./06-xml-serialization.md), [`08`](./08-engines-and-extensions.md)).
2. **Single executable process.** Exactly one `<process isExecutable="true">`; no `<collaboration>`,
   pools, lanes, or choreography.
3. **Whitelist only (flow nodes), recursively.** Every flow node — at the process level **and inside each
   `transaction`** — is one of the supported nodes above. Any other standard-namespace flow node ⇒ reject
   with the offending element id + reason (deferred gateways carry their roadmap pointer). No implicit
   split: >1 outgoing sequence flow is allowed **only on an `exclusiveGateway`**.
4. **Event definitions.** Start events carry **no** event definition. End events are **none** (commit) or
   a **cancel** end **only inside a `transaction`**. Boundary events carry exactly one of
   `compensate`/`error`/`cancel` and never attach to a gateway.
5. **Conditions only on gateway splits, flows scoped.** A `conditionExpression` is allowed **only** on a
   flow leaving a multi-out `exclusiveGateway`; there, every **non-default** outgoing flow MUST carry one
   (FEEL; parse-checked at publish — a parse failure rejects with element id + reason), the `default`
   flow MUST NOT, and the `default` attribute MUST reference one of the gateway's own outgoing flows.
   All other flows are plain. Flows connect supported nodes **in the same scope** (a flow may not cross a
   transaction boundary). Cycles on the token path are legal; reachability is BFS-based.
6. **Structural sanity, per scope.** Each scope (the process and each transaction) has exactly one none
   start event, ≥1 none end event, every `*Ref` resolves, and every node is reachable (via sequence flow,
   boundary attachment, or compensation association).
7. **No model-based instantiation.** No `receiveTask instantiate="true"`.
8. **Service task is bound.** Each `serviceTask` (forward or `isForCompensation`) declares a non-empty
   `easy-bpmn:taskDefinition` `type`.
9. **Receive task is well-formed.** Has a `messageRef` resolving to a named `<message>`.
10. **Compensation wiring.** A compensation boundary event has **zero outgoing sequence flow** and
    **exactly one** `<association>` to an `isForCompensation` service task **in the same transaction**.
11. **Error boundary → cancel.** An error boundary event is attached to a `serviceTask`, has exactly one
    outgoing flow to a **cancel end event**, and its `errorRef` resolves to a declared `<bpmn:error>`.
12. **Cancel placement.** A cancel **end event** appears only inside a `transaction`; a cancel **boundary
    event** is attached only to the `transaction`.
13. **Extensions tolerated, not required.** Foreign-namespace `<extensionElements>`, DI, `documentation`,
    and text annotations are accepted and ignored; the only binding `easy-bpmn` reads is its own.

Every rejection MUST state **what** was wrong, **which BPMN element** (by id), and **what the user can
do** (constitution V — operator clarity).

## Runtime mapping (how the profile executes)

| BPMN construct | `easy-bpmn` runtime behavior |
|----------------|------------------------------|
| Publish definition | Create an **immutable**, versioned definition (constitution II); an instance binds one version for life. |
| Start instance | Create instance bound to one version; seed variables; **audit**. |
| **Service Task** | A durable **pull** job: persist the job (status `created`), wait on `bpmn_job_<jobId>`; a remote worker leases by `taskType`, runs, then `complete`/`fail`. On `complete`: persist output, then advance. Idempotent across retries/duplicate callbacks (lease + `lock_token`). |
| **Receive Task** | Durable **wait state**; on an external message, correlate by `messageName` + `correlationKey` to exactly one instance; atomically apply payload + advance (constitution IV). |
| **Transaction** | Enter a saga **scope**; record completed compensatable steps in the saga ledger (input + captured output), atomically with advance. In a loop, **each iteration is its own occurrence-keyed ledger row**, compensated separately. |
| **Exclusive Gateway** | One persisted decision per visit (`gw:elementId#occurrence`): read variables from D1, evaluate non-default outgoing FEEL conditions in document order, first `true` wins, else `default`, else terminal incident `kind=noPath` (Hazard in a transaction). The `gateway_decisions` row + transition + `gatewayDecisionEvaluated` history event commit in **one batch** (persist-before-advance); replay reuses the recorded branch, never re-evaluates. |
| **Cycles** | Re-visiting an element starts a new **occurrence** (fresh job row / ledger row / subscription; step names keyed `element#occurrence`). A visit counter exceeding `MAX_ELEMENT_OCCURRENCES = 1000` → terminal incident `kind=loopLimit` (no auto-compensation; operator `/cancel` available). |
| **Reverse-order compensation** | On transaction cancel (error boundary → cancel end, or operator cancel), run each completed step's `isForCompensation` handler **in reverse completion order**, idempotently; on a compensator's retry-exhaustion → terminal `compensationFailed` + operator remediation (constitution VI). |
| None end | Consume token; transaction commits / instance completes; **audit**. |
| Any transition | Recorded in **audit history**; replay-safe & idempotent (constitution III & V). |

Cloudflare mapping: **one Cloudflare Workflow per process instance** is the durable per-instance
coordinator (`step.do` for replay-safe side effects, `step.waitForEvent` for worker/message callbacks),
plus a **single Durable Object correlation broker** keyed by `workspaceId + messageName + correlationKey`
for strongly-consistent message correlation. **D1** is the canonical, queryable store (inspection reads
D1, never Workflow state). See [`07-execution-semantics.md`](./07-execution-semantics.md) and SAGA design
§4–§5 for detail.

## Accept / reject examples

**ACCEPT** — the canonical transaction-saga above (forward path + compensation handlers + boundary
events + associations round-trips cleanly when `easy-bpmn` + DI are ignored).

**ACCEPT** — the linear happy path: `startEvent(none) → serviceTask → receiveTask → endEvent(none)`.

**ACCEPT** — a conditional saga: an XOR split whose non-default outgoing flows carry FEEL conditions
(`method = "card"`), a `default` flow, an XOR join, and a loop back through the gateway — see
[`examples/conditional-fulfillment-saga.bpmn`](../../examples/conditional-fulfillment-saga.bpmn).

**REJECT** — a parallel gateway (deferred-gateway pointer):
> `Parallel (AND) gateways need concurrent tokens, which are deferred to concurrency (M4). Only
>  exclusiveGateway branching is supported.`

**REJECT** — a condition on a flow not leaving an exclusiveGateway, an implicit split on a task, a
non-default gateway flow with no condition, a `default` referencing a foreign flow, or an invalid FEEL
expression — each with the offending element id.

**REJECT** — a compensation boundary with an outgoing sequence flow:
> `Compensation boundary event 'reserveStock_comp' must have zero outgoing sequence flows; it wires to a
>  handler via <association>.`

**REJECT** — an error boundary whose `errorRef` does not resolve:
> `Error boundary event 'shipping_err' has an errorRef that does not resolve to a declared <bpmn:error>.`

**REJECT** — a cancel end event outside a transaction:
> `Cancel end event 'ProcCancel' is outside any transaction. A cancel end event is allowed only inside a
>  <transaction>.`

## Resolved decisions & roadmap

**Resolved** ([`research.md`](../../specs/001-bpmn-lite-orchestrator-mvp/research.md) +
[`specs/002-saga-orchestrator/research.md`](../../specs/002-saga-orchestrator/research.md)):
- **Service-task → worker binding.** `easy-bpmn:taskDefinition type` in `<extensionElements>`; routed by
  `type`. Reusing `camunda:`/`zeebe:` vocabulary was rejected.
- **Saga modeling.** Canonical BPMN transaction + compensation boundary + `isForCompensation` handler +
  association + cancel; not a custom extension. The only additive binding stays `easy-bpmn:taskDefinition`.
- **Worker model.** Pull / external-task (`/jobs/activate`, `/complete`, `/fail`); the orchestrator never
  knows service addresses.
- **Parser.** `bpmn-moddle` (namespace-aware).
- **Expression language (M2).** **FEEL via `feelin`** — the BPMN/DMN-ecosystem language (Camunda 8
  semantics), pure-JS interpreter (Workers-compatible, no `eval`), edited natively by Camunda Modeler →
  true round-trip. JSONLogic / a custom JS subset were rejected as non-standard blobs inside
  `conditionExpression` (they fail the canonicity test).
- **Cycles (M2).** Occurrence-discriminated extension of the single-token engine; the tokens-first
  alternative (pulling M4's `execution_tokens` forward) was rejected.

**Roadmap (per-milestone target semantics):**
- **M2 — conditional sagas: SHIPPED** (constitution v2.1.0; this profile + [`03-gateways.md`](./03-gateways.md)).
- **M3 — time & failure taxonomy:** timers, per-step timeouts, error catalog. [`01-events.md`](./01-events.md).
- **M4 — concurrency:** `parallelGateway`, token set, AND-join, parallel-branch compensation.
  [`07-execution-semantics.md`](./07-execution-semantics.md).
- **M5 — composition:** `callActivity`, non-transaction `subProcess`, `multiInstance`, `signal`/`escalation`.
  [`02-activities.md`](./02-activities.md).

> Any expansion of this profile requires amending the constitution first (Governance & scope). This file
> is updated in lockstep with that amendment and with the `src/bpmn/validator.ts` accept/reject behavior.
