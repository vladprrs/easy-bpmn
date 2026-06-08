# Data Model: BPMN-lite Orchestrator MVP

## Entity: Workspace

Represents the project/workspace scope used for deterministic correlation uniqueness.

**Fields**:
- `workspaceId`: Stable identifier. MVP may use a default workspace.
- `name`: Display name.
- `createdAt`: Creation timestamp.

**Relationships**:
- Owns process definitions, process instances, broker keys, messages, and history.

**Validation Rules**:
- Every definition, instance, subscription, and message is scoped to exactly one workspace.

## Entity: Process Definition Draft

Editable BPMN XML before publish.

**Fields**:
- `draftId`: Unique draft identifier.
- `workspaceId`: Owning workspace.
- `name`: User-visible process name.
- `bpmnXml`: Raw BPMN XML.
- `status`: `draft`, `valid`, or `invalid`.
- `validationIssues`: Array of `ValidationIssue` records.
- `latestPublishedVersionId`: Optional pointer to the latest published version from this draft.
- `createdAt`, `updatedAt`: Timestamps.

**Relationships**:
- May produce many `ProcessDefinitionVersion` records.

**Validation Rules**:
- XML must parse as namespace-aware BPMN 2.0 (matched by `{MODEL-ns}localName`, not
  by prefix) before validation can complete.
- Unsupported standard-namespace flow nodes/constructs are recorded as validation
  issues and block publish; they are never silently skipped.
- Foreign-namespace `<extensionElements>`, Diagram Interchange, and `documentation`
  are tolerated and ignored, never a reason to reject.
- An accepted draft remains valid against the BPMN 2.0 XSD and round-trips through a
  standard modeler when easy-bpmn extensions and DI are ignored.
- Draft edits never mutate an existing published version.

## Entity: Validation Issue

Element-level validation problem for BPMN XML.

**Fields**:
- `issueId`: Unique issue identifier.
- `draftId`: Associated draft.
- `severity`: `error` or `warning`; MVP publish-blocking issues are `error`.
- `elementId`: BPMN element ID when available.
- `elementName`: BPMN element type or XML name.
- `location`: XPath-like or parser location string when available.
- `reason`: User-visible reason.

**Validation Rules**:
- Publish requires zero `error` issues.

## Entity: Process Definition Version

Immutable executable snapshot created from a valid draft.

**Fields**:
- `definitionVersionId`: Unique version identifier.
- `draftId`: Source draft.
- `workspaceId`: Owning workspace.
- `versionNumber`: Monotonic per draft.
- `bpmnXml`: Immutable XML snapshot.
- `bpmnXmlHash`: Content hash for audit.
- `parsedProfile`: Supported BPMN-lite execution graph.
- `status`: `published`.
- `publishedAt`: Publish timestamp.

**Relationships**:
- Has many `BPMNElement` records.
- Has many `ProcessInstance` records.

**Validation Rules**:
- Immutable after creation.
- Must contain exactly one supported Start Event and at least one End Event.
- MVP execution graph must be a deterministic supported path using only the allowed profile.

## Entity: BPMN Element

Supported BPMN element extracted from a published definition.

**Fields**:
- `elementId`: BPMN XML ID (tool-generated; used for audit/inspection, NOT for worker routing).
- `definitionVersionId`: Owning definition version.
- `type`: `startEvent`, `serviceTask`, `receiveTask`, `endEvent`, `sequenceFlow`, or `message`.
- `name`: Optional display name.
- `taskType`: For Service Tasks, the stable author-defined worker routing key read
  from `<bpmn:extensionElements>` under the `easy-bpmn` namespace. This — not
  `elementId`/`name` — is the worker handle.
- `messageName`: For Receive Tasks, the resolved name of the referenced `<message>`.
- `metadata`: Other BPMN-compatible extension metadata, including Service Task retry
  policy, carried only in standard `<extensionElements>`.

**Relationships**:
- Connected through `SequenceFlow` records in `parsedProfile`.
- Referenced by jobs, subscriptions, history events, and incidents.

**Validation Rules**:
- No custom notation: no new MODEL-namespace tags/attributes, no redefinition of a
  standard element's runtime meaning, and no non-standard attribute required to parse.
- Service Task worker binding and retry metadata must live in standard
  `<extensionElements>` under the `easy-bpmn` namespace — additive and ignorable.
- `taskType` is required for a Service Task; routing by `elementId` or `name` is not allowed.

## Entity: Process Instance

One execution of a published definition version.

**Fields**:
- `instanceId`: Unique process instance identifier.
- `workspaceId`: Owning workspace.
- `definitionVersionId`: Immutable version binding.
- `workflowInstanceId`: Cloudflare Workflow instance ID.
- `businessKey`: Optional user-supplied business identifier.
- `correlationKey`: Required key used by Receive Task subscriptions. Supplied via the
  API at instance start in the MVP (not derived from a model-level subscription
  expression); see the correlation-key decision in research.md.
- `status`: `starting`, `running`, `waiting`, `completed`, or `incident`.
- `currentElementId`: Current BPMN element when not completed.
- `variables`: Current variable map.
- `startedAt`, `updatedAt`, `completedAt`: Timestamps.

**Relationships**:
- Has one `Workflow Instance Binding`.
- Has many `ServiceTaskJob`, `MessageSubscription`, `HistoryEvent`, and `Incident` records.

**Validation Rules**:
- Must start from a published definition version.
- Must remain bound to one definition version for its lifetime.
- Variables are updated atomically with element transitions that depend on worker or message payloads.

**State Transitions**:
- `starting` -> `running` when Workflow starts execution.
- `running` -> `waiting` when Receive Task subscription is active.
- `waiting` -> `running` when a matching message is correlated and variables are applied.
- `running` -> `completed` when End Event is reached.
- `running` or `waiting` -> `incident` when a terminal runtime problem occurs.

## Entity: Workflow Instance Binding

Bridge between product process instances and Cloudflare Workflow runtime instances.

**Fields**:
- `instanceId`: Process instance identifier.
- `workflowInstanceId`: Cloudflare Workflow instance identifier.
- `workflowStatus`: Last observed Workflow status.
- `createdAt`, `lastSyncedAt`: Timestamps.

**Validation Rules**:
- Exactly one binding per process instance.
- Workflow instance ID must not be required from external message publishers.

## Entity: Service Task Job

Durable Service Task execution state.

**Fields**:
- `jobId`: Unique job identifier.
- `instanceId`: Owning process instance.
- `elementId`: Service Task BPMN element (for audit/inspection).
- `taskType`: Stable worker routing key resolved from the element's `easy-bpmn`
  extension metadata; the worker is dispatched by this, not by `elementId`.
- `status`: `created`, `running`, `completed`, or `failed`.
- `retryLimit`: Maximum attempts from the Service Task's `easy-bpmn` extension metadata.
- `attemptCount`: Number of attempts recorded.
- `idempotencyKey`: Stable key for completion/failure callbacks.
- `inputVariablesSnapshot`: Variables delivered to the worker.
- `outputVariables`: Worker output after completion.
- `createdAt`, `updatedAt`, `completedAt`: Timestamps.

**Relationships**:
- Has many `WorkerAttempt` records.

**Validation Rules**:
- Job state is persisted before worker execution begins.
- Completion persists output variables before the process advances.
- Duplicate callbacks for the same idempotency key must not advance the process twice.

## Entity: Worker Attempt

One attempt to execute a Service Task job.

**Fields**:
- `attemptId`: Unique attempt identifier.
- `jobId`: Associated job.
- `attemptNumber`: 1-based attempt count.
- `workflowStepName`: Workflow step label.
- `status`: `started`, `succeeded`, or `failed`.
- `requestPayloadSnapshot`: Raw worker request payload.
- `responsePayloadSnapshot`: Raw worker response payload when available.
- `error`: Failure reason when available.
- `startedAt`, `finishedAt`: Timestamps.

**Validation Rules**:
- Retry count and attempt number must be visible in history.
- Final failed attempt creates an incident-style state.

## Entity: Message Subscription

Durable Receive Task wait state.

**Fields**:
- `subscriptionId`: Unique subscription identifier.
- `workspaceId`: Owning workspace.
- `instanceId`: Waiting process instance.
- `elementId`: Receive Task BPMN element.
- `messageName`: Expected message name.
- `correlationKey`: Expected correlation key.
- `brokerKey`: Derived `workspaceId + messageName + correlationKey`.
- `workflowEventType`: Workflow event type used by `waitForEvent`.
- `status`: `active`, `consumed`, `expired`, or `cancelled`.
- `createdAt`, `expiresAt`, `consumedAt`: Timestamps.

**Relationships**:
- Consumes zero or one `ExternalMessage`.

**Validation Rules**:
- At most one `active` subscription may exist per broker key.
- Registration checks for an existing buffered message before waiting.

## Entity: External Message

Business event submitted by an external system.

**Fields**:
- `externalMessageId`: Internal unique identifier.
- `workspaceId`: Owning workspace.
- `messageName`: Message name supplied by caller.
- `correlationKey`: Correlation key supplied by caller.
- `messageId`: Caller-supplied deduplication ID.
- `payload`: Message payload.
- `payloadHash`: Hash for diagnostics.
- `outcome`: `correlated`, `buffered`, `duplicate`, `expired`, `late`, `rejected`, or `invariantViolation`.
- `originalResponse`: Stable response returned for duplicate publishes.
- `matchedInstanceId`: Instance ID when correlated.
- `matchedSubscriptionId`: Subscription ID when correlated.
- `receivedAt`, `expiresAt`, `correlatedAt`: Timestamps.

**Relationships**:
- May correlate to one subscription.
- Produces history events.

**Validation Rules**:
- Public publish request must include `messageName`, `correlationKey`, `messageId`, and `payload`.
- Deduplication scope is `workspaceId + messageName + correlationKey + messageId`.
- Duplicate publish returns the original response and creates no duplicate transition.
- Early messages are buffered for one hour.

## Entity: Variable Snapshot

Current or historical process variable state.

**Fields**:
- `snapshotId`: Unique identifier.
- `instanceId`: Owning instance.
- `source`: `start`, `serviceTask`, or `message`.
- `sourceId`: Job, attempt, message, or API request identifier.
- `variables`: JSON object.
- `createdAt`: Timestamp.

**Validation Rules**:
- Message payload variables are applied atomically with the transition out of Receive Task.
- Worker output variables are persisted before transition out of Service Task.

## Entity: History Event

Operator-visible audit and diagnostic event.

**Fields**:
- `historyEventId`: Unique identifier.
- `workspaceId`: Owning workspace.
- `instanceId`: Optional process instance.
- `externalMessageId`: Optional external message.
- `elementId`: Optional BPMN element.
- `type`: Event category such as `definitionPublished`, `instanceStarted`, `elementEntered`, `workerAttemptStarted`, `workerAttemptSucceeded`, `workerAttemptFailed`, `messageBuffered`, `messageCorrelated`, `duplicateIgnored`, `incidentCreated`, or `instanceCompleted`.
- `businessTime`: Business timeline timestamp.
- `technicalTime`: Technical recording timestamp.
- `payloadSnapshot`: Raw or summarized payload snapshot.
- `diagnostics`: JSON object with request IDs, retry counts, correlation IDs, and reasons.

**Validation Rules**:
- Key transitions and duplicate handling must produce history events.
- Errors include what happened, which element was involved, and the available boundary/action.

## Entity: Incident

View-only terminal runtime problem for the MVP.

**Fields**:
- `incidentId`: Unique incident identifier.
- `instanceId`: Affected process instance.
- `elementId`: BPMN element involved.
- `reason`: User-visible reason.
- `status`: `open`.
- `retryCount`: Retry count at incident creation.
- `payloadContext`: Relevant raw payload snapshot or reference.
- `createdAt`: Timestamp.

**Validation Rules**:
- MVP does not expose retry, resolution, manual completion, or recovery actions.
- Incident inspection must explain that recovery actions are outside MVP operator scope.

## Entity: Idempotency Record

Stable record for at-least-once inputs.

**Fields**:
- `idempotencyKey`: Stable key.
- `scope`: `startInstance`, `workerCallback`, `messagePublish`, or `workflowEvent`.
- `result`: Stored response/result.
- `createdAt`: Timestamp.

**Validation Rules**:
- Repeated inputs in the same scope return or reuse the original result.
- Idempotency records must be written before externally visible duplicate-prone effects are considered complete.
