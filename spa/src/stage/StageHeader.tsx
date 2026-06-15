// The floating stage header — the ONE glass surface in the console. Carries the run /
// aggregate identity (the page <h1>), its defining metric (elapsed / live count), and the
// controls that sit ON the stage (instance switcher, mode toggle, actions, details).
// Single-instance and aggregate variants. Everything else in the console is matte.

import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Check, Copy, Crosshair, Layers, PanelRightOpen, RotateCcw } from "lucide-react";
import type { ProcessInstanceInspection, SagaHeatmap, SagaSummary } from "../api/types";
import type { ElementIndex } from "../lib/elements";
import { Button } from "../components/ui";
import { StatusBadge } from "../components/StatusBadge";
import { InstanceSwitcher } from "./InstanceSwitcher";
import { formatDuration, LIVE_STATUSES } from "./model";
import { humanizeProcessName } from "../lib/humanize";

const prefersReducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// A header metric, not a stopwatch: tick coarsely (30s) so a live run reads as alive
// without re-rendering the whole header every second, and memoize the formatted parts.
function useElapsed(
  startIso: string | null,
  endIso: string | null | undefined,
  live: boolean,
): { value: string; label: string } | null {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [live]);
  return useMemo(() => {
    if (!startIso) return null;
    const start = new Date(startIso).getTime();
    const end = endIso ? new Date(endIso).getTime() : Date.now();
    return { value: formatDuration(end - start), label: live ? "elapsed" : "ran" };
    // tick is an intentional refresh trigger; Date.now() is read at compute time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startIso, endIso, live, tick]);
}

// The confident mono numeral that anchors a run's / process's state — the one big
// number in the header (Commit Mono 500, tabular, 40px). The value carries the weight;
// the label is a quiet micro-caption (General Sans, AA) baseline-aligned beside it.
function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex shrink-0 items-baseline gap-1.5">
      <span className="font-data tabular text-2xl font-medium leading-none text-content-strong">{value}</span>
      <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-content-secondary">{label}</span>
    </div>
  );
}

// The raw id, demoted to a quiet copyable mono sub-line beneath the headline. A tiny
// General Sans caption names it ("run" / "saga"); the click copies, and a settled-green
// check confirms (the confirmation is a STATE swap, fully legible without motion — the
// scale-in is a one-shot flourish skipped under prefers-reduced-motion).
function CopyableId({ caption, id }: { caption: string; id: string }) {
  const [copied, setCopied] = useState(false);
  const iconRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!copied) return;
    const el = iconRef.current;
    if (el && !prefersReducedMotion()) {
      el.animate(
        [
          { opacity: 0, transform: "scale(0.5)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        { duration: 220, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
      );
    }
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(id).then(
          () => setCopied(true),
          () => {},
        );
      }}
      title={`${caption} id · ${id} (click to copy)`}
      className="group/id -mx-1 mt-0.5 flex min-w-0 max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-surface-hover"
    >
      <span className="shrink-0 text-2xs font-semibold uppercase tracking-[0.08em] text-content-secondary">
        {caption}
      </span>
      <span className="truncate font-data text-xs text-content-secondary">{id}</span>
      <span
        className={`grid h-3 w-3 shrink-0 place-items-center text-content-muted transition-opacity ${
          copied ? "opacity-100" : "opacity-0 group-hover/id:opacity-100"
        }`}
        aria-hidden
      >
        {copied ? <Check ref={iconRef} className="h-3 w-3 text-ok" /> : <Copy className="h-3 w-3" />}
      </span>
    </button>
  );
}

export function StageHeader({
  mode,
  saga,
  instance,
  heatmap,
  index,
  workspaceId,
  onToggleMode,
  onOpenDetails,
  canCancel,
  canRetry,
  isStuck,
  onRequestCancel,
  onRetry,
  acting,
}: {
  mode: "single" | "aggregate";
  saga: SagaSummary | null;
  instance: ProcessInstanceInspection | undefined;
  heatmap: SagaHeatmap | undefined;
  index: ElementIndex;
  workspaceId: string;
  onToggleMode: () => void;
  onOpenDetails: () => void;
  canCancel: boolean;
  canRetry: boolean;
  isStuck: boolean;
  onRequestCancel: () => void;
  onRetry: () => void;
  acting: boolean;
}) {
  const live = !!instance && LIVE_STATUSES.has(instance.status);
  const elapsed = useElapsed(instance?.startedAt ?? null, instance?.completedAt, live);
  // The page <h1>: a confident human process name, never a raw saga id. The id itself
  // lives on, quiet and copyable, in the mono sub-line below.
  const processName = humanizeProcessName(saga?.name, saga?.sagaId);

  return (
    <div className="glass pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-4 py-2.5">
      {mode === "single" && instance ? (
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-display text-xl text-content-strong">{processName}</h1>
              <StatusBadge status={instance.status} />
            </div>
            <CopyableId caption="run" id={instance.businessKey || instance.correlationKey} />
          </div>
          {elapsed && (
            <>
              <span className="hidden h-9 w-px shrink-0 bg-line sm:block" aria-hidden />
              <Metric value={elapsed.value} label={elapsed.label} />
            </>
          )}
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <div className="min-w-0">
            <h1 className="truncate font-display text-xl text-content-strong">{processName}</h1>
            {saga?.sagaId ? (
              <CopyableId caption="saga" id={saga.sagaId} />
            ) : (
              <div className="mt-0.5 text-xs text-content-secondary">where work sits now</div>
            )}
          </div>
          <span className="hidden h-9 w-px shrink-0 bg-line sm:block" aria-hidden />
          {heatmap ? (
            <Metric value={String(heatmap.totalLive)} label="live" />
          ) : (
            <span className="shrink-0 text-xs text-content-secondary">Reading the field…</span>
          )}
        </div>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {saga && (
          <InstanceSwitcher
            workspaceId={workspaceId}
            sagaId={saga.sagaId}
            currentInstanceId={instance?.instanceId ?? null}
            currentLabel={mode === "single" && instance ? instance.businessKey || instance.correlationKey : null}
            index={index}
          />
        )}

        {/* Mode toggle — a single run ⇄ the whole process. Read-only: it focuses the view,
            it never executes, so the labels avoid any run/play verb. */}
        <div className="flex items-center rounded-lg border border-line bg-surface-card p-0.5">
          <button
            onClick={() => mode === "aggregate" && onToggleMode()}
            aria-pressed={mode === "single"}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              mode === "single" ? "bg-accent-hover text-white shadow-sm" : "text-content-secondary hover:text-content"
            }`}
          >
            <Crosshair className="h-3.5 w-3.5" /> <span className="sr-only lg:not-sr-only">This run</span>
          </button>
          <button
            onClick={() => mode === "single" && onToggleMode()}
            aria-pressed={mode === "aggregate"}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              mode === "aggregate" ? "bg-accent-hover text-white shadow-sm" : "text-content-secondary hover:text-content"
            }`}
          >
            <Layers className="h-3.5 w-3.5" /> <span className="sr-only lg:not-sr-only">All runs</span>
          </button>
        </div>

        {canRetry && (
          <Button variant="primary" onClick={onRetry} disabled={acting}>
            <RotateCcw className="h-4 w-4" /> {isStuck ? "Resume" : "Retry"}
          </Button>
        )}
        {canCancel && (
          <Button variant="danger" onClick={onRequestCancel} disabled={acting}>
            <Ban className="h-4 w-4" /> Cancel
          </Button>
        )}
        <Button variant="ghost" onClick={onOpenDetails} title="Details">
          <PanelRightOpen className="h-4 w-4" /> <span className="sr-only lg:not-sr-only">Details</span>
        </Button>
      </div>
    </div>
  );
}
