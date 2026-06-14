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
- In `easy-bpmn`, sequence-flow `sourceRef`/`targetRef` and compensation-`association`
  `sourceRef`/`targetRef` are **retained** at publish — persisted both in the parsed-profile graph
  (`GraphNode.outgoing: Flow[]`, with `next` derived as `outgoing[0].targetId`) and as queryable
  `bpmn_elements.source_ref`/`target_ref` rows (migration `0003_topology.sql`). The pre-saga MVP
  dropped these refs; topology is now queryable and replay-deterministic.

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
> the most common BPMN decision pattern. (Both are in scope since M2 when the flow leaves an
> `exclusiveGateway` — and since M4 an `inclusiveGateway`; anywhere else they are rejected — see the
> easy-bpmn scope section below.)

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
- **Sequence Flow** (`sequenceFlow`) — plain by default; **since M2** a flow leaving an
  `exclusiveGateway`, and **since M4** a flow leaving an `inclusiveGateway`, may carry a FEEL
  `conditionExpression`, or be that gateway's `default` flow. Conditions anywhere else are still rejected
  — see [`03-gateways.md`](./03-gateways.md).
- **Association** (`association`) — **since M1**, exclusively as compensation wiring: from a
  compensation boundary event to its `isForCompensation` handler. Free-floating associations to
  artifacts remain ignorable annotation, not flow.
- **Message** (`<message>`) — declares the message **name** a Receive Task waits for. The
  **correlation key** is supplied via the **API** at instance start in the MVP (constitution,
  Principle IV), *not* derived from a model-level subscription expression; model-level correlation is
  deferred. See [`09`](./09-easy-bpmn-profile.md).
- **Process variables** — initial variables at start; output variables persisted from service-task
  workers; payload applied on message correlation.

**Out of scope (reject before publish):** conditional or default flow **not leaving an
`exclusiveGateway` or `inclusiveGateway`** (including the "conditional sequence flow from a task" pattern
and any implicit split), **message flow** (no multi-pool collaboration), and **all** data shapes (`dataObject`,
`dataStore`, `dataInput`/`dataOutput`, data associations). Signals and escalations are out of scope
too. (Errors are **in since M1** — `bpmn:error` + error boundary events drive the saga failure
path; see [`01-events.md`](./01-events.md) and [`09`](./09-easy-bpmn-profile.md).)

So the connector vocabulary is `sequenceFlow` (conditional/default only off an XOR gateway, since
M2), the compensation `association` (since M1), and a `<message>` used purely for Receive Task
correlation. See [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).
