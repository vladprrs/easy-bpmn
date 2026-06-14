import { describe, it, expect } from "vitest";
import { SCENARIOS } from "./registry";

describe("matrix registry well-formedness", () => {
  it("has exactly 60 scenarios with unique ids", () => {
    expect(SCENARIOS).toHaveLength(60);
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(60);
  });

  it("every scenario has valid enums and at least one declared mode", () => {
    for (const s of SCENARIOS) {
      expect(["valid", "reject"]).toContain(s.legality);
      expect(["new", "extends-existing", "duplicate"]).toContain(s.coverage);
      expect([1, 2, 3]).toContain(s.phase);
      expect(s.modes.length).toBeGreaterThan(0);
      for (const m of s.modes) expect(["direct", "workflow"]).toContain(m);
      if (s.modes.includes("direct")) expect(s.directFile, s.id).not.toBe("");
      if (s.modes.includes("workflow")) expect(s.workflowFile, s.id).not.toBe("");
    }
  });

  it("registers exactly the 11 reject scenarios and they are direct-only", () => {
    const rejects = SCENARIOS.filter((s) => s.legality === "reject");
    expect(rejects).toHaveLength(11);
    for (const s of rejects) expect(s.modes).toEqual(["direct"]);
  });
});
