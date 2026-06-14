// Process statistics — unobtrusive, affirmative-first. Lead with the health line
// ("all flows nominal"); the status chips are secondary. Clicking a chip asks the
// stage to focus those runs. From GET /sagas rollups (no extra read).

import type { CountSummary } from "./model";
import { healthLine } from "./model";

const CHIP_TONE: Record<string, string> = {
  running: "text-info",
  starting: "text-info",
  waiting: "text-accent",
  compensating: "text-warn",
  completed: "text-ok",
  compensated: "text-ok",
  incident: "text-danger",
  compensationFailed: "text-danger",
  cancelled: "text-content-muted",
};

const HEALTH_TONE = {
  ok: "text-ok",
  accent: "text-accent",
  danger: "text-danger",
} as const;

export function StatsRail({
  summary,
  onPickStatus,
}: {
  summary: CountSummary;
  onPickStatus?: (status: string) => void;
}) {
  const health = healthLine(summary);
  return (
    <div className="flex items-center gap-3">
      <span className={`flex items-center gap-1.5 text-sm font-medium ${HEALTH_TONE[health.tone]}`}>
        <span className="relative flex h-1.5 w-1.5">
          {health.tone !== "ok" && (
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:hidden ${health.tone === "danger" ? "bg-danger" : "bg-accent"}`} />
          )}
          <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${health.tone === "danger" ? "bg-danger" : health.tone === "ok" ? "bg-ok" : "bg-accent"}`} />
        </span>
        {health.text}
      </span>
      {summary.entries.length > 0 && (
        <span className="hidden items-center gap-2 md:flex">
          {summary.entries.slice(0, 5).map((e) => (
            <button
              key={e.status}
              onClick={() => onPickStatus?.(e.status)}
              title={`${e.count} ${e.status}`}
              className="group flex items-baseline gap-1 transition hover:opacity-100"
            >
              <span className={`font-data tabular text-sm font-medium ${CHIP_TONE[e.status] ?? "text-content-secondary"}`}>
                {e.count}
              </span>
              <span className="text-2xs text-content-muted group-hover:text-content-secondary">{e.status}</span>
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
