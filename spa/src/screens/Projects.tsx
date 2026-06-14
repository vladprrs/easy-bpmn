import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Activity, AlertTriangle, Clock, FolderGit2, Layers } from "lucide-react";
import { api } from "../api/client";
import type { StatusCounts } from "../api/types";
import { Breadcrumb } from "../components/Layout";
import { Card, CountChips, ErrorState, Spinner } from "../components/ui";

const TILE_TONE = {
  accent: "bg-accent/10 text-accent",
  info: "bg-info/10 text-info",
  muted: "bg-surface-sunken text-content-secondary",
  danger: "bg-danger/10 text-danger",
} as const;

function StatTile({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  tone: keyof typeof TILE_TONE;
}) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md ${TILE_TONE[tone]}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-xl font-semibold tabular-nums leading-tight text-content-strong">{value}</div>
        <div className="truncate text-xs text-content-muted">{label}</div>
      </div>
    </Card>
  );
}

/** Proportional run-health bar from real status counts (completed vs in-flight vs failed). */
function HealthBar({ counts }: { counts: StatusCounts }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return null;
  const good = (counts.completed || 0) + (counts.compensated || 0);
  const bad = (counts.incident || 0) + (counts.compensationFailed || 0);
  const rest = Math.max(0, total - good - bad);
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-surface-sunken" title={`${good} ok · ${rest} in flight · ${bad} failed`}>
      {good > 0 && <span style={{ width: pct(good) }} className="bg-ok" />}
      {rest > 0 && <span style={{ width: pct(rest) }} className="bg-info/60" />}
      {bad > 0 && <span style={{ width: pct(bad) }} className="bg-danger" />}
    </div>
  );
}

export function Projects() {
  const { data, isLoading, error } = useQuery({ queryKey: ["projects"], queryFn: () => api.projects() });

  const agg = (data?.projects ?? []).reduce(
    (a, p) => ({
      running: a.running + (p.counts.running || 0) + (p.counts.starting || 0),
      waiting: a.waiting + (p.counts.waiting || 0),
      attention: a.attention + p.attention,
    }),
    { running: 0, waiting: 0, attention: 0 },
  );

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumb items={[{ label: "Projects" }]} />
      <h1 className="mb-4 mt-2 text-lg font-semibold tracking-[-0.01em] text-content-strong">Projects</h1>
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} />}

      {data && data.projects.length > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Projects" value={data.projects.length} icon={<FolderGit2 className="h-4 w-4" />} tone="accent" />
          <StatTile label="Running now" value={agg.running} icon={<Activity className="h-4 w-4" />} tone="info" />
          <StatTile label="Waiting" value={agg.waiting} icon={<Clock className="h-4 w-4" />} tone="muted" />
          <StatTile label="Needs attention" value={agg.attention} icon={<AlertTriangle className="h-4 w-4" />} tone="danger" />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.projects.map((p) => (
          <Card key={p.projectId} className="p-4 transition hover:border-accent/40 hover:shadow-md">
            <Link to={`/console/p/${encodeURIComponent(p.projectId)}`} className="block">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 font-medium text-content-strong">
                  <FolderGit2 className="h-4 w-4 shrink-0 text-accent" />
                  <span className="truncate">{p.name || p.projectId}</span>
                </span>
                {p.attention > 0 && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">
                    <AlertTriangle className="h-3 w-3" /> {p.attention}
                  </span>
                )}
              </div>
              <div className="mb-2 flex items-center gap-1 text-xs text-content-muted">
                <Layers className="h-3 w-3" /> {p.sagaCount} saga{p.sagaCount === 1 ? "" : "s"}
              </div>
              <CountChips counts={p.counts} />
              <HealthBar counts={p.counts} />
            </Link>
            {p.attention > 0 && (
              <Link
                to={`/console/p/${encodeURIComponent(p.projectId)}/attention`}
                className="mt-3 inline-block text-xs font-medium text-danger hover:underline"
              >
                view {p.attention} needing attention →
              </Link>
            )}
          </Card>
        ))}
        {data && data.projects.length === 0 && (
          <Card className="col-span-full p-8 text-center text-sm text-content-muted">No projects yet.</Card>
        )}
      </div>
    </div>
  );
}
