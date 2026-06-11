import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  authedPost,
  DEMO_BPMN,
  drainSampleWorkers,
  get,
  leaseOne,
  mintWorkerToken,
  publishAndStart,
  rewindBackoff,
  SAGA_BPMN,
} from "../helpers";

// TASK-40 (M3-L1): the Jobs API now HONORS the `/jobs/{id}/fail` `retryable` field
// (`false` ⇒ immediate exhaustion, skip remaining technical retries) and ENFORCES
// reclaim exhaustion (a job exhausted purely through lease-expiry reclaim no longer
// retries forever — it terminates via the same exhaustion path as an explicit fail).
// Omitting/`true` keeps the current backoff-retry behavior (regression).

const jobRow = (instanceId: string, isCompensation = 0) =>
  env.DB.prepare(
    `SELECT * FROM service_task_jobs WHERE instance_id = ? AND is_compensation = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(instanceId, isCompensation)
    .first<any>();

/** Simulate a worker crashing mid-lease: lapse the in-flight lock (token still held). */
const lapseLease = (instanceId: string, taskType: string) =>
  env.DB
    .prepare(
      `UPDATE service_task_jobs SET lock_expires_at = '2000-01-01T00:00:00Z'
         WHERE instance_id = ? AND task_type = ?`,
    )
    .bind(instanceId, taskType)
    .run();

describe("AC#1 — fail(retryable=false) ⇒ immediate exhaustion (inside a transaction)", () => {
  it("short-circuits remaining technical retries → serviceTaskFailure Hazard, no further lease", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "rt-false-1",
      variables: { qty: 2, amount: 100 },
    });
    const instanceId = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting"); // parked at reserveStock inside Tx

    const token = await mintWorkerToken();
    const job = await leaseOne(token, "reserve-stock"); // attempt 0 → 1, retry_limit=3
    expect(job.attempt).toBe(1);

    // Technical failure (no errorCode) but retryable=false: attempts REMAIN (1 < 3),
    // yet the worker declares the failure permanent ⇒ immediate exhaustion.
    const failed = await authedPost(`/jobs/${job.jobId}/fail`, token, {
      lockToken: job.lockToken,
      reason: "card network permanently down",
      retryable: false,
    });
    expect(failed.status).toBe(200);

    // Technical exhaustion inside a transaction is a Hazard (serviceTaskFailure),
    // NOT auto-compensation.
    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("serviceTaskFailure");
    expect(inst.body.incident.elementId).toBe("reserveStock");

    // The job is terminal and NOT re-leasable: a subsequent activate hands out nothing.
    expect((await jobRow(instanceId)).status).toBe("failed");
    const reactivate = await authedPost("/jobs/activate", token, { taskType: "reserve-stock", workerId: "w2" });
    expect(reactivate.body.jobs).toHaveLength(0);

    // Audit truth: the jobFailed history row records retryable=false (not a hardcoded true).
    const history = await get(`/instances/${instanceId}/history`);
    const jf = history.body.events.find((e: any) => e.type === "jobFailed");
    expect(jf.diagnostics.retryable).toBe(false);
  });
});

describe("AC#2 — fail with retryable omitted/true keeps backoff-retry (regression)", () => {
  it("retryable OMITTED with attempts remaining ⇒ backoff park, re-leasable after delay", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "rt-omit-1",
      variables: { amount: 1 },
    });
    const instanceId = instance.body.instanceId;
    const token = await mintWorkerToken();
    const job = await leaseOne(token, "external-check"); // attempt → 1, retry_limit=3

    const failed = await authedPost(`/jobs/${job.jobId}/fail`, token, {
      lockToken: job.lockToken,
      reason: "transient timeout",
      // retryable omitted ⇒ treated as retryable
    });
    expect(failed.status).toBe(200);

    // Parked behind backoff (NOT exhausted, NOT an incident).
    const parked = await jobRow(instanceId);
    expect(parked.status).toBe("locked");
    expect(parked.lock_token).toBeNull();
    expect((await get(`/instances/${instanceId}`)).body.status).toBe("waiting");

    // Re-leasable once the backoff elapses, at the next attempt.
    await rewindBackoff(instanceId, "external-check");
    const again = await authedPost("/jobs/activate", token, { taskType: "external-check", workerId: "w2" });
    expect(again.body.jobs).toHaveLength(1);
    expect(again.body.jobs[0].attempt).toBe(2);
  });

  it("retryable=true with attempts remaining ⇒ backoff park (unchanged)", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "rt-true-1",
      variables: { amount: 1 },
    });
    const instanceId = instance.body.instanceId;
    const token = await mintWorkerToken();
    const job = await leaseOne(token, "external-check");

    await authedPost(`/jobs/${job.jobId}/fail`, token, {
      lockToken: job.lockToken,
      reason: "transient",
      retryable: true,
    });

    const parked = await jobRow(instanceId);
    expect(parked.status).toBe("locked");
    expect(parked.lock_token).toBeNull();
    expect((await get(`/instances/${instanceId}`)).body.status).toBe("waiting");
  });
});

describe("AC#3 — reclaim exhaustion: lease-expiry alone terminates via the exhaustion path", () => {
  it("a job driven purely through repeated lease expiry incidents instead of re-leasing forever", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "reclaim-exhaust-1",
      variables: { amount: 1 },
    });
    const instanceId = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting");
    const token = await mintWorkerToken();

    // Drive the job through lease → lapse → reclaim cycles. retry_limit=3, so after
    // attempt_count reaches 3 the next reclaim pre-pass must EXHAUST (not park again).
    // Bounded loop: if reclaim never exhausted, the job would re-lease forever and
    // the instance would never reach 'incident' — the loop would run out the bound.
    let reachedIncident = false;
    for (let i = 0; i < 20; i++) {
      await authedPost("/jobs/activate", token, { taskType: "external-check", workerId: "w" });
      if ((await get(`/instances/${instanceId}`)).body.status === "incident") {
        reachedIncident = true;
        break;
      }
      // Lapse any in-flight lease AND rewind any backoff park so the next activate's
      // reclaim pre-pass re-handles the job (the test stand-in for elapsed wall-clock).
      await lapseLease(instanceId, "external-check");
    }

    expect(reachedIncident).toBe(true);
    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("serviceTaskFailure");
    expect(inst.body.incident.elementId).toBe("Task_check");
    expect((await jobRow(instanceId)).status).toBe("failed");

    // Regression-lock the audit convention (TASK-40 review): the reclaim route now
    // flows through the SAME deliverJobFailed tail as /jobs/fail exhaustion, and a
    // lease-expiry exhaustion is a TECHNICAL-class failure whose budget is merely
    // spent (no worker declared it non-retryable) → diagnostics.retryable === true.
    // A FORWARD job → diagnostics.isCompensation === false. (AC#1 still locks the
    // explicit `retryable:false` /jobs/fail route to retryable === false.)
    const history = await get(`/instances/${instanceId}/history`);
    const jf = history.body.events.find((e: any) => e.type === "jobFailed");
    expect(jf.diagnostics.retryable).toBe(true);
    expect(jf.diagnostics.isCompensation).toBe(false);

    // The exhaustion is terminal: no further lease is handed out.
    const reactivate = await authedPost("/jobs/activate", token, { taskType: "external-check", workerId: "w3" });
    expect(reactivate.body.jobs).toHaveLength(0);
  });
});

describe("compensation-job reclaim exhaustion routes to compensationFailure (not the forward Hazard)", () => {
  it("a compensation job exhausted purely through lease expiry settles to compensationFailed", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "comp-reclaim-1",
      variables: { qty: 1, amount: 50, shippingFails: true },
    });
    const instanceId = instance.body.instanceId;

    // Drive ONLY the forward steps: confirmShipping business-fails → cancel →
    // compensation begins and creates the refund-card comp job (compensator for
    // chargeCard), which we deliberately do NOT drain so it can be exhausted via
    // lease expiry rather than completed.
    await drainSampleWorkers({ taskTypes: ["reserve-stock", "charge-card", "confirm-shipping"] });
    expect((await get(`/instances/${instanceId}`)).body.status).toBe("compensating");

    const token = await mintWorkerToken();
    const comp = await leaseOne(token, "refund-card");
    expect(comp.isCompensation).toBe(true);

    // Force the exhausted-in-flight-expired shape a comp job reaches after repeated
    // reclaim re-leases (attempt_count at the budget, lock lapsed but token held).
    const row = await jobRow(instanceId, 1);
    await env.DB
      .prepare(`UPDATE service_task_jobs SET attempt_count = retry_limit, lock_expires_at = '2000-01-01T00:00:00Z' WHERE job_id = ?`)
      .bind(row.job_id)
      .run();

    // The reclaim pre-pass must EXHAUST and route to the COMPENSATION-failure path.
    await authedPost("/jobs/activate", token, { taskType: "refund-card", workerId: "w" });

    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("compensationFailed");
    expect(inst.body.incident.kind).toBe("compensationFailure");
    expect((await jobRow(instanceId, 1)).status).toBe("failed");
  });
});
