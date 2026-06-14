// The living-flow derivation (visual-design-brief §3.4) — PURE. Turns the audit log
// + instance inspection into (a) the runtime overlay (traversed / current / failed /
// compensated / badges) and (b) the "flow plan": which edges read as the calm
// completed path (green), which carry the live current + a travelling token (teal),
// which interrupt in coral, and which nodes settle on a finished circuit. Aggregate
// mode derives a per-node heat plan from the density read. No DOM, no engine call —
// the BpmnViewer renders what this returns, and the same input always yields the same
// flow (so scrubbing the timeline replays it deterministically).

import type {
  BpmnElement,
  HistoryEvent,
  ProcessInstanceInspection,
  SagaHeatmap,
} from "../api/types";

export type FlowTone = "ok" | "danger" | "warn" | "accent";

export interface DiagramOverlay {
  traversed: string[];
  current: string[];
  failed: { elementId: string; reason: string }[];
  compensated: string[];
  badges: { elementId: string; text: string; tone: FlowTone }[];
}

export interface FlowPlan {
  /** Edges carrying the live current (bright teal, marching). */
  liveEdges: string[];
  /** The calm completed path behind the frontier (green). */
  doneEdges: string[];
  /** A path that stalled / failed (coral). */
  interruptEdges: string[];
  /** Edges to animate a travelling token along (the frontier approach). */
  tokenEdges: string[];
  /** Nodes that earn the finished-circuit settle glow. */
  settledNodes: string[];
}

export interface HeatNode {
  elementId: string;
  count: number;
  tier: 1 | 2 | 3;
  hot: boolean; // dominated by incident / compensationFailed
}
export interface HeatPlan {
  nodes: HeatNode[];
  liveEdges: string[]; // edges between two populated nodes (throughput hint)
  max: number;
}

const LIVE_TOKEN_STATUSES = ["active", "waiting", "arrivedAtJoin"];
const TERMINAL_GOOD = new Set(["completed", "compensated"]);
const FAILED_STATE = new Set(["incident", "compensationFailed"]);

interface Edge {
  id: string;
  source: string;
  target: string;
}

export interface Adjacency {
  edges: Edge[];
  byTarget: Map<string, Edge[]>;
  typeOf: Map<string, string>;
}

export function buildAdjacency(elements: BpmnElement[]): Adjacency {
  const edges: Edge[] = [];
  const byTarget = new Map<string, Edge[]>();
  const typeOf = new Map<string, string>();
  for (const el of elements) {
    typeOf.set(el.elementId, el.type);
    if (el.type === "sequenceFlow" && el.sourceRef && el.targetRef) {
      const e: Edge = { id: el.elementId, source: el.sourceRef, target: el.targetRef };
      edges.push(e);
      const list = byTarget.get(e.target) ?? [];
      list.push(e);
      byTarget.set(e.target, list);
    }
  }
  return { edges, byTarget, typeOf };
}

/** Runtime overlay for the diagram. When `cut` is set (scrubbing), state is derived
 *  ONLY from history up to that index — the live token/incident state is ignored, so
 *  the diagram replays the run to that exact moment. */
export function computeOverlay(
  instance: ProcessInstanceInspection | undefined,
  events: HistoryEvent[],
  cut: number | null = null,
): DiagramOverlay {
  const scrubbing = cut != null;
  const shown = scrubbing ? events.slice(0, cut + 1) : events;

  const traversed = new Set<string>();
  for (const e of shown) if (e.elementId) traversed.add(e.elementId);

  // A finished run isn't "anywhere" now — let the circuit settle (no live frontier).
  const terminal = !!instance && ["completed", "compensated", "cancelled"].includes(instance.status);
  const current = new Set<string>();
  if (scrubbing) {
    const last = shown[shown.length - 1];
    if (last?.elementId) current.add(last.elementId);
  } else if (terminal) {
    /* settled — leave current empty */
  } else if (instance?.tokens?.length) {
    for (const t of instance.tokens) if (LIVE_TOKEN_STATUSES.includes(t.status)) current.add(t.positionElementId);
  } else if (instance?.currentElementId) {
    current.add(instance.currentElementId);
  }

  const failed = scrubbing ? [] : (instance?.openIncidents ?? []).map((i) => ({ elementId: i.elementId, reason: i.reason }));

  const compensated = new Set<string>();
  if (!scrubbing) {
    for (const s of instance?.saga?.steps ?? []) {
      if (s.compensationStatus === "compensated") {
        compensated.add(s.elementId);
        if (s.compensationElementId) compensated.add(s.compensationElementId);
      }
    }
  }

  const badges: DiagramOverlay["badges"] = [];
  const decided = new Set<string>();
  for (const e of shown) {
    if ((e.type === "gatewayDecisionEvaluated" || e.type === "ebgDecision") && e.elementId && !decided.has(e.elementId)) {
      decided.add(e.elementId);
      const chosen = e.diagnostics?.chosenFlowId;
      badges.push({ elementId: e.elementId, text: typeof chosen === "string" ? `→ ${chosen}` : "decided", tone: "accent" });
    }
  }
  if (!scrubbing) {
    for (const t of instance?.timers ?? []) {
      badges.push({
        elementId: t.elementId,
        text: t.status === "fired" ? "timer fired" : t.status === "armed" ? "timer armed" : "timer cleared",
        tone: t.status === "fired" ? "warn" : "accent",
      });
    }
  }

  return {
    traversed: [...traversed],
    current: [...current],
    failed,
    compensated: [...compensated],
    badges,
  };
}

/** The living-flow plan: classify each edge as done / live / interrupt and place
 *  travelling tokens on the frontier approach. Semantics the operator can read:
 *  green = done · teal (+token) = happening now · coral = trouble. */
export function deriveFlow(
  adj: Adjacency,
  overlay: DiagramOverlay,
  status: string,
): FlowPlan {
  const traversed = new Set(overlay.traversed);
  const current = new Set(overlay.current);
  const failedIds = new Set(overlay.failed.map((f) => f.elementId));
  const terminalGood = TERMINAL_GOOD.has(status) && current.size === 0;

  const liveEdges: string[] = [];
  const doneEdges: string[] = [];
  const interruptEdges: string[] = [];
  const tokenEdges: string[] = [];

  for (const e of adj.edges) {
    const fromWalked = traversed.has(e.source);
    if (!fromWalked) continue;
    const intoCurrent = current.has(e.target);
    const intoFailed = failedIds.has(e.target);
    const intoWalked = traversed.has(e.target);

    if (intoFailed) {
      interruptEdges.push(e.id);
    } else if (intoCurrent) {
      liveEdges.push(e.id);
      tokenEdges.push(e.id);
    } else if (intoWalked) {
      doneEdges.push(e.id);
    }
  }

  // The finished circuit settles: glow the end event(s) that were reached.
  const settledNodes: string[] = [];
  if (terminalGood && !FAILED_STATE.has(status)) {
    for (const id of traversed) {
      const t = (adj.typeOf.get(id) ?? "").toLowerCase();
      if (t === "endevent") settledNodes.push(id);
    }
  }

  return { liveEdges, doneEdges, interruptEdges, tokenEdges, settledNodes };
}

/** Aggregate density → heat tiers + throughput edges. A node where instances are
 *  failing runs hot (coral); otherwise teal intensity scales with occupancy. */
export function deriveHeat(adj: Adjacency, heatmap: SagaHeatmap | undefined): HeatPlan {
  if (!heatmap || heatmap.nodes.length === 0) return { nodes: [], liveEdges: [], max: 0 };
  const max = heatmap.nodes.reduce((m, n) => Math.max(m, n.count), 0) || 1;
  const populated = new Set(heatmap.nodes.map((n) => n.elementId));

  const nodes: HeatNode[] = heatmap.nodes.map((n) => {
    const hot = (n.byStatus.incident ?? 0) + (n.byStatus.compensationFailed ?? 0) > 0;
    const ratio = n.count / max;
    const tier: 1 | 2 | 3 = ratio >= 0.66 ? 3 : ratio >= 0.33 ? 2 : 1;
    return { elementId: n.elementId, count: n.count, tier, hot };
  });

  // A throughput hint: light edges that connect two currently-populated nodes.
  const liveEdges = adj.edges
    .filter((e) => populated.has(e.source) && populated.has(e.target))
    .map((e) => e.id);

  return { nodes, liveEdges, max };
}
