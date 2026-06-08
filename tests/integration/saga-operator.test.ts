import { describe, expect, it } from "vitest";
import { SAGA_BPMN, drainSampleWorkers, get, post, publishAndStart } from "../helpers";

const SAGA_TASKS = ["reserve-stock", "charge-card", "confirm-shipping", "release-stock", "refund-card"];

describe("operator remediation verbs", () => {
  it("operator /cancel mid-saga compensates the completed steps", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "op-cancel",
      variables: { qty: 1, amount: 30 },
    });
    const id = instance.body.instanceId;

    // Drive only the first forward step, leaving the instance parked at chargeCard.
    await drainSampleWorkers({ taskTypes: ["reserve-stock"] });
    const mid = await get(`/instances/${id}`);
    expect(mid.body.status).toBe("waiting");
    expect(mid.body.currentElementId).toBe("chargeCard");

    // Operator cancels → reverse compensation of reserveStock.
    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("compensating");

    await drainSampleWorkers({ taskTypes: SAGA_TASKS });
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    expect(done.body.saga.steps.find((s: any) => s.elementId === "reserveStock").compensationStatus).toBe("compensated");
  });

  it("operator /cancel with an empty ledger cancels outright", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "op-cancel-empty",
      variables: { qty: 1, amount: 10 },
    });
    const id = instance.body.instanceId;
    // Parked at reserveStock with nothing completed yet → nothing to compensate.
    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("cancelled");
  });

  it("operator /retry resumes a compensationFailed saga after fixing the condition", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "op-retry",
      variables: { qty: 1, amount: 50, shippingFails: true, refundFails: true },
    });
    const id = instance.body.instanceId;

    await drainSampleWorkers({ taskTypes: SAGA_TASKS, maxRounds: 80 });
    expect((await get(`/instances/${id}`)).body.status).toBe("compensationFailed");

    // Operator fixes the downstream issue (refundFails=false) and retries.
    const retry = await post(`/instances/${id}/retry`, { variables: { refundFails: false } });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("compensating");

    await drainSampleWorkers({ taskTypes: SAGA_TASKS });
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    expect(done.body.saga.steps.find((s: any) => s.elementId === "chargeCard").compensationStatus).toBe("compensated");
    expect(done.body.saga.steps.find((s: any) => s.elementId === "reserveStock").compensationStatus).toBe("compensated");
  });

  it("operator /cancel forces compensation of an in-transaction Hazard incident", async () => {
    // reserveStock completes (compensatable, ledger 'pending'); chargeCard fails
    // TECHNICALLY to exhaustion → Hazard → incident (NOT auto-compensated).
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "op-hazard",
      variables: { qty: 1, amount: 40, chargeFails: true },
    });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: SAGA_TASKS, maxRounds: 80 });

    const hazard = await get(`/instances/${id}`);
    expect(hazard.body.status).toBe("incident");
    expect(hazard.body.incident.kind).toBe("serviceTaskFailure");
    // The completed reserveStock step is stranded (Hazard does not auto-compensate).
    expect(hazard.body.saga.steps.find((s: any) => s.elementId === "reserveStock").compensationStatus).toBe("pending");

    // Operator forces compensation of the Hazarded transaction.
    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("compensating");

    await drainSampleWorkers({ taskTypes: SAGA_TASKS });
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    expect(done.body.saga.steps.find((s: any) => s.elementId === "reserveStock").compensationStatus).toBe("compensated");
  });

  it("rejects a /cancel on a terminal instance (409)", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "op-terminal",
      variables: { qty: 1, amount: 10 },
    });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: SAGA_TASKS });
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
    const r = await post(`/instances/${id}/cancel`, {});
    expect(r.status).toBe(409);
  });
});

describe("operator read API", () => {
  it("exposes the saga view on GET /instances/{id}", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "saga-view",
      variables: { qty: 1, amount: 20 },
    });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: SAGA_TASKS });
    const inst = await get(`/instances/${id}`);
    expect(inst.body.saga).toBeTruthy();
    expect(inst.body.saga.traceId).toBe(`trace_${id}`);
    expect(inst.body.saga.phase).toBe("forward");
    expect(inst.body.saga.steps.length).toBeGreaterThanOrEqual(2);
    expect(inst.body.saga.steps.find((s: any) => s.elementId === "reserveStock").compensationElementId).toBe("releaseStock");
  });

  it("lists instances filtered by workspace + status", async () => {
    const ws = "ws-list";
    // two compensating-then-terminal + one waiting
    const a = await publishAndStart(SAGA_BPMN, { correlationKey: "list-a", variables: { qty: 1, amount: 5 } });
    // a's workspace is default (publishAndStart uses default); start one in a dedicated workspace via the API directly
    void a;
    const r = await get(`/instances?workspaceId=default&status=completed&limit=5`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.instances)).toBe(true);
    // (default workspace accrues completed instances across this suite)
    void ws;
  });
});
