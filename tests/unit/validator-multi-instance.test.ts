// M5-L3 (Task 2): validator acceptance of multiInstanceLoopCharacteristics on
// serviceTask / subProcess / callActivity — the two cardinality sources
// (standard loopCardinality XOR the easy-bpmn:multiInstance collection binding),
// the miBody scope entries, and the reject matrix (standard loop marker, MI on
// unsupported hosts, standard MI data bindings, non-All behavior, FEEL parse
// failures, compensation restrictions, and the v1 MI-subProcess body whitelist).
// Pure document-local validation only — bodyStepCost refinement for callActivity
// bodies via call resolution is Task 3.
import { describe, expect, it } from "vitest";
import { parseAndValidate } from "../../src/bpmn/validator";

const MI_XML = (activity: string, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="defs" targetNamespace="http://example.com">
  ${extra}
  <bpmn:process id="proc" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="mi1"/>
    ${activity}
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;

const MI_TASK = (loop: string, ext = "") => `<bpmn:serviceTask id="mi1" name="Fan">
  <bpmn:extensionElements><easy-bpmn:taskDefinition type="charge" retries="1"/>${ext}</bpmn:extensionElements>
  ${loop}
</bpmn:serviceTask>`;

const CARD = (n = "3", seq = "false", inner = "") =>
  `<bpmn:multiInstanceLoopCharacteristics isSequential="${seq}">
     <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">${n}</bpmn:loopCardinality>${inner}
   </bpmn:multiInstanceLoopCharacteristics>`;
const COLL_EXT = `<easy-bpmn:multiInstance collection="orders" elementVariable="order" outputVariable="results"/>`;

/** An MI subProcess with the given loop characteristics + body flow elements. */
const MI_SUBPROCESS = (loop: string, body: string) => `<bpmn:subProcess id="mi1" name="Batch">
  ${loop}
  ${body}
</bpmn:subProcess>`;

const SIMPLE_BODY = `
  <bpmn:startEvent id="b_start"/>
  <bpmn:sequenceFlow id="b_f1" sourceRef="b_start" targetRef="b_task"/>
  <bpmn:serviceTask id="b_task" name="Echo"><bpmn:extensionElements><easy-bpmn:taskDefinition type="echo"/></bpmn:extensionElements></bpmn:serviceTask>
  <bpmn:sequenceFlow id="b_f2" sourceRef="b_task" targetRef="b_end"/>
  <bpmn:endEvent id="b_end"/>`;

type Result = Awaited<ReturnType<typeof parseAndValidate>>;
const issueOn = (r: Result, id: string, re: RegExp): boolean =>
  r.issues.some((i) => i.elementId === id && re.test(i.reason));

describe("M5-L3 multiInstance acceptance", () => {
  it("accepts parallel cardinality MI on a serviceTask and emits the spec + miBody scope", async () => {
    const r = await parseAndValidate(MI_XML(MI_TASK(CARD())));
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["mi1"]!.multiInstance).toMatchObject({
      isSequential: false,
      loopCardinality: "3",
      collection: null,
      bodyStepCost: 1,
    });
    expect(r.graph!.scopes!["mi1"]).toMatchObject({ kind: "miBody", parentId: null, startId: "mi1" });
  });

  it("accepts sequential collection MI via the easy-bpmn:multiInstance binding", async () => {
    const r = await parseAndValidate(
      MI_XML(MI_TASK(`<bpmn:multiInstanceLoopCharacteristics isSequential="true"/>`, COLL_EXT)),
    );
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["mi1"]!.multiInstance).toMatchObject({
      isSequential: true,
      collection: "orders",
      elementVariable: "order",
      outputVariable: "results",
    });
  });

  it("accepts a completionCondition and carries its FEEL body", async () => {
    const r = await parseAndValidate(MI_XML(MI_TASK(CARD(
      "5",
      "false",
      `<bpmn:completionCondition xsi:type="bpmn:tFormalExpression">done = true</bpmn:completionCondition>`,
    ))));
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["mi1"]!.multiInstance!.completionCondition).toBe("done = true");
  });

  it("accepts MI on a subProcess: miBody scope kind, bodyStepCost, interior scope membership", async () => {
    const r = await parseAndValidate(MI_XML(MI_SUBPROCESS(CARD(), SIMPLE_BODY)));
    expect(r.ok).toBe(true);
    expect(r.graph!.scopes!["mi1"]!.kind).toBe("miBody");
    expect(r.graph!.nodes["mi1"]!.multiInstance!.bodyStepCost).toBeGreaterThanOrEqual(1);
    expect(r.graph!.nodes["b_task"]!.scopeId).toBe("mi1");
    expect(r.graph!.nodes["b_end"]!.scopeId).toBe("mi1");
  });

  it("accepts MI on a callActivity (bodyStepCost 1 pre-resolution — Task 3 refines it)", async () => {
    const r = await parseAndValidate(
      MI_XML(`<bpmn:callActivity id="mi1" calledElement="child-proc">${CARD()}</bpmn:callActivity>`),
    );
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["mi1"]).toMatchObject({ type: "callActivity", calledElementId: "child-proc" });
    expect(r.graph!.nodes["mi1"]!.multiInstance).toMatchObject({
      isSequential: false,
      loopCardinality: "3",
      bodyStepCost: 1,
    });
  });

  it("accepts error + timer boundaries attached to an MI serviceTask", async () => {
    const xml = MI_XML(
      `${MI_TASK(CARD())}
       <bpmn:boundaryEvent id="mi1_err" attachedToRef="mi1"><bpmn:errorEventDefinition errorRef="E1"/></bpmn:boundaryEvent>
       <bpmn:sequenceFlow id="ferr" sourceRef="mi1_err" targetRef="end"/>
       <bpmn:boundaryEvent id="mi1_timer" attachedToRef="mi1"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
       <bpmn:sequenceFlow id="ftimer" sourceRef="mi1_timer" targetRef="end"/>`,
      `<bpmn:error id="E1" name="Fail" errorCode="E_FAIL"/>`,
    );
    const r = await parseAndValidate(xml);
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["mi1_err"]!.attachedToRef).toBe("mi1");
    expect(r.graph!.nodes["mi1_timer"]!.attachedToRef).toBe("mi1");
  });

  it("tolerates camunda/zeebe MI attributes as extension content when a recognized source exists", async () => {
    const loop = `<bpmn:multiInstanceLoopCharacteristics isSequential="false"
        xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
        camunda:collection="legacyItems" camunda:elementVariable="legacyVar">
      <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">3</bpmn:loopCardinality>
    </bpmn:multiInstanceLoopCharacteristics>`;
    const r = await parseAndValidate(MI_XML(MI_TASK(loop)));
    expect(r.ok).toBe(true);
    // The foreign attributes are ignored, never read as a cardinality source.
    expect(r.graph!.nodes["mi1"]!.multiInstance).toMatchObject({ loopCardinality: "3", collection: null });
  });
});

describe("M5-L3 multiInstance reject matrix", () => {
  it("rejects standardLoopCharacteristics (the loop marker) with a distinct permanent message", async () => {
    const r = await parseAndValidate(MI_XML(MI_TASK(`<bpmn:standardLoopCharacteristics/>`)));
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /standard loop|loop marker/i)).toBe(true);
  });

  it("rejects MI on a receiveTask", async () => {
    const r = await parseAndValidate(
      MI_XML(
        `<bpmn:receiveTask id="mi1" name="Wait" messageRef="M1">${CARD()}</bpmn:receiveTask>`,
        `<bpmn:message id="M1" name="mi-msg"/>`,
      ),
    );
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /multi-instance.*not supported on/i)).toBe(true);
  });

  it("rejects MI on a transaction", async () => {
    const r = await parseAndValidate(MI_XML(`<bpmn:transaction id="mi1" name="Tx">
      ${CARD()}
      <bpmn:startEvent id="t_start"/>
      <bpmn:sequenceFlow id="t_f1" sourceRef="t_start" targetRef="t_end"/>
      <bpmn:endEvent id="t_end"/>
    </bpmn:transaction>`));
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /multi-instance.*not supported on/i)).toBe(true);
  });

  it("rejects the standard MI data bindings: loopDataInputRef", async () => {
    const r = await parseAndValidate(
      MI_XML(MI_TASK(CARD("3", "false", `<bpmn:loopDataInputRef>x</bpmn:loopDataInputRef>`))),
    );
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /loopDataInputRef|data bindings/i)).toBe(true);
  });

  it("rejects the standard MI data bindings: inputDataItem", async () => {
    const r = await parseAndValidate(
      MI_XML(MI_TASK(CARD("3", "false", `<bpmn:inputDataItem id="dii" name="d"/>`))),
    );
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /inputDataItem|data bindings/i)).toBe(true);
  });

  it("rejects MI with no recognized cardinality source", async () => {
    const r = await parseAndValidate(MI_XML(MI_TASK(`<bpmn:multiInstanceLoopCharacteristics/>`)));
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /no recognized cardinality source/i)).toBe(true);
  });

  it("rejects both cardinality sources at once (loopCardinality + collection)", async () => {
    const r = await parseAndValidate(MI_XML(MI_TASK(CARD(), COLL_EXT)));
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /both/i)).toBe(true);
  });

  it("rejects a loopCardinality that does not parse as FEEL", async () => {
    const r = await parseAndValidate(MI_XML(MI_TASK(CARD("((("))));
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /invalid feel|syntax error/i)).toBe(true);
  });

  it("rejects a completionCondition that does not parse as FEEL", async () => {
    const r = await parseAndValidate(MI_XML(MI_TASK(CARD(
      "3",
      "false",
      `<bpmn:completionCondition xsi:type="bpmn:tFormalExpression">(((</bpmn:completionCondition>`,
    ))));
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /invalid feel|syntax error/i)).toBe(true);
  });

  it("rejects isForCompensation on an MI activity", async () => {
    const r = await parseAndValidate(MI_XML(`<bpmn:serviceTask id="mi1" name="Fan" isForCompensation="true">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="charge" retries="1"/></bpmn:extensionElements>
      ${CARD()}
    </bpmn:serviceTask>`));
    expect(r.ok).toBe(false);
    // Pin the MI-specific reject (the generic handler-outside-transaction rule
    // also fires on this fixture, so the regex must require the MI wording).
    expect(issueOn(r, "mi1", /isForCompensation.*multi-instance/i)).toBe(true);
  });

  it("rejects a compensation boundary attached to an MI activity (compensate-as-a-unit deferred)", async () => {
    const xml = MI_XML(`${MI_TASK(CARD())}
      <bpmn:boundaryEvent id="comp_b" attachedToRef="mi1"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>`);
    const r = await parseAndValidate(xml);
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /compensate.*multi-instance.*deferred/i)).toBe(true);
  });

  it("rejects a receiveTask inside a multi-instance body (v1 whitelist)", async () => {
    const body = `
      <bpmn:startEvent id="b_start"/>
      <bpmn:sequenceFlow id="b_f1" sourceRef="b_start" targetRef="b_recv"/>
      <bpmn:receiveTask id="b_recv" messageRef="M1"/>
      <bpmn:sequenceFlow id="b_f2" sourceRef="b_recv" targetRef="b_end"/>
      <bpmn:endEvent id="b_end"/>`;
    const r = await parseAndValidate(
      MI_XML(MI_SUBPROCESS(CARD(), body), `<bpmn:message id="M1" name="mi-msg"/>`),
    );
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /message|receive/i)).toBe(true);
    expect(issueOn(r, "mi1", /multi-instance body/i)).toBe(true);
  });

  it("rejects a nested subProcess inside a multi-instance body (v1 whitelist)", async () => {
    const body = `
      <bpmn:startEvent id="b_start"/>
      <bpmn:sequenceFlow id="b_f1" sourceRef="b_start" targetRef="b_sub"/>
      <bpmn:subProcess id="b_sub">
        <bpmn:startEvent id="n_start"/>
        <bpmn:sequenceFlow id="n_f1" sourceRef="n_start" targetRef="n_end"/>
        <bpmn:endEvent id="n_end"/>
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="b_f2" sourceRef="b_sub" targetRef="b_end"/>
      <bpmn:endEvent id="b_end"/>`;
    const r = await parseAndValidate(MI_XML(MI_SUBPROCESS(CARD(), body)));
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /multi-instance body/i)).toBe(true);
  });

  it("rejects a parallelGateway inside a multi-instance body (v1 whitelist)", async () => {
    const body = `
      <bpmn:startEvent id="b_start"/>
      <bpmn:sequenceFlow id="b_f1" sourceRef="b_start" targetRef="b_fork"/>
      <bpmn:parallelGateway id="b_fork"/>
      <bpmn:sequenceFlow id="b_f2" sourceRef="b_fork" targetRef="b_t1"/>
      <bpmn:sequenceFlow id="b_f3" sourceRef="b_fork" targetRef="b_t2"/>
      <bpmn:serviceTask id="b_t1"><bpmn:extensionElements><easy-bpmn:taskDefinition type="a"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="b_f4" sourceRef="b_t1" targetRef="b_join"/>
      <bpmn:serviceTask id="b_t2"><bpmn:extensionElements><easy-bpmn:taskDefinition type="b"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="b_f5" sourceRef="b_t2" targetRef="b_join"/>
      <bpmn:parallelGateway id="b_join"/>
      <bpmn:sequenceFlow id="b_f6" sourceRef="b_join" targetRef="b_end"/>
      <bpmn:endEvent id="b_end"/>`;
    const r = await parseAndValidate(MI_XML(MI_SUBPROCESS(CARD(), body)));
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /multi-instance body/i)).toBe(true);
  });

  it("rejects an eventBasedGateway inside a multi-instance body (v1 whitelist)", async () => {
    const body = `
      <bpmn:startEvent id="b_start"/>
      <bpmn:sequenceFlow id="b_f1" sourceRef="b_start" targetRef="b_ebg"/>
      <bpmn:eventBasedGateway id="b_ebg"/>
      <bpmn:sequenceFlow id="b_f2" sourceRef="b_ebg" targetRef="b_ct"/>
      <bpmn:sequenceFlow id="b_f3" sourceRef="b_ebg" targetRef="b_cm"/>
      <bpmn:intermediateCatchEvent id="b_ct"><bpmn:timerEventDefinition><bpmn:timeDuration>PT1M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>
      <bpmn:sequenceFlow id="b_f4" sourceRef="b_ct" targetRef="b_end"/>
      <bpmn:intermediateCatchEvent id="b_cm"><bpmn:messageEventDefinition messageRef="M1"/></bpmn:intermediateCatchEvent>
      <bpmn:sequenceFlow id="b_f5" sourceRef="b_cm" targetRef="b_end2"/>
      <bpmn:endEvent id="b_end"/>
      <bpmn:endEvent id="b_end2"/>`;
    const r = await parseAndValidate(
      MI_XML(MI_SUBPROCESS(CARD(), body), `<bpmn:message id="M1" name="mi-msg"/>`),
    );
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /multi-instance body/i)).toBe(true);
  });

  it(`rejects behavior="One" (only the default behavior="All" is supported)`, async () => {
    const r = await parseAndValidate(MI_XML(MI_TASK(`<bpmn:multiInstanceLoopCharacteristics behavior="One">
      <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">3</bpmn:loopCardinality>
    </bpmn:multiInstanceLoopCharacteristics>`)));
    expect(r.ok).toBe(false);
    expect(issueOn(r, "mi1", /behavior/i)).toBe(true);
  });
});
