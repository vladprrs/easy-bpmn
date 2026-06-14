import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { api } from "./api/client";
import { useApp } from "./store";
import { Layout } from "./components/Layout";
import { Login } from "./screens/Login";
import { Projects } from "./screens/Projects";
import { Sagas } from "./screens/Sagas";
import { SagaDetail } from "./screens/SagaDetail";
import { Instance } from "./screens/Instance";
import { Attention } from "./screens/Attention";
import { Messages } from "./screens/Messages";

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

  if (meQ.isLoading) {
    return (
      <div className="grid min-h-full place-items-center text-slate-500">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 animate-pulse text-accent" /> starting operator console…
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/console" replace />} />
        <Route path="/console" element={<Projects />} />
        <Route path="/console/p/:projectId" element={<Sagas />} />
        <Route path="/console/p/:projectId/attention" element={<Attention />} />
        <Route path="/console/p/:projectId/messages" element={<Messages />} />
        <Route path="/console/sagas/:sagaId" element={<SagaDetail />} />
        <Route path="/console/instances/:instanceId" element={<Instance />} />
        <Route path="*" element={<Navigate to="/console" replace />} />
      </Route>
    </Routes>
  );
}
