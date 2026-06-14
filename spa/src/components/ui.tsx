// Small UI primitives for the operator console, styled to the easy·bpmn design
// system: light surfaces, teal accent, soft tinted status pills, calm motion.
// Dependency-light (no Radix); the Tone vocabulary is shared with the diagram +
// status badges, so the values here are re-pointed but the names stay stable.

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { Tone } from "../lib/humanize";

// Soft tinted pills on the light canvas — colour carries status meaning, never decoration.
const TONE: Record<Tone, string> = {
  info: "bg-info/10 text-info border-info/25",
  ok: "bg-ok/10 text-ok border-ok/25",
  warn: "bg-warn/15 text-warn border-warn/30",
  danger: "bg-danger/10 text-danger border-danger/25",
  muted: "bg-surface-sunken text-content-muted border-line",
  accent: "bg-accent/10 text-accent border-accent/25",
};

export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-[3px] text-[11px] font-semibold leading-none ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = "muted" }: { tone?: Tone }) {
  const c: Record<Tone, string> = {
    info: "bg-info",
    ok: "bg-ok",
    warn: "bg-warn",
    danger: "bg-danger",
    muted: "bg-line-strong",
    accent: "bg-accent",
  };
  return <span className={`inline-block h-2 w-2 rounded-full ${c[tone]}`} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-card border border-line bg-surface-card shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  const styles: Record<string, string> = {
    default:
      "border-line bg-surface-card text-content shadow-xs hover:bg-surface-hover hover:border-line-strong",
    primary:
      "border-transparent bg-accent text-white shadow-sm hover:bg-accent-hover active:bg-accent-press active:translate-y-px",
    danger:
      "border-transparent bg-danger text-white shadow-sm hover:bg-[#c63d36] active:translate-y-px",
    ghost: "border-transparent text-content-secondary hover:bg-surface-hover hover:text-content",
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-content-secondary">
      <Loader2 className="h-4 w-4 animate-spin text-accent" /> {label ?? "Loading…"}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 p-10 text-center text-content-muted">
      <div className="text-sm font-medium text-content-secondary">{title}</div>
      {hint && <div className="text-xs">{hint}</div>}
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="m-4 rounded-md border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
      {msg}
    </div>
  );
}

export function KeyVal({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="w-32 shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-content-muted">
        {k}
      </span>
      <span className="min-w-0 break-all font-mono text-content">{children}</span>
    </div>
  );
}

/** Render status→count chips (e.g. running 3 · waiting 1 · incident 2). */
export function CountChips({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return <span className="text-xs text-content-muted">no instances</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([status, n]) => (
        <span
          key={status}
          className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-content-secondary"
        >
          {status} <span className="text-content-muted">{n}</span>
        </span>
      ))}
    </div>
  );
}
