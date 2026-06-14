// Humanized, live-appended history feed (design §4 stage-4, §9). Clicking a row
// selects its element (bidirectional element↔event linking); a selected element
// filters the feed to that element.

import { Radio, Filter, X } from "lucide-react";
import type { HistoryEvent } from "../api/types";
import type { ElementIndex } from "../lib/elements";
import { describeEvent, humanize } from "../lib/humanize";
import type { Tone } from "../lib/humanize";
import { formatTime, relativeTime } from "../lib/format";
import type { LiveStatus } from "../api/stream";
import { Dot } from "./ui";

const LIVE_LABEL: Record<LiveStatus, { tone: Tone; text: string }> = {
  connecting: { tone: "muted", text: "connecting…" },
  live: { tone: "ok", text: "live" },
  reconnecting: { tone: "warn", text: "reconnecting…" },
  polling: { tone: "info", text: "polling" },
};

export function Timeline({
  events,
  index,
  selectedElement,
  onSelectElement,
  live,
}: {
  events: HistoryEvent[];
  index: ElementIndex;
  selectedElement: string | null;
  onSelectElement: (id: string | null) => void;
  live?: LiveStatus;
}) {
  const shown = selectedElement ? events.filter((e) => e.elementId === selectedElement) : events;
  const liveInfo = live ? LIVE_LABEL[live] : null;

  return (
    <div className="flex flex-col">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-content-muted">
          <span>{shown.length} events</span>
          {selectedElement && (
            <button
              onClick={() => onSelectElement(null)}
              className="flex items-center gap-1 rounded bg-surface-sunken px-1.5 py-0.5 text-accent hover:bg-surface-active"
            >
              <Filter className="h-3 w-3" /> {index.nameOf(selectedElement)} <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {liveInfo && (
          <span className="flex items-center gap-1 text-xs text-content-secondary">
            <Radio className="h-3 w-3" />
            <Dot tone={liveInfo.tone} /> {liveInfo.text}
          </span>
        )}
      </div>
      <ol className="max-h-[60vh] space-y-1 overflow-auto pr-1">
        {shown.length === 0 && <li className="p-4 text-center text-xs text-content-muted">no events</li>}
        {shown.map((e) => {
          const h = humanize(e.type);
          const detail = describeEvent(e, index.nameOf);
          return (
            <li
              key={e.historyEventId}
              onClick={() => e.elementId && onSelectElement(e.elementId)}
              className={`group flex cursor-pointer items-start gap-2 rounded-md border border-transparent px-2 py-1.5 hover:border-line-strong hover:bg-surface-sunken/60 ${
                selectedElement && e.elementId === selectedElement ? "bg-surface-sunken/60" : ""
              }`}
            >
              <span className="mt-1.5">
                <Dot tone={h.tone} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-content">{h.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-content-muted" title={formatTime(e.businessTime)}>
                    {relativeTime(e.businessTime)}
                  </span>
                </div>
                {detail && <div className="truncate text-xs text-content-muted">{detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
