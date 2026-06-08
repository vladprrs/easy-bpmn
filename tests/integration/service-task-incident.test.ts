import { describe, expect, it } from "vitest";
import { DEMO_BPMN, drainSampleWorkers, get, publishAndStart } from "../helpers";

describe("Scenario 5: Service Task retry (via re-lease) and incident on exhaustion", () => {
  it("re-leases until retries are exhausted, then creates a view-only incident", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "inc-1",
      variables: { amount: 1, forceFail: true },
    });
    const instanceId = instance.body.instanceId;
    // Parked at the pull Service Task awaiting a worker.
    expect(instance.body.status).toBe("waiting");

    // The sample worker always fails (forceFail). Each technical failure re-leases
    // the job (attempt++) until retries="3" is exhausted → the engine incidents.
    await drainSampleWorkers({ taskTypes: ["external-check"] });

    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident).toBeTruthy();
    expect(inst.body.incident.elementId).toBe("Task_check");
    expect(inst.body.incident.retryCount).toBe(3); // retries="3" → 3 attempts
    expect(inst.body.incident.status).toBe("open");
    expect(inst.body.incident.kind).toBe("serviceTaskFailure");

    const history = await get(`/instances/${instanceId}/history`);
    const failed = history.body.events.filter((e: any) => e.type === "jobFailed");
    expect(failed).toHaveLength(3);
    expect(history.body.events.some((e: any) => e.type === "incidentCreated")).toBe(true);
  });
});
