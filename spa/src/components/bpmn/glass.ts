// Shared SVG <defs> + geometry for the liquid-glass renderer. The defs are
// injected once per <svg> root (idempotent): a frost gradient that lets the
// aurora behind bleed through, a top specular sheen, a soft elevation shadow,
// and a feTurbulence→feDisplacementMap "liquid" refraction applied to the sheen.

import { append as svgAppend, create as svgCreate, innerSVG } from "tiny-svg";

const DEFS_ID = "ebpmn-glass-defs";

const DEFS_MARKUP = `
  <linearGradient id="ebpmn-frost" x1="0" y1="0" x2="0.18" y2="1">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.74"/>
    <stop offset="1" stop-color="#ffffff" stop-opacity="0.32"/>
  </linearGradient>
  <linearGradient id="ebpmn-sheen" x1="0" y1="0" x2="0.18" y2="1">
    <stop offset="0" stop-color="#ffffff" stop-opacity="1"/>
    <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.22"/>
    <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
  </linearGradient>
  <filter id="ebpmn-elev" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB">
    <feDropShadow dx="0" dy="4" stdDeviation="7" flood-color="#13233c" flood-opacity="0.22"/>
  </filter>
  <filter id="ebpmn-liquid" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.013 0.021" numOctaves="2" seed="11" result="noise"/>
    <feDisplacementMap in="SourceGraphic" in2="noise" scale="7" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <radialGradient id="ebpmn-disc-frost" cx="0.36" cy="0.26" r="0.92">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.92"/>
    <stop offset="1" stop-color="#ffffff" stop-opacity="0.4"/>
  </radialGradient>
  <marker id="ebpmn-arrow" viewBox="0 0 12 12" refX="9.5" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
    <path d="M3.2 2.6 L9.4 6 L3.2 9.4" fill="none" stroke="context-stroke" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
`;

/** Inject the glass <defs> into the SVG root once. Safe to call per shape. */
export function ensureGlassDefs(node: SVGElement | null | undefined): void {
  if (!node) return;
  const svg = (node as any).ownerSVGElement || node;
  if (!svg || svg.querySelector?.(`#${DEFS_ID}`)) return;
  const defs = svgCreate("defs");
  defs.id = DEFS_ID;
  innerSVG(defs, DEFS_MARKUP);
  // Prepend so referenced ids resolve for everything drawn after.
  if (svg.firstChild) svg.insertBefore(defs, svg.firstChild);
  else svgAppend(svg, defs);
}

type Pt = [number, number];

/** Rounded-corner polygon path (used for the gateway diamond). */
export function roundedPolygon(points: Pt[], r: number): string {
  const n = points.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const v1 = unit(prev, cur);
    const v2 = unit(next, cur);
    const p1: Pt = [cur[0] + v1[0] * r, cur[1] + v1[1] * r];
    const p2: Pt = [cur[0] + v2[0] * r, cur[1] + v2[1] * r];
    d += `${i === 0 ? "M" : "L"}${f(p1[0])},${f(p1[1])}Q${f(cur[0])},${f(cur[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return d + "Z";
}

/** A rounded diamond inscribed in a w×h box (gateway). */
export function diamondPath(w: number, h: number, r = 5): string {
  const cx = w / 2;
  const cy = h / 2;
  return roundedPolygon([[cx, 0], [w, cy], [cx, h], [0, cy]], r);
}

function unit(a: Pt, b: Pt): Pt {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

function f(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}
