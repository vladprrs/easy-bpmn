// The slim top chrome (visual-design-brief §4): brand · process switcher · stats ·
// ⌘K · attention · live · logout. Everything process/global level; the diagram
// commands the rest of the stage. Floating glass so the field reads beneath it.

import { Command, LogOut, Radio } from "lucide-react";
import type { AttentionItem, SagaSummary } from "../api/types";
import type { LiveStatus } from "../api/stream";
import type { CountSummary } from "./model";
import { ProcessSwitcher } from "./ProcessSwitcher";
import { StatsRail } from "./StatsRail";
import { AttentionPopover } from "./AttentionPopover";
import { Kbd } from "./primitives";

const LIVE: Record<LiveStatus, { dot: string; label: string }> = {
  connecting: { dot: "bg-content-muted", label: "connecting" },
  live: { dot: "bg-ok", label: "live" },
  reconnecting: { dot: "bg-warn", label: "reconnecting" },
  polling: { dot: "bg-info", label: "polling" },
};

export function ChromeBar({
  sagas,
  currentSaga,
  summary,
  attention,
  live,
  authConfigured,
  onOpenPalette,
  onPickStatus,
  onLogout,
}: {
  sagas: SagaSummary[];
  currentSaga: SagaSummary | null;
  summary: CountSummary;
  attention: AttentionItem[];
  live: LiveStatus | null;
  authConfigured: boolean;
  onOpenPalette: () => void;
  onPickStatus: (status: string) => void;
  onLogout: () => void;
}) {
  const liveInfo = live ? LIVE[live] : null;
  return (
    <header className="z-30 flex items-center gap-3 border-b border-line/70 bg-surface-card/75 px-3 py-2 backdrop-blur-md backdrop-saturate-150">
      <span className="flex shrink-0 items-center gap-1.5 pl-1 text-sm font-semibold tracking-[-0.02em] text-content-strong">
        easy<span className="text-accent">·</span>bpmn
      </span>
      <span className="h-5 w-px bg-line" aria-hidden />
      <ProcessSwitcher sagas={sagas} current={currentSaga} />
      <span className="hidden h-5 w-px bg-line lg:block" aria-hidden />
      <div className="hidden min-w-0 lg:block">
        <StatsRail summary={summary} onPickStatus={onPickStatus} />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onOpenPalette}
          className="flex items-center gap-2 rounded-lg border border-line bg-surface-card px-2.5 py-1.5 text-sm text-content-secondary shadow-xs transition hover:border-line-strong hover:text-content"
        >
          <Command className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
        <AttentionPopover items={attention} />
        {liveInfo && (
          <span
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-2xs font-medium text-content-secondary"
            title={`live tail · ${liveInfo.label}`}
          >
            <Radio className="h-3.5 w-3.5" />
            <span className="relative flex h-1.5 w-1.5">
              {live === "live" && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok/60 motion-reduce:hidden" />
              )}
              <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${liveInfo.dot}`} />
            </span>
            <span className="hidden md:inline">{liveInfo.label}</span>
          </span>
        )}
        {authConfigured && (
          <button
            onClick={onLogout}
            title="Sign out"
            className="flex items-center rounded-lg px-2 py-1.5 text-content-secondary transition hover:bg-surface-hover hover:text-danger"
          >
            <LogOut className="h-4 w-4" />
          </button>
        )}
      </div>
    </header>
  );
}
