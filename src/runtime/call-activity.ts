// callActivity forward runtime (M5-L2). This file is Task 6's — the invoke,
// output-apply, and child→parent notify plumbing land there. Task 5 (executor
// idempotent child start, suppressParentNotify plumbing, JobScheduler
// child-notify alarm) only needs a stable import target for JobScheduler's
// alarm dispatch, so this stub exists to let the two tasks compile
// independently when executed strictly separately.

import type { Env } from "../env";

/**
 * Retry a dropped/lost child→parent notify tickle (JobScheduler child-notify
 * alarm, M5-L2 spec §3.4). Stub only — Task 6 implements the real re-read of
 * the child's terminal state + notify of the parent.
 */
export async function retryChildNotify(_env: Env, _childInstanceId: string, _attempt: number): Promise<void> {
  // Task 6 implements
}
