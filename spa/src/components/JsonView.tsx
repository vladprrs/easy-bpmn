// Compact recursive JSON tree for the Variables / payload panels. Renders an R2
// overlay reference ({"__r2":"key"}) as a placeholder (design §15) — no rehydration.

import { useState } from "react";
import { ChevronRight } from "lucide-react";

function isR2Ref(v: unknown): v is { __r2: string } {
  return !!v && typeof v === "object" && "__r2" in (v as object);
}

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className="text-content-muted">null</span>;
  if (typeof value === "string") return <span className="text-ok">&quot;{value}&quot;</span>;
  if (typeof value === "number") return <span className="text-accent">{value}</span>;
  if (typeof value === "boolean") return <span className="text-warn">{String(value)}</span>;
  return <span className="text-content">{String(value)}</span>;
}

function Node({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (isR2Ref(value)) {
    return (
      <div className="font-mono text-xs">
        {name && <span className="text-content-secondary">{name}: </span>}
        <span className="italic text-content-muted">large payload stored in R2 ({value.__r2})</span>
      </div>
    );
  }
  const isObj = value && typeof value === "object";
  if (!isObj) {
    return (
      <div className="font-mono text-xs">
        {name && <span className="text-content-secondary">{name}: </span>}
        <Leaf value={value} />
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  return (
    <div className="font-mono text-xs">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-content-secondary hover:text-content">
        <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
        {name ?? (Array.isArray(value) ? "[ ]" : "{ }")}
        <span className="text-content-muted">{Array.isArray(value) ? `(${entries.length})` : ""}</span>
      </button>
      {open && (
        <div className="ml-3 border-l border-line pl-3">
          {entries.length === 0 && <span className="text-content-muted">empty</span>}
          {entries.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  if (value === undefined || value === null || (typeof value === "object" && Object.keys(value).length === 0)) {
    return <div className="p-2 text-xs text-content-muted">no data</div>;
  }
  return (
    <div className="overflow-auto rounded-md border border-line bg-surface-sunken p-2.5">
      <Node value={value} depth={0} />
    </div>
  );
}
