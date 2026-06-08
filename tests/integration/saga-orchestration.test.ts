import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SAGA_BPMN, drainSampleWorkers, get, publishAndStart, publishDraft } from "../helpers";

// End-to-end transaction-saga orchestration over the pull data plane (the §3
// order saga). Forward steps reserve-stock → charge-card → confirm-shipping; a
// business failure of confirm-shipping cancels the transaction and compensates
// the completed steps in REVERSE order (refund-card, then release-stock).

const SAGA_TASKS = ["reserve-stock", "charge-card", "confirm-shipping", "release-stock", "refund-card"];

async function ledger(instanceId: string) {
  const res = await env.DB.prepare(
    `SELECT element_id, seq, compensation_status FROM saga_steps WHERE instance_id = ? ORDER BY seq`,
  ).bind(instanceId).all<{ element_id: string; seq: number; compensation_status: string }>();
  return res.results ?? [];
}

describe("transaction-saga orchestration", () => {
  it("commits the happy saga (all forward steps succeed)", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "saga-ok",
      variables: { qty: 2, amount: 100 },
    });
    const id = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting"); // parked at reserveStock

    await drainSampleWorkers({ taskTypes: SAGA_TASKS });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.currentElementId).toBe("SagaDone");
    expect(inst.body.variables).toMatchObject({ reservationId: expect.any(String), chargeId: expect.any(String), shipmentId: expect.any(String) });

    // All completed steps are in the ledger in completion order; on COMMIT the
    // compensatable steps are terminalized to `committed` (so a later cancel of a
    // different scope cannot re-compensate them); confirmShipping had no
    // compensator so it stays `notRequired`.
    const rows = await ledger(id);
    expect(rows.map((r) => r.element_id)).toEqual(["reserveStock", "chargeCard", "confirmShipping"]);
    expect(rows.find((r) => r.element_id === "reserveStock")?.compensation_status).toBe("committed");
    expect(rows.find((r) => r.element_id === "chargeCard")?.compensation_status).toBe("committed");
    expect(rows.find((r) => r.element_id === "confirmShipping")?.compensation_status).toBe("notRequired");
  });

  it("compensates completed steps in REVERSE order on a business failure", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "saga-comp",
      variables: { qty: 2, amount: 100, shippingFails: true },
    });
    const id = instance.body.instanceId;

    await drainSampleWorkers({ taskTypes: SAGA_TASKS });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("compensated");
    expect(inst.body.currentElementId).toBe("SagaFailed");

    // Reverse completion order: chargeCard (seq 2) compensated before reserveStock (seq 1).
    const history = await get(`/instances/${id}/history`);
    const compStarts = history.body.events.filter((e: any) => e.type === "compensationStarted").map((e: any) => e.elementId);
    expect(compStarts).toEqual(["chargeCard", "reserveStock"]);

    const rows = await ledger(id);
    expect(rows.find((r) => r.element_id === "reserveStock")?.compensation_status).toBe("compensated");
    expect(rows.find((r) => r.element_id === "chargeCard")?.compensation_status).toBe("compensated");
  });

  it("settles to compensationFailed when a compensator exhausts its retries", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "saga-compfail",
      variables: { qty: 1, amount: 50, shippingFails: true, refundFails: true },
    });
    const id = instance.body.instanceId;

    await drainSampleWorkers({ taskTypes: SAGA_TASKS, maxRounds: 80 });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("compensationFailed");
    expect(inst.body.incident.kind).toBe("compensationFailure");

    // The failing compensator (chargeCard's refund) is `failed`; the reverse pass
    // stopped, so the earlier reserveStock step is still `pending` (not compensated).
    const rows = await ledger(id);
    expect(rows.find((r) => r.element_id === "chargeCard")?.compensation_status).toBe("failed");
    expect(rows.find((r) => r.element_id === "reserveStock")?.compensation_status).toBe("pending");
  });

  it("keeps a mid-saga instance bound to v1's graph after v2 publishes (compensation via v1)", async () => {
    const { versionId: v1, draftId, instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "saga-ver",
      variables: { qty: 1, amount: 50, shippingFails: true },
    });
    const id = instance.body.instanceId;

    // A new immutable version is published while the instance is mid-saga.
    const v2 = await publishDraft(draftId);
    expect(v2.body.definitionVersionId).not.toBe(v1);

    await drainSampleWorkers({ taskTypes: SAGA_TASKS });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.definitionVersionId).toBe(v1); // still bound to v1
    expect(inst.body.status).toBe("compensated"); // compensated via v1's graph
  });
});
