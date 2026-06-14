import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { api } from "../api/client";
import { Breadcrumb } from "../components/Layout";
import { Badge, Card, EmptyState, ErrorState, Spinner } from "../components/ui";
import { relativeTime } from "../lib/format";
import type { Tone } from "../lib/humanize";

const REASON: Record<string, { tone: Tone; label: string }> = {
  incident: { tone: "danger", label: "incident" },
  compensationFailed: { tone: "danger", label: "compensation failed" },
  staleCompensating: { tone: "warn", label: "stale compensating" },
};

export function Attention() {
  const { projectId = "default" } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["attention", projectId, "full"],
    queryFn: () => api.attention(projectId),
    refetchInterval: 10_000,
  });

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumb
        items={[{ label: "Projects", to: "/console" }, { label: projectId, to: `/console/p/${projectId}` }, { label: "Attention" }]}
      />
      <h1 className="mb-4 mt-2 flex items-center gap-2 text-lg font-semibold text-slate-100">
        <AlertTriangle className="h-5 w-5 text-danger" /> Needs attention
      </h1>
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} />}
      {data && data.items.length === 0 && (
        <Card>
          <EmptyState title="Nothing on fire" hint="No incidents, compensation failures, or stale compensations." />
        </Card>
      )}
      {data && data.items.length > 0 && (
        <Card className="divide-y divide-ink-700">
          {data.items.map((it) => {
            const r = REASON[it.reason] ?? { tone: "danger" as Tone, label: it.reason };
            return (
              <Link
                key={it.instanceId}
                to={`/console/instances/${encodeURIComponent(it.instanceId)}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-ink-800/50"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone={r.tone}>{r.label}</Badge>
                    <span className="truncate text-sm text-slate-200">{it.sagaName || it.sagaId || "—"}</span>
                  </div>
                  <div className="truncate font-mono text-xs text-slate-500">
                    {it.businessKey ? `${it.businessKey} · ` : ""}
                    {it.correlationKey} · at {it.currentElementId || "—"}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-slate-500">{relativeTime(it.since)}</span>
              </Link>
            );
          })}
        </Card>
      )}
    </div>
  );
}
