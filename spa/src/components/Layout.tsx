import { Link, Outlet, useNavigate } from "react-router-dom";
import { Activity, ChevronRight, LogOut } from "lucide-react";
import { api } from "../api/client";
import { useApp } from "../store";
import { Toasts } from "./Toasts";

export function Breadcrumb({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm text-slate-400">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-slate-600" />}
          {it.to ? (
            <Link to={it.to} className="hover:text-accent">
              {it.label}
            </Link>
          ) : (
            <span className="font-medium text-slate-200">{it.label}</span>
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
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-ink-700 bg-ink-900/90 px-4 py-2.5 backdrop-blur">
        <Link to="/console" className="flex items-center gap-2 font-semibold text-slate-100">
          <Activity className="h-5 w-5 text-accent" />
          easy-bpmn <span className="text-slate-500">operator console</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="rounded bg-ink-800 px-2 py-1 font-mono text-xs text-slate-400">ws: {workspaceId}</span>
          {me?.authConfigured && (
            <button onClick={logout} className="flex items-center gap-1 text-slate-400 hover:text-danger">
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
