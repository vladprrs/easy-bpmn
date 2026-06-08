import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_BPMN, drainSampleWorkers, get, publishAndStart } from "../helpers";
import { runInstance } from "../../src/runtime/engine";

// SC-004 / FR-010: worker callbacks are at-least-once and must not advance the
// instance twice or corrupt variables. The dedicated lock_token + idempotency
// record cover a duplicate HTTP /complete (see saga-pull-jobs). Here we assert
// the ENGINE-side guard: re-driving from an already-completed forward Service
// Task job is a no-op (no new job, no variable corruption, no double advance).
describe("Scenario: duplicate Service Task completion idempotency (engine guard)", () => {
  it("a redundant resume over a completed forward job does not advance twice", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "dupwork-1",
      variables: { amount: 42 },
    });
    const instanceId = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting");

    // A worker completes the forward Service Task; the instance reaches the Receive Task.
    await drainSampleWorkers({ taskTypes: ["external-check"] });
    const mid = await get(`/instances/${instanceId}`);
    expect(mid.body.status).toBe("waiting");
    expect(mid.body.currentElementId).toBe("Task_wait");
    expect(mid.body.variables.checkedAmount).toBe(42);

    const before = await get(`/instances/${instanceId}/history`);
    const jobsBefore = before.body.events.filter((e: any) => e.type === "serviceTaskJobCreated").length;
    expect(jobsBefore).toBe(1);

    // Redundant resume from the completed Service Task element (a duplicate wakeup).
    const inline = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
    await runInstance(env, instanceId, { runStep: inline, waitFor: null, startAt: "Task_check" });

    const after = await get(`/instances/${instanceId}`);
    expect(after.body.status).toBe("waiting"); // still at Receive — did not advance past it
    expect(after.body.variables.checkedAmount).toBe(42); // not duplicated/corrupted
    expect(after.body.variables.checkStatus).toBe("approved");

    const afterHist = await get(`/instances/${instanceId}/history`);
    const jobsAfter = afterHist.body.events.filter((e: any) => e.type === "serviceTaskJobCreated").length;
    expect(jobsAfter).toBe(1); // no second forward job created
    const correlated = afterHist.body.events.filter((e: any) => e.type === "messageCorrelated").length;
    expect(correlated).toBe(0); // no message yet
  });
});
