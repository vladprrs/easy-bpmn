// Small UI primitives for the operator console, styled to the easy·bpmn design
// system: light surfaces, teal accent, soft tinted status pills, calm motion.
// Dependency-light (no Radix); the Tone vocabulary is shared with the diagram +
// status badges, so the values here are re-pointed but the names stay stable.

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { Tone } from "../lib/humanize";

// Soft tinted pills on the light canvas — colour carries status meaning, never
// decoration. The ink uses the dark end of each ramp (700) so every label clears
// WCAG AA on its own /10–/15 fill (≈6.0–7.2:1), not the mid token (which fails).
const TONE: Record<Tone, string> = {
  info: "bg-info/10 text-[var(--blue-700)] border-info/30", // 7.9:1 on fill
  ok: "bg-ok/10 text-[var(--green-700)] border-ok/30", // 7.2:1
  warn: "bg-warn/15 text-[var(--amber-700)] border-warn/35", // 6.0:1
  danger: "bg-danger/10 text-[var(--red-700)] border-danger/30", // 6.9:1
  muted: "bg-surface-sunken text-content-secondary border-line", // 4.99:1 on sunken
  accent: "bg-accent/10 text-accent-press border-accent/30", // 6.7:1
};

export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold leading-none ${TONE[tone]}`}
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

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  className?: string;
}) {
  const styles: Record<string, string> = {
    default:
      "border-line bg-surface-card text-content shadow-xs hover:bg-surface-hover hover:border-line-strong",
    // White on teal-500 is only 3.47:1 — start at teal-600 (4.98:1) and darken on
    // interaction so the primary action always clears AA for its label.
    primary:
      "border-transparent bg-accent-hover text-white shadow-sm hover:bg-accent-press active:bg-accent-press active:translate-y-px",
    // White on red-500 is 3.84:1 — start at red-600 (5.1:1), hover red-700 (7.3:1).
    danger:
      "border-transparent bg-danger-hover text-white shadow-sm hover:bg-[var(--red-700)] active:translate-y-px",
    ghost: "border-transparent text-content-secondary hover:bg-surface-hover hover:text-content",
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--state-focus-ring)] disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
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
