import { describe, expect, it } from "vitest";
import { buildAdjacency, computeOverlay, deriveFlow, deriveHeat } from "./flow";
import type { BpmnElement, HistoryEvent, ProcessInstanceInspection, SagaHeatmap } from "../api/types";

// A small linear process: start → t1 → t2 → end.
const ELEMENTS: BpmnElement[] = [
  { elementId: "start", type: "startEvent" },
  { elementId: "t1", type: "serviceTask" },
  { elementId: "t2", type: "serviceTask" },
  { elementId: "end", type: "endEvent" },
  { elementId: "f1", type: "sequenceFlow", sourceRef: "start", targetRef: "t1" },
  { elementId: "f2", type: "sequenceFlow", sourceRef: "t1", targetRef: "t2" },
  { elementId: "f3", type: "sequenceFlow", sourceRef: "t2", targetRef: "end" },
];
const adj = buildAdjacency(ELEMENTS);

function ev(type: string, elementId: string | null = null, i = 0): HistoryEvent {
  return {
    historyEventId: `h${i}-${type}`,
    type,
    elementId: elementId ?? null,
    businessTime: "2026-06-14T00:00:00.000Z",
    technicalTime: "2026-06-14T00:00:00.000Z",
    diagnostics: {},
  };
}
const inst = (over: Partial<ProcessInstanceInspection>): ProcessInstanceInspection =>
  ({ status: "running", ...over }) as ProcessInstanceInspection;

describe("buildAdjacency", () => {
  it("parses sequence flows into edges + a target index", () => {
    expect(adj.edges.map((e) => e.id)).toEqual(["f1", "f2", "f3"]);
    expect(adj.byTarget.get("t2")?.[0]?.source).toBe("t1");
    expect(adj.typeOf.get("end")).toBe("endEvent");
  });
});

describe("computeOverlay", () => {
  it("derives traversed + current from history and live token state", () => {
    const events = [ev("instanceStarted", null, 0), ev("elementEntered", "start", 1), ev("elementEntered", "t1", 2)];
    const o = computeOverlay(inst({ currentElementId: "t1" }), events);
    expect(o.traversed.sort()).toEqual(["start", "t1"]);
    expect(o.current).toEqual(["t1"]);
  });

  it("surfaces open incidents as failed elements", () => {
    const o = computeOverlay(inst({ status: "incident", openIncidents: [{ elementId: "t2", reason: "503" } as any] }), [ev("elementEntered", "t2", 0)]);
    expect(o.failed).toEqual([{ elementId: "t2", reason: "503" }]);
  });

  it("scrubbing replays to a moment and ignores live incident state", () => {
    const events = [ev("elementEntered", "start", 0), ev("elementEntered", "t1", 1), ev("elementEntered", "t2", 2)];
    const o = computeOverlay(inst({ status: "incident", openIncidents: [{ elementId: "t2" } as any] }), events, 1);
    expect(o.traversed.sort()).toEqual(["start", "t1"]);
    expect(o.current).toEqual(["t1"]); // last shown event
    expect(o.failed).toEqual([]); // live state ignored while scrubbing
  });
});

describe("deriveFlow", () => {
  it("splits the path: done behind, live (+token) into the frontier", () => {
    const o = computeOverlay(inst({ currentElementId: "t2" }), [ev("e", "start", 0), ev("e", "t1", 1), ev("e", "t2", 2)]);
    const f = deriveFlow(adj, o, "running");
    expect(f.doneEdges).toEqual(["f1"]); // start→t1, behind the frontier
    expect(f.liveEdges).toEqual(["f2"]); // t1→t2, into the current node
    expect(f.tokenEdges).toEqual(["f2"]);
    expect(f.interruptEdges).toEqual([]);
  });

  it("interrupts the edge into a failed node", () => {
    const o = computeOverlay(inst({ status: "incident", openIncidents: [{ elementId: "t2" } as any] }), [ev("e", "start", 0), ev("e", "t1", 1), ev("e", "t2", 2)]);
    const f = deriveFlow(adj, o, "incident");
    expect(f.interruptEdges).toContain("f2");
  });

  it("settles the finished circuit (all done, end glows, no live frontier)", () => {
    const events = [ev("e", "start", 0), ev("e", "t1", 1), ev("e", "t2", 2), ev("e", "end", 3)];
    // A completed run keeps currentElementId, but it must NOT read as a live frontier.
    const o = computeOverlay(inst({ status: "completed", currentElementId: "end" }), events);
    expect(o.current).toEqual([]);
    const f = deriveFlow(adj, o, "completed");
    expect(f.doneEdges.sort()).toEqual(["f1", "f2", "f3"]);
    expect(f.liveEdges).toEqual([]);
    expect(f.settledNodes).toEqual(["end"]);
  });

  it("flags the success beat + orders the reverse sweep End→Start", () => {
    const events = [ev("e", "start", 0), ev("e", "t1", 1), ev("e", "t2", 2), ev("e", "end", 3)];
    const o = computeOverlay(inst({ status: "completed", currentElementId: "end" }), events);
    const f = deriveFlow(adj, o, "completed");
    expect(f.settled).toBe(true);
    const ids = f.settleOrder!.map((s) => s.id);
    expect(ids[0]).toBe("end"); // the sweep originates at the End event
    expect(ids[ids.length - 1]).toBe("start"); // …and lands back at Start
    expect(f.settleOrder!.filter((s) => s.kind === "node").map((s) => s.id)).toEqual(["end", "t2", "t1", "start"]);
    // every node is followed by the edge that fed it (so light reads as flowing back)
    expect(f.settleOrder!.slice(0, 4)).toEqual([
      { id: "end", kind: "node" },
      { id: "f3", kind: "edge" },
      { id: "t2", kind: "node" },
      { id: "f2", kind: "edge" },
    ]);
  });

  it("does not fire the beat while running (no settle order)", () => {
    const o = computeOverlay(inst({ currentElementId: "t2" }), [ev("e", "start", 0), ev("e", "t1", 1), ev("e", "t2", 2)]);
    const f = deriveFlow(adj, o, "running");
    expect(f.settled).toBe(false);
    expect(f.settleOrder).toEqual([]);
  });

  it("does not fire the beat on a compensated roll-back", () => {
    const events = [ev("e", "start", 0), ev("e", "t1", 1)];
    const o = computeOverlay(inst({ status: "compensated" }), events);
    const f = deriveFlow(adj, o, "compensated");
    expect(f.settled).toBe(false);
  });
});

describe("deriveHeat", () => {
  it("tiers density and runs a failing node hot", () => {
    const heatmap: SagaHeatmap = {
      sagaId: "s",
      activeVersionId: "v",
      totalLive: 4,
      generatedAt: "2026-06-14T00:00:00.000Z",
      nodes: [
        { elementId: "t1", count: 3, byStatus: { running: 3 } },
        { elementId: "t2", count: 1, byStatus: { incident: 1 } },
      ],
    };
    const h = deriveHeat(adj, heatmap);
    expect(h.max).toBe(3);
    expect(h.nodes.find((n) => n.elementId === "t1")).toMatchObject({ tier: 3, hot: false });
    expect(h.nodes.find((n) => n.elementId === "t2")).toMatchObject({ hot: true });
    expect(h.liveEdges).toEqual(["f2"]); // both endpoints populated
  });

  it("is empty without a heatmap", () => {
    expect(deriveHeat(adj, undefined)).toEqual({ nodes: [], liveEdges: [], max: 0 });
  });
});
