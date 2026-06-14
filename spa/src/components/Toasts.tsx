import { X } from "lucide-react";
import { useApp } from "../store";

const KIND: Record<string, string> = {
  info: "border-info/40 bg-info/10 text-info",
  success: "border-ok/40 bg-ok/10 text-ok",
  error: "border-danger/40 bg-danger/10 text-danger",
};

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg ${KIND[t.kind]}`}
        >
          <span className="flex-1">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="opacity-60 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
