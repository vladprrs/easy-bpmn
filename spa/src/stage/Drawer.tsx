// Depth on the same stage (visual-design-brief §4.7) — a right slide-over for the
// data layer: variables, worker attempts, saga ledger, timers/tokens, waiting-on,
// incidents, raw JSON, plus the process-scoped Messages + Versions surfaces (opened
// from ⌘K). Calm by default, dense on demand — the mono layer carries the rigor.
// Everything reads D1 via the existing endpoints.
//
// Each panel has its OWN shape so the eye can tell them apart at a glance: Attempts
// is a timeline rail, the Saga ledger is a dense tabular-nums table, Messages is a
// compact log. Every engine enum is humanized — a raw camelCase status never shows.

import { useEffect, useMemo, useRef, useState, type DependencyList } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Inbox, RotateCcw, Search, X } from "lucide-react";
import { api } from "../api/client";
import type { InstanceJobView, ProcessInstanceInspection } from "../api/types";
import type { ElementIndex } from "../lib/elements";
import { JsonView } from "../components/JsonView";
import { StatusBadge } from "../components/StatusBadge";
import { Badge } from "../components/ui";
import { compensationPreview } from "../lib/compensation";
import { relativeTime } from "../lib/format";
import { humanize, type Tone } from "../lib/humanize";

export type DrawerTab =
  | "variables"
  | "attempts"
  | "saga"
  | "timers"
  | "waiting"
  | "incidents"
  | "raw"
  | "messages"
  | "versions";

const LABEL: Record<DrawerTab, string> = {
  variables: "Variables",
  attempts: "Attempts",
  saga: "Saga",
  timers: "Timers & tokens",
  waiting: "Waiting on",
  incidents: "Incidents",
  raw: "Raw",
  messages: "Messages",
  versions: "Versions",
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="tech-label mb-2">{children}</div>;
}

// Honors the OS reduced-motion setting; mirrors the diagram's guard so the console
// keeps one motion contract.
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// Tasteful staggered reveal of a panel's rows. Each panel is conditionally rendered,
// so switching tabs remounts it and replays the reveal; async panels pass their row
// count in `deps` so it fires once the data lands. WAAPI only (transform/opacity,
// exponential ease-out, no global keyframes). Reduced motion → a no-op: every row is
// already in its final, fully legible state, so nothing lives only in the motion.
function useStaggerRows<T extends HTMLElement>(deps: DependencyList) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || prefersReducedMotion()) return;
    const rows = Array.from(node.querySelectorAll<HTMLElement>("[data-row]"));
    const anims = rows
      .map((el, i) => {
        if (typeof el.animate !== "function") return null;
        return el.animate(
          [
            { opacity: 0, transform: "translateY(7px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 320, delay: Math.min(i * 34, 300), easing: "cubic-bezier(0.16,1,0.3,1)", fill: "both" },
        );
      })
      .filter((a): a is Animation => a !== null);
    return () => anims.forEach((a) => a.cancel());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

export function Drawer({
  open,
  onClose,
  tab,
  onTab,
  instance,
  jobs,
  index,
  sagaId,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  tab: DrawerTab;
  onTab: (t: DrawerTab) => void;
  instance: ProcessInstanceInspection | undefined;
  jobs: InstanceJobView[] | undefined;
  index: ElementIndex;
  sagaId: string | null;
  workspaceId: string;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<Partial<Record<DrawerTab, HTMLButtonElement | null>>>({});

  const tabs = useMemo<DrawerTab[]>(() => {
    const t: DrawerTab[] = [];
    if (instance) {
      t.push("variables", "attempts");
      if (instance.saga) t.push("saga");
      if (instance.timers?.length || instance.tokens?.length) t.push("timers");
      if (instance.subscriptions?.length) t.push("waiting");
      if (instance.openIncidents?.length) t.push("incidents");
      t.push("raw");
    }
    t.push("messages");
    if (sagaId) t.push("versions");
    return t;
  }, [instance, sagaId]);

  // Keep the active tab valid as context changes.
  useEffect(() => {
    if (open && !tabs.includes(tab)) onTab(tabs[0] ?? "messages");
  }, [open, tabs, tab, onTab]);

  // Keep the selected tab visible: up to 9 tabs live in an overflow-x scroller.
  // Default (instant) scroll, so there is no motion to gate for reduced-motion.
  useEffect(() => {
    if (open) tabRefs.current[tab]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open, tab]);

  // Roving tabindex: arrows move selection + focus across the tablist (Home/End jump
  // to the ends), so the whole strip is one Tab stop per the WAI-ARIA tabs pattern.
  const onTablistKey = (e: React.KeyboardEvent) => {
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const nt = tabs[next];
    onTab(nt);
    tabRefs.current[nt]?.focus();
  };

  // Real dialog: capture the trigger, move focus inside on open, restore it on close.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const node = drawerRef.current;
    const first = node?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (first ?? node)?.focus();
    return () => restoreRef.current?.focus?.();
  }, [open]);

  // Escape closes; Tab is trapped within the slide-over (consistent with the palette).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const node = drawerRef.current;
      if (!node) return;
      const focusable = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (el) => !el.hasAttribute("disabled") && el.offsetParent !== null && el.getAttribute("tabindex") !== "-1",
      );
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[300] flex justify-end">
      <div className="absolute inset-0 bg-scrim" onClick={onClose} />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal
        aria-label="Instance details"
        tabIndex={-1}
        className="anim-rise relative flex h-full w-full max-w-[30rem] flex-col border-l border-line bg-surface-card shadow-xl focus:outline-none"
      >
        <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
          <div
            role="tablist"
            aria-label="Instance detail sections"
            onKeyDown={onTablistKey}
            className="flex flex-1 items-center gap-1 overflow-x-auto"
          >
            {tabs.map((t) => (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[t] = el;
                }}
                role="tab"
                id={`drawer-tab-${t}`}
                aria-selected={t === tab}
                aria-controls={`drawer-panel-${t}`}
                tabIndex={t === tab ? 0 : -1}
                onClick={() => onTab(t)}
                className={`shrink-0 rounded-md px-2.5 py-1.5 text-sm font-medium transition ${
                  t === tab ? "bg-accent-soft text-accent" : "text-content-secondary hover:bg-surface-hover hover:text-content"
                }`}
              >
                {LABEL[t]}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            aria-label="Close instance details"
            className="shrink-0 rounded-md p-1.5 text-content-secondary transition hover:bg-surface-hover hover:text-content"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          role="tabpanel"
          id={`drawer-panel-${tab}`}
          aria-labelledby={`drawer-tab-${tab}`}
          tabIndex={0}
          className="flex-1 overflow-auto p-4 focus:outline-none"
        >
          {tab === "variables" && <JsonView value={instance?.variables} />}
          {tab === "raw" && <JsonView value={instance} />}
          {tab === "attempts" && <AttemptsPanel jobs={jobs} index={index} />}
          {tab === "saga" && <SagaPanel instance={instance} index={index} />}
          {tab === "timers" && <TimersPanel instance={instance} index={index} />}
          {tab === "waiting" && <WaitingPanel instance={instance} index={index} />}
          {tab === "incidents" && <IncidentsPanel instance={instance} index={index} />}
          {tab === "messages" && <MessagesPanel workspaceId={workspaceId} />}
          {tab === "versions" && sagaId && <VersionsPanel sagaId={sagaId} />}
        </div>
      </aside>
    </div>
  );
}

// Tone maps kept domain-local; the human label always flows through StatusBadge.
function jobTone(status: string): Tone {
  return status === "completed" ? "ok" : status === "failed" ? "danger" : "muted";
}
function attemptDot(status: string): string {
  return status === "succeeded" ? "bg-ok" : status === "failed" ? "bg-danger" : "bg-line-strong";
}

function AttemptsPanel({ jobs, index }: { jobs: InstanceJobView[] | undefined; index: ElementIndex }) {
  const attemptCount = jobs?.reduce((n, j) => n + Math.max(1, j.attempts.length), 0) ?? 0;
  const ref = useStaggerRows<HTMLDivElement>([attemptCount]);
  if (!jobs) return <SkeletonRows rows={3} />;
  if (!jobs.length) return <Empty>No service-task jobs yet.</Empty>;
  return (
    <div ref={ref} className="space-y-7">
      {jobs.map((j) => (
        <section key={j.jobId}>
          <header className="flex items-baseline justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm font-medium text-content">
              {index.nameOf(j.elementId)}
              {j.isCompensation && <Badge tone="warn">roll-back</Badge>}
            </span>
            <StatusBadge status={j.status} tone={jobTone(j.status)} />
          </header>
          <div className="mt-0.5 font-data text-xs text-content-secondary">{j.taskType}</div>
          {j.attempts.length > 0 && (
            <ol className="relative mt-3 space-y-2.5 pl-4">
              {/* one continuous rail, inset to run dot-to-dot — the attempt journey */}
              <span aria-hidden className="pointer-events-none absolute left-0 top-2 bottom-2 w-px bg-line" />
              {j.attempts.map((a) => (
                <li data-row key={a.attemptNumber} className="relative text-xs leading-relaxed">
                  <span
                    aria-hidden
                    className={`absolute -left-[19px] top-[5px] h-[7px] w-[7px] rounded-full ring-2 ring-surface-card ${attemptDot(a.status)}`}
                  />
                  <div className="flex items-center gap-1.5">
                    <span className="font-data tabular text-content-secondary">#{a.attemptNumber}</span>
                    <span className="font-medium text-content">{humanize(a.status).title}</span>
                    <span className="ml-auto font-data tabular text-content-secondary">{relativeTime(a.startedAt)}</span>
                  </div>
                  {a.error && <div className="mt-0.5 break-words text-danger-hover">{a.error}</div>}
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}

function SagaPanel({ instance, index }: { instance: ProcessInstanceInspection | undefined; index: ElementIndex }) {
  const saga = instance?.saga;
  const preview = useMemo(() => compensationPreview(saga), [saga]);
  const ref = useStaggerRows<HTMLDivElement>([saga?.steps.length ?? 0, preview.length]);
  if (!instance) return <SkeletonRows />;
  if (!saga) return <Empty>No compensation scope in this process.</Empty>;
  const stepTone = (s: string): Tone => (s === "compensated" ? "ok" : s === "failed" ? "danger" : "muted");
  return (
    <div ref={ref} className="space-y-6">
      <div>
        <SectionLabel>Ledger · {humanize(saga.phase).title}</SectionLabel>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-content-secondary">
              <th className="w-7 pb-1.5 pr-2 text-left text-2xs font-semibold uppercase tracking-[0.06em]">#</th>
              <th className="pb-1.5 pr-2 text-left text-2xs font-semibold uppercase tracking-[0.06em]">Step</th>
              <th className="pb-1.5 text-right text-2xs font-semibold uppercase tracking-[0.06em]">State</th>
            </tr>
          </thead>
          <tbody>
            {saga.steps.map((s) => (
              <tr data-row key={`${s.elementId}-${s.seq}`} className="border-t border-line/60">
                <td className="w-7 py-1.5 pr-2 align-baseline font-data tabular text-content-secondary">{s.seq}</td>
                <td className="py-1.5 pr-2 align-baseline text-content">{index.nameOf(s.elementId)}</td>
                <td className="py-1.5 text-right align-baseline">
                  <StatusBadge status={s.compensationStatus} tone={stepTone(s.compensationStatus)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <SectionLabel>If cancelled, compensates (reverse order)</SectionLabel>
        {preview.length === 0 ? (
          <Empty>Nothing pending to compensate.</Empty>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {preview.map((p, i) => (
                <tr data-row key={`${p.elementId}-${p.seq}`} className="border-b border-line/60 last:border-0">
                  <td className="w-7 py-1.5 pr-2 align-baseline font-data tabular text-content-secondary">{i + 1}</td>
                  <td className="py-1.5 pr-2 align-baseline text-content">{index.nameOf(p.elementId)}</td>
                  <td className="py-1.5 text-right align-baseline font-data text-xs text-[color:var(--amber-700)]">
                    {p.compensationTaskType || p.compensationElementId || "none"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function TimersPanel({ instance, index }: { instance: ProcessInstanceInspection | undefined; index: ElementIndex }) {
  const timers = instance?.timers ?? [];
  const tokens = instance?.tokens ?? [];
  const ref = useStaggerRows<HTMLDivElement>([timers.length, tokens.length]);
  if (!instance) return <SkeletonRows />;
  if (!timers.length && !tokens.length) return <Empty>No timers or live tokens.</Empty>;
  return (
    <div ref={ref} className="space-y-6">
      {timers.length > 0 && (
        <div>
          <SectionLabel>Timers</SectionLabel>
          <div className="divide-y divide-line/70">
            {timers.map((t) => (
              <div data-row key={t.timerId} className="flex items-center justify-between gap-2 py-2 text-sm first:pt-0">
                <span className="min-w-0 truncate">
                  <span className="text-content" title={index.nameOf(t.elementId)}>
                    {index.nameOf(t.elementId)}
                  </span>
                  <span className="ml-1.5 text-content-secondary">{humanize(t.kind).title}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={t.status} tone={t.status === "fired" ? "warn" : t.status === "armed" ? "accent" : "muted"} />
                  <span className="font-data tabular text-xs text-content-secondary">{relativeTime(t.fireAt)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {tokens.length > 0 && (
        <div>
          <SectionLabel>Token frontier</SectionLabel>
          <div className="divide-y divide-line/70">
            {tokens.map((t) => (
              <div data-row key={t.tokenId} className="flex items-center justify-between gap-2 py-2 text-sm first:pt-0">
                <span className="min-w-0 truncate text-content" title={index.nameOf(t.positionElementId)}>
                  {index.nameOf(t.positionElementId)}
                </span>
                <StatusBadge
                  status={t.status}
                  tone={["active", "waiting", "arrivedAtJoin"].includes(t.status) ? "accent" : "muted"}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WaitingPanel({ instance, index }: { instance: ProcessInstanceInspection | undefined; index: ElementIndex }) {
  const subs = instance?.subscriptions ?? [];
  const ref = useStaggerRows<HTMLDivElement>([subs.length]);
  if (!subs.length) return <Empty>Not waiting on any message.</Empty>;
  return (
    <div ref={ref} className="divide-y divide-line/70">
      {subs.map((s) => (
        <div data-row key={s.subscriptionId} className="py-3 first:pt-0">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium text-content" title={s.messageName}>
              {s.messageName}
            </span>
            <span className="shrink-0 text-xs text-content-secondary" title={index.nameOf(s.elementId)}>
              {index.nameOf(s.elementId)}
            </span>
          </div>
          <div className="mt-1 font-data text-xs text-content-secondary">
            <span className="tabular">{s.bufferedCount}</span> buffered · key <span className="break-all">{s.correlationKey}</span>
            {s.expiresAt ? (
              <>
                {" "}
                · expires <span className="tabular">{relativeTime(s.expiresAt)}</span>
              </>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function IncidentsPanel({ instance, index }: { instance: ProcessInstanceInspection | undefined; index: ElementIndex }) {
  const incidents = instance?.openIncidents ?? [];
  const ref = useStaggerRows<HTMLDivElement>([incidents.length]);
  if (!instance) return <SkeletonRows />;
  if (!incidents.length) return <Empty>No open incidents.</Empty>;
  return (
    <div ref={ref} className="space-y-3">
      {incidents.map((inc) => (
        <div data-row key={inc.incidentId} className="rounded-md border border-danger/30 bg-danger/5 p-3.5">
          <div className="mb-1.5 flex items-center gap-2">
            <Badge tone="danger">{humanize(inc.kind || "incident").title}</Badge>
            <span className="truncate text-xs text-content-secondary" title={index.nameOf(inc.elementId)}>
              {index.nameOf(inc.elementId)}
            </span>
            <span className="ml-auto shrink-0 font-data tabular text-xs text-content-secondary">retry #{inc.retryCount}</span>
          </div>
          <div className="text-sm text-content">{inc.reason}</div>
          {inc.payloadContext && (
            <div className="mt-2.5">
              <JsonView value={inc.payloadContext} bare />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const OUTCOME_TONE: Record<string, Tone> = {
  correlated: "ok",
  buffered: "info",
  duplicate: "muted",
  expired: "warn",
  late: "warn",
  rejected: "danger",
  invariantViolation: "danger",
};

function MessagesPanel({ workspaceId }: { workspaceId: string }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  // Debounce the filters before they reach the queryKey so a fast typist fires one
  // request after they pause, not one per keystroke.
  const dName = useDebounced(name, 250);
  const dKey = useDebounced(key, 250);
  const q = useQuery({
    queryKey: ["messages", workspaceId, dName, dKey],
    queryFn: () => api.messages({ workspaceId, messageName: dName || undefined, correlationKey: dKey || undefined }),
  });
  const ref = useStaggerRows<HTMLDivElement>([q.data?.messages.length ?? 0]);
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 rounded-md border border-line px-2 focus-within:border-accent">
          <Search className="h-3.5 w-3.5 text-content-secondary" />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="message name"
            aria-label="Filter messages by name"
            className="w-full bg-transparent py-1.5 text-sm outline-none placeholder:text-content-muted"
          />
        </div>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="correlation key"
          aria-label="Filter messages by correlation key"
          className="w-full rounded-md border border-line px-2.5 py-1.5 text-sm outline-none placeholder:text-content-muted focus:border-accent"
        />
      </div>
      {q.isError ? (
        <ErrorState onRetry={() => q.refetch()}>Couldn't load messages.</ErrorState>
      ) : q.isLoading ? (
        <SkeletonRows rows={5} variant="log" />
      ) : q.data && q.data.messages.length === 0 ? (
        <Empty>No messages match. Un-correlated late or rejected messages also surface here.</Empty>
      ) : (
        // a compact log: a fixed mono timestamp gutter, the entry to its right
        <div ref={ref} className="-mx-2">
          {q.data?.messages.map((m) => (
            <div
              data-row
              key={m.externalMessageId}
              className="grid grid-cols-[3.5rem_1fr] gap-x-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-hover"
            >
              <span className="pt-px text-right font-data tabular text-2xs text-content-secondary">{relativeTime(m.receivedAt)}</span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusBadge status={m.finalOutcome} tone={OUTCOME_TONE[m.finalOutcome] ?? "muted"} />
                  <span className="min-w-0 flex-1 truncate font-medium text-content" title={m.messageName}>
                    {m.messageName}
                  </span>
                </div>
                <div className="mt-0.5 break-all font-data text-2xs text-content-secondary">
                  key {m.correlationKey}
                  {m.reason ? ` · ${m.reason}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VersionsPanel({ sagaId }: { sagaId: string }) {
  const q = useQuery({ queryKey: ["saga", sagaId], queryFn: () => api.sagaDetail(sagaId) });
  const detail = q.data;
  const ref = useStaggerRows<HTMLDivElement>([detail?.versions.length ?? 0]);
  if (q.isError) return <ErrorState onRetry={() => q.refetch()}>Couldn't load version history.</ErrorState>;
  if (q.isLoading) return <SkeletonRows rows={4} />;
  if (!detail) return <Empty>No version history.</Empty>;
  return (
    <div ref={ref} className="divide-y divide-line/70">
      {detail.versions.map((v) => (
        <div data-row key={v.definitionVersionId} className="flex items-center justify-between gap-2 py-2.5 text-sm first:pt-0">
          <span className="flex items-center gap-2">
            <span className="font-medium text-content">v{v.versionNumber}</span>
            {v.definitionVersionId === detail.activeVersionId && <Badge tone="ok">active</Badge>}
            <span className="font-data text-xs text-content-secondary">{v.definitionVersionId.slice(-8)}</span>
          </span>
          <span className="shrink-0 text-xs text-content-secondary">
            <span className="tabular">{v.instanceCount}</span> run{v.instanceCount === 1 ? "" : "s"} ·{" "}
            <span className="tabular">{relativeTime(v.publishedAt)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// Hold a value back until it stops changing for `ms`, so search filters fire one
// request on pause instead of one per keystroke.
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

// A loading affordance that reads as "data is on its way", distinct from the empty
// state (which keeps the Inbox glyph for a genuinely empty result). The placeholder
// bars breathe on the shared cadence; reduced motion holds them still and fully
// legible, and the role/label announce the wait to assistive tech.
function SkeletonRows({ rows = 4, variant = "list" }: { rows?: number; variant?: "list" | "log" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || prefersReducedMotion() || typeof node.animate !== "function") return;
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--pulse").trim();
    const dur = parseFloat(raw) || 2600;
    const anim = node.animate([{ opacity: 0.55 }, { opacity: 1 }], {
      duration: dur,
      iterations: Infinity,
      direction: "alternate",
      easing: "ease-in-out",
    });
    return () => anim.cancel();
  }, []);
  return (
    <div ref={ref} role="status" aria-label="Loading" aria-live="polite" className="space-y-2.5 py-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5">
          {variant === "log" && <span aria-hidden className="h-3 w-12 shrink-0 rounded bg-line" />}
          <span aria-hidden className="h-3 flex-1 rounded bg-line" style={{ maxWidth: `${74 - (i % 3) * 14}%` }} />
        </div>
      ))}
    </div>
  );
}

// A recoverable read failure: say what failed plainly, then offer the one action.
function ErrorState({ onRetry, children }: { onRetry: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-content-secondary">
      <AlertTriangle className="h-5 w-5 text-danger" aria-hidden />
      <p>{children}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-content transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--state-focus-ring)]"
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        Retry
      </button>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-10 text-center text-sm text-content-secondary">
      <Inbox className="h-5 w-5 text-content-muted" />
      {children}
    </div>
  );
}
