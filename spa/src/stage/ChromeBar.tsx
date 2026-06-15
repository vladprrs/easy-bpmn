// The slim top chrome (visual-design-brief §4): brand · process switcher · stats ·
// ⌘K · attention · live · logout. Everything process/global level; the diagram
// commands the rest of the stage. Matte solid chrome — the single glass surface in
// the console is the floating StageHeader, never this bar.

import { useEffect, useRef, useState, type RefObject } from "react";
import { Command, LogOut, Radio } from "lucide-react";
import type { AttentionItem, SagaSummary } from "../api/types";
import type { LiveStatus } from "../api/stream";
import type { CountSummary } from "./model";
import { ProcessSwitcher } from "./ProcessSwitcher";
import { StatsRail } from "./StatsRail";
import { AttentionPopover } from "./AttentionPopover";
import { Kbd } from "./primitives";

const LIVE: Record<LiveStatus, { dot: string; label: string }> = {
  connecting: { dot: "bg-content-muted", label: "connecting" },
  live: { dot: "bg-ok", label: "live" },
  reconnecting: { dot: "bg-warn", label: "reconnecting" },
  polling: { dot: "bg-info", label: "polling" },
};

// Listen for prefers-reduced-motion (not read once at mount): flipping the OS setting
// live settles every idle pulse to its resting frame without a reload.
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// The single resting breath for the chrome: ONE cadence (var(--pulse)) shared by every
// idle live signal here (the teal wordmark dot and the live-tail dot), so the bar reads
// as one heartbeat, not three near-equal rhythms. transform/opacity only, ease-standard,
// no bounce. Reduced motion rests the dot at full opacity/scale, so liveness still reads
// from colour and the adjacent label, never from motion alone.
function useBreathe<T extends HTMLElement>(ref: RefObject<T>, active: boolean) {
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || !active || reduced) return;
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--pulse").trim();
    const ms = raw.endsWith("ms") ? parseFloat(raw) : raw.endsWith("s") ? parseFloat(raw) * 1000 : NaN;
    const anim = el.animate(
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0.5, transform: "scale(0.78)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: Number.isFinite(ms) ? ms : 2600, easing: "cubic-bezier(0.4, 0, 0.2, 1)", iterations: Infinity },
    );
    return () => anim.cancel();
  }, [ref, active, reduced]);
}

export function ChromeBar({
  sagas,
  currentSaga,
  summary,
  attention,
  live,
  authConfigured,
  onOpenPalette,
  onPickStatus,
  onLogout,
}: {
  sagas: SagaSummary[];
  currentSaga: SagaSummary | null;
  summary: CountSummary;
  attention: AttentionItem[];
  live: LiveStatus | null;
  authConfigured: boolean;
  onOpenPalette: () => void;
  onPickStatus: (status: string) => void;
  onLogout: () => void;
}) {
  const liveInfo = live ? LIVE[live] : null;
  // Two idle live signals, ONE breath cadence (var(--pulse), via useBreathe): the teal
  // wordmark dot (always) and the live-tail dot (only while the stream is truly live).
  const dotRef = useRef<HTMLSpanElement>(null);
  const liveDotRef = useRef<HTMLSpanElement>(null);
  useBreathe(dotRef, true);
  useBreathe(liveDotRef, live === "live");

  return (
    <header className="z-30 flex items-center gap-3 border-b border-line bg-surface-card px-4 py-2.5">
      <span
        className="shrink-0 select-none pl-0.5 font-display text-md text-content-strong"
        style={{ letterSpacing: "-0.01em" }}
      >
        easy
        <span ref={dotRef} className="inline-block text-accent" style={{ transformOrigin: "center" }}>
          ·
        </span>
        bpmn
      </span>
      <span className="h-5 w-px shrink-0 bg-line" aria-hidden />
      <div className="min-w-0">
        <ProcessSwitcher sagas={sagas} current={currentSaga} />
      </div>
      <span className="hidden h-5 w-px shrink-0 bg-line lg:block" aria-hidden />
      <div className="hidden min-w-0 lg:block">
        <StatsRail summary={summary} onPickStatus={onPickStatus} />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onOpenPalette}
          className="flex items-center gap-2 rounded-lg border border-line bg-surface-card px-2.5 py-1.5 text-sm text-content-secondary shadow-xs transition-colors hover:border-line-strong hover:text-content"
        >
          <Command className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
        <AttentionPopover items={attention} />
        {liveInfo && (
          <span
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-content-secondary"
            title={`live tail · ${liveInfo.label}`}
          >
            <Radio className="h-3.5 w-3.5" />
            <span
              ref={liveDotRef}
              className={`inline-flex h-1.5 w-1.5 rounded-full ${liveInfo.dot}`}
              style={{ transformOrigin: "center" }}
            />
            <span className="hidden md:inline">{liveInfo.label}</span>
          </span>
        )}
        {authConfigured && (
          <button
            onClick={onLogout}
            title="Sign out"
            className="flex items-center rounded-lg px-2 py-1.5 text-content-secondary transition-colors hover:bg-surface-hover hover:text-content"
          >
            <LogOut className="h-4 w-4" />
          </button>
        )}
      </div>
    </header>
  );
}
