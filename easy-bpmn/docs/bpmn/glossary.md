# Glossary

Terms used throughout this reference. Where a term has a specific meaning in `easy-bpmn`, that is
noted.

| Term | Definition |
|------|------------|
| **Activity** | A unit of work: a **task** (atomic) or a **sub-process** (compound). Drawn as a rounded rectangle. |
| **Artifact** | Documentation element with no execution effect: text annotation, group. |
| **Boundary event** | An event attached to the border of an activity, reacting to something (timer, error, message…) while the activity runs. Interrupting or non-interrupting. |
| **Call activity** | An activity that invokes a separate, reusable process (`callActivity`, `calledElement`). |
| **Catching event** | An event that *waits* for a trigger to occur (message arrives, timer fires). |
| **Choreography** | A diagram type modeling message exchange between participants with no central controller. |
| **Collaboration** | A diagram with ≥2 pools connected by message flows. |
| **Compensation** | "Undo" logic — a compensation handler reverses an already-completed activity. |
| **Conditional flow** | A sequence flow guarded by a `conditionExpression`; taken only if the condition is true. |
| **Conformance level** | A defined subset of BPMN a tool claims to support (Descriptive, Analytic, Common Executable, Full). |
| **Correlation** | Matching an incoming message to the one waiting process instance it belongs to. In `easy-bpmn`: by **`messageName` + `correlationKey`** (constitution, Principle IV). |
| **Correlation key** | The value (e.g. an order id) used to route an external message to the right instance. |
| **Data object** | In-process data with a lifecycle scoped to the process instance. |
| **Data store** | Persistent data that outlives the instance (a DB, a file). |
| **Default flow** | The outgoing flow from a gateway/activity taken when no conditional flow matches. Marked with a slash. |
| **Definition** | See *process definition*. |
| **DI (Diagram Interchange)** | The `BPMNDI` part of the XML that stores shape coordinates and edge waypoints — the visual layout. |
| **End event** | Consumes a token. Drawn as a thick-bordered circle. |
| **Escalation** | A non-error signal bubbling up to a handler (e.g. "needs manager attention"); unlike errors, can be non-interrupting. |
| **Event** | Something that *happens* during a process: start, intermediate, or end. Drawn as a circle. |
| **Event-based gateway** | A gateway that routes by *which event happens first*, not by data. |
| **Event definition** | The child element that gives an event its trigger type (`messageEventDefinition`, `timerEventDefinition`, …). A bare event with no definition is a "none" event. |
| **Event sub-process** | A sub-process with no incoming/outgoing flow, triggered by its start event from within its parent (`triggeredByEvent="true"`). |
| **FEEL** | Friendly Enough Expression Language — the DMN/BPMN expression language used by Camunda 8 / Zeebe. |
| **Flow node** | Any node a token can occupy: event, activity, or gateway. |
| **Gateway** | A routing/branching control. Diamond shape. |
| **Idempotent** | Safe to apply more than once with the same effect. A core `easy-bpmn` requirement for callbacks, retries, and messages (constitution, Principle III). |
| **Instance** | See *process instance*. |
| **Interrupting** | An event that cancels the activity/scope it reacts to (solid border). Opposite: *non-interrupting* (dashed border), which spawns a parallel path and leaves the activity running. |
| **Intermediate event** | An event between start and end: catching (waits) or throwing (emits). |
| **Lane** | A subdivision of a pool, usually a role/system responsible for the contained nodes. |
| **Marker** | A small icon inside an activity indicating loop, multi-instance, compensation, or sub-process. |
| **Message** | A named payload exchanged between participants; the trigger for message events and the (re)start of a receive task. |
| **Message flow** | Dashed connector between pools representing a message; *never* connects nodes inside the same pool. |
| **moddle / bpmn-moddle** | The JS library that reads/writes BPMN XML into a typed object model. |
| **Multi-instance** | A marker causing an activity to run N times, sequentially or in parallel. |
| **Pool** | A participant in a collaboration; a container for a process. |
| **Process definition** | The static, parsed `<process>` model. In `easy-bpmn`, **immutable & versioned**. |
| **Process instance** | One running execution of a definition, with its own variables and history. |
| **Receive task** | A task that *waits* for a message before completing. The MVP's wait state. |
| **Sequence flow** | The solid arrow that orders flow nodes within a single process/pool. |
| **Service task** | A task performed by software (a remote worker, in `easy-bpmn`'s case). |
| **Signal** | A broadcast event with no specific recipient (one-to-many), vs a message (one-to-one). |
| **Sub-process** | A compound activity containing its own flow nodes. |
| **Throwing event** | An event that *emits* a trigger (throws a message/signal/error). |
| **Token** | The abstraction for "control is here." Created by start events, consumed by end events. |
| **Transaction** | A special sub-process with all-or-nothing semantics; supports cancel + compensation. |
| **Wait state** | A point where the instance is durably parked until something external happens (receive task, timer, message catch). |
| **Worker** | In `easy-bpmn` / Zeebe-style engines: an external process that polls for / receives service-task jobs and reports results. |
