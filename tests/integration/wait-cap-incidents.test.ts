import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_BPMN, SAGA_BPMN, drainSampleWorkers, get, post, publishAndStart } from "../helpers";
import { runInstance } from "../../src/runtime/engine";
import type { RunStep, WaitForEvent } from "../../src/runtime/engine";

// M3-L1 (TASK-39): the overloaded incident kind 'timeout' is split. The
// un-guarded service-task and receive-task durable-wait CAPS now settle a
// `waitTimeout` incident (distinct from the DLQ's `jobActivationTimeout` and
// from the compensation-wait cap's `compensationFailure`).
//
// Direct mode parks instead of waiting, so the wait-cap path is exercised here
// by re-driving the instance with a `waitFor` stub that returns a timeout —
// the same seam the WorkflowExecutor wires to step.waitForEvent.

const inline: RunStep = (_name, fn) => fn();
const timeoutWait: WaitForEvent = async () => ({ kind: "timeout" });

describe("durable-wait caps → waitTimeout (M3-L1, TASK-39)", () => {
  it("an un-guarded service-task wait cap settles a waitTimeout incident", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: `wt-svc-${crypto.randomUUID()}`, variables: { amount: 1 } });
    const id = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting"); // parked at the pull Service Task, job created, never leased

    const result = await runInstance(env, id, { runStep: inline, waitFor: timeoutWait });
    expect(result.status).toBe("incident");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("waitTimeout");
    expect(inst.body.incident.elementId).toBe("Task_check");
  });

  it("an un-guarded receive-task wait cap settles a waitTimeout incident", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: `wt-recv-${crypto.randomUUID()}`, variables: { amount: 1 } });
    const id = instance.body.instanceId;

    // Advance past the Service Task so the instance parks at the Receive Task
    // with an active subscription (no message ever arrives).
    await drainSampleWorkers({ taskTypes: ["external-check"] });
    const waiting = await get(`/instances/${id}`);
    expect(waiting.body.status).toBe("waiting");
    expect(waiting.body.currentElementId).toBe("Task_wait");

    const result = await runInstance(env, id, { runStep: inline, waitFor: timeoutWait });
    expect(result.status).toBe("incident");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("waitTimeout");
    expect(inst.body.incident.elementId).toBe("Task_wait");
  });

  // AC#2 regression: the compensation-wait cap is DELIBERATELY not a timeout
  // site — it writes compensationFailure + status compensationFailed and must
  // stay that way after the split.
  it("the compensation-wait cap stays compensationFailure + compensationFailed (NOT waitTimeout)", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, { correlationKey: `wt-comp-${crypto.randomUUID()}`, variables: { qty: 1, amount: 30 } });
    const id = instance.body.instanceId;

    // reserveStock completes (compensatable, ledger 'pending'); operator cancels
    // → the reverse pass creates a compensation job and parks at 'compensating'.
    await drainSampleWorkers({ taskTypes: ["reserve-stock"] });
    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.body.status).toBe("compensating");

    // The compensation job's wait now CAPS (no worker ever completes it).
    const result = await runInstance(env, id, { runStep: inline, waitFor: timeoutWait });
    expect(result.status).toBe("incident");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("compensationFailed");
    expect(inst.body.incident.kind).toBe("compensationFailure");
    // The split must NOT leak the wait taxonomy into the compensation path.
    expect(inst.body.openIncidents.some((i: any) => i.kind === "waitTimeout")).toBe(false);
    expect(inst.body.openIncidents.some((i: any) => i.kind === "compensationFailure")).toBe(true);
  });
});
