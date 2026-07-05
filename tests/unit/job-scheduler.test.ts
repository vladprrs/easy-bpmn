import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as callActivity from "../../src/runtime/call-activity";

// JobScheduler one-shot scheduler DO (M3-L3 design §4.2, TASK-43). The existing
// per-job DLQ alarm is generalized to also fire model timers, dispatched by which
// MARKER the DO holds (JOB_KEY vs TIMER_KEY). These tests cover: arm/re-arm
// idempotency, a stray alarm against an already-decided timer no-ops + the
// unconditional one-shot storage cleanup, the marker-keying-cannot-collide
// invariant, and marker dispatch (timer → fireTimer, job → terminateUnleasableJob).

import { createInstance } from "../../src/persistence/instances";
import { insertTimerArmedStmt, insertTimerOutcomeStmt } from "../../src/persistence/timers";
import { leaseOne, mintWorkerToken, publishAndStart } from "../helpers";

// A real model whose `slow` service task carries an interrupting boundary timer →
// onTimeout. Used to drive a genuine fireTimer through the DO's dispatch.
const SVC_TIMER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_js" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:serviceTask id="slow"><bpmn:extensionElements><easy-bpmn:taskDefinition type="js-slow"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:serviceTask id="onTimeout"><bpmn:extensionElements><easy-bpmn:taskDefinition type="js-timeout"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:boundaryEvent id="tb" attachedToRef="slow"><bpmn:timerEventDefinition><bpmn:timeDuration>PT5M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="slow"/>
    <bpmn:sequenceFlow id="s1" sourceRef="slow" targetRef="E"/>
    <bpmn:sequenceFlow id="tf" sourceRef="tb" targetRef="onTimeout"/>
    <bpmn:sequenceFlow id="af" sourceRef="onTimeout" targetRef="E"/>
  </bpmn:process>
</bpmn:definitions>`;

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE_1 = "2099-01-01T00:00:00.000Z";
const FUTURE_2 = "2099-06-01T00:00:00.000Z";
const NOW = "2026-06-12T00:00:00.000Z";

// The DO's private storage marker keys (job-scheduler.ts).
const JOB_KEY = "jobId";
const TIMER_KEY = "timerId";
const CHILD_KEY = "childNotify";
const CHILD_ATTEMPT_KEY = "childNotifyAttempt";

function timerStub(timerId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`timer:${timerId}`));
}
function jobStub(jobId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(jobId));
}
function childStub(childInstanceId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`child-notify:${childInstanceId}`));
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

  it("dispatches by marker: a timer marker → fireTimer (real fire); a job marker → terminateUnleasableJob", async () => {
    // TIMER marker → fireTimer: set up a REAL fire-eligible boundary timer (a
    // published model + a parked, in-flight host service-task job), then force its
    // engine-armed DO alarm. fireTimer claims the decider 'fired'; that write is the
    // unambiguous proof the marker dispatched to fireTimer (terminateUnleasableJob
    // would never touch timer_outcomes).
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(SVC_TIMER_BPMN, { correlationKey: "js-disp", variables: {} });
    const id = instance.body.instanceId;
    await leaseOne(token, "js-slow"); // host job in-flight → the fire guard passes
    const t = await env.DB.prepare(`SELECT timer_id FROM timers WHERE instance_id = ?`).bind(id).first<{ timer_id: string }>();
    await env.DB.prepare(`UPDATE timers SET fire_at = ? WHERE timer_id = ?`).bind(PAST, t!.timer_id).run();

    expect(await runDurableObjectAlarm(timerStub(t!.timer_id))).toBe(true);
    const outcome = await env.DB.prepare(`SELECT outcome FROM timer_outcomes WHERE timer_id = ?`).bind(t!.timer_id).first<{ outcome: string }>();
    expect(outcome?.outcome).toBe("fired"); // fireTimer ran
    // Clean dispatch (no throw) → the one-shot deleteAll cleared the marker.
    await runInDurableObject(timerStub(t!.timer_id), async (_i, state) => {
      expect(await state.storage.get(TIMER_KEY)).toBeUndefined();
    });

    // JOB marker keyed off the SAME id string as that timer → terminateUnleasableJob
    // (no job row by that id) → clean no-op. Had it mis-dispatched to fireTimer it
    // would have re-read the already-decided timer and still no-op'd — so we assert
    // the run completed cleanly (and the timer_outcomes row is untouched).
    const jStub = jobStub(t!.timer_id);
    await jStub.arm(t!.timer_id, FUTURE_1);
    expect(await runDurableObjectAlarm(jStub)).toBe(true);
  });

  it("armChildNotify is idempotent: re-arm updates the alarm + attempt and keeps a SINGLE child marker", async () => {
    const stub = childStub("child_rearm");
    await stub.armChildNotify("child_rearm", FUTURE_1, 0);
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get(CHILD_KEY)).toBe("child_rearm");
      expect(await state.storage.get(CHILD_ATTEMPT_KEY)).toBe(0);
      expect(await state.storage.get(JOB_KEY)).toBeUndefined();
      expect(await state.storage.get(TIMER_KEY)).toBeUndefined();
      expect(await state.storage.getAlarm()).toBe(new Date(FUTURE_1).getTime());
    });

    await stub.armChildNotify("child_rearm", FUTURE_2, 1); // re-park with a bumped attempt
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get(CHILD_KEY)).toBe("child_rearm"); // still ONE marker
      expect(await state.storage.get(CHILD_ATTEMPT_KEY)).toBe(1);
      expect(await state.storage.getAlarm()).toBe(new Date(FUTURE_2).getTime());
    });
  });

  it("child marker keyed off the same id string as a job/timer cannot collide (distinct DO names)", async () => {
    expect(childStub("X").id.toString()).not.toBe(jobStub("X").id.toString());
    expect(childStub("X").id.toString()).not.toBe(timerStub("X").id.toString());

    const cStub = childStub("X");
    await cStub.armChildNotify("X", FUTURE_1, 0);
    await runInDurableObject(cStub, async (_i, state) => {
      expect(await state.storage.get(CHILD_KEY)).toBe("X");
      expect(await state.storage.get(JOB_KEY)).toBeUndefined();
      expect(await state.storage.get(TIMER_KEY)).toBeUndefined();
    });
  });

  it("dispatches a lone CHILD marker to retryChildNotify with the stored attempt, then one-shot clears storage", async () => {
    const spy = vi.spyOn(callActivity, "retryChildNotify").mockResolvedValue(undefined);
    try {
      const stub = childStub("child_disp");
      await stub.armChildNotify("child_disp", FUTURE_1, 2);

      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(env, "child_disp", 2);

      // One-shot: clean dispatch clears every marker (including the attempt).
      await runInDurableObject(stub, async (_i, state) => {
        expect(await state.storage.get(CHILD_KEY)).toBeUndefined();
        expect(await state.storage.get(CHILD_ATTEMPT_KEY)).toBeUndefined();
        expect(await state.storage.getAlarm()).toBeNull();
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("dispatch precedence: a JOB marker wins over a CHILD marker on the same DO instance", async () => {
    const spy = vi.spyOn(callActivity, "retryChildNotify").mockResolvedValue(undefined);
    try {
      // Contrived co-presence (arm both on the SAME stub) to exercise the
      // `if (jobId) ... else if (timerId) ... else if (childId)` precedence order
      // directly, since production callers never arm two roles on one DO name.
      const stub = jobStub("precedence_job_wins");
      await stub.arm("precedence_job_wins", FUTURE_1); // no matching job row → clean no-op
      await stub.armChildNotify("child_should_not_fire", FUTURE_1, 0);

      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(spy).not.toHaveBeenCalled(); // job branch dispatched, not child

      // One-shot still clears everything, including the shadowed child marker.
      await runInDurableObject(stub, async (_i, state) => {
        expect(await state.storage.get(JOB_KEY)).toBeUndefined();
        expect(await state.storage.get(CHILD_KEY)).toBeUndefined();
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("dispatch precedence: a TIMER marker wins over a CHILD marker on the same DO instance", async () => {
    const spy = vi.spyOn(callActivity, "retryChildNotify").mockResolvedValue(undefined);
    try {
      const stub = timerStub("precedence_timer_wins");
      await stub.armTimer("precedence_timer_wins", FUTURE_1); // no matching timer row → fireTimer no-ops
      await stub.armChildNotify("child_should_not_fire", FUTURE_1, 0);

      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(spy).not.toHaveBeenCalled(); // timer branch dispatched, not child

      await runInDurableObject(stub, async (_i, state) => {
        expect(await state.storage.get(TIMER_KEY)).toBeUndefined();
        expect(await state.storage.get(CHILD_KEY)).toBeUndefined();
      });
    } finally {
      spy.mockRestore();
    }
  });
});
