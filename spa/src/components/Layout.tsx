import { Link, Outlet, useNavigate } from "react-router-dom";
import { Activity, ChevronRight, LogOut } from "lucide-react";
import { api } from "../api/client";
import { useApp } from "../store";
import { Toasts } from "./Toasts";

export function Breadcrumb({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm text-content-secondary">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-line-strong" />}
          {it.to ? (
            <Link to={it.to} className="hover:text-accent">
              {it.label}
            </Link>
          ) : (
            <span className="font-medium text-content">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function Layout() {
  const me = useApp((s) => s.me);
  const workspaceId = useApp((s) => s.workspaceId);
  const setMe = useApp((s) => s.setMe);
  const navigate = useNavigate();

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    setMe(null);
    navigate("/login");
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-surface-card/70 px-4 py-2.5 backdrop-blur-md backdrop-saturate-150">
        <Link
          to="/console"
          className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em] text-content-strong"
        >
          <Activity className="h-5 w-5 text-accent" />
          easy<span className="text-accent">·</span>bpmn{" "}
          <span className="font-normal text-content-muted">operator console</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="rounded-md border border-line bg-surface-sunken px-2 py-1 font-mono text-xs text-content-secondary">
            ws: {workspaceId}
          </span>
          {me?.authConfigured && (
            <button
              onClick={logout}
              className="flex items-center gap-1 text-content-secondary transition hover:text-danger"
            >
              <LogOut className="h-4 w-4" /> logout
            </button>
          )}
        </div>
      </header>
      <main className="flex-1 px-4 py-4">
        <Outlet />
      </main>
      <Toasts />
    </div>
  );
}
