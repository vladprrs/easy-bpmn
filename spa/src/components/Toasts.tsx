import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useApp, type ToastKind } from "../store";

const KIND: Record<ToastKind, { cls: string; Icon: typeof Info }> = {
  info: { cls: "border-info/40 bg-info/10 text-info", Icon: Info },
  success: { cls: "border-ok/40 bg-ok/10 text-ok", Icon: CheckCircle2 },
  error: { cls: "border-danger/40 bg-danger/10 text-danger", Icon: AlertCircle },
};

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const { cls, Icon } = KIND[t.kind];
        return (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={`anim-rise pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg ${cls}`}
          >
            <Icon className="mt-px h-4 w-4 shrink-0" />
            <span className="flex-1 text-content">{t.text}</span>
            <button
              onClick={() => dismiss(t.id)}
              title="Dismiss"
              className="-mr-0.5 rounded p-0.5 text-content-muted opacity-70 transition hover:bg-surface-hover hover:opacity-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
