// Shared callActivity (M5-L2) BPMN fixtures — imported by the Task 6 forward
// happy-path suite and the Tasks 7–10 error-routing / drain-cascade / child-
// compensation suites. Two pairs:
//   * SIMPLE_CHILD / SIMPLE_PARENT — a trivial no-transaction pass-through
//     (start → echo → end child; start → call1(child) → echo → end parent) used
//     by the forward happy path + idempotency.
//   * CALL_CHILD / CALL_PARENT — the canonical composed saga: a transactional
//     child that can throw CHILD_FAILED, called from inside a transactional
//     parent with an error boundary on the call + a cancel boundary on the tx.

// Child: start → tx1[ reserve-stock (comp: release-stock) → txEnd ] → gw: failChild ? errorEnd(CHILD_FAILED) : end
export const CALL_CHILD_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="child-defs" targetNamespace="http://example.com">
  <bpmn:error id="errChild" name="ChildFailed" errorCode="CHILD_FAILED"/>
  <bpmn:process id="child-proc" isExecutable="true">
    <bpmn:startEvent id="c-start"/>
    <bpmn:sequenceFlow id="cf1" sourceRef="c-start" targetRef="c-tx"/>
    <bpmn:transaction id="c-tx">
      <bpmn:startEvent id="ct-start"/>
      <bpmn:sequenceFlow id="ctf1" sourceRef="ct-start" targetRef="c-reserve"/>
      <bpmn:serviceTask id="c-reserve" name="Reserve">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="reserve-stock" retries="1"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="c-comp-b" attachedToRef="c-reserve"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="c-release" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="release-stock" retries="1"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="c-assoc" associationDirection="One" sourceRef="c-comp-b" targetRef="c-release"/>
      <bpmn:sequenceFlow id="ctf2" sourceRef="c-reserve" targetRef="ct-end"/>
      <bpmn:endEvent id="ct-end"/>
    </bpmn:transaction>
    <bpmn:sequenceFlow id="cf2" sourceRef="c-tx" targetRef="c-gw"/>
    <bpmn:exclusiveGateway id="c-gw" default="cf-ok"/>
    <bpmn:sequenceFlow id="cf-fail" sourceRef="c-gw" targetRef="c-err">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">failChild = true</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:endEvent id="c-err"><bpmn:errorEventDefinition errorRef="errChild"/></bpmn:endEvent>
    <bpmn:sequenceFlow id="cf-ok" sourceRef="c-gw" targetRef="c-end"/>
    <bpmn:endEvent id="c-end"/>
  </bpmn:process>
</bpmn:definitions>`;

// Parent: start → p-tx[ charge-card (comp: refund-card) → call1(child-proc) → gw: failSettle ? cancelEnd : txEnd ] → end
//         + error boundary (CHILD_FAILED) on call1 → p-handle(log-only) → p-end2, cancel boundary on p-tx → p-comp-end
export const CALL_PARENT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="parent-defs" targetNamespace="http://example.com">
  <bpmn:error id="errChild2" name="ChildFailed" errorCode="CHILD_FAILED"/>
  <bpmn:process id="parent-proc" isExecutable="true">
    <bpmn:startEvent id="p-start"/>
    <bpmn:sequenceFlow id="pf1" sourceRef="p-start" targetRef="p-tx"/>
    <bpmn:transaction id="p-tx" name="Place order">
      <bpmn:startEvent id="pt-start"/>
      <bpmn:sequenceFlow id="ptf1" sourceRef="pt-start" targetRef="p-charge"/>
      <bpmn:serviceTask id="p-charge" name="Charge card">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="charge-card" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="p-charge-comp" attachedToRef="p-charge"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="p-refund" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="refund-card" retries="5"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="p-a1" associationDirection="One" sourceRef="p-charge-comp" targetRef="p-refund"/>
      <bpmn:sequenceFlow id="ptf2" sourceRef="p-charge" targetRef="call1"/>
      <bpmn:callActivity id="call1" calledElement="child-proc"/>
      <bpmn:sequenceFlow id="ptf3" sourceRef="call1" targetRef="p-gw"/>
      <bpmn:exclusiveGateway id="p-gw" default="pf-ok"/>
      <bpmn:sequenceFlow id="pf-fail" sourceRef="p-gw" targetRef="p-cancel-end">
        <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">failSettle = true</bpmn:conditionExpression>
      </bpmn:sequenceFlow>
      <bpmn:endEvent id="p-cancel-end"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      <bpmn:sequenceFlow id="pf-ok" sourceRef="p-gw" targetRef="pt-end"/>
      <bpmn:endEvent id="pt-end"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="call1-err" attachedToRef="call1"><bpmn:errorEventDefinition errorRef="errChild2"/></bpmn:boundaryEvent>
    <bpmn:serviceTask id="p-handle" name="Handle child failure">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="log-only" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="pf-err" sourceRef="call1-err" targetRef="p-handle"/>
    <bpmn:sequenceFlow id="pf-handle" sourceRef="p-handle" targetRef="p-end2"/>
    <bpmn:endEvent id="p-end2"/>
    <bpmn:boundaryEvent id="p-tx-cancel-b" attachedToRef="p-tx"><bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="pf-cancel" sourceRef="p-tx-cancel-b" targetRef="p-comp-end"/>
    <bpmn:endEvent id="p-comp-end"/>
    <bpmn:sequenceFlow id="pf2" sourceRef="p-tx" targetRef="p-end"/>
    <bpmn:endEvent id="p-end"/>
  </bpmn:process>
</bpmn:definitions>`;

// Trivial no-transaction pair — the forward happy path + idempotency.
export const SIMPLE_CHILD_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="simple-child-defs" targetNamespace="http://example.com">
  <bpmn:process id="simple-child" isExecutable="true">
    <bpmn:startEvent id="sc-start"/>
    <bpmn:sequenceFlow id="scf1" sourceRef="sc-start" targetRef="sc-echo"/>
    <bpmn:serviceTask id="sc-echo" name="Echo">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="echo" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="scf2" sourceRef="sc-echo" targetRef="sc-end"/>
    <bpmn:endEvent id="sc-end"/>
  </bpmn:process>
</bpmn:definitions>`;

export const SIMPLE_PARENT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="simple-parent-defs" targetNamespace="http://example.com">
  <bpmn:process id="simple-parent" isExecutable="true">
    <bpmn:startEvent id="sp-start"/>
    <bpmn:sequenceFlow id="spf1" sourceRef="sp-start" targetRef="call1"/>
    <bpmn:callActivity id="call1" calledElement="simple-child"/>
    <bpmn:sequenceFlow id="spf2" sourceRef="call1" targetRef="p-after"/>
    <bpmn:serviceTask id="p-after" name="After">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="echo" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="spf3" sourceRef="p-after" targetRef="sp-end"/>
    <bpmn:endEvent id="sp-end"/>
  </bpmn:process>
</bpmn:definitions>`;
