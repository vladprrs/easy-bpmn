// The rare, sharp punctuation (visual-design-brief §5): a precise, unpanicked callout
// for the run that needs the operator — which node, why, what next. compensationFailed
// gets a Resume-only banner (a "final cancel" would 409 per the server guard-rails).

import { AlertOctagon, AlertTriangle, RotateCcw, Ban } from "lucide-react";
import type { ProcessInstanceInspection } from "../api/types";
import type { ElementIndex } from "../lib/elements";
import { Button } from "../components/ui";

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

  if (stuck) {
    return (
      <div className="pointer-events-auto max-w-md rounded-xl border border-danger/40 bg-surface-card/95 p-3.5 shadow-lg backdrop-blur">
        <div className="flex items-start gap-2.5">
          <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-content-strong">Roll-back stalled — this one needs you</div>
            <p className="mt-0.5 text-sm text-content-secondary">
              The flow ran backward and stopped at a compensation step. The one safe move is to resume it.
            </p>
            <div className="mt-2.5">
              <Button variant="primary" onClick={onRetry} disabled={acting}>
                <RotateCcw className="h-4 w-4" /> Resume roll-back
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!inc) return null;

  return (
    <div className="pointer-events-auto max-w-md rounded-xl border border-danger/40 bg-surface-card/95 p-3.5 shadow-lg backdrop-blur">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-content-strong">{index.nameOf(inc.elementId)} failed</span>
            <span className="rounded-full bg-danger/10 px-1.5 py-0.5 font-data text-2xs text-danger">{inc.kind || "incident"}</span>
          </div>
          <p className="mt-0.5 text-sm text-content-secondary">{inc.reason}</p>
          <div className="mt-1 font-data text-2xs text-content-muted">
            retried {inc.retryCount}×{inc.resolution ? ` · ${inc.resolution}` : ""}
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <Button variant="primary" onClick={onRetry} disabled={acting}>
              <RotateCcw className="h-4 w-4" /> Retry
            </Button>
            <Button variant="danger" onClick={onRequestCancel} disabled={acting}>
              <Ban className="h-4 w-4" /> Cancel &amp; roll back
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
