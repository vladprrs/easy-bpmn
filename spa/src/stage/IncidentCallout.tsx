// The rare, sharp punctuation (visual-design-brief §5): a precise, unpanicked callout
// for the run that needs the operator — which node, why, what next. compensationFailed
// gets a Resume-only banner (a "final cancel" would 409 per the server guard-rails).
//
// Carved, not floated: a solid (opaque) card with a solid coral hairline carrying the
// alert meaning, lifted by a single restrained drop (shadow-md) because it overlays
// the live diagram. No glass, no wide diffuse glow.

import { AlertOctagon, AlertTriangle, RotateCcw, Ban } from "lucide-react";
import type { ProcessInstanceInspection } from "../api/types";
import type { ElementIndex } from "../lib/elements";
import { Button, Badge } from "../components/ui";
import { humanize } from "../lib/humanize";
import { isLineageChild } from "../lib/lineage";

export function IncidentCallout({
  instance,
  index,
  onRetry,
  onRequestCancel,
  acting,
}: {
  instance: ProcessInstanceInspection;
  index: ElementIndex;
  onRetry: () => void;
  onRequestCancel: () => void;
  acting: boolean;
}) {
  const stuck = instance.status === "compensationFailed";
  const inc = instance.openIncidents?.[0];
  // M5-L2 (Task 11): a callActivity child's lifecycle is entirely a function of
  // its parent's step-state machine (the server 409s a direct cancel/retry on
  // one) — the callout still names the trouble, it just never offers a verb
  // the API would refuse.
  const isChild = isLineageChild(instance.lineage);

  if (stuck) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="pointer-events-auto max-w-md rounded-card border border-danger bg-surface-card p-4 shadow-md"
      >
        <div className="flex items-start gap-2.5">
          <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-content-strong">Roll-back stalled. This one needs you.</div>
            <p className="mt-1 text-sm text-content-secondary">
              The flow ran backward and stopped at a compensation step. The one safe move is to resume it.
            </p>
            {!isChild && (
              <div className="mt-3">
                <Button variant="primary" onClick={onRetry} disabled={acting}>
                  <RotateCcw className="h-4 w-4" /> Resume roll-back
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!inc) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto max-w-md rounded-card border border-danger bg-surface-card p-4 shadow-md"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-content-strong">{index.nameOf(inc.elementId)} failed</span>
            <Badge tone="danger">{humanize(inc.kind || "incident").title}</Badge>
          </div>
          <p className="mt-1 text-sm text-content-secondary">{inc.reason}</p>
          <div className="mt-1 font-data text-xs text-content-secondary">
            retried <span className="tabular">{inc.retryCount}</span>×
            {inc.resolution ? ` · ${humanize(inc.resolution).title}` : ""}
          </div>
          {!isChild && (
            <div className="mt-3 flex items-center gap-2">
              <Button variant="primary" onClick={onRetry} disabled={acting}>
                <RotateCcw className="h-4 w-4" /> Retry
              </Button>
              <Button variant="danger" onClick={onRequestCancel} disabled={acting}>
                <Ban className="h-4 w-4" /> Cancel &amp; roll back
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
