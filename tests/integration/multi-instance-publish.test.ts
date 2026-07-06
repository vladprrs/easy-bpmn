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
