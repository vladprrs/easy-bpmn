import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, publishDraft } from "../helpers";

// M5-L3 (Task 3): publish-time composition of multiInstanceLoopCharacteristics
// with callActivity resolution (design §6). The pure validator (Task 2) cannot
// see the called child graph, so it seeds an MI-callActivity's bodyStepCost = 1;
// call resolution (call-resolution.ts) refines it to the child's step-generating
// node count once the callActivity is bound to its pinned child version. That
// refined per-iteration cost feeds the RUNTIME body-aware MI cardinality cap
// (min(MAX_MI_CARDINALITY, floor(STEP_BUDGET_SOFT / (bodyStepCost * 4)))). The
// L2 call-tree rejects (message wait anywhere in the tree, unresolved
// calledElement) still compose unchanged when MI is present.

function threeTaskChildBpmn(processId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_${processId}" targetNamespace="x">
  <bpmn:process id="${processId}" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="t1" />
    <bpmn:serviceTask id="t1"><bpmn:extensionElements><easy-bpmn:taskDefinition type="a"/></bpmn:extensionElements><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="t1" targetRef="t2" />
    <bpmn:serviceTask id="t2"><bpmn:extensionElements><easy-bpmn:taskDefinition type="b"/></bpmn:extensionElements><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="t2" targetRef="t3" />
    <bpmn:serviceTask id="t3"><bpmn:extensionElements><easy-bpmn:taskDefinition type="c"/></bpmn:extensionElements><bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f4" sourceRef="t3" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
}

function receiveWaitChildBpmn(processId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D_${processId}" targetNamespace="x">
  <bpmn:message id="M_${processId}" name="Msg_${processId}"/>
  <bpmn:process id="${processId}" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="wait" />
    <bpmn:receiveTask id="wait" messageRef="M_${processId}">
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:receiveTask>
    <bpmn:sequenceFlow id="f2" sourceRef="wait" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
}

function miCallerBpmn(processId: string, calledElement: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="D_${processId}" targetNamespace="x">
  <bpmn:process id="${processId}" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="call1" />
    <bpmn:callActivity id="call1" calledElement="${calledElement}">
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">3</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:callActivity>
    <bpmn:sequenceFlow id="f2" sourceRef="call1" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
}

interface Graph {
  nodes: Record<
    string,
    {
      type?: string;
      multiInstance?: { bodyStepCost?: number; loopCardinality?: string | null } | null;
      calledDefinitionVersionId?: string | null;
    }
  >;
}

async function getGraph(versionId: string): Promise<Graph> {
  const row = await env.DB.prepare(
    `SELECT parsed_profile FROM definition_versions WHERE definition_version_id = ?`,
  )
    .bind(versionId)
    .first<{ parsed_profile: string }>();
  return JSON.parse(row!.parsed_profile) as Graph;
}

describe("M5-L3 publish-time MI × callActivity composition (Task 3, design §6)", () => {
  it("refines MI-callActivity bodyStepCost from the resolved child graph (>= 3 over a 3-task child)", async () => {
    const childDraft = await createDraft(threeTaskChildBpmn("mi-ca-child"), "mi-ca-child");
    expect((await publishDraft(childDraft.body.draftId)).status).toBe(201);

    const parentDraft = await createDraft(miCallerBpmn("mi-ca-parent", "mi-ca-child"), "mi-ca-parent");
    const parentRes = await publishDraft(parentDraft.body.draftId);
    expect(parentRes.status).toBe(201);

    const graph = await getGraph(parentRes.body.definitionVersionId);
    const call = graph.nodes["call1"]!;
    expect(call.multiInstance).toBeTruthy();
    // Child has 3 serviceTasks + 1 endEvent = 4 step-generating nodes; validator
    // seeded 1, call resolution must have refined it up.
    expect(call.multiInstance!.bodyStepCost).toBeGreaterThanOrEqual(3);
  });

  it("still rejects an MI-callActivity whose child contains a receiveTask (L2 message-wait rule composes)", async () => {
    const childDraft = await createDraft(receiveWaitChildBpmn("mi-ca-msg-child"), "mi-ca-msg-child");
    expect((await publishDraft(childDraft.body.draftId)).status).toBe(201);

    const parentDraft = await createDraft(miCallerBpmn("mi-ca-msg-parent", "mi-ca-msg-child"), "mi-ca-msg-parent");
    const res = await publishDraft(parentDraft.body.draftId);
    expect(res.status).toBe(409);
    const issues = res.body.validationIssues as { elementId?: string; reason: string }[];
    expect(issues.some((i) => i.elementId === "call1" && /message wait/.test(i.reason))).toBe(true);
  });

  it("still rejects an MI-callActivity with an unresolved calledElement", async () => {
    const parentDraft = await createDraft(miCallerBpmn("mi-ca-unresolved", "nope-proc-xyz"), "mi-ca-unresolved");
    const res = await publishDraft(parentDraft.body.draftId);
    expect(res.status).toBe(409);
    const issues = res.body.validationIssues as { elementId?: string; reason: string }[];
    expect(issues.some((i) => i.elementId === "call1" && /nope-proc-xyz/.test(i.reason))).toBe(true);
  });
});

// M5-L3 (Task 13) — the matrix wave's publish-reject scenarios, driven through
// the REAL HTTP publish surface (the L2 CA-REJECT-* precedent: reject scenarios
// live in integration homes, not the pure-validator unit suite).

function miRejectBpmn(processId: string, activity: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_${processId}" targetNamespace="x">
  <bpmn:process id="${processId}" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    ${activity}
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
}

async function publishReject(bpmnXml: string, name: string): Promise<{ elementId?: string | null; reason: string }[]> {
  const draft = await createDraft(bpmnXml, name);
  expect(draft.status).toBe(201);
  const res = await publishDraft(draft.body.draftId);
  expect(res.status).toBeGreaterThanOrEqual(400);
  return (res.body?.validationIssues ?? []) as { elementId?: string | null; reason: string }[];
}

describe("M5-L3 MI publish rejects (matrix wave, Task 13)", () => {
  it("[MI-REJECT-DATABINDING-01] standard MI data bindings (loopDataInputRef) are permanently rejected", async () => {
    const issues = await publishReject(
      miRejectBpmn(
        "mi-rej-databinding",
        `<bpmn:serviceTask id="mi1" name="Fan">
          <bpmn:extensionElements><easy-bpmn:taskDefinition type="charge" retries="1"/></bpmn:extensionElements>
          <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
          <bpmn:multiInstanceLoopCharacteristics isSequential="false">
            <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">3</bpmn:loopCardinality>
            <bpmn:loopDataInputRef>someCollection</bpmn:loopDataInputRef>
          </bpmn:multiInstanceLoopCharacteristics>
        </bpmn:serviceTask>`,
      ),
      "mi-rej-databinding",
    );
    expect(issues.some((i) => i.elementId === "mi1" && /loopDataInputRef|data bindings/i.test(i.reason))).toBe(true);
  });

  it("[MI-REJECT-NOSOURCE-01] multiInstanceLoopCharacteristics with no recognized cardinality source rejects", async () => {
    const issues = await publishReject(
      miRejectBpmn(
        "mi-rej-nosource",
        `<bpmn:serviceTask id="mi1" name="Fan">
          <bpmn:extensionElements><easy-bpmn:taskDefinition type="charge" retries="1"/></bpmn:extensionElements>
          <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
          <bpmn:multiInstanceLoopCharacteristics/>
        </bpmn:serviceTask>`,
      ),
      "mi-rej-nosource",
    );
    expect(issues.some((i) => i.elementId === "mi1" && /no recognized cardinality source/i.test(i.reason))).toBe(true);
  });

  it("[MI-REJECT-BODY-01] a receiveTask inside an MI-subProcess body rejects (v1 body whitelist)", async () => {
    const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_rej_body" targetNamespace="x">
  <bpmn:message id="m_body" name="BodyMsg"/>
  <bpmn:process id="mi-rej-body" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:subProcess id="mi1" name="Wait each">
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">2</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
      <bpmn:startEvent id="Sb"><bpmn:outgoing>b1</bpmn:outgoing></bpmn:startEvent>
      <bpmn:sequenceFlow id="b1" sourceRef="Sb" targetRef="waitMsg"/>
      <bpmn:receiveTask id="waitMsg" name="Wait" messageRef="m_body">
        <bpmn:incoming>b1</bpmn:incoming><bpmn:outgoing>b2</bpmn:outgoing>
      </bpmn:receiveTask>
      <bpmn:sequenceFlow id="b2" sourceRef="waitMsg" targetRef="Eb"/>
      <bpmn:endEvent id="Eb"><bpmn:incoming>b2</bpmn:incoming></bpmn:endEvent>
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
    const issues = await publishReject(bpmn, "mi-rej-body");
    // The whitelist anchors the issue on the MI scope itself and names the
    // offending interior element in the reason text.
    expect(issues.some((i) => i.elementId === "mi1" && /waitMsg/.test(i.reason) && /multi-instance body/i.test(i.reason))).toBe(true);
  });
});
