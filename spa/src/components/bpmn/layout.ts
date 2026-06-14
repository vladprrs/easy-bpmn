// Layout for DI-less BPMN. `bpmn-auto-layout@1.3.0` emits a sparse vertical column
// with NO edges, which renders as scattered disconnected blobs in a sea of empty
// space. Instead we run dagre (battle-tested layered layout) left-to-right, which
// fills a wide canvas with a readable flow and routed orthogonal-ish edges, then
// emit full BPMN DI (BPMNShape + BPMNEdge). Boundary events are placed on their
// host's border. Authored-DI documents skip all of this.

import * as dagre from "@dagrejs/dagre";
import { layoutProcess } from "bpmn-auto-layout";

const NS = {
  bpmn: "http://www.omg.org/spec/BPMN/20100524/MODEL",
  di: "http://www.omg.org/spec/BPMN/20100524/DI",
  dc: "http://www.omg.org/spec/DD/20100524/DC",
  did: "http://www.omg.org/spec/DD/20100524/DI",
};

const EVENT = new Set(["startEvent", "endEvent", "intermediateCatchEvent", "intermediateThrowEvent", "boundaryEvent"]);
const GATEWAY = new Set(["exclusiveGateway", "parallelGateway", "inclusiveGateway", "eventBasedGateway", "complexGateway"]);
const ACTIVITY = new Set([
  "task", "serviceTask", "userTask", "sendTask", "receiveTask", "scriptTask",
  "businessRuleTask", "manualTask", "subProcess", "transaction", "callActivity", "adHocSubProcess",
]);
const FLOW = new Set([...EVENT, ...GATEWAY, ...ACTIVITY]);

type Box = { x: number; y: number; w: number; h: number };
type Pt = [number, number];

function sizeFor(tag: string): [number, number] {
  if (EVENT.has(tag)) return [44, 44];
  if (GATEWAY.has(tag)) return [54, 54];
  return [156, 72]; // wider "tile" — fits the left icon-chip + bold label
}

/** Lay out a DI-less BPMN document into a readable left-to-right flow. */
export async function layoutDiagram(xml: string): Promise<string> {
  try {
    const out = dagreLayout(xml);
    if (out) return out;
  } catch {
    /* fall through to the simple layouter */
  }
  try {
    return ensureEdges(await layoutProcess(xml));
  } catch {
    return xml;
  }
}

function firstProcess(doc: Document): Element | null {
  const list = doc.getElementsByTagNameNS(NS.bpmn, "process");
  return list.length ? list[0] : null;
}

function dagreLayout(xml: string): string | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  const proc = firstProcess(doc);
  if (!proc) return null;

  // Flow nodes (direct children of the process; collapsed subprocesses count as one).
  const nodes = new Map<string, { tag: string; w: number; h: number; attachedTo?: string }>();
  for (const c of Array.from(proc.children)) {
    const tag = c.localName;
    if (!FLOW.has(tag)) continue;
    const id = c.getAttribute("id");
    if (!id) continue;
    const [w, h] = sizeFor(tag);
    nodes.set(id, { tag, w, h, attachedTo: tag === "boundaryEvent" ? c.getAttribute("attachedToRef") || undefined : undefined });
  }
  if (!nodes.size) return null;

  const flows: { id: string; s: string; t: string }[] = [];
  for (const f of Array.from(proc.getElementsByTagNameNS(NS.bpmn, "sequenceFlow"))) {
    const id = f.getAttribute("id");
    const s = f.getAttribute("sourceRef");
    const t = f.getAttribute("targetRef");
    if (id && s && t && nodes.has(s) && nodes.has(t)) flows.push({ id, s, t });
  }

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 38, ranksep: 76, marginx: 28, marginy: 28, ranker: "network-simplex" });
  g.setDefaultEdgeLabel(() => ({}));
  for (const [id, n] of nodes) if (!n.attachedTo) g.setNode(id, { width: n.w, height: n.h });

  // Boundary events aren't ranked nodes; their flows rank from the host instead.
  const eff = (id: string) => nodes.get(id)?.attachedTo || id;
  for (const f of flows) {
    const u = eff(f.s);
    const v = eff(f.t);
    if (u === v || !g.hasNode(u) || !g.hasNode(v)) continue;
    g.setEdge(u, v, {}, f.id);
  }

  dagre.layout(g);

  const pos = new Map<string, Box>();
  for (const id of g.nodes()) {
    const nd = g.node(id);
    if (!nd) continue;
    pos.set(id, { x: nd.x - nd.width / 2, y: nd.y - nd.height / 2, w: nd.width, h: nd.height });
  }
  // Boundary events ride the bottom border of their host.
  for (const [id, n] of nodes) {
    if (!n.attachedTo) continue;
    const host = pos.get(n.attachedTo);
    pos.set(id, host ? { x: host.x + host.w * 0.72 - n.w / 2, y: host.y + host.h - n.h / 2, w: n.w, h: n.h } : { x: 0, y: 0, w: n.w, h: n.h });
  }

  const edgeWp = new Map<string, Pt[]>();
  for (const f of flows) {
    const src = nodes.get(f.s)!;
    if (src.attachedTo) {
      const b = pos.get(f.s);
      const t = pos.get(f.t);
      if (b && t) edgeWp.set(f.id, route(b, t));
      continue;
    }
    const ge = g.edge(eff(f.s), eff(f.t), f.id) as { points?: { x: number; y: number }[] } | undefined;
    if (ge?.points && ge.points.length >= 2) {
      edgeWp.set(f.id, ge.points.map((p) => [p.x, p.y] as Pt));
    } else {
      const s = pos.get(f.s);
      const t = pos.get(f.t);
      if (s && t) edgeWp.set(f.id, route(s, t));
    }
  }

  return emitDi(doc, proc.getAttribute("id") || "process", pos, edgeWp);
}

function emitDi(doc: Document, procId: string, pos: Map<string, Box>, edges: Map<string, Pt[]>): string {
  const diagram = doc.createElementNS(NS.di, "bpmndi:BPMNDiagram");
  diagram.setAttribute("id", "BPMNDiagram_gen");
  const plane = doc.createElementNS(NS.di, "bpmndi:BPMNPlane");
  plane.setAttribute("id", "BPMNPlane_gen");
  plane.setAttribute("bpmnElement", procId);
  diagram.appendChild(plane);

  for (const [id, b] of pos) {
    const sh = doc.createElementNS(NS.di, "bpmndi:BPMNShape");
    sh.setAttribute("bpmnElement", id);
    const bd = doc.createElementNS(NS.dc, "dc:Bounds");
    bd.setAttribute("x", String(Math.round(b.x)));
    bd.setAttribute("y", String(Math.round(b.y)));
    bd.setAttribute("width", String(Math.round(b.w)));
    bd.setAttribute("height", String(Math.round(b.h)));
    sh.appendChild(bd);
    plane.appendChild(sh);
  }
  for (const [id, pts] of edges) {
    const e = doc.createElementNS(NS.di, "bpmndi:BPMNEdge");
    e.setAttribute("bpmnElement", id);
    for (const [x, y] of pts) {
      const wp = doc.createElementNS(NS.did, "di:waypoint");
      wp.setAttribute("x", String(Math.round(x)));
      wp.setAttribute("y", String(Math.round(y)));
      e.appendChild(wp);
    }
    plane.appendChild(e);
  }
  doc.documentElement.appendChild(diagram);
  return new XMLSerializer().serializeToString(doc);
}

/** Synthesise missing edges on an already-positioned diagram (fallback path). */
export function ensureEdges(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return xml;
  const plane = doc.getElementsByTagNameNS(NS.di, "BPMNPlane")[0];
  if (!plane) return xml;

  const bounds = new Map<string, Box>();
  for (const sh of Array.from(doc.getElementsByTagNameNS(NS.di, "BPMNShape"))) {
    const id = sh.getAttribute("bpmnElement");
    const b = sh.getElementsByTagNameNS(NS.dc, "Bounds")[0];
    if (!id || !b) continue;
    bounds.set(id, { x: +b.getAttribute("x")!, y: +b.getAttribute("y")!, w: +b.getAttribute("width")!, h: +b.getAttribute("height")! });
  }
  const haveEdge = new Set<string>();
  for (const e of Array.from(doc.getElementsByTagNameNS(NS.di, "BPMNEdge"))) {
    const id = e.getAttribute("bpmnElement");
    if (id) haveEdge.add(id);
  }
  let added = 0;
  for (const f of Array.from(doc.getElementsByTagNameNS(NS.bpmn, "sequenceFlow"))) {
    const id = f.getAttribute("id");
    const s = f.getAttribute("sourceRef");
    const t = f.getAttribute("targetRef");
    if (!id || !s || !t || haveEdge.has(id)) continue;
    const sb = bounds.get(s);
    const tb = bounds.get(t);
    if (!sb || !tb) continue;
    const e = doc.createElementNS(NS.di, "bpmndi:BPMNEdge");
    e.setAttribute("bpmnElement", id);
    for (const [x, y] of route(sb, tb)) {
      const wp = doc.createElementNS(NS.did, "di:waypoint");
      wp.setAttribute("x", String(Math.round(x)));
      wp.setAttribute("y", String(Math.round(y)));
      e.appendChild(wp);
    }
    plane.appendChild(e);
    added++;
  }
  return added ? new XMLSerializer().serializeToString(doc) : xml;
}

/** Orthogonal route between two boxes with one mid-bend (clean right angles). */
function route(s: Box, t: Box): Pt[] {
  const scx = s.x + s.w / 2;
  const scy = s.y + s.h / 2;
  const tcx = t.x + t.w / 2;
  const tcy = t.y + t.h / 2;
  const dx = tcx - scx;
  const dy = tcy - scy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = dx >= 0 ? s.x + s.w : s.x;
    const tx = dx >= 0 ? t.x : t.x + t.w;
    if (Math.abs(dy) < 4) return [[sx, scy], [tx, tcy]];
    const mx = (sx + tx) / 2;
    return [[sx, scy], [mx, scy], [mx, tcy], [tx, tcy]];
  }
  const sy = dy >= 0 ? s.y + s.h : s.y;
  const ty = dy >= 0 ? t.y : t.y + t.h;
  if (Math.abs(dx) < 4) return [[scx, sy], [tcx, ty]];
  const my = (sy + ty) / 2;
  return [[scx, sy], [scx, my], [tcx, my], [tcx, ty]];
}
