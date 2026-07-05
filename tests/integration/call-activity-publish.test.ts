import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, publishDraft } from "../helpers";

// M5-L2 (Task 3): publish-time call-tree resolution (spec §7, Principle II).
// A callActivity's calledElement binds to ONE immutable child definition
// version at the CALLER's publish — resolved to the latest published version
// of the target processId in the same workspace, then the RESOLVED call tree
// (an immutable DAG: every stored child graph already carries its own
// resolved calledDefinitionVersionId) is walked to enforce MAX_CALL_DEPTH, a
// defensive cycle check, and a v1 reject of message waits anywhere in the
// tree (a callActivity child has no correlation-key source).

function trivialBpmn(processId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D_${processId}" targetNamespace="x">
  <bpmn:process id="${processId}" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
}

function callerBpmn(processId: string, calledElement: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D_${processId}" targetNamespace="x">
  <bpmn:process id="${processId}" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="call1" />
    <bpmn:callActivity id="call1" calledElement="${calledElement}">
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:callActivity>
    <bpmn:sequenceFlow id="f2" sourceRef="call1" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
}

function receiveWaitBpmn(processId: string): string {
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

function messageCatchBpmn(processId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D_${processId}" targetNamespace="x">
  <bpmn:message id="M_${processId}" name="Msg_${processId}"/>
  <bpmn:process id="${processId}" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="IC" />
    <bpmn:intermediateCatchEvent id="IC">
      <bpmn:messageEventDefinition messageRef="M_${processId}"/>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:intermediateCatchEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="IC" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
}

interface Graph {
  nodes: Record<string, { calledDefinitionVersionId?: string | null }>;
}

async function getGraph(versionId: string): Promise<Graph> {
  const row = await env.DB.prepare(
    `SELECT parsed_profile FROM definition_versions WHERE definition_version_id = ?`,
  )
    .bind(versionId)
    .first<{ parsed_profile: string }>();
  return JSON.parse(row!.parsed_profile) as Graph;
}

describe("M5-L2 publish-time call-tree resolution (spec §7)", () => {
  it("[1 Happy binding] pins the callActivity to the child's published version, immutably", async () => {
    const childDraft = await createDraft(trivialBpmn("child-proc-happy"), "child-v1");
    const childV1 = await publishDraft(childDraft.body.draftId);
    expect(childV1.status).toBe(201);

    const parentDraft = await createDraft(callerBpmn("parent-happy", "child-proc-happy"), "parent-happy");
    const parentRes = await publishDraft(parentDraft.body.draftId);
    expect(parentRes.status).toBe(201);

    const parentGraph = await getGraph(parentRes.body.definitionVersionId);
    expect(parentGraph.nodes["call1"]!.calledDefinitionVersionId).toBe(childV1.body.definitionVersionId);

    // Republish the child as a NEW version — the parent's already-stored
    // graph must keep pinning the OLD child version (immutability).
    const childDraft2 = await createDraft(trivialBpmn("child-proc-happy"), "child-v2");
    const childV2 = await publishDraft(childDraft2.body.draftId);
    expect(childV2.status).toBe(201);
    expect(childV2.body.definitionVersionId).not.toBe(childV1.body.definitionVersionId);

    const parentGraphAfter = await getGraph(parentRes.body.definitionVersionId);
    expect(parentGraphAfter.nodes["call1"]!.calledDefinitionVersionId).toBe(childV1.body.definitionVersionId);
  });

  it("[2 Unresolved] [CA-REJECT-UNRESOLVED-01] rejects a calledElement that does not resolve to any published process, naming the call activity and the target", async () => {
    const draft = await createDraft(callerBpmn("parent-unresolved", "nope-proc-xyz"), "parent-unresolved");
    const res = await publishDraft(draft.body.draftId);
    expect(res.status).toBe(409);
    const issues = res.body.validationIssues as { elementId?: string; reason: string }[];
    expect(
      issues.some((i) => i.elementId === "call1" && /nope-proc-xyz/.test(i.reason)),
    ).toBe(true);
  });

  it("[3 Message-wait, direct child] [CA-REJECT-MSG-01] the child publishes standalone; the parent's publish rejects naming the child's receive element", async () => {
    const childDraft = await createDraft(receiveWaitBpmn("child-msg-direct"), "child-msg-direct");
    const childRes = await publishDraft(childDraft.body.draftId);
    expect(childRes.status).toBe(201);

    const parentDraft = await createDraft(callerBpmn("parent-msg-direct", "child-msg-direct"), "parent-msg-direct");
    const parentRes = await publishDraft(parentDraft.body.draftId);
    expect(parentRes.status).toBe(409);
    const issues = parentRes.body.validationIssues as { elementId?: string; reason: string }[];
    expect(issues.some((i) => /'wait'/.test(i.reason))).toBe(true);
  });

  it("[4 Message-wait, grandchild] the CHILD's own publish rejects (it is itself a caller of a message-bearing tree); a parent calling a clean child succeeds", async () => {
    const gcDraft = await createDraft(messageCatchBpmn("grandchild-msg"), "grandchild-msg");
    const gcRes = await publishDraft(gcDraft.body.draftId);
    expect(gcRes.status).toBe(201); // the grandchild publishes fine standalone

    const childDraft = await createDraft(callerBpmn("child-msg-indirect", "grandchild-msg"), "child-msg-indirect");
    const childRes = await publishDraft(childDraft.body.draftId);
    expect(childRes.status).toBe(409); // the CHILD's own publish rejects
    const childIssues = childRes.body.validationIssues as { elementId?: string; reason: string }[];
    expect(childIssues.some((i) => i.elementId === "call1" && /'IC'/.test(i.reason))).toBe(true);

    const cleanChildDraft = await createDraft(trivialBpmn("clean-child"), "clean-child");
    const cleanChildRes = await publishDraft(cleanChildDraft.body.draftId);
    expect(cleanChildRes.status).toBe(201);

    const parentDraft = await createDraft(callerBpmn("parent-clean", "clean-child"), "parent-clean");
    const parentRes = await publishDraft(parentDraft.body.draftId);
    expect(parentRes.status).toBe(201);
  });

  it("[5 Depth] [CA-REJECT-DEPTH-01] a chain of trivial one-callActivity processes rejects at depth 5 > MAX_CALL_DEPTH=4; depth 4 succeeds", async () => {
    const d1 = await createDraft(trivialBpmn("depth-d1"), "depth-d1");
    expect((await publishDraft(d1.body.draftId)).status).toBe(201);

    const d2 = await createDraft(callerBpmn("depth-d2", "depth-d1"), "depth-d2");
    expect((await publishDraft(d2.body.draftId)).status).toBe(201);

    const d3 = await createDraft(callerBpmn("depth-d3", "depth-d2"), "depth-d3");
    expect((await publishDraft(d3.body.draftId)).status).toBe(201);

    const d4 = await createDraft(callerBpmn("depth-d4", "depth-d3"), "depth-d4");
    const d4Res = await publishDraft(d4.body.draftId);
    expect(d4Res.status).toBe(201); // depth 4 succeeds

    const d5 = await createDraft(callerBpmn("depth-d5", "depth-d4"), "depth-d5");
    const d5Res = await publishDraft(d5.body.draftId);
    expect(d5Res.status).toBe(409); // depth 5 exceeds MAX_CALL_DEPTH=4
    const issues = d5Res.body.validationIssues as { elementId?: string; reason: string }[];
    expect(issues.some((i) => /MAX_CALL_DEPTH/.test(i.reason))).toBe(true);
  });

  it("[6 Self-reference] a callActivity naming its own processId pins to the PREVIOUS already-published version (no cycle by construction)", async () => {
    const v1Draft = await createDraft(trivialBpmn("loop-proc"), "loop-v1");
    const v1 = await publishDraft(v1Draft.body.draftId);
    expect(v1.status).toBe(201);

    const v2Draft = await createDraft(callerBpmn("loop-proc", "loop-proc"), "loop-v2");
    const v2 = await publishDraft(v2Draft.body.draftId);
    expect(v2.status).toBe(201);

    const v2Graph = await getGraph(v2.body.definitionVersionId);
    expect(v2Graph.nodes["call1"]!.calledDefinitionVersionId).toBe(v1.body.definitionVersionId);
  });
});
