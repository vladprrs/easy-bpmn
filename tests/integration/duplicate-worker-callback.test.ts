import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_BPMN, get, publishAndStart } from "../helpers";
import { runInstance } from "../../src/runtime/engine";

// SC-004 / FR-010 / quickstart "Validation Commands": duplicate worker callbacks
// are at-least-once inputs and must not advance the instance twice or corrupt
// variables. The sample worker runs synchronously, so a "duplicate callback" is
// modeled by re-driving the engine from the already-completed Service Task — the
// completed-job idempotency guard must make it a no-op for the worker.
describe("Scenario: duplicate Service Task worker callback idempotency", () => {
  it("a re-delivered Service Task completion does not advance twice or duplicate variables", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "dupwork-1",
      variables: { amount: 42 },
    });
    const instanceId = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting");
    expect(instance.body.variables.checkedAmount).toBe(42);

    const before = await get(`/instances/${instanceId}/history`);
    const startedBefore = before.body.events.filter((e: any) => e.type === "workerAttemptStarted").length;
    expect(startedBefore).toBe(1);

    // Duplicate worker callback ≈ re-running the Service Task step.
    const inline = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
    await runInstance(env, instanceId, { runStep: inline, waitFor: null, startAt: "Task_check" });

    const after = await get(`/instances/${instanceId}`);
    expect(after.body.status).toBe("waiting"); // still waiting — did not advance past Receive
    expect(after.body.variables.checkedAmount).toBe(42); // not duplicated/corrupted
    expect(after.body.variables.checkStatus).toBe("approved");

    const afterHist = await get(`/instances/${instanceId}/history`);
    const startedAfter = afterHist.body.events.filter((e: any) => e.type === "workerAttemptStarted").length;
    const succeededAfter = afterHist.body.events.filter((e: any) => e.type === "workerAttemptSucceeded").length;
    const correlatedAfter = afterHist.body.events.filter((e: any) => e.type === "messageCorrelated").length;
    expect(startedAfter).toBe(1); // no second worker attempt
    expect(succeededAfter).toBe(1);
    expect(correlatedAfter).toBe(0); // no message published yet → no correlation
  });
});
