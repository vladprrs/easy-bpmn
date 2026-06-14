import { Suspense, lazy, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Search, Workflow } from "lucide-react";
import { api } from "../api/client";
import { useApp } from "../store";
import { Breadcrumb } from "../components/Layout";
import { Badge, Card, ErrorState, Spinner } from "../components/ui";
import { Panel, Tabs } from "../components/Tabs";
import { buildElementIndex } from "../lib/elements";
import { relativeTime } from "../lib/format";
import { StatusBadge } from "../components/StatusBadge";

const BpmnViewer = lazy(() => import("../components/BpmnViewer"));

const EMPTY_OVERLAY = { traversed: [], current: [], failed: [], compensated: [], badges: [] };

const STATUS_FILTERS = ["running", "waiting", "incident", "compensating", "compensationFailed", "completed", "compensated", "cancelled"];

export function SagaDetail() {
  const { sagaId = "" } = useParams();
  const workspaceId = useApp((s) => s.workspaceId);
  const [tab, setTab] = useState("instances");
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);

  const saga = useQuery({ queryKey: ["saga", sagaId], queryFn: () => api.sagaDetail(sagaId) });
  const activeVersionId = saga.data?.activeVersionId ?? null;

  const versionXml = useQuery({
    queryKey: ["bpmn", activeVersionId],
    queryFn: () => api.versionBpmn(activeVersionId!),
    enabled: !!activeVersionId,
  });
  const version = useQuery({
    queryKey: ["version", activeVersionId],
    queryFn: () => api.version(activeVersionId!),
    enabled: !!activeVersionId,
  });
  const elements = version.data?.elements ?? [];
  const index = useMemo(() => buildElementIndex(version.data), [version.data]);

  const instances = useQuery({
    queryKey: ["instances", workspaceId, sagaId, statuses, search],
    queryFn: () =>
      api.instances({
        workspaceId,
        sagaId,
        status: statuses.length ? statuses.join(",") : undefined,
        search: search || undefined,
      }),
    enabled: !!sagaId,
  });

  const toggleStatus = (s: string) => setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumb items={[{ label: "Projects", to: "/console" }, { label: "Sagas", to: `/console/p/${workspaceId}` }, { label: saga.data?.name ?? sagaId }]} />
      <div className="mb-3 mt-2 flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-content-strong">
          <Workflow className="h-5 w-5 text-accent" /> {saga.data?.name ?? sagaId}
          {saga.data?.hasTransaction && <Badge tone="info">saga</Badge>}
        </h1>
        {activeVersionId && <span className="font-mono text-xs text-content-muted">active version {activeVersionId.slice(-8)}</span>}
      </div>

      {saga.error && <ErrorState error={saga.error} />}

      {/* Calm "view BPMN" job — the active version's diagram. */}
      <div className="mb-4">
        {activeVersionId && versionXml.data ? (
          <Suspense fallback={<Card className="grid h-40 place-items-center text-xs text-content-muted">loading diagram…</Card>}>
            <BpmnViewer
              bpmnXml={versionXml.data.bpmnXml}
              elements={elements}
              overlay={EMPTY_OVERLAY}
              onSelectElement={() => {}}
            />
          </Suspense>
        ) : (
          <Card className="grid h-32 place-items-center text-xs text-content-muted">
            {activeVersionId ? "loading diagram…" : "no published version"}
          </Card>
        )}
      </div>

      <Tabs
        tabs={[
          { id: "instances", label: "Instances", badge: instances.data?.instances.length },
          { id: "versions", label: "Versions", badge: saga.data?.versions.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "instances" && (
        <Panel>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-md border border-line-strong bg-surface-card px-2 transition focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/20">
              <Search className="h-4 w-4 text-content-muted" />
              <input
                placeholder="business / correlation key"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-transparent py-1.5 text-sm text-content outline-none"
              />
            </div>
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => toggleStatus(s)}
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  statuses.includes(s) ? "border-accent bg-accent/20 text-accent" : "border-line-strong text-content-secondary"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          {instances.isLoading && <Spinner />}
          {instances.error && <ErrorState error={instances.error} />}
          <Card className="divide-y divide-line">
            {instances.data?.instances.map((i) => (
              <Link
                key={i.instanceId}
                to={`/console/instances/${encodeURIComponent(i.instanceId)}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface-sunken/50"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={i.status} />
                    <span className="truncate font-mono text-xs text-content">{i.businessKey || i.correlationKey}</span>
                  </div>
                  <div className="truncate font-mono text-[11px] text-content-muted">
                    at {index.nameOf(i.currentElementId || "") || "—"}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-content-muted">{relativeTime(i.updatedAt)}</span>
              </Link>
            ))}
            {instances.data && instances.data.instances.length === 0 && (
              <div className="p-6 text-center text-sm text-content-muted">No instances match.</div>
            )}
          </Card>
        </Panel>
      )}

      {tab === "versions" && (
        <Panel>
          <Card className="divide-y divide-line">
            {saga.data?.versions.map((v) => (
              <div key={v.definitionVersionId} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <div>
                  <span className="font-medium text-content">v{v.versionNumber}</span>
                  {v.definitionVersionId === activeVersionId && <Badge tone="ok">active</Badge>}
                  <span className="ml-2 font-mono text-xs text-content-muted">{v.definitionVersionId.slice(-8)}</span>
                </div>
                <div className="text-xs text-content-muted">
                  {v.instanceCount} instance{v.instanceCount === 1 ? "" : "s"} · {relativeTime(v.publishedAt)}
                </div>
              </div>
            ))}
          </Card>
        </Panel>
      )}
    </div>
  );
}
