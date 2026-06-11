import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, publishDraft, SAGA_BPMN, XOR_BPMN, XOR_IN_TX_BPMN } from "../helpers";
import {
  createVersion,
  getVersionElements,
  getVersionGraph,
} from "../../src/persistence/definitions";
import { parseAndValidate } from "../../src/bpmn/validator";

// TASK-11 closeout (design §3.2): topology is persisted BOTH as the parsed_profile
// JSON and as queryable bpmn_elements rows. The validator no longer drops
// sequence-flow source/target or association source/target.

describe("Saga topology persistence (TASK-11 closeout)", () => {
  async function publishSaga() {
    const draft = await createDraft(SAGA_BPMN, "order-saga");
    expect(draft.status).toBe(201);
    const version = await publishDraft(draft.body.draftId);
    expect(version.status).toBe(201);
    return version.body.definitionVersionId as string;
  }

  it("persists sequenceFlow source/target as queryable bpmn_elements rows (no longer NULL)", async () => {
    const versionId = await publishSaga();
    const rows = await env.DB.prepare(
      `SELECT element_id, source_ref, target_ref FROM bpmn_elements
         WHERE definition_version_id = ? AND type = 'sequenceFlow' ORDER BY element_id`,
    )
      .bind(versionId)
      .all<{ element_id: string; source_ref: string | null; target_ref: string | null }>();

    const byId = Object.fromEntries((rows.results ?? []).map((r) => [r.element_id, r]));
    // inner transaction chain + process-level edges all carry their refs
    expect(byId["f1"]).toMatchObject({ source_ref: "Tx_start", target_ref: "reserveStock" });
    expect(byId["f2"]).toMatchObject({ source_ref: "reserveStock", target_ref: "chargeCard" });
    expect(byId["f4"]).toMatchObject({ source_ref: "confirmShipping", target_ref: "Tx_ok" });
    expect(byId["f5"]).toMatchObject({ source_ref: "shipping_err", target_ref: "Tx_cancel" });
    expect(byId["g1"]).toMatchObject({ source_ref: "Start", target_ref: "Tx_order" });
    expect(byId["g3"]).toMatchObject({ source_ref: "Tx_cancelled", target_ref: "SagaFailed" });
    // none are NULL
    for (const r of rows.results ?? []) {
      expect(r.source_ref).not.toBeNull();
      expect(r.target_ref).not.toBeNull();
    }
  });

  it("persists association source/target (boundaryId → handlerId)", async () => {
    const versionId = await publishSaga();
    const rows = await env.DB.prepare(
      `SELECT element_id, source_ref, target_ref FROM bpmn_elements
         WHERE definition_version_id = ? AND type = 'association' ORDER BY element_id`,
    )
      .bind(versionId)
      .all<{ element_id: string; source_ref: string | null; target_ref: string | null }>();
    const byId = Object.fromEntries((rows.results ?? []).map((r) => [r.element_id, r]));
    expect(byId["a1"]).toMatchObject({ source_ref: "reserveStock_comp", target_ref: "releaseStock" });
    expect(byId["a2"]).toMatchObject({ source_ref: "chargeCard_comp", target_ref: "refundCard" });
  });

  it("exposes sourceRef/targetRef on the version API element list", async () => {
    const versionId = await publishSaga();
    const r = await env.DB.prepare(
      `SELECT parsed_profile FROM definition_versions WHERE definition_version_id = ?`,
    ).bind(versionId).first<{ parsed_profile: string }>();
    expect(r).toBeTruthy();
    // version API is exercised via getVersionElements below; here assert the
    // GET /definitions/versions response surfaces the refs.
    const resp = await (await import("../helpers")).get(`/definitions/versions/${versionId}`);
    const flow = resp.body.elements.find((e: any) => e.elementId === "f1");
    expect(flow).toMatchObject({ type: "sequenceFlow", sourceRef: "Tx_start", targetRef: "reserveStock" });
    const assoc = resp.body.elements.find((e: any) => e.elementId === "a1");
    expect(assoc).toMatchObject({ type: "association", sourceRef: "reserveStock_comp", targetRef: "releaseStock" });
  });

  it("getVersionGraph round-trips deep-equal to a fresh parse (replay determinism)", async () => {
    const versionId = await publishSaga();
    const stored = await getVersionGraph(env.DB, versionId);
    const fresh = (await parseAndValidate(SAGA_BPMN)).graph;
    expect(stored).toEqual(fresh);
    // the multi-edge IR + scope + associations all survive the round-trip
    expect(stored!.nodes["reserveStock"]!.outgoing).toEqual([
      { flowId: "f2", targetId: "chargeCard", conditionExpression: null, isDefault: false },
    ]);
    expect(stored!.transactions!["Tx_order"]!.compensations["chargeCard"]).toEqual({
      handlerId: "refundCard",
      boundaryId: "chargeCard_comp",
    });
  });
});

// TASK-31 (M2 design §4): conditional topology persists into bpmn_elements
// (condition_expression / is_default) and parsed_profile. These tests insert
// the version DIRECTLY via createVersion to pin the persistence layer in
// isolation (the HTTP publish path accepts XOR models since TASK-33 and is
// covered by tests/contract/api.test.ts).
describe("Conditional topology persistence (TASK-31)", () => {
  async function createConditionalVersion() {
    const r = await parseAndValidate(XOR_BPMN);
    expect(r.ok).toBe(true); // TASK-33 opened the publish gate for XOR models
    expect(r.graph).toBeDefined();
    const versionId = `pdv_xor_${crypto.randomUUID()}`;
    await createVersion(env.DB, {
      definitionVersionId: versionId,
      draftId: `draft_xor_${crypto.randomUUID()}`,
      workspaceId: "default",
      versionNumber: 1,
      bpmnXml: XOR_BPMN,
      bpmnXmlHash: "test-hash-xor",
      graph: r.graph!,
      now: new Date().toISOString(),
    });
    return versionId;
  }

  it("persists condition_expression/is_default on sequenceFlow bpmn_elements rows", async () => {
    const versionId = await createConditionalVersion();
    const rows = await env.DB.prepare(
      `SELECT element_id, type, source_ref, target_ref, condition_expression, is_default
         FROM bpmn_elements WHERE definition_version_id = ? ORDER BY element_id`,
    )
      .bind(versionId)
      .all<{
        element_id: string;
        type: string;
        source_ref: string | null;
        target_ref: string | null;
        condition_expression: string | null;
        is_default: number;
      }>();
    const byId = Object.fromEntries((rows.results ?? []).map((row) => [row.element_id, row]));

    expect(byId["GW_split"]).toMatchObject({ type: "exclusiveGateway" });
    expect(byId["GW_join"]).toMatchObject({ type: "exclusiveGateway" });
    expect(byId["f_gold"]).toMatchObject({
      type: "sequenceFlow",
      source_ref: "GW_split",
      target_ref: "T_gold",
      condition_expression: "amount > 100",
      is_default: 0,
    });
    expect(byId["f_silver"]).toMatchObject({ condition_expression: "amount > 10", is_default: 0 });
    expect(byId["f_def"]).toMatchObject({ condition_expression: null, is_default: 1 });
    // unconditional flows stay null/0
    expect(byId["f0"]).toMatchObject({ condition_expression: null, is_default: 0 });
    expect(byId["f_end"]).toMatchObject({ condition_expression: null, is_default: 0 });
  });

  it("getVersionElements returns conditionExpression/isDefault", async () => {
    const versionId = await createConditionalVersion();
    const elements = await getVersionElements(env.DB, versionId);
    const byId = Object.fromEntries(elements.map((e) => [e.elementId, e]));
    expect(byId["f_gold"]).toMatchObject({ conditionExpression: "amount > 100", isDefault: false });
    expect(byId["f_silver"]).toMatchObject({ conditionExpression: "amount > 10", isDefault: false });
    expect(byId["f_def"]).toMatchObject({ conditionExpression: null, isDefault: true });
    expect(byId["GW_split"]).toMatchObject({ type: "exclusiveGateway" });
    const defaults = elements.filter((e) => e.isDefault).map((e) => e.elementId);
    expect(defaults).toEqual(["f_def"]);
  });

  it("getVersionGraph round-trips deep-equal to a fresh parse, conditions + outgoing order included", async () => {
    const versionId = await createConditionalVersion();
    const stored = await getVersionGraph(env.DB, versionId);
    const fresh = (await parseAndValidate(XOR_BPMN)).graph;
    expect(stored).toEqual(fresh);
    // the conditional multi-edge IR survives the parsed_profile round-trip,
    // in document order (= condition evaluation order, design §2 decision 5)
    expect(stored!.nodes["GW_split"]!.outgoing).toEqual([
      { flowId: "f_gold", targetId: "T_gold", conditionExpression: "amount > 100", isDefault: false },
      { flowId: "f_silver", targetId: "T_silver", conditionExpression: "amount > 10", isDefault: false },
      { flowId: "f_def", targetId: "T_basic", conditionExpression: null, isDefault: true },
    ]);
    expect(stored!.nodes["GW_split"]!.next).toBeNull();
    expect(stored!.nodes["GW_join"]!.outgoing).toEqual([
      { flowId: "f_end", targetId: "E", conditionExpression: null, isDefault: false },
    ]);
  });

  it("transaction-scoped XOR: getVersionGraph round-trips deep-equal + condition columns persist", async () => {
    // Regression class: conditions dropped ONLY inside <transaction> scopes.
    // The gateway-inside-transaction fixture must survive the same persistence
    // round-trip as the flat XOR model above.
    const r = await parseAndValidate(XOR_IN_TX_BPMN);
    expect(r.ok).toBe(true); // TASK-33 opened the publish gate for XOR models
    expect(r.graph).toBeDefined();
    const versionId = `pdv_xortx_${crypto.randomUUID()}`;
    await createVersion(env.DB, {
      definitionVersionId: versionId,
      draftId: `draft_xortx_${crypto.randomUUID()}`,
      workspaceId: "default",
      versionNumber: 1,
      bpmnXml: XOR_IN_TX_BPMN,
      bpmnXmlHash: "test-hash-xortx",
      graph: r.graph!,
      now: new Date().toISOString(),
    });

    // parsed_profile round-trip: tx-scoped conditional IR deep-equals a fresh parse
    const stored = await getVersionGraph(env.DB, versionId);
    const fresh = (await parseAndValidate(XOR_IN_TX_BPMN)).graph;
    expect(stored).toEqual(fresh);
    expect(stored!.nodes["GW"]!.scopeId).toBe("Tx");
    expect(stored!.nodes["GW"]!.outgoing).toEqual([
      { flowId: "t_a", targetId: "A", conditionExpression: "ok", isDefault: false },
      { flowId: "t_b", targetId: "B", conditionExpression: null, isDefault: true },
    ]);
    expect(stored!.transactions!["Tx"]!.childIds).toContain("GW");

    // ...and the bpmn_elements condition columns persist for tx-scoped flows
    const rows = await env.DB.prepare(
      `SELECT element_id, condition_expression, is_default FROM bpmn_elements
         WHERE definition_version_id = ? AND type = 'sequenceFlow' ORDER BY element_id`,
    )
      .bind(versionId)
      .all<{ element_id: string; condition_expression: string | null; is_default: number }>();
    const byId = Object.fromEntries((rows.results ?? []).map((row) => [row.element_id, row]));
    expect(byId["t_a"]).toMatchObject({ condition_expression: "ok", is_default: 0 });
    expect(byId["t_b"]).toMatchObject({ condition_expression: null, is_default: 1 });
    // process-level + remaining tx-internal flows stay unconditional
    expect(byId["g1"]).toMatchObject({ condition_expression: null, is_default: 0 });
    expect(byId["t2"]).toMatchObject({ condition_expression: null, is_default: 0 });
  });
});
