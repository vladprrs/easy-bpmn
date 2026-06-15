import { useEffect, useRef } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client";
import { useApp } from "./store";
import { Login } from "./screens/Login";
import { Stage } from "./stage/Stage";

export default function App() {
  const setMe = useApp((s) => s.setMe);
  const location = useLocation();
  const navigate = useNavigate();
  const meQ = useQuery({ queryKey: ["me"], queryFn: () => api.me(), retry: false });

  useEffect(() => {
    if (meQ.data) setMe(meQ.data);
  }, [meQ.data, setMe]);

  useEffect(() => {
    if (meQ.data && meQ.data.authConfigured && !meQ.data.authenticated && location.pathname !== "/login") {
      navigate("/login", { replace: true });
    }
  }, [meQ.data, location.pathname, navigate]);

  if (meQ.isLoading) return <BootScreen />;

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/console" element={<Stage />} />
      <Route path="/console/p/:sagaId" element={<Stage />} />
      <Route path="/console/p/:sagaId/i/:instanceId" element={<Stage />} />
      <Route path="/console/i/:instanceId" element={<Stage />} />
      <Route path="*" element={<Navigate to="/console" replace />} />
    </Routes>
  );
}

// The living signature begins here. The teal '·' breathes and a slow sonar ring
// expands from the status dot — the SAME cadence the Login screen reuses, so
// boot → login reads as one continuous detail. transform/opacity only; reduced
// motion falls back to a static, fully legible teal dot + wordmark.
// The cadence is the shared --pulse token (read once at animate time, 2600ms fallback
// off-DOM) so boot and login share a single heartbeat.
function pulseMs(): number {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return 2600;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--pulse").trim();
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return 2600;
  return raw.endsWith("ms") ? n : n * 1000;
}

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

function sonar(el: Element | null) {
  if (!el || typeof (el as HTMLElement).animate !== "function") return undefined;
  return (el as HTMLElement).animate(
    [
      { opacity: 0.5, transform: "scale(1)" },
      { opacity: 0, transform: "scale(2.6)" },
    ],
    { duration: pulseMs(), iterations: Infinity, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  );
}

function BootScreen() {
  const haloRef = useRef<HTMLSpanElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const a = sonar(haloRef.current);
    const b = breathe(dotRef.current);
    return () => {
      a?.cancel();
      b?.cancel();
    };
  }, []);

  return (
    <div className="stage-field grid h-screen place-items-center">
      <div className="anim-fade flex items-center gap-3 text-content-secondary">
        <span className="relative flex h-2.5 w-2.5">
          <span
            ref={haloRef}
            className="absolute inline-flex h-full w-full rounded-full bg-accent"
            style={{ opacity: 0 }}
          />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
        </span>
        <span className="font-display text-lg text-content-strong">
          easy<span ref={dotRef} className="inline-block text-accent">·</span>bpmn
        </span>
        <span className="text-base">waking the stage…</span>
      </div>
    </div>
  );
}
