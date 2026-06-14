import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogIn } from "lucide-react";
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
    <div className="stage-field grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="anim-rise w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="font-display text-2xl tracking-[-0.02em] text-content-strong">
            easy<span className="text-accent">·</span>bpmn
          </div>
          <div className="mt-1 text-sm text-content-secondary">operator console</div>
        </div>
        <div className="rounded-2xl border border-line bg-surface-card/90 p-6 shadow-lg backdrop-blur">
          <label htmlFor="login-operator" className="tech-label mb-1.5 block">Operator</label>
          <input
            id="login-operator"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            className="mb-3 w-full rounded-lg border border-line bg-surface-page px-3 py-2 text-sm text-content outline-none transition focus:border-accent focus:bg-surface-card focus:ring-[3px] focus:ring-accent/35"
          />
          <label htmlFor="login-password" className="tech-label mb-1.5 block">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-4 w-full rounded-lg border border-line bg-surface-page px-3 py-2 text-sm text-content outline-none transition focus:border-accent focus:bg-surface-card focus:ring-[3px] focus:ring-accent/35"
          />
          {error && (
            <div role="alert" className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>
          )}
          <Button type="submit" variant="primary" disabled={busy} className="w-full">
            <LogIn className="h-4 w-4" /> {busy ? "Signing in…" : "Sign in"}
          </Button>
        </div>
      </form>
    </div>
  );
}
