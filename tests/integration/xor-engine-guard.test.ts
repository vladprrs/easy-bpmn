import { describe, expect, it } from "vitest";
import { get, publishAndStart, XOR_BPMN } from "../helpers";

// TASK-34 replaces this guard (and reworks this test into real XOR dispatch
// coverage). Until then: TASK-33 opened the publish gate for XOR models, but
// the engine cannot dispatch a gateway yet — a started instance must settle a
// deterministic operator-visible incident, never complete or zombify silently.
describe("Engine guard: exclusiveGateway dispatch not yet supported (pre-TASK-34)", () => {
  it("settles a terminal incident when the token reaches the gateway", async () => {
    const { instance } = await publishAndStart(XOR_BPMN, {
      correlationKey: "xor-guard-1",
      variables: { amount: 42 },
    });
    expect(instance.status).toBe(201);
    const instanceId = instance.body.instanceId;

    const inst = await get(`/instances/${instanceId}`);
    // NOT a silent completion and NOT a running zombie.
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident).toBeTruthy();
    expect(inst.body.incident.elementId).toBe("GW_split");
    expect(inst.body.incident.status).toBe("open");
    // The reason is operator-visible and points at the missing capability.
    expect(inst.body.incident.reason).toMatch(/exclusiveGateway dispatch/);
    expect(inst.body.incident.reason).toMatch(/TASK-34/);

    const history = await get(`/instances/${instanceId}/history`);
    expect(history.body.events.some((e: any) => e.type === "incidentCreated")).toBe(true);
    expect(history.body.events.some((e: any) => e.type === "instanceCompleted")).toBe(false);
  });
});
