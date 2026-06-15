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
import { Button, Spinner } from "../components/ui";

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
  // Collapsed by default on small screens so the floating header + ribbon don't
  // sandwich the diagram into a sliver; the operator can still toggle it open.
  const [ribbonCollapsed, setRibbonCollapsed] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 640px)").matches,
  );
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
  // Re-run only the reads that failed (the error-state retry on the hero).
  const retryReads = () => {
    sagasQ.refetch();
    if (versionId) {
      versionQ.refetch();
      bpmnQ.refetch();
    }
    if (mode === "single" && instanceId) instanceQ.refetch();
    if (mode === "aggregate" && sagaId) heatmapQ.refetch();
  };
  const doCancel = async () => {
    if (!instanceId) return;
    setActing(true);
    try {
      await api.cancel(instanceId);
      toast("success", "Cancel accepted. Roll-back starting.");
      setConfirming(false);
      setReversePreview(false);
      refetchAll();
    } catch (e) {
      toast("error", e instanceof ApiError && e.isConflict ? "State changed under you. Refreshing." : e instanceof Error ? e.message : "Cancel failed.");
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
      toast("error", e instanceof ApiError && e.isConflict ? "State changed under you. Refreshing." : e instanceof Error ? e.message : "Retry failed.");
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
  const loadError =
    sagasQ.isError ||
    versionQ.isError ||
    bpmnQ.isError ||
    (mode === "single" && instanceQ.isError) ||
    (mode === "aggregate" && heatmapQ.isError);

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
            <Suspense fallback={<FieldMessage>Loading diagram…</FieldMessage>}>
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
              title="Ready for the first run"
              hint="When a definition is published and your services start sagas, its living diagram appears here and lights up as work moves through it."
            />
          ) : noVersion ? (
            <EmptyField
              title="No version published yet"
              hint="Publish a version of this definition to bring its diagram to life on this stage."
            />
          ) : loadError ? (
            <EmptyField
              title="Couldn't reach the orchestrator"
              hint="The console lost its read connection to the worker. Check that the service is running, then load the stage again."
              action={
                <Button variant="primary" onClick={retryReads}>
                  Try again
                </Button>
              }
            />
          ) : onRoot && sagasQ.isSuccess ? (
            <FieldMessage>Opening the most active run…</FieldMessage>
          ) : (
            <FieldMessage>Loading…</FieldMessage>
          )}

          {/* Floating stage header */}
          {showDiagram && contextSaga && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2 sm:p-3">
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

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// The model AT REST. When there is no live diagram to show, the empty state is not a
// "nothing here" card — it is a calm, unlit schematic of a saga (start · service task ·
// gateway · two branches · join · end) drawn in the SAME card + edge language as the
// living diagram. It teaches the interface and previews the hero. On mount the parts
// ink in left-to-right (opacity-only, exponential ease-out); under reduced motion they
// are simply present. Decorative — aria-hidden, no information lives here.
function RestingCircuit({ className = "" }: { className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg || prefersReducedMotion()) return;
    const parts = Array.from(svg.querySelectorAll<SVGElement>("[data-rest-part]"));
    const anims = parts
      .map((el, i) => {
        if (typeof el.animate !== "function") return null;
        const a = el.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 380,
          delay: 140 + i * 45,
          easing: "cubic-bezier(0.16,1,0.3,1)",
          fill: "both",
        });
        a.onfinish = () => {
          el.style.opacity = "";
        };
        return a;
      })
      .filter((a): a is Animation => a !== null);
    return () => anims.forEach((a) => a.cancel());
  }, []);

  const edge: React.CSSProperties = {
    fill: "none",
    stroke: "var(--border-strong)",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    opacity: 0.8,
  };
  const card: React.CSSProperties = { fill: "var(--surface-card)", stroke: "var(--border-strong)", strokeWidth: 1.5 };

  return (
    <svg
      ref={ref}
      viewBox="0 0 680 220"
      className={className}
      role="presentation"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* connectors first, then nodes — document order doubles as the left→right reveal */}
      <path data-rest-part d="M59 110 H92" style={edge} />
      <path data-rest-part d="M220 110 H262" style={edge} />
      <path data-rest-part d="M282 90 V62 H350" style={edge} />
      <path data-rest-part d="M282 130 V158 H350" style={edge} />
      <path data-rest-part d="M478 62 H560 V92" style={edge} />
      <path data-rest-part d="M478 158 H560 V128" style={edge} />
      <path data-rest-part d="M578 110 H620" style={edge} />
      <circle data-rest-part cx="44" cy="110" r="15" style={card} />
      <rect data-rest-part x="92" y="86" width="128" height="48" rx="12" style={card} />
      <polygon data-rest-part points="282,90 302,110 282,130 262,110" style={card} />
      <rect data-rest-part x="350" y="40" width="128" height="44" rx="12" style={card} />
      <rect data-rest-part x="350" y="136" width="128" height="44" rx="12" style={card} />
      <polygon data-rest-part points="560,92 578,110 560,128 542,110" style={card} />
      <circle data-rest-part cx="636" cy="110" r="15" style={{ ...card, strokeWidth: 2.4 }} />
    </svg>
  );
}

function EmptyField({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) {
  return (
    <div className="stage-field relative grid h-full w-full place-items-center overflow-hidden p-8">
      <div className="w-full max-w-2xl">
        <RestingCircuit className="anim-fade h-auto w-full max-w-xl" />
        <div className="anim-rise mt-8 max-w-xl">
          <h1 className="font-display text-2xl text-content-strong">{title}</h1>
          <p className="mt-3 max-w-[56ch] text-sm leading-relaxed text-content-secondary">{hint}</p>
          {action ? <div className="pointer-events-auto mt-5">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}

function HeatLegend({ idle }: { idle: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface-card px-3 py-2 text-2xs text-content-secondary shadow-sm">
      {idle ? (
        <span>No runs in flight. Showing the model at rest.</span>
      ) : (
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-accent" /> busy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-danger" /> failing
          </span>
          <span>count = runs at that node</span>
        </div>
      )}
    </div>
  );
}
