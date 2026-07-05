import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("migration 0008_call_activity", () => {
  it("creates child_instances with the provenance columns", async () => {
    const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info('child_instances')`).all<{ name: string }>();
    const names = (cols.results ?? []).map((r) => r.name);
    for (const c of [
      "parent_instance_id",
      "parent_element_id",
      "occurrence",
      "iteration_index",
      "child_instance_id",
      "status",
      "created_at",
      "updated_at",
    ]) {
      expect(names).toContain(c);
    }
  });

  it("rejects a duplicate visit key via the UNIQUE index", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO child_instances
         (parent_instance_id, parent_element_id, occurrence, iteration_index, child_instance_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'invoked', ?, ?)`,
    )
      .bind("inst-1", "CallActivity_1", 0, 0, "child-1", now, now)
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO child_instances
           (parent_instance_id, parent_element_id, occurrence, iteration_index, child_instance_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'invoked', ?, ?)`,
      )
        .bind("inst-1", "CallActivity_1", 0, 0, "child-2", now, now)
        .run(),
    ).rejects.toThrow();
  });

  it("markChildOutputAppliedStmt-shaped UPDATE flips exactly the invoked row, once", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO child_instances
         (parent_instance_id, parent_element_id, occurrence, iteration_index, child_instance_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'invoked', ?, ?)`,
    )
      .bind("inst-2", "CallActivity_1", 0, 0, "child-3", now, now)
      .run();

    const first = await env.DB.prepare(
      `UPDATE child_instances SET status = 'outputApplied', updated_at = ?
         WHERE parent_instance_id = ? AND parent_element_id = ? AND occurrence = ? AND iteration_index = ? AND status = 'invoked'`,
    )
      .bind(now, "inst-2", "CallActivity_1", 0, 0)
      .run();
    expect(first.meta.changes).toBe(1);

    const second = await env.DB.prepare(
      `UPDATE child_instances SET status = 'outputApplied', updated_at = ?
         WHERE parent_instance_id = ? AND parent_element_id = ? AND occurrence = ? AND iteration_index = ? AND status = 'invoked'`,
    )
      .bind(now, "inst-2", "CallActivity_1", 0, 0)
      .run();
    expect(second.meta.changes).toBe(0);
  });

  it("adds process_instances parent linkage + error_code columns, defaulting NULL", async () => {
    const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info('process_instances')`).all<{ name: string }>();
    const names = (cols.results ?? []).map((r) => r.name);
    for (const c of ["parent_instance_id", "parent_element_id", "parent_occurrence", "error_code"]) {
      expect(names).toContain(c);
    }

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO process_instances
         (instance_id, workspace_id, definition_version_id, workflow_instance_id, workflow_status,
          business_key, correlation_key, status, current_element_id, variables, started_at, updated_at, completed_at, last_synced_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, 'starting', NULL, '{}', ?, ?, NULL, NULL)`,
    )
      .bind("inst-null-check", "ws-1", "dv-1", "inst-null-check", "ck-1", now, now)
      .run();

    const row = await env.DB.prepare(
      `SELECT parent_instance_id, parent_element_id, parent_occurrence, error_code FROM process_instances WHERE instance_id = ?`,
    )
      .bind("inst-null-check")
      .first<{ parent_instance_id: unknown; parent_element_id: unknown; parent_occurrence: unknown; error_code: unknown }>();
    expect(row?.parent_instance_id).toBeNull();
    expect(row?.parent_element_id).toBeNull();
    expect(row?.parent_occurrence).toBeNull();
    expect(row?.error_code).toBeNull();
  });

  it("adds saga_steps.child_instance_id", async () => {
    const s = await env.DB.prepare(`SELECT name FROM pragma_table_info('saga_steps')`).all<{ name: string }>();
    expect((s.results ?? []).map((r) => r.name)).toContain("child_instance_id");
  });
});
