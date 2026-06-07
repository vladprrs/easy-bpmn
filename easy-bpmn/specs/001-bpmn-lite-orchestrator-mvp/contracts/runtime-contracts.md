# Runtime Contracts: BPMN-lite Orchestrator MVP

## Process Workflow Contract

Each BPMN process instance maps to exactly one Cloudflare Workflow instance.

### Workflow create params

```json
{
  "workspaceId": "default",
  "instanceId": "pi_123",
  "definitionVersionId": "pdv_001",
  "correlationKey": "order-123",
  "initialVariables": {
    "amount": 42
  }
}
```

**Rules**:
- `instanceId` is the product process instance identifier.
- `workflowInstanceId` is stored in D1 and never required from external business message publishers.
- The Workflow reads immutable definition metadata by `definitionVersionId`.
- Workflow state is not the canonical operator history. Every meaningful transition writes D1 history.

## Service Task Contract

The MVP includes a product-provided sample Service Task worker. Custom worker registration is outside the MVP, but the runtime contract should be shaped so future workers can use the same semantics.

### Worker request

```json
{
  "jobId": "job_123",
  "instanceId": "pi_123",
  "definitionVersionId": "pdv_001",
  "taskType": "external-check",
  "elementId": "run_external_check",
  "attempt": 1,
  "variables": {
    "amount": 42
  }
}
```

`taskType` is the stable worker routing key, read from the Service Task's
`<bpmn:extensionElements>` under the `easy-bpmn` namespace. Workers are dispatched by
`taskType`; `elementId` is included for audit/inspection only and is never the routing
key (tool-generated ids change when a task is re-drawn).

### Worker success

```json
{
  "jobId": "job_123",
  "status": "completed",
  "outputVariables": {
    "checkStatus": "approved"
  }
}
```

### Worker failure

```json
{
  "jobId": "job_123",
  "status": "failed",
  "reason": "sample worker forced failure",
  "diagnostics": {
    "attempt": 1
  }
}
```

**Rules**:
- Job state is persisted before worker execution begins.
- `step.do` retry configuration and `taskType` are derived from the Service Task's standard `<extensionElements>` under the `easy-bpmn` namespace — additive, ignorable, and introducing no custom notation.
- Every attempt writes a `WorkerAttempt` and `HistoryEvent`.
- Duplicate completion or failure callbacks reuse the original result and never advance the instance twice.
- Worker output variables are persisted before the instance advances to the next BPMN element.
- Exhausted retries create a view-only `Incident`.

## Receive Task and Workflow Event Contract

When the Workflow reaches a Receive Task, it registers a subscription with the broker before waiting for the event.

### Broker registration request

```json
{
  "workspaceId": "default",
  "instanceId": "pi_123",
  "workflowInstanceId": "wf_pi_123",
  "elementId": "wait_for_approval",
  "messageName": "ApprovalReceived",
  "correlationKey": "order-123",
  "workflowEventType": "bpmn.message.ApprovalReceived",
  "expiresAt": "2026-06-07T22:00:00Z"
}
```

### Workflow event payload

```json
{
  "externalMessageId": "msg_123",
  "messageName": "ApprovalReceived",
  "correlationKey": "order-123",
  "messageId": "approval-001",
  "payload": {
    "approved": true,
    "approvedBy": "admin"
  }
}
```

**Rules**:
- The broker key is `workspaceId + messageName + correlationKey`.
- The `correlationKey` is supplied via the API at instance start (MVP); it is not derived from a model-level subscription expression, and the `<message>` element carries only its name. This is a recorded divergence from canonical model-level correlation, not an implied behavior.
- At most one active subscription may exist per broker key.
- If a buffered message already exists, registration consumes it and the Workflow should continue without waiting.
- Otherwise, the Workflow waits with `step.waitForEvent` using the registered `workflowEventType` and one-hour timeout.
- Message payload variables are applied atomically with the transition out of Receive Task.

## Correlation Broker Contract

The Durable Object broker owns deterministic behavior for a single broker key.

### RPC methods

```text
registerSubscription(request) -> RegisterSubscriptionResult
publishMessage(request) -> PublishMessageResult
expireBufferedMessages(now) -> ExpireResult
getState() -> BrokerInspection
```

### Public outcomes

```text
correlated
buffered
duplicate
rejected
```

### Internal/history outcomes

```text
expired
late
invariantViolation
```

**Rules**:
- Duplicate scope is `workspaceId + messageName + correlationKey + messageId`.
- A duplicate publish returns the original public response.
- Early messages are buffered for one hour.
- A different `messageId` after an instance already advanced is recorded as `late` or `rejected`.
- A second active subscription for the same broker key is rejected as an invariant violation and recorded in history.

## D1 Persistence Contract

D1 is the source of record for:

- BPMN drafts and validation issues
- Immutable definition versions and parsed profile metadata
- Process instances and Workflow bindings
- Variables and variable snapshots
- Service Task jobs and worker attempts
- Message subscriptions and external messages
- History events and incidents
- Idempotency records

**Rules**:
- Product inspection endpoints read from D1, not directly from Workflow internals.
- Workflow status can be synchronized into D1 diagnostics but does not replace business status.
- History writes are part of the same logical transition as variable and status updates whenever the transition is user-visible.

## Payload Contract

**Rules**:
- MVP message and worker payload snapshots are stored in D1.
- Payloads delivered to Workflows must stay within the Cloudflare Workflows event payload limit.
- Oversized payloads return a user-visible rejection with the involved message or BPMN element.
- R2 references are reserved for future larger-payload support.
