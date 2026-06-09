import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedPost, DEMO_BPMN, get, mintWorkerToken, publishAndStart } from "../helpers";
import { terminateUnleasableJob } from "../../src/runtime/engine";
import { failUnleasableJobConditional } from "../../src/persistence/jobs";

// TASK-23 (design §4.2): a forward job whose taskType nobody polls must not hang.
// At creation it gets activation_expires_at = created + ACTIVATION_TTL_MS and a
// per-job JobScheduler DO alarm is armed. On expiry the alarm re-reads D1 and, if
// the job is still un-leased, routes a synthetic timeout via terminateUnleasableJob
// → terminal incident kind='timeout' (NOT a generic 'Workflow terminated:' fall
// through). A job that progressed (leased/completed) is a no-op.

async function forwardJob(instanceId: string) {
  return env.DB.prepare(
    `SELECT * FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 0`,
  ).bind(instanceId).first<any>();
}

const expireActivation = (jobId: string) =>
  env.DB.prepare(`UPDATE service_task_jobs SET activation_expires_at = '2000-01-01T00:00:00Z' WHERE job_id = ?`).bind(jobId).run();

function schedulerStub(jobId: string) {
  return env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(jobId));
}

describe("un-leasable-job DLQ timeout (TASK-23 design §4.2)", () => {
  it("times out a never-leased forward job via the armed alarm → terminal incident kind='timeout'", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: "dlq-1", variables: { amount: 1 } });
    const instanceId = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting"); // parked at the pull Service Task

    const job = await forwardJob(instanceId);
    expect(job.status).toBe("created");
    expect(job.activation_expires_at).not.toBeNull(); // armed with a TTL at creation
    await expireActivation(job.job_id);

    // Fire the per-job alarm that was armed at job creation.
    const ran = await runDurableObjectAlarm(schedulerStub(job.job_id));
    expect(ran).toBe(true);

    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("timeout");
    expect(inst.body.incident.elementId).toBe("Task_check");
    // a SPECIFIC reason, not the process-workflow catch-all 'Workflow terminated:'
    expect(inst.body.incident.reason).toMatch(/un-leasable/i);
    expect(inst.body.incident.reason).not.toMatch(/Workflow terminated/);

    const history = await get(`/instances/${instanceId}/history`);
    expect(history.body.events.some((e: any) => e.type === "jobActivationExpired")).toBe(true);
    // the job itself is failed so a stray late lease cannot pick it up
    expect((await forwardJob(instanceId)).status).toBe("failed");
  });

  it("does NOT time out a job leased before activation_expires_at (negative case)", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: "dlq-2", variables: { amount: 1 } });
    const instanceId = instance.body.instanceId;
    const token = await mintWorkerToken("default");

    // Lease (attempt → 1) but do NOT complete — the job has progressed.
    const leased = await authedPost("/jobs/activate", token, { taskType: "external-check", workerId: "w" });
    expect(leased.body.jobs).toHaveLength(1);
    const job = await forwardJob(instanceId);
    expect(job.attempt_count).toBe(1);
    await expireActivation(job.job_id);

    const ran = await runDurableObjectAlarm(schedulerStub(job.job_id));
    expect(ran).toBe(true); // the alarm fired …

    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).not.toBe("incident"); // … but it was a no-op (job progressed)
    expect(inst.body.incident).toBeFalsy();
  });

  it("the guarded DLQ claim only flips a STILL-un-leased job (TOCTOU protection)", async () => {
    // The settle must be conditional on the job still being created/attempt-0, so a
    // lease that lands between the alarm's re-check and the write cannot be clobbered.
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: "dlq-guard", variables: { amount: 1 } });
    const job = await forwardJob(instance.body.instanceId);
    const now = new Date().toISOString();

    // A leased (or otherwise progressed) job is NOT claimable by the DLQ.
    await env.DB.prepare(`UPDATE service_task_jobs SET status='locked', attempt_count=1, lock_token='lt' WHERE job_id=?`).bind(job.job_id).run();
    expect(await failUnleasableJobConditional(env.DB, job.job_id, now)).toBe(0);

    // A still-created, attempt-0 job IS claimed exactly once.
    await env.DB.prepare(`UPDATE service_task_jobs SET status='created', attempt_count=0, lock_token=NULL WHERE job_id=?`).bind(job.job_id).run();
    expect(await failUnleasableJobConditional(env.DB, job.job_id, now)).toBe(1);
    expect((await forwardJob(instance.body.instanceId)).status).toBe("failed");
    // a second claim finds nothing (already failed)
    expect(await failUnleasableJobConditional(env.DB, job.job_id, now)).toBe(0);
  });

  it("does not regress a concurrently-terminal instance back into a timeout incident", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: "dlq-noregress", variables: { amount: 1 } });
    const instanceId = instance.body.instanceId;
    const job = await forwardJob(instanceId);
    await expireActivation(job.job_id);
    // Simulate the instance having already settled terminally (e.g. operator cancel).
    await env.DB.prepare(`UPDATE process_instances SET status='cancelled' WHERE instance_id=?`).bind(instanceId).run();

    await terminateUnleasableJob(env, job.job_id);
    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("cancelled"); // NOT regressed to 'incident'
  });

  it("terminateUnleasableJob is idempotent: a duplicate/late call after settlement is a no-op", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: "dlq-3", variables: { amount: 1 } });
    const instanceId = instance.body.instanceId;
    const job = await forwardJob(instanceId);
    await expireActivation(job.job_id);

    await terminateUnleasableJob(env, job.job_id);
    const first = await get(`/instances/${instanceId}`);
    expect(first.body.status).toBe("incident");
    const incidentId = first.body.incident.incidentId;

    // A late/duplicate alarm must not create a second incident or change status.
    await terminateUnleasableJob(env, job.job_id);
    const second = await get(`/instances/${instanceId}`);
    expect(second.body.status).toBe("incident");
    expect(second.body.incident.incidentId).toBe(incidentId);
  });
});
