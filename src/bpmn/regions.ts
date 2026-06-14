// Pure SESE region analysis (M4-L1, design §4.1). No moddle, no runtime.
//
// Validates that every parallelGateway/inclusiveGateway split is paired with
// exactly one matching join of the SAME type forming a single-entry/single-exit
// (SESE) region, and produces the region map the engine persists. Operates on the
// classification data validator.ts already builds for one scope.

const VIRTUAL_SOURCE = " SOURCE";
const VIRTUAL_SINK = " SINK";

export interface RegionNodeInfo {
  id: string;
  type: string; // NodeType string ("serviceTask" | "parallelGateway" | "endEvent" | "boundaryEvent" | …)
  scopeId: string;
  boundaryKind?: string | null;
  attachedToRef?: string | null;
}
export interface RegionFlowInfo {
  id: string;
  source?: string;
  target?: string;
  scopeId: string;
}
export interface RegionInput {
  scopeId: string;
  scopeKind: "process" | "transaction";
  scopeNodes: RegionNodeInfo[];
  flows: RegionFlowInfo[];
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
  nodeById: Map<string, RegionNodeInfo>;
}
export interface RegionInfoOut {
  splitId: string;
  joinId: string;
  type: "and" | "or";
  branchFlowIds: string[];
  enclosingScopeId: string;
}
export interface RegionError {
  reason: string;
  elementId: string | null;
}
export interface RegionValidationResult {
  regions: Record<string, RegionInfoOut>;
  errors: RegionError[];
}

const isSplitType = (t: string) => t === "parallelGateway" || t === "inclusiveGateway";

/** Iterative dominators (Cooper–Harvey–Kennedy) over a forward CFG from `entry`. */
function dominators(
  vertices: string[],
  succ: Map<string, string[]>,
  pred: Map<string, string[]>,
  entry: string,
): Map<string, string> {
  // Reverse-postorder numbering from `entry`.
  const order: string[] = [];
  const seen = new Set<string>();
  (function dfs(v: string) {
    seen.add(v);
    for (const w of succ.get(v) ?? []) if (!seen.has(w)) dfs(w);
    order.push(v);
  })(entry);
  order.reverse();
  const rpo = new Map(order.map((v, i) => [v, i]));
  const idom = new Map<string, string | undefined>(vertices.map((v) => [v, undefined]));
  idom.set(entry, entry);
  const intersect = (a: string, b: string): string => {
    let x = a, y = b;
    while (x !== y) {
      while ((rpo.get(x) ?? Infinity) > (rpo.get(y) ?? Infinity)) x = idom.get(x)!;
      while ((rpo.get(y) ?? Infinity) > (rpo.get(x) ?? Infinity)) y = idom.get(y)!;
    }
    return x;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const v of order) {
      if (v === entry) continue;
      let newIdom: string | undefined;
      for (const p of pred.get(v) ?? []) {
        if (idom.get(p) === undefined) continue;
        newIdom = newIdom === undefined ? p : intersect(newIdom, p);
      }
      if (newIdom !== undefined && idom.get(v) !== newIdom) {
        idom.set(v, newIdom);
        changed = true;
      }
    }
  }
  return new Map(Array.from(idom.entries()).filter(([, d]) => d !== undefined) as [string, string][]);
}

export function validateRegions(input: RegionInput): RegionValidationResult {
  const { scopeId, scopeNodes, outgoing, incoming, nodeById } = input;
  const errors: RegionError[] = [];
  const regions: Record<string, RegionInfoOut> = {};

  // ---- Build the CFG: token-path vertices + each transaction as one vertex +
  // error/cancel/timer boundary events; edges = sequence flows + activity→boundary
  // + boundary→target; virtual SOURCE→start, every end/successor-less node→SINK.
  const inScope = (id: string) => nodeById.get(id)?.scopeId === scopeId;
  const tokenNodes = scopeNodes.filter(
    (n) => n.scopeId === scopeId && n.type !== "boundaryEvent" && !(n.type === "serviceTask" && (n as any).isForCompensation),
  );
  const routingBoundaries = scopeNodes.filter(
    (n) => n.scopeId === scopeId && n.type === "boundaryEvent" && (n.boundaryKind === "error" || n.boundaryKind === "cancel" || n.boundaryKind === "timer"),
  );
  const verts = new Set<string>([VIRTUAL_SOURCE, VIRTUAL_SINK]);
  for (const n of tokenNodes) verts.add(n.id);
  for (const b of routingBoundaries) verts.add(b.id);

  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  const addEdge = (a: string, b: string) => {
    if (!verts.has(a) || !verts.has(b)) return;
    (succ.get(a) ?? succ.set(a, []).get(a)!).push(b);
    (pred.get(b) ?? pred.set(b, []).get(b)!).push(a);
  };
  const start = tokenNodes.find((n) => n.type === "startEvent");
  if (!start) return { regions, errors }; // a malformed scope; degree checks already errored
  addEdge(VIRTUAL_SOURCE, start.id);
  for (const n of tokenNodes) {
    const outs = (outgoing.get(n.id) ?? []).filter(inScope);
    if (n.type === "endEvent" || outs.length === 0) addEdge(n.id, VIRTUAL_SINK);
    for (const t of outs) addEdge(n.id, t);
  }
  for (const b of routingBoundaries) {
    if (b.attachedToRef && verts.has(b.attachedToRef)) addEdge(b.attachedToRef, b.id);
    const outs = (outgoing.get(b.id) ?? []).filter(inScope);
    if (outs.length === 0) addEdge(b.id, VIRTUAL_SINK);
    for (const t of outs) addEdge(b.id, t);
  }

  const vertexList = Array.from(verts);
  const idom = dominators(vertexList, succ, pred, VIRTUAL_SOURCE);
  // Post-dominators = dominators on the reversed CFG from SINK.
  const ipdom = dominators(vertexList, pred, succ, VIRTUAL_SINK);
  const dom = (a: string, b: string): boolean => { // a dominates b
    let x: string | undefined = b;
    while (x !== undefined) { if (x === a) return true; if (x === idom.get(x)) break; x = idom.get(x); }
    return a === b;
  };
  const postdom = (a: string, b: string): boolean => { // a post-dominates b
    let x: string | undefined = b;
    while (x !== undefined) { if (x === a) return true; if (x === ipdom.get(x)) break; x = ipdom.get(x); }
    return a === b;
  };

  // ---- Match each split to ipdom(split); validate type + single-entry + bijection.
  const splits = tokenNodes.filter((n) => isSplitType(n.type) && (outgoing.get(n.id) ?? []).filter(inScope).length > 1);
  const joinClaimedBy = new Map<string, string>();
  for (const s of splits) {
    const j = ipdom.get(s.id);
    const jNode = j ? nodeById.get(j) : undefined;
    if (!j || !jNode || jNode.type !== s.type || (incoming.get(j) ?? []).filter(inScope).length < 2) {
      errors.push({ reason: `Concurrent split '${s.id}' (${s.type}) has no matching join of the same type — a parallel/inclusive region must be single-entry/single-exit (a balanced split↔join pair).`, elementId: s.id });
      continue;
    }
    if (idom.get(j) !== s.id) {
      errors.push({ reason: `Concurrent split '${s.id}' and its join '${j}' are not single-entry (the join is not dominated by the split) — region nesting must be properly balanced.`, elementId: s.id });
      continue;
    }
    if (joinClaimedBy.has(j)) {
      errors.push({ reason: `Join '${j}' is matched by two splits ('${joinClaimedBy.get(j)}' and '${s.id}') — the split↔join map must be a bijection.`, elementId: s.id });
      continue;
    }
    joinClaimedBy.set(j, s.id);

    // ---- Region members R(S,J) = { X : S dom X and J postdom X }.
    const members = vertexList.filter((x) => x !== VIRTUAL_SOURCE && x !== VIRTUAL_SINK && dom(s.id, x) && postdom(j, x));

    // Rule 6 — no uncontrolled merge: inside the region, only a MERGE-SAFE gateway
    // may have >1 incoming token flow — the matching join (synchronises), a nested
    // parallel/inclusive JOIN (synchronises its own inner region — matched ones are
    // legitimate; an UNMATCHED multi-incoming parallel/inclusive gateway is caught by
    // the bijection "other half" check below), or an exclusiveGateway pass-through
    // merge (single-token by XOR semantics). An `eventBasedGateway` is a SPLIT, never
    // a synchronising join, and is NOT covered by the bijection check, so a
    // multi-incoming EBG inside a region IS an uncontrolled merge — it is flagged like
    // any non-gateway. A service/receive task, intermediate catch, or end event with
    // >1 incoming flow is likewise rejected — concurrent branch tokens would execute
    // it twice instead of synchronising (design §4.1 rule 6 exempts only the matching
    // join + an exclusiveGateway merge).
    for (const x of members) {
      if (x === j || x === s.id) continue;
      const xNode = nodeById.get(x);
      if (xNode?.type === "boundaryEvent") continue;
      const isMergeSafeGateway =
        xNode?.type === "exclusiveGateway" ||
        xNode?.type === "parallelGateway" ||
        xNode?.type === "inclusiveGateway";
      const inc = (incoming.get(x) ?? []).filter(inScope);
      if (inc.length > 1 && !isMergeSafeGateway) {
        errors.push({ reason: `Element '${x}' inside the region of split '${s.id}' has ${inc.length} incoming sequence flows — concurrent branch tokens would execute it twice instead of synchronising at join '${j}'.`, elementId: x });
      }
    }

    // Rule 5 — branch confinement: every member's out-edge target stays in the
    // region (members ∪ {join}); a boundary redirect leaving the region is rejected.
    const memberSet = new Set(members);
    for (const x of members) {
      if (x === j) continue;
      for (const t of (outgoing.get(x) ?? []).filter(inScope)) {
        if (!memberSet.has(t) && t !== j) {
          errors.push({ reason: `Element '${x}' inside the region of split '${s.id}' has an edge to '${t}', which leaves the region without passing through join '${j}' (branch confinement / boundary-redirect escape).`, elementId: x });
        }
      }
    }

    regions[s.id] = {
      splitId: s.id,
      joinId: j,
      type: s.type === "parallelGateway" ? "and" : "or",
      branchFlowIds: (input.flows.filter((f) => f.source === s.id && inScope(f.target ?? "")).map((f) => f.id)),
      enclosingScopeId: scopeId,
    };
  }

  // Bijection (other half): a multi-incoming parallel/inclusive gateway must be a matched join.
  for (const n of tokenNodes) {
    if (isSplitType(n.type) && (incoming.get(n.id) ?? []).filter(inScope).length > 1 && !joinClaimedBy.has(n.id)) {
      errors.push({ reason: `Concurrent join '${n.id}' (${n.type}) is not matched by any split of the same type — an unmatched multi-incoming parallel/inclusive gateway is rejected.`, elementId: n.id });
    }
  }

  // Rule 7 — laminar nesting: any two regions nest or are disjoint, never partially overlap.
  const regionList = Object.values(regions);
  const memberOf = (r: RegionInfoOut) => new Set(vertexList.filter((x) => x !== VIRTUAL_SOURCE && x !== VIRTUAL_SINK && dom(r.splitId, x) && postdom(r.joinId, x)));
  for (let i = 0; i < regionList.length; i++) {
    for (let k = i + 1; k < regionList.length; k++) {
      const a = memberOf(regionList[i]!), b = memberOf(regionList[k]!);
      const inter = [...a].filter((x) => b.has(x));
      if (inter.length > 0) {
        const aSubB = [...a].every((x) => b.has(x));
        const bSubA = [...b].every((x) => a.has(x));
        if (!aSubB && !bSubA) {
          errors.push({ reason: `Regions of splits '${regionList[i]!.splitId}' and '${regionList[k]!.splitId}' partially overlap — regions must be nested or disjoint (laminar).`, elementId: regionList[i]!.splitId });
        }
      }
    }
  }

  return { regions, errors };
}
