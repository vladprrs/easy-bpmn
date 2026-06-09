import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, publishDraft, SAGA_BPMN } from "../helpers";
import { getVersionGraph } from "../../src/persistence/definitions";
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
