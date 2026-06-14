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
    <div className="flex flex-wrap gap-1 border-b border-line">
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              active === t.id
                ? "border-accent text-accent"
                : "border-transparent text-content-secondary hover:text-content"
            }`}
          >
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <span className="ml-1.5 rounded-full bg-surface-sunken px-1.5 text-xs text-content-secondary">
                {t.badge}
              </span>
            )}
          </button>
        ))}
    </div>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return <div className="py-3">{children}</div>;
}
