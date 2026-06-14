// Global attention — cross-process triage as a POPOVER, never a screen. Present for
// on-call, never the mood. Each item deep-links to its run on the stage. GET /attention.

import { useNavigate } from "react-router-dom";
import { AlertTriangle, Check } from "lucide-react";
import type { AttentionItem } from "../api/types";
import { Popover } from "./primitives";
import { Badge } from "../components/ui";
import { relativeTime } from "../lib/format";
import type { Tone } from "../lib/humanize";

const REASON: Record<string, { tone: Tone; label: string }> = {
  incident: { tone: "danger", label: "incident" },
  compensationFailed: { tone: "danger", label: "roll-back stuck" },
  staleCompensating: { tone: "warn", label: "stale rollback" },
};

export function AttentionPopover({ items }: { items: AttentionItem[] }) {
  const navigate = useNavigate();
  const n = items.length;

  return (
    <Popover
      align="end"
      width={340}
      trigger={({ toggle, ref }) => (
        <button
          ref={ref as any}
          onClick={toggle}
          title="Needs attention (all processes)"
          className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium transition ${
            n > 0 ? "text-danger hover:bg-danger/10" : "text-content-secondary hover:bg-surface-hover"
          }`}
        >
          {n > 0 ? <AlertTriangle className="h-4 w-4" /> : <Check className="h-4 w-4 text-ok" />}
          {n > 0 ? <span className="font-data tabular">{n}</span> : <span className="hidden sm:inline">clear</span>}
        </button>
      )}
    >
      {(close) => (
        <div className="w-[340px]">
          <div className="border-b border-line px-3.5 py-2.5 text-2xs font-semibold uppercase tracking-[0.08em] text-content-muted">
            Needs attention · all processes
          </div>
          {n === 0 ? (
            <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
              <Check className="h-6 w-6 text-ok" />
              <div className="text-sm font-medium text-content">Nothing on fire</div>
              <div className="text-xs text-content-muted">No incidents or stuck roll-backs anywhere.</div>
            </div>
          ) : (
            <ul className="max-h-[60vh] overflow-auto p-1.5">
              {items.map((it) => {
                const r = REASON[it.reason] ?? { tone: "danger" as Tone, label: it.reason };
                return (
                  <li key={it.instanceId}>
                    <button
                      onClick={() => {
                        if (it.sagaId) navigate(`/console/p/${encodeURIComponent(it.sagaId)}/i/${encodeURIComponent(it.instanceId)}`);
                        close();
                      }}
                      className="w-full rounded-md px-2.5 py-2 text-left transition hover:bg-surface-hover"
                    >
                      <div className="flex items-center gap-2">
                        <Badge tone={r.tone}>{r.label}</Badge>
                        <span className="min-w-0 flex-1 truncate text-sm text-content">{it.sagaName || it.sagaId || "—"}</span>
                        <span className="shrink-0 text-2xs text-content-muted">{relativeTime(it.since)}</span>
                      </div>
                      <div className="mt-1 truncate font-data text-2xs text-content-muted">
                        {it.businessKey ? `${it.businessKey} · ` : ""}
                        {it.correlationKey}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Popover>
  );
}
