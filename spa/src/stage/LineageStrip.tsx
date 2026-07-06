// The Lineage strip (M5-L2 callActivity, Task 11): a parent breadcrumb (← this run
// was CALLED by another) and/or a row of child chips (→ calls this run made), each
// a live status pill that jumps straight to that run. Same idiom as the rest of the
// console (useNavigate + the `/console/i/:instanceId` deep-link, self-canonicalising
// once its saga resolves — Stage.tsx). Solid card, matte (no glass — glass is
// StageHeader-only). Renders nothing when there is no lineage to show.

import { useNavigate } from "react-router-dom";
import { ArrowUpLeft, GitBranch } from "lucide-react";
import type { InstanceLineage } from "../api/types";
import type { ElementIndex } from "../lib/elements";
import { hasLineage, sortedLineageChildren } from "../lib/lineage";
import { StatusBadge } from "../components/StatusBadge";
import { shortId } from "../lib/format";

export function LineageStrip({ lineage, index }: { lineage: InstanceLineage; index: ElementIndex }) {
  const navigate = useNavigate();
  if (!hasLineage(lineage)) return null;

  const go = (instanceId: string) => navigate(`/console/i/${encodeURIComponent(instanceId)}`);
  const children = sortedLineageChildren(lineage);

  return (
    <div
      role="navigation"
      aria-label="Call lineage"
      className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-card px-3 py-2 text-xs shadow-xs"
    >
      {lineage.parent && (
        <button
          type="button"
          onClick={() => go(lineage.parent!.instanceId)}
          title={`Called from ${lineage.parent!.instanceId} at ${lineage.parent!.elementId ?? "an unknown step"}`}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-content-secondary transition hover:bg-surface-hover hover:text-content"
        >
          <ArrowUpLeft className="h-3.5 w-3.5 text-accent" aria-hidden />
          <span>
            Called from{" "}
            <span className="font-data text-content">
              {lineage.parent.elementId ?? shortId(lineage.parent.instanceId)}
            </span>
          </span>
        </button>
      )}

      {lineage.parent && children.length > 0 && <span className="h-4 w-px bg-line" aria-hidden />}

      {children.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-content-muted" aria-hidden />
          <span className="text-content-secondary">Calls</span>
          {children.map((c) => (
            <button
              key={`${c.elementId}#${c.occurrence}@${c.iterationIndex}`}
              type="button"
              onClick={() => go(c.childInstanceId)}
              title={`${index.nameOf(c.elementId)} · ${c.childInstanceId}`}
              className="flex items-center gap-1.5 rounded-md border border-line bg-surface-page px-2 py-1 transition hover:border-line-strong hover:bg-surface-hover"
            >
              <span className="font-data text-content">{index.nameOf(c.elementId)}</span>
              {c.occurrence > 0 && <span className="text-2xs text-content-muted">#{c.occurrence}</span>}
              {c.iterationIndex > 0 && <span className="text-2xs text-content-muted">·i{c.iterationIndex}</span>}
              <StatusBadge status={c.status} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
