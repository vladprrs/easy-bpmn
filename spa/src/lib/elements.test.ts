import { describe, expect, it } from "vitest";
import { buildElementIndex } from "./elements";
import type { DefinitionVersion } from "../api/types";

const version = {
  definitionVersionId: "dv_1",
  draftId: "d_1",
  workspaceId: "default",
  versionNumber: 1,
  status: "published",
  bpmnXmlHash: "h",
  publishedAt: "2026-06-14T00:00:00Z",
  elements: [
    { elementId: "Start_1", type: "startEvent", name: "Start" },
    { elementId: "reserveStock", type: "serviceTask", name: "Reserve stock", taskType: "reserve-stock" },
    { elementId: "Tx_1", type: "transaction", name: "Order" },
    { elementId: "Flow_1", type: "sequenceFlow", sourceRef: "Start_1", targetRef: "reserveStock" },
  ],
} as DefinitionVersion;

describe("element resolver (§13)", () => {
  it("resolves name / type / taskType by id", () => {
    const idx = buildElementIndex(version);
    expect(idx.nameOf("reserveStock")).toBe("Reserve stock");
    expect(idx.typeOf("reserveStock")).toBe("serviceTask");
    expect(idx.taskTypeOf("reserveStock")).toBe("reserve-stock");
  });

  it("falls back to the id for an unknown element", () => {
    const idx = buildElementIndex(version);
    expect(idx.nameOf("ghost")).toBe("ghost");
    expect(idx.typeOf("ghost")).toBe("unknown");
    expect(idx.taskTypeOf("ghost")).toBeNull();
  });

  it("detects a transaction scope (Saga-tab gate)", () => {
    expect(buildElementIndex(version).hasTransaction).toBe(true);
    expect(buildElementIndex(null).hasTransaction).toBe(false);
  });
});
