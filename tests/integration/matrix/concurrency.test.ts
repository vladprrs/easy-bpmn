import { describe, it, expect } from "vitest";
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { publishAndStart, get, mintWorkerToken, leaseOne, authedPost, publishMessage } from "../../helpers";
import {
  PARALLEL_3ASYM_BPMN,
  PARALLEL_BRANCH_TIMER_BPMN,
  OR_NEST_AND_BPMN,
  PARALLEL_BRANCH_ITIMER_BPMN,
} from "../../fixtures/matrix/fixtures";
import { listTokens } from "../../../src/persistence/tokens";
import { getGatewayDecision } from "../../../src/persistence/gateway-decisions";

// Direct-mode characterization of the M4 concurrency corners (Phase-1 matrix,
// Tasks 3.2/3.3). M4 (L1-L6) is shipped+green, so each of these SHOULD pass.
//
// These fixtures use CUSTOM service-task types with NO registered sample worker
// (see tests/fixtures/matrix/fixtures.ts header), so every task is driven over
// the pull data plane with leaseOne + complete — never drainSampleWorkers.

const complete = (
  t: string,
  j: { jobId: string; lockToken: string },
  out: Record<string, unknown> = {},
) => authedPost(`/jobs/${j.jobId}/complete`, t, { lockToken: j.lockToken, outputVariables: out });

const liveTokens = (rows: Array<{ status: string }>) =>
  rows.filter((r) => ["active", "waiting", "arrivedAtJoin"].includes(r.status));

// ---- timer firing (copied verbatim from boundary-timer.test.ts /
//      intermediate-timer.test.ts: the DO-alarm fire mechanism in direct mode) ----
function timerStub(timerId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`timer:${timerId}`));
}
async function theTimer(instanceId: string): Promise<any> {
  return env.DB.prepare(`SELECT * FROM timers WHERE instance_id = ? ORDER BY created_at LIMIT 1`)
    .bind(instanceId)
    .first<any>();
}
async function timerOutcome(timerId: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT outcome FROM timer_outcomes WHERE timer_id = ?`)
    .bind(timerId)
    .first<{ outcome: string }>();
  return r?.outcome ?? null;
}
/** Force the armed timer overdue, then fire its DO alarm (the deadline elapsing stand-in). */
async function fireTimerNow(instanceId: string): Promise<string> {
  const t = await theTimer(instanceId);
  await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`)
    .bind(t.timer_id)
    .run();
  const ran = await runDurableObjectAlarm(timerStub(t.timer_id));
  expect(ran).toBe(true);
  return t.timer_id;
}
async function joinCompletionCount(instanceId: string, joinId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM join_completions WHERE instance_id = ? AND join_id = ?`,
  )
    .bind(instanceId, joinId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}
const historyLen = async (id: string) => ((await get(`/instances/${id}/history`)).body.events as any[]).length;

describe("matrix: concurrency corners (direct mode)", () => {
  it("[C-AND-3ASYM-01] short branches park at the join until the long branch drains (last-token-out)", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_3ASYM_BPMN, { correlationKey: "asym1", variables: {} });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Branch A: one short service task.
    await complete(token, await leaseOne(token, "asym-a"), { a: 1 });
    // Branch C: a receive task satisfied by message "Mc" (correlationKey == start key).
    const pub = await publishMessage({ messageName: "Mc", correlationKey: "asym1", messageId: "mc-1", payload: { c: 1 } });
    expect(pub.status).toBe(202); // POST /messages is accepted-async (openapi: 202)

    // A (arrived) + C (arrived) but branch B is mid-chain → the AND join is NOT satisfied.
    let inst = await get(`/instances/${id}`);
    expect(inst.body.status).not.toBe("completed");

    await complete(token, await leaseOne(token, "asym-b1"), { b1: 1 });
    inst = await get(`/instances/${id}`);
    expect(inst.body.status).not.toBe("completed"); // still last-token-out (B2, B3 pending)

    await complete(token, await leaseOne(token, "asym-b2"), { b2: 1 });
    await complete(token, await leaseOne(token, "asym-b3"), { b3: 1 });
    // The last branch token in fires the join → the post-join task becomes leasable.
    await complete(token, await leaseOne(token, "asym-post"), {});

    inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    // Every branch's output (and the message payload) is merged into root variables.
    expect(inst.body.variables).toMatchObject({ a: 1, c: 1, b1: 1, b2: 1, b3: 1 });
    // Frontier empty: no token left live/waiting/arrivedAtJoin.
    expect(liveTokens(await listTokens(env.DB, id))).toHaveLength(0);
  });

  it("[C-AND-BTIMER-01] interrupting boundary timer wins on a branch — sibling continues, join waits for the redirect", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_BRANCH_TIMER_BPMN, { correlationKey: "bt1", variables: {} });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // The bt_timer boundary on bt-a arms at fan-out. Fire it BEFORE bt-a completes
    // (mechanism: fireTimerNow — fire_at rewind + runDurableObjectAlarm, the DO-alarm
    // fire path from boundary-timer.test.ts).
    const timerId = await fireTimerNow(id);
    expect(await timerOutcome(timerId)).toBe("fired");

    // The interrupting timer cancelled bt-a's open job — it is no longer leasable.
    const noBtA = await authedPost("/jobs/activate", token, { taskType: "bt-a", workerId: "w" });
    expect(noBtA.body.jobs).toHaveLength(0);

    // The branch followed the redirect to bt-alt (in-region). Complete it → arrives at the join.
    await complete(token, await leaseOne(token, "bt-alt"), { alt: 1 });
    let inst = await get(`/instances/${id}`);
    expect(inst.body.status).not.toBe("completed"); // join still waits for sibling B

    // Sibling bt-b is unaffected; complete it → the join now fires (redirected-A + B).
    await complete(token, await leaseOne(token, "bt-b"), { b: 1 });
    await complete(token, await leaseOne(token, "bt-post"), {});

    inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.variables).toMatchObject({ alt: 1, b: 1 });
    expect(liveTokens(await listTokens(env.DB, id))).toHaveLength(0);
  });

  it("[C-AND-BTIMER-02] boundary timer loses — job completes first; the late (and duplicate) alarm is a no-op", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_BRANCH_TIMER_BPMN, { correlationKey: "bt2", variables: {} });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Complete bt-a PROMPTLY (normal path svcA→Xa→join) → the boundary timer is cancelled
    // by the completion.
    await complete(token, await leaseOne(token, "bt-a"), { a: 1 });
    const timer = await theTimer(id);
    expect(timer.status).toBe("cancelled");
    expect(await timerOutcome(timer.timer_id)).toBe("cancelled");

    // The redirect target bt-alt was NEVER taken.
    expect((await authedPost("/jobs/activate", token, { taskType: "bt-alt", workerId: "w" })).body.jobs).toHaveLength(0);

    // The late bt_timer alarm — fired AND duplicate-fired — is an idempotent no-op:
    // no new history, no re-route.
    const before = await historyLen(id);
    await runDurableObjectAlarm(timerStub(timer.timer_id));
    await runDurableObjectAlarm(timerStub(timer.timer_id));
    expect(await historyLen(id)).toBe(before);
    expect((await authedPost("/jobs/activate", token, { taskType: "bt-alt", workerId: "w" })).body.jobs).toHaveLength(0);

    // Sibling B completes; the join fires exactly once.
    await complete(token, await leaseOne(token, "bt-b"), { b: 1 });
    await complete(token, await leaseOne(token, "bt-post"), {});

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(await joinCompletionCount(id, "join")).toBe(1);
    expect(liveTokens(await listTokens(env.DB, id))).toHaveLength(0);
  });

  it("[C-OR-NESTAND-01] OR-split branch containing a nested AND fork/join", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(OR_NEST_AND_BPMN, {
      correlationKey: "or1",
      variables: { useParallel: true, useSingle: true },
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // The OR split activated exactly b1 (nested AND) + b2 — NOT the default on-log.
    const dec = await getGatewayDecision(env.DB, id, "orFork", 0);
    expect((dec?.activatedFlowIds ?? []).sort()).toEqual(["f_inner", "f_single"]);
    expect(dec?.isDefault).toBe(false);
    // The default branch was never forked → on-log has no job.
    expect((await authedPost("/jobs/activate", token, { taskType: "on-log", workerId: "w" })).body.jobs).toHaveLength(0);

    // Drive the nested AND (on-x | on-y), then the single OR-branch task (on-single).
    await complete(token, await leaseOne(token, "on-x"), { x: 1 });
    await complete(token, await leaseOne(token, "on-y"), { y: 1 });
    await complete(token, await leaseOne(token, "on-single"), { single: 1 });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    // Inner AND folds {x,y} onto branch b1; the OR join then merges b1 + b2 into root.
    expect(inst.body.variables).toMatchObject({ x: 1, y: 1, single: 1 });
    expect(liveTokens(await listTokens(env.DB, id))).toHaveLength(0);
  });

  it("[C-BRANCH-ITIMER-01] intermediate catch timer inside a parallel branch", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_BRANCH_ITIMER_BPMN, { correlationKey: "it1", variables: {} });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Branch A's first task completes → branch A parks at the intermediate catch timer.
    await complete(token, await leaseOne(token, "it-a"), { a: 1 });
    const timer = await theTimer(id);
    expect(timer.status).toBe("armed");
    expect(timer.kind).toBe("intermediateCatch");
    expect(timer.element_id).toBe("it_catch"); // armed timer keyed to the catch in branch A

    // Sibling B proceeds independently; the AND join must still wait for branch A.
    await complete(token, await leaseOne(token, "it-b"), { b: 1 });
    let inst = await get(`/instances/${id}`);
    expect(inst.body.status).not.toBe("completed");

    // Fire branch A's timer (mechanism: fireTimerNow, the intermediate-timer.test.ts path)
    // → branch A advances past the catch to it-a2.
    const timerId = await fireTimerNow(id);
    expect(await timerOutcome(timerId)).toBe("fired");
    await complete(token, await leaseOne(token, "it-a2"), { a2: 1 });

    inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.variables).toMatchObject({ a: 1, b: 1, a2: 1 });
    expect(liveTokens(await listTokens(env.DB, id))).toHaveLength(0);
  });
});
