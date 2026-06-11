# 08 — Engines, Extension Namespaces & the OSS Ecosystem

BPMN's core XML can't say *how* a service task is implemented or *what variables* map in/out — the spec
leaves that to **engine-specific extensions** under their own namespaces. This file surveys the major
engines, their extension attributes, and the open-source building blocks `easy-bpmn` can reuse.

## Why extensions exist

The standard `<serviceTask>` is just a labeled box. To run it, an engine needs to know which code/worker
to call. Engines add this via attributes/elements in their own namespace, carried inside
`<bpmn:extensionElements>` or as namespaced attributes. The *semantic* model stays standard; the
*binding* is vendor-specific.

## Camunda 7 (and Operaton)

Namespace: `xmlns:camunda="http://camunda.org/schema/1.0/bpmn"`. Expressions are **JUEL** (`${...}`).

**Operaton** is the community/open-source fork of Camunda 7 (after Camunda 7 CE went end-of-life). It is
API- and XML-compatible (same `camunda:` schema and `external task` model), so Camunda-7-style BPMN runs
on Operaton largely unchanged. If you want a reference *open-source* engine with the exact external-task
pattern `easy-bpmn` uses, Operaton is the closest match.

### Service task bindings (Camunda 7 / Operaton)
| Binding | Attribute | Meaning |
|---------|-----------|---------|
| Java class | `camunda:class` | Instantiate a `JavaDelegate`. |
| Expression | `camunda:expression` | Evaluate a JUEL expression. |
| Delegate | `camunda:delegateExpression` | Resolve a bean implementing the delegate. |
| **External task** | `camunda:type="external"` + `camunda:topic="..."` | A **remote worker** polls the topic, does the work, completes the job. ← *the model closest to `easy-bpmn`.* |

```xml
<bpmn:serviceTask id="Task_check" name="Run external check">
  <bpmn:extensionElements>
    <camunda:properties>
      <camunda:property name="retries" value="3" />
    </camunda:properties>
  </bpmn:extensionElements>
  <!-- external worker model -->
</bpmn:serviceTask>
<!-- attribute form: camunda:type="external" camunda:topic="external-check" -->
```

The **external task** pattern (worker pulls jobs by topic, reports result/variables) is essentially the
durable-worker contract `easy-bpmn` implements — worth studying.

## Camunda 8 / Zeebe

Namespace: `xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"`. Expressions are **FEEL** (prefix `=`,
e.g. `=amount > 1000`). Extensions live inside `<bpmn:extensionElements>`.

### Job workers (Zeebe)
```xml
<bpmn:serviceTask id="Task_check" name="Run external check">
  <bpmn:extensionElements>
    <zeebe:taskDefinition type="external-check" retries="3" />
    <zeebe:ioMapping>
      <zeebe:input  source="=orderId" target="orderId" />
      <zeebe:output source="=result"  target="checkResult" />
    </zeebe:ioMapping>
  </bpmn:extensionElements>
</bpmn:serviceTask>
```
A **job worker** subscribes to `type="external-check"`, receives the job + variables, and completes it.
This is a clean **push/pull worker contract** over a service task — again, very close to `easy-bpmn`'s
model.

### Zeebe message correlation
```xml
<bpmn:receiveTask id="Task_wait" name="Wait for approval" messageRef="Msg_Approval">
  <bpmn:extensionElements />
</bpmn:receiveTask>
<bpmn:message id="Msg_Approval" name="ApprovalReceived">
  <bpmn:extensionElements>
    <zeebe:subscription correlationKey="=orderId" />
  </bpmn:extensionElements>
</bpmn:message>
```
Note how Zeebe puts the **correlation key** on the `<message>` via `zeebe:subscription`. `easy-bpmn`
needs an equivalent: a message name + a way to derive the correlation key from instance/message data
(constitution, Principle IV).

## Other notable engines

| Engine | Lang | Notes |
|--------|------|-------|
| **Camunda 7 / Operaton** | Java | Mature; external-task workers; `camunda:` schema. Operaton = OSS fork. |
| **Camunda 8 (Zeebe)** | Java/Go | Cloud-native, horizontally scalable; FEEL; job workers; `zeebe:` schema. |
| **Flowable** | Java | Embeddable BPMN/DMN/CMMN engine (Activiti lineage). |
| **Activiti** | Java | Light-weight BPM engine; ancestor of Flowable. |
| **jBPM / Kogito (KIE)** | Java | Red Hat business automation. |
| **SpiffWorkflow** | Python | Pure-Python BPMN 2.0 engine — readable reference for executor semantics. |
| **Temporal** | Go/poly | Not BPMN, but the canonical *durable execution* model worth studying for idempotency/replay. |

## The JavaScript/TypeScript ecosystem (most relevant to `easy-bpmn`)

`easy-bpmn` runs on Cloudflare Workers/Durable Objects (JS/TS). These OSS pieces map directly onto our
build:

| Project | What it does | How `easy-bpmn` could use it |
|---------|--------------|------------------------------|
| **`bpmn-moddle`** | Read/write BPMN 2.0 XML ⇄ typed JS object model, namespace-aware. | **Parsing.** Don't hand-roll XML→model; parse with this, then validate/execute the model. |
| **`camunda-bpmn-moddle`** / **`zeebe-bpmn-moddle`** | moddle extensions for `camunda:` / `zeebe:` attributes. | If/when we read engine extension attrs, or define our own moddle extension for `easy-bpmn:` bindings. |
| **`bpmn-engine`** (paed01, Node) | Lightweight, event-driven BPMN 2.0 execution engine. | **Reference implementation** of executor semantics in JS. Study its token/wait-state handling. |
| **`bpmn-server`** | BPMN server with persistence & monitoring on top of `bpmn-engine`. | Reference for persistence/history/monitoring shape. |
| **`bpmn-js`** | The standard BPMN rendering/modeling toolkit (used by Camunda Modeler). | If we ever add a viewer/modeler UI. |
| **`bpmnlint`** | Pluggable BPMN validation rules. | Inspiration (or reuse) for our *unsupported-element rejection* + structural validation. |
| **`bpmn-js-token-simulation`** | Token-flow simulator overlay. | Mental model / debugging aid for execution semantics. |
| **`SpiffWorkflow`** (Python) | Full BPMN engine. | Cross-language reference for correct semantics. |

> **Recommended split for `easy-bpmn`:** use **`bpmn-moddle`** for parsing (it solves namespaces,
> prefixes, refs, and DI for free), then implement our *own* (a) **whitelist validator** that rejects
> anything outside the supported profile with a user-visible reason, and (b) **durable executor** as one
> Cloudflare Workflow per process instance, plus a single Durable Object correlation broker (keyed by
> `workspaceId + messageName + correlationKey`) for message correlation. The executor semantics can be
> cross-checked against `bpmn-engine` / `SpiffWorkflow`.

## FEEL & expression languages (context)

- **JUEL** (`${...}`) — Camunda 7 / Operaton.
- **FEEL** (`=expr`) — Camunda 8 / Zeebe and DMN. "Friendly Enough Expression Language" — a small,
  side-effect-free expression language for conditions and data mapping.
- **`easy-bpmn`**: **FEEL, since M2.** XOR branching ships with FEEL `conditionExpression`s on the
  flows leaving an `exclusiveGateway`, evaluated via the **`feelin`** interpreter with
  Camunda-compatible semantics (parse-checked at publish; evaluated at runtime in document order,
  first `true` wins; a missing variable makes a comparison `null` → not taken, not an error). FEEL
  was chosen because it is the modern, standard choice (an OMG/DMN standard). See the
  "Conditional saga (M2)" section of [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).

---

## `easy-bpmn` scope

`easy-bpmn` is **not** aiming for Camunda/Zeebe compatibility (the constitution explicitly excludes
"full Zeebe/Camunda compatibility" from the MVP). It defines its *own* minimal service-worker contract
and message-correlation API. Concretely, the worker binding is an **`easy-bpmn:taskDefinition`** (a
`type` topic + `retries`) inside standard `<extensionElements>` — modeled on the external-task pattern
but under `easy-bpmn`'s **own** namespace (`http://easy-bpmn/schema/1.0`). Reusing `camunda:`/`zeebe:`
vocabulary verbatim was rejected: it would make files *look* compatible while not honoring their
semantics (FEEL, ioMapping). See [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md) and
[`research.md`](../../specs/001-bpmn-lite-orchestrator-mvp/research.md).

What to borrow now: **`bpmn-moddle`** for parsing; the **external-task / job-worker** mental model
(Operaton/Zeebe) for the service-task ↔ remote-worker contract; and **`bpmn-engine`/`SpiffWorkflow`** as
semantic references. What to ignore for now: `camunda:`/`zeebe:` extension attributes (tolerated but
never required), FEEL, and any multi-engine portability. See
[`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md) and [`resources.md`](./resources.md).
