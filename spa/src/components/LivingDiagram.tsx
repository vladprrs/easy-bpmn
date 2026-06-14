// The living process diagram — the hero (visual-design-brief §3.1, §3.4). Renders the
// BPMN (author DI, else synthesised via bpmn-auto-layout — a hard prerequisite since
// bpmn-js draws nothing DI-less) and makes it ALIVE: the traversed path settles green,
// the live current runs teal with a travelling token toward the frontier, a stall
// interrupts coral, the finished circuit glows. Aggregate mode swaps per-token motion
// for a per-node density heat. Degrades to an element list if render fails, and the
// static illuminated path IS the reduced-motion floor (no information lives only in
// motion). Default export so the Stage can React.lazy() the heavy bpmn-js bundle.

import { useEffect, useRef, useState } from "react";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import { layoutProcess } from "bpmn-auto-layout";
import "bpmn-js/dist/assets/diagram-js.css";
import { glassRendererModule } from "./bpmn/GlassRenderer";
import { AuroraField, type Hotspot } from "./bpmn/AuroraField";
import type { BpmnElement } from "../api/types";
import type { DiagramOverlay, FlowPlan, HeatPlan } from "../lib/flow";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const MAX_TOKENS = 12; // mirror a sane visual cap on the animated frontier

const MARKER = {
  traversed: "ebpmn-traversed",
  current: "ebpmn-current",
  failed: "ebpmn-failed",
  compensated: "ebpmn-compensated",
  settled: "ebpmn-settled",
  selected: "ebpmn-selected",
};

function hasDi(xml: string): boolean {
  return /<bpmndi:BPMNDiagram|<BPMNDiagram/.test(xml);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export default function LivingDiagram({
  bpmnXml,
  elements,
  mode,
  overlay,
  flow,
  heat,
  reverse = false,
  selectedElement,
  onSelectElement,
}: {
  bpmnXml: string | null;
  elements: BpmnElement[];
  mode: "single" | "aggregate";
  overlay: DiagramOverlay;
  flow: FlowPlan;
  heat: HeatPlan;
  reverse?: boolean;
  selectedElement: string | null;
  onSelectElement: (id: string | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<any>(null);
  const auroraRef = useRef<AuroraField | null>(null);
  // Stable click callback so the (expensive) import effect never re-runs on a new
  // parent-render identity of onSelectElement.
  const onSelectRef = useRef(onSelectElement);
  onSelectRef.current = onSelectElement;
  const appliedMarkers = useRef<{ id: string; cls: string }[]>([]);
  const tokenNodes = useRef<SVGGElement[]>([]);
  const overlayIds = useRef<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // The aurora field owns its own WebGL canvas + RAF loop. It's created lazily in
  // the import effect (the canvas only exists on the non-fallback branch) and torn
  // down here on unmount.
  useEffect(() => {
    return () => {
      auroraRef.current?.dispose();
      auroraRef.current = null;
    };
  }, []);

  // ---- Import (only on XML change) ----------------------------------------
  useEffect(() => {
    let disposed = false;
    setReady(false);
    setFailed(null);
    if (!bpmnXml || !hostRef.current) {
      setFailed(bpmnXml ? null : "No BPMN XML available.");
      return;
    }
    const viewer = new NavigatedViewer({
      container: hostRef.current,
      additionalModules: [glassRendererModule],
    });
    viewerRef.current = viewer;
    let ro: ResizeObserver | undefined;
    if (canvasRef.current && !auroraRef.current) {
      auroraRef.current = new AuroraField(canvasRef.current);
    }
    const aurora = auroraRef.current;

    (async () => {
      try {
        // Load the label font BEFORE import so diagram-js measures (and therefore
        // wraps) labels with the real General Sans metrics, not a fallback — else
        // text is measured narrow, never wraps, and overflows the node.
        if (typeof document !== "undefined" && document.fonts?.load) {
          try {
            await Promise.all([
              document.fonts.load('600 13px "General Sans"'),
              document.fonts.load('500 13px "General Sans"'),
            ]);
          } catch {
            /* font API hiccup — proceed with fallback metrics */
          }
        }
        const xml = hasDi(bpmnXml) ? bpmnXml : await layoutProcess(bpmnXml);
        await viewer.importXML(xml);
        if (disposed) return;
        const canvas = viewer.get("canvas");
        canvas.zoom("fit-viewport", "auto");
        viewer.on("element.click", (e: any) => {
          const id = e?.element?.id;
          if (id) onSelectRef.current(id);
        });
        // Hover: lift the node you're reading, let its peers recede (CSS-driven).
        const host = hostRef.current;
        viewer.on("element.hover", (e: any) => {
          const id = e?.element?.id;
          if (!id || !host) return;
          host.classList.add("ebpmn-hovering");
          try {
            canvas.addMarker(id, "ebpmn-hover");
          } catch {
            /* gone */
          }
        });
        viewer.on("element.out", (e: any) => {
          const id = e?.element?.id;
          if (!id || !host) return;
          host.classList.remove("ebpmn-hovering");
          try {
            canvas.removeMarker(id, "ebpmn-hover");
          } catch {
            /* gone */
          }
        });
        // The aurora field reads node geometry + the live viewbox transform so its
        // light tracks the diagram through pan/zoom.
        aurora?.attach(viewer);
        // The circuit powers up: nodes ignite left→right, edges ink in after.
        playEntrance(viewer);
        // Near-full-bleed: re-fit on container resize.
        if (hostRef.current && "ResizeObserver" in window) {
          ro = new ResizeObserver(() => {
            try {
              canvas.zoom("fit-viewport", "auto");
            } catch {
              /* ignore */
            }
          });
          ro.observe(hostRef.current);
        }
        setReady(true);
      } catch (err) {
        if (!disposed) setFailed(err instanceof Error ? err.message : "Diagram render failed.");
      }
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      aurora?.detach();
      try {
        viewer.destroy();
      } catch {
        /* ignore */
      }
      viewerRef.current = null;
      appliedMarkers.current = [];
      tokenNodes.current = [];
      overlayIds.current = [];
    };
    // `elements`/`onSelectElement` intentionally omitted: elements change with bpmnXml,
    // and the click handler reads the latest callback via onSelectRef — so a new parent
    // identity never re-imports the (heavy) diagram.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bpmnXml]);

  // ---- Apply / refresh overlay + flow + heat (once ready) ------------------
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready) return;
    let canvas: any, overlays: any, registry: any;
    try {
      canvas = viewer.get("canvas");
      overlays = viewer.get("overlays");
      registry = viewer.get("elementRegistry");
    } catch {
      return;
    }

    // Clear prior markers / tokens / badges.
    for (const m of appliedMarkers.current) {
      try {
        canvas.removeMarker(m.id, m.cls);
      } catch {
        /* gone */
      }
    }
    appliedMarkers.current = [];
    for (const n of tokenNodes.current) n.remove();
    tokenNodes.current = [];
    for (const id of overlayIds.current) {
      try {
        overlays.remove(id);
      } catch {
        /* ignore */
      }
    }
    overlayIds.current = [];

    const addMarker = (id: string, cls: string) => {
      try {
        canvas.addMarker(id, cls);
        appliedMarkers.current.push({ id, cls });
      } catch {
        /* not in this diagram */
      }
    };
    const addBadge = (id: string, text: string, tone: string) => {
      try {
        const oid = overlays.add(id, {
          position: { top: -12, left: -6 },
          html: `<div class="ebpmn-overlay-badge ${tone}">${text}</div>`,
        });
        overlayIds.current.push(oid);
      } catch {
        /* skip */
      }
    };

    if (mode === "aggregate") {
      // Density heat: tier glow per node, coral where runs fail; throughput edges.
      for (const e of heat.liveEdges) addMarker(e, "ebpmn-flow-live");
      for (const n of heat.nodes) {
        addMarker(n.elementId, n.hot ? "ebpmn-heat-hot" : `ebpmn-heat-${n.tier}`);
        addBadge(n.elementId, String(n.count), n.hot ? "flow hot" : "flow");
      }
    } else {
      // Living flow: settled path (green) · live current (teal) · interrupt (coral).
      for (const e of flow.doneEdges) addMarker(e, "ebpmn-flow-done");
      for (const e of flow.interruptEdges) addMarker(e, "ebpmn-flow-interrupt");
      for (const e of flow.liveEdges) addMarker(e, "ebpmn-flow-live");
      for (const id of flow.settledNodes) addMarker(id, MARKER.settled);

      // Runtime-state node markers (state wins over category stroke).
      overlay.traversed.forEach((id) => addMarker(id, MARKER.traversed));
      overlay.compensated.forEach((id) => addMarker(id, MARKER.compensated));
      overlay.current.forEach((id) => addMarker(id, MARKER.current));
      overlay.failed.forEach((f) => addMarker(f.elementId, MARKER.failed));

      // Travelling tokens along the frontier approach (SMIL, reduced-motion safe).
      if (!prefersReducedMotion()) {
        injectTokens(registry, flow.tokenEdges.slice(0, MAX_TOKENS), reverse, tokenNodes);
      }

      // Badges: failure reasons, gateway decisions, timers.
      overlay.failed.forEach((f) => addBadge(f.elementId, "✕ " + f.reason.slice(0, 28), "danger"));
      overlay.badges.forEach((b) => addBadge(b.elementId, b.text, b.tone));
    }

    // Selection highlight.
    if (selectedElement) addMarker(selectedElement, MARKER.selected);

    // Feed the aurora field the live light pools (it resolves geometry itself).
    const spots: Hotspot[] =
      mode === "aggregate"
        ? heat.nodes.map((n) => ({
            id: n.elementId,
            kind: n.hot ? "hot" : n.tier >= 2 ? "live" : "settle",
            weight: n.hot ? 1 : 0.5 + n.tier * 0.25,
          }))
        : [
            ...overlay.current.map((id) => ({ id, kind: "live" as const })),
            ...overlay.failed.map((f) => ({ id: f.elementId, kind: "hot" as const })),
            ...flow.settledNodes.map((id) => ({ id, kind: "settle" as const, weight: 0.8 })),
          ];
    auroraRef.current?.setHotspots(spots);
  }, [overlay, flow, heat, mode, reverse, selectedElement, ready]);

  if (failed) {
    return <ElementListFallback elements={elements} overlay={overlay} reason={failed} onSelectElement={onSelectElement} />;
  }

  return (
    <div className="stage-field relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="ebpmn-aurora pointer-events-none absolute inset-0 h-full w-full" />
      <div ref={hostRef} className="ebpmn-host absolute inset-0 h-full w-full" />
      {!ready && (
        <div className="anim-fade absolute inset-0 grid place-items-center text-sm text-content-muted">
          <span className="font-data">rendering diagram…</span>
        </div>
      )}
    </div>
  );
}

/** Inject a glowing token that rides an edge path (SMIL animateMotion + mpath). The
 *  token is a sibling of the connection's path so they share an exact coordinate
 *  space. Reverse mode walks it backward (compensation) in amber. */
function injectTokens(registry: any, edgeIds: string[], reverse: boolean, store: { current: SVGGElement[] }) {
  for (const id of edgeIds) {
    const gfx: SVGGElement | undefined = registry.getGraphics?.(id);
    const visual = gfx?.querySelector(".djs-visual") as SVGGElement | null;
    // The connection's VISIBLE path is a direct child of .djs-visual; a bpmn-js
    // connection also nests an arrowhead <path> inside <defs><marker> — skip that.
    const path = visual?.querySelector(":scope > path") as SVGPathElement | null;
    if (!visual || !path) continue;
    if (!path.id) path.id = `ebpmn-edge-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", `ebpmn-flow-token${reverse ? " reverse" : ""}`);
    const halo = document.createElementNS(SVG_NS, "circle");
    halo.setAttribute("class", "halo");
    halo.setAttribute("r", "8.5");
    const core = document.createElementNS(SVG_NS, "circle");
    core.setAttribute("class", "core");
    core.setAttribute("r", "3.6");
    if (reverse) {
      core.style.fill = "var(--state-warning)";
      halo.style.fill = "rgba(207,138,24,0.45)";
    }
    const motion = document.createElementNS(SVG_NS, "animateMotion");
    motion.setAttribute("dur", "2.6s");
    motion.setAttribute("repeatCount", "indefinite");
    motion.setAttribute("rotate", "0");
    motion.setAttribute("calcMode", "linear");
    if (reverse) {
      motion.setAttribute("keyPoints", "1;0");
      motion.setAttribute("keyTimes", "0;1");
    }
    const mpath = document.createElementNS(SVG_NS, "mpath");
    mpath.setAttributeNS(XLINK, "xlink:href", `#${path.id}`);
    mpath.setAttribute("href", `#${path.id}`);
    motion.appendChild(mpath);
    g.appendChild(halo);
    g.appendChild(core);
    g.appendChild(motion);
    visual.appendChild(g);
    store.current.push(g);
  }
}

/** The diagram "powers up" on load: nodes ignite left→right with a soft scale-in,
 *  edges + labels ink in just after. WAAPI so it composes with the resting CSS;
 *  inline styles are cleared on finish. A no-op under reduced motion (the diagram
 *  simply appears — no information lives only in this motion). */
function playEntrance(viewer: any) {
  if (prefersReducedMotion()) return;
  let registry: any;
  try {
    registry = viewer.get("elementRegistry");
  } catch {
    return;
  }
  const shapes = registry
    .filter((el: any) => el.parent && !el.waypoints && !el.labelTarget && el.x != null)
    .sort((a: any, b: any) => a.x - b.x || a.y - b.y);
  shapes.forEach((el: any, i: number) => {
    const node = registry.getGraphics(el)?.querySelector?.(".ebpmn-node") as (SVGElement & { animate?: any }) | null;
    if (!node?.animate) return;
    const anim = node.animate(
      [
        { opacity: 0, transform: "scale(0.86) translateY(8px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 460, delay: Math.min(i * 26, 720), easing: "cubic-bezier(0.16,1,0.3,1)", fill: "both" },
    );
    anim.onfinish = () => {
      node.style.opacity = "";
      node.style.transform = "";
    };
  });
  registry
    .filter((el: any) => el.waypoints || el.labelTarget)
    .forEach((el: any) => {
      const vis = registry.getGraphics(el)?.querySelector?.(".djs-visual") as (SVGElement & { animate?: any }) | null;
      if (!vis?.animate) return;
      const anim = vis.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: 340, easing: "ease-out", fill: "both" });
      anim.onfinish = () => {
        vis.style.opacity = "";
      };
    });
}

function ElementListFallback({
  elements,
  overlay,
  reason,
  onSelectElement,
}: {
  elements: BpmnElement[];
  overlay: DiagramOverlay;
  reason: string;
  onSelectElement: (id: string | null) => void;
}) {
  // The diagram IS the hero, so the textual element list is the resilient floor.
  return (
    <div className="stage-field flex h-full w-full flex-col overflow-auto p-6">
      <div className="mb-3 text-sm text-content-secondary">
        Diagram unavailable ({reason}). Reading the process as an element list.
      </div>
      <ul className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
        {elements
          .filter((e) => !["sequenceFlow", "association"].includes(e.type))
          .map((e) => {
            const isFailed = overlay.failed.some((f) => f.elementId === e.elementId);
            const isCurrent = overlay.current.includes(e.elementId);
            const isDone = overlay.traversed.includes(e.elementId);
            return (
              <li key={e.elementId}>
                <button
                  onClick={() => onSelectElement(e.elementId)}
                  title={e.elementId}
                  className={`w-full truncate rounded-md border px-3 py-2 text-left text-sm transition ${
                    isFailed
                      ? "border-danger/40 bg-danger/10 text-danger"
                      : isCurrent
                        ? "border-accent/40 bg-accent/10 text-accent"
                        : isDone
                          ? "border-ok/30 bg-ok/5 text-content"
                          : "border-line bg-surface-card text-content hover:border-line-strong"
                  }`}
                >
                  <span className="font-data text-2xs text-content-muted">{e.type}</span>
                  <span className="block truncate">{e.name || e.elementId}</span>
                </button>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
