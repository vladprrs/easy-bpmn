// The floating stage header (glass) — instance headline + the controls that sit ON the
// stage (instance switcher, mode toggle, actions, details). Single-instance and
// aggregate variants. The chrome stays slim; this is the run/mode layer.

import { useEffect, useState } from "react";
import { Ban, Layers, PanelRightOpen, Play, RotateCcw, Sparkles } from "lucide-react";
import type { ProcessInstanceInspection, SagaHeatmap, SagaSummary } from "../api/types";
import type { ElementIndex } from "../lib/elements";
import { Button } from "../components/ui";
import { StatusBadge } from "../components/StatusBadge";
import { InstanceSwitcher } from "./InstanceSwitcher";
import { formatDuration, LIVE_STATUSES } from "./model";

function useElapsed(startIso: string | null, endIso: string | null | undefined, live: boolean): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
  if (!startIso) return "";
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  return `${live ? "elapsed" : "ran"} ${formatDuration(end - start)}`;
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

  return (
    <div className="glass pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-4 py-2.5">
      {mode === "single" && instance ? (
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-display text-xl text-content-strong">
                {instance.businessKey || instance.correlationKey}
              </span>
              <StatusBadge status={instance.status} />
            </div>
            <div className="font-data text-2xs text-content-muted">
              {elapsed}
              {instance.businessKey && <span className="text-content-secondary"> · {instance.correlationKey}</span>}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-soft text-accent">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate font-display text-xl text-content-strong">{saga?.name ?? "Process"}</div>
            <div className="font-data text-2xs text-content-muted">
              {heatmap
                ? `${heatmap.totalLive} live across ${heatmap.nodes.length} node${heatmap.nodes.length === 1 ? "" : "s"}`
                : "aggregate · where work sits now"}
            </div>
          </div>
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

        {/* Mode toggle — single (a run) ⇄ aggregate (the whole process). */}
        <div className="flex items-center rounded-lg border border-line bg-surface-card/80 p-0.5 shadow-xs backdrop-blur">
          <button
            onClick={() => mode === "aggregate" && onToggleMode()}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
              mode === "single" ? "bg-accent text-white shadow-sm" : "text-content-secondary hover:text-content"
            }`}
          >
            <Play className="h-3.5 w-3.5" /> Run
          </button>
          <button
            onClick={() => mode === "single" && onToggleMode()}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
              mode === "aggregate" ? "bg-accent text-white shadow-sm" : "text-content-secondary hover:text-content"
            }`}
          >
            <Layers className="h-3.5 w-3.5" /> All
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
          <PanelRightOpen className="h-4 w-4" /> Details
        </Button>
      </div>
    </div>
  );
}
