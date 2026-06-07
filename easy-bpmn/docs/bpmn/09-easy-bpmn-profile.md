# 09 — The `easy-bpmn` BPMN Profile (MVP)

This is the **contract** between the BPMN standard and what `easy-bpmn` actually executes. It is the
operational reading of [`start.md`](../../start.md) and the
[constitution](../../.specify/memory/constitution.md). When in doubt, the constitution wins.

> **Core principle (constitution I — "Standard BPMN-Lite Profile Only"):** execute *only* standard
> BPMN 2.0 elements from this profile; introduce **no** custom notation or platform-only semantics; and
> **reject unsupported elements before publish with a user-visible reason.**

## The supported happy path

```text
○ Start Event ──→ ⚙ Service Task ──→ ✉ Receive Task ──→ ● End Event
   (none)          (remote worker)     (await message)     (none)
```

Example use case (from `start.md`):

```text
Start → Run External Check → Wait for Approval Event → End
```

## Supported element set (the whitelist)

| BPMN element | XML tag | Constraints in MVP |
|--------------|---------|--------------------|
| **None Start Event** | `startEvent` (no child event definition) | Exactly one; no message/timer/signal/etc. trigger. Instances are started via API. |
| **Service Task** | `serviceTask` | Maps to a remote service worker (RPC-like). Output variables persisted before advancing. |
| **Receive Task** | `receiveTask` (with `messageRef`) | A durable wait state; resumed by a correlated external message. |
| **None End Event** | `endEvent` (no child event definition) | Plain completion. |
| **Sequence Flow** | `sequenceFlow` | Plain only — **no** `conditionExpression`, no `default`. |
| **Message** | `message` (root) | Declares the message a Receive Task waits for; carries name + correlation. |

Supporting machinery (not drawn shapes, but required):
- **Process variables** — initial variables at start; service-task output variables; message payload.
- **Correlation key** — message name + correlation key → exactly one waiting instance.
- **DI** (`bpmndi:*`) — accepted and ignored for execution (optional).

## Explicitly out of scope (must be rejected before publish)

From the constitution's MVP scope section and Out-of-Scope list in `start.md`:

| Category | Rejected elements |
|----------|-------------------|
| Tasks | abstract `task`, `userTask`, `sendTask`, `manualTask`, `scriptTask`, `businessRuleTask` |
| Events | any start/intermediate/boundary/end event **with** an event definition (message/timer/error/escalation/signal/conditional/link/compensation/cancel start & end), all `intermediateCatchEvent`/`intermediateThrowEvent`, all `boundaryEvent`, terminate end |
| Gateways | `exclusiveGateway`, `parallelGateway`, `inclusiveGateway`, `eventBasedGateway`, `complexGateway` |
| Flow | conditional sequence flow, default flow, `messageFlow`, `association` |
| Structure | `subProcess`, `transaction`, `adHocSubProcess`, `callActivity`, `collaboration`, `participant` (pools), `laneSet`/`lane`, `choreography` |
| Loops/data | `multiInstanceLoopCharacteristics`, `standardLoopCharacteristics`, compensation, `dataObject`/`dataStore`/`dataInput`/`dataOutput` |
| Platform | built-in tasklist, forms/assignment, process migration, full Zeebe/Camunda compatibility, visual modeler, advanced Operate-style UI |

> **No silent skips.** Encountering any of the above is a *validation failure with a reason*, not a
> "best effort, ignore the bits we don't understand." Silent skipping would violate Principle I and
> break the product promise ("we don't pretend to support the full ecosystem").

## Validation rules (publish-time gate)

A BPMN document is accepted for publish only if **all** hold:

1. **Parses** as namespace-aware BPMN 2.0 XML (use `bpmn-moddle`; see [`08`](./08-engines-and-extensions.md)).
2. **Single executable process.** Exactly one `<process isExecutable="true">`; no `<collaboration>`,
   pools, lanes, or choreography.
3. **Whitelist only.** Every flow node is one of: none start event, service task, receive task, none end
   event. Any other tag ⇒ reject with the offending element id + a reason.
4. **None events only.** Start/end events carry **no** child `*EventDefinition`.
5. **Plain sequence flows.** No `conditionExpression`; no `default` attribute; flows connect supported
   nodes only.
6. **Structural sanity.** Exactly one none start event; ≥1 none end event; the graph is connected;
   every node reachable from start; every `*Ref` resolves; no dangling flows.
7. **Receive task is well-formed.** Has a `messageRef` to a declared `<message>`, and the message
   defines (or the start call supplies) a correlation key strategy.
8. **No engine lock-in required.** `camunda:`/`zeebe:` extension attributes may be present but MUST NOT
   be *required* for execution; the worker binding is `easy-bpmn`'s own (TBD — see open questions).

Every rejection MUST state **what** was wrong, **which BPMN element** (by id/name), and **what the user
can do** (constitution, Principle V — operator clarity).

## Runtime mapping (how the profile executes)

| BPMN construct | `easy-bpmn` runtime behavior |
|----------------|------------------------------|
| Publish definition | Create an **immutable**, versioned process definition (constitution II). |
| Start instance | Create instance bound to one definition version; seed initial variables; place token at start; **audit**. |
| None start → flow | Token advances to the first node. |
| **Service Task** | Invoke remote worker over the RPC-like contract; on result, **persist output variables, then advance** (constitution III). Idempotent across retries/duplicate callbacks. |
| **Receive Task** | Durable **wait state**: persist & park. On external message, **correlate by `messageName` + `correlationKey` to exactly one** instance; atomically apply payload + advance (constitution IV). |
| None end | Consume token; instance completes; **audit**. |
| Any transition | Recorded in **audit history**; replay-safe & idempotent (constitution III & V). |

Cloudflare mapping: one **Durable Object per instance** gives single-threaded, transactional state —
ideal for "persist-before-advance" and exactly-once message application. (See
[`07-execution-semantics.md`](./07-execution-semantics.md).)

## Accept / reject examples

**ACCEPT** — the canonical happy path (full XML in [`06-xml-serialization.md`](./06-xml-serialization.md)):
```text
startEvent(none) → serviceTask → receiveTask(messageRef) → endEvent(none)
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

## Open questions / future-facing notes

These are *not* decided here — flagged so the reference doesn't imply more than the constitution says:

- **Service-task → worker binding.** How does a `serviceTask` name a worker/topic? Options: by task
  `name`/`id` convention, or an `easy-bpmn:` moddle extension. (Avoid *requiring* `camunda:`/`zeebe:`
  attrs — keep files standard.)
- **Correlation key source.** On the `<message>` (Zeebe-style `subscription`), supplied at send time,
  or derived from a variable expression? Constitution requires the *outcome* (exactly-one match), not
  the mechanism.
- **First extension after MVP.** Most likely the **exclusive gateway + conditional flow** (decisions),
  then **timers / boundary events**. Each requires a constitution amendment (the MVP scope list is
  governance, not a suggestion). [`03-gateways.md`](./03-gateways.md) and [`01-events.md`](./01-events.md)
  already document the target semantics.

> Any expansion of this profile requires amending the constitution first (constitution, Governance &
> MVP scope). This file should be updated in lockstep with that amendment.
