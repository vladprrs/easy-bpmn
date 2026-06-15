// Compact recursive JSON tree for the Variables / payload panels. Renders an R2
// overlay reference ({"__r2":"key"}) as a placeholder (design §15) — no rehydration.
//
// Syntax palette is deliberately NEUTRAL — it must never borrow the runtime-state
// tones (green/teal/amber/coral), which carry meaning elsewhere on the stage. Keys
// read as secondary ink, strings as a desaturated slate, numbers/booleans as the
// strong ink, null as muted. Long ids/URLs wrap (no horizontal scrollbar). The
// `bare` prop drops the frame so the tree can sit inside another card (e.g. the
// incident callout) without a card-in-card double border.

import { useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";

// AA-safe muted ink (var, 5.2:1 on white / 4.65:1 on sunken) — the Tailwind
// `content-muted` utility is the lighter decorative gray, so use the token directly.
const MUTED = "text-[color:var(--text-muted)]";

function isR2Ref(v: unknown): v is { __r2: string } {
  return !!v && typeof v === "object" && "__r2" in (v as object);
}

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className={MUTED}>null</span>;
  // strings: desaturated slate (cat-gateway #4d6e6a → 5.6:1 on white, 4.85:1 on sunken)
  if (typeof value === "string") return <span className="break-all text-cat-gateway">&quot;{value}&quot;</span>;
  // numbers + booleans: the strong ink, never the runtime-state colours
  if (typeof value === "number") return <span className="text-content-strong">{value}</span>;
  if (typeof value === "boolean") return <span className="text-content-strong">{String(value)}</span>;
  return <span className="break-all text-content">{String(value)}</span>;
}

function Node({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (isR2Ref(value)) {
    return (
      <div className="font-data text-xs leading-relaxed">
        {name && <span className="text-content-secondary">{name}: </span>}
        <span className={`italic ${MUTED}`}>large payload stored in R2 ({value.__r2})</span>
      </div>
    );
  }
  const isObj = value && typeof value === "object";
  if (!isObj) {
    return (
      <div className="whitespace-pre-wrap break-words font-data text-xs leading-relaxed">
        {name && <span className="text-content-secondary">{name}: </span>}
        <Leaf value={value} />
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  return (
    <div className="font-data text-xs leading-relaxed">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-content-secondary transition-colors hover:text-content"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="break-all">{name ?? (Array.isArray(value) ? "[ ]" : "{ }")}</span>
        {Array.isArray(value) && <span className={`tabular ${MUTED}`}>{entries.length}</span>}
      </button>
      {open && (
        <div className="ml-2 border-l border-line pl-3">
          {entries.length === 0 && <span className={MUTED}>empty</span>}
          {entries.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function JsonView({ value, bare = false }: { value: unknown; bare?: boolean }) {
  const [copied, setCopied] = useState(false);
  const isEmpty =
    value === undefined ||
    value === null ||
    (typeof value === "object" && Object.keys(value as object).length === 0);
  if (isEmpty) {
    return <div className={`text-xs ${MUTED} ${bare ? "" : "px-1 py-2"}`}>no data</div>;
  }

  const copy = () => {
    const text = JSON.stringify(value, null, 2);
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className={`relative ${bare ? "" : "rounded-md border border-line bg-surface-sunken"}`}>
      <button
        type="button"
        onClick={copy}
        title="Copy JSON"
        aria-label={copied ? "Copied" : "Copy JSON"}
        className="absolute right-1.5 top-1.5 z-10 rounded-md p-1 text-content-secondary transition hover:bg-surface-hover hover:text-content"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <div className={bare ? "pr-7" : "p-2.5 pr-8"}>
        <Node value={value} depth={0} />
      </div>
    </div>
  );
}
