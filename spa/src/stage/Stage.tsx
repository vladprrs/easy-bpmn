// The Process Stage — the single screen (visual-design-brief §4). Opens directly onto
// a process's living diagram; switching process, dropping into a run, and finding a
// transaction are controls, not screens. Routes (all render this):
//   /console                         → auto-select the most-relevant run (alive on load)
//   /console/p/:sagaId               → aggregate "living heatmap"
//   /console/p/:sagaId/i/:instanceId → single-instance living flow (permalink)
//   /console/i/:instanceId           → deep-link; resolves its saga then canonicalises

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { ApiError, api } from "../api/client";
import { subscribeInstanceHistory, type LiveStatus } from "../api/stream";
import type { HistoryEvent } from "../api/types";
import { useApp } from "../store";
import { buildElementIndex } from "../lib/elements";
import { buildAdjacency, computeOverlay, deriveFlow, deriveHeat } from "../lib/flow";
import { compensationPreview } from "../lib/compensation";
import { canCancel, canRetry, isStuck } from "../lib/guards";
import { pickFeaturedSaga, pickRelevantInstance, summarize } from "./model";
import { ChromeBar } from "./ChromeBar";
import { StageHeader } from "./StageHeader";
import { NarrationRibbon } from "./NarrationRibbon";
import { Drawer, type DrawerTab } from "./Drawer";
import { CommandPalette } from "./CommandPalette";
import { ConfirmCancel } from "./ConfirmCancel";
import { IncidentCallout } from "./IncidentCallout";
import { Toasts } from "../components/Toasts";
import { Spinner } from "../components/ui";

const LivingDiagram = lazy(() => import("../components/LivingDiagram"));

const EMPTY_OVERLAY = { traversed: [], current: [], failed: [], compensated: [], badges: [] };
const EMPTY_FLOW = { liveEdges: [], doneEdges: [], interruptEdges: [], tokenEdges: [], settledNodes: [] };
const EMPTY_HEAT = { nodes: [], liveEdges: [], max: 0 };

function mergeEvents(prev: HistoryEvent[], next: HistoryEvent[]): HistoryEvent[] {
  if (next.length === 0) return prev;
  const seen = new Set(prev.map((e) => e.historyEventId));
  const add = next.filter((e) => !seen.has(e.historyEventId));
  return add.length ? [...prev, ...add] : prev;
}

export function Stage() {
  const { sagaId, instanceId } = useParams<{ sagaId?: string; instanceId?: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useApp((s) => s.me);
  const workspaceId = useApp((s) => s.workspaceId);
  const setMe = useApp((s) => s.setMe);
  const toast = useApp((s) => s.toast);

  const onRoot = !sagaId && !instanceId;
  const mode: "single" | "aggregate" = instanceId ? "single" : "aggregate";

  // ---- Chrome-level reads --------------------------------------------------
  const sagasQ = useQuery({ queryKey: ["sagas", workspaceId], queryFn: () => api.sagas(workspaceId) });
  const attentionQ = useQuery({
    queryKey: ["attention", workspaceId],
    queryFn: () => api.attention(workspaceId),
    refetchInterval: 15_000,
  });
  const sagas = sagasQ.data?.sagas ?? [];
  const attention = attentionQ.data?.items ?? [];

  const featured = useMemo(() => (onRoot ? pickFeaturedSaga(sagas) : null), [onRoot, sagas]);
  const contextSagaId = sagaId ?? featured?.sagaId ?? null;
  const contextSaga = contextSagaId ? sagas.find((s) => s.sagaId === contextSagaId) ?? null : null;
  const summary = useMemo(() => summarize(contextSaga?.counts), [contextSaga]);

  // Instances of the context saga (auto-select + mode toggle). Cheap, list-only.
  const ctxInstancesQ = useQuery({
    queryKey: ["ctx-instances", workspaceId, contextSagaId],
    queryFn: () => api.instances({ workspaceId, sagaId: contextSagaId!, limit: 20 }),
    enabled: !!contextSagaId,
  });

  // ---- Single-instance reads ----------------------------------------------
  const instanceQ = useQuery({ queryKey: ["instance", instanceId], queryFn: () => api.instance(instanceId!), enabled: mode === "single" && !!instanceId });
  const instance = instanceQ.data;
  const historyQ = useQuery({ queryKey: ["history", instanceId], queryFn: () => api.instanceHistory(instanceId!), enabled: mode === "single" && !!instanceId });
  const jobsQ = useQuery({ queryKey: ["jobs", instanceId], queryFn: () => api.instanceJobs(instanceId!), enabled: mode === "single" && !!instanceId });

  // ---- Diagram source (version) -------------------------------------------
  const versionId = mode === "single" ? instance?.definitionVersionId ?? null : contextSaga?.activeVersionId ?? null;
  const bpmnQ = useQuery({ queryKey: ["bpmn", versionId], queryFn: () => api.versionBpmn(versionId!), enabled: !!versionId });
  const versionQ = useQuery({ queryKey: ["version", versionId], queryFn: () => api.version(versionId!), enabled: !!versionId });
  const index = useMemo(() => buildElementIndex(versionQ.data), [versionQ.data]);
  const elements = versionQ.data?.elements ?? [];
  const adj = useMemo(() => buildAdjacency(elements), [elements]);

  // ---- Aggregate read ------------------------------------------------------
  const heatmapQ = useQuery({
    queryKey: ["heatmap", sagaId],
    queryFn: () => api.sagaHeatmap(sagaId!),
    enabled: mode === "aggregate" && !!sagaId,
    refetchInterval: 5_000,
  });

  // ---- Live history tail (single) -----------------------------------------
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    setEvents([]);
    setLive(null);
    setScrubIndex(null);
    startedRef.current = false;
  }, [instanceId]);

  useEffect(() => {
    if (historyQ.data) setEvents((prev) => mergeEvents(prev, historyQ.data.events));
  }, [historyQ.data]);

  useEffect(() => {
    if (mode !== "single" || !historyQ.isSuccess || startedRef.current || !instanceId) return;
    startedRef.current = true;
    const handle = subscribeInstanceHistory(instanceId, historyQ.data.nextCursor, {
      onEvents: (ne) => {
        setEvents((prev) => mergeEvents(prev, ne));
        qc.invalidateQueries({ queryKey: ["instance", instanceId] });
        qc.invalidateQueries({ queryKey: ["jobs", instanceId] });
      },
      onStatus: setLive,
    });
    return () => handle.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, historyQ.isSuccess, instanceId]);

  // ---- Auto-select (root) + canonicalise deep-link ------------------------
  useEffect(() => {
    if (!onRoot || !featured || !ctxInstancesQ.data) return;
    const inst = pickRelevantInstance(ctxInstancesQ.data.instances);
    navigate(inst ? `/console/p/${featured.sagaId}/i/${inst.instanceId}` : `/console/p/${featured.sagaId}`, { replace: true });
  }, [onRoot, featured, ctxInstancesQ.data, navigate]);

  useEffect(() => {
    if (instanceId && !sagaId && versionQ.data?.draftId) {
      navigate(`/console/p/${versionQ.data.draftId}/i/${instanceId}`, { replace: true });
    }
  }, [instanceId, sagaId, versionQ.data?.draftId, navigate]);

  // ---- UI state ------------------------------------------------------------
  const [selectedElement, setSelectedElement] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("variables");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [ribbonCollapsed, setRibbonCollapsed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reversePreview, setReversePreview] = useState(false);
  const [acting, setActing] = useState(false);

  // ⌘K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- Derivations ---------------------------------------------------------
  const overlay = useMemo(
    () => (mode === "single" ? computeOverlay(instance, events, scrubIndex) : EMPTY_OVERLAY),
    [mode, instance, events, scrubIndex],
  );
  const baseFlow = useMemo(
    () => (mode === "single" ? deriveFlow(adj, overlay, instance?.status ?? "") : EMPTY_FLOW),
    [mode, adj, overlay, instance?.status],
  );
  // Reverse-pass preview: stream tokens backward along the completed path.
  const flow = useMemo(
    () => (reversePreview ? { ...baseFlow, tokenEdges: baseFlow.doneEdges } : baseFlow),
    [reversePreview, baseFlow],
  );
  const heat = useMemo(() => (mode === "aggregate" ? deriveHeat(adj, heatmapQ.data) : EMPTY_HEAT), [mode, adj, heatmapQ.data]);
  const preview = useMemo(() => compensationPreview(instance?.saga), [instance?.saga]);
  const status = instance?.status ?? "";

  // ---- Actions -------------------------------------------------------------
  const refetchAll = () => {
    if (!instanceId) return;
    qc.invalidateQueries({ queryKey: ["instance", instanceId] });
    qc.invalidateQueries({ queryKey: ["history", instanceId] });
    qc.invalidateQueries({ queryKey: ["jobs", instanceId] });
    qc.invalidateQueries({ queryKey: ["sagas", workspaceId] });
  };
  const doCancel = async () => {
    if (!instanceId) return;
    setActing(true);
    try {
      await api.cancel(instanceId);
      toast("success", "Cancel accepted — roll-back starting.");
      setConfirming(false);
      setReversePreview(false);
      refetchAll();
    } catch (e) {
      toast("error", e instanceof ApiError && e.isConflict ? "State changed under you — refreshing." : e instanceof Error ? e.message : "Cancel failed.");
      refetchAll();
    } finally {
      setActing(false);
    }
  };
  const doRetry = async () => {
    if (!instanceId) return;
    setActing(true);
    try {
      await api.retry(instanceId);
      toast("success", isStuck(status) ? "Resume accepted." : "Retry accepted.");
      refetchAll();
    } catch (e) {
      toast("error", e instanceof ApiError && e.isConflict ? "State changed under you — refreshing." : e instanceof Error ? e.message : "Retry failed.");
      refetchAll();
    } finally {
      setActing(false);
    }
  };

  const toggleMode = () => {
    if (!contextSaga) return;
    if (mode === "single") navigate(`/console/p/${encodeURIComponent(contextSaga.sagaId)}`);
    else {
      const inst = pickRelevantInstance(ctxInstancesQ.data?.instances ?? []);
      if (inst) navigate(`/console/p/${encodeURIComponent(contextSaga.sagaId)}/i/${encodeURIComponent(inst.instanceId)}`);
      else toast("info", "No runs yet for this process.");
    }
  };

  const openDrawer = (tab: DrawerTab) => {
    setDrawerTab(tab);
    setDrawerOpen(true);
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    setMe(null);
    navigate("/login");
  };

  // ---- Render --------------------------------------------------------------
  const noProcesses = sagasQ.isSuccess && sagas.length === 0;
  const noVersion = !!contextSagaId && !!contextSaga && !contextSaga.activeVersionId && mode === "aggregate";
  const showDiagram = !!versionId && !!bpmnQ.data;
  const aggregateIdle = mode === "aggregate" && heatmapQ.isSuccess && (heatmapQ.data?.totalLive ?? 0) === 0;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface-page text-content">
      <ChromeBar
        sagas={sagas}
        currentSaga={contextSaga}
        summary={summary}
        attention={attention}
        live={mode === "single" ? live : null}
        authConfigured={!!me?.authConfigured}
        onOpenPalette={() => setPaletteOpen(true)}
        onPickStatus={() => contextSaga && navigate(`/console/p/${encodeURIComponent(contextSaga.sagaId)}`)}
        onLogout={logout}
      />

      <main className="relative flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          {/* The hero */}
          {showDiagram ? (
            <Suspense fallback={<FieldMessage>Loading the living diagram…</FieldMessage>}>
              <LivingDiagram
                bpmnXml={bpmnQ.data!.bpmnXml}
                elements={elements}
                mode={mode}
                overlay={overlay}
                flow={flow}
                heat={heat}
                reverse={reversePreview}
                selectedElement={selectedElement}
                onSelectElement={(id) => setSelectedElement((cur) => (cur === id ? null : id))}
              />
            </Suspense>
          ) : noProcesses ? (
            <EmptyField
              title="No processes yet"
              hint="A process appears here once a definition is published and your services start sagas."
            />
          ) : noVersion ? (
            <EmptyField title="No published version" hint="Publish a definition version to see its living diagram." />
          ) : onRoot && sagasQ.isSuccess ? (
            <FieldMessage>Finding your most active run…</FieldMessage>
          ) : (
            <FieldMessage>Loading the stage…</FieldMessage>
          )}

          {/* Floating stage header */}
          {showDiagram && contextSaga && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3">
              <div className="w-full max-w-[min(1120px,100%)]">
                <StageHeader
                  mode={mode}
                  saga={contextSaga}
                  instance={instance}
                  heatmap={heatmapQ.data}
                  index={index}
                  workspaceId={workspaceId}
                  onToggleMode={toggleMode}
                  onOpenDetails={() => openDrawer(mode === "single" ? "variables" : "messages")}
                  canCancel={mode === "single" && canCancel(status)}
                  canRetry={mode === "single" && canRetry(status)}
                  isStuck={isStuck(status)}
                  onRequestCancel={() => setConfirming(true)}
                  onRetry={doRetry}
                  acting={acting}
                />
              </div>
            </div>
          )}

          {/* Incident punctuation (single) */}
          {mode === "single" && instance && (isStuck(status) || (instance.openIncidents?.length ?? 0) > 0) && (
            <div className="pointer-events-none absolute bottom-4 left-4 z-10">
              <IncidentCallout instance={instance} index={index} onRetry={doRetry} onRequestCancel={() => setConfirming(true)} acting={acting} />
            </div>
          )}

          {/* Aggregate legend / idle */}
          {mode === "aggregate" && showDiagram && (
            <div className="pointer-events-none absolute bottom-4 left-4 z-10">
              <HeatLegend idle={aggregateIdle} />
            </div>
          )}
        </div>

        {mode === "single" && showDiagram && (
          <NarrationRibbon
            events={events}
            index={index}
            live={live}
            scrubIndex={scrubIndex}
            onScrub={setScrubIndex}
            onSelectElement={(id) => setSelectedElement((cur) => (cur === id ? null : id))}
            collapsed={ribbonCollapsed}
            onToggleCollapsed={() => setRibbonCollapsed((c) => !c)}
          />
        )}
      </main>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        tab={drawerTab}
        onTab={setDrawerTab}
        instance={mode === "single" ? instance : undefined}
        jobs={jobsQ.data?.jobs}
        index={index}
        sagaId={contextSagaId}
        workspaceId={workspaceId}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sagas={sagas}
        attention={attention}
        workspaceId={workspaceId}
        onOpenSurface={(s) => openDrawer(s)}
      />

      <ConfirmCancel
        open={confirming}
        preview={preview}
        index={index}
        acting={acting}
        reversePreviewing={reversePreview}
        onToggleReversePreview={() => setReversePreview((p) => !p)}
        onConfirm={doCancel}
        onClose={() => {
          setConfirming(false);
          setReversePreview(false);
        }}
      />

      <Toasts />
    </div>
  );
}

function FieldMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="stage-field grid h-full w-full place-items-center">
      <Spinner label={typeof children === "string" ? children : undefined} />
    </div>
  );
}

function EmptyField({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="stage-field grid h-full w-full place-items-center p-6">
      <div className="anim-rise max-w-md text-center">
        <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent">
          <Sparkles className="h-6 w-6" />
        </span>
        <h2 className="font-display text-xl text-content-strong">{title}</h2>
        <p className="mt-1.5 text-sm text-content-secondary">{hint}</p>
      </div>
    </div>
  );
}

function HeatLegend({ idle }: { idle: boolean }) {
  return (
    <div className="glass rounded-xl px-3 py-2 text-2xs text-content-secondary">
      {idle ? (
        <span className="text-content-muted">No runs in flight — the static model, ready.</span>
      ) : (
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-accent" /> busy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-danger" /> failing
          </span>
          <span className="text-content-muted">· count = runs at that node</span>
        </div>
      )}
    </div>
  );
}
