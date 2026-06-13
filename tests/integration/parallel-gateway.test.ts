import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, get, mintWorkerToken, leaseOne, authedPost, PARALLEL_BPMN } from "../helpers";
import { listTokens } from "../../src/persistence/tokens";

const complete = (token: string, job: { jobId: string; lockToken: string }, outputVariables: Record<string, unknown> = {}) =>
  authedPost(`/jobs/${job.jobId}/complete`, token, { lockToken: job.lockToken, outputVariables });

describe("parallelGateway AND (M4-L3, direct mode)", () => {
  it("fans out both branches (both jobs leasable at once), join waits for both, completes on empty frontier", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_BPMN, { correlationKey: "p1", variables: {} });
    const id = instance.body.instanceId;

    // After fan-out, BOTH branch jobs are leasable concurrently (real parallelism is worker-side).
    const a = await authedPost("/jobs/activate", token, { taskType: "reserve-stock", workerId: "w" });
    const b = await authedPost("/jobs/activate", token, { taskType: "authorize-payment", workerId: "w" });
    expect(a.body.jobs).toHaveLength(1);
    expect(b.body.jobs).toHaveLength(1);

    // Complete B first — the join must wait for BOTH before producing a token.
    await complete(token, b.body.jobs[0], { paid: true });
    let inst = await get(`/instances/${id}`);
    expect(["running", "waiting"]).toContain(inst.body.status); // join not yet satisfied (A pending)
    // The post-join task must NOT be leasable yet (the join has not fired).
    const earlyConfirm = await authedPost("/jobs/activate", token, { taskType: "confirm-order", workerId: "w" });
    expect(earlyConfirm.body.jobs).toHaveLength(0);

    // Complete A — now the join fires and produces exactly one token.
    await complete(token, a.body.jobs[0], { reserved: true });

    // The post-join confirm task is now leasable; complete it to finish.
    const c = await leaseOne(token, "confirm-order");
    await complete(token, c, { confirmed: true });
    inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");

    const rows = await listTokens(env.DB, id);
    // Frontier empty: no token left in a live status.
    expect(rows.filter((r) => ["active", "waiting", "arrivedAtJoin"].includes(r.status))).toHaveLength(0);
    // Both branch tokens were materialised.
    expect(rows.some((r) => r.branch_flow_id === "f1")).toBe(true);
    expect(rows.some((r) => r.branch_flow_id === "f2")).toBe(true);
  });

  it("merges branch-local variables at the join in document order (later branch wins a conflict)", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_BPMN, { correlationKey: "p2", variables: { base: 1 } });
    const id = instance.body.instanceId;
    // reserve-stock (f1) writes shared='A'; authorize-payment (f2) writes shared='B'; f2 is later in doc order.
    const a = await leaseOne(token, "reserve-stock");
    await complete(token, a, { shared: "A", fromA: 1 });
    const b = await leaseOne(token, "authorize-payment");
    await complete(token, b, { shared: "B", fromB: 1 });
    const c = await leaseOne(token, "confirm-order");
    await complete(token, c, {});
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.variables).toMatchObject({ base: 1, fromA: 1, fromB: 1, shared: "B" });
  });

  it("never completes while any token is live (last-token-out, §5.6)", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_BPMN, { correlationKey: "p3", variables: {} });
    const id = instance.body.instanceId;
    // Complete ONLY branch f1; f2 + the join + the post-join confirm are all pending,
    // so a none-end on the produced token is unreachable and completion must NOT fire.
    const a = await leaseOne(token, "reserve-stock");
    await complete(token, a, {});
    const mid = await get(`/instances/${id}`);
    expect(mid.body.status).not.toBe("completed");
    // Drain the rest so this instance leaves no open jobs to pollute sibling tests.
    const b = await leaseOne(token, "authorize-payment");
    await complete(token, b, {});
    const c = await leaseOne(token, "confirm-order");
    await complete(token, c, {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  it("does not leak a sibling branch's write into the other branch before the join", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_BPMN, { correlationKey: "p4", variables: { base: 1 } });
    const id = instance.body.instanceId;
    // Complete f1 with a write, then lease f2 — f2's job input must NOT see f1's write.
    const a = await leaseOne(token, "reserve-stock");
    await complete(token, a, { fromA: 99 });
    const b = await leaseOne(token, "authorize-payment");
    expect(b.variables).toMatchObject({ base: 1 });
    expect(b.variables.fromA).toBeUndefined();
  });
});
