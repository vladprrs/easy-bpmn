# 09 — The `easy-bpmn` BPMN Profile (MVP)

This is the **contract** between the BPMN standard and what `easy-bpmn` actually executes. It is the
operational reading of the [constitution](../../.specify/memory/constitution.md). When in doubt, the
constitution wins.

> **Core principle (constitution I — "Standard BPMN-Lite Profile Only"):** execute *only* standard
> BPMN 2.0 elements from this profile; introduce **no** custom notation or platform-only semantics; and
> **reject unsupported elements before publish with a user-visible reason.**

## What "no custom notation" means (precisely)

The constraint is testable, not vibes. `easy-bpmn` MUST NOT:

1. introduce **new element or shape types** in the BPMN `MODEL` namespace;
2. **redefine the runtime meaning** of a standard element; or
3. **require a non-standard attribute** on a standard element for a file to *parse*.

What **is** allowed (and is *not* "custom notation"): carrying binding metadata in the standard
`<bpmn:extensionElements>` escape hatch under a dedicated `easy-bpmn` namespace. `extensionElements` is
part of BPMN 2.0 precisely so engines can attach implementation details; every engine (Camunda, Zeebe,
Flowable) does this. Using it additively is standard, not an invention.

**The operative test.** Every accepted file MUST stay valid against the BPMN 2.0 XSD and **round-trip
through a standard modeler** (bpmn-js / Camunda Modeler) unchanged even when `easy-bpmn` extensions and
Diagram Interchange are ignored. If a modeler can open, render, and re-save the file without losing the
diagram, we did not invent a notation. (Binding decisions recorded in
[`research.md`](../../specs/001-bpmn-lite-orchestrator-mvp/research.md).)

> This section is the *operational reading* of Principle I. If the team wants this precise wording
> (extension mechanism permitted; routing by a stable task type) codified as governance, amend the
> constitution in lockstep — see the closing note.

## The supported happy path

```text
○ Start Event ──→ ⚙ Service Task ──→ ✉ Receive Task ──→ ● End Event
   (none)          (remote worker)     (await message)     (none)
```

Example use case:

```text
Start → Run External Check → Wait for Approval Event → End
```

## Supported element set (the whitelist)

| BPMN element | XML tag | Constraints in MVP |
|--------------|---------|--------------------|
| **None Start Event** | `startEvent` (no child event definition) | Exactly one; no message/timer/signal/etc. trigger. Instances are started via API. |
| **Service Task** | `serviceTask` | Maps to a remote worker. Bound by a stable **`taskType`** in `<extensionElements>` under the `easy-bpmn` namespace — **not** by element `id`/`name`. Output variables persisted before advancing. |
| **Receive Task** | `receiveTask` (with `messageRef`) | A durable wait state; resumed by a correlated external message. `instantiate="true"` is **rejected** (instances start via API). |
| **None End Event** | `endEvent` (no child event definition) | Plain completion. |
| **Sequence Flow** | `sequenceFlow` | Plain only — **no** `conditionExpression`, no `default`. |
| **Message** | `message` (root) | Declares the message **name** a Receive Task waits for. Carries **only the name**; the correlation key is supplied via the **API** at start (MVP), not derived from the model. |

Supporting machinery (not drawn shapes, but required):
- **Process variables** — initial variables at start; service-task output variables; message payload.
- **Correlation key** — message name + correlation key → exactly one waiting instance. In the MVP the
  key is **supplied via the API** at instance start and on publish; it is *not* read from a model-level
  subscription expression. Model-level correlation (an `easy-bpmn:subscription`/FEEL key over variables)
  is a deliberate **future** option, not MVP behavior.
- **`easy-bpmn` extension binding** — `serviceTask` worker `taskType` and retry policy live in
  `<bpmn:extensionElements>` under the `easy-bpmn` namespace (see below). Additive and ignorable.
- **DI** (`bpmndi:*`) — accepted and ignored for execution; **preserved** on the stored snapshot so the
  file round-trips.

### The `easy-bpmn` extension (the only binding we add)

```xml
<bpmn:serviceTask id="Task_check" name="Run external check">
  <bpmn:extensionElements>
    <easy-bpmn:taskDefinition type="external-check" retries="3" />
  </bpmn:extensionElements>
</bpmn:serviceTask>
```

with `xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"` declared on `<definitions>`. Notes:
- `type` is the **stable worker routing key** (the "topic"). Workers are dispatched by `type`; the
  element `id` is audit-only (modelers regenerate ids when a task is re-drawn).
- `retries` is the per-task retry limit (constitution III).
- This mirrors the Zeebe/Camunda external-task pattern but under **our own** namespace — we do **not**
  require or honor `camunda:`/`zeebe:` semantics (FEEL, ioMapping). Reusing their vocabulary verbatim was
  rejected because it would imply a compatibility the constitution excludes. See
  [`08-engines-and-extensions.md`](./08-engines-and-extensions.md) and
  [`research.md`](../../specs/001-bpmn-lite-orchestrator-mvp/research.md).
- A file with these extensions still opens / renders / round-trips in any standard modeler that ignores
  the `easy-bpmn` namespace — that is the operative test above.

## Explicitly out of scope (must be rejected before publish)

From the constitution's MVP scope section:

| Category | Rejected elements |
|----------|-------------------|
| Tasks | abstract `task`, `userTask`, `sendTask`, `manualTask`, `scriptTask`, `businessRuleTask` |
| Events | any start/intermediate/boundary/end event **with** an event definition (message/timer/error/escalation/signal/conditional/link/compensation/cancel start & end), all `intermediateCatchEvent`/`intermediateThrowEvent`, all `boundaryEvent`, terminate end |
| Gateways | `exclusiveGateway`, `parallelGateway`, `inclusiveGateway`, `eventBasedGateway`, `complexGateway` |
| Flow | conditional sequence flow, default flow, `messageFlow`, `association` |
| Structure | `subProcess`, `transaction`, `adHocSubProcess`, `callActivity`, `collaboration`, `participant` (pools), `laneSet`/`lane`, `choreography` |
| Loops/data | `multiInstanceLoopCharacteristics`, `standardLoopCharacteristics`, compensation, `dataObject`/`dataStore`/`dataInput`/`dataOutput` |
| Model instantiation | `receiveTask instantiate="true"` (or any non-none instantiation path) — instances start via the API only |
| Platform | built-in tasklist, forms/assignment, process migration, full Zeebe/Camunda compatibility, visual modeler, advanced Operate-style UI |

> **No silent skips — for *flow elements*.** Encountering any unsupported **standard-namespace flow node
> or structure** above is a *validation failure with a reason*, not "best effort, ignore the bits we
> don't understand." That is the Principle-I guarantee. It does **not** apply to *ignorable extension
> content*: foreign-namespace `<extensionElements>` (`camunda:`/`zeebe:`/…), DI, and `documentation` are
> **tolerated and ignored**, because BPMN 2.0 requires conformant tools to ignore unknown extensions.
> Rejecting a file merely for carrying such a block would itself be non-canonical.

## Validation rules (publish-time gate)

A BPMN document is accepted for publish only if **all** hold:

1. **Parses** as namespace-aware BPMN 2.0 XML — matched by `{MODEL-ns}localName`, never by prefix (use
   `bpmn-moddle`; see [`06`](./06-xml-serialization.md) and [`08`](./08-engines-and-extensions.md)).
2. **Single executable process.** Exactly one `<process isExecutable="true">`; no `<collaboration>`,
   pools, lanes, or choreography.
3. **Whitelist only (flow nodes).** Every flow node is one of: none start event, service task, receive
   task, none end event. Any other standard-namespace flow node/structure ⇒ reject with the offending
   element id + a reason.
4. **None events only.** Start/end events carry **no** child `*EventDefinition`.
5. **Plain sequence flows.** No `conditionExpression`; no `default` attribute; flows connect supported
   nodes only.
6. **Structural sanity.** Exactly one none start event; ≥1 none end event; the graph is connected;
   every node reachable from start; every `*Ref` resolves; no dangling flows.
7. **No model-based instantiation.** No `receiveTask instantiate="true"` (or any non-none instantiation
   path); instances start only via the API.
8. **Service task is bound.** Each `serviceTask` declares an `easy-bpmn:taskDefinition` with a non-empty
   `type` in `<extensionElements>`. Routing by `id`/`name` is not allowed.
9. **Receive task is well-formed.** Has a `messageRef` resolving to a declared `<message>`. The
   correlation key is supplied via the API at start (MVP) — the model is **not** required to declare it.
10. **Extensions tolerated, not required.** Foreign-namespace `<extensionElements>` (`camunda:`,
    `zeebe:`, …), DI, and `documentation` are accepted and ignored; `camunda:`/`zeebe:` attributes MUST
    NOT be *required* for execution. The only binding `easy-bpmn` reads is its own `easy-bpmn:*`.

Every rejection MUST state **what** was wrong, **which BPMN element** (by id/name), and **what the user
can do** (constitution, Principle V — operator clarity).

## Runtime mapping (how the profile executes)

| BPMN construct | `easy-bpmn` runtime behavior |
|----------------|------------------------------|
| Publish definition | Create an **immutable**, versioned process definition (constitution II). |
| Start instance | Create instance bound to one definition version; seed initial variables; place token at start; **audit**. |
| None start → flow | Token advances to the first node. |
| **Service Task** | Invoke remote worker over the RPC-like contract, **routed by `easy-bpmn:taskDefinition` `type`** (not element id/name); on result, **persist output variables, then advance** (constitution III). Idempotent across retries/duplicate callbacks. |
| **Receive Task** | Durable **wait state**: persist & park. On external message, **correlate by `messageName` + `correlationKey` to exactly one** instance; atomically apply payload + advance (constitution IV). |
| None end | Consume token; instance completes; **audit**. |
| Any transition | Recorded in **audit history**; replay-safe & idempotent (constitution III & V). |

Cloudflare mapping: one **Durable Object per instance** gives single-threaded, transactional state —
ideal for "persist-before-advance" and exactly-once message application. (See
[`07-execution-semantics.md`](./07-execution-semantics.md).)

## Accept / reject examples

**ACCEPT** — the canonical happy path (full XML, including the `easy-bpmn:taskDefinition`, in
[`06-xml-serialization.md`](./06-xml-serialization.md)):
```text
startEvent(none) → serviceTask[easy-bpmn:taskDefinition type=…] → receiveTask(messageRef) → endEvent(none)
```

**REJECT** — contains an exclusive gateway:
> `Validation failed: element 'Gateway_1' (exclusiveGateway) is not supported in this profile.
>  Supported nodes: start event, service task, receive task, end event.`

**REJECT** — a timer start event:
> `Validation failed: start event 'Start_1' has a timerEventDefinition. Only none start events are
>  supported; start instances via the API instead.`

**REJECT** — a user task:
> `Validation failed: element 'Task_Approve' (userTask) is not supported. Human steps must happen in an
>  external system and report back via a message to a receive task.`

**REJECT** — an instantiating receive task:
> `Validation failed: receive task 'Task_wait' has instantiate="true". The MVP starts instances via the
>  API only; remove instantiate.`

**REJECT** — a service task with no worker binding:
> `Validation failed: service task 'Task_check' has no easy-bpmn:taskDefinition type. Declare a worker
>  type in <extensionElements>; routing by id/name is not supported.`

## Resolved decisions & remaining open questions

**Resolved** (recorded in [`research.md`](../../specs/001-bpmn-lite-orchestrator-mvp/research.md)):
- **Service-task → worker binding.** An `easy-bpmn:taskDefinition type="…"` in `<extensionElements>`,
  routed by `type`. Reusing `camunda:`/`zeebe:` vocabulary verbatim was rejected (implies excluded
  compatibility); overloading `name`/`id` was rejected (hidden platform-only semantics).
- **Correlation key source (MVP).** Supplied via the API at start; the `<message>` carries only its
  name. Model-level correlation is deferred.
- **Parser.** `bpmn-moddle` (namespace-aware); `fast-xml-parser` was rejected.

**Still open / future-facing:**
- **Model-level correlation.** Whether/when to add an `easy-bpmn:subscription` key (FEEL over variables)
  so the key lives in the model rather than the API.
- **First extension after MVP.** Most likely the **exclusive gateway + conditional flow** (decisions),
  then **timers / boundary events**. Each requires a constitution amendment (the MVP scope list is
  governance, not a suggestion). [`03-gateways.md`](./03-gateways.md) and [`01-events.md`](./01-events.md)
  already document the target semantics.

> Any expansion of this profile — or codifying the "no custom notation" wording above and the
> `easy-bpmn:` binding as governance — requires amending the constitution first (Governance & MVP
> scope). This file should be updated in lockstep with that amendment.
