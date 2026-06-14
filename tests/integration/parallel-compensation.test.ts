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

const compJobCount = async (instanceId: string): Promise<number> =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 1`).bind(instanceId).first<{ n: number }>())?.n ?? 0;

const compStartedCount = async (instanceId: string): Promise<number> =>
  ((await get(`/instances/${instanceId}/history`)).body.events as Array<{ type: string }>).filter((e) => e.type === "compensationStarted").length;

describe("parallel-branch compensation (M4-L5)", () => {
  it("[C-COMP-QUIESCE-01] a business error after the join → reverse-compensates completed steps across all branches; quiescence holds until terminal", async () => {
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

  it("[C-COMP-STRAGGLER-01] operator /cancel of a parallel region does NOT leak a late-completing branch", async () => {
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

  it("[C-ERR-HAZARD-01] a technical incident on one branch leaves the instance 'incident' with the sibling frozen (not wedged), then /cancel runs the reverse pass", async () => {
    const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, { correlationKey: "pc3", variables: { hazardBranchB: true } });
    const id = instance.body.instanceId;
    // Branch A completes (→ arrivedAtJoin); branch B exhausts its retries → a technical
    // Hazard transitions the WHOLE instance to 'incident' with branch A frozen (no wedge).
    await drainSampleWorkers({ taskTypes: ["branch-a", "branch-b"] });
    expect((await get(`/instances/${id}`)).body.status).toBe("incident");

    // Operator /cancel from 'incident' runs the same straggler-catching reverse pass over
    // the cohort (no new code beyond L5.1–L5.4): A compensates, B (failed forward) discards.
    const cancelled = await post(`/instances/${id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    await drainSampleWorkers({ taskTypes: ["comp-a", "comp-b"] });
    expect(["compensated", "compensationFailed", "cancelled"]).toContain((await get(`/instances/${id}`)).body.status);
    expect(await liveTokens(id)).toHaveLength(0);
  });

  // [C-AND-INTX-01] The forward COMMIT path of an AND fork/join wholly inside a
  // transaction — the mirror of the failure tests above. Drive the SAME
  // PARALLEL_SAGA_BPMN with the settle steer OFF (no `failSettle`): both branches
  // succeed, the post-join `settle` succeeds, and the none-end (`Tx_ok`) COMMITS the
  // transaction. Both branch steps are ledgered with their OWN branch token id, the
  // commit marks them `committed` (never compensated), and NO compensation runs.
  it("[C-AND-INTX-01] AND fork/join inside a transaction commits with both branch outputs, no compensation", async () => {
    const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, { correlationKey: "pc-intx", variables: {} });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;
    // No `failSettle` ⇒ branch-settle succeeds ⇒ Tx_ok (none end) ⇒ the transaction commits.
    await drainSampleWorkers({ taskTypes: ["branch-a", "branch-b", "branch-settle"] });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");

    // Both branch steps are ledgered, each tagged with its OWN branch token id…
    const steps = await getSagaStepsForInstance(env.DB, id);
    const a = steps.find((s) => s.elementId === "branchA");
    const b = steps.find((s) => s.elementId === "branchB");
    expect(a?.tokenId).toContain("fork#0:f_a");
    expect(b?.tokenId).toContain("fork#0:f_b");
    // …and the none-end commit marked them `committed`, NOT compensated.
    expect(a?.compensationStatus).toBe("committed");
    expect(b?.compensationStatus).toBe("committed");

    // NO compensation occurred: no reverse-pass history, no compensation job.
    expect(await compStartedCount(id)).toBe(0);
    expect(await compJobCount(id)).toBe(0);

    // Frontier drained at the commit.
    expect(await liveTokens(id)).toHaveLength(0);
  });

  // [C-OP-CANCEL-MIDFAN-01] Operator /cancel issued mid-fan-out, BEFORE either branch
  // job completes, so the saga ledger is EMPTY. The distinctive behavior vs the
  // straggler case above is "no reverse pass over nothing": the cancel performs NO
  // compensation work (no compensation job, no compensationStarted) — there is nothing
  // ledgered to reverse. (PARALLEL_SAGA_BPMN has no armed timers / open incidents, so
  // the cancel sweep's timer-settle and operatorResolved-incident-close arms are not
  // exercised here; and because a region with a LIVE cohort never takes the empty-ledger
  // terminal-`cancelled` shortcut, the instance enters `compensating` and the quiescence
  // barrier holds — yet still no reverse pass runs.)
  it("[C-OP-CANCEL-MIDFAN-01] operator /cancel mid-fan-out over an empty ledger runs no reverse pass", async () => {
    const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, { correlationKey: "pc-midfan", variables: {} });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;
    // Genuinely mid-fan-out: the cohort is live (both branch tokens) and NOTHING has
    // completed, so the ledger is empty.
    expect((await liveTokens(id)).length).toBe(2);
    expect(await getSagaStepsForInstance(env.DB, id)).toHaveLength(0);

    const cancelled = await post(`/instances/${id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    // Region + live cohort ⇒ the compensating lifecycle (not the empty-ledger terminal
    // shortcut), but the empty ledger means the reverse pass has nothing to do.
    expect(cancelled.body.status).toBe("compensating");

    // No reverse pass over nothing: the synchronous cancel drive created NO compensation
    // job and emitted NO compensationStarted — there was nothing ledgered to reverse.
    expect(await compStartedCount(id)).toBe(0);
    expect(await compJobCount(id)).toBe(0);
  });
});
