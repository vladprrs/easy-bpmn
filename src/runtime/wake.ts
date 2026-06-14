// Single-wake protocol (TASK-54): ONE replay-stable step.waitForEvent per parked
// pass on a constant event type, with a timer-aware self-heal timeout. The wake is
// a pure tickle — D1 is the truth; the engine re-walks and reconciles on every wake.
import type { Env } from "../env";
import { getEarliestArmedTimerForInstance } from "../persistence/timers";

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
 * The per-instance waitForEvent timeout for the single wake: size to the nearest
 * armed timer (so a modeled timer fires on time and a 7-day timer stays cheap),
 * capped at MAX_WAKE_BACKSTOP so a lost tickle on a non-timer wait self-heals.
 * Returns a Cloudflare-Workflows duration string ("N seconds").
 */
export async function wakeBackstop(env: Env, instanceId: string): Promise<string> {
  const timer = await getEarliestArmedTimerForInstance(env.DB, instanceId);
  let ms = MAX_WAKE_BACKSTOP_MS;
  if (timer) {
    const untilMs = new Date(timer.fireAt).getTime() - Date.now() + WAKE_SLACK_MS;
    ms = Math.min(MAX_WAKE_BACKSTOP_MS, Math.max(WAKE_SLACK_MS, untilMs));
  }
  return `${Math.ceil(ms / 1000)} seconds`;
}
