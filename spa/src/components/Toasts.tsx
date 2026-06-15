import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useApp, type ToastKind } from "../store";

// A solid card (no tinted-wash, no edge-stripe). Severity rides a FILLED tone
// icon-chip with a white glyph — the same vivid-chip language as the diagram
// activities — over dark, fully-legible body text.
const KIND: Record<ToastKind, { chip: string; Icon: typeof Info }> = {
  info: { chip: "bg-info", Icon: Info },
  success: { chip: "bg-ok", Icon: CheckCircle2 },
  error: { chip: "bg-danger", Icon: AlertCircle },
};

// Cap the stack so a burst never climbs past the top of the viewport; the most
// recent few stay readable and the rest collapse into a quiet count.
const MAX_VISIBLE_TOASTS = 4;

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  const visible = toasts.slice(-MAX_VISIBLE_TOASTS);
  const overflow = toasts.length - visible.length;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {overflow > 0 && (
        <div
          aria-hidden="true"
          className="self-center rounded-full border border-line bg-surface-card px-2.5 py-0.5 text-xs font-semibold text-content-secondary shadow-sm"
        >
          {overflow} more
        </div>
      )}
      {visible.map((t) => {
        const { chip, Icon } = KIND[t.kind];
        return (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className="anim-rise pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line bg-surface-card px-3 py-2.5 text-sm shadow-md"
          >
            <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md ${chip}`}>
              <Icon className="h-3.5 w-3.5 text-white" />
            </span>
            <span className="flex-1 text-content">{t.text}</span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              title="Dismiss"
              className="-mr-0.5 rounded p-0.5 text-content-secondary transition hover:bg-surface-hover hover:text-content"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
