import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { AlertOctagon, Ban, Copy, Download, RotateCcw } from "lucide-react";
import { ApiError, api } from "../api/client";
import { subscribeInstanceHistory, type LiveStatus } from "../api/stream";
import type { HistoryEvent, ProcessInstanceInspection } from "../api/types";
import { useApp } from "../store";
import { Breadcrumb } from "../components/Layout";
import { StatusBadge } from "../components/StatusBadge";
import { Badge, Button, Card, ErrorState, KeyVal, Spinner } from "../components/ui";
import { Panel, Tabs } from "../components/Tabs";
import { Timeline } from "../components/Timeline";
import { JsonView } from "../components/JsonView";
import { buildElementIndex } from "../lib/elements";
import { compensationPreview } from "../lib/compensation";
import { canCancel, canRetry, isStuck } from "../lib/guards";
import { formatTime, relativeTime } from "../lib/format";
import type { DiagramOverlay } from "../components/BpmnViewer";

const BpmnViewer = lazy(() => import("../components/BpmnViewer"));

function mergeEvents(prev: HistoryEvent[], next: HistoryEvent[]): HistoryEvent[] {
  if (next.length === 0) return prev;
  const seen = new Set(prev.map((e) => e.historyEventId));
  const add = next.filter((e) => !seen.has(e.historyEventId));
  return add.length ? [...prev, ...add] : prev;
}

function computeOverlay(instance: ProcessInstanceInspection | undefined, events: HistoryEvent[]): DiagramOverlay {
  const traversed = new Set<string>();
  for (const e of events) if (e.elementId) traversed.add(e.elementId);

  const current = new Set<string>();
  const liveStatuses = ["active", "waiting", "arrivedAtJoin"];
  if (instance?.tokens?.length) {
    for (const t of instance.tokens) if (liveStatuses.includes(t.status)) current.add(t.positionElementId);
  } else if (instance?.currentElementId) {
    current.add(instance.currentElementId);
  }

  const failed = (instance?.openIncidents ?? []).map((i) => ({ elementId: i.elementId, reason: i.reason }));

  const compensated = new Set<string>();
  for (const s of instance?.saga?.steps ?? []) {
    if (s.compensationStatus === "compensated") {
      compensated.add(s.elementId);
      if (s.compensationElementId) compensated.add(s.compensationElementId);
    }
  }

  const badges: DiagramOverlay["badges"] = [];
  const decided = new Set<string>();
  for (const e of events) {
    if ((e.type === "gatewayDecisionEvaluated" || e.type === "ebgDecision") && e.elementId && !decided.has(e.elementId)) {
      decided.add(e.elementId);
      const chosen = e.diagnostics?.chosenFlowId;
      badges.push({ elementId: e.elementId, text: typeof chosen === "string" ? `→ ${chosen}` : "decided", tone: "accent" });
    }
  }
  for (const t of instance?.timers ?? []) {
    badges.push({
      elementId: t.elementId,
      text: t.status === "fired" ? "⏰ fired" : t.status === "armed" ? "⏱ armed" : "⏱ cancelled",
      tone: t.status === "fired" ? "warn" : "accent",
    });
  }

  return {
    traversed: [...traversed],
    current: [...current],
    failed,
    compensated: [...compensated],
    badges,
  };
}

export function Instance() {
  const { instanceId = "" } = useParams();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const workspaceId = useApp((s) => s.workspaceId);

  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [live, setLive] = useState<LiveStatus>("connecting");
  const [selectedElement, setSelectedElement] = useState<string | null>(null);
  const [tab, setTab] = useState("timeline");
  const [confirming, setConfirming] = useState<null | "cancel">(null);
  const [acting, setActing] = useState(false);
  const startedRef = useRef(false);

  const instanceQ = useQuery({ queryKey: ["instance", instanceId], queryFn: () => api.instance(instanceId) });
  const instance = instanceQ.data;
  const versionId = instance?.definitionVersionId ?? null;

  const historyQ = useQuery({ queryKey: ["history", instanceId], queryFn: () => api.instanceHistory(instanceId) });
  const versionXml = useQuery({ queryKey: ["bpmn", versionId], queryFn: () => api.versionBpmn(versionId!), enabled: !!versionId });
  const version = useQuery({ queryKey: ["version", versionId], queryFn: () => api.version(versionId!), enabled: !!versionId });
  const jobsQ = useQuery({ queryKey: ["jobs", instanceId], queryFn: () => api.instanceJobs(instanceId) });

  const index = useMemo(() => buildElementIndex(version.data), [version.data]);

  // Reset live stream when the instance changes.
  useEffect(() => {
    setEvents([]);
    startedRef.current = false;
  }, [instanceId]);

  // Seed timeline from the initial history page.
  useEffect(() => {
    if (historyQ.data) setEvents((prev) => mergeEvents(prev, historyQ.data.events));
  }, [historyQ.data]);

  // Live tail from the initial cursor (subscribe once per instance).
  useEffect(() => {
    if (!historyQ.isSuccess || startedRef.current) return;
    startedRef.current = true;
    const handle = subscribeInstanceHistory(instanceId, historyQ.data.nextCursor, {
      onEvents: (ne) => {
        setEvents((prev) => mergeEvents(prev, ne));
        qc.invalidateQueries({ queryKey: ["instance", instanceId] });
        qc.invalidateQueries({ queryKey: ["jobs", instanceId] });
      },
      onStatus: setLive,
    });
    return () => handle.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyQ.isSuccess, instanceId]);

  const overlay = useMemo(() => computeOverlay(instance, events), [instance, events]);
  const preview = useMemo(() => compensationPreview(instance?.saga), [instance?.saga]);
  const status = instance?.status ?? "";

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ["instance", instanceId] });
    qc.invalidateQueries({ queryKey: ["history", instanceId] });
    qc.invalidateQueries({ queryKey: ["jobs", instanceId] });
  };

  const doCancel = async () => {
    setActing(true);
    try {
      await api.cancel(instanceId);
      toast("success", "Cancel accepted — compensation starting.");
      setConfirming(null);
      refetchAll();
    } catch (e) {
      if (e instanceof ApiError && e.isConflict) toast("error", "State changed under you — refreshing.");
      else toast("error", e instanceof Error ? e.message : "Cancel failed.");
      refetchAll();
    } finally {
      setActing(false);
    }
  };

  const doRetry = async () => {
    setActing(true);
    try {
      await api.retry(instanceId);
      toast("success", isStuck(status) ? "Resume accepted." : "Retry accepted.");
      refetchAll();
    } catch (e) {
      if (e instanceof ApiError && e.isConflict) toast("error", "State changed under you — refreshing.");
      else toast("error", e instanceof Error ? e.message : "Retry failed.");
      refetchAll();
    } finally {
      setActing(false);
    }
  };

  const copyPermalink = () => {
    navigator.clipboard?.writeText(window.location.href).then(
      () => toast("success", "Permalink copied."),
      () => toast("error", "Copy failed."),
    );
  };

  const exportTimeline = () => {
    const blob = new Blob([JSON.stringify({ instanceId, status, events }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `instance-${instanceId}-history.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (instanceQ.isLoading) return <Spinner label="Loading instance…" />;
  if (instanceQ.error) return <ErrorState error={instanceQ.error} />;
  if (!instance) return null;

  const hasSaga = !!instance.saga || index.hasTransaction;

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumb
        items={[
          { label: "Projects", to: "/console" },
          { label: "Sagas", to: `/console/p/${workspaceId}` },
          { label: instance.businessKey || instance.correlationKey },
        ]}
      />

      {/* Header */}
      <Card className="mb-4 mt-2 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <StatusBadge status={status} />
              <span className="font-mono text-sm text-slate-300">{instance.instanceId}</span>
            </div>
            <div className="grid gap-0.5">
              <KeyVal k="business key">{instance.businessKey || "—"}</KeyVal>
              <KeyVal k="correlation">{instance.correlationKey}</KeyVal>
              <KeyVal k="version">{instance.definitionVersionId}</KeyVal>
              <KeyVal k="started">{formatTime(instance.startedAt)}</KeyVal>
              {instance.completedAt && <KeyVal k="completed">{formatTime(instance.completedAt)}</KeyVal>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canCancel(status) && (
              <Button variant="danger" onClick={() => setConfirming("cancel")} disabled={acting}>
                <Ban className="h-4 w-4" /> Cancel
              </Button>
            )}
            {canRetry(status) && (
              <Button variant="primary" onClick={doRetry} disabled={acting}>
                <RotateCcw className="h-4 w-4" /> {isStuck(status) ? "Resume" : "Retry"}
              </Button>
            )}
            <Button onClick={copyPermalink}>
              <Copy className="h-4 w-4" /> Permalink
            </Button>
            <Button onClick={exportTimeline} title="Export history (JSON)">
              <Download className="h-4 w-4" /> Export
            </Button>
          </div>
        </div>

        {isStuck(status) && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            <AlertOctagon className="h-4 w-4" />
            Compensation is stuck. The only safe action is <b>Resume</b> (retry the failed compensation step).
          </div>
        )}
      </Card>

      {/* Spine: diagram with live overlay */}
      <div className="mb-4">
        {versionXml.data ? (
          <Suspense fallback={<Card className="grid h-40 place-items-center text-xs text-slate-500">loading diagram…</Card>}>
            <BpmnViewer
              bpmnXml={versionXml.data.bpmnXml}
              elements={version.data?.elements ?? []}
              overlay={overlay}
              onSelectElement={(id) => setSelectedElement((cur) => (cur === id ? null : id))}
            />
          </Suspense>
        ) : (
          <Card className="grid h-32 place-items-center text-xs text-slate-500">loading diagram…</Card>
        )}
      </div>

      {/* Panels */}
      <Tabs
        tabs={[
          { id: "timeline", label: "Timeline", badge: events.length },
          { id: "variables", label: "Variables" },
          { id: "waiting", label: "Waiting on", badge: instance.subscriptions?.length, hidden: !instance.subscriptions?.length },
          { id: "saga", label: "Saga", hidden: !hasSaga },
          { id: "incidents", label: "Incidents", badge: instance.openIncidents?.length },
          { id: "timers", label: "Timers & Tokens", hidden: !(instance.timers?.length || instance.tokens?.length) },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "timeline" && (
        <Panel>
          <Timeline events={events} index={index} selectedElement={selectedElement} onSelectElement={setSelectedElement} live={live} />
        </Panel>
      )}

      {tab === "variables" && (
        <Panel>
          <JsonView value={instance.variables} />
        </Panel>
      )}

      {tab === "waiting" && (
        <Panel>
          <Card className="divide-y divide-ink-700">
            {instance.subscriptions?.map((s) => (
              <div key={s.subscriptionId} className="px-4 py-2.5 text-sm">
                <div className="flex items-center gap-2">
                  <Badge tone="info">{s.messageName}</Badge>
                  <span className="font-mono text-xs text-slate-400">{index.nameOf(s.elementId)}</span>
                </div>
                <div className="mt-1 font-mono text-xs text-slate-500">
                  key {s.correlationKey} · {s.bufferedCount} buffered{s.expiresAt ? ` · expires ${relativeTime(s.expiresAt)}` : ""}
                </div>
              </div>
            ))}
          </Card>
        </Panel>
      )}

      {tab === "saga" && (
        <Panel>
          {!instance.saga ? (
            <Card className="p-4 text-sm text-slate-500">No compensation scope in this process.</Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Card className="p-4">
                <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Ledger · phase {instance.saga.phase}</div>
                <ol className="space-y-1">
                  {instance.saga.steps.map((s) => (
                    <li key={`${s.elementId}-${s.seq}`} className="flex items-center justify-between text-sm">
                      <span className="font-mono text-slate-300">
                        #{s.seq} {index.nameOf(s.elementId)}
                      </span>
                      <Badge tone={s.compensationStatus === "compensated" ? "ok" : s.compensationStatus === "failed" ? "danger" : "muted"}>
                        {s.compensationStatus}
                      </Badge>
                    </li>
                  ))}
                </ol>
              </Card>
              <Card className="p-4">
                <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">If cancelled, compensates (reverse order)</div>
                {preview.length === 0 ? (
                  <div className="text-sm text-slate-500">Nothing pending to compensate.</div>
                ) : (
                  <ol className="space-y-1">
                    {preview.map((p) => (
                      <li key={`${p.elementId}-${p.seq}`} className="flex items-center justify-between text-sm">
                        <span className="font-mono text-slate-300">{index.nameOf(p.elementId)}</span>
                        <span className="font-mono text-xs text-warn">{p.compensationTaskType || p.compensationElementId || "—"}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            </div>
          )}
        </Panel>
      )}

      {tab === "incidents" && (
        <Panel>
          {(instance.openIncidents ?? []).length === 0 && (
            <Card className="p-4 text-sm text-slate-500">No open incidents.</Card>
          )}
          {(instance.openIncidents ?? []).map((inc) => (
            <Card key={inc.incidentId} className="mb-3 p-4">
              <div className="mb-1 flex items-center gap-2">
                <Badge tone="danger">{inc.kind || "incident"}</Badge>
                <span className="font-mono text-xs text-slate-400">{index.nameOf(inc.elementId)}</span>
                <span className="ml-auto text-xs text-slate-500">retry #{inc.retryCount}</span>
              </div>
              <div className="text-sm text-slate-300">{inc.reason}</div>
              {inc.payloadContext && <div className="mt-2"><JsonView value={inc.payloadContext} /></div>}
            </Card>
          ))}
          {/* Attempts drill-down (per worker_attempts). */}
          <div className="mt-2 text-xs uppercase tracking-wide text-slate-500">Jobs &amp; worker attempts</div>
          {jobsQ.data?.jobs.map((j) => (
            <Card key={j.jobId} className="mb-2 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-mono text-slate-300">
                  {index.nameOf(j.elementId)} {j.isCompensation && <Badge tone="warn">comp</Badge>}
                </span>
                <span className="flex items-center gap-2 text-xs text-slate-500">
                  {j.taskType} · <Badge tone={j.status === "completed" ? "ok" : j.status === "failed" ? "danger" : "muted"}>{j.status}</Badge>
                  {j.errorCode && <span className="text-danger">{j.errorCode}</span>}
                </span>
              </div>
              {j.attempts.length > 0 && (
                <ol className="mt-2 space-y-1 border-l border-ink-700 pl-3">
                  {j.attempts.map((a) => (
                    <li key={a.attemptNumber} className="text-xs">
                      <span className="text-slate-400">#{a.attemptNumber}</span>{" "}
                      <Badge tone={a.status === "succeeded" ? "ok" : a.status === "failed" ? "danger" : "muted"}>{a.status}</Badge>
                      {a.error && <span className="ml-1 text-danger">{a.error}</span>}
                      <span className="ml-1 text-slate-600">{relativeTime(a.startedAt)}</span>
                    </li>
                  ))}
                </ol>
              )}
              {(j.activationExpiresAt || j.lockExpiresAt) && (
                <div className="mt-1 font-mono text-[11px] text-slate-600">
                  {j.activationExpiresAt && `DLQ ${relativeTime(j.activationExpiresAt)} `}
                  {j.lockExpiresAt && `· lease ${relativeTime(j.lockExpiresAt)}`}
                </div>
              )}
            </Card>
          ))}
        </Panel>
      )}

      {tab === "timers" && (
        <Panel>
          <div className="grid gap-4 md:grid-cols-2">
            {instance.timers?.length ? (
              <Card className="p-4">
                <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Timers</div>
                {instance.timers.map((t) => (
                  <div key={t.timerId} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-slate-300">
                      {index.nameOf(t.elementId)} <span className="text-slate-600">{t.kind}</span>
                    </span>
                    <span className="flex items-center gap-2 text-xs">
                      <Badge tone={t.status === "fired" ? "warn" : t.status === "armed" ? "accent" : "muted"}>{t.status}</Badge>
                      <span className="text-slate-500">{relativeTime(t.fireAt)}</span>
                    </span>
                  </div>
                ))}
              </Card>
            ) : null}
            {instance.tokens?.length ? (
              <Card className="p-4">
                <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Token frontier</div>
                {instance.tokens.map((t) => (
                  <div key={t.tokenId} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-slate-300">{index.nameOf(t.positionElementId)}</span>
                    <Badge tone={["active", "waiting", "arrivedAtJoin"].includes(t.status) ? "accent" : "muted"}>{t.status}</Badge>
                  </div>
                ))}
              </Card>
            ) : null}
          </div>
        </Panel>
      )}

      {/* Cancel confirmation with compensation preview (MoT-3). */}
      {confirming === "cancel" && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setConfirming(null)}>
          <Card className="w-full max-w-md p-5" >
            <div className="mb-2 text-base font-semibold text-slate-100">Cancel this instance?</div>
            <p className="mb-3 text-sm text-slate-400">
              Cancelling triggers compensation. The following completed steps will be compensated in reverse order:
            </p>
            {preview.length === 0 ? (
              <div className="mb-3 rounded border border-ink-700 bg-ink-900 p-3 text-sm text-slate-500">
                Nothing pending to compensate — the instance will move to a terminal state.
              </div>
            ) : (
              <ol className="mb-3 max-h-48 space-y-1 overflow-auto rounded border border-ink-700 bg-ink-900 p-3">
                {preview.map((p) => (
                  <li key={`${p.elementId}-${p.seq}`} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-slate-300">{index.nameOf(p.elementId)}</span>
                    <span className="font-mono text-xs text-warn">{p.compensationTaskType || "—"}</span>
                  </li>
                ))}
              </ol>
            )}
            <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
              <Button onClick={() => setConfirming(null)}>Keep running</Button>
              <Button variant="danger" onClick={doCancel} disabled={acting}>
                <Ban className="h-4 w-4" /> Cancel &amp; compensate
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
