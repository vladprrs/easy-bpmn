// Confidence for the rare destructive moment (visual-design-brief §5, §6, MoT-3): show
// the consequence — the reverse pass — BEFORE the click. Lists the completed steps that
// will compensate, in reverse order. The server stays authoritative (a 409 → "state
// changed, refresh"). A "Preview reverse flow" toggle animates it on the diagram.
// The consequence text is the most legible thing here: dark-amber ink on the sunken
// panel (AA), the safe "Keep running" takes focus, Tab is trapped, focus is restored.

import { useEffect, useRef } from "react";
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Open: remember the trigger, drop focus on the SAFE action, restore on close.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>(".cc-safe")?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  // Keep Tab inside the dialog while it's modal.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes);
    const first = list[0];
    const last = list[list.length - 1];
    const here = document.activeElement;
    if (e.shiftKey && here === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && here === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-[400] grid place-items-center bg-scrim p-4" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Cancel this run"
        aria-describedby="cc-desc cc-consequence"
        className="anim-rise w-full max-w-md rounded-card border border-line bg-surface-card p-5 shadow-md"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="mb-1 text-base font-semibold text-content-strong">Cancel this run?</div>
        <p id="cc-desc" className="mb-3 text-sm text-content-secondary">
          Cancelling triggers compensation. These completed steps roll back, in reverse order:
        </p>
        {preview.length === 0 ? (
          <div
            id="cc-consequence"
            className="mb-4 rounded-md border border-line bg-surface-sunken p-3 text-sm text-content-secondary"
          >
            Nothing pending to compensate. The run moves straight to a terminal state.
          </div>
        ) : (
          <ol
            id="cc-consequence"
            className="mb-3 max-h-52 space-y-1 overflow-auto rounded-md border border-line bg-surface-sunken p-3"
          >
            {preview.map((p, i) => (
              <li key={`${p.elementId}-${p.seq}`} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-data text-xs tabular-nums text-content-secondary">{i + 1}</span>
                  <span className="truncate font-data text-content">{index.nameOf(p.elementId)}</span>
                </span>
                <span className="shrink-0 font-data text-sm text-[color:var(--amber-700)]">
                  {p.compensationTaskType || p.compensationElementId || "no handler"}
                </span>
              </li>
            ))}
          </ol>
        )}
        {preview.length > 0 && (
          <button
            onClick={onToggleReversePreview}
            aria-pressed={reversePreviewing}
            className={`mb-4 flex items-center gap-1.5 text-sm font-medium transition ${
              reversePreviewing ? "text-accent" : "text-content-secondary hover:text-accent"
            }`}
          >
            <PlayCircle className="h-4 w-4" />
            {reversePreviewing ? "Previewing reverse flow on the diagram" : "Preview the reverse flow"}
          </button>
        )}
        <div className="flex justify-end gap-2">
          <Button className="cc-safe" onClick={onClose}>
            Keep running
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={acting}>
            <Ban className="h-4 w-4" /> Cancel &amp; roll back
          </Button>
        </div>
      </div>
    </div>
  );
}
