// GlassRenderer — a high-priority bpmn-js BaseRenderer that redraws every flow
// node as a luminous "liquid glass" shape (frosted body + specular sheen +
// refraction + soft elevation), with custom line-icons instead of bpmn-js's
// default corner glyphs. Runtime state / flow / heat / selection still arrive as
// marker CSS classes on the .djs-element group; this renderer only owns the
// resting visual vocabulary, so the existing living-flow machinery is untouched.
//
// Connections are intentionally NOT handled here — the default renderer keeps
// drawing them as a single <path> child of .djs-visual, which preserves both the
// travelling-token injection and the flow-edge CSS. We restyle those edges in CSS.

import BaseRenderer from "diagram-js/lib/draw/BaseRenderer";
import { is, isAny, getBusinessObject } from "bpmn-js/lib/util/ModelUtil";
import { append as svgAppend, attr as svgAttr, classes as svgClasses, create as svgCreate } from "tiny-svg";
import { ensureGlassDefs, diamondPath } from "./glass";
import { ICONS, FILLED_ICONS, type IconKey } from "./icons";

const HIGH_PRIORITY = 1500;
const TASK_RADIUS = 13;

type Cat = "task" | "event" | "inter" | "boundary" | "end" | "gateway";

export default class GlassRenderer extends BaseRenderer {
  static $inject = ["eventBus", "textRenderer"];
  private textRenderer: any;

  constructor(eventBus: any, textRenderer: any) {
    super(eventBus, HIGH_PRIORITY);
    this.textRenderer = textRenderer;
  }

  canRender(element: any): boolean {
    return !element.labelTarget && isAny(element, ["bpmn:Event", "bpmn:Gateway", "bpmn:Activity"]);
  }

  drawShape(parent: SVGElement, element: any): SVGElement {
    ensureGlassDefs(parent);
    const cat = catOf(element);
    const g = el("g", {}, `ebpmn-node ebpmn-c-${cat}`);
    if (is(element, "bpmn:Transaction")) svgClasses(g).add("ebpmn-tx");
    if (isInterrupting(element) === false) svgClasses(g).add("ebpmn-noninterrupt");

    if (cat === "gateway") this.drawGateway(g, element);
    else if (cat === "task") this.drawActivity(g, element);
    else this.drawEvent(g, element, cat);

    svgAppend(parent, g);
    return g;
  }

  // ---- Activity (task / subprocess / call activity) -----------------------
  private drawActivity(g: SVGElement, element: any) {
    const { width: w, height: h } = element;
    const clipId = `ebpmn-clip-${safeId(element.id)}`;
    appendClip(g, clipId, el("rect", { x: 0, y: 0, width: w, height: h, rx: TASK_RADIUS }));

    svgAppend(g, el("rect", { x: 0, y: 0, width: w, height: h, rx: TASK_RADIUS, fill: "url(#ebpmn-frost)", filter: "url(#ebpmn-elev)" }, "ebpmn-shape"));
    const inner = el("g", { "clip-path": `url(#${clipId})` });
    svgAppend(inner, el("rect", { x: 0, y: 0, width: w, height: h, rx: TASK_RADIUS }, "ebpmn-tint"));
    svgAppend(inner, el("rect", { x: -3, y: -3, width: w + 6, height: h * 0.66, rx: TASK_RADIUS, fill: "url(#ebpmn-sheen)", filter: "url(#ebpmn-liquid)" }, "ebpmn-sheen"));
    svgAppend(g, inner);
    svgAppend(g, el("rect", { x: 0.75, y: 0.75, width: w - 1.5, height: h - 1.5, rx: TASK_RADIUS - 0.75, fill: "none" }, "ebpmn-stroke"));

    // A small corner icon (replaces bpmn-js's default glyph). The label stays
    // centred across the full width so it reads cleanly without cramped wrapping.
    const ic = iconFor(element);
    if (ic) {
      const chip = el("g", { transform: "translate(11 11)" }, "ebpmn-chip");
      svgAppend(chip, el("rect", { x: -2, y: -2, width: 24, height: 24, rx: 7, fill: "none" }, "ebpmn-chip-bg"));
      svgAppend(chip, iconSvg(ic.key, ic.filled, 0, 0, 20));
      svgAppend(g, chip);
    }

    const name = getBusinessObject(element)?.name;
    if (name) {
      const text = this.textRenderer.createText(name, {
        box: { width: w, height: h },
        align: "center-middle",
        padding: { top: ic ? 16 : 8, right: 9, bottom: 8, left: 9 },
        style: { fontFamily: FONT, fontSize: 12, fontWeight: 600, fill: INK, lineHeight: 1.2 },
      });
      svgClasses(text).add("ebpmn-label");
      svgAppend(g, text);
    }

    // Sub-process collapse marker (BPMN [+]).
    if (isAny(element, ["bpmn:SubProcess", "bpmn:Transaction", "bpmn:CallActivity"])) {
      const mk = el("g", { transform: `translate(${w / 2 - 9} ${h - 18})` }, "ebpmn-marker");
      svgAppend(mk, el("rect", { x: 0, y: 0, width: 18, height: 14, rx: 3, fill: "none" }, "ebpmn-marker-box"));
      svgAppend(mk, el("path", { d: "M9 3.5v7M5.5 7h7" }, "ebpmn-glyph"));
      svgAppend(g, mk);
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
    svgAppend(inner, el("ellipse", { cx, cy: cy - r * 0.28, rx: r * 0.92, ry: r * 0.62, fill: "url(#ebpmn-sheen)", filter: "url(#ebpmn-liquid)" }, "ebpmn-sheen"));
    svgAppend(g, inner);
    // Outer ring (the state-coloured stroke target).
    svgAppend(g, el("circle", { cx, cy, r: r - 1, fill: "none" }, "ebpmn-stroke"));
    // Intermediate / boundary get the BPMN double ring.
    if (cat === "inter" || cat === "boundary") {
      svgAppend(g, el("circle", { cx, cy, r: r - 4, fill: "none" }, "ebpmn-stroke-inner"));
    }

    const ic = iconFor(element);
    if (ic) svgAppend(g, iconSvg(ic.key, ic.filled, cx - r * 0.58, cy - r * 0.58, r * 1.16));
  }

  // ---- Gateway (exclusive / parallel / inclusive / event-based) -----------
  private drawGateway(g: SVGElement, element: any) {
    const { width: w, height: h } = element;
    const d = diamondPath(w, h, 6);
    const clipId = `ebpmn-clip-${safeId(element.id)}`;
    appendClip(g, clipId, el("path", { d }));

    svgAppend(g, el("path", { d, fill: "url(#ebpmn-frost)", filter: "url(#ebpmn-elev)" }, "ebpmn-shape"));
    const inner = el("g", { "clip-path": `url(#${clipId})` });
    svgAppend(inner, el("path", { d }, "ebpmn-tint"));
    svgAppend(inner, el("rect", { x: 0, y: -2, width: w, height: h * 0.6, fill: "url(#ebpmn-sheen)", filter: "url(#ebpmn-liquid)" }, "ebpmn-sheen"));
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
const INK = "#1b222c";

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

/** A nested 24-grid icon, positioned at (x,y) scaled to `size`. */
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
    // Exclusive (and default) — the X.
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
    return null; // plain end event — bare ring
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
  return null; // plain task — icon-less, just the label
}

function safeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "");
}
