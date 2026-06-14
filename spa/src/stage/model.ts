// Stage selection + summary helpers (pure). "Alive on first paint" = auto-select the
// most-relevant instance; the affirmative health line = "show it's OK" first.

import type { InstanceListItem, SagaSummary, StatusCounts } from "../api/types";

export const LIVE_STATUSES = new Set(["running", "starting", "waiting", "compensating"]);
export const ATTENTION_STATUSES = new Set(["incident", "compensationFailed"]);

function liveOf(counts: StatusCounts): number {
  let n = 0;
  for (const [s, c] of Object.entries(counts)) if (LIVE_STATUSES.has(s)) n += c ?? 0;
  return n;
}
function attentionOf(counts: StatusCounts): number {
  return (counts.incident ?? 0) + (counts.compensationFailed ?? 0);
}

/** The process the stage opens on: most live work, else most attention, else most recent. */
export function pickFeaturedSaga(sagas: SagaSummary[]): SagaSummary | null {
  if (sagas.length === 0) return null;
  return [...sagas].sort((a, b) => {
    const la = liveOf(a.counts);
    const lb = liveOf(b.counts);
    if (la !== lb) return lb - la;
    const aa = attentionOf(a.counts);
    const ab = attentionOf(b.counts);
    if (aa !== ab) return ab - aa;
    return (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "");
  })[0]!;
}

/** The run the stage flows on load: most-recent in-flight, else most-recent overall.
 *  (The instance list arrives rowid-desc = most-recent first.) */
export function pickRelevantInstance(instances: InstanceListItem[]): InstanceListItem | null {
  if (instances.length === 0) return null;
  return instances.find((i) => LIVE_STATUSES.has(i.status) || ATTENTION_STATUSES.has(i.status)) ?? instances[0]!;
}

export interface CountSummary {
  total: number;
  live: number;
  done: number;
  attention: number;
  entries: { status: string; count: number }[];
}

export function summarize(counts: StatusCounts | undefined): CountSummary {
  const c = counts ?? {};
  const entries = Object.entries(c)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([status, n]) => ({ status, count: n ?? 0 }))
    .sort((a, b) => b.count - a.count);
  const total = entries.reduce((s, e) => s + e.count, 0);
  const done = (c.completed ?? 0) + (c.compensated ?? 0);
  return { total, live: liveOf(c), done, attention: attentionOf(c), entries };
}

/** The affirmative headline — proof-of-working first, alarm only when real. */
export function healthLine(s: CountSummary): { text: string; tone: "ok" | "accent" | "danger" } {
  if (s.total === 0) return { text: "No runs yet", tone: "accent" };
  if (s.attention > 0)
    return { text: `${s.attention} run${s.attention === 1 ? "" : "s"} need${s.attention === 1 ? "s" : ""} you`, tone: "danger" };
  if (s.live > 0) return { text: `${s.live} flowing · all nominal`, tone: "accent" };
  return { text: "All flows nominal", tone: "ok" };
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
