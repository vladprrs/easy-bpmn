# 00 — Overview & Core Concepts

## What BPMN is

**BPMN 2.0** (Business Process Model and Notation) is an OMG standard that defines:

1. A **graphical notation** — the shapes you draw (events, tasks, gateways, flows).
2. A **metamodel** — the abstract objects and their relationships.
3. An **XML serialization** — how a diagram is stored and exchanged (`.bpmn` files; see
   [`06-xml-serialization.md`](./06-xml-serialization.md)).
4. **Execution semantics** — token-based rules for how a process *runs*
   ([`07-execution-semantics.md`](./07-execution-semantics.md)).

The fourth point is what makes BPMN more than flowcharting: a sufficiently constrained BPMN model is
**directly executable** by an engine. That is exactly the bet `easy-bpmn` makes.

## The two artifacts: definition vs instance

| Term | Meaning |
|------|---------|
| **Process definition** | The model itself — the `<process>` parsed from the BPMN XML. Static, versioned. In `easy-bpmn`, **immutable once published** (constitution, Principle II). |
| **Process instance** | One running execution of a definition. Has its own variables, current position(s), and history. Bound to exactly one definition version for life. |
| **Token** | The execution-semantics abstraction for "where control is right now." An instance has one or more tokens moving along sequence flows. See [`07`](./07-execution-semantics.md). |

## The five element categories

Every BPMN shape belongs to one of these groups.

### 1. Flow Objects (the "verbs/nouns" of the process)

| Object | Shape | Reference |
|--------|-------|-----------|
| **Event** | Circle | [`01-events.md`](./01-events.md) |
| **Activity** | Rounded rectangle | [`02-activities.md`](./02-activities.md) |
| **Gateway** | Diamond | [`03-gateways.md`](./03-gateways.md) |

### 2. Connecting Objects

| Object | Shape | Reference |
|--------|-------|-----------|
| **Sequence Flow** | Solid arrow, filled head | [`04-flows-and-data.md`](./04-flows-and-data.md) |
| **Message Flow** | Dashed arrow, open head | [`04`](./04-flows-and-data.md) / [`05`](./05-swimlanes-collaboration.md) |
| **Association** | Dotted line | [`04`](./04-flows-and-data.md) |

### 3. Swimlanes (organization)

| Object | Shape | Reference |
|--------|-------|-----------|
| **Pool** | Big rectangle (a participant) | [`05-swimlanes-collaboration.md`](./05-swimlanes-collaboration.md) |
| **Lane** | Subdivision of a pool | [`05`](./05-swimlanes-collaboration.md) |

### 4. Data

| Object | Shape | Reference |
|--------|-------|-----------|
| **Data Object** | Dog-eared page | [`04-flows-and-data.md`](./04-flows-and-data.md) |
| **Data Store** | Cylinder | [`04`](./04-flows-and-data.md) |
| **Data Input / Output** | Page with arrow | [`04`](./04-flows-and-data.md) |

### 5. Artifacts (documentation only — no execution semantics)

| Object | Shape |
|--------|-------|
| **Text Annotation** | Open bracket with text |
| **Group** | Dashed rounded rectangle |

## Diagram types

BPMN 2.0 defines three diagram kinds. The first is what 95% of people mean by "a BPMN diagram."

- **Process diagram** — orchestration of one participant's work. *This is `easy-bpmn`'s world.*
- **Collaboration diagram** — two or more pools exchanging **message flows**. See [`05`](./05-swimlanes-collaboration.md).
- **Choreography diagram** — message exchange between participants with no central controller (rare).
  Briefly covered in [`05`](./05-swimlanes-collaboration.md).

## Conformance / modeling levels

Not every tool implements all of BPMN. The spec and the community recognize tiers — useful for
understanding why some elements are "draw-only" and others are "executable."

| Level | What it covers | Notes |
|-------|----------------|-------|
| **Descriptive** | Pools, lanes, tasks, sub-processes, none/message/timer start & end events, sequence/message flow, gateways, data objects | The "Bruce Silver Level 1" subset — for humans |
| **Analytic** | Adds the full event taxonomy, all gateways, markers | "Level 2" — still mostly for analysis |
| **Common Executable** | The subset the spec marks as runnable by engines | Closest to what `easy-bpmn` cares about |
| **Full** | Everything, including choreography | Few tools implement all of it |

> **Takeaway for us:** BPMN is *big*. `easy-bpmn` implements a sliver well below even "Common
> Executable." The whole product thesis is that a *small, correct, durable* subset is more valuable
> than a partial implementation of everything. See [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).

## How to read a process (token mental model)

1. A **start event** creates a **token**.
2. The token follows **sequence flows** from element to element.
3. At an **activity**, the token waits until the work completes.
4. At a **gateway**, tokens are split, merged, or routed.
5. An **end event** consumes a token. When no tokens remain, the **instance** completes.

That single mental model — "tokens flowing and being consumed" — explains almost all of BPMN's
runtime behavior. Everything in [`07-execution-semantics.md`](./07-execution-semantics.md) is a
refinement of it.
