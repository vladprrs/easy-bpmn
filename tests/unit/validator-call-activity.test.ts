// M5-L2 (Task 2): validator acceptance of bpmn:callActivity as a leaf node on
// the token path. Pure document-local validation only — calledElement
// cross-document resolution to a calledDefinitionVersionId happens at the
// CALLER's publish in a later M5-L2 task; here calledDefinitionVersionId
// stays unset.
import { describe, expect, it } from "vitest";
import { parseAndValidate } from "../../src/bpmn/validator";

const CALL_XML = (body: string, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
    id="defs" targetNamespace="http://example.com">
  ${extra}
  <bpmn:process id="proc" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="call1"/>
    ${body}
    <bpmn:sequenceFlow id="f2" sourceRef="call1" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;

describe("M5-L2 callActivity acceptance", () => {
  it("accepts a plain callActivity and emits the node", async () => {
    const r = await parseAndValidate(CALL_XML(`<bpmn:callActivity id="call1" calledElement="child-proc"/>`));
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["call1"]).toMatchObject({ type: "callActivity", calledElementId: "child-proc", next: "end" });
  });

  it("rejects a callActivity without calledElement", async () => {
    const r = await parseAndValidate(CALL_XML(`<bpmn:callActivity id="call1"/>`));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "call1" && /calledElement/.test(i.reason))).toBe(true);
  });

  // M5-L3 flipped this from the interim "planned for M5-L3" reject: MI on a
  // callActivity is now ACCEPTED, but a bare <multiInstanceLoopCharacteristics/>
  // has no cardinality source — the permanent no-source reject.
  it("rejects a callActivity MI with no recognized cardinality source", async () => {
    const r = await parseAndValidate(CALL_XML(
      `<bpmn:callActivity id="call1" calledElement="child-proc"><bpmn:multiInstanceLoopCharacteristics/></bpmn:callActivity>`));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "call1" && /no recognized cardinality source/i.test(i.reason))).toBe(true);
  });

  it("rejects a same-document non-process calledElement (GlobalTask) explicitly", async () => {
    const r = await parseAndValidate(CALL_XML(
      `<bpmn:callActivity id="call1" calledElement="gt1"/>`,
      `<bpmn:globalTask id="gt1" name="G"/>`));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "call1" && /process/.test(i.reason) && /gt1/.test(i.reason))).toBe(true);
  });

  it("tolerates-and-ignores camunda binding attributes", async () => {
    const r = await parseAndValidate(CALL_XML(
      `<bpmn:callActivity id="call1" calledElement="child-proc" camunda:calledElementBinding="latest" camunda:calledElementVersion="7"/>`));
    expect(r.ok).toBe(true);
  });

  it("accepts error/timer boundaries attached to a callActivity", async () => {
    const xml = CALL_XML(
      `<bpmn:callActivity id="call1" calledElement="child-proc"/>
       <bpmn:boundaryEvent id="call1_err" attachedToRef="call1"><bpmn:errorEventDefinition errorRef="E1"/></bpmn:boundaryEvent>
       <bpmn:sequenceFlow id="ferr" sourceRef="call1_err" targetRef="end"/>
       <bpmn:boundaryEvent id="call1_timer" attachedToRef="call1"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
       <bpmn:sequenceFlow id="ftimer" sourceRef="call1_timer" targetRef="end"/>`,
      `<bpmn:error id="E1" name="Fail" errorCode="E_FAIL"/>`,
    );
    const r = await parseAndValidate(xml);
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["call1_err"]!.attachedToRef).toBe("call1");
    expect(r.graph!.nodes["call1_timer"]!.attachedToRef).toBe("call1");
  });
});
