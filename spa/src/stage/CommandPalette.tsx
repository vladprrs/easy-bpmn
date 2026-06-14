// ⌘K — the universal navigator (visual-design-brief §4, §6). One input to switch
// process, find a run by business/correlation key, jump to an attention item, or open
// a secondary surface (Messages, Versions). It is what lets the IA stay screen-free:
// finding is instant, so a browse-list is never needed. Keyboard-first.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CornerDownLeft, Inbox, Play, Search, GitBranch, Workflow } from "lucide-react";
import { api } from "../api/client";
import type { AttentionItem, SagaSummary } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { summarize } from "./model";

type Row =
  | { kind: "process"; id: string; label: string; sub: string; go: () => void }
  | { kind: "run"; id: string; label: string; sub: string; status: string; go: () => void }
  | { kind: "attention"; id: string; label: string; sub: string; go: () => void }
  | { kind: "surface"; id: string; label: string; sub: string; go: () => void };

export function CommandPalette({
  open,
  onClose,
  sagas,
  attention,
  workspaceId,
  onOpenSurface,
}: {
  open: boolean;
  onClose: () => void;
  sagas: SagaSummary[];
  attention: AttentionItem[];
  workspaceId: string;
  onOpenSurface: (s: "messages" | "versions") => void;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const runsQ = useQuery({
    queryKey: ["palette-runs", workspaceId, q],
    queryFn: () => api.instances({ workspaceId, search: q, limit: 8 }),
    enabled: open && q.trim().length >= 2,
  });

  const rows = useMemo<Row[]>(() => {
    const term = q.trim().toLowerCase();
    const match = (s: string) => !term || s.toLowerCase().includes(term);
    const out: Row[] = [];

    for (const s of sagas.filter((s) => match(s.name)).slice(0, 6)) {
      const sum = summarize(s.counts);
      out.push({
        kind: "process",
        id: s.sagaId,
        label: s.name,
        sub: sum.live > 0 ? `${sum.live} live now` : sum.total > 0 ? `${sum.total} run${sum.total === 1 ? "" : "s"}` : "no runs yet",
        go: () => navigate(`/console/p/${encodeURIComponent(s.sagaId)}`),
      });
    }
    for (const i of runsQ.data?.instances ?? []) {
      out.push({
        kind: "run",
        id: i.instanceId,
        label: i.businessKey || i.correlationKey,
        sub: i.correlationKey,
        status: i.status,
        go: () => navigate(`/console/i/${encodeURIComponent(i.instanceId)}`),
      });
    }
    for (const a of attention.filter((a) => match((a.businessKey ?? "") + a.correlationKey + (a.sagaName ?? ""))).slice(0, 4)) {
      out.push({
        kind: "attention",
        id: a.instanceId,
        label: a.businessKey || a.correlationKey,
        sub: `${a.sagaName ?? a.sagaId ?? ""} · ${a.reason}`,
        go: () => a.sagaId && navigate(`/console/p/${encodeURIComponent(a.sagaId)}/i/${encodeURIComponent(a.instanceId)}`),
      });
    }
    if (match("messages"))
      out.push({ kind: "surface", id: "messages", label: "Messages", sub: "search correlation", go: () => onOpenSurface("messages") });
    if (match("versions"))
      out.push({ kind: "surface", id: "versions", label: "Versions", sub: "this process", go: () => onOpenSurface("versions") });
    return out;
  }, [q, sagas, attention, runsQ.data, navigate, onOpenSurface]);

  useEffect(() => setActive((a) => Math.min(a, Math.max(0, rows.length - 1))), [rows.length]);

  // Keep the keyboard-active row in view when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[active];
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const activate = (r: Row | undefined) => {
    if (!r) return;
    r.go();
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(rows[active]);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  const ICON = {
    process: <Workflow className="h-4 w-4 text-accent" />,
    run: <Play className="h-4 w-4 text-info" />,
    attention: <AlertTriangle className="h-4 w-4 text-danger" />,
    surface: <Inbox className="h-4 w-4 text-content-muted" />,
  } as const;

  return (
    <div
      className="fixed inset-0 z-[400] flex items-start justify-center bg-scrim p-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="anim-rise w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface-card shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-content-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search processes, runs and alerts"
            placeholder="Switch process, find a run by key, jump to an alert…"
            className="w-full bg-transparent text-md text-content outline-none placeholder:text-content-muted"
          />
          <span className="hidden shrink-0 items-center gap-1 whitespace-nowrap text-2xs text-content-muted sm:flex">
            <CornerDownLeft className="h-3 w-3" /> to open · esc to close
          </span>
        </div>
        <div ref={listRef} role="listbox" aria-label="Results" className="max-h-[52vh] overflow-auto p-1.5">
          {rows.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-content-muted">
              {q.trim().length >= 2 ? "Nothing matches." : "Type to search runs, or pick a process."}
            </div>
          )}
          {rows.map((r, i) => (
            <button
              key={`${r.kind}-${r.id}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => activate(r)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${
                i === active ? "bg-accent-soft" : "hover:bg-surface-hover"
              }`}
            >
              <span className="shrink-0">{r.kind === "surface" && r.id === "versions" ? <GitBranch className="h-4 w-4 text-content-muted" /> : ICON[r.kind]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-content">{r.label}</span>
                <span className="block truncate font-data text-2xs text-content-muted">{r.sub}</span>
              </span>
              {r.kind === "run" && <StatusBadge status={r.status} />}
              {r.kind === "process" && <span className="text-2xs uppercase tracking-wide text-content-muted">process</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
