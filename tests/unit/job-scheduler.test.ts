import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// JobScheduler one-shot scheduler DO (M3-L3 design §4.2, TASK-43). The existing
// per-job DLQ alarm is generalized to also fire model timers, dispatched by which
// MARKER the DO holds (JOB_KEY vs TIMER_KEY). These tests cover: arm/re-arm
// idempotency, a stray alarm against an already-decided timer no-ops + the
// unconditional one-shot storage cleanup, the marker-keying-cannot-collide
// invariant, and marker dispatch (timer → fireTimer, job → terminateUnleasableJob).

import { createInstance } from "../../src/persistence/instances";
import { insertTimerArmedStmt, insertTimerOutcomeStmt } from "../../src/persistence/timers";

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE_1 = "2099-01-01T00:00:00.000Z";
const FUTURE_2 = "2099-06-01T00:00:00.000Z";
const NOW = "2026-06-12T00:00:00.000Z";

// The DO's private storage marker keys (job-scheduler.ts).
const JOB_KEY = "jobId";
const TIMER_KEY = "timerId";

function timerStub(timerId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`timer:${timerId}`));
}
function jobStub(jobId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(jobId));
}

function armTimerRow(timerId: string, instanceId: string, fireAt: string) {
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

describe("JobScheduler — one-shot scheduler DO (TASK-43)", () => {
  it("armTimer is idempotent: re-arm updates the alarm and keeps a SINGLE timer marker", async () => {
    const stub = timerStub("T_rearm");
    await stub.armTimer("T_rearm", FUTURE_1);
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get(TIMER_KEY)).toBe("T_rearm");
      expect(await state.storage.get(JOB_KEY)).toBeUndefined();
      expect(await state.storage.getAlarm()).toBe(new Date(FUTURE_1).getTime());
    });

    await stub.armTimer("T_rearm", FUTURE_2); // re-park (rewalk self-heal arm)
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get(TIMER_KEY)).toBe("T_rearm"); // still ONE marker
      expect(await state.storage.getAlarm()).toBe(new Date(FUTURE_2).getTime()); // updated
    });
  });

  it("a stray alarm against an already-decided timer no-ops and clears storage one-shot", async () => {
    // Decided: armed row + a recorded timer_outcomes decision → fireTimer no-ops.
    await armTimerRow("T_decided", "pi_decided", PAST);
    await insertTimerOutcomeStmt(env.DB, { timerId: "T_decided", outcome: "fired", now: NOW }).run();

    const stub = timerStub("T_decided");
    // Arm the DO alarm in the FUTURE so it does not auto-fire in the background;
    // runDurableObjectAlarm forces it. (The timer ROW's fire_at governs due-ness,
    // independent of the DO alarm clock.)
    await stub.armTimer("T_decided", FUTURE_1);

    // The alarm fires, fireTimer no-ops (decided), and storage is dropped one-shot.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get(TIMER_KEY)).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    // A second alarm has nothing scheduled — inert after firing.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("job vs timer markers cannot collide — even keyed off the same underlying id string", async () => {
    // Callers prefix timer DOs with `timer:`, so the same id string yields two
    // DISTINCT DO instances; and within a DO the markers use distinct keys.
    expect(jobStub("X").id.toString()).not.toBe(timerStub("X").id.toString());

    const jStub = jobStub("X");
    await jStub.arm("X", FUTURE_1);
    await runInDurableObject(jStub, async (_i, state) => {
      expect(await state.storage.get(JOB_KEY)).toBe("X");
      expect(await state.storage.get(TIMER_KEY)).toBeUndefined(); // no timer marker leaks in
    });

    const tStub = timerStub("X");
    await tStub.armTimer("X", FUTURE_1);
    await runInDurableObject(tStub, async (_i, state) => {
      expect(await state.storage.get(TIMER_KEY)).toBe("X");
      expect(await state.storage.get(JOB_KEY)).toBeUndefined(); // no job marker leaks in
    });
  });

  it("dispatches by marker: a timer marker → fireTimer; a job marker → terminateUnleasableJob", async () => {
    // A FIRE-ELIGIBLE timer row keyed "M" exists (armed, due, undecided, live
    // instance). fireTimer would hit the TASK-44 seam and THROW; terminateUnleasableJob
    // no-ops on a missing job. So the dispatch target is unambiguous from the outcome.
    await makeInstance("pi_dispatch", "waiting");
    await armTimerRow("M", "pi_dispatch", PAST);

    // Timer marker → fireTimer → the eligible seam throws. The DO alarm is armed
    // in the future (no background auto-fire); runDurableObjectAlarm forces it.
    const tStub = timerStub("M");
    await tStub.armTimer("M", FUTURE_1);
    await expect(runDurableObjectAlarm(tStub)).rejects.toThrow(/TASK-44/);
    // The throw must skip the one-shot `deleteAll()`, leaving the marker intact so
    // the timer is re-dispatchable when the platform RE-DELIVERS the alarm (workerd
    // auto-reschedules an alarm whose handler threw — that reschedule is runtime
    // behavior `runDurableObjectAlarm` does not model, so we assert the property we
    // CAN observe: the marker survived = `deleteAll()` was skipped). A
    // `try/finally { deleteAll() }` around dispatch would silently break this.
    await runInDurableObject(tStub, async (_i, state) => {
      expect(await state.storage.get(TIMER_KEY)).toBe("M");
    });

    // Job marker with the SAME underlying id "M" → terminateUnleasableJob (no job
    // row "M" exists) → clean no-op. Had it mis-dispatched to fireTimer, the
    // eligible timer row "M" would have made it throw.
    const jStub = jobStub("M");
    await jStub.arm("M", FUTURE_1);
    expect(await runDurableObjectAlarm(jStub)).toBe(true); // ran, no throw
  });
});
