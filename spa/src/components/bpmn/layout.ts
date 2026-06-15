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

// A task tile must stay wide enough that a 2-word label wraps to <= 2-3 whole-word
// lines instead of one character per line (the P0 symptom this layout exists to kill).
const MIN_TASK_W = 132;

function sizeFor(tag: string): [number, number] {
  if (EVENT.has(tag)) return [44, 44];
  if (GATEWAY.has(tag)) return [54, 54];
  return [Math.max(MIN_TASK_W, 156), 72]; // wide "tile" — fits the icon-chip + bold label
}

/** Lay out a DI-less BPMN document into a readable left-to-right flow. */
export async function layoutDiagram(xml: string): Promise<string> {
  try {
    const out = dagreLayout(xml);
    if (out) return out;
  } catch (err) {
    console.warn("[living-diagram] dagre layout failed; falling back to bpmn-auto-layout", err);
  }
  try {
    return ensureEdges(await layoutProcess(xml));
  } catch (err) {
    console.warn("[living-diagram] bpmn-auto-layout failed; rendering DI-less XML as-is", err);
    return xml;
  }
}

function firstProcess(doc: Document): Element | null {
  const list = doc.getElementsByTagNameNS(NS.bpmn, "process");
  return list.length ? list[0] : null;
}

const SUB = new Set(["subProcess", "transaction", "adHocSubProcess"]);
const PADX = 26; // horizontal padding inside an expanded subprocess
const HEADER = 36; // top space reserved for the subprocess chip + label
const PADB = 22; // bottom padding inside an expanded subprocess

interface Scope {
  boxes: Map<string, Box>;
  edges: Map<string, Pt[]>;
  expanded: Set<string>;
  width: number;
  height: number;
}

function dagreLayout(xml: string): string | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  const proc = firstProcess(doc);
  if (!proc) return null;
  const r = layoutScope(proc);
  if (!r || !r.boxes.size) return null;
  return emitDi(doc, proc.getAttribute("id") || "process", r.boxes, r.edges, r.expanded);
}

/** Lay out one scope (process or expanded subprocess) into LOCAL coordinates with a
 *  0-origin. Expanded subprocess children are laid out recursively and nested inside
 *  the parent box, so a DI-less transaction-saga reads as a real region, not a tile
 *  with edges dangling into empty space. */
function layoutScope(scopeEl: Element): Scope | null {
  const nodes = new Map<string, { tag: string; w: number; h: number; attachedTo?: string }>();
  const subScopes = new Map<string, Scope>();
  for (const c of Array.from(scopeEl.children)) {
    const tag = c.localName;
    if (!FLOW.has(tag)) continue;
    const id = c.getAttribute("id");
    if (!id) continue;
    if (SUB.has(tag)) {
      try {
        const inner = layoutScope(c);
        if (inner && inner.boxes.size) {
          subScopes.set(id, inner);
          nodes.set(id, { tag, w: inner.width + 2 * PADX, h: inner.height + HEADER + PADB });
          continue;
        }
      } catch (err) {
        // A nested scope that throws must NOT sink the whole diagram into the
        // edge-less fallback — degrade just this region to a collapsed tile.
        console.warn(`[living-diagram] nested scope layout failed for "${id}"; rendering it as a collapsed tile`, err);
      }
      // an empty / collapsed / failed subprocess falls through to a plain tile
    }
    const [w, h] = sizeFor(tag);
    nodes.set(id, { tag, w, h, attachedTo: tag === "boundaryEvent" ? c.getAttribute("attachedToRef") || undefined : undefined });
  }
  if (!nodes.size) return null;

  const flows: { id: string; s: string; t: string }[] = [];
  for (const f of Array.from(scopeEl.children)) {
    if (f.localName !== "sequenceFlow") continue;
    const id = f.getAttribute("id");
    const s = f.getAttribute("sourceRef");
    const t = f.getAttribute("targetRef");
    if (id && s && t && nodes.has(s) && nodes.has(t)) flows.push({ id, s, t });
  }

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 78, marginx: 14, marginy: 14, ranker: "network-simplex" });
  g.setDefaultEdgeLabel(() => ({}));
  for (const [id, n] of nodes) if (!n.attachedTo) g.setNode(id, { width: n.w, height: n.h });

  const eff = (id: string) => nodes.get(id)?.attachedTo || id;
  for (const f of flows) {
    const u = eff(f.s);
    const v = eff(f.t);
    if (u === v || !g.hasNode(u) || !g.hasNode(v)) continue;
    g.setEdge(u, v, {}, f.id);
  }
  try {
    dagre.layout(g);
  } catch (err) {
    console.warn(`[living-diagram] dagre.layout threw for scope "${scopeEl.getAttribute("id") ?? "process"}"`, err);
    return null;
  }

  const boxes = new Map<string, Box>();
  for (const id of g.nodes()) {
    const nd = g.node(id);
    if (!nd) continue;
    boxes.set(id, { x: nd.x - nd.width / 2, y: nd.y - nd.height / 2, w: nd.width, h: nd.height });
  }
  // Boundary events ride the bottom border of their host (0.72 along).
  for (const [id, n] of nodes) {
    if (!n.attachedTo) continue;
    const host = boxes.get(n.attachedTo);
    boxes.set(id, host ? { x: host.x + host.w * 0.72 - n.w / 2, y: host.y + host.h - n.h / 2, w: n.w, h: n.h } : { x: 0, y: 0, w: n.w, h: n.h });
  }

  const edges = new Map<string, Pt[]>();
  for (const f of flows) {
    const s = boxes.get(f.s);
    const t = boxes.get(f.t);
    if (s && t) edges.set(f.id, route(s, t));
  }

  // Nest each expanded subprocess's children inside its box.
  const expanded = new Set<string>();
  for (const [id, inner] of subScopes) {
    const base = boxes.get(id);
    if (!base) continue;
    expanded.add(id);
    for (const e of inner.expanded) expanded.add(e);
    const ox = base.x + PADX;
    const oy = base.y + HEADER;
    for (const [cid, b] of inner.boxes) boxes.set(cid, { x: b.x + ox, y: b.y + oy, w: b.w, h: b.h });
    for (const [eid, pts] of inner.edges) edges.set(eid, pts.map(([x, y]) => [x + ox, y + oy] as Pt));
  }

  // Normalise to a 0-origin so the parent's offset math stays clean.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = 0;
  let maxY = 0;
  for (const b of boxes.values()) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
  }
  for (const b of boxes.values()) {
    b.x -= minX;
    b.y -= minY;
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  for (const pts of edges.values()) for (const p of pts) {
    p[0] -= minX;
    p[1] -= minY;
  }
  return { boxes, edges, expanded, width: maxX, height: maxY };
}

function emitDi(doc: Document, procId: string, pos: Map<string, Box>, edges: Map<string, Pt[]>, expanded: Set<string>): string {
  const diagram = doc.createElementNS(NS.di, "bpmndi:BPMNDiagram");
  diagram.setAttribute("id", "BPMNDiagram_gen");
  const plane = doc.createElementNS(NS.di, "bpmndi:BPMNPlane");
  plane.setAttribute("id", "BPMNPlane_gen");
  plane.setAttribute("bpmnElement", procId);
  diagram.appendChild(plane);

  for (const [id, b] of pos) {
    const sh = doc.createElementNS(NS.di, "bpmndi:BPMNShape");
    sh.setAttribute("bpmnElement", id);
    if (expanded.has(id)) sh.setAttribute("isExpanded", "true");
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
  // Parity: every sequenceFlow should have emitted an edge (cross-scope flows whose
  // ends live in different scopes are the only legitimate gap).
  const flowCount = doc.getElementsByTagNameNS(NS.bpmn, "sequenceFlow").length;
  if (edges.size !== flowCount) {
    console.warn(`[living-diagram] dagre emitted ${edges.size} edges for ${flowCount} sequenceFlows`);
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
  // A boundary event's own bounds may be missing in a partial DI; fall back to its
  // host's box so an edge into/out of it still resolves (today's orphan "↘" arrow
  // is a flow whose end had no bounds, so the edge was silently dropped).
  const attachedTo = new Map<string, string>();
  for (const be of Array.from(doc.getElementsByTagNameNS(NS.bpmn, "boundaryEvent"))) {
    const id = be.getAttribute("id");
    const host = be.getAttribute("attachedToRef");
    if (id && host) attachedTo.set(id, host);
  }
  const resolve = (id: string): Box | null =>
    bounds.get(id) ?? (attachedTo.has(id) ? bounds.get(attachedTo.get(id)!) ?? null : null);

  const haveEdge = new Set<string>();
  for (const e of Array.from(doc.getElementsByTagNameNS(NS.di, "BPMNEdge"))) {
    const id = e.getAttribute("bpmnElement");
    if (id) haveEdge.add(id);
  }
  const addedSet = new Set<string>();
  let missing = 0;
  const flowIds: string[] = [];
  for (const f of Array.from(doc.getElementsByTagNameNS(NS.bpmn, "sequenceFlow"))) {
    const id = f.getAttribute("id");
    if (id) flowIds.push(id);
    const s = f.getAttribute("sourceRef");
    const t = f.getAttribute("targetRef");
    if (!id || !s || !t || haveEdge.has(id)) continue;
    const sb = resolve(s);
    const tb = resolve(t);
    if (!sb || !tb) {
      missing++;
      console.warn(`[living-diagram] no bounds to route sequenceFlow "${id}" (${s} → ${t}); skipping`);
      continue;
    }
    const e = doc.createElementNS(NS.di, "bpmndi:BPMNEdge");
    e.setAttribute("bpmnElement", id);
    for (const [x, y] of route(sb, tb)) {
      const wp = doc.createElementNS(NS.did, "di:waypoint");
      wp.setAttribute("x", String(Math.round(x)));
      wp.setAttribute("y", String(Math.round(y)));
      e.appendChild(wp);
    }
    plane.appendChild(e);
    addedSet.add(id);
  }
  // Parity: assert every sequenceFlow now has a rendered edge.
  const covered = flowIds.filter((id) => haveEdge.has(id) || addedSet.has(id)).length;
  if (covered !== flowIds.length) {
    console.warn(`[living-diagram] edge parity mismatch: ${covered}/${flowIds.length} sequenceFlows routed (${missing} unroutable)`);
  }
  return addedSet.size ? new XMLSerializer().serializeToString(doc) : xml;
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
