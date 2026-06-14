import type { ReactNode } from "react";

export interface TabDef {
  id: string;
  label: string;
  badge?: number;
  hidden?: boolean;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-ink-700">
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              active === t.id
                ? "border-accent text-accent"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <span className="ml-1.5 rounded-full bg-ink-700 px-1.5 text-xs text-slate-300">{t.badge}</span>
            )}
          </button>
        ))}
    </div>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return <div className="py-3">{children}</div>;
}
