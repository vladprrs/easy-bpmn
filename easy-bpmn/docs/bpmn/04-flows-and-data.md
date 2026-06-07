# 04 — Connecting Objects & Data

## Connecting objects

| Connector | Line style | XML | Connects | Purpose |
|-----------|-----------|-----|----------|---------|
| **Sequence Flow** | solid line, filled arrowhead | `sequenceFlow` | flow nodes **within one** process/pool | Defines execution order — the path a token follows. |
| **Conditional Sequence Flow** | solid line with a small **diamond** at the source | `sequenceFlow` + `conditionExpression` | as above | A sequence flow taken only if its condition is true. |
| **Default Flow** | solid line with a **slash** `╱` near the source | `sequenceFlow` referenced by a node's `default` attr | as above | The fallback path when no conditional flow matches. |
| **Message Flow** | dashed line, open (hollow) arrowhead, open circle at source | `messageFlow` | **across** pools (different participants) | Represents a message sent between participants. |
| **Association** | dotted line | `association` | artifacts/data ↔ flow nodes | Links text annotations, data, or compensation handlers. No execution effect (except compensation associations). |

### Sequence flow — the backbone
- Lives inside a single `<process>`.
- Has `sourceRef` and `targetRef` (the connected nodes' ids).
- Each flow node also lists its connections via child `<incoming>` / `<outgoing>` elements (the flow
  ids). Both representations appear in the XML; keep them consistent. See
  [`06-xml-serialization.md`](./06-xml-serialization.md).

### Conditional & default flow
A `conditionExpression` guards a flow:

```xml
<bpmn:sequenceFlow id="Flow_hi" sourceRef="Gateway_1" targetRef="Task_Review">
  <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${amount &gt; 1000}</bpmn:conditionExpression>
</bpmn:sequenceFlow>
```
The owning gateway/activity may declare one outgoing flow as the default:
```xml
<bpmn:exclusiveGateway id="Gateway_1" default="Flow_default" />
```
> Conditional/default flows are how you do data routing. Combined with an exclusive gateway they form
> the most common BPMN decision pattern. (Both are out of `easy-bpmn`'s MVP scope.)

### Message flow vs sequence flow — the cardinal rule
- **Sequence flow** never crosses a pool boundary.
- **Message flow** *only* crosses pool boundaries (between participants); it never orders nodes inside
  one pool.

Mixing these up is the single most common BPMN modeling error.

## Data elements

BPMN data elements are mostly **descriptive** — they document what data flows where. Execution engines
typically drive real state through **process variables** (a key/value map on the instance), and treat
data objects as documentation or as typed I/O contracts.

| Element | Symbol | XML | Meaning |
|---------|--------|-----|---------|
| **Data Object** | dog-eared page | `dataObject` + `dataObjectReference` | Information created/used within the process; lifecycle = the instance. |
| **Data Object (collection)** | page with `\|\|\|` | `dataObject isCollection="true"` | A list of items (often drives multi-instance). |
| **Data Input** | page with hollow arrow | `dataInput` (in an `ioSpecification`) | Required input to a process/activity. |
| **Data Output** | page with solid arrow | `dataOutput` | Output produced by a process/activity. |
| **Data Store** | cylinder (database) | `dataStore` + `dataStoreReference` | Persistent data that **outlives** the instance (a DB/file). |
| **Data Association** | dotted arrow | `dataInputAssociation` / `dataOutputAssociation` | Wires data into/out of an activity. |
| **Property** | (no shape) | `property` | An unvisualized data holder on a process/activity. |

### Process variables (the executable reality)
Most engines (and `easy-bpmn`) carry state as **variables** on the instance:
- Set at start (initial variables).
- Read/written by service-task workers (output variables are merged back).
- Carried by messages (a message payload updates variables on correlation).

This variable map — not data objects — is what the runtime actually persists and audits.

## Messages, signals, errors, escalations (root definitions)

These are *referenced* by events/tasks but *declared* as top-level elements under `<definitions>`:

| Definition | XML root element | Referenced by | Semantics |
|-----------|------------------|---------------|-----------|
| **Message** | `<message id name>` | message events, send/receive tasks (`messageRef`) | One-to-one, addressed (correlates to a specific instance). |
| **Signal** | `<signal id name>` | signal events (`signalRef`) | One-to-many **broadcast**; every matching catcher reacts. |
| **Error** | `<error id name errorCode>` | error events (`errorRef`) | A thrown fault caught by an error boundary/event sub-process. |
| **Escalation** | `<escalation id name escalationCode>` | escalation events (`escalationRef`) | A non-fatal "raise up"; may be non-interrupting. |

**Message vs Signal** is a frequent exam/interview point:

| | Message | Signal |
|--|---------|--------|
| Recipients | exactly one (correlated) | all listeners (broadcast) |
| Addressing | by correlation key | none |
| Flow | message flow (across pools) | no flow line (ambient) |
| `easy-bpmn` | ✅ used by Receive Task | ✗ out of scope |

---

## `easy-bpmn` scope

**In scope:**
- **Sequence Flow** (`sequenceFlow`) — plain, no conditions.
- **Message** (`<message>`) + a **correlation key** — to drive the Receive Task
  (constitution, Principle IV).
- **Process variables** — initial variables at start; output variables persisted from service-task
  workers; payload applied on message correlation.

**Out of scope (reject before publish):** conditional flow, default flow, **message flow** (no
multi-pool collaboration in the MVP), associations, and **all** data shapes (`dataObject`,
`dataStore`, `dataInput`/`dataOutput`, data associations). Signals, errors, and escalations are out of
scope too.

So the MVP's connector vocabulary is a single plain `sequenceFlow`, plus a `<message>` used purely for
Receive Task correlation. See [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).
