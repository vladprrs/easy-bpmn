import { describe, it, expect } from "vitest";
import { rootTokenId, branchTokenId, parseTokenId } from "../../src/persistence/tokens";

describe("token id forms (design §5.5)", () => {
  it("roots and branches are replay-stable strings", () => {
    expect(rootTokenId("inst1")).toBe("inst1:#root");
    expect(branchTokenId("inst1", "fork", 0, "f1")).toBe("inst1:fork#0:f1");
  });
  it("round-trips a branch id back to its parts", () => {
    expect(parseTokenId("inst1:fork#2:f_gold")).toMatchObject({ kind: "branch", splitId: "fork", activation: 2, branchFlowId: "f_gold" });
    expect(parseTokenId("inst1:#root")).toMatchObject({ kind: "root" });
  });
});
