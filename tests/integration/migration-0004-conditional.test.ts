import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Persistence gate for migration 0004_conditional.sql (applied by
// tests/apply-migrations.ts) — the M2 conditional-saga substrate (design
// 2026-06-09 §5/§6/§9): the occurrence discriminator across jobs / ledger /
// subscriptions, the output_applied fast-forward marker, the conditional
// topology columns on bpmn_elements, and the gateway_decisions table. Exercises
// the REAL statement builders in src/persistence/ against a real D1.

import {
  createJobStmt,
  createSubscription,
  getCompensationJobByElement,
  getForwardJob,
  getForwardJobByElement,
  getIncidentForInstance,
  incidentStmt,
  jobCompleteStmt,
  markJobOutputAppliedStmt,
} from "../../src/persistence/instances";
import { resetJobForRetry } from "../../src/persistence/jobs";
import { insertSagaStepStmt } from "../../src/persistence/saga";
import {
  getGatewayDecision,
  insertGatewayDecisionStmt,
} from "../../src/persistence/gateway-decisions";

const NOW = "2026-06-10T00:00:00Z";

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

function insertJob(jobId: string, instanceId: string, elementId: string, occurrence: number, isComp = false) {
  return createJobStmt(env.DB, {
    jobId,
    instanceId,
    elementId,
    taskType: "reserve-stock",
    retryLimit: 3,
    idempotencyKey: `${instanceId}:${elementId}:${isComp ? 1 : 0}:${occurrence}`,
    inputVariables: {},
    now: NOW,
    isCompensation: isComp,
    occurrence,
  }).run();
}

function insertStep(stepId: string, instanceId: string, elementId: string, occurrence: number) {
  return insertSagaStepStmt(env.DB, {
    stepId,
    instanceId,
    scopeId: "Tx",
    elementId,
    forwardJobId: `job_${stepId}`,
    capturedInput: { sku: "A" },
    capturedOutput: null,
    compensationElementId: "undoReserve",
    compensationTaskType: "release-stock",
    compensationStatus: "pending",
    now: NOW,
    occurrence,
  }).run();
}

describe("migration 0004_conditional schema", () => {
  it("adds occurrence + output_applied to service_task_jobs and widens the unique index", async () => {
    const cols = await columns("service_task_jobs");
    expect(cols).toContain("occurrence");
    expect(cols).toContain("output_applied");
    expect(await indexColumns("uq_jobs_instance_element_kind")).toEqual([
      "instance_id",
      "element_id",
      "is_compensation",
      "occurrence",
    ]);
  });

  it("adds occurrence to saga_steps and widens uq_saga_steps_forward", async () => {
    expect(await columns("saga_steps")).toContain("occurrence");
    expect(await indexColumns("uq_saga_steps_forward")).toEqual([
      "instance_id",
      "element_id",
      "occurrence",
    ]);
  });

  it("adds occurrence to message_subscriptions and the conditional columns to bpmn_elements", async () => {
    expect(await columns("message_subscriptions")).toContain("occurrence");
    const els = await columns("bpmn_elements");
    expect(els).toContain("condition_expression");
    expect(els).toContain("is_default");
  });

  it("creates gateway_decisions with the (instance, element, occurrence) unique index", async () => {
    const cols = await columns("gateway_decisions");
    for (const c of [
      "decision_id",
      "instance_id",
      "element_id",
      "occurrence",
      "chosen_flow_id",
      "is_default",
      "evaluations",
      "variables_snapshot",
      "created_at",
    ]) {
      expect(cols).toContain(c);
    }
    expect(await uniqueIndexNames("gateway_decisions")).toContain("uq_gateway_decisions");
    expect(await indexColumns("uq_gateway_decisions")).toEqual([
      "instance_id",
      "element_id",
      "occurrence",
    ]);
  });
});

describe("occurrence-discriminated job rows (design §5)", () => {
  it("allows one forward job per (element, occurrence) and a second iteration as a new row", async () => {
    const inst = "pi_loop_jobs";
    await insertJob("job_o0", inst, "reserveStock", 0);
    // same (instance, element, kind, occurrence) → unique-index violation
    await expect(insertJob("job_o0_dup", inst, "reserveStock", 0)).rejects.toThrow();
    // second iteration is its own row
    await insertJob("job_o1", inst, "reserveStock", 1);
    // a compensation job inherits its forward step's occurrence (design §8)
    await insertJob("job_c1", inst, "reserveStock", 1, true);

    const o0 = await getForwardJob(env.DB, inst, "reserveStock", 0);
    const o1 = await getForwardJob(env.DB, inst, "reserveStock", 1);
    const o2 = await getForwardJob(env.DB, inst, "reserveStock", 2);
    expect(o0?.job_id).toBe("job_o0");
    expect(o0?.occurrence).toBe(0);
    expect(o0?.output_applied).toBe(0);
    expect(o1?.job_id).toBe("job_o1");
    expect(o2).toBeNull();

    // legacy occurrence-unaware lookups (deprecated) deterministically return
    // the LATEST iteration, never an arbitrary row
    const legacyFwd = await getForwardJobByElement(env.DB, inst, "reserveStock");
    expect(legacyFwd?.job_id).toBe("job_o1");
    const legacyComp = await getCompensationJobByElement(env.DB, inst, "reserveStock");
    expect(legacyComp?.job_id).toBe("job_c1");
  });

  it("markJobOutputAppliedStmt flips the marker for a COMPLETED job only", async () => {
    const inst = "pi_applied";
    await insertJob("job_app", inst, "reserveStock", 0);

    // status 'created' → guarded UPDATE affects 0 rows, marker stays down
    const miss = await markJobOutputAppliedStmt(env.DB, "job_app", NOW).run();
    expect(miss.meta.changes).toBe(0);
    let row = await getForwardJob(env.DB, inst, "reserveStock", 0);
    expect(row?.output_applied).toBe(0);

    // once completed, the flip applies
    await jobCompleteStmt(env.DB, "job_app", { reserved: true }, NOW).run();
    const hit = await markJobOutputAppliedStmt(env.DB, "job_app", NOW).run();
    expect(hit.meta.changes).toBe(1);
    row = await getForwardJob(env.DB, inst, "reserveStock", 0);
    expect(row?.output_applied).toBe(1);
  });
});

describe("resetJobForRetry live-frontier matcher (TASK-32)", () => {
  const PATCH = `{"patched":true}`;

  async function jobState(jobId: string) {
    return env.DB.prepare(
      `SELECT status, output_applied, input_variables, attempt_count, lock_token, activation_expires_at FROM service_task_jobs WHERE job_id = ?`,
    )
      .bind(jobId)
      .first<{ status: string; output_applied: number; input_variables: string; attempt_count: number; lock_token: string | null; activation_expires_at: string | null }>();
  }

  it("resets a LOCKED unapplied forward job (workflow svc-timeout incident) and refreshes its input", async () => {
    const inst = "pi_retry_locked";
    await insertJob("job_rt_locked", inst, "taskA", 0);
    // workflow-mode svc-timeout leaves the job mid-lease: nobody completed it.
    // The stale-PAST activation_expires_at simulates the creation-time DLQ TTL
    // long lapsed by the time the operator retries.
    await env.DB.prepare(
      `UPDATE service_task_jobs SET status = 'locked', lock_token = 'tok', lock_expires_at = '2026-06-10T01:00:00Z', attempt_count = 2, activation_expires_at = '2000-01-01T00:00:00Z' WHERE job_id = 'job_rt_locked'`,
    ).run();

    const changes = await resetJobForRetry(env.DB, {
      instanceId: inst,
      elementId: "taskA",
      isCompensation: false,
      inputVariables: PATCH,
      now: NOW,
    });
    expect(changes).toBe(1);
    expect(await jobState("job_rt_locked")).toMatchObject({
      status: "created",
      attempt_count: 0,
      lock_token: null,
      input_variables: PATCH, // the operator's variable patch reaches the worker
      // The stale DLQ TTL is cleared — otherwise a late/duplicate JobScheduler
      // alarm would see a fresh-looking (created, attempt_count=0) job with a
      // long-past activation_expires_at and insta-fail the retry.
      activation_expires_at: null,
    });
  });

  it("resets a CREATED unapplied compensation job (workflow comp-timeout)", async () => {
    const inst = "pi_retry_comp";
    await insertJob("job_rt_comp", inst, "taskA", 0, true);

    const changes = await resetJobForRetry(env.DB, {
      instanceId: inst,
      elementId: "taskA",
      isCompensation: true,
      inputVariables: PATCH,
      now: NOW,
    });
    expect(changes).toBe(1);
    expect((await jobState("job_rt_comp"))?.input_variables).toBe(PATCH);
  });

  it("resets the failed and poison-completed frontiers, NEVER an applied or compensated row", async () => {
    const inst = "pi_retry_mixed";
    // failed unapplied (technical exhaustion / uncaught business error),
    // carrying a stale-past DLQ TTL from creation
    await insertJob("job_rt_failed", inst, "taskFail", 0);
    await env.DB.prepare(`UPDATE service_task_jobs SET status = 'failed', activation_expires_at = '2000-01-01T00:00:00Z' WHERE job_id = 'job_rt_failed'`).run();
    // poison: completed forward, output never applicable
    await insertJob("job_rt_poison", inst, "taskPoison", 0);
    await jobCompleteStmt(env.DB, "job_rt_poison", { huge: "blob" }, NOW).run();
    // APPLIED earlier iteration — must never re-open (breaks write-free rewalk)
    await insertJob("job_rt_applied", inst, "taskDone", 0);
    await jobCompleteStmt(env.DB, "job_rt_applied", { ok: true }, NOW).run();
    await markJobOutputAppliedStmt(env.DB, "job_rt_applied", NOW).run();
    // COMPLETED compensation — already compensated (ledger holds the state)
    await insertJob("job_rt_comp_done", inst, "taskDone", 0, true);
    await jobCompleteStmt(env.DB, "job_rt_comp_done", { released: true }, NOW).run();

    const reset = (elementId: string, isCompensation: boolean) =>
      resetJobForRetry(env.DB, { instanceId: inst, elementId, isCompensation, inputVariables: PATCH, now: NOW });

    expect(await reset("taskFail", false)).toBe(1);
    expect(await reset("taskPoison", false)).toBe(1);
    expect(await reset("taskDone", false)).toBe(0);
    expect(await reset("taskDone", true)).toBe(0);

    // The reset frontier sheds its stale DLQ TTL (late-alarm immunity).
    expect((await jobState("job_rt_failed"))?.activation_expires_at).toBeNull();

    expect(await jobState("job_rt_applied")).toMatchObject({ status: "completed", output_applied: 1 });
    expect((await jobState("job_rt_comp_done"))?.status).toBe("completed");
  });
});

describe("saga_steps ledger dedup per occurrence (design §8)", () => {
  it("duplicate completion of the same occurrence is a no-op; a second occurrence inserts a new row", async () => {
    const inst = "pi_loop_ledger";
    await insertStep("step_a", inst, "reserveStock", 0);
    await insertStep("step_a_dup", inst, "reserveStock", 0); // replay → INSERT OR IGNORE no-op
    let n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM saga_steps WHERE instance_id = ?`)
      .bind(inst)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);

    await insertStep("step_b", inst, "reserveStock", 1); // next loop iteration → its own ledger row
    const rows = await env.DB.prepare(
      `SELECT step_id, seq, occurrence FROM saga_steps WHERE instance_id = ? ORDER BY seq`,
    )
      .bind(inst)
      .all<{ step_id: string; seq: number; occurrence: number }>();
    expect(rows.results).toEqual([
      { step_id: "step_a", seq: 1, occurrence: 0 },
      { step_id: "step_b", seq: 2, occurrence: 1 },
    ]);
  });
});

describe("gateway_decisions builders (design §6)", () => {
  const evaluations = [
    { flowId: "toHigh", expression: "amount > 100", result: false },
    { flowId: "toLow", expression: "amount <= 100", result: true },
  ];

  it("inserts and selects a decision; a duplicate insert for the same occurrence REJECTS", async () => {
    const inst = "pi_gw";
    await insertGatewayDecisionStmt(env.DB, {
      decisionId: "gd_1",
      instanceId: inst,
      elementId: "xorGw",
      occurrence: 0,
      chosenFlowId: "toLow",
      isDefault: false,
      evaluations,
      variablesSnapshot: { amount: 50 },
      now: NOW,
    }).run();

    // a losing concurrent walk's plain INSERT hits the unique constraint and
    // REJECTS — in the engine this aborts its whole batch (transition +
    // history); the caller re-reads the decision and follows the recorded
    // branch, never re-evaluates
    await expect(
      insertGatewayDecisionStmt(env.DB, {
        decisionId: "gd_1_dup",
        instanceId: inst,
        elementId: "xorGw",
        occurrence: 0,
        chosenFlowId: "toHigh",
        isDefault: false,
        evaluations: [],
        variablesSnapshot: null,
        now: NOW,
      }).run(),
    ).rejects.toThrow(/UNIQUE/i);

    // the original recorded branch is unchanged
    const d = await getGatewayDecision(env.DB, inst, "xorGw", 0);
    expect(d?.decisionId).toBe("gd_1");
    expect(d?.chosenFlowId).toBe("toLow");
    expect(d?.isDefault).toBe(false);
    expect(d?.evaluations).toEqual(evaluations); // JSON, document order preserved
    expect(d?.variablesSnapshot).toEqual({ amount: 50 });

    // a later loop pass through the same gateway is its own decision
    await insertGatewayDecisionStmt(env.DB, {
      decisionId: "gd_2",
      instanceId: inst,
      elementId: "xorGw",
      occurrence: 1,
      chosenFlowId: "toHigh",
      isDefault: true,
      evaluations: [],
      variablesSnapshot: null,
      now: NOW,
    }).run();
    const d1 = await getGatewayDecision(env.DB, inst, "xorGw", 1);
    expect(d1?.decisionId).toBe("gd_2");
    expect(d1?.isDefault).toBe(true);
    expect(d1?.variablesSnapshot).toBeNull();
    expect(await getGatewayDecision(env.DB, inst, "xorGw", 2)).toBeNull();
  });
});

describe("occurrence-keyed message subscriptions (design §5)", () => {
  it("persists the supplied occurrence and defaults legacy callers to 0", async () => {
    const base = {
      workspaceId: "ws1",
      instanceId: "pi_subs",
      elementId: "waitPayment",
      messageName: "PaymentReceived",
      correlationKey: "order-1",
      brokerKey: "ws1::PaymentReceived::order-1",
      workflowEventType: "bpmn_message_x",
      status: "active" as const,
      expiresAt: "2026-06-10T01:00:00Z",
      now: NOW,
    };
    await createSubscription(env.DB, { ...base, subscriptionId: "sub_0" });
    await createSubscription(env.DB, { ...base, subscriptionId: "sub_2", occurrence: 2 });
    const rows = await env.DB.prepare(
      `SELECT subscription_id, occurrence FROM message_subscriptions WHERE instance_id = 'pi_subs' ORDER BY subscription_id`,
    ).all<{ subscription_id: string; occurrence: number }>();
    expect(rows.results).toEqual([
      { subscription_id: "sub_0", occurrence: 0 },
      { subscription_id: "sub_2", occurrence: 2 },
    ]);
  });
});

describe("incident kinds loopLimit / noPath (design §9)", () => {
  it("persists and maps the M2 incident kinds", async () => {
    for (const [inst, kind] of [
      ["pi_inc_loop", "loopLimit"],
      ["pi_inc_nopath", "noPath"],
    ] as const) {
      await incidentStmt(env.DB, {
        incidentId: `inc_${kind}`,
        instanceId: inst,
        elementId: "xorGw",
        reason: `terminal ${kind}`,
        retryCount: 0,
        kind,
        now: NOW,
      }).run();
      const incident = await getIncidentForInstance(env.DB, inst);
      expect(incident?.kind).toBe(kind);
    }
  });
});
