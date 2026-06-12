// JobScheduler — a generic ONE-SHOT scheduler Durable Object (design §4.2). It
// fires a single alarm and dispatches by which marker it holds:
//   * a JOB marker (`arm`)      → the un-leasable-job DLQ timer (terminateUnleasableJob).
//   * a TIMER marker (`armTimer`) → a model timer (fireTimer, M3-L3).
//
// Existing per-job DOs keep their raw-`jobId` naming (`idFromName(jobId)`,
// unchanged — NO re-keying of armed DLQ timers); new timer DOs are keyed
// `timer:<timerId>` by callers (TASK-44). The two storage markers use DISTINCT
// keys (JOB_KEY vs TIMER_KEY), so a DO instance dispatches unambiguously and the
// job/timer roles cannot collide. Same wrangler binding (JOB_SCHEDULER, class
// JobScheduler) — no DO-namespace migration.
//
// The DO is deliberately "dumb": it holds NO authoritative state (D1 is
// canonical). At fire time the dispatch target re-reads D1 and decides whether to
// act; a late/duplicate/stray alarm is a safe idempotent no-op. The DO
// self-deletes its storage after firing (one-shot), so it is inert afterwards.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { terminateUnleasableJob } from "../runtime/engine";
import { fireTimer } from "../runtime/timers";

const JOB_KEY = "jobId";
const TIMER_KEY = "timerId";

export class JobScheduler extends DurableObject<Env> {
  /** Arm (or re-arm) the DLQ alarm for `jobId` at `activationExpiresAt`. */
  async arm(jobId: string, activationExpiresAt: string): Promise<void> {
    await this.ctx.storage.put(JOB_KEY, jobId);
    await this.ctx.storage.setAlarm(new Date(activationExpiresAt).getTime());
  }

  /** Arm (or re-arm) a model-timer alarm for `timerId` at `fireAt` (design §4.2). */
  async armTimer(timerId: string, fireAt: string): Promise<void> {
    await this.ctx.storage.put(TIMER_KEY, timerId);
    await this.ctx.storage.setAlarm(new Date(fireAt).getTime());
  }

  override async alarm(): Promise<void> {
    // Re-read the stored marker and dispatch. A job DO and a timer DO are
    // distinct DO instances (distinct names), so at most one marker is present;
    // job is checked first only for deterministic dispatch order.
    const jobId = await this.ctx.storage.get<string>(JOB_KEY);
    const timerId = await this.ctx.storage.get<string>(TIMER_KEY);
    if (jobId) await terminateUnleasableJob(this.env, jobId);
    else if (timerId) await fireTimer(this.env, timerId);
    // One-shot: drop our storage so the DO is inert after firing. Unconditional,
    // as today — independent of which marker (or none) was dispatched.
    await this.ctx.storage.deleteAll();
  }
}
