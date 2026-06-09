import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedPost, mintWorkerToken } from "../helpers";
import { backoffCapMs, RETRY_POLICY } from "../../src/runtime/retry-policy";

// TASK-23 (design §4.1): a retryable fail must PARK the job behind an exponential
// backoff (status='locked', lock_token=NULL, lock_expires_at=now+backoff) reusing
// the activate lease gate — NOT make it instantly re-leasable ('created'). The
// jitter is non-deterministic, so the gate is exercised by forcing lock_expires_at
// (the design's "advance time / set lock_expires_at" wrinkle), and the park bound
// is checked against backoffCapMs.

let n = 0;
const uid = (p: string) => `${p}_${Date.now()}_${n++}`;

async function seedInstance(workspaceId: string): Promise<string> {
  const instanceId = uid("pi");
  await env.DB.prepare(
    `INSERT INTO process_instances
       (instance_id, workspace_id, definition_version_id, workflow_instance_id, correlation_key, status, variables, started_at, updated_at)
     VALUES (?, ?, 'pdv_x', ?, 'c1', 'running', '{}', '2026-06-08T00:00:00Z', '2026-06-08T00:00:00Z')`,
  ).bind(instanceId, workspaceId, instanceId).run();
  return instanceId;
}

async function seedJob(opts: { instanceId: string; workspaceId: string; taskType: string; retryLimit?: number }): Promise<string> {
  const jobId = uid("job");
  await env.DB.prepare(
    `INSERT INTO service_task_jobs
       (job_id, instance_id, element_id, task_type, status, retry_limit, attempt_count, idempotency_key, input_variables, created_at, updated_at, workspace_id, is_compensation)
     VALUES (?, ?, 'reserveStock', ?, 'created', ?, 0, ?, '{}', '2026-06-08T00:00:00Z', '2026-06-08T00:00:00Z', ?, 0)`,
  ).bind(jobId, opts.instanceId, opts.taskType, opts.retryLimit ?? 3, `${opts.instanceId}:k`, opts.workspaceId).run();
  return jobId;
}

const jobRow = (jobId: string) => env.DB.prepare(`SELECT * FROM service_task_jobs WHERE job_id = ?`).bind(jobId).first<any>();
const setLockExpiry = (jobId: string, at: string) =>
  env.DB.prepare(`UPDATE service_task_jobs SET lock_expires_at = ? WHERE job_id = ?`).bind(at, jobId).run();

async function leaseOne(workspaceId: string, taskType: string, leaseMs?: number) {
  const inst = await seedInstance(workspaceId);
  const jobId = await seedJob({ instanceId: inst, workspaceId, taskType });
  const token = await mintWorkerToken(workspaceId);
  const r = await authedPost("/jobs/activate", token, { taskType, workerId: "w", leaseMs });
  return { inst, jobId, token, lockToken: r.body.jobs[0].lockToken as string };
}

describe("retry backoff (TASK-23 design §4.1)", () => {
  it("parks a retryable fail behind backoff (locked, no token, future expiry) — not instantly re-leasable", async () => {
    const { jobId, token, lockToken } = await leaseOne("ws-bo", "bo-task");
    const failAt = Date.now();
    const r = await authedPost(`/jobs/${jobId}/fail`, token, { lockToken, reason: "timeout", retryable: true });
    expect(r.status).toBe(200);

    const row = await jobRow(jobId);
    expect(row.status).toBe("locked"); // parked, NOT 'created'
    expect(row.lock_token).toBeNull();
    expect(row.lock_expires_at).not.toBeNull();
    // parked within [failAt, failAt + cap(attempt=1)] (+ slack) — bounded by the policy
    const parkUntil = new Date(row.lock_expires_at).getTime();
    expect(parkUntil).toBeGreaterThanOrEqual(failAt - 1000);
    expect(parkUntil).toBeLessThanOrEqual(failAt + backoffCapMs(1) + 1000);
  });

  it("does NOT re-lease during backoff but DOES after it elapses (attempt incremented)", async () => {
    const { jobId, token, lockToken } = await leaseOne("ws-bo2", "bo2-task");
    await authedPost(`/jobs/${jobId}/fail`, token, { lockToken, reason: "timeout", retryable: true });

    // Negative: backoff still in the future → not leasable.
    await setLockExpiry(jobId, "2999-01-01T00:00:00Z");
    const tooEarly = await authedPost("/jobs/activate", token, { taskType: "bo2-task", workerId: "w2" });
    expect(tooEarly.body.jobs).toHaveLength(0);

    // Positive: backoff elapsed → re-leasable, attempt incremented to 2.
    await setLockExpiry(jobId, "2000-01-01T00:00:00Z");
    const after = await authedPost("/jobs/activate", token, { taskType: "bo2-task", workerId: "w2" });
    expect(after.body.jobs).toHaveLength(1);
    expect(after.body.jobs[0].attempt).toBe(2);
  });

  it("backoff is independent of lease duration: an in-flight lease's expiry reflects leaseMs, not backoff", async () => {
    const leaseStart = Date.now();
    const { jobId } = await leaseOne("ws-bo3", "bo3-task", 60_000); // 60s lease > 30s max backoff
    const row = await jobRow(jobId);
    expect(row.status).toBe("locked");
    expect(row.lock_token).not.toBeNull(); // in-flight (held), not a backoff park
    const leaseExpiry = new Date(row.lock_expires_at).getTime() - leaseStart;
    // The in-flight lease expiry tracks leaseMs (~60s), well beyond any backoff cap.
    expect(leaseExpiry).toBeGreaterThan(RETRY_POLICY.maxBackoffMs);
  });

  it("parks a lease-expiry reclaim behind backoff too (design §4.1 reclaim leg), not instant re-lease", async () => {
    const { jobId, token } = await leaseOne("ws-bo5", "bo5-task"); // attempt 1, in-flight (lock_token held)
    // Simulate the worker crashing / the lease lapsing WITHOUT an explicit /jobs/fail.
    await env.DB.prepare(`UPDATE service_task_jobs SET lock_expires_at = '2000-01-01T00:00:00Z' WHERE job_id = ?`).bind(jobId).run();

    // The next activate must NOT instantly re-lease the lapsed in-flight lease;
    // it parks it behind backoff first (lock_token cleared, future expiry).
    const reclaim = await authedPost("/jobs/activate", token, { taskType: "bo5-task", workerId: "w2" });
    expect(reclaim.body.jobs).toHaveLength(0);
    const parked = await jobRow(jobId);
    expect(parked.status).toBe("locked");
    expect(parked.lock_token).toBeNull();
    expect(new Date(parked.lock_expires_at).getTime()).toBeGreaterThan(Date.now() - 1000);

    // After the backoff elapses it re-leases at the next attempt.
    await setLockExpiry(jobId, "2000-01-01T00:00:00Z");
    const after = await authedPost("/jobs/activate", token, { taskType: "bo5-task", workerId: "w3" });
    expect(after.body.jobs).toHaveLength(1);
    expect(after.body.jobs[0].attempt).toBe(2);
  });

  it("is idempotent: a duplicate retryable fail does not double-park nor double-count the attempt", async () => {
    const { jobId, token, lockToken } = await leaseOne("ws-bo4", "bo4-task");
    const r1 = await authedPost(`/jobs/${jobId}/fail`, token, { lockToken, reason: "t", retryable: true });
    const after1 = await jobRow(jobId);

    const r2 = await authedPost(`/jobs/${jobId}/fail`, token, { lockToken, reason: "t", retryable: true });
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body); // stable prior outcome
    const after2 = await jobRow(jobId);
    expect(after2.attempt_count).toBe(after1.attempt_count); // no double-count
    expect(after2.lock_expires_at).toBe(after1.lock_expires_at); // no re-park
  });
});
