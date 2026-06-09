// JobScheduler — a per-job Durable Object whose only job is a single alarm: the
// un-leasable-job DLQ timer (design §4.2). One DO per service_task_job (keyed by
// jobId via idFromName), armed at job creation for `activation_expires_at`.
//
// The DO is deliberately "dumb": it holds NO authoritative state (D1 is canonical).
// At fire time it re-reads D1 through terminateUnleasableJob, which decides whether
// the job is genuinely un-leasable or has progressed. A late/duplicate alarm is a
// safe no-op (the re-check is idempotent). The DO self-deletes its storage after
// firing. Per-job keeps each alarm isolated — no shared sorted queue, no DO↔D1
// drift — at negligible churn for M1 volume.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { terminateUnleasableJob } from "../runtime/engine";

const JOB_KEY = "jobId";

export class JobScheduler extends DurableObject<Env> {
  /** Arm (or re-arm) the DLQ alarm for `jobId` at `activationExpiresAt`. */
  async arm(jobId: string, activationExpiresAt: string): Promise<void> {
    await this.ctx.storage.put(JOB_KEY, jobId);
    await this.ctx.storage.setAlarm(new Date(activationExpiresAt).getTime());
  }

  override async alarm(): Promise<void> {
    const jobId = await this.ctx.storage.get<string>(JOB_KEY);
    if (jobId) await terminateUnleasableJob(this.env, jobId);
    // One-shot: drop our storage so the DO is inert after firing.
    await this.ctx.storage.deleteAll();
  }
}
