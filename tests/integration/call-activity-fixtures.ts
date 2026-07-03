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

// ---------------------------------------------------------------------------
// Task 8 — cascading drain/cancel fixtures (timer Hazard, scope-drain,
// operator-cancel cascade, never-regress). SIMPLE_CHILD_BPMN's `sc-echo` task
// (type "echo") doubles as the "never completes" park: a test simply never
// drains that task type, leaving the child running/waiting forever.
// ---------------------------------------------------------------------------

// Child: start -> tx[reserve-stock-park (comp: release-stock-park)] -> park
// (never drained). The tx COMMITS (sealing its ledger row uncompensable, spec
// §3's committed shield) before the child parks, so the Hazard test has a real
// ledger row to prove is RETAINED (never compensated) by the cancel-cascade.
export const CALL_CHILD_TX_PARK_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="child-tx-park-defs" targetNamespace="http://example.com">
  <bpmn:process id="child-tx-park-proc" isExecutable="true">
    <bpmn:startEvent id="ctp-start"/>
    <bpmn:sequenceFlow id="ctpf1" sourceRef="ctp-start" targetRef="ctp-tx"/>
    <bpmn:transaction id="ctp-tx">
      <bpmn:startEvent id="ctpt-start"/>
      <bpmn:sequenceFlow id="ctptf1" sourceRef="ctpt-start" targetRef="ctp-reserve"/>
      <bpmn:serviceTask id="ctp-reserve" name="Reserve">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="reserve-stock-park" retries="1"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="ctp-comp-b" attachedToRef="ctp-reserve"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="ctp-release" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="release-stock-park" retries="1"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="ctp-assoc" associationDirection="One" sourceRef="ctp-comp-b" targetRef="ctp-release"/>
      <bpmn:sequenceFlow id="ctptf2" sourceRef="ctp-reserve" targetRef="ctpt-end"/>
      <bpmn:endEvent id="ctpt-end"/>
    </bpmn:transaction>
    <bpmn:sequenceFlow id="ctpf2" sourceRef="ctp-tx" targetRef="ctp-park"/>
    <bpmn:serviceTask id="ctp-park" name="Park">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="child-park" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="ctpf3" sourceRef="ctp-park" targetRef="ctp-end"/>
    <bpmn:endEvent id="ctp-end"/>
  </bpmn:process>
</bpmn:definitions>`;

// Parent: start -> call1(child-tx-park-proc) -[timer PT0.5S]-> onTimeout(handler) -> end2
//                          \-------------------------------------------/ call1 -> end (normal path, never reached in the Hazard test)
export const CALL_PARENT_TIMER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="parent-timer-defs" targetNamespace="http://example.com">
  <bpmn:process id="parent-timer-proc" isExecutable="true">
    <bpmn:startEvent id="pt-start"/>
    <bpmn:sequenceFlow id="ptf1" sourceRef="pt-start" targetRef="call1"/>
    <bpmn:callActivity id="call1" calledElement="child-tx-park-proc"/>
    <bpmn:boundaryEvent id="call1-timer" attachedToRef="call1">
      <bpmn:timerEventDefinition><bpmn:timeDuration>PT0.5S</bpmn:timeDuration></bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="ptf-timer" sourceRef="call1-timer" targetRef="pt-timeout"/>
    <bpmn:serviceTask id="pt-timeout" name="Timeout handler">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="timeout-handler" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="ptf-handled" sourceRef="pt-timeout" targetRef="pt-end2"/>
    <bpmn:endEvent id="pt-end2"/>
    <bpmn:sequenceFlow id="ptf2" sourceRef="call1" targetRef="pt-end"/>
    <bpmn:endEvent id="pt-end"/>
  </bpmn:process>
</bpmn:definitions>`;

// Parent: a plain (non-transaction) subProcess SD with an AND fork — branch A
// = call1(simple-child) (parks; never drained), branch B = a `sibling` task
// that business-errors (SIBLING_FAILED, no OWN boundary) and bubbles to SD's
// own error boundary → SD-handle → end2. The scope drain triggered by that
// bubble must cascade-cancel call1's still-running child.
export const CALL_PARENT_SCOPE_DRAIN_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="parent-scopedrain-defs" targetNamespace="http://example.com">
  <bpmn:error id="errSib" name="SiblingFailed" errorCode="SIBLING_FAILED"/>
  <bpmn:process id="parent-scopedrain-proc" isExecutable="true">
    <bpmn:startEvent id="sd-start"><bpmn:outgoing>sdf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="sdf1" sourceRef="sd-start" targetRef="SD"/>
    <bpmn:subProcess id="SD">
      <bpmn:startEvent id="sdi-start"><bpmn:outgoing>sdi0</bpmn:outgoing></bpmn:startEvent>
      <bpmn:sequenceFlow id="sdi0" sourceRef="sdi-start" targetRef="fork"/>
      <bpmn:parallelGateway id="fork"><bpmn:incoming>sdi0</bpmn:incoming><bpmn:outgoing>fa</bpmn:outgoing><bpmn:outgoing>fb</bpmn:outgoing></bpmn:parallelGateway>
      <bpmn:sequenceFlow id="fa" sourceRef="fork" targetRef="call1"/>
      <bpmn:callActivity id="call1" calledElement="simple-child"><bpmn:incoming>fa</bpmn:incoming><bpmn:outgoing>ja</bpmn:outgoing></bpmn:callActivity>
      <bpmn:sequenceFlow id="ja" sourceRef="call1" targetRef="join"/>
      <bpmn:sequenceFlow id="fb" sourceRef="fork" targetRef="sibling"/>
      <bpmn:serviceTask id="sibling" name="Sibling">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="sibling-task" retries="1"/></bpmn:extensionElements>
        <bpmn:incoming>fb</bpmn:incoming><bpmn:outgoing>jb</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:sequenceFlow id="jb" sourceRef="sibling" targetRef="join"/>
      <bpmn:parallelGateway id="join"><bpmn:incoming>ja</bpmn:incoming><bpmn:incoming>jb</bpmn:incoming><bpmn:outgoing>sdi1</bpmn:outgoing></bpmn:parallelGateway>
      <bpmn:sequenceFlow id="sdi1" sourceRef="join" targetRef="sdi-end"/>
      <bpmn:endEvent id="sdi-end"><bpmn:incoming>sdi1</bpmn:incoming></bpmn:endEvent>
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="SD-err" attachedToRef="SD"><bpmn:errorEventDefinition errorRef="errSib"/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="sdf-err" sourceRef="SD-err" targetRef="sd-handle"/>
    <bpmn:serviceTask id="sd-handle" name="Handle">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="log-only" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="sdf-handle" sourceRef="sd-handle" targetRef="sd-end2"/>
    <bpmn:endEvent id="sd-end2"/>
    <bpmn:sequenceFlow id="sdf2" sourceRef="SD" targetRef="sd-end"/>
    <bpmn:endEvent id="sd-end"/>
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// Task 9 — child-compensation fixtures. The canonical composed-cancel parent:
// a top-level transaction containing a compensable service task (px-charge,
// comp refund-card), then call1, then a steerable post-call settle task
// (branch-settle: `failSettle` → SETTLE_REJECTED business error → its error
// boundary → the cancel end → the parent reverse pass), with a cancel boundary
// on the transaction (SAGA_BPMN's wiring). The reverse order under cancel is
// call1 (the child's OWN reverse pass — release-stock) BEFORE the earlier
// px-charge step (refund-card). Task 7's fixture-repair lesson respected: the
// error boundary sits on px-settle INSIDE the tx and exits to the cancel end in
// the SAME scope; only the CANCEL boundary sits on the tx itself.
// ---------------------------------------------------------------------------
export const CALL_PARENT_TX_CANCEL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="parent-txcancel-defs" targetNamespace="http://example.com">
  <bpmn:error id="errSettle" name="Settle rejected" errorCode="SETTLE_REJECTED"/>
  <bpmn:process id="parent-txcancel-proc" isExecutable="true">
    <bpmn:startEvent id="px-start"/>
    <bpmn:sequenceFlow id="pxf1" sourceRef="px-start" targetRef="px-tx"/>
    <bpmn:transaction id="px-tx" name="Place order">
      <bpmn:startEvent id="pxt-start"/>
      <bpmn:sequenceFlow id="pxtf1" sourceRef="pxt-start" targetRef="px-charge"/>
      <bpmn:serviceTask id="px-charge" name="Charge card">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="charge-card" retries="2"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="px-charge-comp" attachedToRef="px-charge"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="px-refund" isForCompensation="true">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="refund-card" retries="5"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:association id="px-a1" associationDirection="One" sourceRef="px-charge-comp" targetRef="px-refund"/>
      <bpmn:sequenceFlow id="pxtf2" sourceRef="px-charge" targetRef="call1"/>
      <bpmn:callActivity id="call1" calledElement="child-proc"/>
      <bpmn:sequenceFlow id="pxtf3" sourceRef="call1" targetRef="px-settle"/>
      <bpmn:serviceTask id="px-settle" name="Settle">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="branch-settle" retries="1"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="px-settle-err" attachedToRef="px-settle"><bpmn:errorEventDefinition errorRef="errSettle"/></bpmn:boundaryEvent>
      <bpmn:sequenceFlow id="pxtf4" sourceRef="px-settle" targetRef="pxt-ok"/>
      <bpmn:endEvent id="pxt-ok"/>
      <bpmn:sequenceFlow id="pxf-cancel" sourceRef="px-settle-err" targetRef="pxt-cancel"/>
      <bpmn:endEvent id="pxt-cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="px-tx-cancel" attachedToRef="px-tx"><bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="pxf2" sourceRef="px-tx" targetRef="px-done"/>
    <bpmn:endEvent id="px-done"/>
    <bpmn:sequenceFlow id="pxf3" sourceRef="px-tx-cancel" targetRef="px-failed"/>
    <bpmn:endEvent id="px-failed"/>
  </bpmn:process>
</bpmn:definitions>`;

// Variant (Task 9 test 2, no-op compensator): the SAME parent shape calling the
// no-transaction `simple-child` (echo) — a committed child with an EMPTY
// compensable ledger. Derived by string surgery so the two stay structurally in
// lockstep (a test must still assert it publishes).
export const CALL_PARENT_TX_CANCEL_SIMPLE_BPMN = CALL_PARENT_TX_CANCEL_BPMN
  .replace('id="parent-txcancel-defs"', 'id="parent-txcancel-simple-defs"')
  .replace('id="parent-txcancel-proc"', 'id="parent-txcancel-simple-proc"')
  .replace('calledElement="child-proc"', 'calledElement="simple-child"');

// Variant (Task 9 test 4, interrupted child): the SAME parent shape calling
// `child-tx-park-proc` (the Task-8 fixture whose tx COMMITS then parks forever)
// — the operator /cancel cascade cancels the child mid-flight, then the parent
// reverse pass drives the cancelled child's reverse over its retained ledger.
export const CALL_PARENT_TX_CANCEL_PARK_BPMN = CALL_PARENT_TX_CANCEL_BPMN
  .replace('id="parent-txcancel-defs"', 'id="parent-txcancel-park-defs"')
  .replace('id="parent-txcancel-proc"', 'id="parent-txcancel-park-proc"')
  .replace('calledElement="child-proc"', 'calledElement="child-tx-park-proc"');

// Three-level call chain (depth 3 <= MAX_CALL_DEPTH=4), no transactions anywhere
// (a pure straight-line callActivity chain): leaf parks on a never-drained task.
export const CALL_LEAF_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="call-leaf-defs" targetNamespace="http://example.com">
  <bpmn:process id="call-leaf-proc" isExecutable="true">
    <bpmn:startEvent id="lf-start"/>
    <bpmn:sequenceFlow id="lff1" sourceRef="lf-start" targetRef="lf-park"/>
    <bpmn:serviceTask id="lf-park" name="Park">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="leaf-park" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="lff2" sourceRef="lf-park" targetRef="lf-end"/>
    <bpmn:endEvent id="lf-end"/>
  </bpmn:process>
</bpmn:definitions>`;

export const CALL_MID_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="call-mid-defs" targetNamespace="http://example.com">
  <bpmn:process id="call-mid-proc" isExecutable="true">
    <bpmn:startEvent id="md-start"/>
    <bpmn:sequenceFlow id="mdf1" sourceRef="md-start" targetRef="call2"/>
    <bpmn:callActivity id="call2" calledElement="call-leaf-proc"/>
    <bpmn:sequenceFlow id="mdf2" sourceRef="call2" targetRef="md-end"/>
    <bpmn:endEvent id="md-end"/>
  </bpmn:process>
</bpmn:definitions>`;

export const CALL_ROOT_3LEVEL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="call-root3-defs" targetNamespace="http://example.com">
  <bpmn:process id="call-root3-proc" isExecutable="true">
    <bpmn:startEvent id="rt-start"/>
    <bpmn:sequenceFlow id="rtf1" sourceRef="rt-start" targetRef="call1"/>
    <bpmn:callActivity id="call1" calledElement="call-mid-proc"/>
    <bpmn:sequenceFlow id="rtf2" sourceRef="call1" targetRef="rt-end"/>
    <bpmn:endEvent id="rt-end"/>
  </bpmn:process>
</bpmn:definitions>`;
