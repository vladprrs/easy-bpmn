import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedPost, mintWorkerToken } from "../helpers";

// Pull data plane (TASK-13/14/15): lease + workspace isolation + reclaim +
// compensation enrichment + lock_token-conditional complete/fail idempotency.
// Jobs are seeded directly (the engine flip that CREATES leasable jobs is a
// separate M1 task; these tests exercise the data-plane mechanics in isolation).

let n = 0;
const uid = (p: string) => `${p}_${Date.now()}_${n++}`;

async function seedInstance(workspaceId: string, status = "running"): Promise<string> {
  const instanceId = uid("pi");
  await env.DB.prepare(
    `INSERT INTO process_instances
       (instance_id, workspace_id, definition_version_id, workflow_instance_id, correlation_key, status, variables, started_at, updated_at)
     VALUES (?, ?, 'pdv_x', ?, 'c1', ?, '{}', '2026-06-08T00:00:00Z', '2026-06-08T00:00:00Z')`,
  )
    .bind(instanceId, workspaceId, instanceId, status)
    .run();
  return instanceId;
}

async function seedJob(opts: {
  instanceId: string;
  workspaceId: string;
  elementId: string;
  taskType: string;
  status?: string;
  isCompensation?: number;
  compensatesElementId?: string | null;
  lockToken?: string | null;
  lockExpiresAt?: string | null;
  attempt?: number;
  retryLimit?: number;
  input?: Record<string, unknown>;
}): Promise<string> {
  const jobId = uid("job");
  await env.DB.prepare(
    `INSERT INTO service_task_jobs
       (job_id, instance_id, element_id, task_type, status, retry_limit, attempt_count, idempotency_key, input_variables, created_at, updated_at,
        workspace_id, is_compensation, compensates_element_id, lock_token, lock_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-06-08T00:00:00Z', '2026-06-08T00:00:00Z', ?, ?, ?, ?, ?)`,
  )
    .bind(
      jobId,
      opts.instanceId,
      opts.elementId,
      opts.taskType,
      opts.status ?? "created",
      opts.retryLimit ?? 3,
      opts.attempt ?? 0,
      `${opts.instanceId}:${opts.elementId}:${opts.isCompensation ?? 0}`,
      JSON.stringify(opts.input ?? { qty: 1 }),
      opts.workspaceId,
      opts.isCompensation ?? 0,
      opts.compensatesElementId ?? null,
      opts.lockToken ?? null,
      opts.lockExpiresAt ?? null,
    )
    .run();
  return jobId;
}

async function seedSagaStep(instanceId: string, elementId: string, input: object, output: object) {
  await env.DB.prepare(
    `INSERT INTO saga_steps
       (step_id, instance_id, scope_id, seq, element_id, forward_job_id, captured_input, captured_output,
        compensation_element_id, compensation_task_type, compensation_job_id, compensation_status, trace_id, created_at, updated_at)
     VALUES (?, ?, 'Tx', 1, ?, 'job_fwd', ?, ?, 'releaseStock', 'release-stock', NULL, 'pending', NULL, '2026-06-08T00:00:00Z', '2026-06-08T00:00:00Z')`,
  )
    .bind(uid("step"), instanceId, elementId, JSON.stringify(input), JSON.stringify(output))
    .run();
}

async function jobRow(jobId: string) {
  return env.DB.prepare(`SELECT * FROM service_task_jobs WHERE job_id = ?`).bind(jobId).first<any>();
}

describe("pull data plane: lease + isolation + reclaim", () => {
  it("leases a created job exactly once (status→locked, attempt incremented)", async () => {
    const inst = await seedInstance("ws-lease");
    const jobId = await seedJob({ instanceId: inst, workspaceId: "ws-lease", elementId: "reserveStock", taskType: "reserve-stock" });
    const token = await mintWorkerToken("ws-lease");

    const r1 = await authedPost("/jobs/activate", token, { taskType: "reserve-stock", workerId: "w1" });
    expect(r1.status).toBe(200);
    expect(r1.body.jobs).toHaveLength(1);
    expect(r1.body.jobs[0].jobId).toBe(jobId);
    expect(r1.body.jobs[0].attempt).toBe(1);
    expect(r1.body.jobs[0].lockToken).toMatch(/^lock_/);
    expect(r1.body.jobs[0].isCompensation).toBe(false);
    expect(r1.body.jobs[0].traceId).toBe(`trace_${inst}`);

    const row = await jobRow(jobId);
    expect(row.status).toBe("locked");

    const r2 = await authedPost("/jobs/activate", token, { taskType: "reserve-stock", workerId: "w2" });
    expect(r2.body.jobs).toHaveLength(0);
  });

  it("scopes the lease to the credential's workspace (cross-tenant gets nothing)", async () => {
    const inst = await seedInstance("ws-A");
    await seedJob({ instanceId: inst, workspaceId: "ws-A", elementId: "reserveStock", taskType: "iso-task" });
    const tokenB = await mintWorkerToken("ws-B");
    const r = await authedPost("/jobs/activate", tokenB, { taskType: "iso-task", workerId: "wB" });
    expect(r.body.jobs).toHaveLength(0);
  });

  it("parks an expired in-flight lease behind backoff, then reclaims it (attempt incremented)", async () => {
    const inst = await seedInstance("ws-reclaim");
    const jobId = await seedJob({
      instanceId: inst,
      workspaceId: "ws-reclaim",
      elementId: "reserveStock",
      taskType: "reclaim-task",
      status: "locked",
      lockToken: "lock_old", // a HELD in-flight lease that lapsed (crashed worker)
      lockExpiresAt: "2000-01-01T00:00:00Z",
      attempt: 1,
    });
    const token = await mintWorkerToken("ws-reclaim");
    // TASK-23 §4.1 reclaim leg: the lapsed in-flight lease is parked behind backoff
    // first (not instantly re-handed).
    const parkPass = await authedPost("/jobs/activate", token, { taskType: "reclaim-task", workerId: "w-new" });
    expect(parkPass.body.jobs).toHaveLength(0);
    const parked = await jobRow(jobId);
    expect(parked.status).toBe("locked");
    expect(parked.lock_token).toBeNull(); // cleared → now a backoff park

    // Elapse the backoff → the next activate reclaims it at attempt 2.
    await env.DB.prepare(`UPDATE service_task_jobs SET lock_expires_at = '2000-01-01T00:00:00Z' WHERE job_id = ?`).bind(jobId).run();
    const r = await authedPost("/jobs/activate", token, { taskType: "reclaim-task", workerId: "w-new" });
    expect(r.body.jobs).toHaveLength(1);
    expect(r.body.jobs[0].jobId).toBe(jobId);
    expect(r.body.jobs[0].attempt).toBe(2);
  });

  it("hands one job to exactly one of two concurrent activates", async () => {
    const inst = await seedInstance("ws-race");
    await seedJob({ instanceId: inst, workspaceId: "ws-race", elementId: "reserveStock", taskType: "race-task" });
    const token = await mintWorkerToken("ws-race");
    const [a, b] = await Promise.all([
      authedPost("/jobs/activate", token, { taskType: "race-task", workerId: "wa" }),
      authedPost("/jobs/activate", token, { taskType: "race-task", workerId: "wb" }),
    ]);
    expect(a.body.jobs.length + b.body.jobs.length).toBe(1);
  });

  it("enriches a compensation job with originalInput + capturedOutput from the ledger", async () => {
    const inst = await seedInstance("ws-comp");
    await seedSagaStep(inst, "reserveStock", { qty: 5 }, { reservationId: "r-9" });
    await seedJob({
      instanceId: inst,
      workspaceId: "ws-comp",
      elementId: "reserveStock",
      taskType: "release-stock",
      isCompensation: 1,
      compensatesElementId: "reserveStock",
    });
    const token = await mintWorkerToken("ws-comp");
    const r = await authedPost("/jobs/activate", token, { taskType: "release-stock", workerId: "wc" });
    expect(r.body.jobs).toHaveLength(1);
    expect(r.body.jobs[0].isCompensation).toBe(true);
    expect(r.body.jobs[0].originalInput).toEqual({ qty: 5 });
    expect(r.body.jobs[0].capturedOutput).toEqual({ reservationId: "r-9" });
  });

  it("returns empty {jobs:[]} after a bounded wait when nothing is leasable", async () => {
    const token = await mintWorkerToken("ws-poll");
    const r = await authedPost("/jobs/activate", token, { taskType: "no-such-task", workerId: "wp", waitMs: 300 });
    expect(r.status).toBe(200);
    expect(r.body.jobs).toEqual([]);
  });
});

describe("pull data plane: complete / fail callbacks", () => {
  async function leaseOne(workspaceId: string, taskType: string) {
    const inst = await seedInstance(workspaceId);
    const jobId = await seedJob({ instanceId: inst, workspaceId, elementId: "reserveStock", taskType });
    const token = await mintWorkerToken(workspaceId);
    const r = await authedPost("/jobs/activate", token, { taskType, workerId: "w" });
    return { inst, jobId, token, lockToken: r.body.jobs[0].lockToken as string };
  }

  it("completes a leased job and is idempotent on a duplicate complete", async () => {
    const { jobId, token, lockToken } = await leaseOne("ws-complete", "c-task");
    const r1 = await authedPost(`/jobs/${jobId}/complete`, token, { lockToken, outputVariables: { ok: true } });
    expect(r1.status).toBe(200);
    expect(r1.body.disposition).toBe("applied");
    expect((await jobRow(jobId)).status).toBe("completed");

    const r2 = await authedPost(`/jobs/${jobId}/complete`, token, { lockToken, outputVariables: { ok: true } });
    expect(r2.status).toBe(200);
    expect(r2.body.outcome).toBe("completed"); // stable prior outcome — advanced at most once
  });

  it("rejects a complete bearing a stale lock token (409)", async () => {
    const { jobId, token } = await leaseOne("ws-stale", "s-task");
    const r = await authedPost(`/jobs/${jobId}/complete`, token, { lockToken: "lock_wrong", outputVariables: {} });
    expect(r.status).toBe(409);
  });

  it("rejects an oversized completion output (400) before any delivery", async () => {
    const { jobId, token, lockToken } = await leaseOne("ws-big", "b-task");
    const big = { blob: "x".repeat(1_100_000) };
    const r = await authedPost(`/jobs/${jobId}/complete`, token, { lockToken, outputVariables: big });
    expect(r.status).toBe(400);
    expect((await jobRow(jobId)).status).toBe("locked"); // unchanged
  });

  it("acks (200 no-op) a callback to a job on a terminal instance", async () => {
    const inst = await seedInstance("ws-term", "completed");
    const jobId = await seedJob({ instanceId: inst, workspaceId: "ws-term", elementId: "reserveStock", taskType: "t-task", status: "locked", lockToken: "lock_z" });
    const token = await mintWorkerToken("ws-term");
    const r = await authedPost(`/jobs/${jobId}/complete`, token, { lockToken: "lock_z", outputVariables: {} });
    expect(r.status).toBe(200);
    expect(r.body.disposition).toBe("ignored");
  });

  it("fails a job with a business errorCode (terminal-for-step) and is idempotent", async () => {
    const { jobId, token, lockToken } = await leaseOne("ws-bizfail", "bf-task");
    const r1 = await authedPost(`/jobs/${jobId}/fail`, token, { lockToken, reason: "rejected", errorCode: "SHIPPING_REJECTED" });
    expect(r1.status).toBe(200);
    expect(r1.body.disposition).toBe("applied");
    const row = await jobRow(jobId);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("SHIPPING_REJECTED");

    const r2 = await authedPost(`/jobs/${jobId}/fail`, token, { lockToken, reason: "rejected", errorCode: "SHIPPING_REJECTED" });
    expect(r2.status).toBe(200); // idempotent
  });

  it("makes a technical failure re-leasable after backoff (retry via re-lease)", async () => {
    const { jobId, token, lockToken } = await leaseOne("ws-techfail", "tf-task");
    const r = await authedPost(`/jobs/${jobId}/fail`, token, { lockToken, reason: "timeout", retryable: true });
    expect(r.status).toBe(200);
    // TASK-23 §4.1: parked behind backoff (locked, no token, future expiry) —
    // NOT instantly re-leasable.
    const parked = await jobRow(jobId);
    expect(parked.status).toBe("locked");
    expect(parked.lock_token).toBeNull();
    expect(parked.lock_expires_at).not.toBeNull();

    // Elapse the backoff (set lock_expires_at into the past), then it re-leases.
    await env.DB.prepare(`UPDATE service_task_jobs SET lock_expires_at = '2000-01-01T00:00:00Z' WHERE job_id = ?`).bind(jobId).run();
    const again = await authedPost("/jobs/activate", token, { taskType: "tf-task", workerId: "w2" });
    expect(again.body.jobs).toHaveLength(1);
    expect(again.body.jobs[0].attempt).toBe(2); // re-lease bumped the attempt
  });
});
