// M4-L5: compensation of parallel branches (straggler-catching). A transaction
// with an AND fork/join where one branch errors → cancel end must reverse-
// compensate the completed steps across ALL branches, hold the terminal until the
// ledger drains AND every cohort token is terminal, and never strand/leak a branch
// that completes after cancellation began. Direct-mode (EXECUTION_MODE=direct).

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, drainSampleWorkers, get, post, authedPost, leaseOne, mintWorkerToken, PARALLEL_SAGA_BPMN } from "../helpers";
import { listTokens } from "../../src/persistence/tokens";
import { getSagaStepsForInstance } from "../../src/persistence/saga";

const liveTokens = async (instanceId: string) =>
  (await listTokens(env.DB, instanceId)).filter((r) => ["active", "waiting", "arrivedAtJoin"].includes(r.status));

describe("parallel-branch compensation (M4-L5)", () => {
  it("a business error after the join → reverse-compensates completed steps across all branches; quiescence holds until terminal", async () => {
    const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, { correlationKey: "pc1", variables: { failSettle: true } });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;
    // Both branches complete (each ledgered with its branch token id); the post-join
    // `settle` raises a business error → Tx_cancel → reverse-compensate the cohort.
    await drainSampleWorkers({ taskTypes: ["branch-a", "branch-b", "branch-settle", "comp-a", "comp-b"] });

    const inst = await get(`/instances/${id}`);
    expect(["compensated", "compensationFailed"]).toContain(inst.body.status);

    const steps = await getSagaStepsForInstance(env.DB, id);
    // BOTH branch steps must have been compensated (not stranded) — across branches.
    expect(steps.some((s) => s.elementId === "branchA" && s.compensationStatus === "compensated")).toBe(true);
    expect(steps.some((s) => s.elementId === "branchB" && s.compensationStatus === "compensated")).toBe(true);

    // The live-token frontier is empty at the terminal (the produced root token at
    // `settle` was discarded by the straggler scan; the branch tokens are merged).
    expect(await liveTokens(id)).toHaveLength(0);
  });

  it("operator /cancel of a parallel region does NOT leak a late-completing branch", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, { correlationKey: "pc2", variables: {} });
    const id = instance.body.instanceId;
    // Lease branch A (status 'locked') but DON'T complete it, then cancel the instance.
    const a = await leaseOne(token, "branch-a");
    const cancelled = await post(`/instances/${id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    // A late complete arrives AFTER cancel — because the region path leaves the cohort
    // job in place (no eager abandon), it must land as a straggler (ledger row written,
    // then compensated), never a 0-row no-op that leaks the executed side-effect.
    const ack = await authedPost(`/jobs/${a.jobId}/complete`, token, { lockToken: a.lockToken, outputVariables: { didWork: true } });
    expect(ack.status).toBe(200);
    await drainSampleWorkers({ taskTypes: ["comp-a", "comp-b"] });

    const steps = await getSagaStepsForInstance(env.DB, id);
    const branchAStep = steps.find((s) => s.elementId === "branchA");
    expect(branchAStep).toBeDefined(); // ledgered, not leaked
    expect(branchAStep!.compensationStatus).toBe("compensated"); // and reverse-compensated
  });
});
