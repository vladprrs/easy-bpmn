# 01 — Events

An **event** is something that *happens* during a process. Drawn as a **circle**; the border tells
you the position, and the inner icon tells you the **trigger**.

```text
○   thin single border      → Start event
◎   thin double border      → Intermediate event
●   thick single border     → End event
⌀   dashed border           → Non-interrupting (start-of-event-subprocess or boundary)
```

Two orthogonal questions define every event:

1. **Position** — where in the lifecycle: *Start*, *Intermediate (catch or throw)*, *End*, or
   *Boundary* (attached to an activity).
2. **Trigger (event definition)** — *what* it reacts to or emits: none, message, timer, error,
   escalation, cancel, compensation, conditional, link, signal, or a combination (multiple / parallel
   multiple) / terminate.

> In XML, the position is the element name (`startEvent`, `intermediateCatchEvent`,
> `intermediateThrowEvent`, `endEvent`, `boundaryEvent`) and the trigger is a child
> `*EventDefinition` element. A bare event with no child definition is a **none** event. See
> [`06-xml-serialization.md`](./06-xml-serialization.md).

## Catching vs throwing

- **Catching** event — *waits* for the trigger (a message arrives, a timer elapses, a signal is
  broadcast). All start and boundary events are catching. Intermediate events can be either.
- **Throwing** event — *emits* the trigger (throw a signal, throw an escalation). End events and some
  intermediate events are throwing.

Visually: a **catch** has an *unfilled (outline)* icon; a **throw** has a *filled (solid)* icon.

## Interrupting vs non-interrupting

Applies to **boundary events** and **event sub-process start events**:

- **Interrupting** (solid border): cancels the activity/scope it is attached to, then continues down
  the event's outgoing path.
- **Non-interrupting** (dashed border): leaves the activity running and spawns an *additional*
  parallel token. New in BPMN 2.0.

In XML this is the `cancelActivity` attribute on `boundaryEvent` (`true` = interrupting, the default;
`false` = non-interrupting) and `isInterrupting` on an event sub-process `startEvent`.

## The event taxonomy matrix

Which trigger is valid in which position. ✓ = allowed; blank = not allowed.
(EvSub = event sub-process start event.)

| Trigger | Start | EvSub interrupt | EvSub non-int | Intermediate Catch | Intermediate Throw | Boundary interrupt | Boundary non-int | End |
|---------|:-----:|:---------------:|:-------------:|:------------------:|:------------------:|:------------------:|:----------------:|:---:|
| **None** | ✓ | | | | ✓ | | | ✓ |
| **Message** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Timer** | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | |
| **Conditional** | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | |
| **Signal** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Error** | | ✓ | | | | ✓ | | ✓ |
| **Escalation** | | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ |
| **Cancel** | | | | | | ✓¹ | | ✓¹ |
| **Compensation** | | ✓ | | | ✓ | ✓² | | ✓ |
| **Link** | | | | ✓ | ✓ | | | |
| **Multiple** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Parallel Multiple** | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | |
| **Terminate** | | | | | | | | ✓ |

¹ **Cancel** is only valid on a **transaction** sub-process: a cancel *boundary* event reacts to a
cancel *end* event thrown inside the transaction. See [`02-activities.md`](./02-activities.md).
² A **compensation boundary** event is a special case — it does not "interrupt"; it declares which
activity is the compensation handler. It is attached after the activity completes.

> Notes:
> - **Error** is *always* interrupting. There is no non-interrupting error event.
> - **None intermediate** events are pass-through markers (often used to denote a state/milestone).
> - **Link** events are "go-to" connectors: a throw-link and a matching catch-link (same `name`) let
>   you stitch a diagram together without drawing a long sequence flow.

## Trigger reference

| Trigger | Icon | Meaning |
|---------|------|---------|
| **None** | (empty) | Unspecified — plain start/end, or a milestone marker. |
| **Message** | envelope | A named message sent/received between participants (one-to-one). The basis of `easy-bpmn`'s receive task. |
| **Timer** | clock | Fires at a date, after a duration, or on a cycle. ISO-8601 (`timeDate` / `timeDuration` / `timeCycle`). |
| **Conditional** | lined page | Fires when a boolean condition over process data becomes true. |
| **Signal** | triangle | A broadcast (one-to-many). Every matching catch reacts. Not addressed to one instance. |
| **Error** | lightning (jagged) | A thrown business/technical error caught by an error boundary or error event sub-process. Always interrupting. |
| **Escalation** | arrowhead (up) | A non-fatal "raise this up" notification; can be non-interrupting. |
| **Cancel** | X | Transaction-only: triggers rollback/compensation of a transaction sub-process. |
| **Compensation** | rewind | Triggers compensation handlers to undo completed work. |
| **Link** | arrow (off-page) | Paired throw/catch "go-to" within one process. |
| **Multiple** | pentagon | Any one of several triggers (OR). |
| **Parallel Multiple** | plus (+) | All of several triggers required (AND). |
| **Terminate** | filled circle | End event that immediately ends the *entire* process instance, killing all remaining tokens. |

## Position reference

### Start events
Create a token and instantiate the process.
- **None start**: started explicitly (e.g. via API "start instance"). *This is what `easy-bpmn` uses.*
- **Message / Timer / Signal / Conditional start**: the engine instantiates the process when the
  trigger occurs. (Out of scope for the MVP — instances are started via API.)

### Intermediate events
Sit on the sequence flow between start and end.
- **Catch** (e.g. message catch, timer catch): the token **waits** here — a *wait state*.
- **Throw** (e.g. signal throw): emits and immediately continues.

### Boundary events
Attached to an activity's border (`attachedToRef`). React while the activity runs.
- Interrupting: cancel the activity, take the boundary's outgoing flow (e.g. timeout, error handling).
- Non-interrupting: fire a side path, activity keeps running (e.g. "send reminder after 1 day").

### End events
Consume the token. When the last token is consumed, the instance ends.
- **None end**: ordinary completion. *This is what `easy-bpmn` uses.*
- **Terminate end**: hard stop — discards *all* remaining tokens in the instance immediately.
- **Error/Escalation/Signal/Message/Compensation end**: emit the corresponding trigger as they end the path.

---

## `easy-bpmn` scope

**In scope:** **None Start Event** and **None End Event** only.

Everything else in this file — message/timer/signal/error/escalation/conditional start & end events,
**all** intermediate events, **all** boundary events, and terminate — is **out of scope** for the MVP
and MUST be rejected before publish with a user-visible reason (constitution, Principles I & the MVP
scope section). The MVP starts instances via API (a none start) and ends them via a none end.

The one message-shaped behavior we *do* support is the **Receive Task** wait + message correlation —
but that is modeled as a *task*, not an intermediate message catch event. See
[`02-activities.md`](./02-activities.md) and [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).
