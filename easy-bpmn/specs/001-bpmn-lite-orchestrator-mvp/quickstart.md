# Quickstart: BPMN-lite Orchestrator MVP Validation

This guide describes the end-to-end validation scenarios for the MVP implementation plan. It is written as the target validation flow for the implementation generated from this feature.

## Prerequisites

- Node.js compatible with the selected TypeScript toolchain
- Wrangler installed through project dependencies
- Cloudflare local development support for Workers, Workflows, Durable Objects, and D1

## Setup

```bash
npm install
npx wrangler d1 migrations apply easy_bpmn --local
npm run test
npm run dev
```

Expected setup outcome:

- Unit, contract, and integration tests pass.
- Local Worker API is available at `http://localhost:8787`.
- Local D1 database has the MVP schema.
- Workflow and Durable Object bindings are available in local development.

## Scenario 1: Full Demo Flow

1. Upload a valid BPMN-lite XML draft.

```bash
curl -sS http://localhost:8787/definitions/drafts \
  -H 'Content-Type: application/json' \
  -d @examples/simple-approval-draft.json
```

The demo BPMN's Service Task declares its worker via a stable `taskType` carried in
standard `<bpmn:extensionElements>` under the `easy-bpmn` namespace (e.g.
`external-check`) — not via the element id or name. The file stays valid against the
BPMN 2.0 XSD and round-trips through a standard modeler when the easy-bpmn extension
and Diagram Interchange are ignored.

Expected outcome:

- Response status is `201`.
- Draft status is `valid`.
- `validationIssues` is empty.

2. Publish the draft.

```bash
curl -sS -X POST http://localhost:8787/definitions/drafts/{draftId}/publish
```

Expected outcome:

- Response status is `201`.
- A new immutable `definitionVersionId` is returned.
- Version output includes supported BPMN elements only.

3. Start an instance.

```bash
curl -sS http://localhost:8787/definitions/versions/{definitionVersionId}/instances \
  -H 'Content-Type: application/json' \
  -d '{
    "workspaceId": "default",
    "businessKey": "demo-approval-001",
    "correlationKey": "approval-001",
    "variables": {
      "amount": 42
    }
  }'
```

Expected outcome:

- Response status is `201`.
- Instance has exactly one `definitionVersionId`.
- Instance includes a `workflowInstanceId`.
- Instance status becomes `running` or `waiting` after the sample Service Task completes.

4. Publish the matching external message.

```bash
curl -sS http://localhost:8787/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "workspaceId": "default",
    "messageName": "ApprovalReceived",
    "correlationKey": "approval-001",
    "messageId": "approval-message-001",
    "payload": {
      "approved": true,
      "approvedBy": "demo-admin"
    }
  }'
```

Expected outcome:

- Response outcome is `correlated`.
- Response includes the matching `instanceId`.
- Instance advances exactly once.

5. Inspect the completed instance and history.

```bash
curl -sS http://localhost:8787/instances/{instanceId}
curl -sS http://localhost:8787/instances/{instanceId}/history
```

Expected outcome:

- Instance status is `completed`.
- Current/final BPMN element is visible.
- Variables include start variables, sample worker output, and message payload variables.
- History includes instance start, Service Task job creation, worker attempt/result, Receive Task wait, message correlation, completion, and raw payload snapshots.

## Scenario 2: Unsupported BPMN Rejection

Upload a BPMN draft containing an unsupported gateway, timer, subprocess, User Task, boundary event, or other out-of-scope element.

Expected outcome:

- Draft validation records element-level reasons.
- Publish returns `409`.
- No executable definition version is created.

Conversely, a draft that is inside the profile but also carries ignorable content —
foreign-namespace `<extensionElements>` (e.g. `camunda:`/`zeebe:`), Diagram
Interchange, or `documentation` — is accepted with `validationIssues` empty: the
ignorable content is not a rejection reason. Only standard-namespace flow nodes and
structures outside the profile are rejected.

## Scenario 3: Duplicate Message Publish

Publish the same `messageName + correlationKey + messageId` twice.

Expected outcome:

- First response is `correlated` or `buffered`.
- Second response is `duplicate`.
- Duplicate response references or reproduces the original response.
- Instance advances no more than once.
- History records duplicate handling.

## Scenario 4: Early Message Buffering

Publish a message before the instance reaches its Receive Task, then start or continue the matching instance.

Expected outcome:

- Initial message response is `buffered`.
- Message expires one hour after receipt if no matching subscription appears.
- If the matching Receive Task becomes eligible before expiry, the broker consumes the buffered message and the instance completes.
- Repeating the same message publish returns the original response.

## Scenario 5: Service Task Retry and Incident

Start an instance configured to force the sample worker to fail until retries are exhausted.

Expected outcome:

- Each worker attempt is recorded with attempt number and payload context.
- Instance remains at the Service Task while retries remain.
- Exhausted retries create an incident-style state at the Service Task element.
- Inspection shows element, reason, retry history, relevant payload snapshots, and a statement that recovery actions are outside the MVP operator view.

## Scenario 6: Immutable Version Binding

Publish a valid definition, start an instance, then edit the draft and publish another version.

Expected outcome:

- The running instance remains bound to the original `definitionVersionId`.
- New instances can start from the new version.
- History for the original instance references only its original published version.

## Validation Commands

```bash
npm run test:unit
npm run test:contract
npm run test:integration
npx wrangler deploy --dry-run
```

Expected validation outcome:

- BPMN validation contract rejects unsupported elements.
- Public API contract tests match `contracts/openapi.yaml`.
- Integration tests prove duplicate message publish and duplicate worker callback idempotency.
- End-to-end test completes the demo flow without external workflow infrastructure.
