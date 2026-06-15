import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { ApiError, api } from "../api/client";
import { useApp } from "../store";
import { Button } from "../components/ui";

// The living signature. A single teal current orbits a faint BPMN-shaped circuit
// behind the card — the same current the operator will watch all day, previewed —
// while the wordmark '·' breathes. Cadence comes from the shared --pulse token (read
// once at animate time) so boot → login share one heartbeat. transform/opacity only.
function pulseMs(): number {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return 2600;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--pulse").trim();
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return 2600;
  return raw.endsWith("ms") ? n : n * 1000;
}

// A closed, rounded BPMN-ish loop the current traces — one seamless orbit, no jump.
const CIRCUIT_D =
  "M150 70 H610 Q690 70 690 150 V410 Q690 490 610 490 H150 Q70 490 70 410 V150 Q70 70 150 70 Z";

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const sync = () => setReduced(mq.matches);
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  return reduced;
}

// Slow opacity+scale "breath" on the wordmark '·' — the through-line from boot.
function breathe(el: Element | null) {
  if (!el || typeof (el as HTMLElement).animate !== "function") return undefined;
  return (el as HTMLElement).animate(
    [
      { opacity: 1, transform: "scale(1)" },
      { opacity: 0.5, transform: "scale(0.8)" },
      { opacity: 1, transform: "scale(1)" },
    ],
    { duration: pulseMs(), iterations: Infinity, easing: "ease-in-out" },
  );
}

export function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setMe = useApp((s) => s.setMe);
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const dotRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (reduced) return;
    const a = breathe(dotRef.current);
    return () => a?.cancel();
  }, [reduced]);

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
    <div className="stage-field relative grid min-h-screen place-items-center overflow-y-auto px-4 py-8">
      {/* The previewed current — a soft teal token orbiting a faint circuit behind the
          card. Pure decoration (aria-hidden); the opaque card keeps the form crisp.
          Reduced motion: the circuit + dot render statically (no travel, no pulse). */}
      <div
        aria-hidden="true"
        className="anim-fade pointer-events-none absolute inset-0 z-0 grid place-items-center overflow-hidden"
        style={{ animationDelay: "140ms" }}
      >
        <svg viewBox="0 0 760 560" className="h-auto w-[min(94vw,760px)]" role="presentation">
          <path
            d={CIRCUIT_D}
            fill="none"
            stroke="var(--current)"
            strokeOpacity={0.22}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Ghost BPMN nodes punctuating the loop — a whisper of the diagram's soul:
              start event · service task · end event · gateway. */}
          <g fill="none" stroke="var(--current)" strokeOpacity={0.22} strokeWidth={1.3}>
            <circle cx={200} cy={70} r={8} />
            <rect x={353} y={473} width={54} height={34} rx={9} />
            <circle cx={690} cy={280} r={9} />
            <circle cx={690} cy={280} r={5.5} />
            <rect x={56} y={266} width={28} height={28} rx={5} transform="rotate(45 70 280)" />
          </g>
          {/* The travelling current: a bright core in a soft halo, riding the loop. */}
          <g transform="translate(200 70)">
            <circle r={9} fill="var(--current-glow)" opacity={reduced ? 0.4 : 0.55} />
            <circle
              r={3.4}
              fill="var(--current-bright)"
              style={{ filter: "drop-shadow(0 0 5px var(--current-glow))" }}
            />
            {!reduced && <animateMotion dur="18s" repeatCount="indefinite" path={CIRCUIT_D} />}
          </g>
        </svg>
      </div>

      <form
        onSubmit={submit}
        aria-labelledby="login-title login-subtitle"
        className="anim-rise relative z-10 w-full max-w-sm"
      >
        <div className="mb-6 text-center">
          <h1 id="login-title" className="font-display text-2xl tracking-[-0.02em] text-content-strong">
            easy<span ref={dotRef} className="inline-block text-accent">·</span>bpmn
          </h1>
          <p id="login-subtitle" className="mt-1 text-base text-content-secondary">operator console</p>
        </div>
        <div className="rounded-card bg-surface-card p-6 shadow-md">
          <label htmlFor="login-operator" className="tech-label mb-1.5 block">Operator</label>
          <input
            id="login-operator"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            className="mb-3 w-full rounded-lg border border-line bg-surface-page px-3 py-2 text-base text-content outline-none transition focus:border-[var(--state-focus)] focus:bg-surface-card focus:ring-[3px] focus:ring-[var(--state-focus-ring)]"
          />
          <label htmlFor="login-password" className="tech-label mb-1.5 block">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-4 w-full rounded-lg border border-line bg-surface-page px-3 py-2 text-base text-content outline-none transition focus:border-[var(--state-focus)] focus:bg-surface-card focus:ring-[3px] focus:ring-[var(--state-focus-ring)]"
          />
          {error && (
            <div
              role="alert"
              className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-base font-medium text-[var(--red-700)]"
            >
              {error}
            </div>
          )}
          <Button type="submit" variant="primary" disabled={busy} className="w-full">
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
