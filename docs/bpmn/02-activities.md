# 02 — Activities (Tasks, Sub-processes, Markers)

An **activity** is a unit of work. Two kinds:

- **Task** — *atomic*: a single step the engine doesn't look inside.
- **Sub-process** — *compound*: contains its own flow nodes.

Both are drawn as **rounded rectangles**. Icons (top-left) indicate the task type; **markers**
(bottom-center) indicate loop / multi-instance / compensation / sub-process.

## Task types

The icon in the top-left corner distinguishes them. XML element names in the third column.

| Task | Icon | XML element | Executed by | In `easy-bpmn`? |
|------|------|-------------|-------------|:---------------:|
| **Abstract / Undefined** | (none) | `task` | unspecified | ✗ |
| **Service Task** | gear ⚙ | `serviceTask` | software (a remote worker / connector) | ✅ **yes** |
| **Send Task** | filled envelope | `sendTask` | sends a message | ✗ |
| **Receive Task** | open envelope | `receiveTask` | waits for a message | ✅ **yes** |
| **User Task** | person | `userTask` | a human via a tasklist UI | ✗ (humans act in *external* systems) |
| **Manual Task** | hand | `manualTask` | a human, untracked by the engine | ✗ |
| **Script Task** | scroll | `scriptTask` | an inline script run by the engine | ✗ |
| **Business Rule Task** | table | `businessRuleTask` | a decision/rules engine (e.g. DMN) | ✗ |

### Service Task
Work performed by software. In execution engines this is the integration point with the outside world.

- **Camunda 7**: `camunda:class`, `camunda:delegateExpression`, `camunda:expression`, or
  `camunda:type="external"` (external task workers).
- **Camunda 8 / Zeebe**: `zeebe:taskDefinition type="..."` — a **job worker** subscribes to that type.
- **`easy-bpmn`**: a Service Task calls a **remote service worker** over an RPC-like contract; the
  worker returns output variables, which are **persisted before the instance advances** (constitution,
  Principle III). This is `easy-bpmn`'s core automation primitive. The worker is bound by a stable
  **`taskType`** declared in standard `<extensionElements>` under the `easy-bpmn` namespace
  (`<easy-bpmn:taskDefinition type="…" retries="…"/>`) — **not** by the element `id`/`name`, which tools
  regenerate. See [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).

### Receive Task
Waits for an incoming **message** before completing — a durable **wait state**.

- Carries a `messageRef` pointing to a `<message>` root element.
- `instantiate="true"` can make a receive task *start* a process — **rejected** in the MVP (instances
  start via the API only).
- **`easy-bpmn`**: the Receive Task is the MVP's wait point. An external system (admin UI, bot, CRM)
  posts a message; the runtime **correlates** it to the one waiting instance by
  **`messageName` + `correlationKey`** and resumes (constitution, Principle IV). The `correlationKey` is
  supplied via the **API** at instance start (MVP) — the `<message>` carries only its name, and the key
  is not read from a model-level subscription expression. Human decisions enter the process *only* as
  such messages — there is no in-platform human task.

### Why no User Task?
`easy-bpmn` deliberately keeps humans **outside** the platform. A person acts in their own system; the
platform only learns the *fact* of that action via a BPMN message hitting a Receive Task. This is why
`userTask`, `manualTask`, tasklists, forms, and assignment are all out of scope.

## Sub-processes

A **sub-process** groups flow nodes. Collapsed it shows a `[+]` marker; expanded it shows its contents
inline. XML: `<subProcess>` (or `<transaction>`, `<adHocSubProcess>`).

| Type | XML | Behavior |
|------|-----|----------|
| **Embedded (inline) sub-process** | `subProcess` | Shares the parent's data scope. Has exactly one **none** start event. Used to group work and to scope boundary events / compensation. |
| **Event sub-process** | `subProcess triggeredByEvent="true"` | No incoming/outgoing sequence flow. Sits *inside* a process/sub-process and is triggered by its single start event (message, timer, error, escalation, signal, conditional, compensation…). Interrupting or non-interrupting. Drawn with a **dotted** border. |
| **Transaction** | `transaction` | All-or-nothing semantics. Drawn with a **double** border. Can be ended by a *cancel end* event → triggers a *cancel boundary* event on the transaction and runs compensation. |
| **Ad-hoc sub-process** | `adHocSubProcess` | Contained activities run in **any order**, repeatedly, or not at all, until a completion condition holds. Marked with a tilde `~`. |
| **Call Activity** | `callActivity` (attr `calledElement`) | Invokes a *separate, reusable* process definition (or a global task). Drawn with a **thick** border. Requires explicit in/out data mapping. |

> **Call activity vs sub-process:** an embedded sub-process is defined *inline*; a call activity
> *references* another top-level process by id (`calledElement`) and reuses it.

## Activity markers

Small icons at the bottom-center of an activity. They can combine.

| Marker | Icon | XML | Meaning |
|--------|------|-----|---------|
| **Sub-process** | `[+]` | (it's a `subProcess`) | Collapsed sub-process; expand for detail. |
| **Loop** | circular arrow ↻ | `standardLoopCharacteristics` | Repeat the activity while/until a condition holds (sequential). |
| **Multi-instance — parallel** | `\|\|\|` | `multiInstanceLoopCharacteristics isSequential="false"` | Run N copies *simultaneously* (e.g. one per line item). |
| **Multi-instance — sequential** | `≡` | `multiInstanceLoopCharacteristics isSequential="true"` | Run N copies *one after another*. |
| **Compensation** | rewind ◁◁ | (paired with a compensation boundary event) | This activity is a compensation handler — runs to *undo* completed work. |

Markers compose: e.g. a multi-instance **sub-process**, or a compensation **loop**.

## Boundary events on activities

Any activity (task or sub-process) can have **boundary events** attached to its border — see
[`01-events.md`](./01-events.md). Common patterns:

- **Timer boundary (interrupting)** → timeout: cancel the activity after a deadline.
- **Error boundary** → catch an error thrown inside the activity/sub-process.
- **Message boundary (non-interrupting)** → react to a message while work continues.
- **Compensation boundary** → register the activity's undo handler.

---

## `easy-bpmn` scope

**In scope:** exactly two task types — **Service Task** (`serviceTask`) and **Receive Task**
(`receiveTask`). The Service Task's worker `taskType` and retry policy ride in standard
`<extensionElements>` under the `easy-bpmn` namespace (additive, ignorable — not custom notation; see
[`09`](./09-easy-bpmn-profile.md)).

**In scope since M1 (canonical transaction-saga):** the `transaction` sub-process and the **compensation**
marker (a compensation boundary event wired to an `isForCompensation` handler), plus error/cancel boundary
events.

**Out of scope (reject before publish):** the abstract `task`, `userTask`, `sendTask`, `manualTask`,
`scriptTask`, `businessRuleTask`, the non-transaction sub-process types (`subProcess`, `adHocSubProcess`),
`callActivity`, the loop and multi-instance markers, and any task with `instantiate="true"` (instances start
via the API).

The baseline activity vocabulary is *call a worker* (service task) and *wait for a message* (receive task);
since M1 it also includes the `transaction` sub-process with compensation / error / cancel boundary events
— the canonical saga scope. See [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).
