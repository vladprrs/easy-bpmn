import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Persistence gate for migration 0002_saga.sql (applied by tests/apply-migrations.ts).
// Asserts the new schema is present and that the relaxed job-uniqueness + saga_steps
// INSERT OR IGNORE idempotency behave as the compensation pass relies on.

async function columns(table: string): Promise<string[]> {
  const res = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return (res.results ?? []).map((r) => r.name);
}

async function indexNames(table: string): Promise<string[]> {
  const res = await env.DB.prepare(`PRAGMA index_list(${table})`).all<{ name: string }>();
  return (res.results ?? []).map((r) => r.name);
}

async function insertForwardJob(jobId: string, instanceId: string, elementId: string, isComp = 0) {
  await env.DB.prepare(
    `INSERT INTO service_task_jobs
       (job_id, instance_id, element_id, task_type, status, retry_limit, attempt_count, idempotency_key, input_variables, created_at, updated_at, is_compensation)
     VALUES (?, ?, ?, 'reserve-stock', 'created', 3, 0, ?, '{}', '2026-06-08T00:00:00Z', '2026-06-08T00:00:00Z', ?)`,
  )
    .bind(jobId, instanceId, elementId, `${instanceId}:${elementId}:${isComp}`, isComp)
    .run();
}

async function insertSagaStep(stepId: string, instanceId: string, elementId: string) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO saga_steps
       (step_id, instance_id, scope_id, seq, element_id, forward_job_id, captured_input, captured_output,
        compensation_element_id, compensation_task_type, compensation_job_id, compensation_status, trace_id, created_at, updated_at)
     SELECT ?, ?, 'Tx', COALESCE((SELECT MAX(seq) FROM saga_steps WHERE instance_id=? AND scope_id='Tx'),0)+1,
            ?, 'job_x', '{}', NULL, 'undo', 'undo-a', NULL, 'pending', NULL, '2026-06-08T00:00:00Z', '2026-06-08T00:00:00Z'`,
  )
    .bind(stepId, instanceId, instanceId, elementId)
    .run();
}

describe("migration 0002_saga schema", () => {
  it("adds the pull-lease / compensation / DLQ columns to service_task_jobs", async () => {
    const cols = await columns("service_task_jobs");
    for (const c of ["workspace_id", "is_compensation", "compensates_element_id", "worker_id", "lock_token", "lock_expires_at", "activation_expires_at", "error_code"]) {
      expect(cols).toContain(c);
    }
    const idx = await indexNames("service_task_jobs");
    expect(idx).toContain("uq_jobs_instance_element_kind");
    expect(idx).toContain("idx_jobs_leasable");
    expect(idx).not.toContain("uq_jobs_instance_element");
  });

  it("creates the saga_steps ledger with its indexes", async () => {
    const cols = await columns("saga_steps");
    for (const c of ["step_id", "instance_id", "scope_id", "seq", "element_id", "forward_job_id", "captured_input", "captured_output", "compensation_element_id", "compensation_task_type", "compensation_job_id", "compensation_status", "trace_id", "created_at", "updated_at"]) {
      expect(cols).toContain(c);
    }
    const idx = await indexNames("saga_steps");
    expect(idx).toContain("uq_saga_steps_forward");
    expect(idx).toContain("idx_saga_steps_scope");
  });

  it("adds incident remediation columns and the operator-list + credential schema", async () => {
    const inc = await columns("incidents");
    expect(inc).toContain("kind");
    expect(inc).toContain("resolution");
    expect(await indexNames("process_instances")).toContain("idx_instances_workspace_status");
    const cred = await columns("worker_credentials");
    for (const c of ["credential_id", "workspace_id", "token_hash", "label", "created_at", "revoked_at"]) {
      expect(cred).toContain(c);
    }
    expect(await indexNames("worker_credentials")).toContain("uq_worker_credentials_token");
  });

  it("allows a forward + compensation job per element but rejects two forward jobs", async () => {
    const inst = "pi_uniq";
    await insertForwardJob("job_f1", inst, "reserveStock", 0);
    // a compensation job (is_compensation=1) for the SAME element is allowed
    await insertForwardJob("job_c1", inst, "reserveStock", 1);
    // a second FORWARD job for the same element is rejected by the unique index
    await expect(insertForwardJob("job_f2", inst, "reserveStock", 0)).rejects.toThrow();
  });

  it("INSERT OR IGNORE on saga_steps is idempotent per (instance, element)", async () => {
    const inst = "pi_ledger";
    await insertSagaStep("step_1", inst, "reserveStock");
    await insertSagaStep("step_2", inst, "reserveStock"); // ignored — same (instance, element)
    const res = await env.DB.prepare(`SELECT COUNT(*) AS n FROM saga_steps WHERE instance_id = ?`).bind(inst).first<{ n: number }>();
    expect(res?.n).toBe(1);
  });
});
