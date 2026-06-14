// The narration ribbon — A's voice inside B's stage (visual-design-brief §3, §6).
// The humanized timeline as a spoken line over the flow + a scrubber: dragging the
// playhead replays the run to any moment (the stage re-derives the diagram from
// history up to that index). Clicking the focused element links to the diagram.
// Fully legible without motion (text + a slider).

import { ChevronUp, Radio, Rewind, SkipBack, SkipForward } from "lucide-react";
import type { HistoryEvent } from "../api/types";
import type { ElementIndex } from "../lib/elements";
import type { LiveStatus } from "../api/stream";
import { narrate, type Tone } from "../lib/humanize";
import { relativeTime, formatTime } from "../lib/format";

const TICK: Record<Tone, string> = {
  ok: "bg-ok",
  danger: "bg-danger",
  warn: "bg-warn",
  info: "bg-info",
  accent: "bg-accent",
  muted: "bg-line-strong",
};

export function NarrationRibbon({
  events,
  index,
  live,
  scrubIndex,
  onScrub,
  onSelectElement,
  collapsed,
  onToggleCollapsed,
}: {
  events: HistoryEvent[];
  index: ElementIndex;
  live: LiveStatus | null;
  scrubIndex: number | null;
  onScrub: (i: number | null) => void;
  onSelectElement: (id: string | null) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const n = events.length;
  const atLive = scrubIndex === null;
  const focusIdx = atLive ? n - 1 : Math.min(scrubIndex, n - 1);
  const focus = events[focusIdx];
  const story = focus ? narrate(focus.type, focus.elementId ? index.nameOf(focus.elementId) : null) : null;

  const step = (delta: number) => {
    if (n === 0) return;
    const base = atLive ? n - 1 : scrubIndex!;
    const next = Math.max(0, Math.min(n - 1, base + delta));
    onScrub(next === n - 1 ? null : next);
  };

  return (
    <section className="z-20 border-t border-line/70 bg-surface-card/80 backdrop-blur-md">
      <div className="flex items-center gap-3 px-4 py-2.5">
        {/* The voice */}
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {story ? (
            <>
              <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${TICK[story.tone]}`} />
              <button
                onClick={() => focus?.elementId && onSelectElement(focus.elementId)}
                className="min-w-0 text-left"
                title={focus ? formatTime(focus.businessTime) : undefined}
              >
                <span className="block truncate text-md text-content-strong">{story.line}</span>
                <span className="font-data text-2xs text-content-muted">
                  {focus && relativeTime(focus.businessTime)}
                  {focus?.elementId && <span className="text-content-secondary"> · {index.nameOf(focus.elementId)}</span>}
                  {!atLive && <span className="ml-1 text-accent">· replaying {focusIdx + 1}/{n}</span>}
                </span>
              </button>
            </>
          ) : (
            <span className="text-sm text-content-muted">Waiting for the first step…</span>
          )}
        </div>

        {/* Transport */}
        <div className="flex shrink-0 items-center gap-1">
          <button onClick={() => step(-1)} disabled={n === 0} className="rounded-md p-1.5 text-content-secondary transition hover:bg-surface-hover disabled:opacity-40" title="Step back">
            <SkipBack className="h-4 w-4" />
          </button>
          <button onClick={() => step(1)} disabled={n === 0 || atLive} className="rounded-md p-1.5 text-content-secondary transition hover:bg-surface-hover disabled:opacity-40" title="Step forward">
            <SkipForward className="h-4 w-4" />
          </button>
          <button
            onClick={() => onScrub(null)}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition ${
              atLive ? "text-ok" : "text-accent hover:bg-accent-soft"
            }`}
            title={atLive ? "Following live" : "Return to live"}
          >
            {atLive ? <Radio className="h-3.5 w-3.5" /> : <Rewind className="h-3.5 w-3.5" />}
            {atLive ? (live === "live" ? "Live" : live ?? "live") : "Live"}
          </button>
          <button onClick={onToggleCollapsed} className="rounded-md p-1.5 text-content-muted transition hover:bg-surface-hover" title={collapsed ? "Show timeline" : "Hide timeline"}>
            <ChevronUp className={`h-4 w-4 transition ${collapsed ? "" : "rotate-180"}`} />
          </button>
        </div>
      </div>

      {/* The scrubber track */}
      {!collapsed && (
        <div className="px-4 pb-3">
          <div className="flex h-9 items-stretch gap-px overflow-x-auto rounded-lg bg-surface-sunken/70 p-1">
            {n === 0 && <div className="grid w-full place-items-center text-2xs text-content-muted">no events yet</div>}
            {events.map((e, i) => {
              const t = narrate(e.type, null).tone;
              const isFocus = i === focusIdx;
              return (
                <button
                  key={e.historyEventId}
                  onClick={() => onScrub(i === n - 1 ? null : i)}
                  title={narrate(e.type, e.elementId ? index.nameOf(e.elementId) : null).line}
                  className={`group relative min-w-[6px] flex-1 rounded-sm transition ${isFocus ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-sunken" : ""}`}
                >
                  <span className={`block h-full w-full rounded-sm opacity-70 transition group-hover:opacity-100 ${TICK[t]} ${isFocus ? "opacity-100" : ""}`} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
