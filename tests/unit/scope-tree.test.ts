import { describe, expect, it } from "vitest";
import type { ExecutionGraph } from "../../src/bpmn/graph";
import { eligibleCommittedLocalScopeIds, isStrictAncestor, nearestEnclosingTx, ownedScopeIds, scopesOf, subtreeScopeIds } from "../../src/bpmn/scope-tree";

/** O(tx) > S1(sub) > T(tx) > S2(sub); sibling P(sub) directly in the process. */
const g = {
  processId: "proc", startElementId: "start", endElementIds: [], elements: [], nodes: {},
  scopes: {
    O:  { id: "O",  kind: "transaction", parentId: null, depth: 1, startId: "sO" },
    S1: { id: "S1", kind: "subProcess",  parentId: "O",  depth: 2, startId: "sS1" },
    T:  { id: "T",  kind: "transaction", parentId: "S1", depth: 3, startId: "sT" },
    S2: { id: "S2", kind: "subProcess",  parentId: "T",  depth: 4, startId: "sS2" },
    P:  { id: "P",  kind: "subProcess",  parentId: null, depth: 1, startId: "sP" },
  },
} as unknown as ExecutionGraph;

describe("scope-tree", () => {
  it("subtree: root inclusive, downward-closed; null root = all scopes", () => {
    expect(subtreeScopeIds(g, "T").sort()).toEqual(["S2", "T"]);
    expect(subtreeScopeIds(g, "O").sort()).toEqual(["O", "S1", "S2", "T"]);
    expect(subtreeScopeIds(g, null).sort()).toEqual(["O", "P", "S1", "S2", "T"]);
  });
  it("nearestEnclosingTx is inclusive", () => {
    expect(nearestEnclosingTx(g, "T")).toBe("T");
    expect(nearestEnclosingTx(g, "S2")).toBe("T");
    expect(nearestEnclosingTx(g, "S1")).toBe("O");
    expect(nearestEnclosingTx(g, "P")).toBeNull();
    expect(nearestEnclosingTx(g, null)).toBeNull();
  });
  it("ownedScopeIds stops at nested transactions", () => {
    expect(ownedScopeIds(g, "O").sort()).toEqual(["O", "S1"]); // T is its own tx; S2 belongs to T
    expect(ownedScopeIds(g, "T").sort()).toEqual(["S2", "T"]);
  });
  it("strict ancestry (process root = null is strict ancestor of everything)", () => {
    expect(isStrictAncestor(g, "O", "S2")).toBe(true);
    expect(isStrictAncestor(g, "T", "T")).toBe(false);
    expect(isStrictAncestor(g, null, "O")).toBe(true);
    expect(isStrictAncestor(g, "P", "T")).toBe(false);
  });
  it("eligibleCommittedLocalScopeIds: scopes whose nearestTx is STRICTLY below the root", () => {
    // root O: rows in T/S2 (nearestTx=T, O strict ancestor of T) eligible; O/S1 (nearestTx=O) shielded
    expect(eligibleCommittedLocalScopeIds(g, "O").sort()).toEqual(["S2", "T"]);
    // root T (self re-entry): nothing (strictAncestor(T,T)=false; strictAncestor(T, nearestTx(S2)=T)=false)
    expect(eligibleCommittedLocalScopeIds(g, "T")).toEqual([]);
    // root process: every tx is strictly below the root
    expect(eligibleCommittedLocalScopeIds(g, null).sort()).toEqual(["O", "P", "S1", "S2", "T"]);
  });
  it("legacy graphs (no scopes map) synthesize flat transaction scopes", () => {
    const legacy = { processId: "p", transactions: { TX: { transactionId: "TX", startId: "s", childIds: [], endIds: [], compensations: {} } } } as unknown as ExecutionGraph;
    expect(scopesOf(legacy).TX).toEqual({ id: "TX", kind: "transaction", parentId: null, depth: 1, startId: "s" });
    expect(subtreeScopeIds(legacy, "TX")).toEqual(["TX"]);
    expect(nearestEnclosingTx(legacy, "TX")).toBe("TX");
  });
});
