import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Inbox, Search } from "lucide-react";
import { api } from "../api/client";
import { Breadcrumb } from "../components/Layout";
import { Badge, Card, EmptyState, ErrorState, Spinner } from "../components/ui";
import { relativeTime } from "../lib/format";
import type { Tone } from "../lib/humanize";

const OUTCOME_TONE: Record<string, Tone> = {
  correlated: "ok",
  buffered: "info",
  duplicate: "muted",
  expired: "warn",
  late: "warn",
  rejected: "danger",
  invariantViolation: "danger",
};

export function Messages() {
  const { projectId = "default" } = useParams();
  const [messageName, setMessageName] = useState("");
  const [correlationKey, setCorrelationKey] = useState("");
  const [outcome, setOutcome] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["messages", projectId, messageName, correlationKey, outcome],
    queryFn: () =>
      api.messages({
        workspaceId: projectId,
        messageName: messageName || undefined,
        correlationKey: correlationKey || undefined,
        outcome: outcome || undefined,
      }),
  });

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumb
        items={[{ label: "Projects", to: "/console" }, { label: projectId, to: `/console/p/${projectId}` }, { label: "Messages" }]}
      />
      <h1 className="mb-4 mt-2 flex items-center gap-2 text-lg font-semibold text-content-strong">
        <Inbox className="h-5 w-5 text-accent" /> Messages
      </h1>
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="flex items-center gap-1 rounded-md border border-line-strong bg-surface-card px-2 transition focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/20">
          <Search className="h-4 w-4 text-content-muted" />
          <input
            placeholder="message name"
            value={messageName}
            onChange={(e) => setMessageName(e.target.value)}
            className="bg-transparent py-1.5 text-sm text-content outline-none"
          />
        </div>
        <input
          placeholder="correlation key"
          value={correlationKey}
          onChange={(e) => setCorrelationKey(e.target.value)}
          className="rounded-md border border-line-strong bg-surface-card px-2 py-1.5 text-sm text-content outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/20"
        />
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          className="rounded-md border border-line-strong bg-surface-card px-2 py-1.5 text-sm text-content outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/20"
        >
          <option value="">any outcome</option>
          {Object.keys(OUTCOME_TONE).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>

      {isLoading && <Spinner />}
      {error && <ErrorState error={error} />}
      {data && data.messages.length === 0 && (
        <Card>
          <EmptyState title="No messages match" hint="Un-correlated late/rejected messages also surface here." />
        </Card>
      )}
      {data && data.messages.length > 0 && (
        <Card className="divide-y divide-line">
          {data.messages.map((m) => (
            <div key={m.externalMessageId} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge tone={OUTCOME_TONE[m.finalOutcome] ?? "muted"}>{m.finalOutcome}</Badge>
                  <span className="truncate text-sm text-content">{m.messageName}</span>
                </div>
                <div className="truncate font-mono text-xs text-content-muted">
                  key {m.correlationKey}
                  {m.reason ? ` · ${m.reason}` : ""}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs text-content-muted">
                {m.matchedInstanceId ? (
                  <Link to={`/console/instances/${m.matchedInstanceId}`} className="text-accent hover:underline">
                    → instance
                  </Link>
                ) : (
                  <span className="text-content-muted">un-correlated</span>
                )}
                <div>{relativeTime(m.receivedAt)}</div>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
