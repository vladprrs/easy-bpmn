import { describe, expect, it } from "vitest";
import { parseAndValidate } from "../../src/bpmn/validator";
import { roundTripBpmnXml } from "../../src/bpmn/parser";
import {
  CALL_ACTIVITY_BPMN,
  CONDITIONAL_FLOW_BPMN,
  DEMO_BPMN,
  EMPTY_MESSAGE_NAME_BPMN,
  GATEWAY_BPMN,
  INSTANTIATE_RECEIVE_BPMN,
  INTERMEDIATE_CATCH_BPMN,
  MALFORMED_XML,
  MULTI_INSTANCE_BPMN,
  NO_TASKTYPE_BPMN,
  SAGA_BPMN,
  SAGA_CANCEL_BOUNDARY_ON_TASK_BPMN,
  SAGA_CANCEL_END_OUTSIDE_TX_BPMN,
  SAGA_CROSS_SCOPE_ASSOC_BPMN,
  SAGA_TOLERANT_BPMN,
  SEND_TASK_BPMN,
  SUBPROCESS_BPMN,
  sagaBpmn,
  TIMER_START_BPMN,
  TOLERANT_BPMN,
  USERTASK_BPMN,
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

  it("rejects an exclusive gateway with the offending element id", async () => {
    const r = await parseAndValidate(GATEWAY_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "G" && /exclusiveGateway/.test(i.reason))).toBe(true);
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

  it("rejects a conditional sequence flow", async () => {
    const r = await parseAndValidate(CONDITIONAL_FLOW_BPMN);
    expect(r.ok).toBe(false);
    expect(reasons(r.issues)).toMatch(/[Cc]onditional sequence flow/);
  });

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
