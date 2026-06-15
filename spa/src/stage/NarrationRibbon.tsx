// The narration ribbon — A's voice inside B's stage (visual-design-brief §3, §6).
// The humanized timeline as a spoken line over the flow + a scrubber: dragging the
// playhead replays the run to any moment (the stage re-derives the diagram from
// history up to that index). Clicking the focused element links to the diagram.
// Fully legible without motion (text + a slider).

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, Radio, Rewind, SkipBack, SkipForward } from "lucide-react";
import type { HistoryEvent } from "../api/types";
import type { ElementIndex } from "../lib/elements";
import type { LiveStatus } from "../api/stream";
import { narrate, type Tone } from "../lib/humanize";
import { relativeTime, formatTime } from "../lib/format";

// The single leading "voice" dot keeps full tone — one focal point reading the
// current step's mood, not a row of colour (the de-rainbowed filmstrip is below).
// A faint same-tone aura (a tight ring, not a diffuse glow) turns the bullet into a
// confident marker so the line reads as the system *speaking*, not logging.
const DOT: Record<Tone, { dot: string; ring: string }> = {
  ok: { dot: "bg-ok", ring: "ring-ok/15" },
  danger: { dot: "bg-danger", ring: "ring-danger/15" },
  warn: { dot: "bg-warn", ring: "ring-warn/15" },
  info: { dot: "bg-info", ring: "ring-info/15" },
  accent: { dot: "bg-accent", ring: "ring-accent/15" },
  muted: { dot: "bg-line-strong", ring: "ring-line-strong/15" },
};

// Single source of the reduced-motion preference for this ribbon's transitions.
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

// Stream state → exactly one Title-Case label (never surface the raw lowercase enum).
const STREAM_LABEL: Record<LiveStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  polling: "Polling…",
};

// Filmstrip ticks are de-rainbowed: only trouble draws the eye. The calm majority
// (ok / info / accent / muted) is one quiet neutral; danger = coral, the warn-toned
// compensation/unwind events = amber. Nothing else is coloured.
const SCRUB_FILL = {
  danger: "bg-danger",
  warn: "bg-warn",
  neutral: "bg-line-strong",
} as const;
type ScrubTone = keyof typeof SCRUB_FILL;

const MAX_SEGMENTS = 72; // cap so the strip bins instead of scrolling / going sub-pixel

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

  const reduced = usePrefersReducedMotion();

  // The "speak" beat: when a new live line arrives, the narrator's words rise softly
  // into place (one-shot, transform/opacity). Scrubbing snaps — you are inspecting a
  // frozen moment, not being spoken to. Reduced-motion renders the final frame only.
  const lineRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!atLive || reduced) return;
    const el = lineRef.current;
    if (!el) return;
    const a = el.animate(
      [
        { opacity: 0, transform: "translateY(5px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 420, easing: "cubic-bezier(0.22,1,0.36,1)" },
    );
    return () => a.cancel();
  }, [story?.line, atLive, reduced]);

  const step = (delta: number) => {
    if (n === 0) return;
    const base = atLive ? n - 1 : scrubIndex!;
    const next = Math.max(0, Math.min(n - 1, base + delta));
    onScrub(next === n - 1 ? null : next);
  };

  const liveLabel = atLive ? STREAM_LABEL[live ?? "live"] : "Live";
  // Teal (the brand "current") when actually following live or returning to live;
  // calm secondary while a transient connection state resolves.
  const liveTone = !atLive || live == null || live === "live" ? "text-accent-press" : "text-content-secondary";

  // Binned filmstrip: contiguous index ranges, worst tone wins (danger > warn > calm).
  // The bin tones are a pure function of the event stream, so memoize them — the inner
  // O(n) narrate() sweep must not re-run on every render (30s live tick, every scrub
  // drag, the speak beat). Focus is layered on top per render, outside the memo.
  const bins = useMemo(() => {
    const binCount = Math.min(n, MAX_SEGMENTS);
    return Array.from({ length: binCount }, (_, b) => {
      const start = Math.floor((b * n) / binCount);
      const end = Math.floor(((b + 1) * n) / binCount) - 1;
      let tone: ScrubTone = "neutral";
      for (let i = start; i <= end; i++) {
        const t = narrate(events[i]!.type, null).tone;
        if (t === "danger") {
          tone = "danger";
          break;
        }
        if (t === "warn") tone = "warn";
      }
      return { start, end, tone };
    });
  }, [events, n]);
  const binCount = bins.length;
  const focusBin = bins.findIndex((b) => focusIdx >= b.start && focusIdx <= b.end);

  return (
    <section className="z-20 border-t border-line bg-surface-card">
      <div className="flex items-center gap-3 px-4 py-2.5">
        {/* The voice — the system speaking, set a clear step above its metadata */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {story ? (
            <>
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ring-4 ${DOT[story.tone].ring} ${DOT[story.tone].dot}`}
                aria-hidden
              />
              <button
                onClick={() => focus?.elementId && onSelectElement(focus.elementId)}
                className="min-w-0 text-left"
                title={focus ? formatTime(focus.businessTime) : undefined}
              >
                <span
                  ref={lineRef}
                  className="block truncate font-sans text-lg font-medium leading-snug tracking-[-0.01em] text-content-strong"
                >
                  {story.line}
                </span>
                <span className="block truncate font-data text-xs text-content-secondary">
                  {focus && relativeTime(focus.businessTime)}
                  {focus?.elementId && <span className="text-content"> · {index.nameOf(focus.elementId)}</span>}
                  {!atLive && <span className="ml-1 font-medium text-accent-press">· replaying {focusIdx + 1}/{n}</span>}
                </span>
              </button>
            </>
          ) : (
            <>
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-line-strong/15 bg-line-strong"
                aria-hidden
              />
              <span className="text-md font-medium text-content-secondary">Listening for the first step…</span>
            </>
          )}
        </div>

        {/* Transport */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => step(-1)}
            disabled={n === 0}
            aria-label="Step back one event"
            className="rounded-md p-1.5 text-content-secondary transition hover:bg-surface-hover disabled:opacity-40"
            title="Step back"
          >
            <SkipBack className="h-4 w-4" />
          </button>
          <button
            onClick={() => step(1)}
            disabled={n === 0 || atLive}
            aria-label="Step forward one event"
            className="rounded-md p-1.5 text-content-secondary transition hover:bg-surface-hover disabled:opacity-40"
            title="Step forward"
          >
            <SkipForward className="h-4 w-4" />
          </button>
          <button
            onClick={() => onScrub(null)}
            aria-label={atLive ? "Following live" : "Return to live"}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition hover:bg-accent-soft ${liveTone}`}
            title={atLive ? "Following live" : "Return to live"}
          >
            {atLive ? <Radio className="h-3.5 w-3.5" /> : <Rewind className="h-3.5 w-3.5" />}
            {liveLabel}
          </button>
          <button
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Show timeline" : "Hide timeline"}
            aria-expanded={!collapsed}
            className="rounded-md p-1.5 text-content-secondary transition hover:bg-surface-hover"
            title={collapsed ? "Show timeline" : "Hide timeline"}
          >
            <ChevronUp className={`h-4 w-4 transition ${collapsed ? "" : "rotate-180"}`} />
          </button>
        </div>
      </div>

      {/* The filmstrip — one continuous band of frames; calm neutral majority, trouble
          punctuates in coral/amber, and a confident teal playhead glides to the focus
          frame (transform only). The frame is the current; its tone shows underneath. */}
      {!collapsed && (
        <div className="px-4 pb-3">
          <div className="rounded-lg bg-surface-sunken p-1">
            {n === 0 ? (
              <div className="grid h-7 w-full place-items-center text-xs text-content-secondary">
                no events yet
              </div>
            ) : (
              <div className="relative flex h-7 items-stretch overflow-hidden rounded-md">
                {bins.map((bin, i) => {
                  const target = bin.end;
                  const ev = events[target]!;
                  const label = narrate(ev.type, ev.elementId ? index.nameOf(ev.elementId) : null).line;
                  const isFocus = i === focusBin;
                  const fill =
                    bin.tone === "neutral"
                      ? "bg-line-strong/55 group-hover:bg-line-strong"
                      : `${SCRUB_FILL[bin.tone]} group-hover:brightness-110`;
                  return (
                    <button
                      key={bin.start}
                      onClick={() => onScrub(target === n - 1 ? null : target)}
                      aria-label={`Replay to: ${label}`}
                      aria-current={isFocus ? "step" : undefined}
                      title={label}
                      className="group relative h-full flex-1"
                    >
                      <span className={`block h-full w-full transition-[background-color,filter] ${fill}`} />
                    </button>
                  );
                })}
                {/* The playhead: a teal-framed frame that slides between bins */}
                {focusBin >= 0 && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 left-0 rounded-sm bg-accent/10 shadow-[inset_0_0_0_2px_var(--accent)]"
                    style={{
                      width: `${100 / binCount}%`,
                      transform: `translateX(${focusBin * 100}%)`,
                      transition: reduced ? "none" : "transform 0.34s cubic-bezier(0.22,1,0.36,1)",
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
