// Static ISO-8601 timer-trigger parsing (M3-L3 boundary timers, design §3/§4.1).
//
// A modeled timer's trigger is a STATIC ISO-8601 literal — `timeDuration`
// (e.g. `PT5M`, `P1DT2H`) or `timeDate` (e.g. `2026-12-31T23:59:00Z`). FEEL
// expressions and `timeCycle` are rejected at validation (deferred). `fire_at`
// is computed ONCE at arm time in code (never recomputed in SQL) so a rewalk
// re-park and a Workflow replay both see the same deadline (replay-safety).

import { isoPlusMs } from "../util";

/** The validated, static trigger carried on a timer-boundary graph node. */
export interface TimerTrigger {
  kind: "timeDate" | "timeDuration";
  value: string;
}

// ISO-8601 duration: P[nY][nM][nW][nD][T[nH][nM][nS]] — at least one component.
const DURATION_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Parse an ISO-8601 duration literal to milliseconds, or null if it is not a
 * well-formed, non-empty duration (`P`/`PT` alone, a FEEL expression, garbage).
 * Years/months are approximated (365d / 30d) — the literal is a relative delay,
 * not a calendar anchor (use `timeDate` for an exact instant).
 */
export function parseIso8601DurationMs(s: string): number | null {
  const m = DURATION_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, w, d, h, mi, se] = m;
  if ([y, mo, w, d, h, mi, se].every((x) => x === undefined)) return null; // bare "P"/"PT"
  const n = (x?: string) => (x ? parseFloat(x) : 0);
  return (
    n(y) * 365 * 24 * 3600_000 +
    n(mo) * 30 * 24 * 3600_000 +
    n(w) * 7 * 24 * 3600_000 +
    n(d) * 24 * 3600_000 +
    n(h) * 3600_000 +
    n(mi) * 60_000 +
    n(se) * 1000
  );
}

const DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** True for a parseable static ISO-8601 date/datetime literal (not a FEEL expr). */
export function isValidIso8601DateTime(s: string): boolean {
  const v = s.trim();
  return DATE_RE.test(v) && !Number.isNaN(Date.parse(v));
}

/**
 * Compute a timer's absolute `fire_at` ONCE at arm time (design §4.1): a
 * `timeDuration` is `now + duration`; a `timeDate` is the literal instant
 * (normalized to UTC). The trigger is already validated at publish, so a
 * defensive un-parseable literal degrades to "fire now" rather than throwing.
 */
export function computeFireAt(trigger: TimerTrigger, now: string): string {
  if (trigger.kind === "timeDuration") {
    return isoPlusMs(now, parseIso8601DurationMs(trigger.value) ?? 0);
  }
  const t = Date.parse(trigger.value);
  return Number.isNaN(t) ? now : new Date(t).toISOString();
}
