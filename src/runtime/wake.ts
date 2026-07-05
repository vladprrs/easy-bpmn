// Single-wake protocol (TASK-54): ONE replay-stable step.waitForEvent per parked
// pass on a constant event type, with a timer-aware self-heal timeout. The wake is
// a pure tickle — D1 is the truth; the engine re-walks and reconciles on every wake.
import type { Env } from "../env";
import { getEarliestArmedTimerForInstance } from "../persistence/timers";
import { dbFirst } from "../persistence/db";

/**
 * The single Cloudflare Workflows event type every job/message/timer sendEvent uses.
 * Must satisfy ^[a-zA-Z0-9_][a-zA-Z0-9-_]*$ (no dots — see [[easy_bpmn_deployed]]).
 * Instance-scoped sendEvent means one global type can never collide across instances.
 */
export const WAKE_TYPE = "bpmn_wake";

/** Slack added past a timer's fire_at so the backstop never wakes microseconds early. */
const WAKE_SLACK_MS = 5000;

/**
 * Ceiling on the wake backstop when no modeled deadline applies (external job/message
 * waits). A lost wake recovers within this bound; D1 read-your-writes consistency
 * makes the tickle the reliable primary path, so this is a rare fallback. Tunable
 * (design §8). Defaults to one hour.
 */
export const MAX_WAKE_BACKSTOP_MS = 60 * 60 * 1000;

/**
 * Child-wait backstop cap (M5-L2 spec §3.4). A parent parked on an invoked
 * callActivity child self-heals via the child-notify DO alarm; this caps the
 * parent's wake backstop as the SECOND net, so a dropped tickle recovers within
 * minutes instead of the 1h MAX_WAKE_BACKSTOP_MS. Defined here (a leaf module) and
 * re-exported from call-activity.ts to avoid an engine↔call-activity import cycle.
 */
export const CHILD_WAIT_BACKSTOP_MS = 5 * 60 * 1000;

/**
 * The per-instance waitForEvent timeout for the single wake: size to the nearest
 * armed timer (so a modeled timer fires on time and a 7-day timer stays cheap),
 * capped at MAX_WAKE_BACKSTOP so a lost tickle on a non-timer wait self-heals.
 * Returns a Cloudflare-Workflows duration string ("N seconds").
 */
export async function wakeBackstop(env: Env, instanceId: string): Promise<string> {
  // TEST-ONLY: Layer-B self-heal tests lower the ceiling via a wrangler-dev var so
  // a genuinely lost wake recovers inside a bounded poll window (design §4.1).
  // Never set in production (wrangler.jsonc declares it nowhere).
  const override = Number((env as { MAX_WAKE_BACKSTOP_OVERRIDE?: string }).MAX_WAKE_BACKSTOP_OVERRIDE);
  const ceiling = Number.isFinite(override) && override > 0 ? override : MAX_WAKE_BACKSTOP_MS;
  const timer = await getEarliestArmedTimerForInstance(env.DB, instanceId);
  let ms = ceiling;
  if (timer) {
    const untilMs = new Date(timer.fireAt).getTime() - Date.now() + WAKE_SLACK_MS;
    ms = Math.min(ceiling, Math.max(WAKE_SLACK_MS, untilMs));
  }
  // M5-L2: a parent parked on a still-`invoked` child self-heals via the
  // child-notify DO alarm; cap the wake backstop at CHILD_WAIT_BACKSTOP_MS as the
  // second net (spec §3.4 — the child-wait path is explicitly short).
  const invokedChild = await dbFirst<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM child_instances WHERE parent_instance_id = ? AND status = 'invoked'`,
    [instanceId],
  );
  if ((invokedChild?.n ?? 0) > 0) ms = Math.min(ms, CHILD_WAIT_BACKSTOP_MS);
  return `${Math.ceil(ms / 1000)} seconds`;
}
