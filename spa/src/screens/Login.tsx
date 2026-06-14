import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, LogIn } from "lucide-react";
import { ApiError, api } from "../api/client";
import { useApp } from "../store";
import { Button } from "../components/ui";

export function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setMe = useApp((s) => s.setMe);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      setMe(await api.me());
      navigate("/console");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-ink-700 bg-ink-850 p-6 shadow-xl">
        <div className="mb-5 flex items-center gap-2 text-lg font-semibold text-slate-100">
          <Activity className="h-6 w-6 text-accent" /> easy-bpmn console
        </div>
        <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Operator</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          className="mb-3 w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent"
        />
        <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent"
        />
        {error && <div className="mb-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
        <Button type="submit" variant="primary" disabled={busy}>
          <LogIn className="h-4 w-4" /> {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
