# 09 — The `easy-bpmn` BPMN Profile

This is the **contract** between the BPMN standard and what `easy-bpmn` actually executes. It is the
operational reading of the [constitution](../../.specify/memory/constitution.md) (now **v2.5.0**, with
the widened **Principle I — "Standard BPMN Profile Only"** covering the M2 conditional set, **the M3
time-&-failure-taxonomy set** — interrupting boundary timers, timer/message intermediate catch events,
the `eventBasedGateway`, and free error-boundary routing — **the M4 in-instance concurrency set**
(block-structured `parallelGateway` (AND) / `inclusiveGateway` (OR), SESE-only) — **and the M5 composition
set** (embedded `subProcess`, scope-hosted error/timer boundaries, the error end event, `callActivity`,
`multiInstance`, escalation, signal, and the first non-interrupting signal/escalation boundaries) — and
**Principle VI — "SAGA / Compensation Integrity"**, redefined per causal chain with a multi-token
completion rule, and generalized to a scope subtree by M5). The M3
set was **accepted in v2.2.0 and opened per validator layer**, and the whole set has now **shipped
(M3-L2/L3/L4)**: free error-boundary routing, interrupting boundary timers, **both** the **timer** and the
**message** intermediate catch, and the `eventBasedGateway` (the timer/message race). The M4 concurrency
set was **accepted in v2.3.0** and has now **shipped**: block-structured `parallelGateway` (AND) regions
(token frontier + AND-join) through **M4-L3**, `inclusiveGateway` (OR) regions through **M4-L4**,
parallel-branch compensation through **M4-L5**, and the concurrency caps, R2 overlay offload, per-token
observability, and the `tokens` inspection array through **M4-L6**. The **whole M5 composition set was
accepted, up front, in v2.5.0** and its runtime opens **per layer**: **M5-L1 (embedded scopes +
hierarchical exceptions) has shipped** — see the interim markers below; M5-L2 (`callActivity`), M5-L3
(`multiInstance`), M5-L4 (escalation + event subprocess), and M5-L5 (signal) remain **accepted-in-
governance, interim-rejected at publish** until their own layers open. When in doubt, the constitution
wins. The authoritative designs are
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
- **M2: conditional sagas** — `bpmn:exclusiveGateway` (XOR split + pass-through join), FEEL
  `conditionExpression` (via `feelin`) on flows leaving an exclusiveGateway, the gateway-owned `default`
  flow, and **cycles on the token path** (occurrence-discriminated iterations). Documented here;
  execution semantics in [`03-gateways.md`](./03-gateways.md).
- **M3 → time & failure taxonomy** (timers, the job-activation DLQ, error catalog):
  [`01-events.md`](./01-events.md). The M3 construct set — interrupting boundary `timerEventDefinition` on
  a `serviceTask`/`receiveTask`, timer/message `intermediateCatchEvent`, the `bpmn:eventBasedGateway`, and
  free error-boundary routing — is **accepted in constitution v2.2.0** and was **opened per validator
  layer**; the whole set has now **shipped (M3-L2/L3/L4)**: **interrupting boundary timers**, **free
  error-boundary routing**, **both** the **timer** and the **message** `intermediateCatchEvent`, and the
  `bpmn:eventBasedGateway` (the timer/message race decided on a single `gateway_decisions` row — TASK-46).
  **One M1 exception (already shipped):** a single **job-level activation TTL**
  (`service_task_jobs.activation_expires_at`, default 15 min) backs the un-leasable-job DLQ — a job
  nobody leases in time settles to a terminal incident `kind=jobActivationTimeout` via a per-job `JobScheduler`
  Durable Object alarm. It is *not* a model-level timer (no BPMN timer event); general (model-level) timers
  are the staged M3 set above. Retry backoff (exponential + jitter, base 1s / factor 2 / cap 30s) and
  poison-job termination (`kind=poison`, no compensation) ship in M1 too.
  **M4 single-wake (TASK-54) — un-guarded-wait liveness (standard BPMN):** the single `bpmn_wake` replaced
  the per-leaf multi-wait and retired the M3 leaf wait CAPS. An UN-GUARDED **service task** (no boundary
  timer) keeps operational liveness ONLY via this job-activation DLQ `jobActivationTimeout`; an UN-GUARDED
  **receive task** / **message `intermediateCatchEvent`** (no boundary timer, no modeled deadline) has no
  deadline and waits **indefinitely** — the M3 leaf `waitTimeout` durable-wait cap is **retired** and the
  `waitTimeout` incident kind is now **unproduced** (kept as a vestigial enum value until the dead-code
  sweep). `compensationFailure` remains the compensation **retry-exhaustion** terminal.
- **M4: concurrency — SHIPPED** (constitution v2.3.0) — block-structured (SESE) `parallelGateway` (AND)
  and `inclusiveGateway` (OR) regions: a token frontier (multiple concurrent tokens per instance), the
  AND/OR join barrier, branch-local variable scopes merging at the join, frontier-empty completion, and
  parallel-branch (straggler-catching) compensation. Execution semantics in
  [`07-execution-semantics.md`](./07-execution-semantics.md); gateway routing in
  [`03-gateways.md`](./03-gateways.md).
- **M5 → composition — ACCEPTED IN FULL v2.5.0, opening per layer** — the whole composition set (embedded
  `subProcess`, scope-hosted error/timer boundaries, an error end event, `callActivity`,
  `multiInstanceLoopCharacteristics`, `escalation`, `signal`, and the first non-interrupting
  signal/escalation boundaries) was accepted by the single M5 amendment; the runtime opens **per layer**,
  M5-L1 through M5-L5. **M5-L1 (embedded scopes + hierarchical exceptions) has SHIPPED** — the plain
  embedded `subProcess`, error/timer boundaries on a scope, the error end event, hierarchical error
  bubbling, the two-tier commit shield, and the root-relative reverse pass are all runtime-open — see below.
  [`02-activities.md`](./02-activities.md).

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
to an `isForCompensation` handler. A business failure is caught by an **error boundary event**; in the
canonical rollback pattern it routes to a **cancel end event**, and cancelling the transaction triggers
**reverse-order compensation** of the completed steps. (Since **M3-L2** an error boundary may instead route
to **any token-path node in the same scope** — e.g. an alternate forward path — leaving the saga ledger
intact; the completed steps stay compensatable if the saga cancels later. See the supported set + rule 11.)
A **cancel boundary event** on the transaction takes the "saga failed" path.

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
> single token to its outgoing target — a cancel end event, or (since **M3-L2**) any other token-path
> node — it is **not** a parallel split, and an XOR gateway routes the single token down exactly one
> outgoing flow. True parallelism (multiple concurrent tokens) is M4.

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
| **Compensation Boundary Event** | `boundaryEvent` + `compensateEventDefinition` | A **compensation marker**: it is **neither interrupting nor non-interrupting** (the `cancelActivity` axis does not apply). MUST have **zero outgoing `sequenceFlow`** and **exactly one** outgoing `<association>` to an `isForCompensation` activity **in the same immediate scope** (the handler's own enclosing scope need not itself be a `transaction` — see the ancestry rule on the Compensation Handler row and rule 10). |
| **Error Boundary Event** | `boundaryEvent` + `errorEventDefinition` | **Interrupting**; attached to a `serviceTask`, a `subProcess`, **or** a `transaction` (M5-L1 — never a compensation handler). Routes its single outgoing flow to **any token-path node in the same scope** (M3-L2) — no longer cancel-end-only. An activity/scope may carry **any number of boundaries with distinct, non-empty `@errorCode`s** plus **at most one catch-all** (`errorEventDefinition` with **no** `errorRef`). A coded boundary's `errorRef` MUST resolve to a declared root `<bpmn:error>` with a non-empty `@errorCode`. Matching on a thrown error's code (a worker `fail.errorCode`, or an **error end event**'s `errorRef`): **exact `@errorCode` → catch-all → the attachment-chain walk continues to the next enclosing scope → uncaught Hazard at the process root** (the catch-all catches any business code, even undeclared ones). On a scope host, catching **interrupts the whole subtree without compensation** (Hazard-vs-Cancel, M5-L1 — see [`07-execution-semantics.md`](./07-execution-semantics.md)); on a `serviceTask` host it behaves exactly as before M5-L1. |
| **Cancel Boundary Event** | `boundaryEvent` + `cancelEventDefinition` | **Interrupting**; attached **only to the `transaction`**; its single outgoing flow is the "saga failed" path. |
| **Boundary Timer (M3-L3; scope hosts M5-L1)** | `boundaryEvent` + `timerEventDefinition` | **Interrupting** (`cancelActivity` absent/`true`); attached to a `serviceTask`, a `receiveTask` (inside or outside a transaction), **or** — since **M5-L1** — a `subProcess`/`transaction` (never a compensation handler). **At most one** per activity/scope. Exactly **one** static ISO-8601 trigger (`timeDate`\|`timeDuration`; `timeCycle`/FEEL/non-parsing reject). One outgoing flow to any token-path node in the same scope. On fire (a per-timer `JobScheduler` DO alarm; D1 `timers`/`timer_outcomes` are canonical) the token takes that path; on a **task** host the in-flight job is abandoned / its message subscription superseded (a late worker callback / publish gets the stable no-op / buffered outcome); on a **scope** host (M5-L1) the whole subtree is interrupted **without compensation** — completed effects retained as `pending`/`committedLocal` rows, the drain deferred to the next engine rewalk (idempotent, retain-only) so the fire transition stays a single atomic batch. See **rule 14**. |
| **Timer Intermediate Catch (M3-L4)** | `intermediateCatchEvent` + `timerEventDefinition` | A **delay step on the token path** — the catch IS the wait. Exactly **one incoming** and **one outgoing** sequence flow (a single-token delay, not a join). Allowed at process level **and inside a `transaction`** (the saga scope stays open across the delay). Exactly **one** static ISO-8601 trigger (`timeDate`\|`timeDuration`; `timeCycle`/FEEL/non-parsing reject — same well-formedness as a boundary timer). On fire (a per-timer `JobScheduler` DO alarm; D1 `timers`/`timer_outcomes` canonical) the token advances down the single outgoing flow; there is **no** host job/subscription to abandon. See **rule 15**. |
| **Message Intermediate Catch (M3-L4)** | `intermediateCatchEvent` + `messageEventDefinition` | A **correlation wait on the token path** with **identical** wait/correlation/resume semantics to a `receiveTask` (the **same** subscription/broker machinery; the `<message>` carries only its name; the correlation key is supplied via the **API** at instance start). Exactly **one incoming** and **one outgoing** sequence flow (a single-token wait, not a join). Allowed at process level **and inside a `transaction`** (the saga scope stays open across the wait). It is an **event, not an activity**: **no** `easy-bpmn:taskDefinition`, and **no** boundary events attach. Early/buffered messages are claimed at registration; a correlated message's payload is applied **atomically** with the transition out of the wait; a duplicate publish returns the stable prior outcome (never double-advances). See **rule 16**. |
| **Event-Based Gateway (M3-L4)** | `eventBasedGateway` | A **deterministic race** over its branch catches. **≥2 outgoing flows**, every target an `intermediateCatchEvent` (timer or message) whose **only** incoming flow is from this gateway; **≤1 timer branch**; message branches reference **distinct** messages; `instantiate="true"` and `eventGatewayType="Parallel"` reject. Token arrival registers every message branch + arms the timer branch, then parks; whichever event resolves **first wins** (early/buffered messages win at registration, document-order tie-break). The race decides on a **single `gateway_decisions` row** claimed by a plain INSERT in the same batch as the transition — two concurrent writers (broker message-apply vs `fireTimer`), so the loser converts. The winner advances straight to the catch's single outgoing flow (the catch is never re-dispatched). See **rule 17**. |
| **Parallel Gateway (M4-L1)** | `parallelGateway` | **Block-structured (SESE) AND**: split (1 in, N out — fork) paired with exactly one matching `parallelGateway` join (N in, 1 out — synchronise), validated at publish via post-dominators (no matching join, a branch escaping the region, an uncontrolled merge inside it, a mismatched join type, non-laminar nesting, or two concurrent branches awaiting the same message name reject with element ids). No conditions on its outgoing flows; `instantiate="true"` rejects. The join is satisfied once a token from every activated branch (origin-branch keyed) has arrived. **Multi-token runtime shipped (M4-L3):** the frontier fans a branch token out per out-flow (all leasable at once), the AND-join barrier waits for every activated branch, and branch-local variable overlays merge in split out-flow document order at the join. |
| **Inclusive Gateway (M4-L1)** | `inclusiveGateway` | **Block-structured (SESE) OR**: split takes every outgoing flow whose FEEL condition is true (≥1; else the gateway-owned `default`) and is paired with a matching `inclusiveGateway` join that waits for a token from every **activated branch** (the recorded subset). Same SESE validation as the parallel gateway and the **same** condition/`default` rules as the `exclusiveGateway` split. `instantiate="true"` rejects. **OR runtime shipped (M4-L4):** the split's activated subset is recorded in `gateway_decisions.activated_flow_ids` (document order) and the OR-join waits for exactly that recorded subset; zero activation with no `default` raises terminal `noPath`. |
| **Compensation Handler** | `serviceTask isForCompensation="true"` | A handler off the token path, reached **only** via compensation (the association from a compensation boundary). Bound by its own `easy-bpmn:taskDefinition type`. Must live inside a transaction — since **M5-L1** this is an **ancestry** check: *some* enclosing scope (not necessarily the immediate one) must be a `transaction`, so a handler may sit inside a `subProcess` that is itself nested in a `transaction`. See **rule 10**. |
| **Embedded Sub-process (M5-L1)** | `subProcess` (plain — not `triggeredByEvent`, not `adHocSubProcess`, no loop characteristics) | A **bookkeeping scope**: one none-start, ≥1 none-end, **shares the parent's variable space**, opens no saga ledger commit of its own. Nests with `transaction` in either order; error/timer boundary events may attach to it (see above). Its completed steps are ledgered against whichever **enclosing transaction** they belong to (the ledger-write gate is "some ancestor is a transaction", not "immediate scope is a transaction"). Bounded by `MAX_SCOPE_DEPTH = 8` (see [`07-execution-semantics.md`](./07-execution-semantics.md)). |
| **Cancel End Event** | `endEvent` + `cancelEventDefinition` | Allowed **only inside a `transaction`** — the cancel end's **immediate** enclosing scope must be the transaction (a cancel end directly inside a plain `subProcess` rejects, even if an ancestor is a transaction). Reaching it cancels that transaction's **subtree** → root-relative reverse-order compensation (M5-L1 generalizes this from a single scope to the scope subtree). A **nested** transaction's cancel end is **non-terminal**: the instance continues on the cancel boundary's outgoing path; only a **top-level** transaction's cancel end (or operator `/cancel`) settles the instance terminally. A nested transaction containing a cancel end MUST carry a cancel boundary (else there is no failure path to continue on) — see **rule 12**. |
| **Error End Event (M5-L1)** | `endEvent` + `errorEventDefinition` | Legal at process level or inside any scope. Reaching it consumes the token and throws the error **from the scope containing the end event** — the attachment-chain walk (exact `@errorCode` → catch-all → next enclosing scope) finds the nearest catching boundary; uncaught at the process root it settles a terminal incident `kind=uncaughtError`. `errorRef` MUST resolve to a declared `<bpmn:error>` with a non-empty `@errorCode` (the same publish-time resolution an error boundary uses). See **rule 18**. |
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

### Accepted in v2.2.0, opened per validator layer — now fully shipped

The M3 time-&-failure-taxonomy set was **accepted by the constitution (Principle I, v2.2.0)** and its
runtime opened in layers (accepted-in-governance, staged-in-runtime). **The whole set has now shipped** —
the last construct, the `eventBasedGateway`, landed in **M3-L4 (TASK-46)**; its
`DEFERRED_GATEWAY_REASONS` pointer and `check:docs` guard 5 flipped together at that point. The
[M3 design](../superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md) (§3, §4.5, §8, §10) and the
recorded [M3 Constitution Check](../../specs/002-saga-orchestrator/m3-constitution-check.md) are the
source artifacts. No M3 construct remains in the interim (rejected-until-its-layer-ships) state.

### Accepted in v2.3.0 (M4) — block-structured concurrency, now shipped

The M4 in-instance concurrency gateways — `parallelGateway` (AND) and `inclusiveGateway` (OR),
**block-structured (single-entry/single-exit, SESE) only** — were **accepted by the constitution
(Principle I, v2.3.0)** and their `DEFERRED_GATEWAY_REASONS` pointer + `check:docs` guard 5 flipped in
lockstep at **M4-L1 (TASK-48)**. Publish-time validation accepts a balanced parallel/inclusive region and
records its split↔join topology in the graph IR (`regions`); a non-SESE region (no matching join, a branch
escaping the region, an uncontrolled merge, a mismatched join type, non-laminar nesting, or two concurrent
branches awaiting the same message name) is **rejected with element ids**. The concurrency **runtime has
now shipped**: the token-frontier engine + the `0007_tokens.sql` token tables (**M4-L2**), the AND fan-out
+ join barrier + frontier-empty completion + branch-local merge (**M4-L3**), the OR activation set +
OR-join (**M4-L4**), parallel-branch (straggler-catching, lineage-ordered) compensation (**M4-L5**), and the
concurrency caps, R2 overlay offload, per-token observability + the `tokens` inspection array (**M4-L6**).
The [M4 design](../superpowers/specs/2026-06-13-m4-concurrency-design.md) (§4–§11) and the recorded
[M4 Constitution Check](../../specs/002-saga-orchestrator/m4-constitution-check.md) are the source artifacts.

**Shipped:** The `eventBasedGateway` (a deterministic race over timer/message branch catches, deciding on a
single `gateway_decisions` row claimed by a plain INSERT in the transition batch) shipped in **M3-L4
(TASK-46)** — ≥2 branches, every target a single-incoming intermediate catch, ≤1 timer branch, distinct
messages; `instantiate`/`Parallel` reject. See the supported element set above and **rule 17**.

**Shipped:** Free error-boundary routing (any number of distinct-`@errorCode` interrupting boundaries + ≤1
catch-all, each targeting any token-path node in the same scope) shipped in **M3-L2 (TASK-42)** — the M1
"error boundary must target a cancel end event" restriction is lifted; see the supported element set above
and **rule 11**.

**Shipped:** Interrupting boundary timers (`boundaryEvent` + `timerEventDefinition` on a
`serviceTask`/`receiveTask`, static ISO-8601 `timeDate`/`timeDuration`, at most one per activity, never on a
`transaction`) shipped in **M3-L3 (TASK-44)** — the timer fires via a per-timer `JobScheduler` DO alarm,
claims its `timer_outcomes` decider in the same batch as the transition out of the wait, and routes the
token down the boundary path; see the supported element set above and **rule 14**.

**Shipped:** The **timer** intermediate catch (`intermediateCatchEvent` + `timerEventDefinition`, exactly one
incoming + one outgoing, at process level or inside a `transaction`) shipped in **M3-L4 (TASK-45)** — a
delay step on the token path. It is its own occurrence-keyed token node (`timer:el#occ`); the fire batch
claims its `timer_outcomes` decider in the same batch as the advance down the single outgoing flow (the catch
IS the wait — no host job/subscription). See the supported element set above and **rule 15**.

**Shipped:** The **standalone message** intermediate catch (`intermediateCatchEvent` + `messageEventDefinition`,
exactly one incoming + one outgoing, at process level or inside a `transaction`) shipped in **M3-L4 (TASK-46)** —
a correlation wait on the token path with **identical** semantics to a `receiveTask`, driven by the **same**
subscription/correlation/broker machinery (it reuses `registerReceive`/`applyMessage`, not a parallel copy).
It correlates in both publish orders (early/buffered claimed at registration; later message correlated against
the active subscription), applies the payload atomically with the transition out of the wait, and dedups
duplicate publishes. See the supported element set above and **rule 16**.

Every M3 construct's row has moved into the supported element set above and the validator
accepts-and-validates it. No construct remains in the interim (rejected-until-its-layer-ships) state.

### Accepted in v2.5.0 (M5) — composition, opening per layer

The **whole** M5 composition set — non-transaction `subProcess`, error/timer boundaries on a
`subProcess`/`transaction`, an error end event, `callActivity`, `multiInstanceLoopCharacteristics`
(parallel and sequential), `escalation` throw/boundary + event subprocess, `signal` throw/catch, and the
first non-interrupting boundary events (signal/escalation only) — was **accepted by the constitution
(Principle I, v2.5.0) up front**, per the single-amendment governance lane (decomposition doc §5). Unlike
M3/M4, where each amendment accepted a set that then opened across a run of layers within the *same*
milestone, M5 is decomposed into **five ordered runtime layers under one milestone** (M5-L1…L5); v2.5.0
accepts the entire five-layer set in one MINOR bump, and the runtime opens **one layer at a time**, each
layer recording its own Constitution Check (`specs/002-saga-orchestrator/m5-L{N}-constitution-check.md`)
and flipping its own construct rows here from "accepted-in-governance, interim-rejected-at-publish" to
"runtime open" — exactly the discipline the M3 (L2–L4) and M4 (L1–L6) amendments established. The
[decomposition design](../superpowers/specs/2026-06-20-m5-composition-design.md) (the 5-layer split,
adversarially hardened) and the [M5-L1 layer design](../superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md)
are the source artifacts; the recorded [M5-L1 Constitution Check](../../specs/002-saga-orchestrator/m5-L1-constitution-check.md)
is the first layer's governance record.

**M5-L1 (embedded scopes + hierarchical exceptions) — SHIPPED, runtime open:**

- Plain embedded `bpmn:subProcess` (one none-start, ≥1 end, sharing the parent variable scope; arbitrary
  nesting of `subProcess`/`transaction` in either order) — **shipped**: a pure bookkeeping scope (no ledger
  commit of its own), whitelisted by the validator, walked by the engine as `scopeEntered`/`scopeExited`
  history bookkeeping. See the supported set + rule 6 (structural sanity now applies per scope, including
  `subProcess` scopes) below.
- Error and timer `boundaryEvent`s hosted on a `subProcess`/`transaction` — **shipped**. A non-cancel
  interrupting boundary (an error catch, or a scope timer firing) interrupts its subtree **without**
  auto-compensation — completed effects stay `pending`/`committedLocal`, retained for a later ancestor
  cancel or operator `/cancel` (Hazard-vs-Cancel; Principle VI). See rules 11 and 14.
- The error **end** event (`endEvent` + `errorEventDefinition`) — **shipped**: throws from the scope
  containing the end event, walks the attachment chain outward (same exact-`@errorCode` → catch-all
  precedence an error boundary uses), and settles a new terminal incident kind `uncaughtError` if the walk
  reaches the process root uncaught (worker/service-task errors keep `serviceTaskFailure`). See the
  supported set + rule 18.
- Hierarchical (up-scope) error bubbling and the generalized scope-subtree compensation model — **shipped**:
  the **two-tier commit shield** (`committedLocal` non-terminal on a nested transaction's own commit,
  sealed `committed` only at the outermost commit), the **root-relative reverse cursor** (a global
  per-instance `seq`, subtree-filtered, ancestry-eligible `committedLocal` rows included), the **straggler
  cohort** and **live-token barrier** un-gated to run for every graph (subtree-filtered, not just M4
  region graphs), and the **compensation-reachability ancestry check** (a handler is legal iff *some*
  ancestor scope is a transaction, not just the immediate one). See
  [`07-execution-semantics.md`](./07-execution-semantics.md) for the runtime mechanics and rule 10 below
  for the validator rule.
- `MAX_SCOPE_DEPTH = 8` (publish-time cap on scope nesting depth, `src/runtime/engine.ts`) — **shipped**:
  enforced by the validator at publish (element id + reason), because in L1 scope depth is fully static (no
  `callActivity`, no `multiInstance` yet). See rule 19.
- **Modeling guidance.** For a **timer-triggered rollback**, route the timer boundary's outgoing flow to a
  **cancel end event inside** the transaction — that *is* Cancel, and it does compensate. A timer boundary
  routed anywhere else is deliberately Hazard-class: it interrupts the scope but does **not** compensate,
  and its retained ledger rows wait for a later ancestor cancel or operator `/cancel`.
- **Nested cancel is non-terminal.** A cancel end **inside a nested transaction** (one enclosed by another
  scope, not the process root) compensates only its own transaction's subtree, then the instance
  **continues running** on the cancel boundary's outgoing (failure) path in the parent scope. Only a
  **top-level** transaction's cancel end, or an operator `/cancel` (compensation root = the process),
  settles the instance terminally.
- **Do not loop a boundary path back into its own scope.** A fired scope timer and a nested cancel both
  *skip* the scope's interior on the rewalk, so **re-entering an abnormally-interrupted scope is not
  supported in M5-L1**: route abnormal boundary paths **forward**, and let a guarded retry loop re-enter a
  scope **only after it commits** (the shipped commit-loop shape). Publish statically rejects an *unguarded*
  loop-back; a *condition-guarded* one still publishes but a runtime hit is caught by a deterministic
  `scopeReentry` incident (the walk-local `skippedScopes` backstop, TASK-71) rather than silently desyncing.

**M5-L2…L5 — accepted (v2.5.0), runtime not yet open — publish still rejects (interim):**

- `bpmn:callActivity` (M5-L2) — **accepted (v2.5.0), runtime not yet open — publish still rejects
  (interim)**; stays in the whitelist reject with an M5-L2 roadmap pointer until that layer opens it.
- `multiInstanceLoopCharacteristics` (parallel and sequential, M5-L3) — **accepted (v2.5.0), runtime not
  yet open — publish still rejects (interim)**.
- `escalation` throw/boundary and the event subprocess (`triggeredByEvent="true"`, M5-L4) — **accepted
  (v2.5.0), runtime not yet open — publish still rejects (interim)**.
- `signal` throw/catch, workspace-scoped 1:N broadcast (M5-L5) — **accepted (v2.5.0), runtime not yet
  open — publish still rejects (interim)**.
- The first non-interrupting boundary events, accepted only for signal/escalation (M5-L4/L5) — **accepted
  (v2.5.0), runtime not yet open — publish still rejects (interim)** until their hosting construct's layer
  opens.

**Deferred beyond M5 (not opened by any M5 layer):** the `compensateEventDefinition` boundary on a
subProcess (compensate-as-unit) stays deferred **post-M5** (decomposition §6 M5-L1 decision 6) — in M5-L1 a
subProcess's completed steps are simply rows in the enclosing transaction's ledger, not a separately
compensatable unit.

### Still deferred (need a future constitution amendment)

These remain out of scope; each requires its own later-milestone amendment first (v2.5.0 opens the whole
M5 composition set noted above — up front, per layer — plus the M2/M4 sets noted earlier; nothing below is
opened by it):

| Category | Rejected elements |
|----------|-------------------|
| Tasks | abstract `task`, `userTask`, `sendTask`, `manualTask`, `scriptTask`, `businessRuleTask` |
| Events | timer **start** events, `conditional` / `link` event definitions; a **top-level (process-level)** `signal` start event; **non-interrupting** *timer or conditional* boundary events and `timeCycle` triggers; `intermediateThrowEvent` other than `escalation`/`signal` (M5-L4/L5); **non-catch** message events (message throw/end); `compensateEventDefinition` on a throw/end; terminate end; a non-cancel end-event definition. (Interrupting boundary timers **and both the timer and the message intermediate catch** are shipped — see the supported set above; not here. `signal`/`escalation` throw/boundary/event-subprocess-start and **non-interrupting** signal/escalation boundaries are **M5-accepted (v2.5.0)** — see the M5 interim markers above; not here. An error **end** event is **M5-L1-accepted and opening now** — see above; not here.) |
| Gateways | `complexGateway` (not on the roadmap), and any **implicit split (>1 outgoing sequence flow on a non-gateway node)** — pointers in lockstep with `DEFERRED_GATEWAY_REASONS` (`src/bpmn/profile.ts`). (`eventBasedGateway` is M3-accepted and **shipped at L4**; `parallelGateway`/`inclusiveGateway` are **M4-accepted and SESE-validated at publish since M4-L1** — all see the supported set above.) |
| Flow | `conditionExpression` on any flow **not leaving an `exclusiveGateway`**, a `default` attribute on a non-gateway node, `messageFlow`, a sequence flow crossing a transaction boundary (a scope boundary, generalized by M5-L1 — see above) |
| Structure | `adHocSubProcess`, `collaboration`, `participant` (pools), `laneSet`/`lane`, `choreography`, a non-process `calledElement` (GlobalTask). (Non-transaction `subProcess` is **M5-L1-accepted and opening now**; `callActivity` is **M5-accepted (v2.5.0), runtime not yet open until M5-L2** — see the M5 interim markers above; neither is here.) |
| Loops/data | `standardLoopCharacteristics` (the activity **marker** — distinct from the accepted M2 cycles drawn as sequence flows through a gateway and from `multiInstanceLoopCharacteristics`), MI's standard ItemAwareElement data bindings (`loopDataInputRef`/`loopDataOutputRef`/`inputDataItem`/`outputDataItem`), an MI with no recognized cardinality source, `dataObject`/`dataStore`/`dataInput`/`dataOutput`. (`multiInstanceLoopCharacteristics` itself is **M5-accepted (v2.5.0), runtime not yet open until M5-L3** — see the M5 interim markers above; not here.) |
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
   scope (`transaction` or, since M5-L1, `subProcess`), recursively to `MAX_SCOPE_DEPTH = 8`** — is one of
   the supported nodes above. Any other standard-namespace flow node ⇒ reject with the offending element id
   + reason (deferred gateways/constructs carry their roadmap pointer). No implicit split: >1 outgoing
   sequence flow is allowed **only on an `exclusiveGateway`, `eventBasedGateway`, `parallelGateway`, or
   `inclusiveGateway`**.
4. **Event definitions.** Start events carry **no** event definition. End events are **none** (commit /
   scope exit), a **cancel** end **only inside a `transaction`** (its **immediate** enclosing scope, not
   merely an ancestor — rule 12), or — since **M5-L1** — an **error** end (rule 18). Boundary events carry
   exactly one of `compensate`/`error`/`cancel`/`timer` and never attach to a gateway.
5. **Conditions only on gateway splits, flows scoped.** A `conditionExpression` is allowed **only** on a
   flow leaving a multi-out `exclusiveGateway`; there, every **non-default** outgoing flow MUST carry one
   (FEEL; parse-checked at publish — a parse failure rejects with element id + reason), the `default`
   flow MUST NOT, and the `default` attribute MUST reference one of the gateway's own outgoing flows.
   All other flows are plain. Flows connect supported nodes **in the same scope** (a flow may not cross a
   scope boundary — `transaction` or `subProcess`). Cycles on the token path are legal; reachability is
   BFS-based.
6. **Structural sanity, per scope.** Each scope (the process, each `transaction`, and — since M5-L1 — each
   `subProcess`) has exactly one none start event, ≥1 none end event, every `*Ref` resolves, and every node
   is reachable (via sequence flow, boundary attachment, or compensation association).
7. **No model-based instantiation.** No `receiveTask instantiate="true"`.
8. **Service task is bound.** Each `serviceTask` (forward or `isForCompensation`) declares a non-empty
   `easy-bpmn:taskDefinition` `type`.
9. **Receive task is well-formed.** Has a `messageRef` resolving to a named `<message>`.
10. **Compensation wiring and reachability (ancestry generalized, M5-L1).** A compensation boundary event
    has **zero outgoing sequence flow** and **exactly one** `<association>` to an `isForCompensation`
    service task **in the same immediate scope** (unchanged mechanism — the boundary and its handler must
    share a scope). Separately, an `isForCompensation` handler must be **reachable by a Cancel trigger**:
    *some* scope on its ancestor chain — not necessarily the immediate one — must be a `transaction`; a
    handler whose chain reaches the process root with no enclosing transaction is rejected (element id +
    reason: "the handler has no trigger"). This lets a handler live inside a `subProcess` that is itself
    nested in a `transaction`, while still catching every case the pre-M5-L1 immediate-parent check caught.
11. **Error boundary routing (M3-L2; scope hosts M5-L1).** An error boundary event is attached to a
    `serviceTask`, a `subProcess`, **or** a `transaction` (since M5-L1 — never an `isForCompensation`
    handler) and has exactly one outgoing flow to **any token-path node in the same scope** (not a start
    event, a boundary event, or a handler). Per activity/scope: **distinct, non-empty `@errorCode`s** on
    the coded boundaries (each `errorRef` resolving to a declared `<bpmn:error>`) plus **at most one
    catch-all** (no `errorRef`). A thrown error's code (a worker `fail.errorCode`, or an error end event's
    `errorRef`) matches **exact `@errorCode` → catch-all → the attachment-chain walk continues to the next
    enclosing scope → uncaught Hazard** at the process root. Catching on a scope host **interrupts the
    whole subtree without compensation** (Hazard-vs-Cancel — see rule 14 and
    [`07-execution-semantics.md`](./07-execution-semantics.md)).
12. **Cancel placement.** A cancel **end event**'s **immediate** enclosing scope MUST be a `transaction`
    (an ancestor transaction further up the chain does not satisfy this — a cancel end directly inside a
    plain `subProcess` rejects even when that `subProcess` is nested in a transaction); a cancel **boundary
    event** is attached only to a `transaction`. Since **M5-L1**: a **nested** transaction (enclosed by any
    scope, not the process root) that contains a cancel end MUST itself carry a cancel boundary — otherwise
    its cancellation's reverse pass would have no failure path to continue the enclosing scope on (element
    id + reason). A top-level transaction needs no cancel boundary: its cancel end settles the instance
    terminally.
13. **Extensions tolerated, not required.** Foreign-namespace `<extensionElements>`, DI, `documentation`,
    and text annotations are accepted and ignored; the only binding `easy-bpmn` reads is its own.
14. **Interrupting boundary timer (M3-L3; scope hosts M5-L1).** A `boundaryEvent` + `timerEventDefinition`
    is **interrupting** (`cancelActivity` absent or `true`; `cancelActivity="false"` rejects — M4) and
    attaches to a `serviceTask` **or** `receiveTask` (inside or outside a transaction), **or** — since
    **M5-L1** — a `subProcess`/`transaction` (never an `isForCompensation` handler). **At most one** timer
    boundary per activity/scope. Exactly **one outgoing flow** to any token-path node in the same scope
    (the rule 11 endpoint rules apply). The `timerEventDefinition` carries exactly **one** of
    `timeDate`|`timeDuration` as a **static ISO-8601 literal that parses** — `timeCycle`, a FEEL expression,
    a non-parsing literal, or zero/two time children each reject with element id + reason. Firing on a
    **task** host abandons its in-flight job / supersedes its subscription (unchanged since M3-L3); firing
    on a **scope** host (M5-L1) generalizes "abandon" to "interrupt the subtree without compensation" —
    every completed step's ledger row is retained (`pending`/`committedLocal`), the drain deferred to the
    next engine rewalk (idempotent, retain-only) — see
    [`07-execution-semantics.md`](./07-execution-semantics.md).
    **Timer fire while the instance is frozen (M5-L1, TASK-73):** if the deadline comes due while the
    instance is not in the active-forward lane — i.e. it has been parked into `incident` (a sibling/inner
    technical failure) or `compensating`/`compensationFailed` (an operator `/cancel` of a Hazard) — a
    **scope-host** timer's fire is **recorded, not applied**. It is written to the same `timer_outcomes
    'fired'` decider (with a `timerFired {suppressed:true}` audit) but drives **no** transition, drain, or
    interrupt, so it **never unfreezes** the parked instance. When the operator resolves the incident and
    `/retry`s, the recorded decision fast-forwards the resume walk onto the boundary path and the
    interrupted scope is drained then — the modeled deadline is applied only **after** the freeze clears,
    never violating it. A **task/receiveTask-host** timer on a frozen instance instead **re-arms with a
    short backoff** (no decider claim, no transition), so the alarm re-fires after resume and the normal
    fire — with its full host cleanup (job abandon / subscription supersede) — applies the deadline then.
15. **Timer intermediate catch (M3-L4).** An `intermediateCatchEvent` + `timerEventDefinition` is a delay
    step on the token path, with exactly **one incoming** and **one outgoing** sequence flow (a join into
    it rejects with element id + reason). Allowed at process level **and inside a `transaction`**. Its
    `timerEventDefinition` obeys the **same well-formedness** as a boundary timer (rule 14: exactly one
    static ISO-8601 `timeDate`|`timeDuration`; `timeCycle`/FEEL/non-parsing/zero-or-two reject).
16. **Message intermediate catch (M3-L4).** An `intermediateCatchEvent` + `messageEventDefinition` is a
    correlation **wait** on the token path with **identical** wait/correlation/resume semantics to a
    `receiveTask` (the **same** subscription/correlation/broker machinery; the `<message>` carries only its
    name; the correlation key is supplied via the API at instance start). Exactly **one incoming** and
    **one outgoing** sequence flow (a join into it rejects with element id + reason). Allowed at process
    level **and inside a `transaction`**. It is an **event, not an activity**: an `easy-bpmn:taskDefinition`
    on it rejects (events route no worker), and **no boundary events attach** (a boundary on a catch rejects
    with element id + reason). Its `messageEventDefinition` MUST carry a `messageRef` resolving to a declared
    root `<bpmn:message>` with a non-empty `@name` (a missing/unresolved/empty-name ref rejects).
17. **Event-based gateway (M3-L4).** An `eventBasedGateway` races its branch catches and decides on a single
    `gateway_decisions` row. It needs **≥2 outgoing flows**, every target an `intermediateCatchEvent` (timer
    or message) whose **only** incoming flow is the one from this gateway; **at most one timer branch**;
    message branches reference **distinct** messages (two on one message collapse to a single broker key);
    `instantiate="true"` and `eventGatewayType="Parallel"` reject (each with element id + reason). Like an
    `exclusiveGateway` it carries `next: null` (branch selection owns the successor) and no `default` /
    conditions on its outgoing flows. At runtime the winning event (message correlation or timer fire) claims
    the decision row by a plain INSERT in the same batch as the transition — the loser's batch aborts and
    converts — and the token advances down the winning catch's single outgoing flow.
18. **Error end event (M5-L1).** An `endEvent` + `errorEventDefinition` is accepted at process level or
    inside any scope. Its `errorRef` MUST resolve to a declared root `<bpmn:error>` with a non-empty
    `@errorCode` (the same publish-time resolution rule 11's error boundary uses; an absent or dangling
    `errorRef` rejects with element id + reason — a throw has no catch-all shape, so it cannot be left
    unset). Reaching it consumes the token and throws the error from the scope containing the end event;
    runtime catching follows rule 11's attachment-chain walk.
19. **`MAX_SCOPE_DEPTH` (M5-L1).** Scope nesting depth (a `transaction`/`subProcess` directly inside the
    process is depth 1; each further nesting level adds 1) MUST NOT exceed **`MAX_SCOPE_DEPTH = 8`** —
    depth 8 is accepted, depth 9 rejects with the offending scope's element id + reason. Enforced at
    **publish** (not a runtime incident) because in M5-L1 the scope tree is fully static.

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

**ACCEPT** — a block-structured concurrency region (M4): an AND `parallelGateway` split paired with a
matching `parallelGateway` join, or an OR `inclusiveGateway` split (FEEL conditions + a `default`) paired
with a matching `inclusiveGateway` join — single-entry/single-exit, validated at publish, its split↔join
topology recorded in the graph IR. The multi-token runtime (frontier fan-out, AND/OR join barrier,
branch-local merge, parallel-branch compensation) has shipped (M4-L2…L6).

**ACCEPT** — embedded scopes (M5-L1): a plain `subProcess` nested inside a `transaction` (or vice versa),
sharing the parent's variable space, with an error boundary on the `subProcess` routing to a token-path
node and a timer boundary on the `transaction` routing to a Cancel end (the rollback-modeling pattern) —
see [`02-activities.md`](./02-activities.md) and [`07-execution-semantics.md`](./07-execution-semantics.md).
An **error end event** inside any scope is likewise accepted, its `errorRef` resolving to a declared
`<bpmn:error>`.

**REJECT** — a non-SESE concurrency region (no matching join, a branch escaping past the join, an
uncontrolled merge, a mismatched join type, or two concurrent branches awaiting the same message name),
or a `complexGateway` (not on the roadmap) — each with the offending element id:
> `Concurrent split 'fork' (parallelGateway) has no matching join of the same type — a parallel/inclusive
>  region must be single-entry/single-exit (a balanced split↔join pair).`

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

**REJECT** — a compensation handler with no transaction anywhere on its ancestor chain (M5-L1 ancestry
rule 10):
> `Service task 'refundCard' is isForCompensation but no enclosing scope is a <transaction> — the handler
>  has no trigger (no Cancel can reach it).`

**REJECT** — a scope nested past `MAX_SCOPE_DEPTH = 8` (M5-L1 rule 19):
> `Scope 'InnerTx' exceeds MAX_SCOPE_DEPTH = 8 (nesting depth 9).`

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
- **M3 — time & failure taxonomy: SHIPPED** (constitution v2.2.0; opened per validator layer, now complete) —
  interrupting boundary timers, timer/message intermediate catch, `eventBasedGateway` (the timer/message
  race), free error routing, the job-activation DLQ, error catalog. (The M3 leaf `waitTimeout` durable-wait
  cap was retired under M4 single-wake — un-guarded waits are indefinite per standard BPMN; see the DLQ note
  above.) [`01-events.md`](./01-events.md).
- **M4 — concurrency: SHIPPED** (constitution v2.3.0) — block-structured (SESE) `parallelGateway` (AND) +
  `inclusiveGateway` (OR), the token frontier, AND/OR joins, branch-local variable merge, frontier-empty
  completion, and parallel-branch (straggler-catching) compensation; plus the concurrency caps, R2 overlay
  offload, per-token observability, and the `tokens` inspection array.
  [`07-execution-semantics.md`](./07-execution-semantics.md), [`03-gateways.md`](./03-gateways.md).
- **M5 — composition: ACCEPTED IN FULL (constitution v2.5.0), opening per layer** — non-transaction
  `subProcess`, scope-hosted error/timer boundaries, an error end event, `callActivity`,
  `multiInstanceLoopCharacteristics`, `escalation`, `signal`, and the first non-interrupting
  signal/escalation boundaries. **M5-L1 (embedded scopes + hierarchical exceptions) has SHIPPED** — the
  plain embedded `subProcess`, scope-hosted error/timer boundaries (Hazard-vs-Cancel), the error end event
  (`uncaughtError` incident kind), hierarchical error bubbling, the two-tier commit shield
  (`committedLocal`/`committed`), the root-relative reverse pass, and `MAX_SCOPE_DEPTH = 8` are all
  runtime-open — see
  [Accepted in v2.5.0 (M5)](#accepted-in-v250-m5--composition-opening-per-layer) above; M5-L2
  (`callActivity`) through M5-L5 (`signal`) remain interim-rejected until their own layers open.
  [`02-activities.md`](./02-activities.md), [`07-execution-semantics.md`](./07-execution-semantics.md).

> Any expansion of this profile requires amending the constitution first (Governance & scope). This file
> is updated in lockstep with that amendment **and** with the `src/bpmn/validator.ts` accept/reject
> behavior. When the two legitimately disagree — a construct **accepted** by a constitution amendment whose
> validator runtime ships in a later layer — that gap is **named explicitly** in the
> [Accepted in v2.2.0, opened per validator layer](#explicitly-out-of-scope-must-be-rejected-before-publish)
> section, so a constitution-allowed construct rejected until its layer ships is documented behavior, not
> drift. The full M3 **and M4** sets have shipped. **M5 currently has such a gap by design**: the whole
> composition set is constitution-accepted (v2.5.0) up front, but only the M5-L1 subset is runtime-open —
> M5-L2 through M5-L5 are named, individually, in the
> [Accepted in v2.5.0 (M5)](#accepted-in-v250-m5--composition-opening-per-layer) section above as
> "accepted, runtime not yet open — publish still rejects (interim)", so each remains documented behavior,
> not drift, until its own layer lands.
