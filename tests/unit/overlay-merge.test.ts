import { describe, it, expect } from "vitest";
import { mergeBranchOverlays } from "../../src/runtime/regions-runtime";

describe("mergeBranchOverlays (design §5.7, document order, later wins)", () => {
  it("unions top-level keys; later branch in split-out-flow order wins a conflict", () => {
    const parent = { base: 1 };
    const branches = [
      { branchFlowId: "f1", overlay: { a: 1, shared: "first" } },
      { branchFlowId: "f2", overlay: { b: 2, shared: "second" } },
    ];
    // branchFlowIds order is [f1, f2]
    expect(mergeBranchOverlays(parent, ["f1", "f2"], branches)).toEqual({ base: 1, a: 1, b: 2, shared: "second" });
  });

  it("restricts to the recorded subset for an OR join, preserving stored order", () => {
    const parent = {};
    const branches = [{ branchFlowId: "f2", overlay: { x: 2 } }];
    expect(mergeBranchOverlays(parent, ["f1", "f2"], branches)).toEqual({ x: 2 });
  });

  it("folds branches in STORED order even when given out of order (f2 listed before f1)", () => {
    const parent = { base: 0 };
    const branches = [
      { branchFlowId: "f2", overlay: { shared: "f2" } },
      { branchFlowId: "f1", overlay: { shared: "f1" } },
    ];
    // stored order [f1, f2] → f2 applied last → wins, regardless of array order.
    expect(mergeBranchOverlays(parent, ["f1", "f2"], branches)).toEqual({ base: 0, shared: "f2" });
  });
});
