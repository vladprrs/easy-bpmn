// Process statistics — unobtrusive, affirmative-first. Lead with the health line
// ("all flows nominal"); the status chips are secondary. Clicking a chip asks the
// stage to focus those runs. From GET /sagas rollups (no extra read).

import { useEffect, useRef, useState } from "react";
import type { CountSummary } from "./model";
import { healthLine } from "./model";

// Only the leading dot carries tone — every status colour fails AA as text on
// white, so the words stay ink and the dot does the colour-coding.
const HEALTH_DOT = {
  ok: "bg-ok",
  accent: "bg-accent",
  danger: "bg-danger",
} as const;

// Single source of the reduced-motion preference, kept live: the operator can flip the
// OS setting mid-watch and the halo must start or stop without a reload.
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

// The health dot "breathes" on the shared living-current cadence (var(--pulse), 2.6s)
// when there is current to read (live work, or trouble): a single calm halo emanating
// and fading, NOT the clinical 1s animate-ping. A settled system (tone "ok") rests
// static (stillness IS the message: "the circuit settles on success"). transform and
// opacity only. Under reduced-motion the halo never mounts, so the always-visible core
// dot carries the whole state.
function BreathingDot({ tone }: { tone: "ok" | "accent" | "danger" }) {
  const haloRef = useRef<HTMLSpanElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const breathing = tone !== "ok" && !reduced;
  useEffect(() => {
    const el = haloRef.current;
    if (!el || !breathing) return;
    // Read the shared cadence token so this halo stays in lockstep with the flow.
    const pulse = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pulse")) || 2600;
    const anim = el.animate(
      [
        { transform: "scale(1)", opacity: 0.5, offset: 0 },
        { transform: "scale(2.3)", opacity: 0, offset: 1 },
      ],
      { duration: pulse, easing: "cubic-bezier(0.16,1,0.3,1)", iterations: Infinity },
    );
    return () => anim.cancel();
  }, [breathing, tone]);

  return (
    <span className="relative flex h-1.5 w-1.5">
      {breathing && (
        <span
          ref={haloRef}
          aria-hidden
          className={`absolute inset-0 rounded-full ${tone === "danger" ? "bg-danger" : "bg-accent"}`}
          style={{ opacity: 0 }}
        />
      )}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${HEALTH_DOT[tone]}`} />
    </span>
  );
}

export function StatsRail({
  summary,
  onPickStatus,
}: {
  summary: CountSummary;
  onPickStatus?: (status: string) => void;
}) {
  const health = healthLine(summary);
  const [open, setOpen] = useState(false);
  const entries = summary.entries.slice(0, 5);

  const chip = (e: { status: string; count: number }) => (
    <button
      key={e.status}
      onClick={() => onPickStatus?.(e.status)}
      aria-label={`${e.count} ${e.status}: focus these runs`}
      title={`${e.count} ${e.status}`}
      className="group flex items-baseline gap-1 rounded-md px-1 transition hover:bg-surface-hover"
    >
      {/* The data is king: near-black, the rest is quiet. */}
      <span className="font-data tabular text-sm font-semibold text-content-strong">{e.count}</span>
      <span className="text-xs text-content-secondary group-hover:text-content">{e.status}</span>
    </button>
  );

  return (
    <div className="flex items-center gap-3">
      <span className="flex items-center gap-2 text-sm font-medium text-content">
        <BreathingDot tone={health.tone} />
        {health.text}
      </span>

      {entries.length > 0 && (
        <>
          {/* Roomy enough to show the chips inline */}
          <span className="hidden items-center gap-3 md:flex">{entries.map(chip)}</span>

          {/* Tight: one persistent toggle that reveals and hides the counts (never a
              silent drop). aria-expanded tracks state and the control toggles both ways. */}
          <div className="flex flex-wrap items-center gap-3 md:hidden">
            <button
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={open ? "Hide run state counts" : `Show counts for ${entries.length} run states`}
              className="rounded-md px-1.5 py-0.5 text-xs font-medium text-content-secondary transition hover:bg-surface-hover hover:text-content"
            >
              {open ? "Hide states" : `+${entries.length} states`}
            </button>
            {open && <span className="flex flex-wrap items-center gap-3">{entries.map(chip)}</span>}
          </div>
        </>
      )}
    </div>
  );
}
