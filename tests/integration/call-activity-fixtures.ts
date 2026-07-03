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

// Parent: start → p-tx[ charge-card (comp: refund-card) → txEnd ] → call1(child-proc) → end
//         + error boundary (CHILD_FAILED) DIRECTLY on call1 (level-0/own-boundary catch,
//         Task 7 test 1) → p-handle(log-only) → p-end2.
// NOTE (Task 7 fixture fix): call1 must sit OUTSIDE the transaction — a boundary
// event's declared scope must match its attached element's scope (validator:
// "attached to an element in a different scope"), and its single outgoing flow
// must stay in that SAME scope; a transaction is a sealed SESE region, so an
// own-boundary catch that exits to p-handle/p-end2 (root scope) requires call1
// itself to be at root scope. CALL_PARENT_SCOPE_BOUNDARY_BPMN below covers the
// call1-nested-in-a-transaction case (bubble-to-scope, hostIsScope=true).
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
      <bpmn:sequenceFlow id="ptf2" sourceRef="p-charge" targetRef="pt-end"/>
      <bpmn:endEvent id="pt-end"/>
    </bpmn:transaction>
    <bpmn:sequenceFlow id="pf2" sourceRef="p-tx" targetRef="call1"/>
    <bpmn:callActivity id="call1" calledElement="child-proc"/>
    <bpmn:boundaryEvent id="call1-err" attachedToRef="call1"><bpmn:errorEventDefinition errorRef="errChild2"/></bpmn:boundaryEvent>
    <bpmn:serviceTask id="p-handle" name="Handle child failure">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="log-only" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="pf-err" sourceRef="call1-err" targetRef="p-handle"/>
    <bpmn:sequenceFlow id="pf-handle" sourceRef="p-handle" targetRef="p-end2"/>
    <bpmn:endEvent id="p-end2"/>
    <bpmn:sequenceFlow id="pf3" sourceRef="call1" targetRef="p-end"/>
    <bpmn:endEvent id="p-end"/>
  </bpmn:process>
</bpmn:definitions>`;

// Parent variant (Task 7 test: bubble to scope): the error boundary sits on the
// ENCLOSING transaction (ps-tx) instead of directly on call1 — errorCatchTarget's
// own-boundary level is a miss, so the walk climbs to the scope level and catches
// there (hostIsScope=true), draining the scope's live subtree + auditing
// `scopeExited`. Calls the SAME child (child-proc / CALL_CHILD_BPMN).
export const CALL_PARENT_SCOPE_BOUNDARY_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="parent-scope-defs" targetNamespace="http://example.com">
  <bpmn:error id="errChild3" name="ChildFailed" errorCode="CHILD_FAILED"/>
  <bpmn:process id="parent-scope-proc" isExecutable="true">
    <bpmn:startEvent id="ps-start"/>
    <bpmn:sequenceFlow id="psf1" sourceRef="ps-start" targetRef="ps-tx"/>
    <bpmn:transaction id="ps-tx" name="Place order">
      <bpmn:startEvent id="pst-start"/>
      <bpmn:sequenceFlow id="pstf1" sourceRef="pst-start" targetRef="ps-charge"/>
      <bpmn:serviceTask id="ps-charge" name="Charge card">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="charge-card" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="ps-charge-comp" attachedToRef="ps-charge"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="ps-refund" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="refund-card" retries="5"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="ps-a1" associationDirection="One" sourceRef="ps-charge-comp" targetRef="ps-refund"/>
      <bpmn:sequenceFlow id="pstf2" sourceRef="ps-charge" targetRef="call1"/>
      <bpmn:callActivity id="call1" calledElement="child-proc"/>
      <bpmn:sequenceFlow id="pstf3" sourceRef="call1" targetRef="pst-end"/>
      <bpmn:endEvent id="pst-end"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="ps-tx-err" attachedToRef="ps-tx"><bpmn:errorEventDefinition errorRef="errChild3"/></bpmn:boundaryEvent>
    <bpmn:serviceTask id="ps-handle" name="Handle child failure">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="log-only" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="psf-err" sourceRef="ps-tx-err" targetRef="ps-handle"/>
    <bpmn:sequenceFlow id="psf-handle" sourceRef="ps-handle" targetRef="ps-end2"/>
    <bpmn:endEvent id="ps-end2"/>
    <bpmn:sequenceFlow id="psf2" sourceRef="ps-tx" targetRef="ps-end"/>
    <bpmn:endEvent id="ps-end"/>
  </bpmn:process>
</bpmn:definitions>`;

// Parent variant (Task 7 test: uncaught at parent root): no error boundary
// anywhere on the chain — an uncaught CHILD_FAILED must raise an `uncaughtError`
// incident at the parent, naming call1; the child stays `errored`.
export const CALL_PARENT_NO_BOUNDARY_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="parent-noboundary-defs" targetNamespace="http://example.com">
  <bpmn:process id="parent-noboundary-proc" isExecutable="true">
    <bpmn:startEvent id="pn-start"/>
    <bpmn:sequenceFlow id="pnf1" sourceRef="pn-start" targetRef="call1"/>
    <bpmn:callActivity id="call1" calledElement="child-proc"/>
    <bpmn:sequenceFlow id="pnf2" sourceRef="call1" targetRef="pn-after"/>
    <bpmn:serviceTask id="pn-after" name="After">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="echo" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="pnf3" sourceRef="pn-after" targetRef="pn-end"/>
    <bpmn:endEvent id="pn-end"/>
  </bpmn:process>
</bpmn:definitions>`;

// Child variant (Task 7 test: child technical incident does NOT notify): a
// single always-fail service task (no transaction) — technical retries exhaust
// to a child-local `incident`, which must NEVER notify the parent (`incident` is
// deliberately absent from PARENT_CONSUMABLE_CHILD_STATUSES).
export const CALL_CHILD_ALWAYS_FAIL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="child-fail-defs" targetNamespace="http://example.com">
  <bpmn:process id="child-fail-proc" isExecutable="true">
    <bpmn:startEvent id="cf-start"/>
    <bpmn:sequenceFlow id="cff1" sourceRef="cf-start" targetRef="cf-task"/>
    <bpmn:serviceTask id="cf-task" name="Always fail">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="always-fail" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="cff2" sourceRef="cf-task" targetRef="cf-end"/>
    <bpmn:endEvent id="cf-end"/>
  </bpmn:process>
</bpmn:definitions>`;

// Parent variant (Task 7 test: child technical incident does NOT notify): calls
// the always-fail child above.
export const CALL_PARENT_FOR_INCIDENT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="parent-incident-defs" targetNamespace="http://example.com">
  <bpmn:process id="parent-incident-proc" isExecutable="true">
    <bpmn:startEvent id="pi-start"/>
    <bpmn:sequenceFlow id="pif1" sourceRef="pi-start" targetRef="call1"/>
    <bpmn:callActivity id="call1" calledElement="child-fail-proc"/>
    <bpmn:sequenceFlow id="pif2" sourceRef="call1" targetRef="pi-after"/>
    <bpmn:serviceTask id="pi-after" name="After">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="echo" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="pif3" sourceRef="pi-after" targetRef="pi-end"/>
    <bpmn:endEvent id="pi-end"/>
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
