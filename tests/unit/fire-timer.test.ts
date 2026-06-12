import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// fireTimer GUARD/NO-OP gate (M3-L3 design §4.3). fireTimer re-reads D1 and returns
// WITHOUT writing whenever firing would be wrong (missing / already-settled /
// not-yet-due / terminal / no resolvable host). The WINNING fire — claim + transition
// + wake — is exercised end-to-end against real graphs in the boundary-timer
// integration suite (TASK-44); these unit tests pin the guard chain in isolation.

import { createInstance } from "../../src/persistence/instances";
import {
  getTimer,
  getTimerOutcome,
  insertTimerArmedStmt,
  insertTimerOutcomeStmt,
  flipTimerFiredStmt,
  timerIdFor,
} from "../../src/persistence/timers";
import { fireTimer } from "../../src/runtime/timers";

const PAST = "2000-01-01T00:00:00.000Z"; // always <= now → "due"
const FUTURE = "2099-01-01T00:00:00.000Z"; // always > now → "not yet due"
const NOW = "2026-06-12T00:00:00.000Z";

function arm(timerId: string, instanceId: string, fireAt: string) {
  return insertTimerArmedStmt(env.DB, {
    timerId,
    instanceId,
    elementId: "Timer_boundary",
    occurrence: 0,
    kind: "boundary",
    attachedToRef: "Task_check",
    fireAt,
    now: NOW,
  }).run();
}

async function makeInstance(instanceId: string, status: string) {
  await createInstance(env.DB, {
    instanceId,
    workspaceId: "ws",
    definitionVersionId: "ver_1",
    workflowInstanceId: instanceId,
    correlationKey: "c",
    startElementId: "Start",
    variables: {},
    now: NOW,
  });
  if (status !== "starting") {
    await env.DB.prepare(`UPDATE process_instances SET status = ? WHERE instance_id = ?`)
      .bind(status, instanceId).run();
  }
}

describe("fireTimer — guard/no-op paths (TASK-43)", () => {
  it("no-ops on a missing timer row (stray/late alarm)", async () => {
    await expect(fireTimer(env, "pi_missing:Nope#0")).resolves.toBeUndefined();
  });

  it("no-ops when the timer is not armed (already fired) — writes nothing", async () => {
    const id = timerIdFor("pi_fired", "Timer_boundary", 0);
    await makeInstance("pi_fired", "running");
    await arm(id, "pi_fired", PAST);
    await flipTimerFiredStmt(env.DB, { timerId: id, firedAt: NOW, now: NOW }).run();

    await expect(fireTimer(env, id)).resolves.toBeUndefined();
    expect((await getTimer(env.DB, id))?.status).toBe("fired"); // untouched
    expect(await getTimerOutcome(env.DB, id)).toBeNull(); // fireTimer wrote no decider
  });

  it("no-ops when a timer_outcomes decision already exists (even if status still armed)", async () => {
    const id = timerIdFor("pi_decided", "Timer_boundary", 0);
    await makeInstance("pi_decided", "running");
    await arm(id, "pi_decided", PAST);
    // A decider row WITHOUT the bookkeeping flip — exercises the explicit
    // getTimerOutcome guard (the decider, not the status, is the source of truth).
    await insertTimerOutcomeStmt(env.DB, { timerId: id, outcome: "cancelled", now: NOW }).run();

    await expect(fireTimer(env, id)).resolves.toBeUndefined();
    expect((await getTimer(env.DB, id))?.status).toBe("armed"); // fireTimer did NOT flip it
  });

  it("no-ops when the timer is not yet due (fire_at in the future)", async () => {
    const id = timerIdFor("pi_early", "Timer_boundary", 0);
    await makeInstance("pi_early", "running");
    await arm(id, "pi_early", FUTURE);

    await expect(fireTimer(env, id)).resolves.toBeUndefined();
    expect(await getTimerOutcome(env.DB, id)).toBeNull();
  });

  it("no-ops on a terminal instance (a fired timer must not reanimate a settled run)", async () => {
    const id = timerIdFor("pi_terminal", "Timer_boundary", 0);
    await makeInstance("pi_terminal", "cancelled");
    await arm(id, "pi_terminal", PAST); // due, armed, undecided — only the instance gates it

    await expect(fireTimer(env, id)).resolves.toBeUndefined();
    expect(await getTimerOutcome(env.DB, id)).toBeNull();
  });

  it("no-ops when the instance row is missing (defensive)", async () => {
    const id = timerIdFor("pi_noinst", "Timer_boundary", 0);
    await arm(id, "pi_noinst", PAST); // due, armed, undecided, but no instance row

    await expect(fireTimer(env, id)).resolves.toBeUndefined();
    expect(await getTimerOutcome(env.DB, id)).toBeNull();
  });

  it("no-ops when the definition graph cannot be resolved (defensive — needs a real host)", async () => {
    // Past every guard (armed, due, undecided, live instance) but the synthetic
    // instance points at a non-existent definition version, so fireBoundaryTimer
    // finds no graph/host to transition — a defensive no-op (no decider written).
    // The genuine winning fire is covered against real graphs in the integration
    // suite (boundary-timer.test.ts gates 1-6, 10).
    const id = timerIdFor("pi_eligible", "Timer_boundary", 0);
    await makeInstance("pi_eligible", "waiting"); // non-terminal, definitionVersionId 'ver_1' (no graph)
    await arm(id, "pi_eligible", PAST); // due, armed, undecided

    await expect(fireTimer(env, id)).resolves.toBeUndefined();
    expect(await getTimerOutcome(env.DB, id)).toBeNull(); // no graph → no claim written
    expect((await getTimer(env.DB, id))?.status).toBe("armed");
  });
});
