// Pure derivations for the M5-L2 callActivity lineage strip (Task 11) — kept in
// the same "pure logic, unit-tested; the component is a thin render shell"
// convention as guards.ts/flow.ts/compensation.ts. This SPA carries no DOM test
// harness (no jsdom/@testing-library), so the render-affecting decisions live
// here where they're directly testable; LineageStrip.tsx just maps this over JSX.

import type { InstanceLineage, InstanceLineageChild } from "../api/types";

/**
 * True when this instance is a callActivity CHILD (it has a live parent) — the
 * gate for hiding the primary cancel/retry controls. A child's lifecycle is
 * entirely a function of its parent's own step-state machine (spec §6); the
 * server already 409s a direct operator verb on one (handleCancelInstance /
 * handleRetryInstance), so this is UX-only — it keeps the console from ever
 * offering an action the API will refuse.
 */
export function isLineageChild(lineage: InstanceLineage | null | undefined): boolean {
  return !!lineage?.parent;
}

/** True when the strip has anything to show: a parent breadcrumb or >=1 child chip. */
export function hasLineage(lineage: InstanceLineage | null | undefined): boolean {
  return isLineageChild(lineage) || (lineage?.children?.length ?? 0) > 0;
}

/**
 * Child rows for display, newest visit first (highest occurrence), then MI
 * iterations in fan-out order (iterationIndex ASC — M5-L3), then the
 * callActivity element id, so a looped callActivity's latest call leads the
 * strip and one MI visit's children read 0,1,2… left to right.
 */
export function sortedLineageChildren(lineage: InstanceLineage | null | undefined): InstanceLineageChild[] {
  const children = lineage?.children ?? [];
  return [...children].sort(
    (a, b) => b.occurrence - a.occurrence || a.iterationIndex - b.iterationIndex || a.elementId.localeCompare(b.elementId),
  );
}

/**
 * Resolve the child a clicked callActivity DIAGRAM NODE should navigate to:
 * every visit of that element, highest occurrence wins (the live/most-recent
 * call when the callActivity sits on a loop-back path); within one MI visit
 * the FIRST iteration wins (the strip chips are the per-iteration jump points
 * — the diagram node is just the visit's front door). Returns null when the
 * element has no bound child yet (visit not reached) or isn't a callActivity.
 */
export function childForElement(lineage: InstanceLineage | null | undefined, elementId: string): InstanceLineageChild | null {
  const matches = (lineage?.children ?? []).filter((c) => c.elementId === elementId);
  if (matches.length === 0) return null;
  return matches.reduce((best, c) =>
    c.occurrence > best.occurrence || (c.occurrence === best.occurrence && c.iterationIndex < best.iterationIndex) ? c : best,
  );
}
