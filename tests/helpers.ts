// Shared test helpers: HTTP client over the Worker (SELF) + BPMN fixtures.

import { SELF } from "cloudflare:test";
import { invokeSampleWorker } from "../src/runtime/service-task";

const BASE = "https://easy-bpmn.test";

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const res = await SELF.fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed as T };
}

export const post = <T = any>(path: string, body?: unknown) => api<T>("POST", path, body);
export const get = <T = any>(path: string) => api<T>("GET", path);

/** HTTP call carrying an `Authorization: Bearer <token>` header (pull workers). */
export async function authed<T = any>(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  const res = await SELF.fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed as T };
}

export const authedPost = <T = any>(path: string, token: string | null, body?: unknown) =>
  authed<T>("POST", path, token, body);

/** Mint a per-workspace worker credential; returns the (one-time) raw token. */
export async function mintWorkerToken(workspaceId = "default", label?: string): Promise<string> {
  const r = await post("/worker-credentials", { workspaceId, label });
  if (r.status !== 201) throw new Error(`mint failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token as string;
}

/**
 * Drives the built-in sample workers over the pull data plane until no leasable
 * forward job remains for the given task types — the test stand-in for remote
 * microservices. Completes successes, fails failures as technical-retryable so
 * re-lease drives the sample worker's failUntilAttempt / forceFail semantics; an
 * exhausted job lets the engine raise its incident. Returns the count of jobs run.
 */
export async function drainSampleWorkers(opts: {
  taskTypes: string[];
  workspaceId?: string;
  token?: string;
  maxRounds?: number;
}): Promise<number> {
  const workspaceId = opts.workspaceId ?? "default";
  const token = opts.token ?? (await mintWorkerToken(workspaceId));
  let rounds = opts.maxRounds ?? 50;
  let ran = 0;
  let didWork = true;
  while (didWork && rounds-- > 0) {
    didWork = false;
    for (const taskType of opts.taskTypes) {
      const r = await authedPost("/jobs/activate", token, { taskType, workerId: "sample-worker" });
      for (const job of (r.body.jobs ?? []) as any[]) {
        didWork = true;
        ran++;
        const result = await invokeSampleWorker({
          jobId: job.jobId,
          instanceId: job.instanceId,
          definitionVersionId: "",
          taskType: job.taskType,
          elementId: job.elementId,
          attempt: job.attempt,
          variables: job.variables,
        });
        if (result.status === "completed") {
          await authedPost(`/jobs/${job.jobId}/complete`, token, { lockToken: job.lockToken, outputVariables: result.outputVariables });
        } else if (result.errorCode) {
          // Business error → carries the model errorCode (not retryable).
          await authedPost(`/jobs/${job.jobId}/fail`, token, { lockToken: job.lockToken, reason: result.reason, errorCode: result.errorCode });
        } else {
          // Technical failure → re-leasable retry.
          await authedPost(`/jobs/${job.jobId}/fail`, token, { lockToken: job.lockToken, reason: result.reason, retryable: true });
        }
      }
    }
  }
  return ran;
}

export async function createDraft(bpmnXml: string, name = "demo", workspaceId = "default") {
  return post("/definitions/drafts", { workspaceId, name, bpmnXml });
}

export async function publishDraft(draftId: string) {
  return post(`/definitions/drafts/${draftId}/publish`);
}

export async function startInstance(
  versionId: string,
  opts: {
    workspaceId?: string;
    correlationKey: string;
    variables: Record<string, unknown>;
    businessKey?: string;
    idempotencyKey?: string;
  },
) {
  return post(`/definitions/versions/${versionId}/instances`, {
    workspaceId: "default",
    ...opts,
  });
}

export async function publishMessage(opts: {
  workspaceId?: string;
  messageName: string;
  correlationKey: string;
  messageId: string;
  payload: Record<string, unknown>;
}) {
  return post("/messages", { workspaceId: "default", ...opts });
}

/** Publish + start convenience; returns { versionId, instance }. */
export async function publishAndStart(
  bpmnXml: string,
  start: { correlationKey: string; variables: Record<string, unknown>; businessKey?: string },
) {
  const draft = await createDraft(bpmnXml);
  const version = await publishDraft(draft.body.draftId);
  const instance = await startInstance(version.body.definitionVersionId, start);
  return { versionId: version.body.definitionVersionId, draftId: draft.body.draftId, instance };
}

// ---------------------------------------------------------------------------
// BPMN fixtures
// ---------------------------------------------------------------------------

/** Canonical happy path: Start → Service Task → Receive Task → End. */
export const DEMO_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
    xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    id="Definitions_demo" targetNamespace="http://easy-bpmn/demo">
  <bpmn:message id="Msg_Approval" name="ApprovalReceived" />
  <bpmn:process id="Process_demo" name="Demo" isExecutable="true">
    <bpmn:startEvent id="Start_1" name="Start">
      <bpmn:outgoing>Flow_s_check</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="Flow_s_check" sourceRef="Start_1" targetRef="Task_check" />
    <bpmn:serviceTask id="Task_check" name="Run external check">
      <bpmn:extensionElements>
        <easy-bpmn:taskDefinition type="external-check" retries="3" />
      </bpmn:extensionElements>
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
</bpmn:definitions>`;

/** Profile-valid file that ALSO carries ignorable content: foreign-namespace
 *  extension, documentation, and Diagram Interchange. Must be accepted. */
export const TOLERANT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
    xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
    xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
    xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    id="Definitions_tol" targetNamespace="http://easy-bpmn/demo">
  <bpmn:message id="Msg_Approval" name="ApprovalReceived" />
  <bpmn:process id="Process_tol" name="Tolerant" isExecutable="true">
    <bpmn:documentation>Carries ignorable content.</bpmn:documentation>
    <bpmn:startEvent id="Start_1">
      <bpmn:outgoing>F1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="Start_1" targetRef="Task_check" />
    <bpmn:serviceTask id="Task_check" name="Check">
      <bpmn:extensionElements>
        <easy-bpmn:taskDefinition type="external-check" retries="2" />
        <camunda:properties>
          <camunda:property name="ignored" value="true" />
        </camunda:properties>
      </bpmn:extensionElements>
      <bpmn:incoming>F1</bpmn:incoming>
      <bpmn:outgoing>F2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="F2" sourceRef="Task_check" targetRef="Task_wait" />
    <bpmn:receiveTask id="Task_wait" messageRef="Msg_Approval">
      <bpmn:incoming>F2</bpmn:incoming>
      <bpmn:outgoing>F3</bpmn:outgoing>
    </bpmn:receiveTask>
    <bpmn:sequenceFlow id="F3" sourceRef="Task_wait" targetRef="End_1" />
    <bpmn:endEvent id="End_1">
      <bpmn:incoming>F3</bpmn:incoming>
    </bpmn:endEvent>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="D1">
    <bpmndi:BPMNPlane id="P1" bpmnElement="Process_tol">
      <bpmndi:BPMNShape id="Start_1_di" bpmnElement="Start_1">
        <dc:Bounds x="160" y="100" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

export const GATEWAY_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="G" />
    <bpmn:exclusiveGateway id="G" name="Choose"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="f2" sourceRef="G" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

export const USERTASK_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="U" />
    <bpmn:userTask id="U" name="Approve"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:userTask>
    <bpmn:sequenceFlow id="f2" sourceRef="U" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

export const TIMER_START_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S">
      <bpmn:timerEventDefinition id="t1"><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition>
      <bpmn:outgoing>f1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

export const NO_TASKTYPE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="T" />
    <bpmn:serviceTask id="T" name="Unbound"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="T" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

export const INSTANTIATE_RECEIVE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D" targetNamespace="x">
  <bpmn:message id="M" name="Go" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:receiveTask id="R" messageRef="M" instantiate="true"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:receiveTask>
    <bpmn:sequenceFlow id="f1" sourceRef="R" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

export const CONDITIONAL_FLOW_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="T">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">\${amount &gt; 1}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:serviceTask id="T"><bpmn:extensionElements><easy-bpmn:taskDefinition type="x" /></bpmn:extensionElements><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="T" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

export const MALFORMED_XML = `<bpmn:definitions><bpmn:process id="P"></bpmn:definitions>`;

/** A Service Task carrying multi-instance loop characteristics — out of profile. */
export const MULTI_INSTANCE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="T" />
    <bpmn:serviceTask id="T" name="Fan out">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="external-check" /></bpmn:extensionElements>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false" />
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="T" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/** A Receive Task referencing a <message> with no name — not correlatable. */
export const EMPTY_MESSAGE_NAME_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D" targetNamespace="x">
  <bpmn:message id="M" name="" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="R" />
    <bpmn:receiveTask id="R" name="Wait" messageRef="M"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:receiveTask>
    <bpmn:sequenceFlow id="f2" sourceRef="R" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/** A subprocess — an unsupported standard-namespace flow node. */
export const SUBPROCESS_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="SP" />
    <bpmn:subProcess id="SP" name="Inner"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:subProcess>
    <bpmn:sequenceFlow id="f2" sourceRef="SP" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/** A Send Task — a standard task type outside the profile. */
export const SEND_TASK_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="T" />
    <bpmn:sendTask id="T" name="Notify"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:sendTask>
    <bpmn:sequenceFlow id="f2" sourceRef="T" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/** An intermediate catch (timer) event — out of profile. */
export const INTERMEDIATE_CATCH_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="IC" />
    <bpmn:intermediateCatchEvent id="IC" name="Wait 5m">
      <bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:intermediateCatchEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="IC" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/** A call activity — composition is deferred to M5; must be rejected. */
export const CALL_ACTIVITY_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="CA" />
    <bpmn:callActivity id="CA" name="Reuse" calledElement="Sub"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:callActivity>
    <bpmn:sequenceFlow id="f2" sourceRef="CA" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// SAGA fixtures (canonical BPMN transaction-saga — SAGA design §3)
// ---------------------------------------------------------------------------

/** The §3 canonical order-saga example. The single canonical accept fixture. */
export const SAGA_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
                  id="Definitions_order_saga" targetNamespace="http://easy-bpmn/example/order-saga">
  <bpmn:error id="Err_shipping" name="Shipping rejected" errorCode="SHIPPING_REJECTED"/>
  <bpmn:process id="OrderSaga" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx_order" name="Place order">
      <bpmn:startEvent id="Tx_start"/>
      <bpmn:serviceTask id="reserveStock" name="Reserve stock">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="reserve-stock" retries="3"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="reserveStock_comp" attachedToRef="reserveStock">
        <bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="releaseStock" name="Release stock" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="release-stock" retries="5"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="a1" associationDirection="One" sourceRef="reserveStock_comp" targetRef="releaseStock"/>
      <bpmn:serviceTask id="chargeCard" name="Charge card">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="charge-card" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="chargeCard_comp" attachedToRef="chargeCard">
        <bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="refundCard" name="Refund card" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="refund-card" retries="5"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="a2" associationDirection="One" sourceRef="chargeCard_comp" targetRef="refundCard"/>
      <bpmn:serviceTask id="confirmShipping" name="Confirm shipping">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="confirm-shipping" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="shipping_err" attachedToRef="confirmShipping">
        <bpmn:errorEventDefinition errorRef="Err_shipping"/></bpmn:boundaryEvent>
      <bpmn:endEvent id="Tx_ok"/>
      <bpmn:endEvent id="Tx_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      <bpmn:sequenceFlow id="f1" sourceRef="Tx_start"        targetRef="reserveStock"/>
      <bpmn:sequenceFlow id="f2" sourceRef="reserveStock"    targetRef="chargeCard"/>
      <bpmn:sequenceFlow id="f3" sourceRef="chargeCard"      targetRef="confirmShipping"/>
      <bpmn:sequenceFlow id="f4" sourceRef="confirmShipping" targetRef="Tx_ok"/>
      <bpmn:sequenceFlow id="f5" sourceRef="shipping_err"    targetRef="Tx_cancel"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="Tx_cancelled" attachedToRef="Tx_order">
      <bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:endEvent id="SagaFailed"/>
    <bpmn:endEvent id="SagaDone"/>
    <bpmn:sequenceFlow id="g1" sourceRef="Start"        targetRef="Tx_order"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx_order"     targetRef="SagaDone"/>
    <bpmn:sequenceFlow id="g3" sourceRef="Tx_cancelled" targetRef="SagaFailed"/>
  </bpmn:process>
</bpmn:definitions>`;

/** §3 example augmented with foreign-namespace extensions, DI, and documentation. */
export const SAGA_TOLERANT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
                  id="Definitions_order_saga_tol" targetNamespace="http://easy-bpmn/example/order-saga">
  <bpmn:error id="Err_shipping" name="Shipping rejected" errorCode="SHIPPING_REJECTED"/>
  <bpmn:process id="OrderSaga" isExecutable="true">
    <bpmn:documentation>Order saga with ignorable content.</bpmn:documentation>
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx_order" name="Place order">
      <bpmn:startEvent id="Tx_start"/>
      <bpmn:serviceTask id="reserveStock" name="Reserve stock">
        <bpmn:extensionElements>
          <easy-bpmn:taskDefinition type="reserve-stock" retries="3"/>
          <camunda:properties><camunda:property name="ignored" value="true"/></camunda:properties>
        </bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="reserveStock_comp" attachedToRef="reserveStock">
        <bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="releaseStock" name="Release stock" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="release-stock" retries="5"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="a1" associationDirection="One" sourceRef="reserveStock_comp" targetRef="releaseStock"/>
      <bpmn:serviceTask id="confirmShipping" name="Confirm shipping">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="confirm-shipping" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="shipping_err" attachedToRef="confirmShipping">
        <bpmn:errorEventDefinition errorRef="Err_shipping"/></bpmn:boundaryEvent>
      <bpmn:endEvent id="Tx_ok"/>
      <bpmn:endEvent id="Tx_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      <bpmn:sequenceFlow id="f1" sourceRef="Tx_start"        targetRef="reserveStock"/>
      <bpmn:sequenceFlow id="f2" sourceRef="reserveStock"    targetRef="confirmShipping"/>
      <bpmn:sequenceFlow id="f4" sourceRef="confirmShipping" targetRef="Tx_ok"/>
      <bpmn:sequenceFlow id="f5" sourceRef="shipping_err"    targetRef="Tx_cancel"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="Tx_cancelled" attachedToRef="Tx_order">
      <bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:endEvent id="SagaFailed"/>
    <bpmn:endEvent id="SagaDone"/>
    <bpmn:sequenceFlow id="g1" sourceRef="Start"        targetRef="Tx_order"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx_order"     targetRef="SagaDone"/>
    <bpmn:sequenceFlow id="g3" sourceRef="Tx_cancelled" targetRef="SagaFailed"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="D1">
    <bpmndi:BPMNPlane id="P1" bpmnElement="OrderSaga">
      <bpmndi:BPMNShape id="Start_di" bpmnElement="Start">
        <dc:Bounds x="160" y="100" width="36" height="36"/>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

/**
 * Builds a minimal one-transaction saga, with injectable fragments so negative
 * variants mutate exactly one structural rule. Valid by default.
 */
export function sagaBpmn(o: {
  compBoundary?: string;
  assoc?: string;
  undoA?: string;
  errBoundary?: string;
  errBoundaryFlow?: string;
  rootError?: string;
  innerExtra?: string;
} = {}): string {
  const compBoundary = o.compBoundary ??
    `<bpmn:boundaryEvent id="stepA_comp" attachedToRef="stepA"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>`;
  const assoc = o.assoc ??
    `<bpmn:association id="a1" associationDirection="One" sourceRef="stepA_comp" targetRef="undoA"/>`;
  const undoA = o.undoA ??
    `<bpmn:serviceTask id="undoA" name="Undo A" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="undo-a" retries="5"/></bpmn:extensionElements></bpmn:serviceTask>`;
  const errBoundary = o.errBoundary ??
    `<bpmn:boundaryEvent id="stepB_err" attachedToRef="stepB"><bpmn:errorEventDefinition errorRef="Err_b"/></bpmn:boundaryEvent>`;
  const errBoundaryFlow = o.errBoundaryFlow ??
    `<bpmn:sequenceFlow id="fe" sourceRef="stepB_err" targetRef="Tx_cancel"/>`;
  const rootError = o.rootError ?? `<bpmn:error id="Err_b" name="B failed" errorCode="B_FAILED"/>`;
  const innerExtra = o.innerExtra ?? "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
                  id="D_minsaga" targetNamespace="x">
  ${rootError}
  <bpmn:process id="MinSaga" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx" name="Tx">
      <bpmn:startEvent id="Tx_start"/>
      <bpmn:serviceTask id="stepA" name="Step A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="step-a" retries="2"/></bpmn:extensionElements></bpmn:serviceTask>
      ${compBoundary}
      ${undoA}
      ${assoc}
      <bpmn:serviceTask id="stepB" name="Step B"><bpmn:extensionElements><easy-bpmn:taskDefinition type="step-b" retries="2"/></bpmn:extensionElements></bpmn:serviceTask>
      ${errBoundary}
      <bpmn:endEvent id="Tx_ok"/>
      <bpmn:endEvent id="Tx_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      <bpmn:sequenceFlow id="t1" sourceRef="Tx_start" targetRef="stepA"/>
      <bpmn:sequenceFlow id="t2" sourceRef="stepA" targetRef="stepB"/>
      <bpmn:sequenceFlow id="t3" sourceRef="stepB" targetRef="Tx_ok"/>
      ${errBoundaryFlow}
      ${innerExtra}
    </bpmn:transaction>
    <bpmn:boundaryEvent id="Tx_cancelled" attachedToRef="Tx"><bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:endEvent id="Done"/>
    <bpmn:endEvent id="Failed"/>
    <bpmn:sequenceFlow id="g1" sourceRef="Start" targetRef="Tx"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="Done"/>
    <bpmn:sequenceFlow id="g3" sourceRef="Tx_cancelled" targetRef="Failed"/>
  </bpmn:process>
</bpmn:definitions>`;
}

/** A cancel boundary attached to a service task (not a transaction) — rejected. */
export const SAGA_CANCEL_BOUNDARY_ON_TASK_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="svc"/>
    <bpmn:serviceTask id="svc"><bpmn:extensionElements><easy-bpmn:taskDefinition type="x"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:boundaryEvent id="bad_cancel" attachedToRef="svc"><bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="svc" targetRef="Done"/>
    <bpmn:sequenceFlow id="f3" sourceRef="bad_cancel" targetRef="Failed"/>
    <bpmn:endEvent id="Done"/>
    <bpmn:endEvent id="Failed"/>
  </bpmn:process>
</bpmn:definitions>`;

/** A cancel end event at process level (outside any transaction) — rejected. */
export const SAGA_CANCEL_END_OUTSIDE_TX_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="svc"/>
    <bpmn:serviceTask id="svc"><bpmn:extensionElements><easy-bpmn:taskDefinition type="x"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="svc" targetRef="ProcCancel"/>
    <bpmn:endEvent id="ProcCancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/** Compensation association crossing transaction scopes — rejected. */
export const SAGA_CROSS_SCOPE_ASSOC_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx1">
      <bpmn:startEvent id="Tx1_start"/>
      <bpmn:serviceTask id="a1step"><bpmn:extensionElements><easy-bpmn:taskDefinition type="a1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:boundaryEvent id="a1step_comp" attachedToRef="a1step"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:association id="cross" associationDirection="One" sourceRef="a1step_comp" targetRef="h2"/>
      <bpmn:endEvent id="Tx1_ok"/>
      <bpmn:sequenceFlow id="x1" sourceRef="Tx1_start" targetRef="a1step"/>
      <bpmn:sequenceFlow id="x2" sourceRef="a1step" targetRef="Tx1_ok"/>
    </bpmn:transaction>
    <bpmn:transaction id="Tx2">
      <bpmn:startEvent id="Tx2_start"/>
      <bpmn:serviceTask id="a2step"><bpmn:extensionElements><easy-bpmn:taskDefinition type="a2"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:serviceTask id="h2" name="Handler in Tx2" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="h2"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:endEvent id="Tx2_ok"/>
      <bpmn:sequenceFlow id="y1" sourceRef="Tx2_start" targetRef="a2step"/>
      <bpmn:sequenceFlow id="y2" sourceRef="a2step" targetRef="Tx2_ok"/>
    </bpmn:transaction>
    <bpmn:endEvent id="Done"/>
    <bpmn:sequenceFlow id="g1" sourceRef="Start" targetRef="Tx1"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx1" targetRef="Tx2"/>
    <bpmn:sequenceFlow id="g3" sourceRef="Tx2" targetRef="Done"/>
  </bpmn:process>
</bpmn:definitions>`;
