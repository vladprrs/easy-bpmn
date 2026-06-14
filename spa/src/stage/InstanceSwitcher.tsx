// Drop into a specific run. A compact control: the current instance + a picker with
// fuzzy search (business / correlation key) and status filters. Backed by
// GET /instances?sagaId=&status=&search=. Picking renders that run's living flow.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Play, Search } from "lucide-react";
import { api } from "../api/client";
import type { ElementIndex } from "../lib/elements";
import { Popover } from "./primitives";
import { StatusBadge } from "../components/StatusBadge";
import { relativeTime } from "../lib/format";

const FILTERS = ["running", "waiting", "incident", "compensationFailed", "completed", "cancelled"];

export function InstanceSwitcher({
  workspaceId,
  sagaId,
  currentInstanceId,
  currentLabel,
  index,
}: {
  workspaceId: string;
  sagaId: string;
  currentInstanceId: string | null;
  currentLabel: string | null;
  index: ElementIndex;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);

  const q = useQuery({
    queryKey: ["instances", workspaceId, sagaId, statuses, search],
    queryFn: () =>
      api.instances({
        workspaceId,
        sagaId,
        status: statuses.length ? statuses.join(",") : undefined,
        search: search || undefined,
        limit: 40,
      }),
    enabled: !!sagaId,
  });

  const toggle = (s: string) => setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <Popover
      width={360}
      trigger={({ toggle: t, ref, open }) => (
        <button
          ref={ref as any}
          onClick={t}
          className="flex items-center gap-2 rounded-lg border border-line bg-surface-card/80 px-2.5 py-1.5 text-sm shadow-xs backdrop-blur transition hover:border-line-strong"
        >
          <Play className="h-3.5 w-3.5 text-accent" />
          <span className="max-w-[12rem] truncate font-data text-xs text-content">
            {currentLabel ?? "Watch a run"}
          </span>
          <ChevronDown className={`h-3.5 w-3.5 text-content-muted transition ${open ? "rotate-180" : ""}`} />
        </button>
      )}
    >
      {(close) => (
        <div className="w-[360px]">
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
            <Search className="h-3.5 w-3.5 text-content-muted" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find by business / correlation key"
              className="w-full bg-transparent text-sm text-content outline-none placeholder:text-content-muted"
            />
          </div>
          <div className="flex flex-wrap gap-1 border-b border-line px-3 py-2">
            {FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => toggle(s)}
                className={`rounded-full border px-2 py-0.5 text-2xs transition ${
                  statuses.includes(s)
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line text-content-secondary hover:border-line-strong"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <ul className="max-h-[50vh] overflow-auto p-1.5">
            {q.isLoading && <li className="px-3 py-6 text-center text-sm text-content-muted">Loading runs…</li>}
            {q.data?.instances.map((i) => (
              <li key={i.instanceId}>
                <button
                  onClick={() => {
                    navigate(`/console/p/${encodeURIComponent(sagaId)}/i/${encodeURIComponent(i.instanceId)}`);
                    close();
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition hover:bg-surface-hover ${
                    i.instanceId === currentInstanceId ? "bg-accent-soft" : ""
                  }`}
                >
                  <StatusBadge status={i.status} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-data text-xs text-content">{i.businessKey || i.correlationKey}</div>
                    <div className="truncate text-2xs text-content-muted">
                      at {index.nameOf(i.currentElementId || "") || "—"}
                    </div>
                  </div>
                  <span className="shrink-0 text-2xs text-content-muted">{relativeTime(i.updatedAt)}</span>
                </button>
              </li>
            ))}
            {q.data && q.data.instances.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-content-muted">No runs match.</li>
            )}
          </ul>
        </div>
      )}
    </Popover>
  );
}
