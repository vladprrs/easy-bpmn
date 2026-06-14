import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, FolderGit2, Layers } from "lucide-react";
import { api } from "../api/client";
import { Breadcrumb } from "../components/Layout";
import { Card, CountChips, ErrorState, Spinner } from "../components/ui";

export function Projects() {
  const { data, isLoading, error } = useQuery({ queryKey: ["projects"], queryFn: () => api.projects() });

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumb items={[{ label: "Projects" }]} />
      <h1 className="mb-4 mt-2 text-lg font-semibold text-slate-100">Projects</h1>
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.projects.map((p) => (
          <Card key={p.projectId} className="p-4 transition hover:border-accent/40">
            <Link to={`/console/p/${encodeURIComponent(p.projectId)}`} className="block">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-2 font-medium text-slate-100">
                  <FolderGit2 className="h-4 w-4 text-accent" /> {p.name || p.projectId}
                </span>
                {p.attention > 0 && (
                  <span className="flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-xs font-semibold text-danger">
                    <AlertTriangle className="h-3 w-3" /> {p.attention}
                  </span>
                )}
              </div>
              <div className="mb-2 flex items-center gap-1 text-xs text-slate-500">
                <Layers className="h-3 w-3" /> {p.sagaCount} saga{p.sagaCount === 1 ? "" : "s"}
              </div>
              <CountChips counts={p.counts} />
            </Link>
            {p.attention > 0 && (
              <Link
                to={`/console/p/${encodeURIComponent(p.projectId)}/attention`}
                className="mt-3 inline-block text-xs text-danger hover:underline"
              >
                view {p.attention} needing attention →
              </Link>
            )}
          </Card>
        ))}
        {data && data.projects.length === 0 && (
          <Card className="col-span-full p-8 text-center text-sm text-slate-500">No projects yet.</Card>
        )}
      </div>
    </div>
  );
}
