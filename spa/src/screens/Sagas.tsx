import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, Inbox, Workflow } from "lucide-react";
import { api } from "../api/client";
import { useApp } from "../store";
import { Breadcrumb } from "../components/Layout";
import { Badge, Card, CountChips, ErrorState, Spinner } from "../components/ui";
import { relativeTime } from "../lib/format";

export function Sagas() {
  const { projectId = "default" } = useParams();
  const setWorkspace = useApp((s) => s.setWorkspace);
  useEffect(() => setWorkspace(projectId), [projectId, setWorkspace]);

  const sagas = useQuery({ queryKey: ["sagas", projectId], queryFn: () => api.sagas(projectId) });
  const attention = useQuery({ queryKey: ["attention", projectId], queryFn: () => api.attention(projectId) });
  const attentionCount = attention.data?.items.length ?? 0;

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumb items={[{ label: "Projects", to: "/console" }, { label: projectId }]} />
      <div className="mb-4 mt-2 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-content-strong">Sagas</h1>
        <div className="flex items-center gap-2">
          <Link
            to={`/console/p/${encodeURIComponent(projectId)}/attention`}
            className={`flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-sm ${
              attentionCount > 0 ? "border-danger/50 bg-danger/10 text-danger" : "border-line-strong text-content-secondary"
            }`}
          >
            <AlertTriangle className="h-4 w-4" /> Attention {attentionCount > 0 && <b>{attentionCount}</b>}
          </Link>
          <Link
            to={`/console/p/${encodeURIComponent(projectId)}/messages`}
            className="flex items-center gap-1 rounded-md border border-line-strong px-2.5 py-1.5 text-sm text-content-secondary hover:text-content"
          >
            <Inbox className="h-4 w-4" /> Messages
          </Link>
        </div>
      </div>

      {sagas.isLoading && <Spinner />}
      {sagas.error && <ErrorState error={sagas.error} />}
      <div className="grid gap-3 md:grid-cols-2">
        {sagas.data?.sagas.map((s) => (
          <Link key={s.sagaId} to={`/console/sagas/${encodeURIComponent(s.sagaId)}`}>
            <Card className="p-4 transition hover:border-accent/40">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 font-medium text-content-strong">
                  <Workflow className="h-4 w-4 shrink-0 text-accent" /> <span className="truncate">{s.name}</span>
                </span>
                {s.hasTransaction && <Badge tone="info">saga</Badge>}
              </div>
              <div className="mb-2 text-xs text-content-muted">
                v{s.activeVersionId ? "" : "—"}
                {s.versionCount} version{s.versionCount === 1 ? "" : "s"} · last activity {relativeTime(s.lastActivityAt)}
              </div>
              <CountChips counts={s.counts} />
            </Card>
          </Link>
        ))}
        {sagas.data && sagas.data.sagas.length === 0 && (
          <Card className="col-span-full p-8 text-center text-sm text-content-muted">
            No published sagas in this project yet.
          </Card>
        )}
      </div>
    </div>
  );
}
