import { describe, expect, it } from "vitest";
import { compensationPreview } from "./compensation";
import type { SagaInspection } from "../api/types";

const saga: SagaInspection = {
  phase: "forward",
  traceId: "trace_x",
  steps: [
    { elementId: "reserveStock", seq: 0, compensationStatus: "pending", compensationElementId: "releaseStock", compensationTaskType: "release-stock" },
    { elementId: "chargeCard", seq: 1, compensationStatus: "pending", compensationElementId: "refundCard", compensationTaskType: "refund-card" },
    { elementId: "confirmShipping", seq: 2, compensationStatus: "notRequired", compensationElementId: null, compensationTaskType: null },
  ],
};

describe("compensation preview (§13, G5)", () => {
  it("includes only pending steps, in reverse completion order", () => {
    const preview = compensationPreview(saga);
    expect(preview.map((p) => p.elementId)).toEqual(["chargeCard", "reserveStock"]);
    expect(preview[0].compensationTaskType).toBe("refund-card");
  });

  it("returns empty for a non-saga (no ledger)", () => {
    expect(compensationPreview(null)).toEqual([]);
    expect(compensationPreview(undefined)).toEqual([]);
  });
});
