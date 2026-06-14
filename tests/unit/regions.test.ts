import { describe, it, expect } from "vitest";
import { validateRegions, type RegionInput } from "../../src/bpmn/regions";

// Build a single-scope RegionInput from (nodeId,type) pairs and (flowId,src,tgt) edges.
function build(
  nodes: Array<[string, string]>,
  edges: Array<[string, string, string]>,
  boundaries: Array<{ id: string; attachedTo: string; target: string; kind: string }> = [],
): RegionInput {
  const nodeInfos = nodes.map(([id, type]) => ({ id, type, scopeId: "P" }));
  for (const b of boundaries) nodeInfos.push({ id: b.id, type: "boundaryEvent", scopeId: "P", boundaryKind: b.kind, attachedToRef: b.attachedTo } as any);
  const flowInfos = edges.map(([id, source, target]) => ({ id, source, target, scopeId: "P" }));
  for (const b of boundaries) flowInfos.push({ id: `${b.id}_out`, source: b.id, target: b.target, scopeId: "P" } as any);
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const f of flowInfos) {
    (outgoing.get(f.source!) ?? outgoing.set(f.source!, []).get(f.source!)!).push(f.target!);
    (incoming.get(f.target!) ?? incoming.set(f.target!, []).get(f.target!)!).push(f.source!);
  }
  const nodeById = new Map(nodeInfos.map((n) => [n.id, n]));
  return { scopeId: "P", scopeKind: "process", scopeNodes: nodeInfos as any, flows: flowInfos as any, outgoing, incoming, nodeById: nodeById as any };
}
const reasons = (r: ReturnType<typeof validateRegions>) => r.errors.map((e) => e.reason).join(" | ");

describe("validateRegions — balanced AND region", () => {
  it("accepts a single AND split/join and emits one region in document order", () => {
    const r = validateRegions(build(
      [["S", "startEvent"], ["fork", "parallelGateway"], ["A", "serviceTask"], ["B", "serviceTask"], ["join", "parallelGateway"], ["C", "serviceTask"], ["E", "endEvent"]],
      [["s0", "S", "fork"], ["f1", "fork", "A"], ["f2", "fork", "B"], ["j1", "A", "join"], ["j2", "B", "join"], ["s1", "join", "C"], ["s2", "C", "E"]],
    ));
    expect(r.errors).toEqual([]);
    expect(r.regions["fork"]).toMatchObject({ splitId: "fork", joinId: "join", type: "and", branchFlowIds: ["f1", "f2"], enclosingScopeId: "P" });
  });
});

describe("validateRegions — rejections", () => {
  it("rejects a split with no matching join (single-exit/post-dominator violation)", () => {
    // fork → A → E and fork → B → join → E2 : join does not post-dominate fork
    const r = validateRegions(build(
      [["S", "startEvent"], ["fork", "parallelGateway"], ["A", "serviceTask"], ["B", "serviceTask"], ["join", "parallelGateway"], ["E", "endEvent"], ["E2", "endEvent"]],
      [["s0", "S", "fork"], ["f1", "fork", "A"], ["f2", "fork", "B"], ["a", "A", "E"], ["j2", "B", "join"], ["s1", "join", "E2"]],
    ));
    expect(r.errors.length).toBeGreaterThan(0);
    expect(reasons(r)).toMatch(/fork/);
  });

  it("rejects a mismatched join type (parallel split, inclusive join)", () => {
    const r = validateRegions(build(
      [["S", "startEvent"], ["fork", "parallelGateway"], ["A", "serviceTask"], ["B", "serviceTask"], ["join", "inclusiveGateway"], ["E", "endEvent"]],
      [["s0", "S", "fork"], ["f1", "fork", "A"], ["f2", "fork", "B"], ["j1", "A", "join"], ["j2", "B", "join"], ["s1", "join", "E"]],
    ));
    expect(reasons(r)).toMatch(/same type|matching join/i);
  });

  it("rejects a none end event inside the region (a path to SINK not through the join)", () => {
    const r = validateRegions(build(
      [["S", "startEvent"], ["fork", "parallelGateway"], ["A", "serviceTask"], ["B", "endEvent"], ["join", "parallelGateway"], ["E", "endEvent"]],
      [["s0", "S", "fork"], ["f1", "fork", "A"], ["f2", "fork", "B"], ["j1", "A", "join"], ["s1", "join", "E"]],
    ));
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects an uncontrolled merge inside the region (a task with 2 incoming flows)", () => {
    // both branches point at the same task M before the join
    const r = validateRegions(build(
      [["S", "startEvent"], ["fork", "parallelGateway"], ["A", "serviceTask"], ["B", "serviceTask"], ["M", "serviceTask"], ["join", "parallelGateway"], ["E", "endEvent"]],
      [["s0", "S", "fork"], ["f1", "fork", "A"], ["f2", "fork", "B"], ["a", "A", "M"], ["b", "B", "M"], ["m", "M", "join"], ["s1", "join", "E"]],
    ));
    // An ALL-branch merge at M makes M the immediate post-dominator of fork, so the
    // split↔join match (design §4.1 rule 3) rejects first with "no matching join";
    // rule 6's "incoming/merge" reason fires for PARTIAL merges (a 2-incoming node
    // off the post-dominator path). Either way the uncontrolled-merge model is
    // rejected with an element id (AC #4) — the regex covers both reasons.
    expect(reasons(r)).toMatch(/incoming|merge|matching join/i);
  });

  it("rejects a multi-incoming eventBasedGateway inside a region (EBG is a split, not a synchronising join)", () => {
    // fork → {A, B, C}; A and B both feed M (an eventBasedGateway, 2 incoming), C
    // bypasses M straight to join — so M is NOT the post-dominator of fork (join is),
    // the split↔join pair matches, and M is a region member with 2 incoming. An EBG
    // is a split, not a join, and is not caught by the bijection check, so rule 6 must
    // flag this uncontrolled merge (regression: rule 6 must NOT exempt eventBasedGateway).
    const r = validateRegions(build(
      [["S", "startEvent"], ["fork", "parallelGateway"], ["A", "serviceTask"], ["B", "serviceTask"], ["C", "serviceTask"], ["M", "eventBasedGateway"], ["join", "parallelGateway"], ["E", "endEvent"]],
      [["s0", "S", "fork"], ["f1", "fork", "A"], ["f2", "fork", "B"], ["f3", "fork", "C"], ["a", "A", "M"], ["b", "B", "M"], ["m", "M", "join"], ["c", "C", "join"], ["s1", "join", "E"]],
    ));
    expect(reasons(r)).toMatch(/incoming|merge/i);
  });

  it("rejects a boundary redirect that escapes the branch (blocker 13)", () => {
    // timer boundary on A inside the region routes to C (outside, past the join)
    const r = validateRegions(build(
      [["S", "startEvent"], ["fork", "parallelGateway"], ["A", "serviceTask"], ["B", "serviceTask"], ["join", "parallelGateway"], ["C", "serviceTask"], ["E", "endEvent"]],
      [["s0", "S", "fork"], ["f1", "fork", "A"], ["f2", "fork", "B"], ["j1", "A", "join"], ["j2", "B", "join"], ["s1", "join", "C"], ["s2", "C", "E"]],
      [{ id: "bt", attachedTo: "A", target: "C", kind: "timer" }],
    ));
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("accepts two disjoint regions and rejects partial overlap (laminar nesting)", () => {
    // nested OK: outer fork/join with an inner fork/join wholly in branch A
    const ok = validateRegions(build(
      [["S", "startEvent"], ["fork", "parallelGateway"], ["if", "parallelGateway"], ["A1", "serviceTask"], ["A2", "serviceTask"], ["ij", "parallelGateway"], ["B", "serviceTask"], ["join", "parallelGateway"], ["E", "endEvent"]],
      [["s0", "S", "fork"], ["f1", "fork", "if"], ["f2", "fork", "B"], ["i1", "if", "A1"], ["i2", "if", "A2"], ["k1", "A1", "ij"], ["k2", "A2", "ij"], ["m1", "ij", "join"], ["m2", "B", "join"], ["s1", "join", "E"]],
    ));
    expect(ok.errors).toEqual([]);
    expect(Object.keys(ok.regions).sort()).toEqual(["fork", "if"]);
  });
});
