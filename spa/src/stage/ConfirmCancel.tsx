// Confidence for the rare destructive moment (visual-design-brief §5, §6, MoT-3): show
// the consequence — the reverse pass — BEFORE the click. Lists the completed steps that
// will compensate, in reverse order. The server stays authoritative (a 409 → "state
// changed, refresh"). A "Preview reverse flow" toggle animates it on the diagram.

import { useEffect } from "react";
import { Ban, PlayCircle } from "lucide-react";
import type { CompensationPreviewItem } from "../lib/compensation";
import type { ElementIndex } from "../lib/elements";
import { Button } from "../components/ui";

export function ConfirmCancel({
  open,
  preview,
  index,
  acting,
  reversePreviewing,
  onToggleReversePreview,
  onConfirm,
  onClose,
}: {
  open: boolean;
  preview: CompensationPreviewItem[];
  index: ElementIndex;
  acting: boolean;
  reversePreviewing: boolean;
  onToggleReversePreview: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[400] grid place-items-center bg-scrim p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Cancel this run" className="anim-rise w-full max-w-md rounded-xl border border-line bg-surface-card p-5 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-1 text-base font-semibold text-content-strong">Cancel this run?</div>
        <p className="mb-3 text-sm text-content-secondary">
          Cancelling triggers compensation. These completed steps roll back, in reverse order:
        </p>
        {preview.length === 0 ? (
          <div className="mb-4 rounded-md border border-line bg-surface-sunken p-3 text-sm text-content-muted">
            Nothing pending to compensate — the run moves to a terminal state.
          </div>
        ) : (
          <ol className="mb-3 max-h-52 space-y-1 overflow-auto rounded-md border border-line bg-surface-sunken p-3">
            {preview.map((p, i) => (
              <li key={`${p.elementId}-${p.seq}`} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className="font-data text-2xs text-content-muted">{i + 1}</span>
                  <span className="font-data text-content">{index.nameOf(p.elementId)}</span>
                </span>
                <span className="font-data text-xs text-warn">{p.compensationTaskType || p.compensationElementId || "—"}</span>
              </li>
            ))}
          </ol>
        )}
        {preview.length > 0 && (
          <button
            onClick={onToggleReversePreview}
            className={`mb-4 flex items-center gap-1.5 text-sm font-medium transition ${
              reversePreviewing ? "text-accent" : "text-content-secondary hover:text-accent"
            }`}
          >
            <PlayCircle className="h-4 w-4" />
            {reversePreviewing ? "Previewing reverse flow on the diagram" : "Preview the reverse flow"}
          </button>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Keep running</Button>
          <Button variant="danger" onClick={onConfirm} disabled={acting}>
            <Ban className="h-4 w-4" /> Cancel &amp; roll back
          </Button>
        </div>
      </div>
    </div>
  );
}
