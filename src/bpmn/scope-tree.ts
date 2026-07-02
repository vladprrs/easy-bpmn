// Static scope-hierarchy math (M5-L1, spec §2). All functions are pure reads of
// the compiled graph; SQL never walks the tree — callers pass precomputed IN-lists.

import type { ExecutionGraph, ScopeMeta } from "./graph";

/** The scope map; legacy (pre-M5) graphs synthesize flat transaction entries. */
export function scopesOf(graph: ExecutionGraph): Record<string, ScopeMeta> {
  if (graph.scopes) return graph.scopes;
  const out: Record<string, ScopeMeta> = {};
  for (const [id, tx] of Object.entries(graph.transactions ?? {})) {
    out[id] = { id, kind: "transaction", parentId: null, depth: 1, startId: tx.startId };
  }
  return out;
}

/** Scopes whose parent chain contains root (inclusive). null root = the process = ALL scopes. */
export function subtreeScopeIds(graph: ExecutionGraph, rootScopeId: string | null): string[] {
  const scopes = scopesOf(graph);
  if (rootScopeId == null) return Object.keys(scopes);
  const out: string[] = [];
  for (const id of Object.keys(scopes)) {
    for (let s: string | null = id; s != null; s = scopes[s]?.parentId ?? null) {
      if (s === rootScopeId) { out.push(id); break; }
    }
  }
  return out;
}

/** Nearest transaction on the parent chain, INCLUSIVE of scopeId itself. */
export function nearestEnclosingTx(graph: ExecutionGraph, scopeId: string | null): string | null {
  const scopes = scopesOf(graph);
  for (let s = scopeId; s != null; s = scopes[s]?.parentId ?? null) {
    if (scopes[s]?.kind === "transaction") return s;
  }
  return null;
}

/** txId plus descendant scopes reachable without passing through another transaction (spec §2). */
export function ownedScopeIds(graph: ExecutionGraph, txId: string): string[] {
  return subtreeScopeIds(graph, txId).filter((id) => nearestEnclosingTx(graph, id) === txId);
}

/** a strictly encloses b. a=null is the process root: strict ancestor of every scope. */
export function isStrictAncestor(graph: ExecutionGraph, a: string | null, b: string): boolean {
  const scopes = scopesOf(graph);
  if (a === b) return false;
  if (a == null) return scopes[b] != null;
  for (let s: string | null = scopes[b]?.parentId ?? null; s != null; s = scopes[s]?.parentId ?? null) {
    if (s === a) return true;
  }
  return false;
}

/**
 * Scopes whose committedLocal rows are eligible for compensation root R:
 * s ∈ subtree(R) with strictAncestor(R, nearestEnclosingTx(s)) — spec §3.4.
 */
export function eligibleCommittedLocalScopeIds(graph: ExecutionGraph, rootScopeId: string | null): string[] {
  return subtreeScopeIds(graph, rootScopeId).filter((id) => {
    const tx = nearestEnclosingTx(graph, id);
    return (tx != null && isStrictAncestor(graph, rootScopeId, tx)) || (tx == null && rootScopeId == null);
  });
}
