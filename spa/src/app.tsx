import { useEffect } from "react";
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

function BootScreen() {
  return (
    <div className="stage-field grid h-screen place-items-center">
      <div className="flex items-center gap-3 text-content-secondary">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60 motion-reduce:hidden" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
        </span>
        <span className="font-display text-lg text-content-strong">
          easy<span className="text-accent">·</span>bpmn
        </span>
        <span className="text-sm">waking the stage…</span>
      </div>
    </div>
  );
}
