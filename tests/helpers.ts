// Shared test helpers: HTTP client over the Worker (SELF) + BPMN fixtures.

import { SELF, env } from "cloudflare:test";
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
          // Technical failure → re-leasable retry (now parked behind backoff).
          await authedPost(`/jobs/${job.jobId}/fail`, token, { lockToken: job.lockToken, reason: result.reason, retryable: true });
        }
      }
    }
    // A retryable fail now PARKS the job behind an exponential backoff (TASK-23
    // §4.1: status='locked', lock_token=NULL, future lock_expires_at) instead of
    // re-leasing instantly. This driver is the test stand-in for elapsed
    // wall-clock, so fast-forward EVERY backoff-parked job of the polled task
    // types and keep draining (the design's "advance time" wrinkle).
    // Deliberately NO `lock_expires_at > now` filter: a job whose jitter expiry
    // falls between the activate read above and this UPDATE would be invisible
    // to BOTH (too far in the future to lease, already in the past to rewind),
    // making the drain exit early — the saga-operator flake. `status='locked'
    // AND lock_token IS NULL` is exactly the backoff-parked shape and never
    // matches a live lease; rewinding an already-lapsed park is harmless (it
    // just forces one more drain round).
    if (!didWork) {
      const ph = opts.taskTypes.map(() => "?").join(", ");
      const res = await env.DB.prepare(
        `UPDATE service_task_jobs SET lock_expires_at = '2000-01-01T00:00:00Z'
           WHERE status = 'locked' AND lock_token IS NULL
             AND task_type IN (${ph})`,
      )
        .bind(...opts.taskTypes)
        .run();
      if ((res.meta?.changes ?? 0) > 0) didWork = true; // re-drain the freed jobs
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

/** A 1-in/1-out exclusiveGateway — a pass-through needing no conditions.
 *  REJECTED through M1; ACCEPTED from TASK-33 (M2 conditional sagas). */
export const PASSTHROUGH_GATEWAY_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="G" />
    <bpmn:exclusiveGateway id="G" name="Choose"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="f2" sourceRef="G" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * Minimal model carrying one still-deferred gateway type (parallel/inclusive/
 * eventBased/complex) — must reject with element id + a milestone pointer.
 */
export function deferredGatewayBpmn(
  tag: "parallelGateway" | "inclusiveGateway" | "eventBasedGateway" | "complexGateway",
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="G" />
    <bpmn:${tag} id="G" name="Deferred"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:${tag}>
    <bpmn:sequenceFlow id="f2" sourceRef="G" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
}

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

/**
 * M2 conditional XOR (TASK-31 graph IR): split gateway with two FEEL-conditional
 * flows + a default, three branches, then a join gateway. The <bpmn:outgoing>
 * refs inside GW_split are deliberately listed in a DIFFERENT order than the
 * <sequenceFlow> elements appear, pinning the IR's document-order guarantee to
 * flowElements order (= condition evaluation order, M2 design §2 decision 5).
 * ACCEPTED (publishes) from TASK-33 — the M2 process-level accept fixture.
 */
export const XOR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_xor" targetNamespace="x">
  <bpmn:process id="P_xor" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f0" sourceRef="S" targetRef="GW_split" />
    <bpmn:exclusiveGateway id="GW_split" name="Route by amount" default="f_def">
      <bpmn:incoming>f0</bpmn:incoming>
      <bpmn:outgoing>f_def</bpmn:outgoing>
      <bpmn:outgoing>f_silver</bpmn:outgoing>
      <bpmn:outgoing>f_gold</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="f_gold" sourceRef="GW_split" targetRef="T_gold">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">amount &gt; 100</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_silver" sourceRef="GW_split" targetRef="T_silver">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">amount &gt; 10</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_def" sourceRef="GW_split" targetRef="T_basic" />
    <bpmn:serviceTask id="T_gold" name="Gold"><bpmn:extensionElements><easy-bpmn:taskDefinition type="gold-handler" /></bpmn:extensionElements><bpmn:incoming>f_gold</bpmn:incoming><bpmn:outgoing>f_g2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:serviceTask id="T_silver" name="Silver"><bpmn:extensionElements><easy-bpmn:taskDefinition type="silver-handler" /></bpmn:extensionElements><bpmn:incoming>f_silver</bpmn:incoming><bpmn:outgoing>f_s2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:serviceTask id="T_basic" name="Basic"><bpmn:extensionElements><easy-bpmn:taskDefinition type="basic-handler" /></bpmn:extensionElements><bpmn:incoming>f_def</bpmn:incoming><bpmn:outgoing>f_b2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f_g2" sourceRef="T_gold" targetRef="GW_join" />
    <bpmn:sequenceFlow id="f_s2" sourceRef="T_silver" targetRef="GW_join" />
    <bpmn:sequenceFlow id="f_b2" sourceRef="T_basic" targetRef="GW_join" />
    <bpmn:exclusiveGateway id="GW_join" name="Merge">
      <bpmn:incoming>f_g2</bpmn:incoming>
      <bpmn:incoming>f_s2</bpmn:incoming>
      <bpmn:incoming>f_b2</bpmn:incoming>
      <bpmn:outgoing>f_end</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="f_end" sourceRef="GW_join" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f_end</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/** XOR gateway INSIDE a <transaction> scope — the gateway node must carry the
 *  enclosing transaction's scopeId like every other scoped node. ACCEPTED
 *  (publishes) from TASK-33. */
export const XOR_IN_TX_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_xortx" targetNamespace="x">
  <bpmn:process id="P_xortx" isExecutable="true">
    <bpmn:startEvent id="PS"><bpmn:outgoing>g1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="g1" sourceRef="PS" targetRef="Tx" />
    <bpmn:transaction id="Tx" name="Scoped">
      <bpmn:startEvent id="TxS"><bpmn:outgoing>t1</bpmn:outgoing></bpmn:startEvent>
      <bpmn:sequenceFlow id="t1" sourceRef="TxS" targetRef="GW" />
      <bpmn:exclusiveGateway id="GW" default="t_b">
        <bpmn:incoming>t1</bpmn:incoming>
        <bpmn:outgoing>t_a</bpmn:outgoing>
        <bpmn:outgoing>t_b</bpmn:outgoing>
      </bpmn:exclusiveGateway>
      <bpmn:sequenceFlow id="t_a" sourceRef="GW" targetRef="A">
        <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">ok</bpmn:conditionExpression>
      </bpmn:sequenceFlow>
      <bpmn:sequenceFlow id="t_b" sourceRef="GW" targetRef="B" />
      <bpmn:serviceTask id="A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="a" /></bpmn:extensionElements><bpmn:incoming>t_a</bpmn:incoming><bpmn:outgoing>t2</bpmn:outgoing></bpmn:serviceTask>
      <bpmn:serviceTask id="B"><bpmn:extensionElements><easy-bpmn:taskDefinition type="b" /></bpmn:extensionElements><bpmn:incoming>t_b</bpmn:incoming><bpmn:outgoing>t3</bpmn:outgoing></bpmn:serviceTask>
      <bpmn:sequenceFlow id="t2" sourceRef="A" targetRef="TxE" />
      <bpmn:sequenceFlow id="t3" sourceRef="B" targetRef="TxE" />
      <bpmn:endEvent id="TxE"><bpmn:incoming>t2</bpmn:incoming><bpmn:incoming>t3</bpmn:incoming></bpmn:endEvent>
    </bpmn:transaction>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="PE" />
    <bpmn:endEvent id="PE"><bpmn:incoming>g2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * The M2 conditional-SAGA fixture: a full transaction saga (compensation pair +
 * error boundary + cancel wiring) whose forward path branches through an XOR
 * split (FEEL condition + default) and re-merges through an XOR join — all
 * INSIDE the transaction. The canonical accept fixture for TASK-33 (publishes)
 * and the round-trip (R3) conditional model.
 */
export const SAGA_XOR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
                  id="D_xorsaga" targetNamespace="http://easy-bpmn/example/payment-saga">
  <bpmn:error id="Err_pay" name="Payment failed" errorCode="PAY_FAILED"/>
  <bpmn:process id="PaymentSaga" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx_pay" name="Take payment">
      <bpmn:startEvent id="Tx_start"/>
      <bpmn:serviceTask id="reserveFunds" name="Reserve funds">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="reserve-funds" retries="3"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="reserveFunds_comp" attachedToRef="reserveFunds">
        <bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="releaseFunds" name="Release funds" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="release-funds" retries="5"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="a1" associationDirection="One" sourceRef="reserveFunds_comp" targetRef="releaseFunds"/>
      <bpmn:exclusiveGateway id="GW_method" name="Payment method?" default="f_wire">
        <bpmn:incoming>t2</bpmn:incoming>
        <bpmn:outgoing>f_card</bpmn:outgoing>
        <bpmn:outgoing>f_wire</bpmn:outgoing>
      </bpmn:exclusiveGateway>
      <bpmn:sequenceFlow id="f_card" sourceRef="GW_method" targetRef="payCard">
        <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">method = "card"</bpmn:conditionExpression>
      </bpmn:sequenceFlow>
      <bpmn:sequenceFlow id="f_wire" sourceRef="GW_method" targetRef="payWire"/>
      <bpmn:serviceTask id="payCard" name="Pay by card">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="pay-card" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="pay_err" attachedToRef="payCard">
        <bpmn:errorEventDefinition errorRef="Err_pay"/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="payWire" name="Pay by wire">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="pay-wire" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:exclusiveGateway id="GW_merge" name="Paid">
        <bpmn:incoming>t3</bpmn:incoming>
        <bpmn:incoming>t4</bpmn:incoming>
        <bpmn:outgoing>t5</bpmn:outgoing>
      </bpmn:exclusiveGateway>
      <bpmn:endEvent id="Tx_ok"/>
      <bpmn:endEvent id="Tx_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      <bpmn:sequenceFlow id="t1" sourceRef="Tx_start"     targetRef="reserveFunds"/>
      <bpmn:sequenceFlow id="t2" sourceRef="reserveFunds" targetRef="GW_method"/>
      <bpmn:sequenceFlow id="t3" sourceRef="payCard"      targetRef="GW_merge"/>
      <bpmn:sequenceFlow id="t4" sourceRef="payWire"      targetRef="GW_merge"/>
      <bpmn:sequenceFlow id="t5" sourceRef="GW_merge"     targetRef="Tx_ok"/>
      <bpmn:sequenceFlow id="fe" sourceRef="pay_err"      targetRef="Tx_cancel"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="Tx_cancelled" attachedToRef="Tx_pay">
      <bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:endEvent id="Done"/>
    <bpmn:endEvent id="Failed"/>
    <bpmn:sequenceFlow id="g1" sourceRef="Start"        targetRef="Tx_pay"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx_pay"       targetRef="Done"/>
    <bpmn:sequenceFlow id="g3" sourceRef="Tx_cancelled" targetRef="Failed"/>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * SAGA_XOR_BPMN minus the gateway's `default` attribute: BOTH outgoing flows
 * of GW_method carry conditions, so a payment method matching neither is the
 * canonical no-match Hazard fixture (terminal incident kind=noPath inside the
 * transaction; design §2 decision 5, §10.2). Derived from SAGA_XOR_BPMN by
 * string surgery so the two stay structurally in lockstep — tests must assert
 * it still PUBLISHES (a stale replace would silently fall back to the
 * default-carrying original).
 */
export const SAGA_XOR_NODEFAULT_BPMN = SAGA_XOR_BPMN.replace(' default="f_wire"', "").replace(
  '<bpmn:sequenceFlow id="f_wire" sourceRef="GW_method" targetRef="payWire"/>',
  `<bpmn:sequenceFlow id="f_wire" sourceRef="GW_method" targetRef="payWire">
        <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">method = "wire"</bpmn:conditionExpression>
      </bpmn:sequenceFlow>`,
);

/**
 * A cyclic token path through a mixed (2-in/2-out) XOR gateway with
 * FEEL-actionable variables. T_charge runs once, BEFORE the cycle; the
 * back-edge returns from T_switch to GW_retry (nothing "re-charges").
 * Legal from TASK-33 (cycles on the token path); reusable for TASK-32
 * (occurrence-counter rewalk) and TASK-35 (loop-guard shapes). The saga-loop
 * companion — a compensatable step inside a <transaction> inside the cycle —
 * is SAGA_LOOP_BPMN below (TASK-35 AC2 / TASK-36).
 */
export const LOOP_XOR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
                  id="D_loop" targetNamespace="x">
  <bpmn:process id="P_loop" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f0" sourceRef="S" targetRef="T_charge"/>
    <bpmn:serviceTask id="T_charge" name="Charge card">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="charge-card" retries="2"/></bpmn:extensionElements>
      <bpmn:incoming>f0</bpmn:incoming>
      <bpmn:outgoing>f1</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f1" sourceRef="T_charge" targetRef="GW_retry"/>
    <bpmn:exclusiveGateway id="GW_retry" name="Declined?" default="f_done">
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:incoming>f_back</bpmn:incoming>
      <bpmn:outgoing>f_retry</bpmn:outgoing>
      <bpmn:outgoing>f_done</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="f_retry" sourceRef="GW_retry" targetRef="T_switch">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">chargeResult = "declined" and attemptsLeft &gt; 0</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:serviceTask id="T_switch" name="Switch payment method">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="switch-payment-method" retries="2"/></bpmn:extensionElements>
      <bpmn:incoming>f_retry</bpmn:incoming>
      <bpmn:outgoing>f_back</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f_back" sourceRef="T_switch" targetRef="GW_retry"/>
    <bpmn:sequenceFlow id="f_done" sourceRef="GW_retry" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f_done</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * The owed saga-loop fixture (TASK-35 AC2; designed for TASK-36 reuse): a
 * compensatable step INSIDE a transaction INSIDE a cycle.
 *
 *   Tx_loop: Tx_start → reserveItem (compensation boundary → releaseItem)
 *            → GW_more ─ f_more (`more = true`) ──→ back to reserveItem
 *                      ├ f_spin (`spin = true`) ──→ back to GW_more (self-loop)
 *                      └ f_done (default) ────────→ finalize → Tx_ok
 *   finalize carries an error boundary (FINALIZE_FAILED) → Tx_cancel; the
 *   transaction carries a cancel boundary → Failed (SAGA_XOR_BPMN's wiring).
 *
 * Each `more = true` pass appends one occurrence-keyed ledger row for
 * reserveItem (TASK-36: N iterations compensated in reverse after a business
 * error on finalize). The `f_spin` SELF-LOOP is the loop-guard lever
 * (TASK-35): a worker output arming `spin = true` makes GW_more revisit
 * ITSELF — pure gateway visits, zero jobs — so an integration test trips the
 * real MAX_ELEMENT_OCCURRENCES cap inside the transaction in seconds. It is
 * inert (FEEL `spin = true` is false/null) unless a test sets `spin`.
 */
export const SAGA_LOOP_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
                  id="D_loopsaga" targetNamespace="http://easy-bpmn/example/loop-saga">
  <bpmn:error id="Err_finalize" name="Finalize failed" errorCode="FINALIZE_FAILED"/>
  <bpmn:process id="LoopSaga" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx_loop" name="Reserve items">
      <bpmn:startEvent id="Tx_start"/>
      <bpmn:serviceTask id="reserveItem" name="Reserve item">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="reserve-item" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="reserveItem_comp" attachedToRef="reserveItem">
        <bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="releaseItem" name="Release item" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="release-item" retries="5"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="a1" associationDirection="One" sourceRef="reserveItem_comp" targetRef="releaseItem"/>
      <bpmn:exclusiveGateway id="GW_more" name="More items?" default="f_done">
        <bpmn:incoming>t2</bpmn:incoming>
        <bpmn:incoming>f_spin</bpmn:incoming>
        <bpmn:outgoing>f_more</bpmn:outgoing>
        <bpmn:outgoing>f_spin</bpmn:outgoing>
        <bpmn:outgoing>f_done</bpmn:outgoing>
      </bpmn:exclusiveGateway>
      <bpmn:sequenceFlow id="f_more" sourceRef="GW_more" targetRef="reserveItem">
        <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">more = true</bpmn:conditionExpression>
      </bpmn:sequenceFlow>
      <bpmn:sequenceFlow id="f_spin" sourceRef="GW_more" targetRef="GW_more">
        <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">spin = true</bpmn:conditionExpression>
      </bpmn:sequenceFlow>
      <bpmn:sequenceFlow id="f_done" sourceRef="GW_more" targetRef="finalize"/>
      <bpmn:serviceTask id="finalize" name="Finalize order">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="finalize-order" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="finalize_err" attachedToRef="finalize">
        <bpmn:errorEventDefinition errorRef="Err_finalize"/></bpmn:boundaryEvent>
      <bpmn:endEvent id="Tx_ok"/>
      <bpmn:endEvent id="Tx_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      <bpmn:sequenceFlow id="t1" sourceRef="Tx_start"     targetRef="reserveItem"/>
      <bpmn:sequenceFlow id="t2" sourceRef="reserveItem"  targetRef="GW_more"/>
      <bpmn:sequenceFlow id="t3" sourceRef="finalize"     targetRef="Tx_ok"/>
      <bpmn:sequenceFlow id="fe" sourceRef="finalize_err" targetRef="Tx_cancel"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="Tx_cancelled" attachedToRef="Tx_loop">
      <bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:endEvent id="Done"/>
    <bpmn:endEvent id="Failed"/>
    <bpmn:sequenceFlow id="g1" sourceRef="Start"        targetRef="Tx_loop"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx_loop"      targetRef="Done"/>
    <bpmn:sequenceFlow id="g3" sourceRef="Tx_cancelled" targetRef="Failed"/>
  </bpmn:process>
</bpmn:definitions>`;

/** XOR model that ALSO carries ignorable content (foreign-namespace extension
 *  on the gateway + a task, documentation, Diagram Interchange) — must be
 *  accepted with the conditional IR intact (constitution tolerate-and-ignore). */
export const XOR_TOLERANT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
                  id="D_xortol" targetNamespace="x">
  <bpmn:process id="P_xortol" isExecutable="true">
    <bpmn:documentation>Conditional model carrying ignorable content.</bpmn:documentation>
    <bpmn:startEvent id="S"><bpmn:outgoing>f0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f0" sourceRef="S" targetRef="GW"/>
    <bpmn:exclusiveGateway id="GW" name="Route" default="f_b">
      <bpmn:extensionElements>
        <camunda:properties><camunda:property name="ignored" value="true"/></camunda:properties>
      </bpmn:extensionElements>
      <bpmn:incoming>f0</bpmn:incoming>
      <bpmn:outgoing>f_a</bpmn:outgoing>
      <bpmn:outgoing>f_b</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="f_a" sourceRef="GW" targetRef="TA">
      <bpmn:documentation>High-value branch.</bpmn:documentation>
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">amount &gt; 100</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_b" sourceRef="GW" targetRef="TB"/>
    <bpmn:serviceTask id="TA" name="A">
      <bpmn:extensionElements>
        <easy-bpmn:taskDefinition type="handler-a"/>
        <camunda:properties><camunda:property name="ignored" value="true"/></camunda:properties>
      </bpmn:extensionElements>
      <bpmn:incoming>f_a</bpmn:incoming><bpmn:outgoing>f_a2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="TB" name="B">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="handler-b"/></bpmn:extensionElements>
      <bpmn:incoming>f_b</bpmn:incoming><bpmn:outgoing>f_b2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f_a2" sourceRef="TA" targetRef="E"/>
    <bpmn:sequenceFlow id="f_b2" sourceRef="TB" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f_a2</bpmn:incoming><bpmn:incoming>f_b2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="D1">
    <bpmndi:BPMNPlane id="P1" bpmnElement="P_xortol">
      <bpmndi:BPMNShape id="GW_di" bpmnElement="GW" isMarkerVisible="true">
        <dc:Bounds x="300" y="100" width="50" height="50"/>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
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
