// Shared test helpers: HTTP client over the Worker (SELF) + BPMN fixtures.

import { SELF } from "cloudflare:test";

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
