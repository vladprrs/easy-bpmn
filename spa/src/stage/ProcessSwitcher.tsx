// The process switcher (top-left) — the current process name in display type, and the
// only breadcrumb the operator needs. Click → switch process. Backed by GET /sagas.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Workflow, Search } from "lucide-react";
import type { SagaSummary } from "../api/types";
import { Popover } from "./primitives";
import { Dot } from "../components/ui";
import { summarize } from "./model";

function toneOf(s: SagaSummary): "danger" | "accent" | "muted" {
  const sum = summarize(s.counts);
  if (sum.attention > 0) return "danger";
  if (sum.live > 0) return "accent";
  return "muted";
}

export function ProcessSwitcher({ sagas, current }: { sagas: SagaSummary[]; current: SagaSummary | null }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  const filtered = q ? sagas.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())) : sagas;

  return (
    <Popover
      width={300}
      ariaLabel="Switch process"
      trigger={({ toggle, ref, open }) => (
        <button
          ref={ref as any}
          onClick={toggle}
          className="group flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left transition hover:bg-surface-hover"
        >
          <Workflow className="h-4 w-4 shrink-0 text-accent" />
          <span className="min-w-0 max-w-[40vw] truncate font-display text-lg leading-none text-content-strong">
            {current?.name ?? "Process"}
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-content-muted transition ${open ? "rotate-180" : ""}`} />
        </button>
      )}
    >
      {(close) => (
        <div className="w-[300px]">
          {sagas.length > 7 && (
            <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
              <Search className="h-3.5 w-3.5 text-content-muted" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter processes"
                className="w-full bg-transparent text-sm text-content outline-none placeholder:text-content-secondary"
              />
            </div>
          )}
          <ul className="max-h-[60vh] overflow-auto p-1.5">
            {filtered.map((s) => {
              const sum = summarize(s.counts);
              const active = s.sagaId === current?.sagaId;
              return (
                <li key={s.sagaId}>
                  <button
                    onClick={() => {
                      navigate(`/console/p/${encodeURIComponent(s.sagaId)}`);
                      close();
                    }}
                    aria-current={active || undefined}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition hover:bg-surface-hover ${
                      active ? "bg-accent-soft" : ""
                    }`}
                  >
                    <Dot tone={toneOf(s)} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-content">{s.name}</span>
                    <span className="font-data tabular text-2xs text-content-secondary">
                      {sum.live > 0 ? `${sum.live} live` : sum.total > 0 ? `${sum.total}` : "idle"}
                      {sum.attention > 0 && <span className="ml-1 text-[var(--red-700)]">!{sum.attention}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-content-secondary">No processes match.</li>
            )}
          </ul>
        </div>
      )}
    </Popover>
  );
}
