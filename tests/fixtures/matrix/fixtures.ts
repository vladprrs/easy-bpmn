// SESE-valid M4 combination-matrix BPMN fixtures (Phase-1 Task 3.1).
//
// Each export below is a complete BPMN model string. They mirror the structure
// of the canonical M4 fixtures in tests/helpers.ts (PARALLEL_BPMN /
// PARALLEL_SAGA_BPMN): standard bpmn namespace + xmlns:easy-bpmn, an
// <easy-bpmn:taskDefinition type=… retries=…/> inside <bpmn:extensionElements>
// on every serviceTask, and balanced parallel/inclusive split↔join regions that
// obey the SESE validator (src/bpmn/regions.ts). Like the boundary-timer test
// helpers, nodes omit the optional <bpmn:incoming>/<bpmn:outgoing> back-refs —
// adjacency is built from <bpmn:sequenceFlow> sourceRef/targetRef only.
//
// All ten VALID fixtures publish (validate) and start; the one REJECT fixture
// (PARALLEL_LOOP_CROSS_BPMN) is rejected at publish. See _publish.smoke.test.ts.
//
// =============================================================================
// DOWNSTREAM CONTRACT — task types, message names, steer vars, boundary ids.
// Matrix tests lease by these EXACT taskType strings, so they are stable.
// (`branch-settle` + steer var `failSettle` → errorCode SETTLE_REJECTED and
// `branch-b` + `hazardBranchB` are the only fixtures wired to REGISTERED sample
// workers — see src/runtime/service-task.ts. Every other taskType has no sample
// worker: drive it with leaseAndComplete / leaseOne + /jobs/{id}/fail, not
// drainSampleWorkers.)
//
// 1. PARALLEL_3ASYM_BPMN  (process; 3-branch AND, asymmetric branch lengths)
//      serviceTasks: asym-a | asym-b1→asym-b2→asym-b3 | (recvC) | post: asym-post
//      message:      "Mc"  (receiveTask recvC, the third branch)
//      steer vars:   none (forward completion only)
//      ids:          fork / join (parallelGateway)
//
// 2. PARALLEL_BRANCH_TIMER_BPMN  (process; AND, interrupting boundary timer on a branch)
//      serviceTasks: bt-a (timer host) , bt-b , bt-alt (timer-redirect target) , post: bt-post
//      steer vars:   none — fire the boundary timer to take the bt-alt path
//      boundary:     bt_timer  (interrupting, PT30S, attached to bt-a → bt-alt)
//      trick:        merge exclusiveGateway "Xa" before the join (see notes below)
//
// 3. OR_NEST_AND_BPMN  (process; inclusive OR split, nested AND inside branch b1)
//      serviceTasks: on-x | on-y (the nested AND) , on-single , on-log (default)
//      steer vars:   useParallel=true → branch b1 (nested AND); useSingle=true → b2;
//                    neither → default (on-log).  (≥1 always active via default)
//      ids:          orFork/orJoin (inclusiveGateway) , innerFork/innerJoin (parallelGateway)
//
// 4. PARALLEL_BRANCH_ITIMER_BPMN  (process; AND, intermediate catch timer in a branch)
//      serviceTasks: it-a → (it_catch timer) → it-a2 | it-b
//      steer vars:   none — fire the it_catch timer to advance the branch
//      element:      it_catch  (intermediateCatchEvent, timeDuration PT30S)
//
// 5. PARALLEL_SAGA_MULTISTEP_BPMN  (transaction; AND, 2-step compensatable chains)
//      serviceTasks: ms-a1→ms-a2 | ms-b1→ms-b2 ; post-join settle = branch-settle
//      comp handlers: comp-ms-a1 , comp-ms-a2 , comp-ms-b1 , comp-ms-b2
//      steer vars:   failSettle=true → settle business error (SETTLE_REJECTED) →
//                    Tx_cancel → per-lineage reverse compensation (a2,a1 / b2,b1)
//      error:        Err_settle / @errorCode SETTLE_REJECTED (boundary settle_err)
//
// 6. PARALLEL_NESTEDTX_BRANCH_BPMN  (outer transaction; AND, inner transaction in branch A)
//      serviceTasks: branchA: [inner tx: ntx-a1] → ntx-a2 ; branchB: ntx-b ; settle = branch-settle
//      comp handlers: comp-ntx-a1 (inner) , comp-ntx-a2 (outer) , comp-ntx-b (outer)
//      steer vars:   failSettle=true → outer Tx_cancel (inner already committed → not re-compensated)
//      error:        Err_settle / SETTLE_REJECTED
//
// 7. PARALLEL_LOOP_BRANCH_BPMN  (transaction; AND, loop wholly inside branch A)
//      serviceTasks: pl-a (looped, compensatable) | pl-b ; settle = branch-settle
//      comp handlers: comp-pl-a , comp-pl-b
//      steer vars:   loopAgain=true → re-execute pl-a (one ledger row per occurrence);
//                    failSettle=true → Tx_cancel → per-occurrence reverse compensation
//      error:        Err_settle / SETTLE_REJECTED
//      trick:        merge exclusiveGateway "Xm" BEFORE pl-a; split "Xa" loops to Xm (see notes)
//
// 8. PARALLEL_BRANCH_NOPATH_BPMN  (process; AND, XOR-with-no-default inside a branch)
//      serviceTasks: np-a → (Xn: 2 conditional out-flows, NO default) | np-b
//      steer vars:   routeHigh / routeLow — set NEITHER → Xn matches nothing → noPath incident
//      trick:        merge exclusiveGateway "Xp" gathers both Xn out-flows before the join
//
// 9. PARALLEL_LOOP_INBRANCH_BPMN  (process, NO transaction; AND, loop inside branch A)
//      serviceTasks: li-a (looped) | li-b
//      steer vars:   loopAgain=true → re-execute li-a (per-branch occurrence keying);
//                    spin=true → gateway SELF-LOOP (zero jobs) → burns MAX_ELEMENT_OCCURRENCES (loopLimit)
//      trick:        merge exclusiveGateway "Xm" before li-a; split "Xl" has loop / spin-self / default
//
// 10. PARALLEL_BRANCH_ERR_COMP_BPMN  (transaction; AND, error boundary redirect in a branch)
//      serviceTasks: ec-a (error host) → [error E1] → ec-alt | ec-b ; settle = branch-settle
//      comp handlers: comp-ec-alt , comp-ec-b   (ec-a, the FAILED step, owes no compensation)
//      steer vars:   fail ec-a with errorCode "E1" → redirect to ec-alt; failSettle=true → Tx_cancel
//      errors:       Err_e1 / @errorCode E1 (boundary ec_err) ; Err_settle / SETTLE_REJECTED
//      trick:        merge exclusiveGateway "Xa" rejoins ec-a normal path + ec-alt before the join
//
// 11. PARALLEL_LOOP_CROSS_BPMN  (REJECT — region-crossing loop)
//      Derived from PARALLEL_BPMN by adding one sequenceFlow from the post-join
//      node C back INTO branch-B's task B (a region member). Publish MUST reject.
//
// -----------------------------------------------------------------------------
// NON-OBVIOUS SESE TRICK (fixtures 2, 7, 8, 9, 10): a pass-through / merge
// exclusiveGateway placed just BEFORE the parallel join (or before a looped
// task). The SESE validator's rule 6 (no uncontrolled merge) rejects any
// service/receive task, intermediate catch, or non-gateway with >1 incoming
// flow INSIDE a region, and a parallel JOIN deadlocks unless every branch feeds
// it exactly ONE token edge. So when a branch has two internal sub-paths (normal
// completion + a timer/error redirect; or a loop back-edge), they are first
// merged at an exclusiveGateway (XOR = single-token, merge-safe and exempt from
// rule 6), which then feeds the join with a single edge. This keeps the region
// single-entry/single-exit and the AND-join token count correct.
// =============================================================================

import { PARALLEL_BPMN } from "../../helpers";

// ---------------------------------------------------------------------------
// XML fragment helpers (private; the exports are plain BPMN strings).
// ---------------------------------------------------------------------------

const svc = (id: string, type: string, retries?: string) =>
  `<bpmn:serviceTask id="${id}"><bpmn:extensionElements><easy-bpmn:taskDefinition type="${type}"${retries ? ` retries="${retries}"` : ""}/></bpmn:extensionElements></bpmn:serviceTask>`;
const compSvc = (id: string, type: string) =>
  `<bpmn:serviceTask id="${id}" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="${type}" retries="5"/></bpmn:extensionElements></bpmn:serviceTask>`;
const compBoundary = (id: string, host: string) =>
  `<bpmn:boundaryEvent id="${id}" attachedToRef="${host}"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>`;
const errBoundary = (id: string, host: string, errorRef: string) =>
  `<bpmn:boundaryEvent id="${id}" attachedToRef="${host}"><bpmn:errorEventDefinition errorRef="${errorRef}"/></bpmn:boundaryEvent>`;
const timerBoundary = (id: string, host: string, dur = "PT30S") =>
  `<bpmn:boundaryEvent id="${id}" cancelActivity="true" attachedToRef="${host}"><bpmn:timerEventDefinition><bpmn:timeDuration>${dur}</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>`;
const assoc = (id: string, src: string, tgt: string) =>
  `<bpmn:association id="${id}" associationDirection="One" sourceRef="${src}" targetRef="${tgt}"/>`;
const flow = (id: string, src: string, tgt: string) =>
  `<bpmn:sequenceFlow id="${id}" sourceRef="${src}" targetRef="${tgt}"/>`;
const cond = (id: string, src: string, tgt: string, feel: string) =>
  `<bpmn:sequenceFlow id="${id}" sourceRef="${src}" targetRef="${tgt}"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${feel}</bpmn:conditionExpression></bpmn:sequenceFlow>`;

const NS = `xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"`;
const NS_COND = `xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"`;

// Process-level cancel/transaction wrapper shared by the saga fixtures: a process
// Start → <transaction id> → Done, with the transaction's cancel boundary → Failed.
const sagaWrapper = (txInner: string, errors: string, txId = "Tx_par"): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS_COND} id="D_${txId}" targetNamespace="x">
  ${errors}
  <bpmn:process id="P_${txId}" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="${txId}">
      ${txInner}
    </bpmn:transaction>
    <bpmn:boundaryEvent id="Tx_cancelled" attachedToRef="${txId}"><bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:endEvent id="Done"/>
    <bpmn:endEvent id="Failed"/>
    ${flow("g1", "Start", txId)}
    ${flow("g2", txId, "Done")}
    ${flow("g3", "Tx_cancelled", "Failed")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// 1. PARALLEL_3ASYM_BPMN — 3-branch asymmetric AND (process level).
// ---------------------------------------------------------------------------
export const PARALLEL_3ASYM_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="D_asym" targetNamespace="x">
  <bpmn:message id="Mc" name="Mc"/>
  <bpmn:process id="P_asym" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:parallelGateway id="fork"/>
    ${svc("A", "asym-a")}
    ${svc("B1", "asym-b1")}
    ${svc("B2", "asym-b2")}
    ${svc("B3", "asym-b3")}
    <bpmn:receiveTask id="recvC" name="AwaitMc" messageRef="Mc"/>
    <bpmn:parallelGateway id="join"/>
    ${svc("postJoin", "asym-post")}
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "fork")}
    ${flow("f1", "fork", "A")}
    ${flow("f2", "fork", "B1")}
    ${flow("f3", "fork", "recvC")}
    ${flow("b12", "B1", "B2")}
    ${flow("b23", "B2", "B3")}
    ${flow("jA", "A", "join")}
    ${flow("jB", "B3", "join")}
    ${flow("jC", "recvC", "join")}
    ${flow("s1", "join", "postJoin")}
    ${flow("s2", "postJoin", "E")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// 2. PARALLEL_BRANCH_TIMER_BPMN — interrupting boundary timer on a branch task.
//    bt-a normal completion AND the bt_timer redirect to bt-alt both rejoin via
//    the merge exclusiveGateway Xa before the parallel join (rule-6-safe).
// ---------------------------------------------------------------------------
export const PARALLEL_BRANCH_TIMER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="D_btimer" targetNamespace="x">
  <bpmn:process id="P_btimer" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:parallelGateway id="fork"/>
    ${svc("svcA", "bt-a")}
    ${timerBoundary("bt_timer", "svcA")}
    ${svc("altA", "bt-alt")}
    <bpmn:exclusiveGateway id="Xa"/>
    ${svc("svcB", "bt-b")}
    <bpmn:parallelGateway id="join"/>
    ${svc("postJoin", "bt-post")}
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "fork")}
    ${flow("f1", "fork", "svcA")}
    ${flow("f2", "fork", "svcB")}
    ${flow("bt_f", "bt_timer", "altA")}
    ${flow("a_x", "svcA", "Xa")}
    ${flow("alt_x", "altA", "Xa")}
    ${flow("x_j", "Xa", "join")}
    ${flow("j_b", "svcB", "join")}
    ${flow("s1", "join", "postJoin")}
    ${flow("s2", "postJoin", "E")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// 3. OR_NEST_AND_BPMN — inclusive OR split; nested AND wholly inside OR-branch b1.
// ---------------------------------------------------------------------------
export const OR_NEST_AND_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS_COND} id="D_ornest" targetNamespace="x">
  <bpmn:process id="P_ornest" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:inclusiveGateway id="orFork" default="f_log"/>
    <bpmn:parallelGateway id="innerFork"/>
    ${svc("X", "on-x")}
    ${svc("Y", "on-y")}
    <bpmn:parallelGateway id="innerJoin"/>
    ${svc("single", "on-single")}
    ${svc("log", "on-log")}
    <bpmn:inclusiveGateway id="orJoin"/>
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "orFork")}
    ${cond("f_inner", "orFork", "innerFork", "useParallel = true")}
    ${cond("f_single", "orFork", "single", "useSingle = true")}
    ${flow("f_log", "orFork", "log")}
    ${flow("i1", "innerFork", "X")}
    ${flow("i2", "innerFork", "Y")}
    ${flow("k1", "X", "innerJoin")}
    ${flow("k2", "Y", "innerJoin")}
    ${flow("m1", "innerJoin", "orJoin")}
    ${flow("m2", "single", "orJoin")}
    ${flow("m3", "log", "orJoin")}
    ${flow("s1", "orJoin", "E")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// 4. PARALLEL_BRANCH_ITIMER_BPMN — intermediate catch timer inside a branch.
// ---------------------------------------------------------------------------
export const PARALLEL_BRANCH_ITIMER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="D_itimer" targetNamespace="x">
  <bpmn:process id="P_itimer" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:parallelGateway id="fork"/>
    ${svc("svcA", "it-a")}
    <bpmn:intermediateCatchEvent id="it_catch" name="Delay">
      <bpmn:timerEventDefinition><bpmn:timeDuration>PT30S</bpmn:timeDuration></bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    ${svc("svcA2", "it-a2")}
    ${svc("svcB", "it-b")}
    <bpmn:parallelGateway id="join"/>
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "fork")}
    ${flow("f1", "fork", "svcA")}
    ${flow("f2", "fork", "svcB")}
    ${flow("a_ic", "svcA", "it_catch")}
    ${flow("ic_a2", "it_catch", "svcA2")}
    ${flow("jA", "svcA2", "join")}
    ${flow("jB", "svcB", "join")}
    ${flow("s1", "join", "E")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// 5. PARALLEL_SAGA_MULTISTEP_BPMN — AND fork/join inside a transaction, each
//    branch a 2-task chain, every task with its own compensation handler.
// ---------------------------------------------------------------------------
export const PARALLEL_SAGA_MULTISTEP_BPMN = sagaWrapper(
  `<bpmn:startEvent id="Tx_start"/>
      <bpmn:parallelGateway id="fork"/>
      ${svc("A1", "ms-a1", "2")}
      ${compBoundary("A1_comp", "A1")}
      ${compSvc("compA1", "comp-ms-a1")}
      ${assoc("aA1", "A1_comp", "compA1")}
      ${svc("A2", "ms-a2", "2")}
      ${compBoundary("A2_comp", "A2")}
      ${compSvc("compA2", "comp-ms-a2")}
      ${assoc("aA2", "A2_comp", "compA2")}
      ${svc("B1", "ms-b1", "2")}
      ${compBoundary("B1_comp", "B1")}
      ${compSvc("compB1", "comp-ms-b1")}
      ${assoc("aB1", "B1_comp", "compB1")}
      ${svc("B2", "ms-b2", "2")}
      ${compBoundary("B2_comp", "B2")}
      ${compSvc("compB2", "comp-ms-b2")}
      ${assoc("aB2", "B2_comp", "compB2")}
      <bpmn:parallelGateway id="join"/>
      ${svc("settle", "branch-settle", "1")}
      ${errBoundary("settle_err", "settle", "Err_settle")}
      <bpmn:endEvent id="Tx_ok"/>
      <bpmn:endEvent id="Tx_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      ${flow("tx0", "Tx_start", "fork")}
      ${flow("fa", "fork", "A1")}
      ${flow("fb", "fork", "B1")}
      ${flow("a12", "A1", "A2")}
      ${flow("b12", "B1", "B2")}
      ${flow("jA", "A2", "join")}
      ${flow("jB", "B2", "join")}
      ${flow("tj", "join", "settle")}
      ${flow("tok", "settle", "Tx_ok")}
      ${flow("fe", "settle_err", "Tx_cancel")}`,
  `<bpmn:error id="Err_settle" name="Settle rejected" errorCode="SETTLE_REJECTED"/>`,
  "Tx_par",
);

// ---------------------------------------------------------------------------
// 6. PARALLEL_NESTEDTX_BRANCH_BPMN — a nested transaction is ONE node inside
//    branch A of an outer AND region; branch B is a single compensatable task.
// ---------------------------------------------------------------------------
export const PARALLEL_NESTEDTX_BRANCH_BPMN = sagaWrapper(
  `<bpmn:startEvent id="Tx_outer_start"/>
      <bpmn:parallelGateway id="fork"/>
      <bpmn:transaction id="Tx_inner">
        <bpmn:startEvent id="Tx_inner_start"/>
        ${svc("a1", "ntx-a1", "2")}
        ${compBoundary("a1_comp", "a1")}
        ${compSvc("compA1", "comp-ntx-a1")}
        ${assoc("aA1", "a1_comp", "compA1")}
        <bpmn:endEvent id="Tx_inner_ok"/>
        ${flow("ix0", "Tx_inner_start", "a1")}
        ${flow("ix1", "a1", "Tx_inner_ok")}
      </bpmn:transaction>
      ${svc("a2", "ntx-a2", "2")}
      ${compBoundary("a2_comp", "a2")}
      ${compSvc("compA2", "comp-ntx-a2")}
      ${assoc("aA2", "a2_comp", "compA2")}
      ${svc("branchB", "ntx-b", "2")}
      ${compBoundary("branchB_comp", "branchB")}
      ${compSvc("compB", "comp-ntx-b")}
      ${assoc("aB", "branchB_comp", "compB")}
      <bpmn:parallelGateway id="join"/>
      ${svc("settle", "branch-settle", "1")}
      ${errBoundary("settle_err", "settle", "Err_settle")}
      <bpmn:endEvent id="Tx_outer_ok"/>
      <bpmn:endEvent id="Tx_outer_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      ${flow("ox0", "Tx_outer_start", "fork")}
      ${flow("ofa", "fork", "Tx_inner")}
      ${flow("ofb", "fork", "branchB")}
      ${flow("oa", "Tx_inner", "a2")}
      ${flow("ja", "a2", "join")}
      ${flow("jb", "branchB", "join")}
      ${flow("tj", "join", "settle")}
      ${flow("tok", "settle", "Tx_outer_ok")}
      ${flow("fe", "settle_err", "Tx_outer_cancel")}`,
  `<bpmn:error id="Err_settle" name="Settle rejected" errorCode="SETTLE_REJECTED"/>`,
  "Tx_outer",
);

// ---------------------------------------------------------------------------
// 7. PARALLEL_LOOP_BRANCH_BPMN — loop wholly inside branch A of an AND region
//    inside a transaction. Merge gateway Xm absorbs the loop back-edge so the
//    looped task pl-a keeps a single incoming flow (rule-6-safe).
// ---------------------------------------------------------------------------
export const PARALLEL_LOOP_BRANCH_BPMN = sagaWrapper(
  `<bpmn:startEvent id="Tx_start"/>
      <bpmn:parallelGateway id="fork"/>
      <bpmn:exclusiveGateway id="Xm"/>
      ${svc("svcA", "pl-a", "2")}
      ${compBoundary("svcA_comp", "svcA")}
      ${compSvc("compA", "comp-pl-a")}
      ${assoc("aA", "svcA_comp", "compA")}
      <bpmn:exclusiveGateway id="Xa" default="x_done"/>
      ${svc("svcB", "pl-b", "2")}
      ${compBoundary("svcB_comp", "svcB")}
      ${compSvc("compB", "comp-pl-b")}
      ${assoc("aB", "svcB_comp", "compB")}
      <bpmn:parallelGateway id="join"/>
      ${svc("settle", "branch-settle", "1")}
      ${errBoundary("settle_err", "settle", "Err_settle")}
      <bpmn:endEvent id="Tx_ok"/>
      <bpmn:endEvent id="Tx_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      ${flow("tx0", "Tx_start", "fork")}
      ${flow("fa", "fork", "Xm")}
      ${flow("fb", "fork", "svcB")}
      ${flow("xm_a", "Xm", "svcA")}
      ${flow("a_x", "svcA", "Xa")}
      ${cond("x_loop", "Xa", "Xm", "loopAgain = true")}
      ${flow("x_done", "Xa", "join")}
      ${flow("jb", "svcB", "join")}
      ${flow("tj", "join", "settle")}
      ${flow("tok", "settle", "Tx_ok")}
      ${flow("fe", "settle_err", "Tx_cancel")}`,
  `<bpmn:error id="Err_settle" name="Settle rejected" errorCode="SETTLE_REJECTED"/>`,
  "Tx_loop",
);

// ---------------------------------------------------------------------------
// 8. PARALLEL_BRANCH_NOPATH_BPMN — an XOR split with NO default inside an AND
//    branch. Both conditional out-flows merge at Xp before the join; if neither
//    condition holds at runtime the drive hits a noPath incident on Xn.
// ---------------------------------------------------------------------------
export const PARALLEL_BRANCH_NOPATH_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS_COND} id="D_nopath" targetNamespace="x">
  <bpmn:process id="P_nopath" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:parallelGateway id="fork"/>
    ${svc("svcA", "np-a")}
    <bpmn:exclusiveGateway id="Xn"/>
    <bpmn:exclusiveGateway id="Xp"/>
    ${svc("svcB", "np-b")}
    <bpmn:parallelGateway id="join"/>
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "fork")}
    ${flow("f1", "fork", "svcA")}
    ${flow("f2", "fork", "svcB")}
    ${flow("a_xn", "svcA", "Xn")}
    ${cond("xn_hi", "Xn", "Xp", "routeHigh = true")}
    ${cond("xn_lo", "Xn", "Xp", "routeLow = true")}
    ${flow("xp_j", "Xp", "join")}
    ${flow("j_b", "svcB", "join")}
    ${flow("s1", "join", "E")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// 9. PARALLEL_LOOP_INBRANCH_BPMN — loop wholly inside an AND branch, process
//    level (NO transaction). Merge gateway Xm absorbs the loop back-edge; the
//    split Xl also carries a self-loop (spin) to burn MAX_ELEMENT_OCCURRENCES.
// ---------------------------------------------------------------------------
export const PARALLEL_LOOP_INBRANCH_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS_COND} id="D_loopin" targetNamespace="x">
  <bpmn:process id="P_loopin" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:parallelGateway id="fork"/>
    <bpmn:exclusiveGateway id="Xm"/>
    ${svc("svcA", "li-a")}
    <bpmn:exclusiveGateway id="Xl" default="xl_done"/>
    ${svc("svcB", "li-b")}
    <bpmn:parallelGateway id="join"/>
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "fork")}
    ${flow("f1", "fork", "Xm")}
    ${flow("f2", "fork", "svcB")}
    ${flow("xm_a", "Xm", "svcA")}
    ${flow("a_xl", "svcA", "Xl")}
    ${cond("xl_loop", "Xl", "Xm", "loopAgain = true")}
    ${cond("xl_spin", "Xl", "Xl", "spin = true")}
    ${flow("xl_done", "Xl", "join")}
    ${flow("j_b", "svcB", "join")}
    ${flow("s1", "join", "E")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// 10. PARALLEL_BRANCH_ERR_COMP_BPMN — error-boundary redirect inside an AND
//     branch (transaction). ec-a's normal completion AND its error redirect to
//     ec-alt both rejoin via the merge gateway Xa before the join.
// ---------------------------------------------------------------------------
export const PARALLEL_BRANCH_ERR_COMP_BPMN = sagaWrapper(
  `<bpmn:startEvent id="Tx_start"/>
      <bpmn:parallelGateway id="fork"/>
      ${svc("svcA", "ec-a", "1")}
      ${errBoundary("ec_err", "svcA", "Err_e1")}
      ${svc("altA", "ec-alt", "2")}
      ${compBoundary("altA_comp", "altA")}
      ${compSvc("compAlt", "comp-ec-alt")}
      ${assoc("aAlt", "altA_comp", "compAlt")}
      <bpmn:exclusiveGateway id="Xa"/>
      ${svc("svcB", "ec-b", "2")}
      ${compBoundary("svcB_comp", "svcB")}
      ${compSvc("compB", "comp-ec-b")}
      ${assoc("aB", "svcB_comp", "compB")}
      <bpmn:parallelGateway id="join"/>
      ${svc("settle", "branch-settle", "1")}
      ${errBoundary("settle_err", "settle", "Err_settle")}
      <bpmn:endEvent id="Tx_ok"/>
      <bpmn:endEvent id="Tx_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      ${flow("tx0", "Tx_start", "fork")}
      ${flow("fa", "fork", "svcA")}
      ${flow("fb", "fork", "svcB")}
      ${flow("a_x", "svcA", "Xa")}
      ${flow("ea", "ec_err", "altA")}
      ${flow("alt_x", "altA", "Xa")}
      ${flow("x_j", "Xa", "join")}
      ${flow("jb", "svcB", "join")}
      ${flow("tj", "join", "settle")}
      ${flow("tok", "settle", "Tx_ok")}
      ${flow("fe", "settle_err", "Tx_cancel")}`,
  `<bpmn:error id="Err_e1" name="Branch A error" errorCode="E1"/>
  <bpmn:error id="Err_settle" name="Settle rejected" errorCode="SETTLE_REJECTED"/>`,
  "Tx_errcomp",
);

// ---------------------------------------------------------------------------
// 11. PARALLEL_LOOP_CROSS_BPMN — REJECT. PARALLEL_BPMN (fork→{A,B}→join→C→E)
//     with an extra sequenceFlow from the post-join node C back into branch-B's
//     task B (a region member): B gains a second incoming inside the region
//     (uncontrolled merge) and the loop crosses the region boundary. Publish
//     MUST reject (region-crossing loop / branch escape).
// ---------------------------------------------------------------------------
export const PARALLEL_LOOP_CROSS_BPMN = PARALLEL_BPMN.replace(
  '<bpmn:sequenceFlow id="s2" sourceRef="C" targetRef="E"/>',
  '<bpmn:sequenceFlow id="s2" sourceRef="C" targetRef="E"/>\n    <bpmn:sequenceFlow id="cross" sourceRef="C" targetRef="B"/>',
);

// =============================================================================
// REJECT fixtures (Phase-1 Task 4.1). Each violates EXACTLY ONE profile/SESE
// rule and MUST be rejected at publish with the offending element id. Validator
// citations are src/bpmn/validator.ts (vN) and src/bpmn/regions.ts (rN). These
// pair with tests/matrix/reject.test.ts; the four REUSED rejects
// (R-JOIN-MISMATCH, R-SAMEMSG, R-INSTANTIATE from tests/helpers.ts; R-LOOP-CROSS
// = PARALLEL_LOOP_CROSS_BPMN above) are imported there, not re-authored here.
// =============================================================================

// ---------------------------------------------------------------------------
// R_BOUNDARY_ON_GW_BPMN — a boundaryEvent attached to a gateway. The validator's
// explicit "Boundary events cannot be attached to gateways" message
// (validator.ts:1016-1024) keys on exclusiveGateway, so the gateway here is a
// 1-in/1-out exclusiveGateway pass-through (valid on its own — see
// PASSTHROUGH_GATEWAY_BPMN) carrying an error boundary. (A parallelGateway host
// instead trips the per-kind "boundary timer/error must attach to a service
// task" rule, validator.ts:1102/1186 — same boundary∧gateway reason class, but
// not the cited line; exclusiveGateway isolates the cited rule exactly.)
// ---------------------------------------------------------------------------
export const R_BOUNDARY_ON_GW_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="D_bgw" targetNamespace="x">
  <bpmn:process id="P_bgw" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:exclusiveGateway id="GW"/>
    <bpmn:boundaryEvent id="bad_b" attachedToRef="GW"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>
    <bpmn:endEvent id="E"/>
    <bpmn:endEvent id="E2"/>
    ${flow("s0", "S", "GW")}
    ${flow("ge", "GW", "E")}
    ${flow("be", "bad_b", "E2")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// R_MERGE_UNCONTROLLED_BPMN — a 3-branch AND where two branches (A, B) merge at a
// serviceTask M (2 incoming) while the third (C) bypasses M to the join, so M is
// a region member (NOT the post-dominator) and rule 6 fires on it — an
// uncontrolled merge: a non-gateway with >1 incoming inside a region
// (regions.ts:188-200). A simple 2-branch all-merge at M would instead make M the
// post-dominator and reject as "no matching join" (rule 3), so the bypass branch
// is essential to isolate rule 6's "executed twice" reason.
// ---------------------------------------------------------------------------
export const R_MERGE_UNCONTROLLED_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="D_unc" targetNamespace="x">
  <bpmn:process id="P_unc" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:parallelGateway id="fork"/>
    ${svc("A", "unc-a")}
    ${svc("B", "unc-b")}
    ${svc("C", "unc-c")}
    ${svc("M", "unc-merge")}
    <bpmn:parallelGateway id="join"/>
    ${svc("post", "unc-post")}
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "fork")}
    ${flow("f1", "fork", "A")}
    ${flow("f2", "fork", "B")}
    ${flow("f3", "fork", "C")}
    ${flow("am", "A", "M")}
    ${flow("bm", "B", "M")}
    ${flow("cj", "C", "join")}
    ${flow("mj", "M", "join")}
    ${flow("s1", "join", "post")}
    ${flow("s2", "post", "E")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// R_JOIN_NOFORK_BPMN — a parallelGateway used as a JOIN (2 incoming, 1 outgoing)
// fed by two branches of an exclusiveGateway split. An XOR split is NOT a
// parallel/inclusive split, so no region matches this join: the "other half"
// bijection check flags it as an unmatched multi-incoming parallel/inclusive
// gateway (regions.ts:224-227). The XOR split carries one FEEL condition + a
// default so it is itself valid and the only fault is the dangling join.
// ---------------------------------------------------------------------------
export const R_JOIN_NOFORK_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS_COND} id="D_nofork" targetNamespace="x">
  <bpmn:process id="P_nofork" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:exclusiveGateway id="Xs" default="fb"/>
    ${svc("A", "nf-a")}
    ${svc("B", "nf-b")}
    <bpmn:parallelGateway id="join"/>
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "Xs")}
    ${cond("fa", "Xs", "A", "go = true")}
    ${flow("fb", "Xs", "B")}
    ${flow("ja", "A", "join")}
    ${flow("jb", "B", "join")}
    ${flow("s1", "join", "E")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// R_MERGE_NONLAMINAR_BPMN — an improperly-nested pair of AND splits that share a
// single join J: outer fork F1 → {F2, B}, inner fork F2 → {A, C}, all of A/B/C →
// J. F1 matches J (J post-dominates F1 and is dominated by F1), but F2's ipdom is
// ALSO J, which F2 does not dominate, so F2 trips the single-entry guard
// ("region nesting must be properly balanced", regions.ts:163-165). NOTE: a TRUE
// partial overlap (neither region nesting in the other) is unreachable — two
// canonically-SESE dom/post-dom regions are always laminar, so the dedicated
// laminar pairwise check (regions.ts:230-244) cannot fire for two regions that
// both FORM; the interleaving is caught one step earlier as a single-entry
// violation. See reject.test.ts / the task report.
// ---------------------------------------------------------------------------
export const R_MERGE_NONLAMINAR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="D_nonlam" targetNamespace="x">
  <bpmn:process id="P_nonlam" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:parallelGateway id="F1"/>
    <bpmn:parallelGateway id="F2"/>
    ${svc("A", "nl-a")}
    ${svc("B", "nl-b")}
    ${svc("C", "nl-c")}
    <bpmn:parallelGateway id="J"/>
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "F1")}
    ${flow("f1f2", "F1", "F2")}
    ${flow("f1b", "F1", "B")}
    ${flow("f2a", "F2", "A")}
    ${flow("f2c", "F2", "C")}
    ${flow("aj", "A", "J")}
    ${flow("cj", "C", "J")}
    ${flow("bj", "B", "J")}
    ${flow("je", "J", "E")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// R_NONINT_TIMER_BPMN — a serviceTask with a NON-interrupting boundary timer
// (cancelActivity="false"). Only interrupting boundary timers are supported; a
// non-interrupting one needs a second token (validator.ts:493-499). The timer is
// otherwise well-formed (static PT30S, one outgoing) so the cancelActivity bit is
// the only fault. (timerBoundary() hardcodes cancelActivity="true", so the
// boundary is written inline here.)
// ---------------------------------------------------------------------------
export const R_NONINT_TIMER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="D_nonint" targetNamespace="x">
  <bpmn:process id="P_nonint" isExecutable="true">
    <bpmn:startEvent id="S"/>
    ${svc("svcA", "ni-a")}
    <bpmn:boundaryEvent id="bt" cancelActivity="false" attachedToRef="svcA"><bpmn:timerEventDefinition><bpmn:timeDuration>PT30S</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    ${svc("alt", "ni-alt")}
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "svcA")}
    ${flow("ae", "svcA", "E")}
    ${flow("bt_alt", "bt", "alt")}
    ${flow("alt_e", "alt", "E")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// R_COND_OFF_XOR_BPMN — a balanced AND region whose fork carries a
// conditionExpression on one out-flow (f1). Conditions are only legal on
// outgoing flows of an exclusive/inclusive gateway; a condition leaving a
// parallelGateway is rejected on element presence (validator.ts:777-784). The
// region is otherwise balanced, so the conditional fork flow is the only fault.
// ---------------------------------------------------------------------------
export const R_COND_OFF_XOR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS_COND} id="D_condx" targetNamespace="x">
  <bpmn:process id="P_condx" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:parallelGateway id="fork"/>
    ${svc("A", "cx-a")}
    ${svc("B", "cx-b")}
    <bpmn:parallelGateway id="join"/>
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "fork")}
    ${cond("f1", "fork", "A", "go = true")}
    ${flow("f2", "fork", "B")}
    ${flow("ja", "A", "join")}
    ${flow("jb", "B", "join")}
    ${flow("s1", "join", "E")}
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// R_BRANCH_ESCAPE_BPMN — a member of an AND region edges OUT of the region
// without passing through the join (branch confinement, regions.ts:204-211).
// Branch B ends at an exclusiveGateway Xb that routes either to the join (normal)
// or BACK to the pre-fork task P (default) — that back-edge target P is not a
// region member, so Xb's escaping edge trips rule 5. (A serviceTask's own edge
// could not escape without becoming a >1-outgoing "implicit split"; routing to a
// post-join node would instead change the post-dominator and reject as "no
// matching join". The pre-fork back-edge keeps the join match intact and isolates
// the confinement reason; P's resulting 2 incoming flows are legal off-region.)
// ---------------------------------------------------------------------------
export const R_BRANCH_ESCAPE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS_COND} id="D_escape" targetNamespace="x">
  <bpmn:process id="P_escape" isExecutable="true">
    <bpmn:startEvent id="S"/>
    ${svc("P", "esc-p")}
    <bpmn:parallelGateway id="fork"/>
    ${svc("A", "esc-a")}
    ${svc("B", "esc-b")}
    <bpmn:exclusiveGateway id="Xb" default="xb_back"/>
    <bpmn:parallelGateway id="join"/>
    ${svc("post", "esc-post")}
    <bpmn:endEvent id="E"/>
    ${flow("s0", "S", "P")}
    ${flow("p1", "P", "fork")}
    ${flow("f1", "fork", "A")}
    ${flow("f2", "fork", "B")}
    ${flow("ja", "A", "join")}
    ${flow("bxb", "B", "Xb")}
    ${cond("xb_j", "Xb", "join", "done = true")}
    ${flow("xb_back", "Xb", "P")}
    ${flow("s1", "join", "post")}
    ${flow("s2", "post", "E")}
  </bpmn:process>
</bpmn:definitions>`;
