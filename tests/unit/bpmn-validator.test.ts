import { describe, expect, it } from "vitest";
import { parseAndValidate } from "../../src/bpmn/validator";
import { roundTripBpmnXml } from "../../src/bpmn/parser";
import {
  CALL_ACTIVITY_BPMN,
  CONDITIONAL_FLOW_BPMN,
  DEMO_BPMN,
  deferredGatewayBpmn,
  EMPTY_MESSAGE_NAME_BPMN,
  INSTANTIATE_RECEIVE_BPMN,
  INTERMEDIATE_CATCH_BPMN,
  LOOP_XOR_BPMN,
  MALFORMED_XML,
  MULTI_INSTANCE_BPMN,
  NO_TASKTYPE_BPMN,
  PARALLEL_BPMN,
  INCLUSIVE_BPMN,
  PARALLEL_DEADLOCK_BPMN,
  PARALLEL_MISMATCH_BPMN,
  PARALLEL_SAME_MESSAGE_BPMN,
  PASSTHROUGH_GATEWAY_BPMN,
  SAGA_BPMN,
  SAGA_CANCEL_BOUNDARY_ON_TASK_BPMN,
  SAGA_CANCEL_END_OUTSIDE_TX_BPMN,
  SAGA_CROSS_SCOPE_ASSOC_BPMN,
  SAGA_TOLERANT_BPMN,
  SAGA_XOR_BPMN,
  SEND_TASK_BPMN,
  SUBPROCESS_BPMN,
  sagaBpmn,
  TIMER_START_BPMN,
  TOLERANT_BPMN,
  USERTASK_BPMN,
  XOR_BPMN,
  XOR_IN_TX_BPMN,
  XOR_TOLERANT_BPMN,
} from "../helpers";

function reasons(issues: { reason: string }[]): string {
  return issues.map((i) => i.reason).join(" | ");
}

describe("BPMN-lite profile validator", () => {
  it("accepts the canonical happy path and extracts the graph", async () => {
    const r = await parseAndValidate(DEMO_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    const g = r.graph!;
    expect(g.startElementId).toBe("Start_1");
    expect(g.nodes["Task_check"]?.type).toBe("serviceTask");
    expect(g.nodes["Task_check"]?.taskType).toBe("external-check");
    expect(g.nodes["Task_check"]?.retries).toBe(3);
    expect(g.nodes["Task_wait"]?.type).toBe("receiveTask");
    expect(g.nodes["Task_wait"]?.messageName).toBe("ApprovalReceived");
    // linear successor chain
    expect(g.nodes["Start_1"]?.next).toBe("Task_check");
    expect(g.nodes["Task_check"]?.next).toBe("Task_wait");
    expect(g.nodes["Task_wait"]?.next).toBe("End_1");
    expect(g.nodes["End_1"]?.next).toBeNull();
  });

  it("tolerates ignorable content (foreign extensions, documentation, DI)", async () => {
    const r = await parseAndValidate(TOLERANT_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    expect(r.graph!.nodes["Task_check"]?.taskType).toBe("external-check");
    expect(r.graph!.nodes["Task_check"]?.retries).toBe(2);
  });

  // TASK-33 (M2): exclusiveGateway flipped reject→accept. The deferred gateway
  // TYPES (parallel/inclusive/eventBased/complex) keep the reject contract —
  // covered in the TASK-33 describe block below.
  it("accepts a 1-in/1-out pass-through exclusive gateway (no conditions needed)", async () => {
    const r = await parseAndValidate(PASSTHROUGH_GATEWAY_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    expect(r.graph!.nodes["G"]?.type).toBe("exclusiveGateway");
  });

  it("rejects a user task", async () => {
    const r = await parseAndValidate(USERTASK_BPMN);
    expect(r.ok).toBe(false);
    expect(reasons(r.issues)).toMatch(/userTask/);
  });

  it("rejects a timer start event", async () => {
    const r = await parseAndValidate(TIMER_START_BPMN);
    expect(r.ok).toBe(false);
    expect(reasons(r.issues)).toMatch(/timer|none start/i);
  });

  it("rejects a service task with no easy-bpmn:taskDefinition type", async () => {
    const r = await parseAndValidate(NO_TASKTYPE_BPMN);
    expect(r.ok).toBe(false);
    expect(reasons(r.issues)).toMatch(/taskDefinition type/);
  });

  it("rejects an instantiating receive task", async () => {
    const r = await parseAndValidate(INSTANTIATE_RECEIVE_BPMN);
    expect(r.ok).toBe(false);
    expect(reasons(r.issues)).toMatch(/instantiate/);
  });

  // TASK-33 (M2): conditions are now legal on exclusiveGateway outgoing flows,
  // so the M1 blanket conditional-flow reject narrowed to "not leaving an
  // exclusive gateway" — covered by CONDITIONAL_FLOW_BPMN in the
  // "Exclusive-gateway reject matrix" describe below.

  it("rejects a Service Task with multi-instance loop characteristics", async () => {
    const r = await parseAndValidate(MULTI_INSTANCE_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "T" && /loop or multi-instance/i.test(i.reason))).toBe(true);
  });

  it("rejects a Receive Task whose <message> has no name", async () => {
    const r = await parseAndValidate(EMPTY_MESSAGE_NAME_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "R" && /no name|non-empty message name/i.test(i.reason))).toBe(true);
  });

  // M5-L1 widened the accept matrix: an embedded subProcess is now a
  // supported construct (see "M5-L1 embedded subProcess acceptance" below).
  // SUBPROCESS_BPMN is an empty subprocess (no inner start/end event), so it
  // is still rejected — now for structural reasons, not "unsupported construct".
  it("rejects an embedded subprocess with no inner start event (structurally invalid)", async () => {
    const r = await parseAndValidate(SUBPROCESS_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "SP" && /none start event/.test(i.reason))).toBe(true);
  });

  it("rejects a send task", async () => {
    const r = await parseAndValidate(SEND_TASK_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "T" && /sendTask/.test(i.reason))).toBe(true);
  });

  it("accepts a STANDALONE message intermediate catch event (M3-L4, TASK-46)", async () => {
    const r = await parseAndValidate(INTERMEDIATE_CATCH_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    const ic = r.graph!.nodes["IC"];
    expect(ic?.type).toBe("intermediateCatchEvent");
    expect(ic?.messageName).toBe("Ping");
    expect(ic?.timerTrigger ?? null).toBeNull();
    expect(ic?.next).toBe("E");
  });

  it("rejects malformed XML before validation", async () => {
    const r = await parseAndValidate(MALFORMED_XML);
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.reason).toMatch(/well-formed|parseable/i);
  });

  it("rejects a call activity (composition deferred)", async () => {
    const r = await parseAndValidate(CALL_ACTIVITY_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "CA" && /callActivity/.test(i.reason))).toBe(true);
  });
});

describe("Canonical transaction-saga profile (SAGA design §3)", () => {
  it("accepts the §3 order-saga example and extracts the saga snapshot", async () => {
    const r = await parseAndValidate(SAGA_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    const g = r.graph!;
    // transaction scope + membership
    expect(g.nodes["Tx_order"]?.type).toBe("transaction");
    expect(g.transactions?.["Tx_order"]?.startId).toBe("Tx_start");
    expect(g.transactions?.["Tx_order"]?.childIds).toContain("reserveStock");
    // reverse-order compensation wiring is captured for both compensatable steps
    expect(g.transactions?.["Tx_order"]?.compensations["reserveStock"]?.handlerId).toBe("releaseStock");
    expect(g.transactions?.["Tx_order"]?.compensations["chargeCard"]?.handlerId).toBe("refundCard");
    // boundary kinds
    expect(g.nodes["shipping_err"]?.boundaryKind).toBe("error");
    expect(g.nodes["shipping_err"]?.errorCode).toBe("SHIPPING_REJECTED");
    expect(g.nodes["Tx_cancelled"]?.boundaryKind).toBe("cancel");
    expect(g.nodes["reserveStock_comp"]?.boundaryKind).toBe("compensate");
    // cancel end vs none end
    expect(g.nodes["Tx_cancel"]?.endKind).toBe("cancel");
    expect(g.nodes["Tx_ok"]?.endKind).toBe("none");
    // handlers flagged + scoped
    expect(g.nodes["releaseStock"]?.isForCompensation).toBe(true);
    expect(g.nodes["releaseStock"]?.scopeId).toBe("Tx_order");
  });

  it("tolerates ignorable content on a saga (foreign extensions, DI, documentation)", async () => {
    const r = await parseAndValidate(SAGA_TOLERANT_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("semantically round-trips the §3 example through bpmn-moddle (canonicity R3)", async () => {
    const out = await roundTripBpmnXml(SAGA_BPMN);
    // standard elements survive re-serialization
    expect(out).toMatch(/bpmn:transaction/i);
    expect(out).toMatch(/compensateEventDefinition/);
    expect(out).toMatch(/cancelEventDefinition/);
    expect(out).toMatch(/errorEventDefinition/);
    expect(out).toMatch(/isForCompensation="true"/);
    // and the re-serialized file still validates
    const r = await parseAndValidate(out);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("accepts the minimal one-transaction saga builder by default", async () => {
    const r = await parseAndValidate(sagaBpmn());
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("rejects a compensation boundary with an outgoing sequence flow", async () => {
    const r = await parseAndValidate(
      sagaBpmn({ innerExtra: `<bpmn:sequenceFlow id="bad" sourceRef="stepA_comp" targetRef="Tx_ok"/>` }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "stepA_comp" && /zero outgoing/.test(i.reason))).toBe(true);
  });

  it("rejects a compensation boundary with no association", async () => {
    const r = await parseAndValidate(sagaBpmn({ assoc: "" }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "stepA_comp" && /exactly one outgoing <association>/.test(i.reason))).toBe(true);
  });

  it("rejects a compensation boundary with multiple associations", async () => {
    const r = await parseAndValidate(
      sagaBpmn({
        assoc:
          `<bpmn:association id="a1" associationDirection="One" sourceRef="stepA_comp" targetRef="undoA"/>` +
          `<bpmn:association id="a1b" associationDirection="One" sourceRef="stepA_comp" targetRef="undoA"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "stepA_comp" && /exactly one outgoing <association>/.test(i.reason))).toBe(true);
  });

  it("rejects a compensation association targeting a non-handler activity", async () => {
    const r = await parseAndValidate(
      sagaBpmn({ assoc: `<bpmn:association id="a1" associationDirection="One" sourceRef="stepA_comp" targetRef="stepB"/>` }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "stepA_comp" && /isForCompensation/.test(i.reason))).toBe(true);
  });

  it("rejects a compensation association crossing transaction scopes", async () => {
    const r = await parseAndValidate(SAGA_CROSS_SCOPE_ASSOC_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "a1step_comp" && /different transaction scope/.test(i.reason))).toBe(true);
  });

  it("rejects an error boundary whose errorRef does not resolve", async () => {
    const r = await parseAndValidate(
      sagaBpmn({ errBoundary: `<bpmn:boundaryEvent id="stepB_err" attachedToRef="stepB"><bpmn:errorEventDefinition errorRef="Err_missing"/></bpmn:boundaryEvent>` }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "stepB_err" && /does not resolve to a declared/.test(i.reason))).toBe(true);
  });

  it("rejects a cancel end event outside any transaction", async () => {
    const r = await parseAndValidate(SAGA_CANCEL_END_OUTSIDE_TX_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "ProcCancel" && /only inside a <transaction>/.test(i.reason))).toBe(true);
  });

  it("rejects a cancel boundary attached to a non-transaction activity", async () => {
    const r = await parseAndValidate(SAGA_CANCEL_BOUNDARY_ON_TASK_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "bad_cancel" && /attached to a <transaction>/.test(i.reason))).toBe(true);
  });
});

describe("Multi-edge IR: outgoing[] (TASK-11 closeout, design §3.1)", () => {
  // The engine-facing multi-edge shape: GraphNode.outgoing carries the full
  // Flow[] (flowId + targetId), with `next` derived as outgoing[0].targetId so
  // the single-token engine is unchanged. conditionExpression/isDefault are the
  // M2 hook — always null/false in M1 (the validator still rejects them).
  it("exposes every forward node's outgoing[] with the right flowId + targetId", async () => {
    const r = await parseAndValidate(SAGA_BPMN);
    expect(r.ok).toBe(true);
    const n = r.graph!.nodes;

    // process-level edges
    expect(n["Start"]!.outgoing).toEqual([{ flowId: "g1", targetId: "Tx_order", conditionExpression: null, isDefault: false }]);
    expect(n["Tx_order"]!.outgoing).toEqual([{ flowId: "g2", targetId: "SagaDone", conditionExpression: null, isDefault: false }]);
    // boundary events DO carry their single routing flow on the token path
    expect(n["Tx_cancelled"]!.outgoing).toEqual([{ flowId: "g3", targetId: "SagaFailed", conditionExpression: null, isDefault: false }]);
    expect(n["shipping_err"]!.outgoing).toEqual([{ flowId: "f5", targetId: "Tx_cancel", conditionExpression: null, isDefault: false }]);

    // inner transaction forward chain f1..f4
    expect(n["Tx_start"]!.outgoing.map((f) => [f.flowId, f.targetId])).toEqual([["f1", "reserveStock"]]);
    expect(n["reserveStock"]!.outgoing.map((f) => [f.flowId, f.targetId])).toEqual([["f2", "chargeCard"]]);
    expect(n["chargeCard"]!.outgoing.map((f) => [f.flowId, f.targetId])).toEqual([["f3", "confirmShipping"]]);
    expect(n["confirmShipping"]!.outgoing.map((f) => [f.flowId, f.targetId])).toEqual([["f4", "Tx_ok"]]);
  });

  it("keeps `next` derived as outgoing[0]?.targetId for every node", async () => {
    const r = await parseAndValidate(SAGA_BPMN);
    const n = r.graph!.nodes;
    for (const node of Object.values(n)) {
      expect(node.next).toBe(node.outgoing[0]?.targetId ?? null);
    }
    // ends have no successor
    expect(n["Tx_ok"]!.next).toBeNull();
    expect(n["SagaDone"]!.outgoing).toEqual([]);
  });

  it("places compensation boundaries and isForCompensation handlers OFF every token-path outgoing[]", async () => {
    const r = await parseAndValidate(SAGA_BPMN);
    expect(r.ok).toBe(true); // not flagged unreachable despite no incoming sequence flow
    const n = r.graph!.nodes;

    // comp boundaries have zero outgoing; handlers have zero outgoing
    for (const offPath of ["reserveStock_comp", "chargeCard_comp", "releaseStock", "refundCard"]) {
      expect(n[offPath]!.outgoing).toEqual([]);
    }
    // no token-path node lists a comp boundary or handler as a successor
    const offPath = new Set(["reserveStock_comp", "chargeCard_comp", "releaseStock", "refundCard"]);
    for (const node of Object.values(n)) {
      for (const flow of node.outgoing) {
        expect(offPath.has(flow.targetId)).toBe(false);
      }
    }
  });
});

describe("Conditional graph IR: exclusiveGateway + live conditional edges (TASK-31, M2 design §4)", () => {
  // TASK-31 landed the conditional IR behind a closed publish gate; TASK-33
  // opened the gate, so the XOR fixtures now validate ok with the SAME graph.
  it("ACCEPTS the XOR model at publish time (TASK-33 opened the gate)", async () => {
    const r = await parseAndValidate(XOR_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("builds an exclusiveGateway node whose outgoing[] carries conditions + default in DOCUMENT order", async () => {
    const r = await parseAndValidate(XOR_BPMN);
    const g = r.graph!;
    expect(g).toBeDefined();

    const split = g.nodes["GW_split"]!;
    expect(split.type).toBe("exclusiveGateway");
    expect(split.name).toBe("Route by amount");
    // document order of the <sequenceFlow> elements (f_gold, f_silver, f_def),
    // NOT the scrambled <bpmn:outgoing> ref order inside the gateway
    expect(split.outgoing).toEqual([
      { flowId: "f_gold", targetId: "T_gold", conditionExpression: "amount > 100", isDefault: false },
      { flowId: "f_silver", targetId: "T_silver", conditionExpression: "amount > 10", isDefault: false },
      { flowId: "f_def", targetId: "T_basic", conditionExpression: null, isDefault: true },
    ]);
  });

  it("marks isDefault true EXACTLY for the flow named by the gateway's default attribute", async () => {
    const r = await parseAndValidate(XOR_BPMN);
    const g = r.graph!;
    const defaults = g.elements
      .filter((e) => e.type === "sequenceFlow" && e.isDefault)
      .map((e) => e.elementId);
    expect(defaults).toEqual(["f_def"]);
    for (const node of Object.values(g.nodes)) {
      for (const flow of node.outgoing) {
        expect(flow.isDefault).toBe(flow.flowId === "f_def");
      }
    }
  });

  it("builds the join gateway as a pass-through node and makes no .next promise on gateways", async () => {
    const r = await parseAndValidate(XOR_BPMN);
    const g = r.graph!;
    const join = g.nodes["GW_join"]!;
    expect(join.type).toBe("exclusiveGateway");
    expect(join.outgoing).toEqual([
      { flowId: "f_end", targetId: "E", conditionExpression: null, isDefault: false },
    ]);
    // gateway nodes carry next: null — branch selection (TASK-34) owns the
    // successor choice; the IR makes no .next promise for gateways
    expect(g.nodes["GW_split"]!.next).toBeNull();
    expect(join.next).toBeNull();
    // non-gateway nodes keep next derived as outgoing[0]?.targetId
    expect(g.nodes["S"]!.next).toBe("GW_split");
    expect(g.nodes["T_gold"]!.next).toBe("GW_join");
    expect(g.nodes["E"]!.next).toBeNull();
  });

  it("exposes sequenceFlow GraphElements carrying conditionExpression/isDefault (persisted topology shape)", async () => {
    const r = await parseAndValidate(XOR_BPMN);
    const g = r.graph!;
    const byId = Object.fromEntries(g.elements.map((e) => [e.elementId, e]));
    expect(byId["GW_split"]).toMatchObject({ type: "exclusiveGateway", name: "Route by amount" });
    expect(byId["f_gold"]).toMatchObject({
      type: "sequenceFlow",
      sourceRef: "GW_split",
      targetRef: "T_gold",
      conditionExpression: "amount > 100",
      isDefault: false,
    });
    expect(byId["f_def"]).toMatchObject({
      type: "sequenceFlow",
      sourceRef: "GW_split",
      targetRef: "T_basic",
      conditionExpression: null,
      isDefault: true,
    });
    // non-gateway flows stay unconditional
    expect(byId["f0"]).toMatchObject({ conditionExpression: null, isDefault: false });
    expect(byId["f_end"]).toMatchObject({ conditionExpression: null, isDefault: false });
  });

  it("scopes a gateway inside a <transaction> like every other scoped node", async () => {
    const r = await parseAndValidate(XOR_IN_TX_BPMN);
    const g = r.graph!;
    expect(g.nodes["GW"]!.type).toBe("exclusiveGateway");
    expect(g.nodes["GW"]!.scopeId).toBe("Tx");
    expect(g.transactions!["Tx"]!.childIds).toContain("GW");
    expect(g.nodes["GW"]!.outgoing).toEqual([
      { flowId: "t_a", targetId: "A", conditionExpression: "ok", isDefault: false },
      { flowId: "t_b", targetId: "B", conditionExpression: null, isDefault: true },
    ]);
  });

  it("probe: a gateway's default attr does NOT mark a same-id flow leaving a DIFFERENT node", async () => {
    // GA declares default="fb1", but fb1's SOURCE is GB — default ownership is
    // per gateway (Flow doc: "isDefault is true exactly for the flow referenced
    // by its gateway's default attribute"), so fb1 must stay isDefault:false
    // everywhere. The model is REJECTED (TASK-33: a default must reference one
    // of the gateway's own outgoing flows, and fa2 is then a condition-less
    // non-default split flow), but the builder runs best-effort on invalid
    // models, so the IR stays observable.
    const CROSS_GATEWAY_DEFAULT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_xdef" targetNamespace="x">
  <bpmn:process id="P_xdef" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f0" sourceRef="S" targetRef="GA" />
    <bpmn:exclusiveGateway id="GA" default="fb1">
      <bpmn:incoming>f0</bpmn:incoming>
      <bpmn:outgoing>fa1</bpmn:outgoing>
      <bpmn:outgoing>fa2</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="fa1" sourceRef="GA" targetRef="GB">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">x &gt; 1</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fa2" sourceRef="GA" targetRef="GB" />
    <bpmn:exclusiveGateway id="GB">
      <bpmn:incoming>fa1</bpmn:incoming>
      <bpmn:incoming>fa2</bpmn:incoming>
      <bpmn:outgoing>fb1</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="fb1" sourceRef="GB" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:incoming>fb1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
    const r = await parseAndValidate(CROSS_GATEWAY_DEFAULT_BPMN);
    expect(r.ok).toBe(false);
    const g = r.graph!;
    expect(g).toBeDefined();
    // fb1 leaves GB, which declares NO default — GA's attr must not leak onto it
    expect(g.nodes["GB"]!.outgoing).toEqual([
      { flowId: "fb1", targetId: "E", conditionExpression: null, isDefault: false },
    ]);
    // GA's own outgoing is unaffected (its declared default is not among them)
    expect(g.nodes["GA"]!.outgoing).toEqual([
      { flowId: "fa1", targetId: "GB", conditionExpression: "x > 1", isDefault: false },
      { flowId: "fa2", targetId: "GB", conditionExpression: null, isDefault: false },
    ]);
    // ...and the persisted-topology elements agree: NO flow is default here
    for (const el of g.elements) {
      if (el.type === "sequenceFlow") expect(el.isDefault).toBe(false);
    }
  });

  it("regression: linear MVP + M1 saga graphs keep conditionExpression null / isDefault false everywhere", async () => {
    for (const xml of [DEMO_BPMN, SAGA_BPMN]) {
      const r = await parseAndValidate(xml);
      expect(r.ok).toBe(true);
      const g = r.graph!;
      for (const node of Object.values(g.nodes)) {
        expect(node.type).not.toBe("exclusiveGateway");
        for (const flow of node.outgoing) {
          expect(flow.conditionExpression).toBeNull();
          expect(flow.isDefault).toBe(false);
        }
      }
      for (const el of g.elements) {
        if (el.type !== "sequenceFlow") continue;
        expect(el.conditionExpression).toBeNull();
        expect(el.isDefault).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// TASK-33 (M2 design §3): the validator accepts-and-validates exclusiveGateway,
// FEEL conditions, default flows, and cycles. Reject matrix per AC#2.
// ---------------------------------------------------------------------------

/**
 * Minimal 2-out XOR split with injectable mutations so each negative variant
 * breaks exactly one rule. Valid by default: f_a carries a FEEL condition,
 * f_b is the gateway's default.
 */
function xorSplitBpmn(o: {
  /** The gateway's default attribute; null removes it. */
  defaultAttr?: string | null;
  /** <conditionExpression> body on f_a; null removes the element entirely. */
  condA?: string | null;
  /** <conditionExpression> body on f_b (the default flow); null = none. */
  condB?: string | null;
  /** Extra process-level elements (e.g. a boundary event on the gateway). */
  extra?: string;
} = {}): string {
  const defaultAttr = o.defaultAttr === null ? "" : ` default="${o.defaultAttr ?? "f_b"}"`;
  const condA = o.condA === null
    ? ""
    : `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${o.condA ?? "amount &gt; 100"}</bpmn:conditionExpression>`;
  const condB = o.condB == null
    ? ""
    : `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${o.condB}</bpmn:conditionExpression>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_split" targetNamespace="x">
  <bpmn:process id="P_split" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f0" sourceRef="S" targetRef="GW"/>
    <bpmn:exclusiveGateway id="GW" name="Split"${defaultAttr}>
      <bpmn:incoming>f0</bpmn:incoming>
      <bpmn:outgoing>f_a</bpmn:outgoing>
      <bpmn:outgoing>f_b</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="f_a" sourceRef="GW" targetRef="TA">${condA}</bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_b" sourceRef="GW" targetRef="TB">${condB}</bpmn:sequenceFlow>
    <bpmn:serviceTask id="TA"><bpmn:extensionElements><easy-bpmn:taskDefinition type="a"/></bpmn:extensionElements><bpmn:incoming>f_a</bpmn:incoming><bpmn:outgoing>f_a2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:serviceTask id="TB"><bpmn:extensionElements><easy-bpmn:taskDefinition type="b"/></bpmn:extensionElements><bpmn:incoming>f_b</bpmn:incoming><bpmn:outgoing>f_b2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f_a2" sourceRef="TA" targetRef="EA"/>
    <bpmn:sequenceFlow id="f_b2" sourceRef="TB" targetRef="EB"/>
    <bpmn:endEvent id="EA"><bpmn:incoming>f_a2</bpmn:incoming></bpmn:endEvent>
    <bpmn:endEvent id="EB"><bpmn:incoming>f_b2</bpmn:incoming></bpmn:endEvent>
    ${o.extra ?? ""}
  </bpmn:process>
</bpmn:definitions>`;
}

describe("Exclusive-gateway accept matrix (TASK-33, M2 design §3)", () => {
  it("accepts the process-level XOR split (FEEL conditions + default) + join", async () => {
    const r = await parseAndValidate(XOR_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    expect(r.graph!.nodes["GW_split"]?.type).toBe("exclusiveGateway");
    expect(r.graph!.nodes["GW_join"]?.type).toBe("exclusiveGateway");
  });

  it("accepts an XOR split + default inside a <transaction>", async () => {
    const r = await parseAndValidate(XOR_IN_TX_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    expect(r.graph!.nodes["GW"]?.scopeId).toBe("Tx");
  });

  it("accepts the full conditional saga (compensation + error/cancel + XOR split/join in the transaction)", async () => {
    const r = await parseAndValidate(SAGA_XOR_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    const g = r.graph!;
    expect(g.nodes["GW_method"]?.type).toBe("exclusiveGateway");
    expect(g.nodes["GW_method"]?.scopeId).toBe("Tx_pay");
    expect(g.nodes["GW_method"]?.outgoing).toEqual([
      { flowId: "f_card", targetId: "payCard", conditionExpression: 'method = "card"', isDefault: false },
      { flowId: "f_wire", targetId: "payWire", conditionExpression: null, isDefault: true },
    ]);
    // the saga wiring is intact alongside the gateway
    expect(g.transactions?.["Tx_pay"]?.compensations["reserveFunds"]?.handlerId).toBe("releaseFunds");
    expect(g.nodes["pay_err"]?.boundaryKind).toBe("error");
  });

  it("accepts the valid 2-out split builder baseline", async () => {
    const r = await parseAndValidate(xorSplitBpmn());
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("accepts a split WITHOUT a default flow (all outgoing conditional)", async () => {
    // Standard BPMN: a default is optional; no-flow-taken is a RUNTIME incident
    // (TASK-34), not a publish-time error.
    const r = await parseAndValidate(xorSplitBpmn({ defaultAttr: null, condB: "amount &lt;= 100" }));
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("accepts a cyclic token path looping back through a mixed 2-in/2-out XOR gateway", async () => {
    const r = await parseAndValidate(LOOP_XOR_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    const g = r.graph!;
    // back-edge is live in the IR: T_switch loops to the gateway
    expect(g.nodes["T_switch"]?.outgoing).toEqual([
      { flowId: "f_back", targetId: "GW_retry", conditionExpression: null, isDefault: false },
    ]);
    expect(g.nodes["GW_retry"]?.outgoing).toEqual([
      {
        flowId: "f_retry",
        targetId: "T_switch",
        conditionExpression: 'chargeResult = "declined" and attemptsLeft > 0',
        isDefault: false,
      },
      { flowId: "f_done", targetId: "E", conditionExpression: null, isDefault: true },
    ]);
  });

  it("tolerates ignorable content on a conditional model (foreign extensions, DI, documentation)", async () => {
    const r = await parseAndValidate(XOR_TOLERANT_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    // the conditional IR is intact despite the ignorable content
    expect(r.graph!.nodes["GW"]?.outgoing).toEqual([
      { flowId: "f_a", targetId: "TA", conditionExpression: "amount > 100", isDefault: false },
      { flowId: "f_b", targetId: "TB", conditionExpression: null, isDefault: true },
    ]);
  });

  it("semantically round-trips the conditional saga through bpmn-moddle (canonicity R3)", async () => {
    const out = await roundTripBpmnXml(SAGA_XOR_BPMN);
    // gateway, conditions, and the default attribute survive re-serialization
    expect(out).toMatch(/bpmn:exclusiveGateway/i);
    expect(out).toMatch(/conditionExpression/);
    expect(out).toMatch(/default="f_wire"/);
    expect(out).toMatch(/method = "card"/);
    // and the re-serialized file still validates
    const r = await parseAndValidate(out);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });
});

describe("Exclusive-gateway reject matrix (TASK-33, M2 design §3)", () => {
  it("rejects an invalid FEEL condition with the flow's element id + parse reason", async () => {
    const r = await parseAndValidate(xorSplitBpmn({ condA: "amount &gt;" }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "f_a" && /Invalid FEEL/i.test(i.reason))).toBe(true);
  });

  it("rejects FEEL unary-test syntax (parses, but can never be boolean true)", async () => {
    // `> 100` is a FEEL *unary test* — valid syntax, but as a flow condition it
    // evaluates to a range, never boolean true: a modeler footgun caught at publish.
    const r = await parseAndValidate(xorSplitBpmn({ condA: "&gt; 100" }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "f_a" && /unary-test/i.test(i.reason))).toBe(true);
  });

  it("rejects a conditionExpression on a flow not leaving an exclusive gateway", async () => {
    const r = await parseAndValidate(CONDITIONAL_FLOW_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "f1" && /exclusiveGateway|exclusive gateway/.test(i.reason))).toBe(true);
  });

  it("rejects a declared non-FEEL condition language (design §3: language unset or FEEL)", async () => {
    // Mis-parsing a JUEL/groovy expression as FEEL would yield a confusing
    // syntax error; the language attribute gets its own clear reject.
    const xml = xorSplitBpmn().replace(
      '<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">',
      '<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="juel">',
    );
    const r = await parseAndValidate(xml);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "f_a" && /language 'juel'/.test(i.reason) && /FEEL/.test(i.reason))).toBe(true);
  });

  it("accepts an explicit FEEL language identifier (the DMN FEEL URN)", async () => {
    const xml = xorSplitBpmn().replace(
      '<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">',
      '<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="https://www.omg.org/spec/DMN/20191111/FEEL/">',
    );
    const r = await parseAndValidate(xml);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("rejects a default referencing a MISSING flow", async () => {
    const r = await parseAndValidate(xorSplitBpmn({ defaultAttr: "f_nope", condB: "amount &lt;= 100" }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "GW" && /default/.test(i.reason) && /f_nope/.test(i.reason))).toBe(true);
  });

  it("rejects a default referencing a FOREIGN flow (not leaving that gateway)", async () => {
    // f0 exists but leaves the start event, not GW.
    const r = await parseAndValidate(xorSplitBpmn({ defaultAttr: "f0", condB: "amount &lt;= 100" }));
    expect(r.ok).toBe(false);
    expect(
      r.issues.some((i) => i.elementId === "GW" && /default/.test(i.reason) && /own outgoing/.test(i.reason)),
    ).toBe(true);
  });

  it("rejects a non-default condition-less split flow", async () => {
    const r = await parseAndValidate(xorSplitBpmn({ defaultAttr: null }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "f_b" && /no .*condition|condition-less|default/i.test(i.reason))).toBe(true);
  });

  it("treats an empty/whitespace conditionExpression as condition-less (same reject bucket)", async () => {
    // The builder normalizes empty bodies to null (see the validator capture
    // site), so an empty condition on a non-default split flow lands in the
    // missing-condition bucket; the message covers both shapes.
    const r = await parseAndValidate(xorSplitBpmn({ defaultAttr: null, condB: "   " }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "f_b" && /no .*condition|missing|empty/i.test(i.reason))).toBe(true);
  });

  it("rejects a conditionExpression on the gateway's default flow", async () => {
    const r = await parseAndValidate(xorSplitBpmn({ condB: "amount &lt;= 100" }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "f_b" && /default flow/.test(i.reason) && /condition/.test(i.reason))).toBe(true);
  });

  it("rejects an EMPTY <conditionExpression/> element on the default flow (presence, not body)", async () => {
    // The default-flow rule keys on element PRESENCE: an empty body is
    // normalized to null elsewhere, but "must not carry a conditionExpression"
    // covers the empty element too (same bit as the non-gateway-flow rule).
    const r = await parseAndValidate(xorSplitBpmn({ condB: "   " }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "f_b" && /default flow/.test(i.reason) && /condition/.test(i.reason))).toBe(true);
  });

  it("rejects a boundary event attached to a gateway (invalid BPMN)", async () => {
    const r = await parseAndValidate(
      xorSplitBpmn({
        extra: `<bpmn:boundaryEvent id="bad_b" attachedToRef="GW"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f_bad" sourceRef="bad_b" targetRef="EB"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "bad_b" && /gateway/i.test(i.reason))).toBe(true);
  });

  // eventBasedGateway is IN since M3-L4 (TASK-46); parallelGateway/inclusiveGateway
  // are IN since M4-L1 (TASK-48, block-structured SESE — see "M4 concurrency
  // profile" below). Only complexGateway remains a DEFERRED_GATEWAY_REASONS
  // milestone pointer; a 1-in/1-out parallel/inclusive pass-through now validates.
  it.each([
    ["complexGateway", /later milestone/],
  ] as const)("rejects %s with a milestone pointer", async (tag, pointer) => {
    const r = await parseAndValidate(deferredGatewayBpmn(tag));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "G" && pointer.test(i.reason))).toBe(true);
  });

  it("still rejects >1 outgoing flow on a non-gateway node", async () => {
    const MULTI_OUT_TASK_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f0" sourceRef="S" targetRef="T"/>
    <bpmn:serviceTask id="T"><bpmn:extensionElements><easy-bpmn:taskDefinition type="x"/></bpmn:extensionElements><bpmn:incoming>f0</bpmn:incoming><bpmn:outgoing>f1</bpmn:outgoing><bpmn:outgoing>f2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f1" sourceRef="T" targetRef="E1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="T" targetRef="E2"/>
    <bpmn:endEvent id="E1"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>
    <bpmn:endEvent id="E2"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
    const r = await parseAndValidate(MULTI_OUT_TASK_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "T" && /Implicit splits/.test(i.reason))).toBe(true);
  });

  it("still rejects a `default` attribute on a non-gateway activity", async () => {
    const DEFAULT_ON_TASK_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f0" sourceRef="S" targetRef="T"/>
    <bpmn:serviceTask id="T" default="f1"><bpmn:extensionElements><easy-bpmn:taskDefinition type="x"/></bpmn:extensionElements><bpmn:incoming>f0</bpmn:incoming><bpmn:outgoing>f1</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f1" sourceRef="T" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
    const r = await parseAndValidate(DEFAULT_ON_TASK_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "T" && /default/.test(i.reason) && /exclusiveGateway/.test(i.reason))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M2 final review: token-path flows into NON-TOKEN nodes. The linearity checks
// skip boundary events and compensation handlers, so without explicit endpoint
// rules these two probe models published OK and wedged the engine (the walk
// fell through with no terminal write). Both fixtures are valid EXCEPT for the
// offending flow(s) — the issue counts pin that the new rules are the only gate.
// ---------------------------------------------------------------------------

describe("Token-path flows into non-token nodes (M2 final review)", () => {
  it("rejects sequence flows into and out of an isForCompensation handler (pre-M2 probe)", async () => {
    // TxStart → A → H(isForCompensation) → TxEnd: a handler spliced into the
    // token path. Published OK since M1; the engine then silently wedged on H.
    const FLOW_THROUGH_HANDLER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:sequenceFlow id="g1" sourceRef="S" targetRef="Tx"/>
    <bpmn:transaction id="Tx">
      <bpmn:startEvent id="TxS"/>
      <bpmn:sequenceFlow id="t1" sourceRef="TxS" targetRef="A"/>
      <bpmn:serviceTask id="A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="step-a"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="t2" sourceRef="A" targetRef="H"/>
      <bpmn:serviceTask id="H" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="undo-a"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="t3" sourceRef="H" targetRef="TxE"/>
      <bpmn:endEvent id="TxE"/>
    </bpmn:transaction>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="E"/>
    <bpmn:endEvent id="E"/>
  </bpmn:process>
</bpmn:definitions>`;
    const r = await parseAndValidate(FLOW_THROUGH_HANDLER_BPMN);
    expect(r.ok).toBe(false);
    // incoming flow: handlers are invoked via their <association>, never the token
    expect(r.issues.some((i) => i.elementId === "t2" && /targets compensation handler 'H'/.test(i.reason))).toBe(true);
    // outgoing flow: handlers have no outgoing sequence flows
    expect(r.issues.some((i) => i.elementId === "t3" && /leaves compensation handler 'H'/.test(i.reason))).toBe(true);
    // the model is otherwise valid — these two are the only gate failures
    expect(r.issues).toHaveLength(2);
  });

  it("rejects a gateway flow targeting a boundary event (NEW-in-M2 probe)", async () => {
    // M1's no-split rule made flow-into-boundary structurally impossible; an
    // XOR default flow opened the route. The boundary's OWN outgoing flow (g3,
    // the escalation path) stays legal — only the INCOMING flow rejects.
    const GATEWAY_INTO_BOUNDARY_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:sequenceFlow id="f0" sourceRef="S" targetRef="GW"/>
    <bpmn:exclusiveGateway id="GW" default="f_bad"/>
    <bpmn:sequenceFlow id="f_go" sourceRef="GW" targetRef="Tx"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">ok = true</bpmn:conditionExpression></bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_bad" sourceRef="GW" targetRef="Tx_cancelled"/>
    <bpmn:transaction id="Tx">
      <bpmn:startEvent id="TxS"/>
      <bpmn:sequenceFlow id="t1" sourceRef="TxS" targetRef="A"/>
      <bpmn:serviceTask id="A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="step-a"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="t2" sourceRef="A" targetRef="TxE"/>
      <bpmn:endEvent id="TxE"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="Tx_cancelled" attachedToRef="Tx"><bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="Done"/>
    <bpmn:sequenceFlow id="g3" sourceRef="Tx_cancelled" targetRef="Failed"/>
    <bpmn:endEvent id="Done"/>
    <bpmn:endEvent id="Failed"/>
  </bpmn:process>
</bpmn:definitions>`;
    const r = await parseAndValidate(GATEWAY_INTO_BOUNDARY_BPMN);
    expect(r.ok).toBe(false);
    expect(
      r.issues.some(
        (i) => i.elementId === "f_bad" && /targets boundary event 'Tx_cancelled'/.test(i.reason) && /activated by the runtime/.test(i.reason),
      ),
    ).toBe(true);
    // the model is otherwise valid — the incoming flow is the only gate failure
    expect(r.issues).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Free error-boundary routing (M3-L2, TASK-42, design §3 + §7 gates 7-8).
//
// Lifts the M1 "an error boundary's single outgoing flow must target a cancel
// end event" restriction. An activity may now carry any number of interrupting
// error boundaries with DISTINCT, NON-EMPTY @errorCode values, plus at most one
// catch-all (errorEventDefinition with no errorRef), each routing to any
// token-path node in the same scope. These are process-level models (no
// transaction) precisely to prove free routing no longer requires a cancel end.
// ---------------------------------------------------------------------------
describe("Free error-boundary routing (M3-L2, TASK-42)", () => {
  const svc = (id: string, type: string) =>
    `<bpmn:serviceTask id="${id}"><bpmn:extensionElements><easy-bpmn:taskDefinition type="${type}"/></bpmn:extensionElements></bpmn:serviceTask>`;

  /** Process-level error-routing model: S → router → E, plus injectable error
   *  boundaries on `router`, their alternate-path targets, and the wiring flows.
   *  Valid (accept) by default: two distinct-code boundaries + one catch-all. */
  function errRouteBpmn(o: { errors?: string; boundaries?: string; targets?: string; flows?: string } = {}): string {
    const errors = o.errors ??
      `<bpmn:error id="Err_A" name="A failed" errorCode="CODE_A"/><bpmn:error id="Err_B" name="B failed" errorCode="CODE_B"/>`;
    const boundaries = o.boundaries ??
      `<bpmn:boundaryEvent id="b_a" attachedToRef="router"><bpmn:errorEventDefinition errorRef="Err_A"/></bpmn:boundaryEvent>
       <bpmn:boundaryEvent id="b_b" attachedToRef="router"><bpmn:errorEventDefinition errorRef="Err_B"/></bpmn:boundaryEvent>
       <bpmn:boundaryEvent id="b_c" attachedToRef="router"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>`;
    const targets = o.targets ?? `${svc("svcA", "svc-a")}${svc("svcB", "svc-b")}${svc("svcC", "svc-c")}`;
    const flows = o.flows ??
      `<bpmn:sequenceFlow id="fa" sourceRef="b_a" targetRef="svcA"/>
       <bpmn:sequenceFlow id="fb" sourceRef="b_b" targetRef="svcB"/>
       <bpmn:sequenceFlow id="fc" sourceRef="b_c" targetRef="svcC"/>
       <bpmn:sequenceFlow id="fa2" sourceRef="svcA" targetRef="E"/>
       <bpmn:sequenceFlow id="fb2" sourceRef="svcB" targetRef="E"/>
       <bpmn:sequenceFlow id="fc2" sourceRef="svcC" targetRef="E"/>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_er" targetNamespace="x">
  ${errors}
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    ${svc("router", "router")}
    ${targets}
    ${boundaries}
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="router"/>
    <bpmn:sequenceFlow id="s1" sourceRef="router" targetRef="E"/>
    ${flows}
  </bpmn:process>
</bpmn:definitions>`;
  }

  it("accepts multi-boundary + catch-all routing to alternate token-path nodes", async () => {
    const r = await parseAndValidate(errRouteBpmn());
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    const n = r.graph!.nodes;
    // coded boundaries carry their resolved @errorCode and route to their alt path
    expect(n["b_a"]?.boundaryKind).toBe("error");
    expect(n["b_a"]?.errorCode).toBe("CODE_A");
    expect(n["b_a"]?.next).toBe("svcA");
    expect(n["b_b"]?.errorCode).toBe("CODE_B");
    expect(n["b_b"]?.next).toBe("svcB");
    // the catch-all (no errorRef) builds with errorCode === null and a next —
    // null unambiguously means catch-all (empty-coded boundaries are rejected)
    expect(n["b_c"]?.boundaryKind).toBe("error");
    expect(n["b_c"]?.errorRef ?? null).toBeNull();
    expect(n["b_c"]?.errorCode ?? null).toBeNull();
    expect(n["b_c"]?.next).toBe("svcC");
  });

  it("rejects two error boundaries on one activity sharing an @errorCode", async () => {
    const r = await parseAndValidate(
      errRouteBpmn({
        errors: `<bpmn:error id="Err_A" errorCode="CODE_A"/><bpmn:error id="Err_A2" errorCode="CODE_A"/>`,
        boundaries: `<bpmn:boundaryEvent id="b_a" attachedToRef="router"><bpmn:errorEventDefinition errorRef="Err_A"/></bpmn:boundaryEvent>
          <bpmn:boundaryEvent id="b_a2" attachedToRef="router"><bpmn:errorEventDefinition errorRef="Err_A2"/></bpmn:boundaryEvent>`,
        targets: `${svc("svcA", "svc-a")}${svc("svcA2", "svc-a2")}`,
        flows: `<bpmn:sequenceFlow id="fa" sourceRef="b_a" targetRef="svcA"/>
          <bpmn:sequenceFlow id="fa2" sourceRef="b_a2" targetRef="svcA2"/>
          <bpmn:sequenceFlow id="ea" sourceRef="svcA" targetRef="E"/>
          <bpmn:sequenceFlow id="ea2" sourceRef="svcA2" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "b_a2" && /CODE_A/.test(i.reason) && /distinct/.test(i.reason))).toBe(true);
  });

  it("rejects an errorRef to an Error with an empty/missing @errorCode (hidden catch-all)", async () => {
    const r = await parseAndValidate(
      errRouteBpmn({
        errors: `<bpmn:error id="Err_empty" name="No code"/>`,
        boundaries: `<bpmn:boundaryEvent id="b_e" attachedToRef="router"><bpmn:errorEventDefinition errorRef="Err_empty"/></bpmn:boundaryEvent>`,
        targets: svc("svcA", "svc-a"),
        flows: `<bpmn:sequenceFlow id="fe" sourceRef="b_e" targetRef="svcA"/>
          <bpmn:sequenceFlow id="ea" sourceRef="svcA" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "b_e" && /@errorCode/.test(i.reason) && /catch-all/.test(i.reason))).toBe(true);
  });

  it("rejects a second catch-all error boundary on one activity", async () => {
    const r = await parseAndValidate(
      errRouteBpmn({
        errors: ``,
        boundaries: `<bpmn:boundaryEvent id="b_c1" attachedToRef="router"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>
          <bpmn:boundaryEvent id="b_c2" attachedToRef="router"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>`,
        targets: `${svc("svcA", "svc-a")}${svc("svcB", "svc-b")}`,
        flows: `<bpmn:sequenceFlow id="fc1" sourceRef="b_c1" targetRef="svcA"/>
          <bpmn:sequenceFlow id="fc2" sourceRef="b_c2" targetRef="svcB"/>
          <bpmn:sequenceFlow id="ea" sourceRef="svcA" targetRef="E"/>
          <bpmn:sequenceFlow id="eb" sourceRef="svcB" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "b_c2" && /catch-all/.test(i.reason) && /more than one/.test(i.reason))).toBe(true);
  });

  it("rejects an error-boundary flow targeting a start event", async () => {
    const r = await parseAndValidate(
      errRouteBpmn({
        errors: `<bpmn:error id="Err_A" errorCode="CODE_A"/>`,
        boundaries: `<bpmn:boundaryEvent id="b_a" attachedToRef="router"><bpmn:errorEventDefinition errorRef="Err_A"/></bpmn:boundaryEvent>`,
        targets: ``,
        flows: `<bpmn:sequenceFlow id="fa" sourceRef="b_a" targetRef="S"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "fa" && /start event 'S'/.test(i.reason))).toBe(true);
  });

  it("rejects an error-boundary flow targeting another boundary event", async () => {
    const r = await parseAndValidate(
      errRouteBpmn({
        errors: `<bpmn:error id="Err_A" errorCode="CODE_A"/><bpmn:error id="Err_B" errorCode="CODE_B"/>`,
        boundaries: `<bpmn:boundaryEvent id="b_a" attachedToRef="router"><bpmn:errorEventDefinition errorRef="Err_A"/></bpmn:boundaryEvent>
          <bpmn:boundaryEvent id="b_b" attachedToRef="router"><bpmn:errorEventDefinition errorRef="Err_B"/></bpmn:boundaryEvent>`,
        targets: svc("svcB", "svc-b"),
        flows: `<bpmn:sequenceFlow id="fa" sourceRef="b_a" targetRef="b_b"/>
          <bpmn:sequenceFlow id="fb" sourceRef="b_b" targetRef="svcB"/>
          <bpmn:sequenceFlow id="eb" sourceRef="svcB" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "fa" && /targets boundary event 'b_b'/.test(i.reason))).toBe(true);
  });

  it("rejects a boundary event attached to an isForCompensation handler", async () => {
    const r = await parseAndValidate(
      sagaBpmn({ innerExtra: `<bpmn:boundaryEvent id="bad_on_handler" attachedToRef="undoA"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>` }),
    );
    expect(r.ok).toBe(false);
    expect(
      r.issues.some((i) => i.elementId === "bad_on_handler" && /attached to compensation handler 'undoA'/.test(i.reason)),
    ).toBe(true);
    // The `continue` after the handler-attachment rejection must suppress the
    // misleading per-kind reasons (a handler IS a serviceTask, and this boundary
    // has no outgoing flow) — exactly ONE reason fires.
    expect(r.issues).toHaveLength(1);
  });

  it("rejects an error-boundary flow targeting a compensation handler", async () => {
    const r = await parseAndValidate(
      sagaBpmn({ errBoundaryFlow: `<bpmn:sequenceFlow id="fe" sourceRef="stepB_err" targetRef="undoA"/>` }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "fe" && /targets compensation handler 'undoA'/.test(i.reason))).toBe(true);
  });

  it("still tolerates ignorable content on a saga carrying an error boundary (regression)", async () => {
    const r = await parseAndValidate(SAGA_TOLERANT_BPMN);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Interrupting boundary timers (M3-L3, TASK-44, design §3 + §7 validator matrix).
//
// `boundaryEvent` + `timerEventDefinition`, interrupting (cancelActivity absent
// or true), attachable to a serviceTask/receiveTask, AT MOST ONE per activity,
// NEVER on a transaction or compensation handler, exactly one outgoing flow to a
// token-path node in the same scope, and exactly ONE of timeDate|timeDuration as
// a static ISO-8601 literal.
// ---------------------------------------------------------------------------
describe("Interrupting boundary timers (M3-L3, TASK-44)", () => {
  /** S → task → E, with a timer boundary `tb` on `task` routing to onTimeout → E. */
  function timerBpmn(o: { boundary?: string; flows?: string; alt?: string; hostExtra?: string } = {}): string {
    const boundary = o.boundary ??
      `<bpmn:boundaryEvent id="tb" attachedToRef="task"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>`;
    const alt = o.alt ??
      `<bpmn:serviceTask id="onTimeout"><bpmn:extensionElements><easy-bpmn:taskDefinition type="timeout-handler"/></bpmn:extensionElements></bpmn:serviceTask>`;
    const flows = o.flows ??
      `<bpmn:sequenceFlow id="tf" sourceRef="tb" targetRef="onTimeout"/>
       <bpmn:sequenceFlow id="af" sourceRef="onTimeout" targetRef="E"/>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_tim" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:serviceTask id="task">${o.hostExtra ?? ""}<bpmn:extensionElements><easy-bpmn:taskDefinition type="t"/></bpmn:extensionElements></bpmn:serviceTask>
    ${alt}
    ${boundary}
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="task"/>
    <bpmn:sequenceFlow id="s1" sourceRef="task" targetRef="E"/>
    ${flows}
  </bpmn:process>
</bpmn:definitions>`;
  }

  it("accepts an interrupting boundary timer on a service task (timeDuration)", async () => {
    const r = await parseAndValidate(timerBpmn());
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    const tb = r.graph!.nodes["tb"];
    expect(tb?.boundaryKind).toBe("timer");
    expect(tb?.attachedToRef).toBe("task");
    expect(tb?.next).toBe("onTimeout");
    expect(tb?.timerTrigger).toEqual({ kind: "timeDuration", value: "PT5M" });
  });

  it("accepts a static timeDate trigger", async () => {
    const r = await parseAndValidate(
      timerBpmn({
        boundary: `<bpmn:boundaryEvent id="tb" attachedToRef="task"><bpmn:timerEventDefinition><bpmn:timeDate>2026-12-31T23:59:00Z</bpmn:timeDate></bpmn:timerEventDefinition></bpmn:boundaryEvent>`,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["tb"]?.timerTrigger).toEqual({ kind: "timeDate", value: "2026-12-31T23:59:00Z" });
  });

  it("rejects a non-interrupting (cancelActivity=false) boundary timer", async () => {
    const r = await parseAndValidate(
      timerBpmn({
        boundary: `<bpmn:boundaryEvent id="tb" attachedToRef="task" cancelActivity="false"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "tb" && /non-interrupting/i.test(i.reason) && /M4/.test(i.reason))).toBe(true);
  });

  it("rejects a timeCycle trigger", async () => {
    const r = await parseAndValidate(
      timerBpmn({
        boundary: `<bpmn:boundaryEvent id="tb" attachedToRef="task"><bpmn:timerEventDefinition><bpmn:timeCycle>R3/PT10M</bpmn:timeCycle></bpmn:timerEventDefinition></bpmn:boundaryEvent>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "tb" && /timeCycle/.test(i.reason))).toBe(true);
  });

  it("rejects a definition carrying BOTH timeDate and timeDuration", async () => {
    const r = await parseAndValidate(
      timerBpmn({
        boundary: `<bpmn:boundaryEvent id="tb" attachedToRef="task"><bpmn:timerEventDefinition><bpmn:timeDate>2026-01-01T00:00:00Z</bpmn:timeDate><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "tb" && /both a timeDate and a timeDuration/.test(i.reason))).toBe(true);
  });

  it("rejects a timerEventDefinition with no time child", async () => {
    const r = await parseAndValidate(
      timerBpmn({
        boundary: `<bpmn:boundaryEvent id="tb" attachedToRef="task"><bpmn:timerEventDefinition/></bpmn:boundaryEvent>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "tb" && /no timeDate or timeDuration/.test(i.reason))).toBe(true);
  });

  it("rejects a non-parsing timeDuration literal (incl. a FEEL expression)", async () => {
    for (const bad of ["PT5X", "${dueIn}", "5 minutes"]) {
      const r = await parseAndValidate(
        timerBpmn({
          boundary: `<bpmn:boundaryEvent id="tb" attachedToRef="task"><bpmn:timerEventDefinition><bpmn:timeDuration>${bad}</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>`,
        }),
      );
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.elementId === "tb" && /not a static ISO-8601 duration literal/.test(i.reason))).toBe(true);
    }
  });

  it("rejects a non-parsing timeDate literal", async () => {
    const r = await parseAndValidate(
      timerBpmn({
        boundary: `<bpmn:boundaryEvent id="tb" attachedToRef="task"><bpmn:timerEventDefinition><bpmn:timeDate>not-a-date</bpmn:timeDate></bpmn:timerEventDefinition></bpmn:boundaryEvent>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "tb" && /not a static ISO-8601 date/.test(i.reason))).toBe(true);
  });

  it("rejects a boundary timer with more than one outgoing flow", async () => {
    const r = await parseAndValidate(
      timerBpmn({
        flows: `<bpmn:sequenceFlow id="tf" sourceRef="tb" targetRef="onTimeout"/>
                <bpmn:sequenceFlow id="tf2" sourceRef="tb" targetRef="E"/>
                <bpmn:sequenceFlow id="af" sourceRef="onTimeout" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "tb" && /exactly one outgoing sequence flow/.test(i.reason))).toBe(true);
  });

  it("rejects a boundary-timer flow targeting a start event (reuses the M3-L2 endpoint rule)", async () => {
    const r = await parseAndValidate(
      timerBpmn({
        alt: ``,
        flows: `<bpmn:sequenceFlow id="tf" sourceRef="tb" targetRef="S"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "tf" && /start event 'S'/.test(i.reason))).toBe(true);
  });

  it("rejects more than one boundary timer on a single activity", async () => {
    const r = await parseAndValidate(
      timerBpmn({
        boundary: `<bpmn:boundaryEvent id="tb" attachedToRef="task"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
                   <bpmn:boundaryEvent id="tb2" attachedToRef="task"><bpmn:timerEventDefinition><bpmn:timeDuration>PT9M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>`,
        flows: `<bpmn:sequenceFlow id="tf" sourceRef="tb" targetRef="onTimeout"/>
                <bpmn:sequenceFlow id="tf2" sourceRef="tb2" targetRef="onTimeout"/>
                <bpmn:sequenceFlow id="af" sourceRef="onTimeout" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "tb2" && /more than one boundary timer/.test(i.reason))).toBe(true);
  });

  it("tolerates ignorable content (foreign extension/documentation) on a boundary-timer model", async () => {
    const r = await parseAndValidate(
      timerBpmn({
        hostExtra: `<bpmn:documentation>host task</bpmn:documentation>`,
        boundary: `<bpmn:boundaryEvent id="tb" attachedToRef="task"><bpmn:extensionElements><camunda:properties><camunda:property name="x" value="y"/></camunda:properties></bpmn:extensionElements><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>`,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("accepts a boundary timer on a RECEIVE task", async () => {
    const RECV_TIMER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_rt" targetNamespace="x">
  <bpmn:message id="M" name="Approval"/>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:receiveTask id="wait" messageRef="M"/>
    <bpmn:serviceTask id="onTimeout"><bpmn:extensionElements><easy-bpmn:taskDefinition type="timeout-handler"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:boundaryEvent id="tb" attachedToRef="wait"><bpmn:timerEventDefinition><bpmn:timeDuration>PT1H</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="wait"/>
    <bpmn:sequenceFlow id="s1" sourceRef="wait" targetRef="E"/>
    <bpmn:sequenceFlow id="tf" sourceRef="tb" targetRef="onTimeout"/>
    <bpmn:sequenceFlow id="af" sourceRef="onTimeout" targetRef="E"/>
  </bpmn:process>
</bpmn:definitions>`;
    const r = await parseAndValidate(RECV_TIMER_BPMN);
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["tb"]?.attachedToRef).toBe("wait");
  });

  it("rejects a boundary timer attached to a transaction (deferred to M5)", async () => {
    const TX_TIMER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_txt" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:transaction id="Tx">
      <bpmn:startEvent id="TxS"/>
      <bpmn:serviceTask id="A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="a"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:endEvent id="TxE"/>
      <bpmn:sequenceFlow id="t1" sourceRef="TxS" targetRef="A"/>
      <bpmn:sequenceFlow id="t2" sourceRef="A" targetRef="TxE"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="tb" attachedToRef="Tx"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    <bpmn:serviceTask id="onTimeout"><bpmn:extensionElements><easy-bpmn:taskDefinition type="timeout-handler"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:endEvent id="Done"/>
    <bpmn:sequenceFlow id="g1" sourceRef="S" targetRef="Tx"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="Done"/>
    <bpmn:sequenceFlow id="tf" sourceRef="tb" targetRef="onTimeout"/>
    <bpmn:sequenceFlow id="af" sourceRef="onTimeout" targetRef="Done"/>
  </bpmn:process>
</bpmn:definitions>`;
    const r = await parseAndValidate(TX_TIMER_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "tb" && /attached to transaction/.test(i.reason) && /M5/.test(i.reason))).toBe(true);
  });

  it("rejects a boundary timer attached to an isForCompensation handler", async () => {
    const r = await parseAndValidate(
      sagaBpmn({
        innerExtra: `<bpmn:boundaryEvent id="tb_on_handler" attachedToRef="undoA"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "tb_on_handler" && /attached to compensation handler 'undoA'/.test(i.reason))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M3-L4 (TASK-45): the TIMER intermediate catch — a delay step on the token path
// (design §4.4). Exactly one incoming + one outgoing sequence flow; allowed at
// process level AND inside a transaction; the same timerEventDefinition
// well-formedness as boundary timers (reuses readTimerTrigger). A MESSAGE
// intermediate catch stays "M3 — not yet implemented" (TASK-46).
// ---------------------------------------------------------------------------
describe("Timer intermediate catch (M3-L4, TASK-45)", () => {
  /** S → catch (timer) → svc → E, with the catch as a token-path delay node. */
  function catchBpmn(o: { def?: string; flows?: string } = {}): string {
    const def = o.def ?? `<bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition>`;
    const flows = o.flows ??
      `<bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="catch"/>
       <bpmn:sequenceFlow id="s1" sourceRef="catch" targetRef="after"/>
       <bpmn:sequenceFlow id="s2" sourceRef="after" targetRef="E"/>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_ic" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:intermediateCatchEvent id="catch">${def}</bpmn:intermediateCatchEvent>
    <bpmn:serviceTask id="after"><bpmn:extensionElements><easy-bpmn:taskDefinition type="after"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:endEvent id="E"/>
    ${flows}
  </bpmn:process>
</bpmn:definitions>`;
  }

  it("accepts a timer intermediate catch at process level (timeDuration)", async () => {
    const r = await parseAndValidate(catchBpmn());
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    const c = r.graph!.nodes["catch"];
    expect(c?.type).toBe("intermediateCatchEvent");
    expect(c?.next).toBe("after");
    expect(c?.timerTrigger).toEqual({ kind: "timeDuration", value: "PT5M" });
  });

  it("accepts a static timeDate trigger", async () => {
    const r = await parseAndValidate(
      catchBpmn({ def: `<bpmn:timerEventDefinition><bpmn:timeDate>2026-12-31T23:59:00Z</bpmn:timeDate></bpmn:timerEventDefinition>` }),
    );
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["catch"]?.timerTrigger).toEqual({ kind: "timeDate", value: "2026-12-31T23:59:00Z" });
  });

  it("accepts a timer intermediate catch INSIDE a transaction (scope stays open across the delay)", async () => {
    const TX_CATCH = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_txic" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:transaction id="Tx">
      <bpmn:startEvent id="TxS"/>
      <bpmn:serviceTask id="A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="a"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:intermediateCatchEvent id="catch"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>
      <bpmn:endEvent id="TxE"/>
      <bpmn:sequenceFlow id="t1" sourceRef="TxS" targetRef="A"/>
      <bpmn:sequenceFlow id="t2" sourceRef="A" targetRef="catch"/>
      <bpmn:sequenceFlow id="t3" sourceRef="catch" targetRef="TxE"/>
    </bpmn:transaction>
    <bpmn:endEvent id="Done"/>
    <bpmn:sequenceFlow id="g1" sourceRef="S" targetRef="Tx"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="Done"/>
  </bpmn:process>
</bpmn:definitions>`;
    const r = await parseAndValidate(TX_CATCH);
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["catch"]?.scopeId).toBe("Tx");
    expect(r.graph!.nodes["catch"]?.next).toBe("TxE");
  });

  it("rejects a MESSAGE intermediate catch with no messageRef (TASK-46)", async () => {
    // A messageEventDefinition without a messageRef is now the MESSAGE variant
    // (opened in TASK-46) failing its receive-task-shaped messageRef rule — not
    // the old "M3 — not yet implemented" deferral.
    const r = await parseAndValidate(
      catchBpmn({ def: `<bpmn:messageEventDefinition/>` }),
    );
    expect(r.ok).toBe(false);
    expect(
      r.issues.some((i) => i.elementId === "catch" && /must reference a declared <message> via messageRef/.test(i.reason)),
    ).toBe(true);
    // No stale "not yet implemented" wording survives for the message catch.
    expect(r.issues.some((i) => i.elementId === "catch" && /not yet implemented/i.test(i.reason))).toBe(false);
  });

  it("rejects an intermediate catch with no event definition", async () => {
    const r = await parseAndValidate(catchBpmn({ def: `` }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "catch" && /no event definition/.test(i.reason))).toBe(true);
  });

  it("rejects a timeCycle trigger", async () => {
    const r = await parseAndValidate(
      catchBpmn({ def: `<bpmn:timerEventDefinition><bpmn:timeCycle>R3/PT10M</bpmn:timeCycle></bpmn:timerEventDefinition>` }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "catch" && /timeCycle/.test(i.reason))).toBe(true);
  });

  it("rejects an empty timerEventDefinition with a construct-neutral reason (no 'boundary' leak)", async () => {
    const r = await parseAndValidate(catchBpmn({ def: `<bpmn:timerEventDefinition/>` }));
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.elementId === "catch" && /no timeDate or timeDuration/.test(i.reason));
    expect(issue).toBeDefined();
    // The shared readTimerTrigger reason must NOT call a catch a "boundary timer".
    expect(issue!.reason).toMatch(/Intermediate catch event 'catch'/);
    expect(issue!.reason).not.toMatch(/boundary/);
  });

  it("rejects BOTH timeDate and timeDuration", async () => {
    const r = await parseAndValidate(
      catchBpmn({ def: `<bpmn:timerEventDefinition><bpmn:timeDate>2026-01-01T00:00:00Z</bpmn:timeDate><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition>` }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "catch" && /both a timeDate and a timeDuration/.test(i.reason))).toBe(true);
  });

  it("rejects a non-parsing timeDuration literal (incl. a FEEL expression)", async () => {
    for (const bad of ["PT5X", "${dueIn}", "soon"]) {
      const r = await parseAndValidate(
        catchBpmn({ def: `<bpmn:timerEventDefinition><bpmn:timeDuration>${bad}</bpmn:timeDuration></bpmn:timerEventDefinition>` }),
      );
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.elementId === "catch" && /not a static ISO-8601 duration literal/.test(i.reason))).toBe(true);
    }
  });

  it("rejects more than one outgoing flow (implicit split)", async () => {
    const r = await parseAndValidate(
      catchBpmn({
        flows: `<bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="catch"/>
                <bpmn:sequenceFlow id="s1" sourceRef="catch" targetRef="after"/>
                <bpmn:sequenceFlow id="s1b" sourceRef="catch" targetRef="E"/>
                <bpmn:sequenceFlow id="s2" sourceRef="after" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "catch" && /outgoing sequence flows/.test(i.reason))).toBe(true);
  });

  it("rejects more than one incoming flow (a catch is a single-token delay, not a join)", async () => {
    const r = await parseAndValidate(
      catchBpmn({
        flows: `<bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="after"/>
                <bpmn:sequenceFlow id="s0b" sourceRef="after" targetRef="catch"/>
                <bpmn:sequenceFlow id="s0c" sourceRef="S" targetRef="catch"/>
                <bpmn:sequenceFlow id="s1" sourceRef="catch" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "catch" && /incoming sequence flows/.test(i.reason) && /not a join/.test(i.reason))).toBe(true);
  });

  it("tolerates ignorable content (foreign extension/documentation) on a timer-catch model", async () => {
    const r = await parseAndValidate(
      catchBpmn({
        def: `<bpmn:documentation>delay</bpmn:documentation><bpmn:extensionElements><camunda:properties><camunda:property name="x" value="y"/></camunda:properties></bpmn:extensionElements><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition>`,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M3-L4 (TASK-46): the STANDALONE message intermediate catch — a token-path node
// with IDENTICAL wait/correlation/resume semantics to a receiveTask (the
// <message> carries only its name), but an EVENT, not an activity: no
// easy-bpmn:taskDefinition, no boundary events attach. Exactly one incoming + one
// outgoing flow; allowed at process level AND inside a transaction. The
// eventBasedGateway accept/reject matrix follows in its own describe block.
// ---------------------------------------------------------------------------
describe("Message intermediate catch (M3-L4, TASK-46)", () => {
  /** S → catch (messageEventDefinition → <message> "Approval") → after → E. */
  function msgCatchBpmn(o: { def?: string; flows?: string; extra?: string; message?: string } = {}): string {
    const def = o.def ?? `<bpmn:messageEventDefinition messageRef="M"/>`;
    const message = o.message ?? `<bpmn:message id="M" name="Approval"/>`;
    const flows = o.flows ??
      `<bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="catch"/>
       <bpmn:sequenceFlow id="s1" sourceRef="catch" targetRef="after"/>
       <bpmn:sequenceFlow id="s2" sourceRef="after" targetRef="E"/>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_mic" targetNamespace="x">
  ${message}
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:intermediateCatchEvent id="catch">${def}</bpmn:intermediateCatchEvent>
    <bpmn:serviceTask id="after"><bpmn:extensionElements><easy-bpmn:taskDefinition type="after"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:endEvent id="E"/>
    ${o.extra ?? ""}
    ${flows}
  </bpmn:process>
</bpmn:definitions>`;
  }

  it("accepts a standalone message intermediate catch at process level", async () => {
    const r = await parseAndValidate(msgCatchBpmn());
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    const c = r.graph!.nodes["catch"];
    expect(c?.type).toBe("intermediateCatchEvent");
    expect(c?.messageName).toBe("Approval");
    expect(c?.timerTrigger ?? null).toBeNull();
    expect(c?.next).toBe("after");
  });

  it("accepts a message intermediate catch INSIDE a transaction (scope stays open across the wait)", async () => {
    const TX_MSG_CATCH = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_txmic" targetNamespace="x">
  <bpmn:message id="M" name="Approval"/>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:transaction id="Tx">
      <bpmn:startEvent id="TxS"/>
      <bpmn:serviceTask id="A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="a"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:intermediateCatchEvent id="catch"><bpmn:messageEventDefinition messageRef="M"/></bpmn:intermediateCatchEvent>
      <bpmn:endEvent id="TxE"/>
      <bpmn:sequenceFlow id="t1" sourceRef="TxS" targetRef="A"/>
      <bpmn:sequenceFlow id="t2" sourceRef="A" targetRef="catch"/>
      <bpmn:sequenceFlow id="t3" sourceRef="catch" targetRef="TxE"/>
    </bpmn:transaction>
    <bpmn:endEvent id="Done"/>
    <bpmn:sequenceFlow id="g1" sourceRef="S" targetRef="Tx"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="Done"/>
  </bpmn:process>
</bpmn:definitions>`;
    const r = await parseAndValidate(TX_MSG_CATCH);
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["catch"]?.scopeId).toBe("Tx");
    expect(r.graph!.nodes["catch"]?.messageName).toBe("Approval");
    expect(r.graph!.nodes["catch"]?.next).toBe("TxE");
  });

  it("rejects a missing/unresolved messageRef", async () => {
    // messageRef names a <message> that does not exist → moddle drops the ref →
    // the receive-task-shaped rule rejects (it is NOT a hidden catch-all).
    const r = await parseAndValidate(msgCatchBpmn({ def: `<bpmn:messageEventDefinition messageRef="Missing"/>` }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "catch" && /must reference a declared <message> via messageRef/.test(i.reason))).toBe(true);
  });

  it("rejects a <message> with no name (correlation needs a non-empty name)", async () => {
    const r = await parseAndValidate(msgCatchBpmn({ message: `<bpmn:message id="M"/>` }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "catch" && /no name|non-empty message name/i.test(i.reason))).toBe(true);
  });

  it("rejects an easy-bpmn:taskDefinition on the catch (an event routes no worker)", async () => {
    const r = await parseAndValidate(
      msgCatchBpmn({
        def: `<bpmn:extensionElements><easy-bpmn:taskDefinition type="nope"/></bpmn:extensionElements><bpmn:messageEventDefinition messageRef="M"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "catch" && /easy-bpmn:taskDefinition/.test(i.reason) && /event, not a service task/.test(i.reason))).toBe(true);
  });

  it("rejects a boundary event attached to a message catch (it is an event, not an activity)", async () => {
    const r = await parseAndValidate(
      msgCatchBpmn({
        extra: `<bpmn:boundaryEvent id="b" attachedToRef="catch"><bpmn:timerEventDefinition><bpmn:timeDuration>PT1M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>`,
        flows: `<bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="catch"/>
                <bpmn:sequenceFlow id="s1" sourceRef="catch" targetRef="after"/>
                <bpmn:sequenceFlow id="sb" sourceRef="b" targetRef="after"/>
                <bpmn:sequenceFlow id="s2" sourceRef="after" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(
      r.issues.some((i) => i.elementId === "b" && /attached to intermediate catch event 'catch'/.test(i.reason)),
    ).toBe(true);
    // Cascade-suppression: the general boundary-on-catch reason `continue`s, so the
    // per-kind "must be attached to a service task" check must NOT also fire.
    expect(r.issues.some((i) => /must be attached to a service task/.test(i.reason))).toBe(false);
  });

  it("rejects more than one outgoing flow (implicit split)", async () => {
    const r = await parseAndValidate(
      msgCatchBpmn({
        flows: `<bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="catch"/>
                <bpmn:sequenceFlow id="s1" sourceRef="catch" targetRef="after"/>
                <bpmn:sequenceFlow id="s1b" sourceRef="catch" targetRef="E"/>
                <bpmn:sequenceFlow id="s2" sourceRef="after" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "catch" && /outgoing sequence flows/.test(i.reason))).toBe(true);
  });

  it("rejects more than one incoming flow (a catch is a single-token wait, not a join)", async () => {
    const r = await parseAndValidate(
      msgCatchBpmn({
        flows: `<bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="after"/>
                <bpmn:sequenceFlow id="s0b" sourceRef="after" targetRef="catch"/>
                <bpmn:sequenceFlow id="s0c" sourceRef="S" targetRef="catch"/>
                <bpmn:sequenceFlow id="s1" sourceRef="catch" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "catch" && /incoming sequence flows/.test(i.reason) && /not a join/.test(i.reason))).toBe(true);
  });

  it("tolerates ignorable content (foreign extension/documentation) on a message-catch model", async () => {
    const r = await parseAndValidate(
      msgCatchBpmn({
        def: `<bpmn:documentation>await approval</bpmn:documentation><bpmn:extensionElements><camunda:properties><camunda:property name="x" value="y"/></camunda:properties></bpmn:extensionElements><bpmn:messageEventDefinition messageRef="M"/>`,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

});

// ---------------------------------------------------------------------------
// M3-L4 (TASK-46, design §3 item 4 / §4.5): the eventBasedGateway — a
// deterministic race over its branch catches. Accept/reject matrix: ≥2 branches,
// every target a single-incoming intermediate catch (timer or message), ≤1 timer
// branch, distinct messages; instantiate / eventGatewayType="Parallel" rejected.
// ---------------------------------------------------------------------------
describe("Event-based gateway (M3-L4, TASK-46)", () => {
  /**
   * S → EBG → { onMsg (message "Approve") , onTimer (timer PT5M) }; each catch
   * continues to a service task and both converge on the end event. Knobs swap the
   * gateway attributes, the branch flows, the branch-target elements, and the
   * <message> declarations.
   */
  function ebgBpmn(o: { gwAttrs?: string; branches?: string; targets?: string; messages?: string; extra?: string } = {}): string {
    const messages = o.messages ?? `<bpmn:message id="MA" name="Approve"/>`;
    const branches =
      o.branches ??
      `<bpmn:sequenceFlow id="e1" sourceRef="EBG" targetRef="onMsg"/>
       <bpmn:sequenceFlow id="e2" sourceRef="EBG" targetRef="onTimer"/>`;
    const targets =
      o.targets ??
      `<bpmn:intermediateCatchEvent id="onMsg"><bpmn:messageEventDefinition messageRef="MA"/></bpmn:intermediateCatchEvent>
       <bpmn:intermediateCatchEvent id="onTimer"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>
       <bpmn:serviceTask id="afterMsg"><bpmn:extensionElements><easy-bpmn:taskDefinition type="am"/></bpmn:extensionElements></bpmn:serviceTask>
       <bpmn:serviceTask id="afterTimer"><bpmn:extensionElements><easy-bpmn:taskDefinition type="at"/></bpmn:extensionElements></bpmn:serviceTask>
       <bpmn:sequenceFlow id="m1" sourceRef="onMsg" targetRef="afterMsg"/>
       <bpmn:sequenceFlow id="m2" sourceRef="onTimer" targetRef="afterTimer"/>
       <bpmn:sequenceFlow id="z1" sourceRef="afterMsg" targetRef="E"/>
       <bpmn:sequenceFlow id="z2" sourceRef="afterTimer" targetRef="E"/>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_ebg" targetNamespace="x">
  ${messages}
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:eventBasedGateway id="EBG" ${o.gwAttrs ?? ""}/>
    ${targets}
    <bpmn:endEvent id="E"/>
    ${o.extra ?? ""}
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="EBG"/>
    ${branches}
  </bpmn:process>
</bpmn:definitions>`;
  }

  it("accepts a timer+message event-based gateway and extracts the IR", async () => {
    const r = await parseAndValidate(ebgBpmn());
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    const g = r.graph!;
    const ebg = g.nodes["EBG"];
    expect(ebg?.type).toBe("eventBasedGateway");
    // Branch selection owns the successor (like an exclusiveGateway): next is null,
    // the engine reads outgoing[] (document order).
    expect(ebg?.next).toBeNull();
    expect(ebg?.outgoing.map((f) => f.targetId)).toEqual(["onMsg", "onTimer"]);
    expect(g.nodes["onMsg"]?.messageName).toBe("Approve");
    expect(g.nodes["onTimer"]?.timerTrigger).toEqual({ kind: "timeDuration", value: "PT5M" });
  });

  it("accepts two distinct-message branches plus a timer branch", async () => {
    const r = await parseAndValidate(
      ebgBpmn({
        messages: `<bpmn:message id="MA" name="Approve"/><bpmn:message id="MR" name="Reject"/>`,
        branches: `<bpmn:sequenceFlow id="e1" sourceRef="EBG" targetRef="onMsg"/>
                   <bpmn:sequenceFlow id="e2" sourceRef="EBG" targetRef="onReject"/>
                   <bpmn:sequenceFlow id="e3" sourceRef="EBG" targetRef="onTimer"/>`,
        targets: `<bpmn:intermediateCatchEvent id="onMsg"><bpmn:messageEventDefinition messageRef="MA"/></bpmn:intermediateCatchEvent>
                  <bpmn:intermediateCatchEvent id="onReject"><bpmn:messageEventDefinition messageRef="MR"/></bpmn:intermediateCatchEvent>
                  <bpmn:intermediateCatchEvent id="onTimer"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>
                  <bpmn:serviceTask id="afterMsg"><bpmn:extensionElements><easy-bpmn:taskDefinition type="am"/></bpmn:extensionElements></bpmn:serviceTask>
                  <bpmn:sequenceFlow id="m1" sourceRef="onMsg" targetRef="afterMsg"/>
                  <bpmn:sequenceFlow id="m2" sourceRef="onReject" targetRef="afterMsg"/>
                  <bpmn:sequenceFlow id="m3" sourceRef="onTimer" targetRef="afterMsg"/>
                  <bpmn:sequenceFlow id="z1" sourceRef="afterMsg" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("rejects fewer than two branches", async () => {
    const r = await parseAndValidate(
      ebgBpmn({
        branches: `<bpmn:sequenceFlow id="e1" sourceRef="EBG" targetRef="onMsg"/>`,
        targets: `<bpmn:intermediateCatchEvent id="onMsg"><bpmn:messageEventDefinition messageRef="MA"/></bpmn:intermediateCatchEvent>
                  <bpmn:serviceTask id="afterMsg"><bpmn:extensionElements><easy-bpmn:taskDefinition type="am"/></bpmn:extensionElements></bpmn:serviceTask>
                  <bpmn:sequenceFlow id="m1" sourceRef="onMsg" targetRef="afterMsg"/>
                  <bpmn:sequenceFlow id="z1" sourceRef="afterMsg" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "EBG" && /races at least two event branches/.test(i.reason))).toBe(true);
  });

  it("rejects a branch whose target is not an intermediate catch event", async () => {
    const r = await parseAndValidate(
      ebgBpmn({
        branches: `<bpmn:sequenceFlow id="e1" sourceRef="EBG" targetRef="onMsg"/>
                   <bpmn:sequenceFlow id="e2" sourceRef="EBG" targetRef="task"/>`,
        targets: `<bpmn:intermediateCatchEvent id="onMsg"><bpmn:messageEventDefinition messageRef="MA"/></bpmn:intermediateCatchEvent>
                  <bpmn:serviceTask id="task"><bpmn:extensionElements><easy-bpmn:taskDefinition type="t"/></bpmn:extensionElements></bpmn:serviceTask>
                  <bpmn:sequenceFlow id="m1" sourceRef="onMsg" targetRef="task"/>
                  <bpmn:sequenceFlow id="z1" sourceRef="task" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "EBG" && /is not an intermediate catch event/.test(i.reason))).toBe(true);
  });

  it("rejects a branch-target catch reached by a second incoming flow (shared catch)", async () => {
    // onMsg is targeted by the EBG AND by `S` directly → two incoming flows.
    const r = await parseAndValidate(
      ebgBpmn({
        branches: `<bpmn:sequenceFlow id="e1" sourceRef="EBG" targetRef="onMsg"/>
                   <bpmn:sequenceFlow id="e2" sourceRef="EBG" targetRef="onTimer"/>
                   <bpmn:sequenceFlow id="e3" sourceRef="S" targetRef="onMsg"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(
      r.issues.some((i) => i.elementId === "EBG" && /exactly one incoming flow — the one from this gateway/.test(i.reason)),
    ).toBe(true);
  });

  it("rejects more than one timer branch", async () => {
    const r = await parseAndValidate(
      ebgBpmn({
        branches: `<bpmn:sequenceFlow id="e1" sourceRef="EBG" targetRef="onTimer"/>
                   <bpmn:sequenceFlow id="e2" sourceRef="EBG" targetRef="onTimer2"/>`,
        targets: `<bpmn:intermediateCatchEvent id="onTimer"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>
                  <bpmn:intermediateCatchEvent id="onTimer2"><bpmn:timerEventDefinition><bpmn:timeDuration>PT9M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>
                  <bpmn:serviceTask id="afterTimer"><bpmn:extensionElements><easy-bpmn:taskDefinition type="at"/></bpmn:extensionElements></bpmn:serviceTask>
                  <bpmn:sequenceFlow id="m1" sourceRef="onTimer" targetRef="afterTimer"/>
                  <bpmn:sequenceFlow id="m2" sourceRef="onTimer2" targetRef="afterTimer"/>
                  <bpmn:sequenceFlow id="z1" sourceRef="afterTimer" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /more than one timer branch/.test(i.reason))).toBe(true);
  });

  it("rejects two branches waiting on the same message (one broker key)", async () => {
    const r = await parseAndValidate(
      ebgBpmn({
        branches: `<bpmn:sequenceFlow id="e1" sourceRef="EBG" targetRef="onMsg"/>
                   <bpmn:sequenceFlow id="e2" sourceRef="EBG" targetRef="onMsg2"/>`,
        targets: `<bpmn:intermediateCatchEvent id="onMsg"><bpmn:messageEventDefinition messageRef="MA"/></bpmn:intermediateCatchEvent>
                  <bpmn:intermediateCatchEvent id="onMsg2"><bpmn:messageEventDefinition messageRef="MA"/></bpmn:intermediateCatchEvent>
                  <bpmn:serviceTask id="afterMsg"><bpmn:extensionElements><easy-bpmn:taskDefinition type="am"/></bpmn:extensionElements></bpmn:serviceTask>
                  <bpmn:sequenceFlow id="m1" sourceRef="onMsg" targetRef="afterMsg"/>
                  <bpmn:sequenceFlow id="m2" sourceRef="onMsg2" targetRef="afterMsg"/>
                  <bpmn:sequenceFlow id="z1" sourceRef="afterMsg" targetRef="E"/>`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /branch waiting on message 'Approve'/.test(i.reason) && /distinct messages/.test(i.reason))).toBe(true);
  });

  it('rejects instantiate="true" (instances start via the API)', async () => {
    const r = await parseAndValidate(ebgBpmn({ gwAttrs: `instantiate="true"` }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "EBG" && /instantiate="true"/.test(i.reason))).toBe(true);
  });

  it('rejects eventGatewayType="Parallel" (wait-for-all is M4-class)', async () => {
    const r = await parseAndValidate(ebgBpmn({ gwAttrs: `eventGatewayType="Parallel"` }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "EBG" && /Parallel event gateway/.test(i.reason))).toBe(true);
  });

  it("tolerates ignorable content (documentation) on an EBG model", async () => {
    const r = await parseAndValidate(ebgBpmn({ extra: `<bpmn:documentation>race the events</bpmn:documentation>` }));
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });
});

describe("M4 concurrency profile", () => {
  it("accepts a balanced AND region and records the region map", async () => {
    const r = await parseAndValidate(PARALLEL_BPMN);
    expect(r.ok).toBe(true);
    expect(r.graph?.regions?.["fork"]).toMatchObject({ joinId: "join", type: "and", branchFlowIds: ["f1", "f2"] });
    expect(r.graph?.nodes["fork"]?.type).toBe("parallelGateway");
  });
  it("accepts a balanced OR region with conditional branches + default", async () => {
    const r = await parseAndValidate(INCLUSIVE_BPMN);
    expect(r.ok).toBe(true);
    expect(r.graph?.regions?.["fork"]).toMatchObject({ joinId: "join", type: "or" });
  });
  it("still rejects complexGateway with a roadmap pointer", async () => {
    const r = await parseAndValidate(deferredGatewayBpmn("complexGateway"));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "G" && /complex/i.test(i.reason))).toBe(true);
  });
  it("rejects a deadlocking AND region (branch loses its token to an end)", async () => {
    const r = await parseAndValidate(PARALLEL_DEADLOCK_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /fork|region|single-exit|matching join/i.test(i.reason))).toBe(true);
  });
  it("rejects a mismatched join type", async () => {
    const r = await parseAndValidate(PARALLEL_MISMATCH_BPMN);
    expect(r.ok).toBe(false);
  });
  it("rejects two concurrent branches on the same message name (blocker 14)", async () => {
    const r = await parseAndValidate(PARALLEL_SAME_MESSAGE_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /same message|broker key|distinct message/i.test(i.reason))).toBe(true);
  });
});

describe("M5-L1 embedded subProcess acceptance", () => {
  const SUBPROC = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="d" targetNamespace="http://example.com">
  <bpmn:process id="proc" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="sub"/>
    <bpmn:subProcess id="sub">
      <bpmn:startEvent id="s_start"/>
      <bpmn:sequenceFlow id="sf1" sourceRef="s_start" targetRef="s_task"/>
      <bpmn:serviceTask id="s_task"><bpmn:extensionElements><easy-bpmn:taskDefinition type="doWork"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="sf2" sourceRef="s_task" targetRef="s_end"/>
      <bpmn:endEvent id="s_end"/>
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="f2" sourceRef="sub" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;

  it("accepts a plain embedded subProcess and compiles its scope", async () => {
    const r = await parseAndValidate(SUBPROC);
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["sub"]!.type).toBe("subProcess");
    expect(r.graph!.nodes["s_task"]!.scopeId).toBe("sub");
    expect(r.graph!.scopes!["sub"]).toEqual({ id: "sub", kind: "subProcess", parentId: null, depth: 1, startId: "s_start" });
  });

  it("rejects an event subprocess (interim → M5-L4) with element id + reason", async () => {
    const r = await parseAndValidate(SUBPROC.replace('<bpmn:subProcess id="sub">', '<bpmn:subProcess id="sub" triggeredByEvent="true">'));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "sub" && /M5-L4/.test(i.reason))).toBe(true);
  });

  it("rejects an adHocSubProcess with element id + reason", async () => {
    const r = await parseAndValidate(SUBPROC.replace(/bpmn:subProcess/g, "bpmn:adHocSubProcess"));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "sub")).toBe(true);
  });

  it("rejects multiInstanceLoopCharacteristics on a subProcess (interim → M5-L3)", async () => {
    const withMi = SUBPROC.replace('<bpmn:startEvent id="s_start"/>', '<bpmn:multiInstanceLoopCharacteristics/><bpmn:startEvent id="s_start"/>');
    const r = await parseAndValidate(withMi);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "sub" && /M5-L3/.test(i.reason))).toBe(true);
  });

  it("enforces MAX_SCOPE_DEPTH: depth 8 accepted, depth 9 rejected", async () => {
    const nest = (depth: number): string => {
      let inner = `<bpmn:startEvent id="d${depth}_start"/><bpmn:sequenceFlow id="d${depth}_f" sourceRef="d${depth}_start" targetRef="d${depth}_end"/><bpmn:endEvent id="d${depth}_end"/>`;
      for (let d = depth; d >= 1; d--) {
        inner = `<bpmn:startEvent id="d${d - 1}_start"/><bpmn:sequenceFlow id="d${d - 1}_f1" sourceRef="d${d - 1}_start" targetRef="sub${d}"/><bpmn:subProcess id="sub${d}">${inner}</bpmn:subProcess><bpmn:sequenceFlow id="d${d - 1}_f2" sourceRef="sub${d}" targetRef="d${d - 1}_end"/><bpmn:endEvent id="d${d - 1}_end"/>`;
      }
      return `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="http://example.com"><bpmn:process id="proc" isExecutable="true">${inner}</bpmn:process></bpmn:definitions>`;
    };
    expect((await parseAndValidate(nest(8))).ok).toBe(true);
    const r9 = await parseAndValidate(nest(9));
    expect(r9.ok).toBe(false);
    expect(r9.issues.some((i) => /MAX_SCOPE_DEPTH|depth/.test(i.reason))).toBe(true);
  });

  it("tolerates and ignores foreign-namespace extension content inside a subProcess", async () => {
    // spec §10 unit bullet: ignorable extension content must not reject.
    const withForeign = SUBPROC.replace(
      '<bpmn:startEvent id="s_start"/>',
      '<bpmn:extensionElements xmlns:camunda="http://camunda.org/schema/1.0/bpmn"><camunda:properties/></bpmn:extensionElements><bpmn:startEvent id="s_start"/>',
    );
    expect((await parseAndValidate(withForeign)).ok).toBe(true);
  });

  it("accepts a transaction nested inside a subProcess and records parentage", async () => {
    const NESTED = SUBPROC.replace(
      '<bpmn:serviceTask id="s_task"><bpmn:extensionElements><easy-bpmn:taskDefinition type="doWork"/></bpmn:extensionElements></bpmn:serviceTask>',
      `<bpmn:transaction id="tx"><bpmn:startEvent id="t_start"/><bpmn:sequenceFlow id="tf1" sourceRef="t_start" targetRef="t_end"/><bpmn:endEvent id="t_end"/></bpmn:transaction>`,
    ).replace(/s_task/g, "tx");
    const r = await parseAndValidate(NESTED);
    expect(r.ok).toBe(true);
    expect(r.graph!.scopes!["tx"]).toMatchObject({ kind: "transaction", parentId: "sub", depth: 2 });
  });
});
