import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  REENTRY_CANCEL_BPMN,
  authedPost,
  leaseAndComplete,
  mintWorkerToken,
  publishAndStart,
  reentryTimerBpmn,
} from "../helpers";

// TASK-71 (M5-L1 follow-up, PR #4 review): the walk-local `skippedScopes` runtime
// backstop. The C1 validator statically rejects UNGUARDED re-entry of an abnormally
// skipped scope, but a CONDITION-GUARDED loop-back is still publishable (the static
// BFS cannot prove a guarded edge unreachable). If hit at runtime, re-descending the
// skipped scope would restart its interior occurrence namespace and silently desync
// against the skipped occurrence's persisted rows. The engine populates a walk-local
// `skippedScopes` set on BOTH abnormal skips — the fired scope-timer exit and the
// nested cancelled-transaction continuation — on their live AND fast-forward paths,
// and raises a deterministic `scopeReentry` incident at scope descend instead.

function timerStub(timerId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`timer:${timerId}`));
}

/** Force the armed scope-hosted timer overdue, then fire its DO alarm (deadline stand-in). */
async function fireDueScopeTimer(instanceId: string): Promise<void> {
  const t = await env.DB.prepare(`SELECT * FROM timers WHERE instance_id = ? ORDER BY created_at LIMIT 1`)
    .bind(instanceId)
    .first<any>();
  await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(t.timer_id).run();
  const ran = await runDurableObjectAlarm(timerStub(t.timer_id));
  expect(ran).toBe(true);
}

async function getInstanceRow(instanceId: string) {
  return env.DB.prepare(`SELECT status, current_element_id FROM process_instances WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ status: string; current_element_id: string | null }>();
}

async function incidentOf(instanceId: string) {
  return env.DB.prepare(`SELECT kind, element_id FROM incidents WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ kind: string; element_id: string | null }>();
}

/**
 * The shared D1 test DB + instance-blind FIFO `/jobs/activate` lease means a stray
 * un-leased job from an earlier test could be picked up here — flush to quiescence
 * first (the established mitigation, mirrors scope-error-bubbling.test.ts).
 */
async function flushStrayJobs(token: string, taskTypes: string[]): Promise<void> {
  for (const taskType of taskTypes) {
    for (let guard = 0; guard < 20; guard++) {
      const r = await authedPost<{ jobs: { jobId: string; lockToken: string }[] }>("/jobs/activate", token, {
        taskType,
        workerId: "flush-worker",
      });
      const jobs = r.body.jobs ?? [];
      if (jobs.length === 0) break;
      for (const job of jobs) {
        await authedPost(`/jobs/${job.jobId}/complete`, token, { lockToken: job.lockToken, outputVariables: {} });
      }
    }
  }
}

describe("TASK-71 runtime scope re-entry backstop (scopeReentry)", () => {
  for (const host of ["transaction", "subProcess"] as const) {
    it(`[S-REENTRY-TIMER] a guarded loop-back into a timer-skipped ${host} raises scopeReentry`, async () => {
      const token = await mintWorkerToken();
      await flushStrayJobs(token, ["reWork"]);
      const { instance } = await publishAndStart(reentryTimerBpmn(host), {
        correlationKey: `reentry-timer-${host}-${crypto.randomUUID()}`,
        variables: { reenter: true },
      });
      const instanceId = instance.body.instanceId as string;

      // HOST entered → its boundary timer is armed; reWork parks the interior.
      expect((await getInstanceRow(instanceId))!.current_element_id).toBe("reWork");

      // Fire the timer: the fast-forward skips HOST's interior (skippedScopes.add),
      // the boundary path reaches gw, and the guarded loop-back re-descends HOST.
      await fireDueScopeTimer(instanceId);

      const inst = await getInstanceRow(instanceId);
      expect(inst!.status).toBe("incident");
      const inc = await incidentOf(instanceId);
      expect(inc!.kind).toBe("scopeReentry");
      expect(inc!.element_id).toBe("HOST");
    });
  }

  it("[S-REENTRY-CANCEL] a guarded loop-back into a nested cancelled transaction raises scopeReentry", async () => {
    const token = await mintWorkerToken();
    await flushStrayJobs(token, ["rcStepA", "rcUndoA", "rcAfter"]);
    const { instance } = await publishAndStart(REENTRY_CANCEL_BPMN, {
      correlationKey: `reentry-cancel-${crypto.randomUUID()}`,
      variables: { reenter: true, doCancel: true },
    });
    const instanceId = instance.body.instanceId as string;

    await leaseAndComplete(token, "rcStepA", {}); // A committedLocal → t_cancel cancels T
    await leaseAndComplete(token, "rcUndoA", {}); // T's reverse pass → nested cancel settles CONTINUE
    // afterCancel parks; completing it forces a rewalk that re-derives the skip from
    // the transactionCancelled marker (the fast-forward path) before the loop-back.
    await leaseAndComplete(token, "rcAfter", {});

    const inst = await getInstanceRow(instanceId);
    expect(inst!.status).toBe("incident");
    const inc = await incidentOf(instanceId);
    expect(inc!.kind).toBe("scopeReentry");
    expect(inc!.element_id).toBe("T");
  });
});
