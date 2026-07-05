// JobScheduler — a generic ONE-SHOT scheduler Durable Object (design §4.2). It
// fires a single alarm and dispatches by which marker it holds:
//   * a JOB marker (`arm`)      → the un-leasable-job DLQ timer (terminateUnleasableJob).
//   * a TIMER marker (`armTimer`) → a model timer (fireTimer, M3-L3).
//   * a CHILD marker (`armChildNotify`) → the callActivity child→parent notify
//     self-heal (retryChildNotify, M5-L2).
//
// Existing per-job DOs keep their raw-`jobId` naming (`idFromName(jobId)`,
// unchanged — NO re-keying of armed DLQ timers); timer DOs are keyed
// `timer:<timerId>` by callers (TASK-44); child-notify DOs are keyed
// `child-notify:<childInstanceId>` by callers (M5-L2) — a distinct name
// namespace from raw job ids and `timer:` ids. The storage markers use DISTINCT
// keys (JOB_KEY / TIMER_KEY / CHILD_KEY), so a DO instance dispatches
// unambiguously and the job/timer/child roles cannot collide. Same wrangler
// binding (JOB_SCHEDULER, class JobScheduler) — no DO-namespace migration.
//
// The DO is deliberately "dumb": it holds NO authoritative state (D1 is
// canonical). At fire time the dispatch target re-reads D1 and decides whether to
// act; a late/duplicate/stray alarm is a safe idempotent no-op. The DO
// self-deletes its storage after firing (one-shot), so it is inert afterwards.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { terminateUnleasableJob } from "../runtime/engine";
import { fireTimer } from "../runtime/timers";
import { retryChildNotify } from "../runtime/call-activity";

const JOB_KEY = "jobId";
const TIMER_KEY = "timerId";
const CHILD_KEY = "childNotify";           // value: childInstanceId
const CHILD_ATTEMPT_KEY = "childNotifyAttempt";

/** Bounded child→parent notify retry schedule (M5-L2 spec §3.4): 4 retries per
 *  level, all far below the 1h MAX_WAKE_BACKSTOP_MS the parent would otherwise
 *  wait after a dropped tickle. */
export const CHILD_NOTIFY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];

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

  /** Arm (or re-arm) the child→parent notify self-heal for `childInstanceId`. */
  async armChildNotify(childInstanceId: string, at: string, attempt: number): Promise<void> {
    await this.ctx.storage.put(CHILD_KEY, childInstanceId);
    await this.ctx.storage.put(CHILD_ATTEMPT_KEY, attempt);
    await this.ctx.storage.setAlarm(new Date(at).getTime());
  }

  override async alarm(): Promise<void> {
    // Re-read the stored marker and dispatch. A job DO, a timer DO, and a
    // child-notify DO are distinct DO instances (distinct names), so at most
    // one marker is present; job is checked first, then timer, then child —
    // only for deterministic dispatch order.
    const jobId = await this.ctx.storage.get<string>(JOB_KEY);
    const timerId = await this.ctx.storage.get<string>(TIMER_KEY);
    const childId = await this.ctx.storage.get<string>(CHILD_KEY);
    if (jobId) await terminateUnleasableJob(this.env, jobId);
    else if (timerId) {
      const rearm = await fireTimer(this.env, timerId);
      if (rearm) {
        // TASK-73: the fire was DEFERRED (frozen instance, a host without a resume
        // heal — task/receive boundary hosts and EBG timers) — re-set our own alarm
        // to the backoff instant and KEEP the marker instead of the one-shot
        // teardown, so the deadline is re-evaluated after the operator resume. Done
        // here, in the alarm handler, because the deleteAll below would wipe any
        // marker a nested (self-RPC) re-arm wrote during the dispatch.
        await this.ctx.storage.setAlarm(new Date(rearm.rearmAt).getTime());
        return;
      }
    } else if (childId) {
      const attempt = (await this.ctx.storage.get<number>(CHILD_ATTEMPT_KEY)) ?? 0;
      await retryChildNotify(this.env, childId, attempt);
    }
    // One-shot: drop our storage so the DO is inert after firing. Unconditional
    // otherwise, as today — independent of which marker (or none) was dispatched.
    await this.ctx.storage.deleteAll();
  }
}
