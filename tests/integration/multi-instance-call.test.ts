import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  authedPost,
  createDraft,
  drainSampleWorkers,
  get,
  leaseOne,
  mintWorkerToken,
  post,
  publishDraft,
  publishAndStart,
} from "../helpers";
import { fireTimer } from "../../src/runtime/timers";
import { childInstanceIdFor } from "../../src/runtime/call-activity";
import { resumeInline } from "../../src/runtime/engine";
import { SIMPLE_CHILD_BPMN, CALL_CHILD_BPMN, CALL_CHILD_TX_PARK_BPMN } from "./call-activity-fixtures";
import {
  MI_CALL_BPMN,
  MI_CALL_ERR_BPMN,
  MI_CALL_ERR_CHILD_BPMN,
  MI_CALL_TIMER_BPMN,
  MI_CALL_TX_BPMN,
  MI_CALL_TX_PARK_BPMN,
} from "./multi-instance-fixtures";

// M5-L3 (Task 10) — MI over callActivity, DIRECT mode. Each iteration `i` of an
// MI callActivity creates a REAL child process instance keyed `(mi1, occ 0, i)`
// (the 4th dimension of childInstanceIdFor, finally non-zero); the MI driver owns
// activation, fan-out, aggregation, and advancement, delegating each iteration to
// the L2 callActivity triad threaded with an `mi` arg. A child that settles
// `errored` is surfaced to the driver as an iteration business error (Task 9
// abort path), never routed at the parent. Under an enclosing transaction cancel,
// the parent reverse pass drives EACH iteration child's own reverse pass (the
// flagship). Direct mode runs each child Workflow inline once; the at-least-once
// CF-create idempotency is asserted structurally (exactly N child_instances rows).

const uid = () => crypto.randomUUID().slice(0, 8);

async function childInstanceRows(parentInstanceId: string) {
  return (
    await env.DB.prepare(
      `SELECT parent_element_id, occurrence, iteration_index, child_instance_id, status
         FROM child_instances WHERE parent_instance_id = ? ORDER BY occurrence, iteration_index`,
    )
      .bind(parentInstanceId)
      .all()
  ).results as {
    parent_element_id: string;
    occurrence: number;
    iteration_index: number;
    child_instance_id: string;
    status: string;
  }[];
}

async function instRow(instanceId: string) {
  return env.DB.prepare(`SELECT status, current_element_id, variables FROM process_instances WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ status: string; current_element_id: string | null; variables: string }>();
}

async function childVars(childInstanceId: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(`SELECT variables FROM process_instances WHERE instance_id = ?`).bind(childInstanceId).first<{ variables: string }>();
  return JSON.parse(row?.variables ?? "{}");
}

async function historyCounts(instanceId: string): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(`SELECT type, COUNT(*) AS n FROM history_events WHERE instance_id = ? GROUP BY type`)
    .bind(instanceId)
    .all<{ type: string; n: number }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.type, r.n]));
}

async function compensationJobCount(instanceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 1`)
    .bind(instanceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function ledgerRows(instanceId: string) {
  return (
    await env.DB.prepare(
      `SELECT element_id, seq, occurrence, iteration_index, scope_id, compensation_status, child_instance_id
         FROM saga_steps WHERE instance_id = ? ORDER BY seq`,
    )
      .bind(instanceId)
      .all()
  ).results as {
    element_id: string;
    seq: number;
    occurrence: number;
    iteration_index: number;
    scope_id: string;
    compensation_status: string;
    child_instance_id: string | null;
  }[];
}

async function theTimer(instanceId: string): Promise<{ timer_id: string } | null> {
  return env.DB.prepare(`SELECT timer_id FROM timers WHERE instance_id = ? ORDER BY created_at LIMIT 1`).bind(instanceId).first<{ timer_id: string }>();
}

async function fireTimerNow(instanceId: string): Promise<string> {
  const t = await theTimer(instanceId);
  expect(t).toBeTruthy();
  await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(t!.timer_id).run();
  await fireTimer(env, t!.timer_id);
  return t!.timer_id;
}

interface LeasedJob {
  jobId: string;
  instanceId: string;
  elementId: string;
  lockToken: string;
  isCompensation?: boolean;
  variables: Record<string, unknown>;
}

async function lease(token: string, taskType: string, maxJobs = 5): Promise<LeasedJob[]> {
  const r = await authedPost("/jobs/activate", token, { taskType, workerId: "mi-call-worker", maxJobs });
  expect(r.status).toBe(200);
  return r.body.jobs as LeasedJob[];
}

async function complete(token: string, job: LeasedJob, output: Record<string, unknown> = {}): Promise<void> {
  const done = await authedPost(`/jobs/${job.jobId}/complete`, token, { lockToken: job.lockToken, outputVariables: output });
  expect(done.status).toBe(200);
}

describe("M5-L3 MI over callActivity — child fan-out + per-iteration child compensation (direct mode)", () => {
  it("[MI-CALL-FANOUT-01] N children are created iteration-keyed, seeded with item/loopCounter, and aggregated by index", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(MI_CALL_BPMN, {
      correlationKey: `mi-call-fanout-${uid()}`,
      variables: { items: ["a", "b", "c"] },
    });
    expect(instance.status).toBe(201);
    const parentId = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");

    // THREE children, iteration-keyed (mi1, occ 0, iter 0/1/2), deterministic ids.
    const rows = await childInstanceRows(parentId);
    expect(rows).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(rows[i]!.parent_element_id).toBe("mi1");
      expect(rows[i]!.occurrence).toBe(0);
      expect(rows[i]!.iteration_index).toBe(i);
      expect(rows[i]!.child_instance_id).toBe(await childInstanceIdFor(parentId, "mi1", 0, i));
    }

    // Each child's INITIAL vars carry the per-iteration item + loopCounter.
    for (let i = 0; i < 3; i++) {
      const v = await childVars(rows[i]!.child_instance_id);
      expect(v.loopCounter).toBe(i);
      expect(v.item).toBe(["a", "b", "c"][i]);
    }

    // Drain the children's echo task → children complete → the parent aggregates.
    await drainSampleWorkers({ taskTypes: ["echo"], token, maxRounds: 20 });

    const parent = await get(`/instances/${parentId}`);
    expect(parent.body.status).toBe("completed");

    // results[i] = child i's FINAL variables (index-ordered).
    const results = (await instRow(parentId).then((r) => JSON.parse(r!.variables))).results as Record<string, unknown>[];
    expect(results).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(results[i]!.loopCounter).toBe(i);
      expect(results[i]!.item).toBe(["a", "b", "c"][i]);
      expect(results[i]!.echoed).toBeDefined();
    }

    // Every iteration child settled completed.
    for (const r of await childInstanceRows(parentId)) {
      expect((await instRow(r.child_instance_id))!.status).toBe("completed");
    }
  });

  it("[MI-CALL-FANOUT-IDEM] a duplicate cold re-drive after fan-out never creates duplicate child rows", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(MI_CALL_BPMN, {
      correlationKey: `mi-call-idem-${uid()}`,
      variables: { items: ["a", "b", "c"] },
    });
    const parentId = instance.body.instanceId as string;
    expect(await childInstanceRows(parentId)).toHaveLength(3);

    // Cold re-drives before draining: still exactly 3 rows (invokeChild idempotent).
    await resumeInline(env, parentId);
    await resumeInline(env, parentId);
    expect(await childInstanceRows(parentId)).toHaveLength(3);

    await drainSampleWorkers({ taskTypes: ["echo"], token, maxRounds: 20 });
    expect((await instRow(parentId))!.status).toBe("completed");
    expect(await childInstanceRows(parentId)).toHaveLength(3);

    // A re-drive after the terminal settle is a cheap no-op — still 3 rows.
    await resumeInline(env, parentId);
    expect(await childInstanceRows(parentId)).toHaveLength(3);
  });

  it("[MI-CALL-COMP-01] under a transaction cancel, the parent reverse pass drives EACH iteration child's own reverse pass in reverse seq order", async () => {
    const childDraft = await createDraft(CALL_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(MI_CALL_TX_BPMN, {
      correlationKey: `mi-call-comp-${uid()}`,
      variables: { items: ["a", "b", "c"], failSettle: true },
    });
    const parentId = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");
    expect(await childInstanceRows(parentId)).toHaveLength(3);

    // Complete each child's reserve-stock in loopCounter order so the ledger seq
    // is deterministic (iter 0 → seq lowest, iter 2 → seq highest).
    const reserves = await lease(token, "reserve-stock", 5);
    expect(reserves).toHaveLength(3);
    for (const i of [0, 1, 2]) {
      const j = reserves.find((r) => r.variables.loopCounter === i)!;
      expect(j).toBeTruthy();
      await complete(token, j, {});
    }

    // All three children committed + completed; the MI aggregated and advanced to
    // `settle`, which is now the parked frontier.
    for (const r of await childInstanceRows(parentId)) {
      expect((await instRow(r.child_instance_id))!.status).toBe("completed");
    }
    // Three iteration ledger rows, scope_id = the miBody scope (mi1), each carrying
    // its child instance id — the reverse-pass predicate.
    const led = (await ledgerRows(parentId)).filter((r) => r.element_id === "mi1");
    expect(led).toHaveLength(3);
    expect(led.every((r) => r.scope_id === "mi1")).toBe(true);
    expect(led.map((r) => r.iteration_index).sort()).toEqual([0, 1, 2]);
    expect(led.every((r) => r.child_instance_id != null && r.compensation_status === "pending")).toBe(true);

    // The steered settle failure routes to the transaction cancel end → reverse pass.
    await drainSampleWorkers({ taskTypes: ["branch-settle"], token });
    expect((await instRow(parentId))!.status).toBe("compensating");

    // REVERSE SEQ ORDER: the child compensators fire iteration 2 → 1 → 0 (each is
    // one release-stock comp job on its own child; exactly one is live at a time).
    for (const expected of [2, 1, 0]) {
      const j = await leaseOne(token, "release-stock");
      expect(j.variables.loopCounter).toBe(expected);
      const done = await authedPost(`/jobs/${j.jobId}/complete`, token, { lockToken: j.lockToken, outputVariables: {} });
      expect(done.status).toBe(200);
    }

    // Every child compensated, the parent settled compensated on the cancel path.
    for (const r of await childInstanceRows(parentId)) {
      expect((await instRow(r.child_instance_id))!.status).toBe("compensated");
    }
    const parent = await instRow(parentId);
    expect(parent!.status).toBe("compensated");
    expect(parent!.current_element_id).toBe("Failed");
    const finalLed = (await ledgerRows(parentId)).filter((r) => r.element_id === "mi1");
    expect(finalLed.every((r) => r.compensation_status === "compensated")).toBe(true);
  });

  it("[MI-CALL-COMP-STRAGGLER-01] a mid-fan-out cancel drives EVERY in-flight committed iteration child through its own reverse pass, not just one", async () => {
    const childDraft = await createDraft(CALL_CHILD_TX_PARK_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(MI_CALL_TX_PARK_BPMN, {
      correlationKey: `mi-call-straggler-${uid()}`,
      variables: { items: ["a", "b", "c"] },
    });
    const parentId = instance.body.instanceId as string;

    // Forward: the compensable pre-step commits, then the MI fans out 3 children.
    await drainSampleWorkers({ taskTypes: ["charge-card"], token });
    // Each child's tx COMMITS (ctp-reserve committedLocal) then parks forever on
    // child-park — it committed a compensable step, but NEVER completes, so the
    // parent applies NONE (no parent ledger row for any iteration).
    await drainSampleWorkers({ taskTypes: ["reserve-stock-park"], token });

    const rows = await childInstanceRows(parentId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.iteration_index).sort()).toEqual([0, 1, 2]);
    for (const r of rows) {
      // Every child is mid-flight (committed + parked), NOT terminal.
      expect((await instRow(r.child_instance_id))!.status).toBe("waiting");
      // The child's own ledger holds the committed compensable step.
      const cReserve = (
        await env.DB.prepare(`SELECT compensation_status FROM saga_steps WHERE instance_id = ? AND element_id = 'ctp-reserve'`)
          .bind(r.child_instance_id)
          .first<{ compensation_status: string }>()
      );
      expect(cReserve?.compensation_status).toBe("committedLocal");
    }
    // The parent parked ON the MI element; NO iteration applied → zero mi1 ledger rows.
    expect((await instRow(parentId))!.status).toBe("waiting");
    expect((await ledgerRows(parentId)).filter((r) => r.element_id === "mi1")).toHaveLength(0);

    // Operator /cancel while ALL THREE iteration children are mid-flight.
    const cancelled = await post(`/instances/${parentId}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("compensating");

    // The reverse pass must drive EACH in-flight child's own reverse pass. Drain the
    // per-child compensators (release-stock-park) + the pre-step's (refund-card).
    await drainSampleWorkers({ taskTypes: ["release-stock-park", "refund-card"], token, maxRounds: 60 });

    // THE CRUX: every iteration child compensated its committed step — NOT just the
    // last (the pre-fix bug reverses only rows[last]; the other two stay `cancelled`,
    // leaking their committed reserve). No orphan children.
    for (const r of await childInstanceRows(parentId)) {
      expect((await instRow(r.child_instance_id))!.status).toBe("compensated");
      const cReserve = await env.DB.prepare(`SELECT compensation_status FROM saga_steps WHERE instance_id = ? AND element_id = 'ctp-reserve'`)
        .bind(r.child_instance_id)
        .first<{ compensation_status: string }>();
      expect(cReserve?.compensation_status).toBe("compensated");
    }
    // Three iteration ledger rows on mi1 (one per in-flight child), all compensated.
    const led = (await ledgerRows(parentId)).filter((r) => r.element_id === "mi1");
    expect(led).toHaveLength(3);
    expect(led.map((r) => r.iteration_index).sort()).toEqual([0, 1, 2]);
    expect(led.every((r) => r.child_instance_id != null && r.compensation_status === "compensated")).toBe(true);
    // The parent settled compensated on the process-root cancel.
    expect((await instRow(parentId))!.status).toBe("compensated");
  });

  it("[MI-CALL-ERR-01] an iteration child that settles errored aborts the visit: siblings cascade-cancelled, the error routes to the MI boundary", async () => {
    const probeType = `mi-call-probe-${uid()}`;
    const handlerType = `mi-call-handler-${uid()}`;
    const childDraft = await createDraft(MI_CALL_ERR_CHILD_BPMN(probeType));
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(MI_CALL_ERR_BPMN(handlerType), {
      correlationKey: `mi-call-err-${uid()}`,
      variables: { items: ["a", "b", "c"] },
    });
    const parentId = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");
    const rows = await childInstanceRows(parentId);
    expect(rows).toHaveLength(3);

    // The children park on `probe`. Complete ONLY iteration 1's probe (item "b") so
    // its interior gateway raises CHILD_FAILED; siblings 0/2 stay live (parked).
    const probes = await lease(token, probeType, 5);
    expect(probes).toHaveLength(3);
    const badProbe = probes.find((p) => p.variables.item === "b")!;
    expect(badProbe).toBeTruthy();
    await complete(token, badProbe, {});

    // Iteration 1's child errored → the whole visit aborted and routed to the MI
    // error boundary → `handler`; siblings 0/2 were cascade-cancelled.
    const id0 = await childInstanceIdFor(parentId, "mi1", 0, 0);
    const id1 = await childInstanceIdFor(parentId, "mi1", 0, 1);
    const id2 = await childInstanceIdFor(parentId, "mi1", 0, 2);
    expect((await instRow(id1))!.status).toBe("errored");
    expect((await instRow(id0))!.status).toBe("cancelled");
    expect((await instRow(id2))!.status).toBe("cancelled");

    const routed = await get(`/instances/${parentId}`);
    expect(routed.body.status).toBe("waiting");
    expect(routed.body.currentElementId).toBe("handler");

    // NEVER auto-compensation; the abort is audited once; never applied.
    expect(await compensationJobCount(parentId)).toBe(0);
    const history = await historyCounts(parentId);
    expect(history["miAborted"]).toBe(1);
    expect(history["miCompleted"]).toBeUndefined();

    // Finish the handler → the saga completes on the boundary path.
    const handlerJob = (await lease(token, handlerType, 5))[0]!;
    expect(handlerJob.elementId).toBe("handler");
    await complete(token, handlerJob, {});
    expect((await get(`/instances/${parentId}`)).body.status).toBe("completed");
  });

  it("[MI-CALL-HAZARD-01] a timer boundary on the MI callActivity cancels ALL live iteration children without compensation", async () => {
    const probeType = `mi-call-tmr-probe-${uid()}`;
    const timeoutType = `mi-call-timeout-${uid()}`;
    const childDraft = await createDraft(MI_CALL_ERR_CHILD_BPMN(probeType));
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(MI_CALL_TIMER_BPMN(timeoutType), {
      correlationKey: `mi-call-timer-${uid()}`,
      variables: { items: ["a", "b", "c"] },
    });
    const parentId = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting");
    // Three children, all parked on probe (never drained).
    const rows = await childInstanceRows(parentId);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect((await instRow(r.child_instance_id))!.status).toBe("waiting");

    // Fire the Hazard timer while all iterations are in flight.
    await fireTimerNow(parentId);

    // Every live iteration child was cascade-cancelled; the token took the boundary.
    for (const r of rows) expect((await instRow(r.child_instance_id))!.status).toBe("cancelled");
    const routed = await get(`/instances/${parentId}`);
    expect(routed.body.status).toBe("waiting");
    expect(routed.body.currentElementId).toBe("onTimeout");
    expect(await compensationJobCount(parentId)).toBe(0);

    // Finish the timeout handler → the saga completes on the boundary path.
    const timeoutJob = (await lease(token, timeoutType, 5))[0]!;
    expect(timeoutJob.elementId).toBe("onTimeout");
    await complete(token, timeoutJob, {});
    expect((await get(`/instances/${parentId}`)).body.status).toBe("completed");
  });
});
