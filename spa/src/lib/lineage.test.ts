import { describe, expect, it } from "vitest";
import { childForElement, hasLineage, isLineageChild, sortedLineageChildren } from "./lineage";
import type { InstanceLineage } from "../api/types";

const EMPTY: InstanceLineage = { parent: null, children: [] };
const CHILD_LINEAGE: InstanceLineage = { parent: { instanceId: "pi-parent", elementId: "call1" }, children: [] };
const PARENT_LINEAGE: InstanceLineage = {
  parent: null,
  children: [
    { elementId: "call1", occurrence: 0, childInstanceId: "pi-a", status: "completed" },
    { elementId: "call1", occurrence: 2, childInstanceId: "pi-c", status: "waiting" },
    { elementId: "call1", occurrence: 1, childInstanceId: "pi-b", status: "completed" },
    { elementId: "call2", occurrence: 0, childInstanceId: "pi-d", status: "errored" },
  ],
};

describe("lineage derivations (M5-L2 callActivity, Task 11)", () => {
  it("flags a child instance (non-null parent); a root instance is never flagged", () => {
    expect(isLineageChild(CHILD_LINEAGE)).toBe(true);
    expect(isLineageChild(EMPTY)).toBe(false);
    expect(isLineageChild(PARENT_LINEAGE)).toBe(false);
    expect(isLineageChild(null)).toBe(false);
    expect(isLineageChild(undefined)).toBe(false);
  });

  it("has nothing to show for a plain instance with no calls in or out", () => {
    expect(hasLineage(EMPTY)).toBe(false);
  });

  it("has something to show for a parent breadcrumb OR any child chip", () => {
    expect(hasLineage(CHILD_LINEAGE)).toBe(true);
    expect(hasLineage(PARENT_LINEAGE)).toBe(true);
  });

  it("renders children newest-occurrence-first within an element, stable across elements", () => {
    expect(sortedLineageChildren(PARENT_LINEAGE).map((c) => c.childInstanceId)).toEqual([
      "pi-c",
      "pi-b",
      "pi-a",
      "pi-d",
    ]);
    expect(sortedLineageChildren(EMPTY)).toEqual([]);
    expect(sortedLineageChildren(null)).toEqual([]);
  });

  it("resolves a clicked callActivity node to its bound child, highest occurrence wins", () => {
    expect(childForElement(PARENT_LINEAGE, "call1")?.childInstanceId).toBe("pi-c");
    expect(childForElement(PARENT_LINEAGE, "call2")?.childInstanceId).toBe("pi-d");
  });

  it("returns null for an element with no bound child (visit not yet reached) or an unknown id", () => {
    expect(childForElement(PARENT_LINEAGE, "call3")).toBeNull();
    expect(childForElement(EMPTY, "call1")).toBeNull();
    expect(childForElement(null, "call1")).toBeNull();
  });
});
