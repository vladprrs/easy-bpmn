// Element resolver (design §13): id → { name, type, taskType }, built from the
// definition-version metadata. Used by the diagram overlay, timeline, and panels.

import type { BpmnElement, DefinitionVersion } from "../api/types";

export interface ElementIndex {
  byId: Map<string, BpmnElement>;
  nameOf: (id: string) => string;
  typeOf: (id: string) => string;
  taskTypeOf: (id: string) => string | null;
  /** True when the definition carries a transaction scope (Saga-tab gate). */
  hasTransaction: boolean;
}

export function buildElementIndex(version: DefinitionVersion | undefined | null): ElementIndex {
  const byId = new Map<string, BpmnElement>();
  for (const el of version?.elements ?? []) byId.set(el.elementId, el);
  return {
    byId,
    nameOf: (id) => byId.get(id)?.name || id,
    typeOf: (id) => byId.get(id)?.type || "unknown",
    taskTypeOf: (id) => byId.get(id)?.taskType ?? null,
    hasTransaction: [...byId.values()].some((e) => e.type === "transaction"),
  };
}
