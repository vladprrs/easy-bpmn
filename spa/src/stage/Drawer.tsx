// Depth on the same stage (visual-design-brief §4.7) — a right slide-over for the
// data layer: variables, worker attempts, saga ledger, timers/tokens, waiting-on,
// incidents, raw JSON, plus the process-scoped Messages + Versions surfaces (opened
// from ⌘K). Calm by default, dense on demand — the mono layer carries the rigor.
// Everything reads D1 via the existing endpoints.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Inbox, Search, X } from "lucide-react";
import { api } from "../api/client";
import type { InstanceJobView, ProcessInstanceInspection } from "../api/types";
import type { ElementIndex } from "../lib/elements";
import { JsonView } from "../components/JsonView";
import { Badge } from "../components/ui";
import { compensationPreview } from "../lib/compensation";
import { relativeTime } from "../lib/format";
import type { Tone } from "../lib/humanize";

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

  // Escape closes the slide-over (consistent with the palette and confirm dialogs).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[300] flex justify-end" role="dialog" aria-modal aria-label="Instance details">
      <div className="absolute inset-0 bg-scrim backdrop-blur-sm" onClick={onClose} />
      <aside className="anim-rise relative flex h-full w-full max-w-[30rem] flex-col border-l border-line bg-surface-card shadow-xl">
        <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => onTab(t)}
              className={`shrink-0 rounded-md px-2.5 py-1.5 text-sm font-medium transition ${
                t === tab ? "bg-accent-soft text-accent" : "text-content-secondary hover:bg-surface-hover hover:text-content"
              }`}
            >
              {LABEL[t]}
            </button>
          ))}
          <button onClick={onClose} className="ml-auto shrink-0 rounded-md p-1.5 text-content-muted transition hover:bg-surface-hover hover:text-content">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
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

function AttemptsPanel({ jobs, index }: { jobs: InstanceJobView[] | undefined; index: ElementIndex }) {
  if (!jobs?.length) return <Empty>No service-task jobs yet.</Empty>;
  return (
    <div className="space-y-2.5">
      {jobs.map((j) => (
        <div key={j.jobId} className="rounded-md border border-line p-3">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="font-medium text-content">
              {index.nameOf(j.elementId)} {j.isCompensation && <Badge tone="warn">comp</Badge>}
            </span>
            <span className="flex items-center gap-2 text-xs text-content-muted">
              <span className="font-data">{j.taskType}</span>
              <Badge tone={j.status === "completed" ? "ok" : j.status === "failed" ? "danger" : "muted"}>{j.status}</Badge>
            </span>
          </div>
          {j.attempts.length > 0 && (
            <ol className="mt-2 space-y-1 border-l border-line pl-3">
              {j.attempts.map((a) => (
                <li key={a.attemptNumber} className="text-xs">
                  <span className="text-content-secondary">#{a.attemptNumber}</span>{" "}
                  <Badge tone={a.status === "succeeded" ? "ok" : a.status === "failed" ? "danger" : "muted"}>{a.status}</Badge>
                  {a.error && <span className="ml-1 text-danger">{a.error}</span>}
                  <span className="ml-1 font-data text-content-muted">{relativeTime(a.startedAt)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}

function SagaPanel({ instance, index }: { instance: ProcessInstanceInspection | undefined; index: ElementIndex }) {
  const saga = instance?.saga;
  const preview = useMemo(() => compensationPreview(saga), [saga]);
  if (!saga) return <Empty>No compensation scope in this process.</Empty>;
  return (
    <div className="space-y-4">
      <div>
        <SectionLabel>Ledger · phase {saga.phase}</SectionLabel>
        <ol className="space-y-1">
          {saga.steps.map((s) => (
            <li key={`${s.elementId}-${s.seq}`} className="flex items-center justify-between text-sm">
              <span className="font-data text-content">
                #{s.seq} {index.nameOf(s.elementId)}
              </span>
              <Badge tone={s.compensationStatus === "compensated" ? "ok" : s.compensationStatus === "failed" ? "danger" : "muted"}>
                {s.compensationStatus}
              </Badge>
            </li>
          ))}
        </ol>
      </div>
      <div>
        <SectionLabel>If cancelled, compensates (reverse order)</SectionLabel>
        {preview.length === 0 ? (
          <Empty>Nothing pending to compensate.</Empty>
        ) : (
          <ol className="space-y-1">
            {preview.map((p) => (
              <li key={`${p.elementId}-${p.seq}`} className="flex items-center justify-between text-sm">
                <span className="font-data text-content">{index.nameOf(p.elementId)}</span>
                <span className="font-data text-xs text-warn">{p.compensationTaskType || p.compensationElementId || "—"}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function TimersPanel({ instance, index }: { instance: ProcessInstanceInspection | undefined; index: ElementIndex }) {
  const timers = instance?.timers ?? [];
  const tokens = instance?.tokens ?? [];
  if (!timers.length && !tokens.length) return <Empty>No timers or live tokens.</Empty>;
  return (
    <div className="space-y-4">
      {timers.length > 0 && (
        <div>
          <SectionLabel>Timers</SectionLabel>
          {timers.map((t) => (
            <div key={t.timerId} className="flex items-center justify-between py-0.5 text-sm">
              <span className="font-data text-content">
                {index.nameOf(t.elementId)} <span className="text-content-muted">{t.kind}</span>
              </span>
              <span className="flex items-center gap-2 text-xs">
                <Badge tone={t.status === "fired" ? "warn" : t.status === "armed" ? "accent" : "muted"}>{t.status}</Badge>
                <span className="font-data text-content-muted">{relativeTime(t.fireAt)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {tokens.length > 0 && (
        <div>
          <SectionLabel>Token frontier</SectionLabel>
          {tokens.map((t) => (
            <div key={t.tokenId} className="flex items-center justify-between py-0.5 text-sm">
              <span className="font-data text-content">{index.nameOf(t.positionElementId)}</span>
              <Badge tone={["active", "waiting", "arrivedAtJoin"].includes(t.status) ? "accent" : "muted"}>{t.status}</Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WaitingPanel({ instance, index }: { instance: ProcessInstanceInspection | undefined; index: ElementIndex }) {
  const subs = instance?.subscriptions ?? [];
  if (!subs.length) return <Empty>Not waiting on any message.</Empty>;
  return (
    <div className="space-y-2.5">
      {subs.map((s) => (
        <div key={s.subscriptionId} className="rounded-md border border-line p-3 text-sm">
          <div className="flex items-center gap-2">
            <Badge tone="info">{s.messageName}</Badge>
            <span className="font-data text-xs text-content-secondary">{index.nameOf(s.elementId)}</span>
          </div>
          <div className="mt-1 font-data text-xs text-content-muted">
            key {s.correlationKey} · {s.bufferedCount} buffered{s.expiresAt ? ` · expires ${relativeTime(s.expiresAt)}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function IncidentsPanel({ instance, index }: { instance: ProcessInstanceInspection | undefined; index: ElementIndex }) {
  const incidents = instance?.openIncidents ?? [];
  if (!incidents.length) return <Empty>No open incidents.</Empty>;
  return (
    <div className="space-y-3">
      {incidents.map((inc) => (
        <div key={inc.incidentId} className="rounded-md border border-danger/30 bg-danger/5 p-3">
          <div className="mb-1 flex items-center gap-2">
            <Badge tone="danger">{inc.kind || "incident"}</Badge>
            <span className="font-data text-xs text-content-secondary">{index.nameOf(inc.elementId)}</span>
            <span className="ml-auto text-2xs text-content-muted">retry #{inc.retryCount}</span>
          </div>
          <div className="text-sm text-content">{inc.reason}</div>
          {inc.payloadContext && (
            <div className="mt-2">
              <JsonView value={inc.payloadContext} />
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
  const q = useQuery({
    queryKey: ["messages", workspaceId, name, key],
    queryFn: () => api.messages({ workspaceId, messageName: name || undefined, correlationKey: key || undefined }),
  });
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 rounded-md border border-line px-2 focus-within:border-accent">
          <Search className="h-3.5 w-3.5 text-content-muted" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="message name" className="w-full bg-transparent py-1.5 text-sm outline-none" />
        </div>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="correlation key" className="w-full rounded-md border border-line px-2.5 py-1.5 text-sm outline-none focus:border-accent" />
      </div>
      {q.isLoading && <Empty>Searching…</Empty>}
      {q.data && q.data.messages.length === 0 && <Empty>No messages match. Un-correlated late/rejected messages also surface here.</Empty>}
      <div className="space-y-1.5">
        {q.data?.messages.map((m) => (
          <div key={m.externalMessageId} className="rounded-md border border-line p-2.5 text-sm">
            <div className="flex items-center gap-2">
              <Badge tone={OUTCOME_TONE[m.finalOutcome] ?? "muted"}>{m.finalOutcome}</Badge>
              <span className="min-w-0 flex-1 truncate text-content">{m.messageName}</span>
              <span className="shrink-0 text-2xs text-content-muted">{relativeTime(m.receivedAt)}</span>
            </div>
            <div className="mt-1 truncate font-data text-2xs text-content-muted">
              key {m.correlationKey}
              {m.reason ? ` · ${m.reason}` : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function VersionsPanel({ sagaId }: { sagaId: string }) {
  const q = useQuery({ queryKey: ["saga", sagaId], queryFn: () => api.sagaDetail(sagaId) });
  if (q.isLoading) return <Empty>Loading versions…</Empty>;
  const detail = q.data;
  if (!detail) return <Empty>No version history.</Empty>;
  return (
    <div className="space-y-1.5">
      {detail.versions.map((v) => (
        <div key={v.definitionVersionId} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm">
          <span className="flex items-center gap-2">
            <span className="font-medium text-content">v{v.versionNumber}</span>
            {v.definitionVersionId === detail.activeVersionId && <Badge tone="ok">active</Badge>}
            <span className="font-data text-2xs text-content-muted">{v.definitionVersionId.slice(-8)}</span>
          </span>
          <span className="text-2xs text-content-muted">
            {v.instanceCount} run{v.instanceCount === 1 ? "" : "s"} · {relativeTime(v.publishedAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-10 text-center text-sm text-content-muted">
      <Inbox className="h-5 w-5 opacity-50" />
      {children}
    </div>
  );
}
