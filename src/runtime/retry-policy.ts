// Failure-edge policy constants + the pure backoff function (design §4.1/§4.4).
//
// Kept pure and dependency-free (no D1, no env) so the backoff curve is
// unit-testable in isolation (risk R1). The values are the approved M1 defaults
// (tunable at spec review) and are mirrored in the specs/002 runtime contract.

export interface RetryPolicy {
  /** First-retry delay (ms). */
  baseMs: number;
  /** Exponential growth factor per attempt. */
  factor: number;
  /** Hard cap on the delay (ms) regardless of attempt. */
  maxBackoffMs: number;
}

/** Approved M1 retry backoff: base 1s, factor 2, cap 30s. */
export const RETRY_POLICY: RetryPolicy = {
  baseMs: 1000,
  factor: 2,
  maxBackoffMs: 30_000,
};

/**
 * Job-level activation TTL: a created job nobody leases within this window is
 * un-leasable → DLQ (terminal incident kind='timeout'). The lone M1 job-level
 * timer (general timers are M3).
 */
export const ACTIVATION_TTL_MS = 15 * 60 * 1000;

/**
 * Poison threshold: a worker that completes with un-applicable output this many
 * times → terminal incident kind='poison' (distinct from a business-error→cancel;
 * poison NEVER triggers compensation).
 */
export const POISON_THRESHOLD = 3;

/**
 * The pre-jitter backoff cap for `attempt` (1-based): the exponential value
 * `base * factor^(attempt-1)`, clamped to `maxBackoffMs`. Monotonically
 * non-decreasing in `attempt`, never exceeding `maxBackoffMs`.
 */
export function backoffCapMs(attempt: number, policy: RetryPolicy = RETRY_POLICY): number {
  const n = Math.max(1, Math.floor(attempt));
  const exponential = policy.baseMs * Math.pow(policy.factor, n - 1);
  return Math.min(policy.maxBackoffMs, exponential);
}

/**
 * Exponential backoff with **full jitter** (AWS-style): a uniformly random delay
 * in `[0, backoffCapMs(attempt)]`. `rand` is injectable (defaults to
 * `Math.random`) so the jitter bounds are deterministically testable. The result
 * is parked into `service_task_jobs.lock_expires_at`, reusing the activate lease
 * gate so backoff stays distinct from `leaseMs` without a new column.
 */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy = RETRY_POLICY,
  rand: () => number = Math.random,
): number {
  return Math.round(rand() * backoffCapMs(attempt, policy));
}
