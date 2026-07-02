import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  NESTED_SCOPE_TIMER_DRAIN_BPMN,
  authedPost,
  leaseOne,
  mintWorkerToken,
  publishAndStart,
} from "../helpers";

// M5-L1 Task 11 REVIEW-FIX: a nested scope-hosted boundary timer must be disarmed
// when an ANCESTOR scope is drained (spec §5.3-§5.4, code-review finding). Scenario:
// transaction T (with its OWN boundary timer) nested in subProcess S; a business
// error thrown INSIDE T bubbles past T (no catch) to S's error boundary, so
// drainScopeSubtree(S) discards T's live token. Before the fix, T's timer stayed
// `armed` and a later overdue alarm FIRED — writing T's scopeExited + a BACKWARD
// transition into the already-drained S (afterT), corrupting a running instance.
// After the fix: (1) the drain settles T's armed timer `cancelled`; (2) even if the
// timer races the drain window, planBoundaryTimerFire's ancestor-exit guard no-ops
// the fire (no backward transition).

function timerStub(timerId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`timer:${timerId}`));
}

/** The transaction T's boundary timer row (only timer in the fixture). */
async function tTimer(instanceId: string): Promise<any> {
  return env.DB.prepare(`SELECT * FROM timers WHERE instance_id = ? AND attached_to_ref = 'T' LIMIT 1`)
    .bind(instanceId)
    .first<any>();
}

async function timerOutcome(timerId: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT outcome FROM timer_outcomes WHERE timer_id = ?`).bind(timerId).first<{ outcome: string }>();
  return r?.outcome ?? null;
}

async function getInstanceRow(instanceId: string) {
  return env.DB.prepare(`SELECT status, current_element_id FROM process_instances WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ status: string; current_element_id: string | null }>();
}

async function countHistory(instanceId: string, type: string, elementId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM history_events WHERE instance_id = ? AND type = ? AND element_id = ?`)
    .bind(instanceId, type, elementId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function countJobs(instanceId: string, taskType: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND task_type = ?`)
    .bind(instanceId, taskType)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** `/jobs/activate` leases FIFO by taskType only (instance-blind); flush stray jobs first. */
async function flushStrayJobs(token: string, taskTypes: string[]): Promise<void> {
  for (const taskType of taskTypes) {
    for (let guard = 0; guard < 20; guard++) {
      const r = await authedPost<{ jobs: { jobId: string; lockToken: string }[] }>("/jobs/activate", token, { taskType, workerId: "flush" });
      const jobs = r.body.jobs ?? [];
      if (jobs.length === 0) break;
      for (const job of jobs) await authedPost(`/jobs/${job.jobId}/complete`, token, { lockToken: job.lockToken, outputVariables: {} });
    }
  }
}

/** Enter S → T (arm T_timer) → failA; business-fail failA so the error bubbles to S. */
async function driveToDrain(token: string): Promise<{ instanceId: string; timerId: string }> {
  await flushStrayJobs(token, ["nstFail", "nstAfter", "nstRecover"]);
  const { instance } = await publishAndStart(NESTED_SCOPE_TIMER_DRAIN_BPMN, {
    correlationKey: `nst-${crypto.randomUUID()}`,
    variables: {},
  });
  const instanceId = instance.body.instanceId as string;

  // failA is inside T (transaction, own timer armed at entry). Business-fail it →
  // the error climbs failA → T (no catch) → S (caught) → drainScopeSubtree(S).
  const job = await leaseOne(token, "nstFail");
  const res = await authedPost(`/jobs/${job.jobId}/fail`, token, {
    lockToken: job.lockToken,
    reason: "boom",
    errorCode: "BIZ",
    retryable: false,
  });
  expect(res.status).toBe(200);

  const t = await tTimer(instanceId);
  expect(t).toBeTruthy();
  // S caught → recover job is the live wait; the instance is parked (non-terminal).
  const inst = await getInstanceRow(instanceId);
  expect(inst!.status).toBe("waiting");
  expect(inst!.current_element_id).toBe("recover");
  return { instanceId, timerId: t.timer_id };
}

describe("M5-L1 nested scope timer disarm under ancestor drain (Task 11 review-fix)", () => {
  it("the drain settles T's armed timer; a later overdue alarm never routes backward", async () => {
    const token = await mintWorkerToken();
    const { instanceId, timerId } = await driveToDrain(token);

    // (1) The ancestor's drain settled T's own boundary timer `cancelled`.
    expect(await timerOutcome(timerId)).toBe("cancelled");
    // The drain does NOT synthesize a scopeExited for the passed-through T.
    expect(await countHistory(instanceId, "scopeExited", "T")).toBe(0);
    // S was audited exactly once (no duplicate abnormal-exit marker).
    expect(await countHistory(instanceId, "scopeExited", "S")).toBe(1);

    // Force T's timer overdue and fire its DO alarm — a decided `cancelled` timer no-ops.
    await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(timerId).run();
    await runDurableObjectAlarm(timerStub(timerId));

    // No BACKWARD transition into the drained S: still on the post-catch path.
    expect((await getInstanceRow(instanceId))!.current_element_id).toBe("recover");
    expect(await countHistory(instanceId, "timerFired", "T_timer")).toBe(0);
    expect(await countJobs(instanceId, "nstAfter")).toBe(0);
    // Still exactly one scopeExited for S; none newly minted for T by the stray alarm.
    expect(await countHistory(instanceId, "scopeExited", "T")).toBe(0);
  });

  it("guard hardening: a timer that races the drain window is no-oped by the ancestor-exit guard", async () => {
    const token = await mintWorkerToken();
    const { instanceId, timerId } = await driveToDrain(token);

    // Simulate the window where the descendant timer fires BEFORE the drain's settle
    // ran: re-arm T's timer and drop its decider row, so ONLY the fire-path guard can
    // stop it (isolating fix (2) from fix (1)).
    await env.DB.prepare(`UPDATE timers SET status = 'armed', fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(timerId).run();
    await env.DB.prepare(`DELETE FROM timer_outcomes WHERE timer_id = ?`).bind(timerId).run();

    await runDurableObjectAlarm(timerStub(timerId));

    // planBoundaryTimerFire's ancestor-exit guard sees S exited after T entered → skip.
    expect((await getInstanceRow(instanceId))!.current_element_id).toBe("recover");
    expect(await countHistory(instanceId, "timerFired", "T_timer")).toBe(0);
    expect(await countJobs(instanceId, "nstAfter")).toBe(0);
    expect(await countHistory(instanceId, "scopeExited", "T")).toBe(0);
  });
});
