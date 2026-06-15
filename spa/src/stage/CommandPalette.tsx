// ⌘K — the universal navigator (visual-design-brief §4, §6). One input to switch
// process, find a run by business/correlation key, jump to an attention item, or open
// a secondary surface (Messages, Versions). It is what lets the IA stay screen-free:
// finding is instant, so a browse-list is never needed. Keyboard-first.
//
// It is the IA hero, so it reads like a signature, not a cmdk clone: results sit under
// editorial section headers (Clash Display + a hairline rule); a single teal "current"
// indicator (a soft full-row tint + a full hairline ring, never a side-rail) *glides*
// between rows as you arrow (the diagram's live current, reused as the selection
// metaphor), and the active row's label goes teal too; the empty state TEACHES the IA
// instead of saying "nothing here"; and it is a real ARIA combobox (activedescendant,
// Tab-trapped, focus restored).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CornerDownLeft, Inbox, Play, Search, GitBranch, Workflow } from "lucide-react";
import { api } from "../api/client";
import type { AttentionItem, SagaSummary } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { Kbd, useDebounced } from "./primitives";
import { summarize } from "./model";

type Kind = "process" | "run" | "attention" | "surface";
type Row =
  | { kind: "process"; id: string; label: string; sub: string; go: () => void }
  | { kind: "run"; id: string; label: string; sub: string; status: string; go: () => void }
  | { kind: "attention"; id: string; label: string; sub: string; go: () => void }
  | { kind: "surface"; id: string; label: string; sub: string; go: () => void };

const GROUP: Record<Kind, string> = {
  process: "Processes",
  run: "Runs",
  attention: "Needs attention",
  surface: "Go to",
};

// The rest state teaches the IA in the console's own voice — the operator learns the
// colour language (process=teal, run=blue, alert=coral) before typing a character.
const HINTS: { icon: React.ReactNode; label: string; sub: string }[] = [
  { icon: <Workflow className="h-4 w-4 text-accent" />, label: "Switch process", sub: "type a process name" },
  { icon: <Play className="h-4 w-4 text-info" />, label: "Open a run", sub: "by business or correlation key" },
  { icon: <AlertTriangle className="h-4 w-4 text-danger" />, label: "Jump to what needs you", sub: "incidents and stuck roll-backs" },
  { icon: <Inbox className="h-4 w-4 text-content-muted" />, label: "Messages & versions", sub: "the secondary surfaces" },
];

// Single source of the reduced-motion preference for the gliding indicator.
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

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
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();

  // Open: reset, focus the input, and remember where focus came from so we can
  // hand it back when the palette closes.
  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    setQ("");
    setActive(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      restore?.focus?.();
    };
  }, [open]);

  // Local matches (processes, attention, surfaces) stay instant; only the run-index
  // network query waits for typing to settle.
  const qDebounced = useDebounced(q.trim(), 200);
  const runsQ = useQuery({
    queryKey: ["palette-runs", workspaceId, qDebounced],
    queryFn: () => api.instances({ workspaceId, search: qDebounced, limit: 8 }),
    enabled: open && qDebounced.length >= 2,
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

  // Render in sections while keeping the keyboard-active flat index intact.
  const groups = useMemo(() => {
    const order: Kind[] = ["process", "run", "attention", "surface"];
    const byKind = new Map<Kind, { row: Row; i: number }[]>();
    rows.forEach((row, i) => {
      const arr = byKind.get(row.kind) ?? [];
      arr.push({ row, i });
      byKind.set(row.kind, arr);
    });
    return order.filter((k) => byKind.has(k)).map((k) => ({ kind: k, label: GROUP[k], items: byKind.get(k)! }));
  }, [rows]);

  useEffect(() => setActive((a) => Math.min(a, Math.max(0, rows.length - 1))), [rows.length]);

  // Keep the keyboard-active row in view when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[active];
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // The teal "current": glide the selection rail to the active row (transform only).
  // Measured from the live DOM so it tracks variable group spacing; hidden when there
  // is nothing to select. Reduced-motion snaps — the end position is the legible state.
  useLayoutEffect(() => {
    const ind = indicatorRef.current;
    if (!ind) return;
    const opt = listRef.current?.querySelector<HTMLElement>(`#cmdk-opt-${active}`);
    if (!opt) {
      ind.style.opacity = "0";
      return;
    }
    ind.style.height = `${opt.offsetHeight}px`;
    ind.style.transform = `translateY(${opt.offsetTop}px)`;
    ind.style.opacity = "1";
  }, [active, rows.length, q, open]);

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
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      // The input is the sole tab stop; options are driven by aria-activedescendant.
      e.preventDefault();
      inputRef.current?.focus();
    }
  };

  const ICON = {
    process: <Workflow className="h-4 w-4 text-accent" />,
    run: <Play className="h-4 w-4 text-info" />,
    attention: <AlertTriangle className="h-4 w-4 text-danger" />,
    surface: <Inbox className="h-4 w-4 text-content-muted" />,
  } as const;

  const hasQuery = q.trim().length > 0;
  const runsErrored = runsQ.isError && qDebounced.length >= 2;
  const activeId = rows[active] ? `cmdk-opt-${active}` : undefined;

  return (
    <div
      className="fixed inset-0 z-[400] flex items-start justify-center bg-scrim p-4 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="anim-rise w-full max-w-xl overflow-hidden rounded-card border border-line bg-surface-card shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3.5">
          <Search className="h-[18px] w-[18px] shrink-0 text-content-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="cmdk-listbox"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search processes, runs and alerts"
            placeholder="Search processes, runs, alerts…"
            className="w-full bg-transparent text-lg font-medium tracking-[-0.01em] text-content outline-none placeholder:font-normal placeholder:tracking-normal placeholder:text-content-secondary"
          />
          <span className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap sm:flex">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span className="text-2xs text-content-secondary">navigate</span>
          </span>
        </div>

        <div
          ref={listRef}
          id="cmdk-listbox"
          role="listbox"
          aria-label="Results"
          className="relative max-h-[52vh] overflow-auto p-1.5"
        >
          {/* The gliding teal selection "current": a full-row soft tint + a full
              hairline ring (never a side-rail), echoing the diagram's live current. */}
          <div
            ref={indicatorRef}
            aria-hidden
            className="pointer-events-none absolute left-1.5 right-1.5 top-0 rounded-lg bg-accent-soft ring-1 ring-inset ring-[color:var(--accent-ring)]"
            style={{
              opacity: 0,
              transition: reduced
                ? "none"
                : "transform 0.24s cubic-bezier(0.22,1,0.36,1), opacity 0.16s ease-out",
            }}
          />

          {rows.length === 0 ? (
            runsErrored ? (
              <div className="px-4 py-12 text-center">
                <AlertTriangle className="mx-auto h-5 w-5 text-danger" />
                <div className="mt-2.5 font-display text-md text-content-strong">Couldn't search runs</div>
                <div className="mx-auto mt-1 max-w-xs text-xs text-content-secondary">
                  The run index didn't respond.{" "}
                  <button onClick={() => runsQ.refetch()} className="font-medium text-accent-press hover:underline">
                    Try again
                  </button>
                </div>
              </div>
            ) : hasQuery ? (
              <div className="px-4 py-12 text-center">
                <Search className="mx-auto h-5 w-5 text-content-muted" />
                <div className="mt-2.5 font-display text-md text-content-strong">
                  Nothing matches “{q.trim()}”
                </div>
                <div className="mx-auto mt-1 max-w-xs text-xs text-content-secondary">
                  Try a business key, a correlation key, or a shorter process name.
                </div>
              </div>
            ) : (
              <div className="px-3 py-4">
                <div className="px-2 font-display text-lg text-content-strong">Jump straight to any run.</div>
                <div className="mt-0.5 px-2 text-xs text-content-secondary">
                  Name a process, a run, or an alert and open it directly.
                </div>
                <div className="mt-3 space-y-0.5">
                  {HINTS.map((h) => (
                    <div key={h.label} className="flex items-center gap-3 rounded-lg px-3 py-2">
                      <span className="shrink-0">{h.icon}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-content">{h.label}</span>
                        <span className="block text-xs text-content-secondary">{h.sub}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          ) : (
            <>
              {runsErrored && (
                <div className="flex items-center justify-center gap-2 px-3 pt-2 text-xs text-content-secondary">
                  <span>Run search is unavailable.</span>
                  <button onClick={() => runsQ.refetch()} className="font-medium text-accent-press hover:underline">
                    Retry
                  </button>
                </div>
              )}
              {groups.map((g) => (
              <div key={g.kind} role="group" aria-label={g.label}>
                <div className="flex items-center gap-2.5 px-3 pb-1 pt-2.5">
                  <span className="font-display text-2xs uppercase tracking-[0.14em] text-content-muted">
                    {g.label}
                  </span>
                  <span className="h-px flex-1 bg-line/70" aria-hidden />
                </div>
                {g.items.map(({ row: r, i }) => (
                  <button
                    key={`${r.kind}-${r.id}`}
                    id={`cmdk-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => activate(r)}
                    className="relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left"
                  >
                    <span className="shrink-0">
                      {r.kind === "surface" && r.id === "versions" ? (
                        <GitBranch className="h-4 w-4 text-content-muted" />
                      ) : (
                        ICON[r.kind]
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-md font-semibold ${
                          i === active ? "text-accent-press" : "text-content-strong"
                        }`}
                      >
                        {r.label}
                      </span>
                      <span
                        className={`block truncate font-data text-xs ${
                          i === active ? "text-content" : "text-content-secondary"
                        }`}
                      >
                        {r.sub}
                      </span>
                    </span>
                    {r.kind === "run" && <StatusBadge status={r.status} />}
                    <span
                      aria-hidden
                      className={`hidden shrink-0 items-center rounded border border-line bg-surface-card px-1.5 py-0.5 text-content-secondary shadow-xs transition-opacity sm:flex ${
                        i === active ? "opacity-100" : "opacity-0"
                      }`}
                    >
                      <CornerDownLeft className="h-3 w-3" />
                    </span>
                  </button>
                ))}
              </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
