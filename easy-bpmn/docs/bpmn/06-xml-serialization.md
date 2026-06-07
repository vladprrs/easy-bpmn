# 06 — BPMN 2.0 XML Serialization

This is the format `easy-bpmn`'s parser/validator consumes. A `.bpmn` file is XML with two parts:

1. **Semantic model** — `<definitions>` → `<process>` (+ optional `<collaboration>`) → flow nodes &
   flows. *This is what the engine executes.*
2. **Diagram interchange (DI)** — `<bpmndi:BPMNDiagram>` with shape coordinates & edge waypoints.
   *Purely visual; the engine ignores it.* A semantically valid process can have **no** DI at all.

## Namespaces

The canonical OMG namespaces are **fixed constants** (the date `20100524` is part of the URI — it is
*not* a version you bump):

| Prefix (conventional) | Namespace URI | Used for |
|-----------------------|---------------|----------|
| `bpmn` *(or `bpmn2`, or default)* | `http://www.omg.org/spec/BPMN/20100524/MODEL` | The semantic model elements |
| `bpmndi` | `http://www.omg.org/spec/BPMN/20100524/DI` | Diagram interchange (shapes/edges) |
| `dc` | `http://www.omg.org/spec/DD/20100524/DC` | Bounds (x/y/width/height) |
| `di` | `http://www.omg.org/spec/DD/20100524/DI` | Waypoints |
| `xsi` | `http://www.w3.org/2001/XMLSchema-instance` | `xsi:type` on expressions |
| `camunda` | `http://camunda.org/schema/1.0/bpmn` | Camunda 7 extensions (see [`08`](./08-engines-and-extensions.md)) |
| `zeebe` | `http://camunda.org/schema/zeebe/1.0` | Camunda 8 / Zeebe extensions |

> **Parser rule #1: bind by namespace + local name, not by prefix.** Different tools use different
> prefixes — `bpmn:`, `bpmn2:`, or no prefix with a default `xmlns`. `<bpmn:task>`, `<bpmn2:task>`, and
> `<task>` (default ns) are the *same element*. Use a namespace-aware XML parser and match on the
> `{MODEL-ns}localName`. (This is exactly what `bpmn-moddle` does for you — see [`08`](./08-engines-and-extensions.md).)

`targetNamespace` on `<definitions>` is the namespace of *this file's* definitions (often
`http://bpmn.io/schema/bpmn`); it's required but doesn't affect parsing of standard elements.

## Document skeleton

```xml
<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
    xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
    xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="Definitions_1"
    targetNamespace="http://bpmn.io/schema/bpmn"
    exporter="Camunda Modeler" exporterVersion="5.x">

  <!-- 0..* root elements: message, signal, error, escalation, itemDefinition, dataStore -->
  <bpmn:message id="Msg_Approved" name="ApprovalReceived" />

  <!-- 0..1 collaboration (pools/participants/messageFlows) -->
  <!-- 1..* process -->
  <bpmn:process id="Process_1" name="Demo" isExecutable="true">
    ... flow nodes and sequence flows ...
  </bpmn:process>

  <!-- diagram interchange (visual layout) -->
  <bpmndi:BPMNDiagram id="Diagram_1">
    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1">
      ... BPMNShape / BPMNEdge ...
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
```

### `<definitions>` (root) — key attributes
| Attribute | Notes |
|-----------|-------|
| `id` | Definitions id. |
| `targetNamespace` | Required. Namespace of these definitions. |
| `exporter` / `exporterVersion` | Which tool wrote the file (informational). |

### `<process>` — key attributes
| Attribute | Notes |
|-----------|-------|
| `id` | **Required.** The process definition key. |
| `name` | Human label. |
| `isExecutable` | `true`/`false`. Engines only run `true`. |

## Element → XML tag map

All in the `MODEL` namespace. `(ref)` = an attribute holding another element's `id`.

### Events
| Element | Tag | Notable attrs / children |
|---------|-----|--------------------------|
| Start event | `startEvent` | `isInterrupting` (event sub-process) |
| End event | `endEvent` | |
| Intermediate catch | `intermediateCatchEvent` | |
| Intermediate throw | `intermediateThrowEvent` | |
| Boundary event | `boundaryEvent` | `attachedToRef` (ref), `cancelActivity` (`true`=interrupting) |

**Event definitions** (child of an event; their presence sets the trigger):
| Trigger | Child element | Key attrs/children |
|---------|---------------|--------------------|
| Message | `messageEventDefinition` | `messageRef` (ref) |
| Timer | `timerEventDefinition` | one of `<timeDate>` / `<timeDuration>` / `<timeCycle>` (ISO-8601) |
| Error | `errorEventDefinition` | `errorRef` (ref) |
| Escalation | `escalationEventDefinition` | `escalationRef` (ref) |
| Signal | `signalEventDefinition` | `signalRef` (ref) |
| Conditional | `conditionalEventDefinition` | `<condition>` expression |
| Link | `linkEventDefinition` | `name` (paired throw/catch) |
| Compensation | `compensateEventDefinition` | `activityRef` (optional) |
| Cancel | `cancelEventDefinition` | (transaction only) |
| Terminate | `terminateEventDefinition` | (end event only) |

> A bare `<startEvent>`/`<endEvent>` with **no** child `*EventDefinition` is a **none** event — exactly
> what `easy-bpmn` supports.

### Activities
| Element | Tag | Notable attrs |
|---------|-----|---------------|
| Abstract task | `task` | |
| Service task | `serviceTask` | engine attrs (`camunda:*` / `zeebe:*`) |
| Send task | `sendTask` | `messageRef` |
| Receive task | `receiveTask` | `messageRef`, `instantiate` |
| User task | `userTask` | |
| Manual task | `manualTask` | |
| Script task | `scriptTask` | `scriptFormat`, `<script>` |
| Business rule task | `businessRuleTask` | |
| Sub-process | `subProcess` | `triggeredByEvent` (event sub-process) |
| Transaction | `transaction` | |
| Ad-hoc sub-process | `adHocSubProcess` | `<completionCondition>` |
| Call activity | `callActivity` | `calledElement` (ref to another process) |

**Loop/multi-instance** (child of an activity): `standardLoopCharacteristics`, or
`multiInstanceLoopCharacteristics` (`isSequential`, `<loopCardinality>`, `loopDataInputRef`).

### Gateways
`exclusiveGateway` · `parallelGateway` · `inclusiveGateway` · `eventBasedGateway` · `complexGateway`.
Splitting gateways may carry `default="<flowId>"`.

### Flows & connections
| Element | Tag | Attrs / children |
|---------|-----|------------------|
| Sequence flow | `sequenceFlow` | `sourceRef`, `targetRef`; child `<conditionExpression>` |
| Message flow | `messageFlow` | `sourceRef`, `targetRef` (in `collaboration`) |
| Association | `association` | `sourceRef`, `targetRef` |
| Flow node ↔ flow links | `<incoming>` / `<outgoing>` | **text content = a sequenceFlow id** |

Each flow node *also* lists its connected flows as child `<bpmn:incoming>`/`<bpmn:outgoing>` elements
(redundant with `sourceRef`/`targetRef`, but present in tool output — keep consistent):

```xml
<bpmn:startEvent id="Start_1">
  <bpmn:outgoing>Flow_1</bpmn:outgoing>
</bpmn:startEvent>
<bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
<bpmn:serviceTask id="Task_1" name="Call worker">
  <bpmn:incoming>Flow_1</bpmn:incoming>
  <bpmn:outgoing>Flow_2</bpmn:outgoing>
</bpmn:serviceTask>
```

### Conditional expression serialization
```xml
<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${amount &gt; 1000}</bpmn:conditionExpression>
```
`xsi:type="bpmn:tFormalExpression"` is required. The body is engine-specific (Camunda 7 = JUEL `${...}`;
Zeebe = FEEL `=amount &gt; 1000`). XML-escape `<`, `>`, `&`.

### Collaboration / swimlanes
`collaboration` → `participant` (`processRef`) ; `messageFlow`. Lanes: `laneSet` → `lane` →
`<flowNodeRef>` (text = node id).

### Root definition elements (referenced by ref attrs)
`message` (`name`) · `signal` (`name`) · `error` (`name`, `errorCode`) · `escalation`
(`escalationCode`) · `itemDefinition` · `dataStore`.

## Diagram Interchange (DI)

The visual layer. **The engine ignores it** — but a good editor needs it, and a missing/garbled DI is a
common reason a file "won't open" even though it executes fine.

```xml
<bpmndi:BPMNDiagram id="Diagram_1">
  <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1">
    <bpmndi:BPMNShape id="Start_1_di" bpmnElement="Start_1">
      <dc:Bounds x="160" y="100" width="36" height="36" />
    </bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="Task_1_di" bpmnElement="Task_1" isExpanded="true">
      <dc:Bounds x="250" y="78" width="100" height="80" />
    </bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
      <di:waypoint x="196" y="118" />
      <di:waypoint x="250" y="118" />
    </bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane>
</bpmndi:BPMNDiagram>
```
| DI element | Links to semantic element via | Holds |
|------------|-------------------------------|-------|
| `BPMNPlane` | `bpmnElement` → process/collaboration id | the canvas |
| `BPMNShape` | `bpmnElement` → node id | `dc:Bounds` (x,y,w,h); `isExpanded`, `isMarkerVisible` |
| `BPMNEdge` | `bpmnElement` → flow id | ordered `di:waypoint` list |
| `BPMNLabel` | (child of shape/edge) | label bounds |

## Minimal complete example — the `easy-bpmn` happy path

A valid, executable-in-MVP process: `Start → Service Task → Receive Task → End`, with message
correlation on the receive task. This is the kind of file the parser should **accept**.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
    xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
    xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
    id="Definitions_demo" targetNamespace="http://easy-bpmn/demo">

  <bpmn:message id="Msg_Approval" name="ApprovalReceived" />

  <bpmn:process id="Process_demo" name="External check + approval" isExecutable="true">

    <bpmn:startEvent id="Start_1" name="Start">
      <bpmn:outgoing>Flow_s_check</bpmn:outgoing>
    </bpmn:startEvent>

    <bpmn:sequenceFlow id="Flow_s_check" sourceRef="Start_1" targetRef="Task_check" />

    <bpmn:serviceTask id="Task_check" name="Run external check">
      <bpmn:incoming>Flow_s_check</bpmn:incoming>
      <bpmn:outgoing>Flow_check_wait</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:sequenceFlow id="Flow_check_wait" sourceRef="Task_check" targetRef="Task_wait" />

    <bpmn:receiveTask id="Task_wait" name="Wait for approval" messageRef="Msg_Approval">
      <bpmn:incoming>Flow_check_wait</bpmn:incoming>
      <bpmn:outgoing>Flow_wait_end</bpmn:outgoing>
    </bpmn:receiveTask>

    <bpmn:sequenceFlow id="Flow_wait_end" sourceRef="Task_wait" targetRef="End_1" />

    <bpmn:endEvent id="End_1" name="Done">
      <bpmn:incoming>Flow_wait_end</bpmn:incoming>
    </bpmn:endEvent>

  </bpmn:process>

  <bpmndi:BPMNDiagram id="Diagram_1">
    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_demo">
      <bpmndi:BPMNShape id="Start_1_di" bpmnElement="Start_1">
        <dc:Bounds x="160" y="100" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_check_di" bpmnElement="Task_check">
        <dc:Bounds x="250" y="78" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_wait_di" bpmnElement="Task_wait">
        <dc:Bounds x="410" y="78" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="End_1_di" bpmnElement="End_1">
        <dc:Bounds x="570" y="100" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_s_check_di" bpmnElement="Flow_s_check">
        <di:waypoint x="196" y="118" /><di:waypoint x="250" y="118" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_check_wait_di" bpmnElement="Flow_check_wait">
        <di:waypoint x="350" y="118" /><di:waypoint x="410" y="118" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_wait_end_di" bpmnElement="Flow_wait_end">
        <di:waypoint x="510" y="118" /><di:waypoint x="570" y="118" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
```

> The Service Task above has no `camunda:`/`zeebe:` worker binding — `easy-bpmn` decides *how* a service
> task maps to a remote worker (by task name/type or an `easy-bpmn:` extension TBD). See
> [`08-engines-and-extensions.md`](./08-engines-and-extensions.md) and
> [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).

## Parsing checklist (gotchas)

- [ ] **Namespace-aware parsing.** Match `{MODEL-ns}localName`; never hard-code the `bpmn:` prefix.
- [ ] **Default namespace.** A file may declare `xmlns="...MODEL"` and use unprefixed tags.
- [ ] **`incoming`/`outgoing` vs `sourceRef`/`targetRef`.** Both encode connectivity; validate they
      agree, but treat `sequenceFlow`'s `sourceRef`/`targetRef` as authoritative.
- [ ] **None vs typed events.** Trigger = presence of a child `*EventDefinition`. No child ⇒ none.
- [ ] **IDs are document-unique** and are the join keys for every `*Ref`. Resolve & validate all refs.
- [ ] **DI is optional and ignorable** for execution — don't fail a publish because layout is missing.
- [ ] **Multiple `<process>`** elements can exist in one file (e.g. a collaboration). Pick the
      executable one(s).
- [ ] **XML-escaping** in expressions (`&gt;`, `&lt;`, `&amp;`).
- [ ] **Unsupported elements** must be *detected and rejected with a reason*, not silently skipped
      (constitution, Principle I). Whitelist the supported tags; reject anything else. See
      [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).

> **Don't write your own XML→model mapper from scratch.** `bpmn-moddle` already turns this XML into a
> typed JS object tree (and back) with full namespace handling. `easy-bpmn` can parse with
> `bpmn-moddle`, then run its *own* whitelist validation + execution over the resulting model. See
> [`08`](./08-engines-and-extensions.md) and [`resources.md`](./resources.md).
