import { describe, expect, it } from "vitest";
import { childForElement, hasLineage, isLineageChild, sortedLineageChildren } from "./lineage";
import type { InstanceLineage } from "../api/types";

const EMPTY: InstanceLineage = { parent: null, children: [] };
const CHILD_LINEAGE: InstanceLineage = { parent: { instanceId: "pi-parent", elementId: "call1" }, children: [] };
const PARENT_LINEAGE: InstanceLineage = {
  parent: null,
  children: [
    { elementId: "call1", occurrence: 0, iterationIndex: 0, childInstanceId: "pi-a", status: "completed" },
    { elementId: "call1", occurrence: 2, iterationIndex: 0, childInstanceId: "pi-c", status: "waiting" },
    { elementId: "call1", occurrence: 1, iterationIndex: 0, childInstanceId: "pi-b", status: "completed" },
    { elementId: "call2", occurrence: 0, iterationIndex: 0, childInstanceId: "pi-d", status: "errored" },
  ],
};
// M5-L3: one MI callActivity visit fans out iteration-keyed children — same
// element, same occurrence, distinct iterationIndex (server order: iteration
// ASC, deliberately shuffled here to prove the client re-sort).
const MI_LINEAGE: InstanceLineage = {
  parent: null,
  children: [
    { elementId: "mi1", occurrence: 0, iterationIndex: 2, childInstanceId: "pi-m2", status: "waiting" },
    { elementId: "call2", occurrence: 0, iterationIndex: 0, childInstanceId: "pi-d", status: "errored" },
    { elementId: "mi1", occurrence: 0, iterationIndex: 0, childInstanceId: "pi-m0", status: "completed" },
    { elementId: "call1", occurrence: 1, iterationIndex: 0, childInstanceId: "pi-b", status: "completed" },
    { elementId: "mi1", occurrence: 0, iterationIndex: 1, childInstanceId: "pi-m1", status: "waiting" },
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

describe("lineage derivations over an MI fan-out (M5-L3 Task 12)", () => {
  it("orders occurrence DESC, then iterationIndex ASC, then elementId", () => {
    expect(sortedLineageChildren(MI_LINEAGE).map((c) => c.childInstanceId)).toEqual([
      "pi-b", // occ 1
      "pi-d", // occ 0, iter 0, call2 < mi1
      "pi-m0", // occ 0, iter 0, mi1
      "pi-m1", // occ 0, iter 1
      "pi-m2", // occ 0, iter 2
    ]);
  });

  it("resolves a clicked MI node to its FIRST iteration child (lowest iterationIndex on the occurrence tie)", () => {
    expect(childForElement(MI_LINEAGE, "mi1")?.childInstanceId).toBe("pi-m0");
  });
});
