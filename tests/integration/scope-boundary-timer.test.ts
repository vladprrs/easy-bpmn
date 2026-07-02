import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TX_TIMER_BPMN, authedPost, get, leaseAndComplete, leaseOne, mintWorkerToken, post, publishAndStart, publishMessage } from "../helpers";
import { resumeInline } from "../../src/runtime/engine";

// M5-L1 timer boundaries on scopes (Task 11, spec §5.3-§5.4, Hazard-vs-Cancel): a
// timer boundary on a transaction/subProcess INTERRUPTS WITHOUT COMPENSATION — the
// ledger rows of completed compensatable steps are RETAINED (pending), the token
// exits on the boundary path, and a later operator /cancel (root = process) drives
// the retained rows through the reverse pass. This mirrors the M3 boundary-timer
// harness (`tests/integration/boundary-timer.test.ts`): force the armed timer
// overdue, then fire its DO alarm directly (the test stand-in for the deadline
// elapsing) via runDurableObjectAlarm.

function timerStub(timerId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`timer:${timerId}`));
}

async function theTimer(instanceId: string): Promise<any> {
  return env.DB.prepare(`SELECT * FROM timers WHERE instance_id = ? ORDER BY created_at LIMIT 1`).bind(instanceId).first<any>();
}

async function timerOutcome(timerId: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT outcome FROM timer_outcomes WHERE timer_id = ?`).bind(timerId).first<{ outcome: string }>();
  return r?.outcome ?? null;
}

/** Force the armed scope-hosted timer overdue, then fire its DO alarm. */
async function fireDueBoundaryTimer(instanceId: string): Promise<string> {
  const t = await theTimer(instanceId);
  await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(t.timer_id).run();
  const ran = await runDurableObjectAlarm(timerStub(t.timer_id));
  expect(ran).toBe(true);
  return t.timer_id;
}

async function getInstanceRow(instanceId: string) {
  return env.DB.prepare(`SELECT status, current_element_id FROM process_instances WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ status: string; current_element_id: string | null }>();
}

/** element_id → compensation_status (one row per element; fixture has no loops). */
async function ledgerByElement(instanceId: string): Promise<Record<string, string>> {
  const res = await env.DB.prepare(`SELECT element_id, compensation_status FROM saga_steps WHERE instance_id = ? ORDER BY seq`)
    .bind(instanceId)
    .all<{ element_id: string; compensation_status: string }>();
  const out: Record<string, string> = {};
  for (const r of res.results ?? []) out[r.element_id] = r.compensation_status;
  return out;
}

async function countJobs(instanceId: string, taskType: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND task_type = ?`)
    .bind(instanceId, taskType)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

describe("M5-L1 timer boundary on a transaction (spec §5.3-§5.4)", () => {
  it("[S-TX-TIMER-01] fire interrupts WITHOUT compensation; ledger retained; the timer path completes", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(TX_TIMER_BPMN, { correlationKey: `tx-timer-1-${crypto.randomUUID()}`, variables: {} });
    const instanceId = instance.body.instanceId as string;

    await leaseAndComplete(token, "stepA", {}); // A ledgered pending (scope TX)
    expect((await getInstanceRow(instanceId))!.current_element_id).toBe("waitMsg");

    await fireDueBoundaryTimer(instanceId);

    // token exited on the boundary path — NO compensation job exists.
    expect(await countJobs(instanceId, "undoA")).toBe(0);
    const ledger = await ledgerByElement(instanceId);
    expect(ledger["A"]).toBe("pending"); // retained (Hazard-class exit), not compensated

    expect((await getInstanceRow(instanceId))!.current_element_id).toBe("afterTimer");
    const hist = await get(`/instances/${instanceId}/history`);
    expect(hist.body.events.some((e: any) => e.type === "timerFired")).toBe(true);
    expect(hist.body.events.some((e: any) => e.type === "scopeExited" && e.elementId === "TX")).toBe(true);

    await leaseAndComplete(token, "afterTimer", {});
    expect((await getInstanceRow(instanceId))!.status).toBe("completed");
    // NOTE: the instance completed with a RETAINED uncompensated row — /cancel is
    // only available pre-terminal, so the operator-cancel scenario is a SEPARATE
    // run (below) that never completes afterTimer.
  });

  it("[S-TX-TIMER-01] operator /cancel after the timer exit drives the retained rows through compensation", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(TX_TIMER_BPMN, { correlationKey: `tx-timer-2-${crypto.randomUUID()}`, variables: {} });
    const instanceId = instance.body.instanceId as string;

    await leaseAndComplete(token, "stepA", {});
    await fireDueBoundaryTimer(instanceId);
    expect((await ledgerByElement(instanceId))["A"]).toBe("pending");

    const cancel = await post(`/instances/${instanceId}/cancel`, {});
    expect(cancel.status).toBe(200);
    await resumeInline(env, instanceId);

    const compensating = await getInstanceRow(instanceId);
    expect(compensating!.status).toBe("compensating");

    await leaseAndComplete(token, "undoA", {});
    expect((await getInstanceRow(instanceId))!.status).toBe("compensated");
    expect((await ledgerByElement(instanceId))["A"]).toBe("compensated");
  });

  it("normal commit (message resolves the wait) disarms the timer — no late fire", async () => {
    const token = await mintWorkerToken();
    const correlationKey = `tx-timer-3-${crypto.randomUUID()}`;
    const { instance } = await publishAndStart(TX_TIMER_BPMN, { correlationKey, variables: {} });
    const instanceId = instance.body.instanceId as string;

    await leaseAndComplete(token, "stepA", {});
    const t = await theTimer(instanceId);
    expect(t.status).toBe("armed");

    const pub = await publishMessage({ messageName: "m1", correlationKey, messageId: `msg-${crypto.randomUUID()}`, payload: {} });
    expect(pub.status).toBe(202);

    // waitMsg resolves → TX commits → the tx's own boundary timer is disarmed.
    expect(await timerOutcome(t.timer_id)).toBe("cancelled");
    expect((await getInstanceRow(instanceId))!.status).toBe("completed");

    // A stray/late alarm on the now-cancelled timer is a no-op (never routes to afterTimer).
    await runDurableObjectAlarm(timerStub(t.timer_id));
    expect((await getInstanceRow(instanceId))!.current_element_id).not.toBe("afterTimer");
    expect(await countJobs(instanceId, "afterTimer")).toBe(0);
  });

  // TASK-72 (M5-L1 follow-up, PR #4 review finding #3): the timer-fired drain of
  // TX must release waitMsg's still-active message subscription — both the D1 row
  // (superseded, not left `active`) and the correlation-broker key (best-effort,
  // freed rather than left to the 1-hour buffered-message TTL).
  it("[TASK-72] timer-fired drain of TX releases waitMsg's active subscription and frees its broker key", async () => {
    const token = await mintWorkerToken();
    const correlationKey = `tx-timer-4-${crypto.randomUUID()}`;
    const { instance } = await publishAndStart(TX_TIMER_BPMN, { correlationKey, variables: {} });
    const instanceId = instance.body.instanceId as string;

    await leaseAndComplete(token, "stepA", {});
    expect((await getInstanceRow(instanceId))!.current_element_id).toBe("waitMsg");

    const before = await env.DB.prepare(
      `SELECT status FROM message_subscriptions WHERE instance_id = ? AND element_id = 'waitMsg' ORDER BY rowid DESC LIMIT 1`,
    )
      .bind(instanceId)
      .first<{ status: string }>();
    expect(before?.status).toBe("active");

    await fireDueBoundaryTimer(instanceId);

    // D1: the drain superseded waitMsg's subscription — it is no longer active.
    const after = await env.DB.prepare(
      `SELECT status FROM message_subscriptions WHERE instance_id = ? AND element_id = 'waitMsg' ORDER BY rowid DESC LIMIT 1`,
    )
      .bind(instanceId)
      .first<{ status: string }>();
    expect(after?.status).toBe("superseded");

    // Broker: the key was freed, not left registered — a late publish no longer
    // correlates to a live wait; it gets buffered (awaiting a NEW subscription
    // within the TTL) rather than delivered to the (already-drained) instance.
    const pub = await publishMessage({ messageName: "m1", correlationKey, messageId: `msg-${crypto.randomUUID()}`, payload: {} });
    expect(pub.status).toBe(202);
    expect(pub.body.outcome).toBe("buffered");
  });
});
