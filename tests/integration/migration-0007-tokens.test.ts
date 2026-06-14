import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("migration 0007_tokens", () => {
  it("creates execution_tokens with the read-model columns", async () => {
    const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info('execution_tokens')`).all<{ name: string }>();
    const names = (cols.results ?? []).map((r) => r.name);
    for (const c of ["token_id", "instance_id", "region_id", "region_activation", "parent_token_id", "branch_flow_id", "position_element_id", "status", "variables_overlay", "created_at", "updated_at"]) {
      expect(names).toContain(c);
    }
  });
  it("creates join_arrivals and join_completions with composite PKs", async () => {
    const t = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('join_arrivals','join_completions')`).all<{ name: string }>();
    expect((t.results ?? []).map((r) => r.name).sort()).toEqual(["join_arrivals", "join_completions"]);
  });
  it("adds gateway_decisions.activated_flow_ids and saga_steps.token_id", async () => {
    const g = await env.DB.prepare(`SELECT name FROM pragma_table_info('gateway_decisions')`).all<{ name: string }>();
    expect((g.results ?? []).map((r) => r.name)).toContain("activated_flow_ids");
    const s = await env.DB.prepare(`SELECT name FROM pragma_table_info('saga_steps')`).all<{ name: string }>();
    expect((s.results ?? []).map((r) => r.name)).toContain("token_id");
  });
});
