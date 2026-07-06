import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Persistence gate for migration 0009_multi_instance.sql + src/persistence/mi-activations.ts
// (M5-L3 design §6). Exercises the REAL statement builders against a real D1: the
// mi_activations decider-table shape (the gateway_decisions analogue — cardinality
// pinned once, early-settle + apply-once CAS deciders), the iteration_index second
// dimension on service_task_jobs + saga_steps, and the widened UNIQUE indexes. The
// correctness keystones asserted here:
//   - insert→get roundtrip + duplicate-visit rejection (uq_mi_activations_visit)
//   - settleMiActivationStmt flips ONCE (WHERE settled_kind IS NULL) — a second run
//     changes 0 rows (asserted via meta.changes) — the once-only decider
//   - markMiOutputAppliedStmt flips ONCE (WHERE output_applied = 0) — the single-apply CAS
//   - two saga steps at the SAME (instance, element, occurrence) but DIFFERENT
//     iteration BOTH insert; the SAME iteration is INSERT-OR-IGNOREd (replay no-op)

import { dbBatch } from "../../src/persistence/db";
import {
  getMiActivation,
  insertMiActivationStmt,
  markMiOutputAppliedStmt,
  settleMiActivationStmt,
} from "../../src/persistence/mi-activations";
import { insertSagaStepStmt } from "../../src/persistence/saga";

const NOW = "2026-07-06T00:00:00.000Z";
const LATER = "2026-07-06T00:05:00.000Z";

async function columns(table: string): Promise<string[]> {
  const res = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return (res.results ?? []).map((r) => r.name);
}

async function indexColumns(index: string): Promise<string[]> {
  const res = await env.DB.prepare(`PRAGMA index_info(${index})`).all<{ name: string }>();
  return (res.results ?? []).map((r) => r.name);
}

async function uniqueIndexNames(table: string): Promise<string[]> {
  const res = await env.DB.prepare(`PRAGMA index_list(${table})`).all<{ name: string; unique: number }>();
  return (res.results ?? []).filter((r) => r.unique === 1).map((r) => r.name);
}

describe("migration 0009_multi_instance schema", () => {
  it("creates the mi_activations decider table with the design §6 columns", async () => {
    const cols = await columns("mi_activations");
    for (const c of [
      "instance_id",
      "element_id",
      "occurrence",
      "cardinality",
      "is_sequential",
      "items",
      "settled_kind",
      "settled_count",
      "output_applied",
      "created_at",
      "updated_at",
    ]) {
      expect(cols).toContain(c);
    }
  });

  it("enforces uq_mi_activations_visit (UNIQUE) over (instance_id, element_id, occurrence)", async () => {
    expect(await uniqueIndexNames("mi_activations")).toContain("uq_mi_activations_visit");
    expect(await indexColumns("uq_mi_activations_visit")).toEqual([
      "instance_id",
      "element_id",
      "occurrence",
    ]);
  });

  it("adds iteration_index (DEFAULT 0) to service_task_jobs + saga_steps", async () => {
    expect(await columns("service_task_jobs")).toContain("iteration_index");
    expect(await columns("saga_steps")).toContain("iteration_index");
  });

  it("widens uq_jobs_instance_element_kind with iteration_index (old key order preserved)", async () => {
    expect(await uniqueIndexNames("service_task_jobs")).toContain("uq_jobs_instance_element_kind");
    expect(await indexColumns("uq_jobs_instance_element_kind")).toEqual([
      "instance_id",
      "element_id",
      "is_compensation",
      "occurrence",
      "iteration_index",
    ]);
  });

  it("widens uq_saga_steps_forward with iteration_index (old key order preserved)", async () => {
    expect(await uniqueIndexNames("saga_steps")).toContain("uq_saga_steps_forward");
    expect(await indexColumns("uq_saga_steps_forward")).toEqual([
      "instance_id",
      "element_id",
      "occurrence",
      "iteration_index",
    ]);
  });
});

describe("mi_activations persistence builders", () => {
  it("insert → get roundtrip pins cardinality + items, starts unsettled + unapplied", async () => {
    await insertMiActivationStmt(env.DB, {
      instanceId: "pi_mi",
      elementId: "Task_fanout",
      occurrence: 0,
      cardinality: 3,
      isSequential: false,
      items: ["a", "b", "c"],
      now: NOW,
    }).run();

    const row = await getMiActivation(env.DB, "pi_mi", "Task_fanout", 0);
    expect(row).not.toBeNull();
    expect(row!.cardinality).toBe(3);
    expect(row!.is_sequential).toBe(0);
    expect(row!.items).toBe(JSON.stringify(["a", "b", "c"]));
    expect(row!.settled_kind).toBeNull();
    expect(row!.settled_count).toBeNull();
    expect(row!.output_applied).toBe(0);
    expect(row!.created_at).toBe(NOW);
  });

  it("stores a null items list + a sequential flag verbatim", async () => {
    await insertMiActivationStmt(env.DB, {
      instanceId: "pi_seq",
      elementId: "Task_seq",
      occurrence: 0,
      cardinality: 5,
      isSequential: true,
      items: null,
      now: NOW,
    }).run();
    const row = await getMiActivation(env.DB, "pi_seq", "Task_seq", 0);
    expect(row!.is_sequential).toBe(1);
    expect(row!.items).toBeNull();
  });

  it("rejects a duplicate visit (uq_mi_activations_visit)", async () => {
    const one = () =>
      insertMiActivationStmt(env.DB, {
        instanceId: "pi_dup",
        elementId: "Task_dup",
        occurrence: 0,
        cardinality: 2,
        isSequential: false,
        items: null,
        now: NOW,
      });
    await one().run();
    await expect(one().run()).rejects.toThrow();
  });

  it("settleMiActivationStmt flips ONCE — a second run changes 0 rows (the once-only decider)", async () => {
    await insertMiActivationStmt(env.DB, {
      instanceId: "pi_settle",
      elementId: "Task_settle",
      occurrence: 0,
      cardinality: 4,
      isSequential: false,
      items: null,
      now: NOW,
    }).run();

    const first = await settleMiActivationStmt(env.DB, {
      instanceId: "pi_settle",
      elementId: "Task_settle",
      occurrence: 0,
      kind: "condition",
      count: 2,
      now: NOW,
    }).run();
    expect(first.meta.changes).toBe(1);

    const row = await getMiActivation(env.DB, "pi_settle", "Task_settle", 0);
    expect(row!.settled_kind).toBe("condition");
    expect(row!.settled_count).toBe(2);

    // Second settle (a different kind/count) must NOT overwrite — WHERE settled_kind IS NULL.
    const second = await settleMiActivationStmt(env.DB, {
      instanceId: "pi_settle",
      elementId: "Task_settle",
      occurrence: 0,
      kind: "abort",
      count: 99,
      now: LATER,
    }).run();
    expect(second.meta.changes).toBe(0);
    const after = await getMiActivation(env.DB, "pi_settle", "Task_settle", 0);
    expect(after!.settled_kind).toBe("condition"); // unchanged
    expect(after!.settled_count).toBe(2);
  });

  it("markMiOutputAppliedStmt flips ONCE — a second run changes 0 rows (the single-apply CAS)", async () => {
    await insertMiActivationStmt(env.DB, {
      instanceId: "pi_apply",
      elementId: "Task_apply",
      occurrence: 0,
      cardinality: 2,
      isSequential: false,
      items: null,
      now: NOW,
    }).run();

    const first = await markMiOutputAppliedStmt(env.DB, {
      instanceId: "pi_apply",
      elementId: "Task_apply",
      occurrence: 0,
      now: NOW,
    }).run();
    expect(first.meta.changes).toBe(1);
    expect((await getMiActivation(env.DB, "pi_apply", "Task_apply", 0))!.output_applied).toBe(1);

    const second = await markMiOutputAppliedStmt(env.DB, {
      instanceId: "pi_apply",
      elementId: "Task_apply",
      occurrence: 0,
      now: LATER,
    }).run();
    expect(second.meta.changes).toBe(0); // single-apply CAS: already applied
  });
});

describe("saga_steps iteration_index second dimension", () => {
  const baseStep = (iterationIndex: number) => ({
    stepId: `step_${iterationIndex}`,
    instanceId: "pi_iter",
    scopeId: "Scope_body",
    elementId: "Task_body",
    forwardJobId: `job_${iterationIndex}`,
    capturedInput: {},
    capturedOutput: null,
    compensationElementId: null,
    compensationTaskType: null,
    compensationStatus: "notRequired" as const,
    occurrence: 0,
    iterationIndex,
    now: NOW,
  });

  it("two steps at the SAME (instance, element, occurrence) but DIFFERENT iteration BOTH insert", async () => {
    await dbBatch(env.DB, [
      insertSagaStepStmt(env.DB, baseStep(0)),
      insertSagaStepStmt(env.DB, baseStep(1)),
    ]);
    const rows = await env.DB.prepare(
      `SELECT iteration_index FROM saga_steps WHERE instance_id = ? AND element_id = ? AND occurrence = ? ORDER BY iteration_index`,
    )
      .bind("pi_iter", "Task_body", 0)
      .all<{ iteration_index: number }>();
    expect((rows.results ?? []).map((r) => r.iteration_index)).toEqual([0, 1]);
  });

  it("the SAME (instance, element, occurrence, iteration) is INSERT-OR-IGNOREd (replay no-op)", async () => {
    await insertSagaStepStmt(env.DB, { ...baseStep(0), stepId: "step_first", instanceId: "pi_ignore" }).run();
    // A second row with the SAME key but a different step_id must be silently ignored.
    await insertSagaStepStmt(env.DB, { ...baseStep(0), stepId: "step_second", instanceId: "pi_ignore" }).run();
    const rows = await env.DB.prepare(
      `SELECT step_id FROM saga_steps WHERE instance_id = ? AND element_id = ? AND occurrence = ? AND iteration_index = ?`,
    )
      .bind("pi_ignore", "Task_body", 0, 0)
      .all<{ step_id: string }>();
    expect((rows.results ?? []).map((r) => r.step_id)).toEqual(["step_first"]);
  });
});
