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
import "bpmn-js/dist/assets/diagram-js.css";
import { glassRendererModule } from "./bpmn/GlassRenderer";
import { AuroraField, type Hotspot } from "./bpmn/AuroraField";
import { layoutDiagram } from "./bpmn/layout";
import type { BpmnElement } from "../api/types";
import type { DiagramOverlay, FlowPlan, HeatPlan } from "../lib/flow";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const MAX_TOKENS = 4; // a few travelling tokens read as DIRECTION; more reads as confetti

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

/** Truncate to <= max chars on a WORD boundary with a trailing ellipsis. The full
 *  string rides the badge's title attribute, so nothing is lost. */
function truncateWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  const head = sp > max * 0.5 ? cut.slice(0, sp) : cut;
  return head.replace(/[\s.,;:–-]+$/, "") + "…";
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
  // The one-shot "circuit settles on success" beat: elements injected for it, plus an
  // edge-trigger guard so it fires once on the false→true settle (never on a prop
  // tick, a selection change, a re-fit, or a replay scrub).
  const beatNodes = useRef<{ el: Element; anim: Animation }[]>([]);
  const settledPlayed = useRef(false);
  const lastBeatAt = useRef(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Bumped after a font-late re-import so the overlay effect re-applies markers/tokens.
  const [refit, setRefit] = useState(0);

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
    // A new diagram: let an already-completed run play the settle beat on arrival.
    settledPlayed.current = false;
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
      // diagram-js measures (and wraps) labels at import time, so the real General
      // Sans metrics MUST be resolved BEFORE importXML — otherwise text is measured
      // with a narrow fallback and a 2-word label wraps one character per line.
      // Preloading the two weights is not enough on its own: also block on
      // document.fonts.ready (all in-flight font loads settled).
      let fontsReady = false;
      if (typeof document !== "undefined" && document.fonts) {
        try {
          await Promise.all([
            document.fonts.load('600 13px "General Sans"'),
            document.fonts.load('500 13px "General Sans"'),
            document.fonts.ready,
          ]);
          fontsReady = true;
        } catch {
          /* font API hiccup — proceed with fallback metrics, re-measure below */
        }
      }

      try {
        const xml = hasDi(bpmnXml) ? bpmnXml : await layoutDiagram(bpmnXml);
        await viewer.importXML(xml);
        if (disposed) return;
        const canvas = viewer.get("canvas");
        canvas.zoom("fit-viewport", "auto");
        // Click / hover handlers register on the persistent eventBus (they survive a
        // re-import), so they're wired exactly once here.
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

        // Safety net: if we imported before the web fonts settled, re-import ONCE
        // when they do — diagram-js only measures labels at import, so this re-wraps
        // them with real metrics. The refit nonce re-applies overlays/tokens after.
        if (!fontsReady && typeof document !== "undefined" && document.fonts?.ready) {
          document.fonts.ready
            .then(() => (disposed ? undefined : viewer.importXML(xml)))
            .then(() => {
              if (disposed) return;
              try {
                canvas.zoom("fit-viewport", "auto");
              } catch {
                /* ignore */
              }
              setRefit((n) => n + 1);
            })
            .catch(() => {
              /* re-measure is best-effort */
            });
        }
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
      clearBeat(beatNodes);
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
    void refit; // re-apply trigger: bumped after a font-late re-import wipes the canvas
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
    clearBeat(beatNodes); // cancel any in-flight settle beat before re-applying
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
    const addBadge = (id: string, text: string, tone: string, title?: string) => {
      try {
        // Build the badge node imperatively (textContent, never innerHTML) so a model
        // name / failure reason can never inject markup.
        const node = document.createElement("div");
        node.className = `ebpmn-overlay-badge ${tone}`;
        node.textContent = text;
        if (title) node.title = title;
        const oid = overlays.add(id, { position: { top: -12, left: -6 }, html: node });
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
      overlay.failed.forEach((f) => addBadge(f.elementId, "✕ " + truncateWords(f.reason, 28), "danger", f.reason));
      overlay.badges.forEach((b) => addBadge(b.elementId, b.text, b.tone));
    }

    // Feed the aurora field the live light pools (it resolves geometry itself). A
    // finished, successful circuit rests on a plain pale field — the pools breathe
    // out in the settle beat below rather than holding a steady glow.
    const reduced = prefersReducedMotion();
    let spots: Hotspot[];
    if (mode === "aggregate") {
      spots = heat.nodes.map((n) => ({
        id: n.elementId,
        kind: n.hot ? "hot" : n.tier >= 2 ? "live" : "settle",
        weight: n.hot ? 1 : 0.5 + n.tier * 0.25,
      }));
    } else if (flow.settled) {
      spots = [];
    } else {
      spots = [
        ...overlay.current.map((id) => ({ id, kind: "live" as const })),
        ...overlay.failed.map((f) => ({ id: f.elementId, kind: "hot" as const })),
        ...flow.settledNodes.map((id) => ({ id, kind: "settle" as const, weight: 0.8 })),
      ];
    }

    // THE SIGNATURE — the circuit settles on success. Edge-triggered on the
    // false→true settle so it plays ONCE: not on a prop tick, a selection, a
    // re-fit, or a replay scrub. Under reduced motion it never plays — the static
    // settled-green state below carries every bit of the information.
    if (mode === "single" && !flow.settled) settledPlayed.current = false;
    const playBeat =
      mode === "single" && !!flow.settled && !settledPlayed.current && !reduced && Date.now() - lastBeatAt.current > 4000;
    if (playBeat) {
      settledPlayed.current = true;
      lastBeatAt.current = Date.now();
      auroraRef.current?.exhale(); // snapshot the live pools BEFORE they're cleared, then breathe out
      playSettleBeat(registry, flow, beatNodes);
    }
    auroraRef.current?.setHotspots(spots);
  }, [overlay, flow, heat, mode, reverse, ready, refit]);

  // ---- Selection ring (its OWN effect) ------------------------------------
  // Clicking a node must NOT tear down the marker/token reconciliation above or
  // restart the live SMIL token march, so the selection highlight is applied and
  // cleared in isolation. Keyed on the selection (plus `ready`/`refit`, since a
  // font-late re-import wipes every canvas marker and the ring must re-land).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready || !selectedElement) return;
    void refit;
    let canvas: any;
    try {
      canvas = viewer.get("canvas");
    } catch {
      return;
    }
    try {
      canvas.addMarker(selectedElement, MARKER.selected);
    } catch {
      /* not in this diagram */
    }
    return () => {
      try {
        canvas.removeMarker(selectedElement, MARKER.selected);
      } catch {
        /* gone */
      }
    };
  }, [selectedElement, ready, refit]);

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
      // Compensation walks backward in amber; derive the halo from the warning token
      // so the two stay in lockstep (no second hard-coded amber to drift).
      core.style.fill = "var(--state-warning)";
      halo.style.fill = "color-mix(in oklch, var(--state-warning) 45%, transparent)";
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

type BeatStore = { current: { el: Element; anim: Animation }[] };
const EXPO = "cubic-bezier(0.16,1,0.3,1)"; // exponential ease-out — confident, no bounce

/** THE SIGNATURE BEAT — "the circuit settles on success". One orchestrated ~1.5s
 *  moment, played once (the overlay effect edge-triggers it on the settle):
 *    1. the live teal current sprints the final edge into the End event;
 *    2. the End event blooms — a soft green ring expands and eases out;
 *    3. a wave of settle-light sweeps BACKWARD End→Start, nodes + edges catching
 *       green in reverse, staggered with an exponential ease-out;
 *    4. each element rests on the calm settled-green it ALREADY wears statically.
 *  Everything injected is additive light over the resting markers, so the beat's end
 *  frame IS the static settled state — the reduced-motion path simply skips it and
 *  loses nothing. */
function playSettleBeat(registry: any, flow: FlowPlan, store: BeatStore) {
  if (!registry) return;
  const order = flow.settleOrder ?? [];
  // ms between elements. Clamp so the backward sweep lands in a fixed ~1.4-1.6s
  // window even on a 30-40 node saga (a flat 58ms would stretch to ~2.6-3s and lose
  // its punch). Small sagas keep the full 58ms legible spacing.
  const STAGGER = Math.min(58, Math.round(1100 / Math.max(order.length, 1)));
  const SPRINT = 340; // the current's final dash into the End event
  const SWEEP_AT = SPRINT - 70; // bloom + sweep begin just as the dash lands

  // (1) the current races the final edge into End (teal hands off to green).
  const intoEnd = order.find((s) => s.kind === "edge");
  if (intoEnd) sprintIntoEnd(registry, intoEnd.id, store);

  // (2) the End event blooms.
  for (const id of flow.settledNodes ?? []) bloomNode(registry, id, SWEEP_AT, store);

  // (3) the wave sweeps backward End→Start.
  order.forEach((step, i) => {
    const delay = SWEEP_AT + i * STAGGER;
    if (step.kind === "node") settleNode(registry, step.id, delay, store);
    else settleEdge(registry, step.id, delay, store);
  });
}

function trackBeat(store: BeatStore, el: Element, anim: Animation) {
  store.current.push({ el, anim });
  anim.onfinish = () => {
    try {
      el.remove();
    } catch {
      /* gone */
    }
  };
}

/** Cancel any in-flight settle beat and remove its injected light (called before a
 *  re-apply and on teardown so a poll/scrub mid-beat never leaves stray elements). */
function clearBeat(store: BeatStore) {
  for (const { el, anim } of store.current) {
    try {
      anim.cancel();
    } catch {
      /* ignore */
    }
    try {
      el.remove();
    } catch {
      /* ignore */
    }
  }
  store.current = [];
}

function supportsOffsetPath(): boolean {
  return typeof CSS !== "undefined" && !!CSS.supports?.("offset-path", 'path("M0 0")');
}

/** A connection's visible path + its `d` (absolute diagram coords, like the token). */
function edgePath(registry: any, edgeId: string): { visual: SVGGElement; d: string } | null {
  const gfx: SVGGElement | undefined = registry.getGraphics?.(edgeId);
  const visual = gfx?.querySelector(".djs-visual") as SVGGElement | null;
  const path = visual?.querySelector(":scope > path") as SVGPathElement | null;
  const d = path?.getAttribute("d");
  if (!visual || !d) return null;
  return { visual, d };
}

/** (1) A bright teal token sprints the final edge and lands in the End event, via CSS
 *  motion-path (a transform). Skipped where unsupported — the bloom + sweep carry on. */
function sprintIntoEnd(registry: any, edgeId: string, store: BeatStore) {
  const e = edgePath(registry, edgeId);
  if (!e || !supportsOffsetPath()) return;
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "ebpmn-settle-sprint");
  const halo = document.createElementNS(SVG_NS, "circle");
  halo.setAttribute("class", "halo");
  halo.setAttribute("r", "9");
  const core = document.createElementNS(SVG_NS, "circle");
  core.setAttribute("class", "core");
  core.setAttribute("r", "3.8");
  g.appendChild(halo);
  g.appendChild(core);
  (g.style as any).offsetPath = `path('${e.d}')`;
  (g.style as any).offsetRotate = "0deg";
  e.visual.appendChild(g);
  const anim = g.animate(
    [
      { offsetDistance: "0%", opacity: 0 },
      { offsetDistance: "14%", opacity: 1, offset: 0.14 },
      { offsetDistance: "92%", opacity: 1, offset: 0.86 },
      { offsetDistance: "100%", opacity: 0 },
    ] as any,
    { duration: 360, easing: EXPO, fill: "both" },
  );
  trackBeat(store, g, anim);
}

/** (2) The End event blooms: a soft green ring expands and eases out (scale+opacity). */
function bloomNode(registry: any, nodeId: string, delay: number, store: BeatStore) {
  const el = registry.get?.(nodeId);
  const gfx: SVGGElement | undefined = registry.getGraphics?.(nodeId);
  const visual = gfx?.querySelector(".djs-visual") as SVGGElement | null;
  if (!el || el.width == null || !visual) return;
  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("class", "ebpmn-settle-bloom");
  ring.setAttribute("cx", String(el.width / 2));
  ring.setAttribute("cy", String(el.height / 2));
  ring.setAttribute("r", String(Math.max(el.width, el.height) / 2));
  (ring.style as any).transformBox = "fill-box";
  ring.style.transformOrigin = "center";
  visual.appendChild(ring);
  const anim = ring.animate(
    [
      { transform: "scale(0.5)", opacity: 0.7 },
      { transform: "scale(2.5)", opacity: 0 },
    ],
    { duration: 780, delay, easing: EXPO, fill: "both" },
  );
  trackBeat(store, ring, anim);
}

/** (3) A node catches the settle-light: a soft green ring pulses around the resting
 *  card and fades. Additive (a ring, never a fill) so the label stays legible and the
 *  calm green marker remains underneath. */
function settleNode(registry: any, nodeId: string, delay: number, store: BeatStore) {
  const el = registry.get?.(nodeId);
  const gfx: SVGGElement | undefined = registry.getGraphics?.(nodeId);
  const node = gfx?.querySelector(".ebpmn-node") as SVGGElement | null;
  if (!el || el.width == null || !node) return;
  const pad = 5;
  const round = Math.abs(el.width - el.height) < 6; // events / gateways read as round
  const halo = document.createElementNS(SVG_NS, round ? "circle" : "rect");
  halo.setAttribute("class", "ebpmn-settle-halo");
  if (round) {
    halo.setAttribute("cx", String(el.width / 2));
    halo.setAttribute("cy", String(el.height / 2));
    halo.setAttribute("r", String(Math.max(el.width, el.height) / 2 + pad));
  } else {
    halo.setAttribute("x", String(-pad));
    halo.setAttribute("y", String(-pad));
    halo.setAttribute("width", String(el.width + pad * 2));
    halo.setAttribute("height", String(el.height + pad * 2));
    halo.setAttribute("rx", "13");
  }
  (halo.style as any).transformBox = "fill-box";
  halo.style.transformOrigin = "center";
  node.appendChild(halo);
  const anim = halo.animate(
    [
      { opacity: 0, transform: "scale(0.94)" },
      { opacity: 0.7, transform: "scale(1.05)", offset: 0.4 },
      { opacity: 0, transform: "scale(1)" },
    ],
    { duration: 560, delay, easing: EXPO, fill: "both" },
  );
  trackBeat(store, halo, anim);
}

/** (3) An edge catches the settle-light: a bright green flash flows over the resting
 *  green path. The backward stagger across consecutive edges is the visible wave. */
function settleEdge(registry: any, edgeId: string, delay: number, store: BeatStore) {
  const e = edgePath(registry, edgeId);
  if (!e) return;
  const flash = document.createElementNS(SVG_NS, "path");
  flash.setAttribute("class", "ebpmn-settle-flash");
  flash.setAttribute("d", e.d);
  e.visual.appendChild(flash);
  const anim = flash.animate([{ opacity: 0 }, { opacity: 1, offset: 0.38 }, { opacity: 0 }], {
    duration: 540,
    delay,
    easing: EXPO,
    fill: "both",
  });
  trackBeat(store, flash, anim);
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
  const shown = elements.filter((e) => !["sequenceFlow", "association"].includes(e.type));
  return (
    <div className="stage-field flex h-full w-full flex-col overflow-auto p-6">
      <div className="mb-3 text-sm text-content-secondary">
        Diagram unavailable ({reason}). Reading the process as an element list.
      </div>
      <ul className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
        {shown.length === 0 ? (
          <li className="col-span-full rounded-md border border-line bg-surface-card px-3 py-6 text-center text-sm text-content-secondary">
            No elements to show.
          </li>
        ) : (
          shown.map((e) => {
            const isFailed = overlay.failed.some((f) => f.elementId === e.elementId);
            const isCurrent = overlay.current.includes(e.elementId);
            const isDone = overlay.traversed.includes(e.elementId);
            return (
              <li key={e.elementId}>
                <button
                  onClick={() => onSelectElement(e.elementId)}
                  title={e.elementId}
                  className={`w-full truncate rounded-md border px-3 py-2 text-left text-sm text-content transition ${
                    isFailed
                      ? "border-danger/40 bg-danger/10"
                      : isCurrent
                        ? "border-accent/40 bg-accent/10"
                        : isDone
                          ? "border-ok/30 bg-ok/5"
                          : "border-line bg-surface-card hover:border-line-strong"
                  }`}
                >
                  <span className="font-data text-2xs text-content-muted">{e.type}</span>
                  {/* Name renders in body ink (AA); state tone lives on border+bg, and
                      a long name carries an AA-safe tone (teal-700 / red-600) only. */}
                  <span
                    className={`block truncate ${
                      isFailed ? "text-danger-hover" : isCurrent ? "text-accent-press" : "text-content"
                    }`}
                  >
                    {e.name || e.elementId}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
