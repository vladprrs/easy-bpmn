// GlassRenderer — a high-priority bpmn-js BaseRenderer that redraws flow nodes as
// luminous glass tiles and sequence flows as rounded connectors with a chevron
// arrowhead that inherits the edge colour. Activities use a left-aligned "tile"
// composition: a vivid filled category icon-chip + a bold name, with depth from a
// glass rim + deep soft shadow rather than a heavy Camunda-style border. Runtime
// state / flow / heat / selection still arrive as marker CSS classes; this renderer
// owns the resting vocabulary.

import BaseRenderer from "diagram-js/lib/draw/BaseRenderer";
import { is, isAny, getBusinessObject } from "bpmn-js/lib/util/ModelUtil";
import { append as svgAppend, attr as svgAttr, classes as svgClasses, create as svgCreate } from "tiny-svg";
import { ensureGlassDefs, diamondPath } from "./glass";
import { ICONS, FILLED_ICONS, type IconKey } from "./icons";

const HIGH_PRIORITY = 1500;
const TASK_RADIUS = 15;

type Cat = "task" | "event" | "inter" | "boundary" | "end" | "gateway";
type Pt = { x: number; y: number };

export default class GlassRenderer extends BaseRenderer {
  static $inject = ["eventBus", "textRenderer"];
  private textRenderer: any;

  constructor(eventBus: any, textRenderer: any) {
    super(eventBus, HIGH_PRIORITY);
    this.textRenderer = textRenderer;
  }

  canRender(element: any): boolean {
    if (element.labelTarget) return false;
    return isAny(element, ["bpmn:Event", "bpmn:Gateway", "bpmn:Activity"]) || is(element, "bpmn:SequenceFlow");
  }

  drawShape(parent: SVGElement, element: any): SVGElement {
    ensureGlassDefs(parent);
    const cat = catOf(element);
    const g = el("g", {}, `ebpmn-node ebpmn-c-${cat}`);
    if (is(element, "bpmn:Transaction")) svgClasses(g).add("ebpmn-tx");
    if (isInterrupting(element) === false) svgClasses(g).add("ebpmn-noninterrupt");

    if (cat === "gateway") this.drawGateway(g, element);
    else if (cat === "task") {
      if (isExpandedContainer(element)) this.drawExpanded(g, element);
      else this.drawActivity(g, element);
    } else this.drawEvent(g, element, cat);

    svgAppend(parent, g);
    return g;
  }

  drawConnection(parent: SVGElement, element: any): SVGElement {
    ensureGlassDefs(parent);
    const path = el("path", { d: roundedConnector(element.waypoints, 7), fill: "none", "marker-end": "url(#ebpmn-arrow)" }, "ebpmn-edge");
    svgAppend(parent, path);
    return path;
  }

  // ---- Activity (task / subprocess / call activity) -----------------------
  private drawActivity(g: SVGElement, element: any) {
    const { width: w, height: h } = element;
    const R = TASK_RADIUS;
    const clipId = `ebpmn-clip-${safeId(element.id)}`;
    appendClip(g, clipId, el("rect", { x: 0, y: 0, width: w, height: h, rx: R }));

    svgAppend(g, el("rect", { x: 0, y: 0, width: w, height: h, rx: R, fill: "url(#ebpmn-frost)", filter: "url(#ebpmn-elev)" }, "ebpmn-shape"));
    const inner = el("g", { "clip-path": `url(#${clipId})` });
    svgAppend(inner, el("rect", { x: 0, y: 0, width: w, height: h, rx: R }, "ebpmn-tint"));
    svgAppend(inner, el("rect", { x: -3, y: -3, width: w + 6, height: h * 0.5, rx: R, fill: "url(#ebpmn-sheen)" }, "ebpmn-sheen"));
    svgAppend(g, inner);
    // Glass rim (bright inner edge) + the thin state stroke — no heavy border.
    svgAppend(g, el("rect", { x: 1, y: 1, width: w - 2, height: h - 2, rx: R - 1, fill: "none" }, "ebpmn-rim"));
    svgAppend(g, el("rect", { x: 0.6, y: 0.6, width: w - 1.2, height: h - 1.2, rx: R - 0.6, fill: "none" }, "ebpmn-stroke"));

    // Small vivid category chip in the TOP-LEFT corner — a colour accent, not a
    // column. Keeps the full tile width for the label (standard 100px authored tasks
    // would otherwise leave ~24px → catastrophic per-character wrapping).
    const ic = iconFor(element);
    if (ic) {
      const cs = 22;
      const chip = el("g", { transform: "translate(11 11)" }, "ebpmn-chip");
      svgAppend(chip, el("rect", { x: 0, y: 0, width: cs, height: cs, rx: 7 }, "ebpmn-chip-bg"));
      svgAppend(chip, iconSvg(ic.key, ic.filled, cs * 0.24, cs * 0.24, cs * 0.52));
      svgAppend(g, chip);
    }

    // Label: centered across the full tile, sitting below the corner chip's strip so
    // it never collides with it. Whole words wrap; never per-character.
    const name = getBusinessObject(element)?.name;
    if (name) {
      const top = ic ? 30 : 8;
      const text = this.textRenderer.createText(name, {
        box: { width: w - 16, height: Math.max(16, h - top - 6) },
        align: "center-middle",
        padding: 0,
        style: { fontFamily: FONT, fontSize: 12, fontWeight: 600, fill: INK, lineHeight: 1.16 },
      });
      svgAttr(text, { transform: `translate(8 ${top})` });
      svgClasses(text).add("ebpmn-label");
      svgAppend(g, text);
    }

    if (isAny(element, ["bpmn:SubProcess", "bpmn:Transaction", "bpmn:CallActivity"])) {
      const mk = el("g", { transform: `translate(${w - 26} ${h - 19})` }, "ebpmn-marker");
      svgAppend(mk, el("rect", { x: 0, y: 0, width: 15, height: 13, rx: 3, fill: "none" }, "ebpmn-marker-box"));
      svgAppend(mk, el("path", { d: "M7.5 3v7M4 6.5h7" }, "ebpmn-glyph"));
      svgAppend(g, mk);
    }
  }

  // ---- Expanded subprocess / transaction (a region, not a tile) -----------
  private drawExpanded(g: SVGElement, element: any) {
    const { width: w, height: h } = element;
    const R = TASK_RADIUS + 3;
    // A light translucent region so the nested children read on top of it.
    svgAppend(g, el("rect", { x: 0, y: 0, width: w, height: h, rx: R, filter: "url(#ebpmn-elev)" }, "ebpmn-region"));
    svgAppend(g, el("rect", { x: 0.6, y: 0.6, width: w - 1.2, height: h - 1.2, rx: R - 0.6, fill: "none" }, "ebpmn-stroke"));
    if (is(element, "bpmn:Transaction")) {
      svgAppend(g, el("rect", { x: 3.5, y: 3.5, width: w - 7, height: h - 7, rx: R - 3, fill: "none" }, "ebpmn-region-inner"));
    }
    // Header: a small chip + the name, top-left (never centred — children live there).
    const ic = iconFor(element);
    let hx = 12;
    if (ic) {
      const cs = 20;
      const chip = el("g", { transform: "translate(12 10)" }, "ebpmn-chip");
      svgAppend(chip, el("rect", { x: 0, y: 0, width: cs, height: cs, rx: 6 }, "ebpmn-chip-bg"));
      svgAppend(chip, iconSvg(ic.key, ic.filled, cs * 0.24, cs * 0.24, cs * 0.52));
      svgAppend(g, chip);
      hx = 12 + cs + 8;
    }
    const name = getBusinessObject(element)?.name;
    if (name) {
      const text = this.textRenderer.createText(name, {
        box: { width: w - hx - 10, height: 22 },
        align: "left-middle",
        padding: 0,
        style: { fontFamily: FONT, fontSize: 12.5, fontWeight: 600, fill: INK, lineHeight: 1.1 },
      });
      svgAttr(text, { transform: `translate(${hx} 10)` });
      svgClasses(text).add("ebpmn-label");
      svgAppend(g, text);
    }
  }

  // ---- Event (start / end / intermediate / boundary) ----------------------
  private drawEvent(g: SVGElement, element: any, cat: Cat) {
    const { width: w, height: h } = element;
    const r = Math.min(w, h) / 2;
    const cx = w / 2;
    const cy = h / 2;
    const clipId = `ebpmn-clip-${safeId(element.id)}`;
    appendClip(g, clipId, el("circle", { cx, cy, r }));

    svgAppend(g, el("circle", { cx, cy, r, fill: "url(#ebpmn-disc-frost)", filter: "url(#ebpmn-elev)" }, "ebpmn-shape"));
    const inner = el("g", { "clip-path": `url(#${clipId})` });
    svgAppend(inner, el("circle", { cx, cy, r }, "ebpmn-tint"));
    svgAppend(inner, el("ellipse", { cx, cy: cy - r * 0.3, rx: r * 0.92, ry: r * 0.6, fill: "url(#ebpmn-sheen)" }, "ebpmn-sheen"));
    svgAppend(g, inner);
    svgAppend(g, el("circle", { cx, cy, r: r - 1.5, fill: "none" }, "ebpmn-rim"));
    svgAppend(g, el("circle", { cx, cy, r: r - 0.75, fill: "none" }, "ebpmn-stroke"));
    if (cat === "inter" || cat === "boundary") {
      svgAppend(g, el("circle", { cx, cy, r: r - 4, fill: "none" }, "ebpmn-stroke-inner"));
    }

    const ic = iconFor(element);
    if (ic) svgAppend(g, iconSvg(ic.key, ic.filled, cx - r * 0.56, cy - r * 0.56, r * 1.12));
  }

  // ---- Gateway (exclusive / parallel / inclusive / event-based) -----------
  private drawGateway(g: SVGElement, element: any) {
    const { width: w, height: h } = element;
    const d = diamondPath(w, h, 7);
    const clipId = `ebpmn-clip-${safeId(element.id)}`;
    appendClip(g, clipId, el("path", { d }));

    svgAppend(g, el("path", { d, fill: "url(#ebpmn-frost)", filter: "url(#ebpmn-elev)" }, "ebpmn-shape"));
    const inner = el("g", { "clip-path": `url(#${clipId})` });
    svgAppend(inner, el("path", { d }, "ebpmn-tint"));
    svgAppend(inner, el("rect", { x: 0, y: -2, width: w, height: h * 0.6, fill: "url(#ebpmn-sheen)" }, "ebpmn-sheen"));
    svgAppend(g, inner);
    svgAppend(g, el("path", { d, fill: "none" }, "ebpmn-stroke"));

    drawGatewayGlyph(g, element, w, h);
  }
}

export const glassRendererModule = {
  __init__: ["glassRenderer"],
  glassRenderer: ["type", GlassRenderer],
};

// ============================ helpers ====================================

const FONT = "'General Sans', 'General Sans Fallback', ui-sans-serif, system-ui, sans-serif";
const INK = "#19212c";

function el(tag: string, attrs: Record<string, any>, cls?: string): SVGElement {
  const node = svgCreate(tag);
  svgAttr(node, attrs);
  if (cls) for (const c of cls.split(" ")) svgClasses(node).add(c);
  return node;
}

function appendClip(g: SVGElement, id: string, shape: SVGElement) {
  const clip = svgCreate("clipPath");
  clip.id = id;
  svgAppend(clip, shape);
  svgAppend(g, clip);
}

function iconSvg(key: IconKey, filled: boolean, x: number, y: number, size: number): SVGElement {
  const sv = el("svg", { x, y, width: size, height: size, viewBox: "0 0 24 24", overflow: "visible" }, "ebpmn-icon");
  for (const d of ICONS[key]) {
    const p = svgCreate("path");
    svgAttr(p, { d });
    if (filled || FILLED_ICONS[key]) svgAttr(p, { class: "filled" });
    svgAppend(sv, p);
  }
  return sv;
}

/** A polyline through the waypoints with rounded corners. */
function roundedConnector(pts: Pt[], r: number): string {
  if (!pts || pts.length < 2) return "";
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y}L${pts[1].x},${pts[1].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const a = toward(p1, p0, Math.min(r, dist(p0, p1) / 2));
    const b = toward(p1, p2, Math.min(r, dist(p1, p2) / 2));
    d += `L${round(a.x)},${round(a.y)}Q${round(p1.x)},${round(p1.y)} ${round(b.x)},${round(b.y)}`;
  }
  const last = pts[pts.length - 1];
  d += `L${last.x},${last.y}`;
  return d;
}

function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function toward(from: Pt, to: Pt, len: number): Pt {
  const d = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) / d) * len, y: from.y + ((to.y - from.y) / d) * len };
}
function round(n: number) {
  return Math.round(n * 100) / 100;
}

function drawGatewayGlyph(g: SVGElement, element: any, w: number, h: number) {
  const cx = w / 2;
  const cy = h / 2;
  const s = Math.min(w, h) * 0.2;
  const wrap = el("g", {}, "ebpmn-gw-glyph");
  if (is(element, "bpmn:ParallelGateway")) {
    svgAppend(wrap, el("path", { d: `M${cx} ${cy - s}V${cy + s}M${cx - s} ${cy}H${cx + s}` }, "ebpmn-glyph"));
  } else if (is(element, "bpmn:InclusiveGateway")) {
    svgAppend(wrap, el("circle", { cx, cy, r: s, fill: "none" }, "ebpmn-glyph"));
  } else if (is(element, "bpmn:EventBasedGateway")) {
    svgAppend(wrap, el("circle", { cx, cy, r: s + 2, fill: "none" }, "ebpmn-glyph"));
    svgAppend(wrap, el("circle", { cx, cy, r: s - 1, fill: "none" }, "ebpmn-glyph"));
    svgAppend(wrap, el("path", { d: pentagon(cx, cy, s - 4), fill: "none" }, "ebpmn-glyph"));
  } else if (is(element, "bpmn:ComplexGateway")) {
    svgAppend(wrap, el("path", { d: `M${cx} ${cy - s}V${cy + s}M${cx - s} ${cy}H${cx + s}M${cx - s * 0.7} ${cy - s * 0.7}L${cx + s * 0.7} ${cy + s * 0.7}M${cx - s * 0.7} ${cy + s * 0.7}L${cx + s * 0.7} ${cy - s * 0.7}` }, "ebpmn-glyph"));
  } else {
    const d = s * 0.78;
    svgAppend(wrap, el("path", { d: `M${cx - d} ${cy - d}L${cx + d} ${cy + d}M${cx - d} ${cy + d}L${cx + d} ${cy - d}` }, "ebpmn-glyph"));
  }
  svgAppend(g, wrap);
}

function pentagon(cx: number, cy: number, r: number): string {
  let d = "";
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    d += `${i === 0 ? "M" : "L"}${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  }
  return d + "Z";
}

function catOf(element: any): Cat {
  if (is(element, "bpmn:Gateway")) return "gateway";
  if (is(element, "bpmn:EndEvent")) return "end";
  if (is(element, "bpmn:BoundaryEvent")) return "boundary";
  if (isAny(element, ["bpmn:IntermediateCatchEvent", "bpmn:IntermediateThrowEvent"])) return "inter";
  if (is(element, "bpmn:Event")) return "event";
  return "task";
}

function isExpandedContainer(element: any): boolean {
  return isAny(element, ["bpmn:SubProcess", "bpmn:Transaction", "bpmn:AdHocSubProcess"]) && element.collapsed === false;
}

function isInterrupting(element: any): boolean | null {
  if (!is(element, "bpmn:BoundaryEvent")) return null;
  const bo = getBusinessObject(element);
  return bo?.cancelActivity !== false;
}

const EVENT_DEF_ICON: Record<string, IconKey> = {
  "bpmn:TimerEventDefinition": "timer",
  "bpmn:MessageEventDefinition": "message",
  "bpmn:ErrorEventDefinition": "error",
  "bpmn:SignalEventDefinition": "signal",
  "bpmn:EscalationEventDefinition": "escalation",
  "bpmn:CompensateEventDefinition": "compensation",
  "bpmn:ConditionalEventDefinition": "conditional",
  "bpmn:LinkEventDefinition": "link",
  "bpmn:TerminateEventDefinition": "terminate",
};

function iconFor(element: any): { key: IconKey; filled: boolean } | null {
  const bo = getBusinessObject(element);
  const isThrow = isAny(element, ["bpmn:IntermediateThrowEvent", "bpmn:EndEvent"]);

  if (is(element, "bpmn:Event")) {
    const def = bo?.eventDefinitions?.[0]?.$type as string | undefined;
    if (def && EVENT_DEF_ICON[def]) return { key: EVENT_DEF_ICON[def], filled: isThrow };
    if (is(element, "bpmn:StartEvent")) return { key: "play", filled: false };
    return null;
  }

  if (is(element, "bpmn:ServiceTask")) return { key: "service", filled: false };
  if (is(element, "bpmn:ReceiveTask")) return { key: "receive", filled: false };
  if (is(element, "bpmn:SendTask")) return { key: "send", filled: false };
  if (is(element, "bpmn:UserTask")) return { key: "user", filled: false };
  if (is(element, "bpmn:ScriptTask")) return { key: "script", filled: false };
  if (is(element, "bpmn:BusinessRuleTask")) return { key: "rule", filled: false };
  if (is(element, "bpmn:ManualTask")) return { key: "manual", filled: false };
  if (is(element, "bpmn:CallActivity")) return { key: "call", filled: false };
  if (isAny(element, ["bpmn:SubProcess", "bpmn:Transaction"])) return { key: "subprocess", filled: false };
  return null;
}

function safeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "");
}
