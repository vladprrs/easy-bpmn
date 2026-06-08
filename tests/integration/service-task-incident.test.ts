import { describe, expect, it } from "vitest";
import { DEMO_BPMN, get, publishAndStart } from "../helpers";

describe("Scenario 5: Service Task retry and incident", () => {
  it("records each attempt and creates a view-only incident on exhaustion", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "inc-1",
      variables: { amount: 1, forceFail: true },
    });
    const instanceId = instance.body.instanceId;
    expect(instance.body.status).toBe("incident");

    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident).toBeTruthy();
    expect(inst.body.incident.elementId).toBe("Task_check");
    expect(inst.body.incident.retryCount).toBe(3); // retries="3" → 3 attempts
    expect(inst.body.incident.status).toBe("open");

    const history = await get(`/instances/${instanceId}/history`);
    const failed = history.body.events.filter((e: any) => e.type === "workerAttemptFailed");
    expect(failed).toHaveLength(3);
    const incident = history.body.events.find((e: any) => e.type === "incidentCreated");
    expect(incident).toBeTruthy();
    expect(incident.diagnostics.recovery).toMatch(/outside the MVP/i);
  });
});
