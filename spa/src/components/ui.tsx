// Small Tailwind UI primitives for the dense operator console. Kept dependency-light
// (the design names Radix as a swappable default; these hand-rolled primitives keep
// the install lean).

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { Tone } from "../lib/humanize";

const TONE: Record<Tone, string> = {
  info: "bg-info/15 text-info border-info/30",
  ok: "bg-ok/15 text-ok border-ok/30",
  warn: "bg-warn/15 text-warn border-warn/30",
  danger: "bg-danger/15 text-danger border-danger/30",
  muted: "bg-ink-700/40 text-slate-400 border-ink-600",
  accent: "bg-accent/15 text-accent border-accent/40",
};

export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium ${TONE[tone]}`}>
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
    muted: "bg-ink-500",
    accent: "bg-accent",
  };
  return <span className={`inline-block h-2 w-2 rounded-full ${c[tone]}`} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-ink-700 bg-ink-850 ${className}`}>{children}</div>;
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
    default: "border-ink-600 bg-ink-800 hover:bg-ink-700 text-slate-200",
    primary: "border-accent/50 bg-accent/20 hover:bg-accent/30 text-accent",
    danger: "border-danger/50 bg-danger/15 hover:bg-danger/25 text-danger",
    ghost: "border-transparent hover:bg-ink-800 text-slate-300",
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin" /> {label ?? "Loading…"}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 p-10 text-center text-slate-500">
      <div className="text-sm font-medium text-slate-400">{title}</div>
      {hint && <div className="text-xs">{hint}</div>}
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="m-4 rounded-md border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
      {msg}
    </div>
  );
}

export function KeyVal({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="w-32 shrink-0 text-xs uppercase tracking-wide text-slate-500">{k}</span>
      <span className="min-w-0 break-all font-mono text-slate-300">{children}</span>
    </div>
  );
}

/** Render status→count chips (e.g. running 3 · waiting 1 · incident 2). */
export function CountChips({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return <span className="text-xs text-slate-600">no instances</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([status, n]) => (
        <span key={status} className="rounded bg-ink-700/50 px-1.5 py-0.5 font-mono text-xs text-slate-300">
          {status} <span className="text-slate-500">{n}</span>
        </span>
      ))}
    </div>
  );
}
