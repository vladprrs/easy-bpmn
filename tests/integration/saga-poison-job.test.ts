import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedPost, DEMO_BPMN, get, mintWorkerToken, publishAndStart, SAGA_BPMN } from "../helpers";
import { POISON_THRESHOLD } from "../../src/runtime/retry-policy";

// TASK-23 (design §4.3): a worker that repeatedly COMPLETES with output that
// cannot be applied (here: a merge that would breach the ~1 MiB event payload
// limit) is a poison job. It is re-opened up to POISON_THRESHOLD, then yields a
// terminal incident with a DISTINCT kind='poison' — it does NOT enter
// 'compensating' and NO compensation jobs are created (unlike a business-error
// → cancel, which is the only path that compensates).

const HALF_MIB = "x".repeat(600_000); // two of these merged exceed the 1 MiB limit

async function forwardJob(instanceId: string) {
  return env.DB.prepare(
    `SELECT * FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 0`,
  ).bind(instanceId).first<any>();
}

async function compensationJobCount(instanceId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 1`,
  ).bind(instanceId).first<{ n: number }>();
  return r?.n ?? 0;
}

describe("poison-job termination (TASK-23 design §4.3)", () => {
  it("[C-BRANCH-POISON-01] re-opens an un-applicable completion up to the threshold, then terminates kind='poison' (no compensation)", async () => {
    // Start with ~0.6 MiB of variables; a 0.6 MiB completion output merges to > 1 MiB.
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: "poison-1", variables: { seed: HALF_MIB } });
    const instanceId = instance.body.instanceId;
    const token = await mintWorkerToken("default");

    let lastComplete: any;
    for (let strike = 1; strike <= POISON_THRESHOLD; strike++) {
      const leased = await authedPost("/jobs/activate", token, { taskType: "external-check", workerId: "w" });
      expect(leased.body.jobs).toHaveLength(1); // re-leasable each strike until poisoned
      const job = leased.body.jobs[0];
      expect(job.attempt).toBe(strike);
      lastComplete = await authedPost(`/jobs/${job.jobId}/complete`, token, {
        lockToken: job.lockToken,
        outputVariables: { extra: HALF_MIB }, // < 1 MiB alone, but merges to > 1 MiB
      });
      expect(lastComplete.status).toBe(200); // accepted at the wire; un-applicable downstream
    }

    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.status).not.toBe("compensating");
    expect(inst.body.incident.kind).toBe("poison");
    expect(inst.body.incident.elementId).toBe("Task_check");
    // distinct from cancel → NO compensation jobs were created
    expect(await compensationJobCount(instanceId)).toBe(0);
    expect(inst.body.saga).toBeFalsy(); // no saga ledger at all

    const history = await get(`/instances/${instanceId}/history`);
    expect(history.body.events.some((e: any) => e.type === "poisonJob")).toBe(true);

    // After poison the job is no longer leasable (terminal instance).
    const after = await authedPost("/jobs/activate", token, { taskType: "external-check", workerId: "w" });
    expect(after.body.jobs).toHaveLength(0);
  });

  it("poison of a COMPENSATABLE transaction step does NOT compensate (AC#5 — distinct from cancel)", async () => {
    // reserveStock sits inside Tx_order and HAS a compensation boundary
    // (reserveStock_comp → releaseStock). Poison must terminate with kind='poison'
    // and NOT enter 'compensating' nor create a release-stock compensation job —
    // unlike a business error → cancel, which is the only compensating path.
    const { instance } = await publishAndStart(SAGA_BPMN, { correlationKey: "poison-tx", variables: { seed: HALF_MIB } });
    const instanceId = instance.body.instanceId;
    const token = await mintWorkerToken("default");

    for (let strike = 1; strike <= POISON_THRESHOLD; strike++) {
      const leased = await authedPost("/jobs/activate", token, { taskType: "reserve-stock", workerId: "w" });
      expect(leased.body.jobs).toHaveLength(1);
      const job = leased.body.jobs[0];
      await authedPost(`/jobs/${job.jobId}/complete`, token, { lockToken: job.lockToken, outputVariables: { extra: HALF_MIB } });
    }

    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.incident.kind).toBe("poison");
    expect(inst.body.status).toBe("incident");
    expect(inst.body.status).not.toBe("compensating");
    // poison terminates BEFORE ledgering, so there is nothing to compensate
    expect(await compensationJobCount(instanceId)).toBe(0);
    const releaseStock = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND task_type = 'release-stock'`,
    ).bind(instanceId).first<{ n: number }>();
    expect(releaseStock?.n).toBe(0);
    expect(inst.body.saga).toBeFalsy(); // no saga_step was written for the poisoned step
  });

  it("counts un-applicable COMPLETIONS, not technical retries, toward the poison threshold (AC#5 semantics)", async () => {
    // DEMO's external-check has retries=3. A technical fail must NOT consume the
    // poison budget — only un-applicable completions count. So it should take a
    // full POISON_THRESHOLD un-applicable completions to poison, even after a
    // prior technical failure.
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: "poison-mix", variables: { seed: HALF_MIB } });
    const instanceId = instance.body.instanceId;
    const token = await mintWorkerToken("default");

    // One technical failure first (re-leasable; parks behind backoff).
    let leased = await authedPost("/jobs/activate", token, { taskType: "external-check", workerId: "w" });
    await authedPost(`/jobs/${leased.body.jobs[0].jobId}/fail`, token, { lockToken: leased.body.jobs[0].lockToken, reason: "transient", retryable: true });
    // elapse the backoff park so it is re-leasable
    await env.DB.prepare(`UPDATE service_task_jobs SET lock_expires_at='2000-01-01T00:00:00Z' WHERE instance_id=? AND is_compensation=0`).bind(instanceId).run();

    // Now POISON_THRESHOLD un-applicable completions are required to poison.
    for (let strike = 1; strike <= POISON_THRESHOLD; strike++) {
      leased = await authedPost("/jobs/activate", token, { taskType: "external-check", workerId: "w" });
      expect(leased.body.jobs).toHaveLength(1); // still leasable before the final strike
      await authedPost(`/jobs/${leased.body.jobs[0].jobId}/complete`, token, { lockToken: leased.body.jobs[0].lockToken, outputVariables: { extra: HALF_MIB } });
      const inst = await get(`/instances/${instanceId}`);
      if (strike < POISON_THRESHOLD) {
        expect(inst.body.status).not.toBe("incident"); // not yet poisoned — the technical fail did not count
      } else {
        expect(inst.body.incident.kind).toBe("poison"); // poisoned only on the THRESHOLD-th un-applicable completion
      }
    }
  });

  it("applies a completion whose merge stays within the limit (poison only triggers on un-applicable output)", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: "poison-ok", variables: { amount: 1 } });
    const instanceId = instance.body.instanceId;
    const token = await mintWorkerToken("default");
    const leased = await authedPost("/jobs/activate", token, { taskType: "external-check", workerId: "w" });
    const job = leased.body.jobs[0];
    await authedPost(`/jobs/${job.jobId}/complete`, token, { lockToken: job.lockToken, outputVariables: { ok: true } });

    const inst = await get(`/instances/${instanceId}`);
    // advanced past the Service Task to the Receive Task wait (not poisoned)
    expect(inst.body.status).toBe("waiting");
    expect(inst.body.incident).toBeFalsy();
    expect((await forwardJob(instanceId)).status).toBe("completed");
  });
});
