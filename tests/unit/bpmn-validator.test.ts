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

  it("rejects a subprocess", async () => {
    const r = await parseAndValidate(SUBPROCESS_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "SP" && /subProcess/.test(i.reason))).toBe(true);
  });

  it("rejects a send task", async () => {
    const r = await parseAndValidate(SEND_TASK_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "T" && /sendTask/.test(i.reason))).toBe(true);
  });

  it("rejects an intermediate catch event", async () => {
    const r = await parseAndValidate(INTERMEDIATE_CATCH_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "IC" && /intermediateCatchEvent/.test(i.reason))).toBe(true);
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

  it.each([
    ["parallelGateway", /concurrency \(M4\)/],
    ["inclusiveGateway", /concurrency \(M4\)/],
    ["eventBasedGateway", /timers & events \(M3\)/],
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
