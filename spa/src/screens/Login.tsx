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
    <div className="grid min-h-full place-items-center px-4" style={{ background: "var(--wash-teal)" }}>
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-card border border-line bg-surface-card p-6 shadow-lg"
      >
        <div className="mb-5 flex items-center gap-2 text-lg font-semibold tracking-[-0.01em] text-content-strong">
          <Activity className="h-6 w-6 text-accent" /> easy<span className="text-accent">·</span>bpmn console
        </div>
        <label className="mb-1 block text-xs uppercase tracking-wide text-content-muted">Operator</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          className="mb-3 w-full rounded-md border border-line-strong bg-surface-card px-3 py-2 text-sm text-content outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/25"
        />
        <label className="mb-1 block text-xs uppercase tracking-wide text-content-muted">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-md border border-line-strong bg-surface-card px-3 py-2 text-sm text-content outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/25"
        />
        {error && <div className="mb-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
        <Button type="submit" variant="primary" disabled={busy}>
          <LogIn className="h-4 w-4" /> {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
