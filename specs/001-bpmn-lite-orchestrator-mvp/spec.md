# Feature Specification: BPMN-lite Orchestrator MVP

**Feature Branch**: `001-bpmn-lite-orchestrator-mvp`

**Created**: 2026-06-07

**Status**: Draft

**Input**: User description: "Discuss easy-bpmn/start.md, add context for why
MVP decisions were made, then create a product-first Spec Kit specification that
proves BPMN execution without Camunda/Zeebe operations while preserving
workflow-engine-grade runtime constraints."

## Constitution Alignment *(mandatory)*

**BPMN Profile Impact**: The feature is the MVP profile itself. It supports only
standard BPMN 2.0-compatible Start Event, Service Task, Receive Task, End Event,
Sequence Flow, and Message correlation. Unsupported BPMN flow nodes are rejected
before publish with element-level reasons.

"No custom notation" is defined precisely so the constraint is testable: the system
MUST NOT (a) introduce new element or shape types in the BPMN MODEL namespace,
(b) redefine the runtime meaning of a standard element, or (c) require any
non-standard attribute on a standard element for a file to parse. Worker binding and
retry metadata are carried only in the standard `<bpmn:extensionElements>` escape
hatch under a dedicated `easy-bpmn` namespace; they are additive and ignorable. The
operative test: every accepted file MUST remain valid against the BPMN 2.0 XSD and
round-trip through a standard modeler (bpmn-js / Camunda Modeler) unchanged even when
easy-bpmn extensions and Diagram Interchange are ignored. Foreign-namespace extension
elements (`camunda:`, `zeebe:`, ...), Diagram Interchange, and `documentation` are
tolerated and ignored, never required for execution and never a reason to reject.

**Definition Versioning Impact**: BPMN XML can be edited as a draft. Publishing
creates an immutable executable definition version. Every process instance starts
from one published version and remains bound to that version for its lifetime.

**Runtime Idempotency Impact**: Service Task worker delivery, worker callbacks,
external messages, retries, and replay are treated as at-least-once inputs.
Duplicate callbacks, duplicate worker attempts, duplicate message publishes, and
retry attempts must not create duplicate completion effects or corrupt variables.

**Receive Task Correlation Impact**: Receive Task waiting creates a durable
message subscription. External messages correlate by `messageName` plus
`correlationKey`, and deduplicate by `messageId` scoped to that pair. Early
messages are buffered for a fixed default TTL and correlated later if the
matching Receive Task becomes eligible.

**Audit and Operator Visibility Impact**: Operators can inspect process instance
status, current BPMN element, variables, business timeline, and technical
diagnostics. History includes state transitions, worker attempts/results, retry
counts, message correlation outcomes, duplicate handling, incidents, and raw
payload snapshots by default.

**Demo Flow Impact**: The MVP directly supports upload -> publish -> start ->
Service Task -> Receive Task -> message correlation -> completion -> history.
The first demo flow uses a platform-provided sample worker so the developer can
complete the flow without deploying a workflow cluster, broker, BPMN engine, or
custom worker.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run BPMN Without Workflow Infrastructure (Priority: P1)

A backend or platform developer uploads a simple BPMN process, publishes it,
starts an instance, lets a sample Service Task worker run, sends an external
business message, and sees the instance complete with visible variables and
history. The developer does this without deploying a workflow cluster, broker,
engine, or custom worker for the first demo.

**Why this priority**: This is the core product bet: standard BPMN becomes an
executable durable process without Camunda/Zeebe-style operations.

**Independent Test**: A new project can run the full demo process from BPMN XML
upload through completed instance inspection using only the product-provided
runtime and sample worker.

**Acceptance Scenarios**:

1. **Given** a valid BPMN XML process with Start Event, Service Task, Receive
   Task, End Event, Sequence Flow, and Message correlation, **When** the
   developer uploads and publishes it, **Then** the system creates an immutable
   executable definition version.
2. **Given** a published definition version, **When** the developer starts an
   instance with initial variables, **Then** the instance is bound to that
   version and enters the first BPMN element.
3. **Given** an instance at the Service Task, **When** the sample worker
   completes the task, **Then** output variables are persisted before the
   instance advances to the Receive Task.
4. **Given** an instance waiting at the Receive Task, **When** the developer
   publishes a matching external message, **Then** the message payload is applied
   and the instance completes.
5. **Given** a completed demo instance, **When** the developer inspects it,
   **Then** status, current or final BPMN element, variables, business timeline,
   and technical diagnostics are visible.

---

### User Story 2 - Publish Stable Executable Definitions (Priority: P2)

A developer iterates on BPMN XML as a draft, validates that it stays inside the
MVP BPMN profile, and publishes immutable versions when ready. Running instances
never change their definition version even if the draft later changes.

**Why this priority**: Stable published versions make execution explainable and
avoid process migration complexity in the MVP.

**Independent Test**: A draft can be validated, rejected for unsupported
elements, published as an immutable version, and used to start an instance whose
definition does not change after later draft edits.

**Acceptance Scenarios**:

1. **Given** a draft with unsupported BPMN elements, **When** the developer
   attempts to publish, **Then** publish is rejected with unsupported element
   names and locations.
2. **Given** a valid draft, **When** the developer publishes it, **Then** a new
   immutable definition version is created.
3. **Given** a running instance bound to a published version, **When** the draft
   BPMN XML changes and a new version is published, **Then** the running
   instance remains bound to its original version.

---

### User Story 3 - Correlate External Business Events Reliably (Priority: P2)

An external system sends a business event with message name, correlation key,
message id, and payload. The runtime correlates it to the right Receive Task,
buffers early messages for a fixed default TTL, and handles duplicate publishes
with stable responses.

**Why this priority**: The product intentionally keeps human work outside the
platform; reliable message correlation is the bridge between external business
systems and the process runtime.

**Independent Test**: Messages can be published before or during a Receive Task
wait, duplicates produce the original response, and a matching waiting instance
advances exactly once.

**Acceptance Scenarios**:

1. **Given** an instance waiting for a message, **When** a matching message with
   a new message id is published, **Then** the response is `correlated` and the
   instance advances exactly once.
2. **Given** no matching instance is waiting yet, **When** a message is
   published within the fixed default TTL window, **Then** the response is
   `buffered` and the message later correlates if the Receive Task becomes
   eligible before expiry.
3. **Given** a message was already accepted, **When** the same message id is
   published again for the same message name and correlation key, **Then** the
   response is the same as the original response and no duplicate process
   transition occurs.

---

### User Story 4 - Diagnose Failures and Runtime Decisions (Priority: P3)

An operator inspects process history and incidents to understand what happened,
which BPMN element was involved, what data was exchanged, and what can be done
outside the product. The MVP shows incidents but does not provide recovery
actions in the operator view.

**Why this priority**: Durable orchestration is credible only when failures,
retries, duplicates, and payloads are visible enough for a backend developer to
debug.

**Independent Test**: A Service Task failure scenario records retry attempts,
then enters an incident-style state with the current BPMN element, reason,
payload context, and history.

**Acceptance Scenarios**:

1. **Given** a Service Task worker failure with retries remaining, **When** the
   runtime records the failure, **Then** the instance remains at the Service Task
   and another attempt is scheduled.
2. **Given** a Service Task worker failure exhausts retries, **When** the runtime
   records the final failure, **Then** the instance enters an incident-style
   state at that BPMN element.
3. **Given** an incident-style instance, **When** the operator inspects it,
   **Then** the operator sees the element, reason, retry history, relevant
   payload snapshots, and a clear explanation that recovery actions are outside
   the MVP operator view.

### Edge Cases

- Invalid BPMN XML is rejected before draft validation completes.
- BPMN XML containing gateways, timers, boundary events, subprocesses,
  multi-instance, compensation, User Task, or other unsupported elements is
  rejected before publish.
- A Receive Task (or any task) with `instantiate="true"`, or any non-none
  instantiation path, is rejected before publish; instances start only via the API.
- BPMN XML that is well-formed and inside the profile but also carries
  foreign-namespace extension elements, Diagram Interchange, or `documentation` is
  accepted; the ignorable content does not cause rejection.
- A process cannot start from an unpublished draft or from a deleted or unknown
  published version.
- Draft edits after publish do not mutate any published version or running
  instance.
- Service Task worker completion received more than once is treated as
  at-least-once input and must not advance the instance twice.
- Worker failure retries are limited; exhausted retries create an incident-style
  state at the Service Task.
- An external message received before the matching Receive Task is buffered for
  the fixed default TTL.
- A buffered message whose TTL expires is recorded in message history and does
  not later advance an instance.
- Duplicate message publish with the same `messageId` for the same
  `messageName + correlationKey` returns the original publish response.
- A different `messageId` for the same `messageName + correlationKey` after the
  instance already advanced is recorded as a late or rejected message in history.
- The runtime enforces at most one active eligible subscription for the same
  `messageName + correlationKey` within a project/workspace so correlation is
  deterministic.
- Raw payload snapshots are stored by default for MVP diagnostics; future
  redaction or retention controls are outside this feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Users MUST be able to upload BPMN XML as an editable draft.
- **FR-002**: The system MUST validate BPMN XML against the MVP BPMN profile
  before publishing, parsing it namespace-aware (matched by `{MODEL-ns}localName`,
  never by element prefix) and rejecting input that is not valid BPMN 2.0 XML.
- **FR-003**: The system MUST reject unsupported BPMN flow nodes (any flow node
  outside none Start Event, Service Task, Receive Task, none End Event) and
  unsupported standard-namespace constructs before publish with user-visible
  element names and reasons. It MUST NOT silently skip them.
- **FR-003a**: The system MUST tolerate (accept and ignore, not reject)
  foreign-namespace `<extensionElements>`, Diagram Interchange (`bpmndi:*`), and
  `documentation`, because the BPMN standard requires conformant tools to ignore
  unknown extension content. The "no silent skips" rule applies to standard-namespace
  flow nodes and structures outside the profile, not to ignorable extension content.
- **FR-004**: The system MUST allow valid drafts to be published as immutable
  executable definition versions.
- **FR-005**: The system MUST keep running process instances bound to exactly one
  published definition version for their lifetime.
- **FR-006**: Users MUST be able to start a process instance from a published
  definition version with initial variables.
- **FR-007**: The first demo flow MUST include a product-provided sample Service
  Task worker so the developer can complete the demo without deploying a custom
  worker.
- **FR-008**: When a process instance enters a Service Task, the runtime MUST
  create durable job state for that task before worker execution begins.
- **FR-009**: A Service Task job MUST complete only after worker output
  variables are persisted and the instance is ready to advance.
- **FR-010**: Service Task worker delivery and callbacks MUST be treated as
  at-least-once inputs; duplicate completion or failure callbacks MUST be
  idempotent.
- **FR-011**: Service Task worker binding and retry policy MUST be declared in
  standard `<bpmn:extensionElements>` under the `easy-bpmn` namespace — additive and
  ignorable, introducing no new MODEL-namespace notation and no non-standard
  attribute on a standard element.
- **FR-011a**: The Service Task worker MUST be routed by a stable, author-defined
  task type carried in the extension metadata, NOT by the BPMN element `id` or
  `name`. Element ids are tool-generated and change when a task is re-drawn, so
  routing on them would be brittle and non-portable.
- **FR-012**: Service Task failures MUST retry automatically while retry attempts
  remain and MUST create an incident-style state when retries are exhausted.
- **FR-013**: A Receive Task MUST create a durable message subscription from the
  Receive Task `messageRef` (the declared message name) and the instance
  correlation key. In the MVP the correlation key is supplied via the API at
  instance start and is NOT derived from a model-level subscription expression; the
  `<message>` element carries only its name. Declaring the key in the model (e.g. a
  `subscription`/FEEL-style binding) is deferred and recorded as a known divergence
  from canonical model-level correlation, not silently implied.
- **FR-014**: The runtime MUST enforce at most one active eligible subscription
  for a given `messageName + correlationKey` within a project/workspace.
- **FR-015**: External messages MUST include `messageName`, `correlationKey`,
  `messageId`, and payload.
- **FR-016**: External messages MUST correlate by `messageName + correlationKey`
  and deduplicate by `messageId` scoped to that pair.
- **FR-017**: If no matching Receive Task is waiting, the runtime MUST buffer the
  message for a fixed default TTL of one hour.
- **FR-018**: Publishing the same `messageId` again for the same
  `messageName + correlationKey` MUST return the same response as the original
  publish attempt.
- **FR-019**: Public message publish outcomes MUST include `correlated`,
  `buffered`, and `duplicate`.
- **FR-020**: Late, expired, rejected, duplicate, and invariant-violation message
  outcomes MUST be recorded in history even when they are not exposed as public
  success outcomes.
- **FR-021**: When a matching message correlates, the runtime MUST apply the
  message payload as variables atomically with the transition that advances the
  instance.
- **FR-022**: Operators MUST be able to inspect instance status, current BPMN
  element, variables, and execution history.
- **FR-023**: Execution history MUST include business timeline events and
  technical diagnostics for worker attempts, worker results, retry counts,
  request or correlation identifiers, duplicate handling, message outcomes, and
  raw payload snapshots.
- **FR-024**: Errors and incidents MUST show what happened, which BPMN element
  was involved, relevant payload context, and the next available action or
  boundary.
- **FR-025**: MVP operator incident handling MUST be view-only; retry,
  resolution, manual completion, and business recovery actions are outside this
  feature.
- **FR-026**: The feature MUST NOT include built-in tasklists, BPMN User Task,
  forms, assignment, gateways, timers, boundary events, subprocesses,
  multi-instance, compensation, process migration, full Camunda/Zeebe
  compatibility, visual BPMN modeling, or advanced operations UI.

### Key Entities *(include if feature involves data)*

- **Process Definition Draft**: Editable BPMN XML and associated validation
  status before publish.
- **Process Definition Version**: Immutable executable snapshot created from a
  valid draft; referenced by every process instance.
- **Process Instance**: One execution of a published definition version, with
  status, current BPMN element, variables, and history.
- **BPMN Element**: Supported process step within the MVP profile, including
  Start Event, Service Task, Receive Task, End Event, Sequence Flow, and Message.
- **Service Task Job**: Durable execution state created when an instance reaches
  a Service Task; tracks attempts, retries, completion, and failure.
- **Worker Attempt**: One delivery of a Service Task job to a worker, with result
  or failure details.
- **Message Subscription**: Durable wait state created by a Receive Task for a
  specific message name and correlation key.
- **External Message**: Business event submitted by an external system with
  message name, correlation key, message id, payload, and publish outcome.
- **Variables**: Process data supplied at start, produced by Service Task
  workers, and applied from external message payloads.
- **History Event**: Business timeline or technical diagnostic entry attached to
  a process instance or external message.
- **Incident**: View-only failed execution state for a BPMN element after
  retries or validation of runtime behavior reaches a terminal problem.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new backend or platform developer can complete the full demo
  flow in under 10 minutes without deploying a workflow cluster, broker, BPMN
  engine, or custom worker.
- **SC-002**: 100% of publish attempts containing unsupported BPMN elements are
  rejected before any executable version is created, with at least one specific
  unsupported element reason shown to the user.
- **SC-003**: Every started process instance can be traced to exactly one
  immutable published definition version in inspection output and history.
- **SC-004**: In duplicate worker callback and duplicate message publish tests,
  the process advances no more than once and variables are not duplicated or
  corrupted.
- **SC-005**: An early external message published within the fixed default TTL
  correlates when the matching Receive Task becomes eligible, and a repeat of
  that publish returns the original response.
- **SC-006**: A Service Task failure scenario records each retry attempt and
  creates an incident-style state with element, reason, retry count, and payload
  context after retries are exhausted.
- **SC-007**: Instance inspection after completion shows start, Service Task
  result, Receive Task wait, message correlation, completion, variables, and raw
  payload snapshots.

## Assumptions

- The primary MVP user is a backend or platform developer evaluating BPMN
  execution without operating a Camunda/Zeebe-style workflow stack.
- The first process shape is intentionally linear to prove the full lifecycle,
  not to demonstrate broad BPMN feature coverage.
- Human work happens in external systems such as admin tools, CRM systems, bots,
  or back-office applications. easy-bpmn receives the fact of that work as a
  message rather than managing human assignments.
- The sample worker is a demo aid, not a production worker starter or reference
  implementation.
- The exact visual presentation of upload, publish, start, message publish, and
  inspection can be minimal as long as the developer can complete and verify the
  demo flow.
- The one-hour early-message TTL is a fixed MVP default chosen to make the
  behavior testable; configurability is out of scope.
- Full raw payload storage is acceptable for the MVP to maximize visibility;
  redaction, masking, and retention configuration are future hardening work.
- Project/workspace tenancy is assumed for uniqueness of active subscriptions;
  cross-tenant or cross-workspace correlation is out of scope.
