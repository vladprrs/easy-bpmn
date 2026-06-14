import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_BPMN, drainSampleWorkers, get, publishAndStart } from "../helpers";
import { runInstance } from "../../src/runtime/engine";
import type { RunStep } from "../../src/runtime/engine";

// M4 single-wake (TASK-54) — standard-BPMN un-guarded-wait policy (Option B).
//
// TASK-54 replaced the per-leaf `step.waitForEvent` multi-wait with a single
// `bpmn_wake`, and in doing so deleted the M3 leaf-level wait CAPS. The adopted
// policy is now standard BPMN:
//
//   - An UN-GUARDED receive task / message intermediate catch (no boundary timer,
//     no modeled deadline) waits INDEFINITELY — no deadline ⇒ no timeout. The M3
//     leaf `waitTimeout` durable-wait cap is RETIRED; the `waitTimeout` incident
//     kind is now unproduced (its only engine producer is dead code, removed in
//     Task 9; the kind stays a documented-but-vestigial enum value until then).
//   - An UN-GUARDED service task keeps operational liveness via the DLQ
//     `jobActivationTimeout` (the per-job `JobScheduler` DO alarm at
//     `activation_expires_at`) — NOT an engine-level wait cap. Covered by
//     `tests/integration/saga-dlq-timeout.test.ts`; not duplicated here.
//   - `compensationFailure` still settles on compensation-job RETRY-EXHAUSTION
//     (`comp.status==='failed'`), unchanged — covered by `loop-compensation`,
//     `parallel-compensation`, `saga-operator`, and `saga-orchestration`. The
//     deleted leaf comp-*wait* cap was a separate net and is also retired.
//
// These tests assert the indefinite-wait semantics WITHOUT hanging by driving in
// DIRECT mode (`waitFor: null`): an un-guarded leaf parks and the drive returns
// `waiting` immediately (issueWake returns false when there is no waitFor), with
// no incident. (A returning timeout `waitFor` would re-walk → re-park → re-wake
// forever under single-wake — precisely the M3 cap behaviour this policy removes.)

const inline: RunStep = (_name, fn) => fn();

describe("un-guarded waits are indefinite (M4 single-wake, standard BPMN — TASK-54)", () => {
  it("an un-guarded receive task / message catch waits indefinitely (no waitTimeout)", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: `wt-recv-${crypto.randomUUID()}`, variables: { amount: 1 } });
    const id = instance.body.instanceId;

    // Advance past the Service Task so the instance parks at the Receive Task
    // with an active subscription (no message ever arrives).
    await drainSampleWorkers({ taskTypes: ["external-check"] });
    const waiting = await get(`/instances/${id}`);
    expect(waiting.body.status).toBe("waiting");
    expect(waiting.body.currentElementId).toBe("Task_wait");

    // The wait state is durable: an ACTIVE subscription is registered (constitution IV).
    const sub = await env.DB.prepare(`SELECT status FROM message_subscriptions WHERE instance_id = ?`).bind(id).first<any>();
    expect(sub?.status).toBe("active");

    // The indefinite-wait guard: re-driving the parked instance (direct mode)
    // keeps it `waiting` — it does NOT cap to a `waitTimeout` incident. This is
    // the standard-BPMN semantics that replaced the M3 leaf wait cap.
    const result = await runInstance(env, id, { runStep: inline, waitFor: null });
    expect(result.status).toBe("waiting");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("waiting");
    expect(inst.body.currentElementId).toBe("Task_wait");
    expect(inst.body.incident).toBeNull();
    expect(inst.body.openIncidents).toHaveLength(0);
    expect(inst.body.openIncidents.some((i: any) => i.kind === "waitTimeout")).toBe(false);
  });

  it("an un-guarded service task parks at the engine — liveness is the DLQ, not a wait cap", async () => {
    // publishAndStart parks at the pull Service Task: the job is created but never
    // leased. Operational liveness for an un-leased job is the DLQ
    // `jobActivationTimeout` (JobScheduler DO alarm at activation_expires_at),
    // exercised by tests/integration/saga-dlq-timeout.test.ts — NOT an engine
    // wait cap, which is why the engine itself raises NO incident here.
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: `wt-svc-${crypto.randomUUID()}`, variables: { amount: 1 } });
    const id = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting");
    expect(instance.body.currentElementId).toBe("Task_check");

    const result = await runInstance(env, id, { runStep: inline, waitFor: null });
    expect(result.status).toBe("waiting");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("waiting");
    expect(inst.body.currentElementId).toBe("Task_check");
    expect(inst.body.incident).toBeNull();
    expect(inst.body.openIncidents).toHaveLength(0);
  });
});
