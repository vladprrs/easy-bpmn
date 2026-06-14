// Small pure formatting helpers used across the console.

import type { Tone } from "./humanize";

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const s = Math.round(abs / 1000);
  const m = Math.round(s / 60);
  const h = Math.round(m / 60);
  const d = Math.round(h / 24);
  const fmt = s < 60 ? `${s}s` : m < 60 ? `${m}m` : h < 24 ? `${h}h` : `${d}d`;
  return diff >= 0 ? `${fmt} ago` : `in ${fmt}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { hour12: false });
}

/** Map an instance status to a semantic tone for badges. */
export function statusTone(status: string): Tone {
  switch (status) {
    case "completed":
    case "compensated":
      return "ok";
    case "running":
    case "starting":
      return "accent";
    case "waiting":
    case "compensating":
      return "info";
    case "incident":
    case "compensationFailed":
      return "danger";
    case "cancelled":
      return "warn";
    default:
      return "muted";
  }
}

export function shortId(id: string | null | undefined, keep = 8): string {
  if (!id) return "—";
  const tail = id.includes("_") ? id.slice(id.lastIndexOf("_") + 1) : id;
  return tail.length > keep ? tail.slice(0, keep) : tail;
}
