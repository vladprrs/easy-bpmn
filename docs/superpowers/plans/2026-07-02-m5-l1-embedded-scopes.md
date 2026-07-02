# M5-L1 Embedded Scopes + Hierarchical Exceptions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement M5-L1 per `docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md` — plain embedded `subProcess`, the generalized typed scope hierarchy, the commit shield (`committedLocal` / sealed `committed`), scope-subtree compensation, hierarchical error bubbling, the error end event, and error/timer boundaries on scopes — opened by the constitution v2.5.0 amendment.

**Architecture:** The scope tree is compiled into the immutable graph (`ExecutionGraph.scopes`), all hierarchy math is pure JS over that map (new `src/bpmn/scope-tree.ts`), and SQL receives precomputed `IN`-lists. The saga ledger gains one non-terminal status (`committedLocal`) and a per-instance-global `seq`; the reverse cursor becomes root-relative. The engine walk treats `subProcess` as a bookkeeping scope (mirroring `transaction`), errors climb the attachment chain, and a nested cancel-end resumes the instance after its subtree compensates.

**Tech Stack:** Cloudflare Workers (TypeScript), D1, bpmn-moddle, Vitest + `@cloudflare/vitest-pool-workers` (direct mode: `EXECUTION_MODE=direct`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md` (referenced below as "spec §N"). Where this plan is more detailed, the plan wins.
- Constitution gate: the v2.5.0 amendment (Task 1) MUST be committed before any runtime change lands.
- `MAX_SCOPE_DEPTH = 8`, defined in `src/runtime/engine.ts`, enforced at publish (validator), synced by `scripts/check-docs.mjs`.
- New incident kind: `uncaughtError` (error end event uncaught at root). Worker-task uncaught errors keep `serviceTaskFailure`.
- New compensation status: `committedLocal` (non-terminal). `committed` stays terminal (sealed). No D1 migration — TEXT column.
- Backward compatibility: graphs published before this layer have no `scopes` map — every helper must fall back to synthesizing `{transaction, parent:null}` entries from `graph.transactions`. All existing M1–M4 tests MUST pass without edits (the no-op gate), except the deliberately rewritten matrix scenario `C-COMP-NESTEDTX-BRANCH-01`.
- All tests run in direct mode: `npm run test:integration`, `npm run test:unit`. Always finish a task with `npm run typecheck` (vitest does not typecheck).
- Commit style: `feat(m5-l1): …` / `docs(m5-l1): …` / `test(m5-l1): …` (repo convention).
- Code and docs are English. No `bpmn:`-namespace custom notation; every reject carries element id + reason.
- File anchors (`file.ts:NNN`) are from branch `m5-composition-design` @ `43ce41f`; re-locate by content if drifted.

---

### Task 1: Branch setup + governance opening (v2.5.0, constitution check, spec section)

**Files:**
- Modify: `.specify/memory/constitution.md`
- Create: `specs/002-saga-orchestrator/m5-L1-constitution-check.md`
- Modify: `specs/002-saga-orchestrator/spec.md`
- Modify: `docs/bpmn/09-easy-bpmn-profile.md` (interim markers only)

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-06-20-m5-composition-design.md` §5 (the amendment content), the M5-L1 design doc.
- Produces: constitution at v2.5.0 — the governance authorization every later task cites.

- [ ] **Step 1: Merge the docs-only design branch and cut the work branch**

```bash
git checkout main && git pull
git merge --no-ff m5-composition-design -m "docs(m5): merge composition decomposition + M5-L1 design"
git push origin main
git checkout -b m5-l1-embedded-scopes
```

(The two stray `Снимок экрана*.png` screenshots in the worktree are untracked leftovers — do not add them; leave or delete.)

- [ ] **Step 2: Amend the constitution to v2.5.0**

Edit `.specify/memory/constitution.md` following the exact structure of the 2.3.x→2.4.0 amendment (Sync Impact Report at the top, per-principle table, version line at the bottom). Content per decomposition doc §5, verbatim decisions:

- Header: `Sync Impact Report — 2.4.0 -> 2.5.0 (<today>)`.
- **Principle I**: widen the accepted construct set with the whole composition set: non-transaction `subProcess`, error/timer boundary on a `subProcess`/`transaction`, error end event, `callActivity`, `multiInstanceLoopCharacteristics` (parallel + sequential), escalation throw/boundary + event subprocess, signal throw/catch, first non-interrupting boundaries (signal/escalation only). List the still-rejected set (complex gateway, conditional/link events, ad-hoc subprocess, `standardLoopCharacteristics`, top-level signal start, non-process `calledElement`, compensate-throw, MI standard data bindings) — each rejected with element id + reason. Runtime opens per layer M5-L1…L5 with interim markers in `docs/bpmn/09` (M3/M4 precedent).
- **Principle II**: `calledElement` resolves at parent publish to a concrete `definitionVersionId` (recorded now; lands in M5-L2).
- **Principle III**: child create / child output-apply / signal fan-out are at-least-once with provenance-gated single-apply (recorded now; lands in L2/L5).
- **Principle IV**: additively extended — the message invariant stays **verbatim**; signal is a separate workspace-scoped 1:N broadcast class (broker-key single-subscription invariant not applicable). Mark "additively extended — message invariant unchanged" in the per-principle table.
- **Principle VI**: compensation generalized to a **scope subtree**: nested commit is non-terminal (`committedLocal`) and seals only at the outermost commit; the straggler cohort + live-token barrier use scope-subtree membership; compensation wiring is legal iff some ancestor scope is a transaction. Cancel-only-trigger / Hazard-does-not-compensate / idempotent / at-least-once clauses unchanged.
- New caps recorded: `MAX_SCOPE_DEPTH` (publish-time in L1), `MAX_CALL_DEPTH`, `MAX_MI_CARDINALITY`, `MAX_SIGNAL_FANOUT` (L2/L3/L5).
- Footer: `**Version**: 2.5.0 | **Ratified**: 2026-06-07 | **Last Amended**: <today>`.

- [ ] **Step 3: Write `specs/002-saga-orchestrator/m5-L1-constitution-check.md`**

Mirror `m4-constitution-check.md`'s structure (read it first): one section per principle, PASS/deviation verdicts for the M5-L1 layer specifically (subProcess acceptance, scope model, commit shield, bubbling, error end, scope boundaries, caps). Record the two deliberate refinements: (a) `MAX_SCOPE_DEPTH` is publish-time in L1 (`scopeDepth` runtime incident deferred to L2 — spec §7); (b) nested cancel-end resumes the instance (non-terminal settle, spec §4.3 as refined by plan Task 8).

- [ ] **Step 4: Append the M5-L1 section to `specs/002-saga-orchestrator/spec.md`**

Follow the M4 section's shape: scope of the layer (spec §1 in/out lists), the ledger invariant (spec §3.1 verbatim), the cursor semantics (§3.4 incl. the case table), exception semantics (§5), validator delta (§6 table), caps (§7), exit gates (§10). Reference the design doc as normative.

- [ ] **Step 5: Add interim markers to `docs/bpmn/09-easy-bpmn-profile.md`**

In the supported-set section add the M5 composition set with per-layer interim markers exactly as M3/M4 did (grep `09` for the previous "accepted in vX.Y.Z, runtime opens per layer" phrasing and reuse it): M5-L1 constructs marked "runtime opening in this layer", L2–L5 constructs marked "accepted (v2.5.0), runtime not yet open — publish still rejects (interim)".

- [ ] **Step 6: Verify and commit**

```bash
npm run check:docs
```
Expected: PASS (no cap values in docs yet; kind enum untouched).

```bash
git add .specify/memory/constitution.md specs/002-saga-orchestrator/ docs/bpmn/09-easy-bpmn-profile.md
git commit -m "docs(m5-l1): constitution v2.5.0 — accept the M5 composition set; L1 constitution check + spec section"
```

---

### Task 2: Scope-tree module + graph types

**Files:**
- Modify: `src/bpmn/graph.ts` (types only)
- Create: `src/bpmn/scope-tree.ts`
- Test: `tests/unit/scope-tree.test.ts`

**Interfaces:**
- Produces (everything below is consumed by Tasks 3–11):

```ts
// graph.ts
export type ScopeKind = "process" | "transaction" | "subProcess" | "callActivity" | "miBody";
export interface ScopeMeta {
  id: string;
  kind: ScopeKind;              // L1 produces only "transaction" | "subProcess"
  parentId: string | null;      // null = the process root
  depth: number;                // 1 for a scope directly in the process
  startId: string;              // the scope's inner none-start element id
}
export interface ExecutionGraph { /* existing fields */; scopes?: Record<string, ScopeMeta>; compensations?: Record<string, { handlerId: string; boundaryId: string }>; }
export type EndKind = "none" | "cancel" | "error";   // was "none" | "cancel"
export type NodeType = /* existing union */ | "subProcess";
// GraphNode gains: errorRef?/errorCode? are reused for endEvent kind "error" (already declared for boundaries)

// scope-tree.ts (all pure; every fn tolerates graphs WITHOUT `scopes` — legacy fallback)
export function scopesOf(graph: ExecutionGraph): Record<string, ScopeMeta>;
export function subtreeScopeIds(graph: ExecutionGraph, rootScopeId: string | null): string[]; // root incl.; null root = ALL scope ids
export function nearestEnclosingTx(graph: ExecutionGraph, scopeId: string | null): string | null; // inclusive walk
export function ownedScopeIds(graph: ExecutionGraph, txId: string): string[]; // txId + tx-free descendants
export function isStrictAncestor(graph: ExecutionGraph, a: string | null, b: string): boolean; // a=null (process) strict ancestor of every scope
export function eligibleCommittedLocalScopeIds(graph: ExecutionGraph, rootScopeId: string | null): string[];
```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/scope-tree.test.ts`:

```ts
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
```

Note on `eligibleCommittedLocalScopeIds(g, null)`: `P`'s rows can never actually BE `committedLocal` (no enclosing tx ever ledgers/commits them) — including `P` in the id-list is harmless and keeps the function a pure set-algebra composition.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/scope-tree.test.ts`
Expected: FAIL — module `src/bpmn/scope-tree.ts` not found.

- [ ] **Step 3: Add the types and implement the module**

In `src/bpmn/graph.ts`: add `ScopeKind`, `ScopeMeta`, extend `EndKind` with `"error"`, extend `NodeType` union with `"subProcess"`, add `scopes?` and `compensations?` to `ExecutionGraph` (doc comments: "static scope hierarchy — spec §2"; "flat element-id-keyed compensation wiring; supersedes per-transaction `compensations` for scope-aware lookups (spec §3.3), which is retained for legacy graphs").

Create `src/bpmn/scope-tree.ts`:

```ts
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
    return tx != null && isStrictAncestor(graph, rootScopeId, tx);
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/scope-tree.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bpmn/graph.ts src/bpmn/scope-tree.ts tests/unit/scope-tree.test.ts
git commit -m "feat(m5-l1): scope-tree module — typed scope hierarchy math over the compiled graph"
```

---

### Task 3: Validator — accept plain subProcess, emit the scope map, MAX_SCOPE_DEPTH

**Files:**
- Modify: `src/bpmn/validator.ts` (`classifyContainer` :381–:461, per-scope checks :849–:873, graph assembly :1488–:1602)
- Modify: `src/runtime/engine.ts` (the caps block, after :175)
- Modify: `scripts/check-docs.mjs` (`SYNCED_CONSTANTS`, :172)
- Test: `tests/unit/bpmn-validator.test.ts` (append a describe block)
- Test fixtures: inline XML in the test

**Interfaces:**
- Consumes: `ScopeMeta`/`ScopeKind` (Task 2).
- Produces: `graph.scopes` populated (with `parentId`/`depth`/`startId`), `graph.compensations` (flat map), `nodes[id].type === "subProcess"` for embedded subprocesses, publish rejects for `triggeredByEvent`, ad-hoc, MI-on-subProcess, depth > 8. Constant `MAX_SCOPE_DEPTH = 8` exported from `src/runtime/engine.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/bpmn-validator.test.ts` (reuse the file's existing `validate(...)` harness — read its top to copy the exact call pattern used by neighboring tests):

```ts
describe("M5-L1 embedded subProcess acceptance", () => {
  const SUBPROC = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="d" targetNamespace="http://example.com">
  <bpmn:process id="proc" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="sub"/>
    <bpmn:subProcess id="sub">
      <bpmn:startEvent id="s_start"/>
      <bpmn:sequenceFlow id="sf1" sourceRef="s_start" targetRef="s_task"/>
      <bpmn:serviceTask id="s_task"><bpmn:extensionElements><easy-bpmn:taskDefinition type="doWork"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="sf2" sourceRef="s_task" targetRef="s_end"/>
      <bpmn:endEvent id="s_end"/>
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="f2" sourceRef="sub" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;

  it("accepts a plain embedded subProcess and compiles its scope", async () => {
    const r = await validate(SUBPROC);
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes["sub"]!.type).toBe("subProcess");
    expect(r.graph!.nodes["s_task"]!.scopeId).toBe("sub");
    expect(r.graph!.scopes!["sub"]).toEqual({ id: "sub", kind: "subProcess", parentId: null, depth: 1, startId: "s_start" });
  });

  it("rejects an event subprocess (interim → M5-L4) with element id + reason", async () => {
    const r = await validate(SUBPROC.replace('<bpmn:subProcess id="sub">', '<bpmn:subProcess id="sub" triggeredByEvent="true">'));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "sub" && /M5-L4/.test(i.reason))).toBe(true);
  });

  it("rejects an adHocSubProcess with element id + reason", async () => {
    const r = await validate(SUBPROC.replace(/bpmn:subProcess/g, "bpmn:adHocSubProcess"));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "sub")).toBe(true);
  });

  it("rejects multiInstanceLoopCharacteristics on a subProcess (interim → M5-L3)", async () => {
    const withMi = SUBPROC.replace('<bpmn:startEvent id="s_start"/>', '<bpmn:multiInstanceLoopCharacteristics/><bpmn:startEvent id="s_start"/>');
    const r = await validate(withMi);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "sub" && /M5-L3/.test(i.reason))).toBe(true);
  });

  it("enforces MAX_SCOPE_DEPTH: depth 8 accepted, depth 9 rejected", async () => {
    const nest = (depth: number): string => {
      let inner = `<bpmn:startEvent id="d${depth}_start"/><bpmn:sequenceFlow id="d${depth}_f" sourceRef="d${depth}_start" targetRef="d${depth}_end"/><bpmn:endEvent id="d${depth}_end"/>`;
      for (let d = depth; d >= 1; d--) {
        inner = `<bpmn:startEvent id="d${d - 1}_start"/><bpmn:sequenceFlow id="d${d - 1}_f1" sourceRef="d${d - 1}_start" targetRef="sub${d}"/><bpmn:subProcess id="sub${d}">${inner}</bpmn:subProcess><bpmn:sequenceFlow id="d${d - 1}_f2" sourceRef="sub${d}" targetRef="d${d - 1}_end"/><bpmn:endEvent id="d${d - 1}_end"/>`;
      }
      return `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="http://example.com"><bpmn:process id="proc" isExecutable="true">${inner}</bpmn:process></bpmn:definitions>`;
    };
    expect((await validate(nest(8))).ok).toBe(true);
    const r9 = await validate(nest(9));
    expect(r9.ok).toBe(false);
    expect(r9.issues.some((i) => /MAX_SCOPE_DEPTH|depth/.test(i.reason))).toBe(true);
  });

  it("tolerates and ignores foreign-namespace extension content inside a subProcess", async () => {
    // spec §10 unit bullet: ignorable extension content must not reject.
    const withForeign = SUBPROC.replace(
      '<bpmn:startEvent id="s_start"/>',
      '<bpmn:extensionElements xmlns:camunda="http://camunda.org/schema/1.0/bpmn"><camunda:properties/></bpmn:extensionElements><bpmn:startEvent id="s_start"/>',
    );
    expect((await validate(withForeign)).ok).toBe(true);
  });

  it("accepts a transaction nested inside a subProcess and records parentage", async () => {
    const NESTED = SUBPROC.replace(
      '<bpmn:serviceTask id="s_task"><bpmn:extensionElements><easy-bpmn:taskDefinition type="doWork"/></bpmn:extensionElements></bpmn:serviceTask>',
      `<bpmn:transaction id="tx"><bpmn:startEvent id="t_start"/><bpmn:sequenceFlow id="tf1" sourceRef="t_start" targetRef="t_end"/><bpmn:endEvent id="t_end"/></bpmn:transaction>`,
    ).replace(/s_task/g, "tx");
    const r = await validate(NESTED);
    expect(r.ok).toBe(true);
    expect(r.graph!.scopes!["tx"]).toMatchObject({ kind: "transaction", parentId: "sub", depth: 2 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/bpmn-validator.test.ts -t "M5-L1 embedded subProcess"`
Expected: FAIL — subProcess hits the generic whitelist reject (`validator.ts:632-640`), `graph.scopes` undefined.

- [ ] **Step 3: Add `MAX_SCOPE_DEPTH` to the engine and the docs guard**

In `src/runtime/engine.ts`, after `STEP_BUDGET_SOFT` (:175):

```ts
/**
 * Scope-nesting depth cap (M5-L1, spec §7). Depth is fully STATIC in L1 (no
 * callActivity / MI), so this is enforced by the VALIDATOR at publish — a
 * fail-closed reject with element id + reason, zero runtime surface. The
 * `scopeDepth` runtime incident becomes reachable only with M5-L2 call chains.
 */
export const MAX_SCOPE_DEPTH = 8;
```

In `scripts/check-docs.mjs` extend the synced list (line ~172):

```js
const SYNCED_CONSTANTS = ["MAX_ELEMENT_OCCURRENCES", "MAX_CONCURRENT_TOKENS", "STEP_BUDGET_SOFT", "MAX_SCOPE_DEPTH"];
```

- [ ] **Step 4: Implement the validator changes**

(a) **`classifyContainer` recursion** — change the signature (all call sites: the initial process call, and the `bpmn:Transaction` recursion at :459):

```ts
const scopeParent = new Map<string, string | null>();
const scopeDepth = new Map<string, number>();

const classifyContainer = (
  container: ModdleElement,
  scopeId: string,
  scopeKind: "process" | "transaction" | "subProcess",
  parentScopeId: string | null,
  depth: number,
): void => {
  scopes.push({ id: scopeId, kind: scopeKind });
  scopeParent.set(scopeId, parentScopeId);
  scopeDepth.set(scopeId, depth);
  if (depth > MAX_SCOPE_DEPTH) {
    err(`Scope '${scopeId}' exceeds MAX_SCOPE_DEPTH = ${MAX_SCOPE_DEPTH} (nesting depth ${depth}).`, scopeId, scopeKind === "transaction" ? "transaction" : "subProcess");
  }
  // ... existing body ...
```

Import at the top of validator.ts: `import { MAX_SCOPE_DEPTH } from "../runtime/engine";` (no cycle: engine imports only `bpmn/graph`, never the validator).

Initial call becomes `classifyContainer(processEl, processId, "process", null, 0)`; the transaction branch becomes `classifyContainer(el, id ?? "", "transaction", scopeId, depth + 1)`.

(b) **subProcess branch** — insert directly after the `bpmn:Transaction` branch (:461):

```ts
// M5-L1: plain embedded subProcess — a bookkeeping scope on the token path.
if ($type === "bpmn:SubProcess") {
  if (el.triggeredByEvent === true) {
    err(`Event subprocess '${id ?? "(no id)"}' (triggeredByEvent="true") is not yet supported — planned for milestone M5-L4.`, id, "subProcess");
    continue;
  }
  if (el.loopCharacteristics != null) {
    err(`Subprocess '${id ?? "(no id)"}' has loop or multi-instance characteristics — multiInstance is planned for milestone M5-L3.`, id, "subProcess");
    continue;
  }
  nodes.push({ id: id ?? "", type: "subProcess", name: (el.name as string) ?? undefined, scopeId });
  classifyContainer(el, id ?? "", "subProcess", scopeId, depth + 1);
  continue;
}
if ($type === "bpmn:AdHocSubProcess") {
  err(`Ad-hoc subprocess '${id ?? "(no id)"}' is not supported in this profile (no planned support).`, id, "subProcess");
  continue;
}
```

(c) **Per-scope structural checks** (:849–:873): the `where` label gains the subProcess case:

```ts
const where = kind === "transaction" ? `transaction '${sid}'` : kind === "subProcess" ? `subprocess '${sid}'` : "the process";
```

The existing one-none-start / ≥1-none-end / cancel-end-only-in-transaction / linearity checks then apply to subProcess scopes with no further change (the cancel-end check keys on `kind !== "transaction"`, which now correctly rejects a cancel end whose *immediate* scope is a subProcess — spec §6).

(d) **Graph assembly** (inside `buildGraph`, after the `transactions` block :1571–:1589):

```ts
// M5-L1: the static scope map (spec §2) + the flat compensation wiring (spec §3.3).
const scopeMetas: Record<string, ScopeMeta> = {};
for (const s of scopes) {
  if (s.kind === "process") continue;
  const inner = nodes.find((n) => n.scopeId === s.id && n.type === "startEvent");
  scopeMetas[s.id] = {
    id: s.id,
    kind: s.kind,
    parentId: scopeParent.get(s.id) === processId ? null : (scopeParent.get(s.id) ?? null),
    depth: scopeDepth.get(s.id) ?? 1,
    startId: inner?.id ?? "",
  };
}
// ...and on the returned object:
//   scopes: scopeMetas,
//   compensations: Object.fromEntries(compensationOf),
```

Also update the reachability error message (:1473) to cover subprocess scopes: replace the ternary with `sid === processId ? "the process" : \`scope '${sid}'\``.

- [ ] **Step 5: Run to verify pass, then the full validator + docs guard**

Run: `npx vitest run tests/unit/bpmn-validator.test.ts && npm run check:docs && npm run typecheck`
Expected: PASS (existing validator tests untouched — subProcess acceptance is additive).

- [ ] **Step 6: Commit**

```bash
git add src/bpmn/validator.ts src/runtime/engine.ts scripts/check-docs.mjs tests/unit/bpmn-validator.test.ts
git commit -m "feat(m5-l1): validator accepts embedded subProcess; scope map compilation + MAX_SCOPE_DEPTH publish gate"
```

---

### Task 4: Ledger — `committedLocal`, root-relative cursor, global `seq`

**Files:**
- Modify: `src/persistence/saga.ts`
- Test: `tests/integration/saga-subtree-cursor.test.ts` (new)

**Interfaces:**
- Consumes: nothing new (pure persistence layer; scope-id lists are plain `string[]` params).
- Produces:

```ts
export type CompensationStatus = "pending" | "notRequired" | "compensating" | "compensated" | "failed" | "committed" | "committedLocal";
export function markScopeStepsCommittedStmt(db, input: { instanceId: string; scopeIds: string[]; seal: boolean; now: string }): D1PreparedStatement;
export async function selectSubtreeStepsForCompensation(db, instanceId: string, subtreeScopeIds: string[], eligibleCommittedLocalScopeIds: string[]): Promise<SagaStepView[]>;
export async function countCompensableSteps(db, instanceId: string, subtreeScopeIds: string[], eligibleCommittedLocalScopeIds: string[]): Promise<number>;
// selectScopeStepsForCompensation / countPendingSteps: DELETED (all call sites move — Tasks 7–8)
// insertSagaStepStmt: seq becomes per-INSTANCE monotonic
```

- [ ] **Step 1: Write the failing eligibility-matrix test**

Create `tests/integration/saga-subtree-cursor.test.ts` — seeds `saga_steps` rows directly through `env.DB` and asserts the cursor against every row of the spec §3.4 case table:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { countCompensableSteps, insertSagaStepStmt, markScopeStepsCommittedStmt, selectSubtreeStepsForCompensation } from "../../src/persistence/saga";

const INST = "inst_cursor_test";

async function seed(stepId: string, scopeId: string, status: string, elementId: string, occurrence = 0) {
  await insertSagaStepStmt(env.DB, {
    stepId, instanceId: INST, scopeId, elementId, forwardJobId: `j_${stepId}`,
    capturedInput: {}, capturedOutput: null, compensationElementId: "h", compensationTaskType: "undo",
    compensationStatus: "pending", occurrence, now: new Date().toISOString(),
  }).run();
  if (status !== "pending") {
    await env.DB.prepare(`UPDATE saga_steps SET compensation_status = ? WHERE step_id = ?`).bind(status, stepId).run();
  }
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM saga_steps WHERE instance_id = ?`).bind(INST).run();
});

// Scope tree used throughout: O(tx) > S(sub) > T(tx); process root = null-root lists.
const SUBTREE_O = ["O", "S", "T"];
const SUBTREE_T = ["T"];
const ELIGIBLE_FOR_O = ["T"];      // nearestTx(T)=T, O strictly above T
const ELIGIBLE_FOR_T: string[] = []; // self: strictAncestor(T,T)=false
const ALL = ["O", "S", "T"];
const ELIGIBLE_FOR_ROOT = ["O", "S", "T"]; // process root strictly above every tx

describe("root-relative subtree cursor (spec §3.4)", () => {
  it("outer cancel reaches a committed inner tx's rows in global reverse order", async () => {
    await seed("st1", "O", "pending", "a");            // seq 1
    await seed("st2", "T", "committedLocal", "b");     // seq 2
    await seed("st3", "O", "pending", "c");            // seq 3
    const steps = await selectSubtreeStepsForCompensation(env.DB, INST, SUBTREE_O, ELIGIBLE_FOR_O);
    expect(steps.map((s) => s.stepId)).toEqual(["st3", "st2", "st1"]); // global seq DESC across scopes
  });
  it("self re-entry shield: root T never re-selects T-committed rows (any occurrence)", async () => {
    await seed("st1", "T", "committedLocal", "a", 0);
    await seed("st2", "T", "pending", "a", 1);
    const steps = await selectSubtreeStepsForCompensation(env.DB, INST, SUBTREE_T, ELIGIBLE_FOR_T);
    expect(steps.map((s) => s.stepId)).toEqual(["st2"]);
  });
  it("process-root (/cancel) takes every committedLocal but NEVER sealed committed", async () => {
    await seed("st1", "T", "committedLocal", "a");
    await seed("st2", "O", "committed", "b");   // sealed at an outermost commit
    await seed("st3", "S", "pending", "c");
    const steps = await selectSubtreeStepsForCompensation(env.DB, INST, ALL, ELIGIBLE_FOR_ROOT);
    expect(steps.map((s) => s.stepId).sort()).toEqual(["st1", "st3"]);
    expect(await countCompensableSteps(env.DB, INST, ALL, ELIGIBLE_FOR_ROOT)).toBe(2);
  });
  it("notRequired is never selected; failed is", async () => {
    await seed("st1", "O", "notRequired", "a");
    await seed("st2", "O", "failed", "b");
    const steps = await selectSubtreeStepsForCompensation(env.DB, INST, SUBTREE_O, ELIGIBLE_FOR_O);
    expect(steps.map((s) => s.stepId)).toEqual(["st2"]);
  });
  it("markScopeStepsCommittedStmt: nested (seal=false) flips owned pending → committedLocal; seal=true also lifts committedLocal → committed", async () => {
    await seed("st1", "T", "pending", "a");
    await seed("st2", "S", "pending", "b");
    await markScopeStepsCommittedStmt(env.DB, { instanceId: INST, scopeIds: ["T"], seal: false, now: new Date().toISOString() }).run();
    let rows = (await env.DB.prepare(`SELECT step_id, compensation_status s FROM saga_steps WHERE instance_id = ? ORDER BY step_id`).bind(INST).all<{ step_id: string; s: string }>()).results!;
    expect(rows).toEqual([{ step_id: "st1", s: "committedLocal" }, { step_id: "st2", s: "pending" }]);
    await markScopeStepsCommittedStmt(env.DB, { instanceId: INST, scopeIds: ["O", "S", "T"], seal: true, now: new Date().toISOString() }).run();
    rows = (await env.DB.prepare(`SELECT step_id, compensation_status s FROM saga_steps WHERE instance_id = ? ORDER BY step_id`).bind(INST).all<{ step_id: string; s: string }>()).results!;
    expect(rows).toEqual([{ step_id: "st1", s: "committed" }, { step_id: "st2", s: "committed" }]);
  });
  it("seq is per-instance global across scopes", async () => {
    await seed("st1", "O", "pending", "a");
    await seed("st2", "T", "pending", "b");
    const rows = (await env.DB.prepare(`SELECT step_id, seq FROM saga_steps WHERE instance_id = ? ORDER BY seq`).bind(INST).all<{ step_id: string; seq: number }>()).results!;
    expect(rows).toEqual([{ step_id: "st1", seq: 1 }, { step_id: "st2", seq: 2 }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/saga-subtree-cursor.test.ts`
Expected: FAIL — `selectSubtreeStepsForCompensation` etc. not exported; seq per-scope (`st2` would get seq 1).

- [ ] **Step 3: Implement in `src/persistence/saga.ts`**

(a) Status union — replace the `committed` comment block (:11-19):

```ts
export type CompensationStatus =
  | "pending"
  | "notRequired"
  | "compensating"
  | "compensated"
  | "failed"
  // Non-terminal local commit (M5-L1 spec §3.2): a NESTED transaction committed.
  // Shielded from its own scope's re-compensation (incl. later occurrences), but
  // still eligible for compensation roots STRICTLY ABOVE its committing tx.
  | "committedLocal"
  // Terminal/sealed: the OUTERMOST enclosing transaction committed.
  | "committed";
```

(b) Global seq — in `insertSagaStepStmt` (:153) change the subquery (drop the scope conjunct and its bind):

```sql
COALESCE((SELECT MAX(seq) FROM saga_steps WHERE instance_id = ?), 0) + 1,
```

(remove the second `input.scopeId` from the params array; keep the row's `scope_id` column bind).

(c) `IN`-list helper + the cursor (replace `selectScopeStepsForCompensation` :182-196 wholesale):

```ts
const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/**
 * Root-relative reverse cursor (M5-L1 spec §3.4). Callers precompute the two
 * scope-id lists from the compiled graph (scope-tree.ts); SQL never walks the
 * hierarchy. Global per-instance `seq DESC` = reverse chronology across nested
 * scopes (bottom-up falls out for free).
 */
export async function selectSubtreeStepsForCompensation(
  db: D1Database,
  instanceId: string,
  subtreeScopeIds: string[],
  eligibleCommittedLocalScopeIds: string[],
): Promise<SagaStepView[]> {
  if (subtreeScopeIds.length === 0) return [];
  const elig = eligibleCommittedLocalScopeIds;
  const rows = await dbAll<SagaStepRow>(
    db,
    `SELECT * FROM saga_steps
       WHERE instance_id = ?
         AND scope_id IN (${placeholders(subtreeScopeIds.length)})
         AND ( compensation_status IN ('pending', 'compensating', 'failed')
            ${elig.length > 0 ? `OR (compensation_status = 'committedLocal' AND scope_id IN (${placeholders(elig.length)}))` : ""} )
       ORDER BY seq DESC`,
    [instanceId, ...subtreeScopeIds, ...elig],
  );
  return rows.map(mapSagaStep);
}

/** Root-relative compensable count (drives the operator-cancel empty-ledger branch). */
export async function countCompensableSteps(
  db: D1Database,
  instanceId: string,
  subtreeScopeIds: string[],
  eligibleCommittedLocalScopeIds: string[],
): Promise<number> {
  return (await selectSubtreeStepsForCompensation(db, instanceId, subtreeScopeIds, eligibleCommittedLocalScopeIds)).length;
}
```

Delete `countPendingSteps` (its only call site, `src/index.ts:466`, moves in Task 8 — leave the build temporarily broken only if doing Tasks 4+8 out of order; otherwise keep `countPendingSteps` in place until Task 8 and delete it there. **Do the latter: keep it for now.**)

(d) `markScopeStepsCommittedStmt` (:282-292) — replace:

```ts
/**
 * Transaction-commit ledger flip (M5-L1 spec §3.2).
 *   seal=false (NESTED commit): owned scopes' pending|compensating → 'committedLocal'.
 *   seal=true  (OUTERMOST commit): subtree's pending|compensating|committedLocal → 'committed' (terminal).
 * For a top-level single-scope transaction seal=true reduces byte-for-byte to the
 * pre-M5 statement (the M1–M4 no-op fast path).
 */
export function markScopeStepsCommittedStmt(
  db: D1Database,
  input: { instanceId: string; scopeIds: string[]; seal: boolean; now: string },
): D1PreparedStatement {
  const from = input.seal ? `('pending', 'compensating', 'committedLocal')` : `('pending', 'compensating')`;
  return stmt(
    db,
    `UPDATE saga_steps SET compensation_status = '${input.seal ? "committed" : "committedLocal"}', updated_at = ?
       WHERE instance_id = ? AND scope_id IN (${placeholders(input.scopeIds.length)}) AND compensation_status IN ${from}`,
    [input.now, input.instanceId, ...input.scopeIds],
  );
}
```

Temporarily fix the two existing call sites to the new signature with single-scope lists so the build stays green: `src/runtime/engine.ts:672` → `markScopeStepsCommittedStmt(env.DB, { instanceId, scopeIds: [txId], seal: true, now })` (Task 7 replaces this with the real two-tier logic).

(e) `getFailedStep` (:242-249): status filter unchanged (`'failed'` only) — no edit.

- [ ] **Step 4: Run to verify pass + the no-op gate for touched suites**

Run: `npx vitest run tests/integration/saga-subtree-cursor.test.ts tests/integration/saga-orchestration.test.ts tests/integration/loop-compensation.test.ts && npm run typecheck`
Expected: PASS (single-scope: global seq ≡ per-scope seq; seal=true single-scope ≡ old statement).

- [ ] **Step 5: Commit**

```bash
git add src/persistence/saga.ts src/runtime/engine.ts tests/integration/saga-subtree-cursor.test.ts
git commit -m "feat(m5-l1): saga ledger — committedLocal status, root-relative subtree cursor, per-instance global seq"
```

---

### Task 5: Engine — the subProcess walk (enter/exit, fast-forward)

**Files:**
- Modify: `src/runtime/engine.ts` (`driveLeaf` :325-424, bookkeeping fns after :662)
- Modify: `src/runtime/engine-shared.ts` (scope-kind helper)
- Modify: `tests/helpers.ts` (new fixture)
- Test: `tests/integration/subprocess-walk.test.ts` (new)

**Interfaces:**
- Consumes: `scopesOf` (Task 2), validator output (Task 3).
- Produces: `driveLeaf` handles `node.type === "subProcess"`; history events `scopeEntered` / `scopeExited` (diagnostics: `{ scope, kind, occurrence }`); step names `scope:${el}#${occ}` / `scope-end:${el}#${occ}`. Helper `scopeKindOf(graph, scopeId): ScopeKind | null` in `engine-shared.ts`.

- [ ] **Step 1: Add the fixture to `tests/helpers.ts`**

```ts
/** M5-L1: linear flow through a plain embedded subProcess (one service task inside). */
export const SUBPROC_LINEAR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="def_subproc" targetNamespace="http://example.com">
  <bpmn:process id="proc_subproc" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="sub"/>
    <bpmn:subProcess id="sub" name="Stage">
      <bpmn:startEvent id="s_start"/>
      <bpmn:sequenceFlow id="sf1" sourceRef="s_start" targetRef="s_task"/>
      <bpmn:serviceTask id="s_task" name="Work"><bpmn:extensionElements><easy-bpmn:taskDefinition type="doWork" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="sf2" sourceRef="s_task" targetRef="s_end"/>
      <bpmn:endEvent id="s_end"/>
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="f2" sourceRef="sub" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;
```

- [ ] **Step 2: Write the failing test**

Create `tests/integration/subprocess-walk.test.ts` (copy the harness imports from `tests/integration/loop-compensation.test.ts`):

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SUBPROC_LINEAR_BPMN, leaseAndComplete, mintWorkerToken, publishAndStart } from "../helpers";

describe("M5-L1 subProcess walk", () => {
  it("walks Start → subProcess(start→task→end) → End; scope markers in history", async () => {
    const { instanceId } = await publishAndStart(SUBPROC_LINEAR_BPMN);
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "doWork", { done: true });
    const inst = await env.DB.prepare(`SELECT status FROM process_instances WHERE instance_id = ?`).bind(instanceId).first<{ status: string }>();
    expect(inst!.status).toBe("completed");
    const hist = (await env.DB.prepare(`SELECT type, element_id FROM history_events WHERE instance_id = ? ORDER BY rowid`).bind(instanceId).all<{ type: string; element_id: string }>()).results!;
    expect(hist.some((h) => h.type === "scopeEntered" && h.element_id === "sub")).toBe(true);
    expect(hist.some((h) => h.type === "scopeExited" && h.element_id === "sub")).toBe(true);
    // scopeExited lands after the inner task completed
    const exitIdx = hist.findIndex((h) => h.type === "scopeExited");
    const taskIdx = hist.findIndex((h) => h.type === "serviceTaskCompleted");
    expect(exitIdx).toBeGreaterThan(taskIdx);
  });
});
```

Adjust helper call signatures to the file's actual exports (`publishAndStart(xml)` — check `tests/helpers.ts:238` for the exact parameters; `leaseAndComplete` may need the task type and instance filter as used in neighboring tests). The table/history column names above match existing tests' queries — verify against one neighboring test and mirror it exactly.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/integration/subprocess-walk.test.ts`
Expected: FAIL — `driveLeaf` reaches the `non-token:` fail-loud branch for the `subProcess` node (unknown type).

- [ ] **Step 4: Implement the walk**

(a) `src/runtime/engine-shared.ts` — beside `isTransactionScope` (:37-39):

```ts
import { scopesOf } from "../bpmn/scope-tree";
/** Kind of the given scope id, or null at process level. Legacy graphs resolve transactions only. */
export function scopeKindOf(graph: ExecutionGraph, scopeId: string | null | undefined): "transaction" | "subProcess" | null {
  if (!scopeId) return null;
  const kind = scopesOf(graph)[scopeId]?.kind;
  return kind === "transaction" || kind === "subProcess" ? kind : graph.nodes[scopeId]?.type === "transaction" ? "transaction" : null;
}
```

(b) `driveLeaf` — extend the transaction branch (:337-341):

```ts
if (node.type === "transaction" || node.type === "subProcess") {
  const meta = scopesOf(graph)[cur];
  const innerStart = meta?.startId || graph.transactions?.[cur]?.startId;
  if (!innerStart) return { kind: "completed" }; // malformed (validator guards this)
  if (node.type === "transaction") {
    return { kind: "next", next: await runStep(`tx:${tag}`, () => enterTransaction(env, instanceId, cur, occ, innerStart)) };
  }
  return { kind: "next", next: await runStep(`scope:${tag}`, () => enterScope(env, instanceId, cur, occ, innerStart)) };
}
```

(c) endEvent branch (:405-424) — insert the subProcess-exit case BEFORE the process-level fallthrough (order: cancel-end → tx-commit → **subProcess-exit** → process end):

```ts
if (scopeKindOf(graph, node.scopeId) === "subProcess") {
  // Inner none end of a subProcess → bookkeeping exit; NO ledger mutation (spec §2).
  return { kind: "next", next: await runStep(`scope-end:${tag}`, () => exitScope(env, instanceId, graph, node.scopeId!, cur, occ)) };
}
```

(The two `isTransactionScope(graph, node.scopeId)` checks above it stay as-is — they gate on the *immediate* scope being a transaction, which remains correct under nesting.)

(d) The bookkeeping fns, after `commitTransaction` (:679) — the exact `enterTransaction` pattern:

```ts
async function enterScope(env: Env, instanceId: string, scopeId: string, occ: number, innerStart: string): Promise<string> {
  if (await visitApplied(env, instanceId, scopeId, occ, "scopeEntered")) return innerStart; // write-free rewalk
  const inst = await loadInst(env, instanceId);
  await dbBatch(env.DB, [
    // MARKER: visitApplied(...) fast-forwards on the EXISTENCE of this occurrence's marker — exactly one per visit, atomic with the transition; do not add/remove/conditionalize.
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: scopeId, type: "scopeEntered", diagnostics: { scope: scopeId, kind: "subProcess", occurrence: occ } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: innerStart, status: "running", now: nowIso() }),
  ]);
  return innerStart;
}

async function exitScope(env: Env, instanceId: string, graph: ExecutionGraph, scopeId: string, endElementId: string, occ: number): Promise<string> {
  const outer = graph.nodes[scopeId]?.next ?? null;
  if (await visitApplied(env, instanceId, endElementId, occ, "elementEntered")) return outer ?? endElementId; // write-free rewalk
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  await dbBatch(env.DB, [
    // MARKER: visitApplied(...) fast-forwards on the EXISTENCE of this occurrence's marker — exactly one per visit, atomic with the transition; do not add/remove/conditionalize.
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: endElementId, type: "elementEntered", diagnostics: { elementType: "endEvent", endKind: "none", scope: scopeId, occurrence: occ } }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: scopeId, type: "scopeExited", diagnostics: { scope: scopeId, occurrence: occ } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: outer ?? endElementId, status: "running", now }),
  ]);
  return outer ?? endElementId;
}
```

Also update `enterStart` (:635): its in-scope branch keys on `isTransactionScope` — widen to any scope: `if (scopeKindOf(graph, node.scopeId) != null) { ... }` so a subProcess inner start also takes the plain `elementEntered` path (not `instanceStarted`).

- [ ] **Step 5: Run to verify pass + no-op gate slice**

Run: `npx vitest run tests/integration/subprocess-walk.test.ts tests/integration/demo-flow.test.ts tests/integration/saga-orchestration.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/engine.ts src/runtime/engine-shared.ts tests/helpers.ts tests/integration/subprocess-walk.test.ts
git commit -m "feat(m5-l1): engine walks embedded subProcess scopes (enter/exit bookkeeping, occurrence fast-forward)"
```

---

### Task 6: Ledger-write gate — ancestry test + flat wiring lookup

**Files:**
- Modify: `src/runtime/forward-task.ts` (:459-484)
- Modify: `src/runtime/compensation.ts` (`ledgerStragglers` wiring lookup :199-200 — same change, kept compiling)
- Modify: `tests/helpers.ts` (fixture)
- Test: `tests/integration/nested-ledger.test.ts` (new)

**Interfaces:**
- Consumes: `nearestEnclosingTx` (Task 2), `graph.compensations` (Task 3).
- Produces: ledger rows for steps whose *immediate* scope is a subProcess (with `scope_id` = the immediate scope id) whenever a transaction ancestor exists; no rows without one.

- [ ] **Step 1: Add the fixture — a transaction containing a subProcess with a compensable task**

Append to `tests/helpers.ts`:

```ts
/**
 * M5-L1 gate fixture: outer tx O > subProcess S > compensable task A (handler undoA),
 * then task B (compensable, in O), then a "trip" task with an error boundary routing
 * to O's cancel end. Cancel boundary on O routes to a process-level end.
 */
export const NESTED_TX_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="def_nested" targetNamespace="http://example.com">
  <bpmn:process id="proc_nested" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="O"/>
    <bpmn:transaction id="O">
      <bpmn:startEvent id="o_start"/>
      <bpmn:sequenceFlow id="of1" sourceRef="o_start" targetRef="S"/>
      <bpmn:subProcess id="S">
        <bpmn:startEvent id="s_start"/>
        <bpmn:sequenceFlow id="sf1" sourceRef="s_start" targetRef="A"/>
        <bpmn:serviceTask id="A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="stepA" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
        <bpmn:boundaryEvent id="A_comp" attachedToRef="A"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
        <bpmn:serviceTask id="undoA" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="undoA" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
        <bpmn:association id="assocA" sourceRef="A_comp" targetRef="undoA"/>
        <bpmn:sequenceFlow id="sf2" sourceRef="A" targetRef="s_end"/>
        <bpmn:endEvent id="s_end"/>
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="of2" sourceRef="S" targetRef="B"/>
      <bpmn:serviceTask id="B"><bpmn:extensionElements><easy-bpmn:taskDefinition type="stepB" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:boundaryEvent id="B_comp" attachedToRef="B"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="undoB" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="undoB" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:association id="assocB" sourceRef="B_comp" targetRef="undoB"/>
      <bpmn:sequenceFlow id="of3" sourceRef="B" targetRef="trip"/>
      <bpmn:serviceTask id="trip"><bpmn:extensionElements><easy-bpmn:taskDefinition type="trip" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:boundaryEvent id="trip_err" attachedToRef="trip"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>
      <bpmn:sequenceFlow id="of4" sourceRef="trip_err" targetRef="o_cancel"/>
      <bpmn:endEvent id="o_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      <bpmn:sequenceFlow id="of5" sourceRef="trip" targetRef="o_end"/>
      <bpmn:endEvent id="o_end"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="O_cancel" attachedToRef="O"><bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="O_cancel" targetRef="failed_end"/>
    <bpmn:endEvent id="failed_end"/>
    <bpmn:sequenceFlow id="f3" sourceRef="O" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;
```

**Prerequisite note:** the handler-in-transaction validator guard (`validator.ts:1432-1439`) currently keys on the *immediate* scope — `undoA` (immediate scope `S`, a subProcess) would be rejected. Fix it in this task (it is the guard this fixture exercises):

```ts
// Compensation wiring is legal iff SOME ancestor scope is a transaction (spec §6, ancestry check).
for (const n of nodes) {
  if (!isHandler(n)) continue;
  let inTx = false;
  for (let s: string | null | undefined = n.scopeId; s != null && s !== processId; s = scopeParent.get(s) ?? null) {
    if (scopeKindOf.get(s) === "transaction") { inTx = true; break; }
  }
  if (!inTx) {
    err(
      `Service task '${n.id}' is isForCompensation but no enclosing scope is a <transaction> — the handler has no trigger (no Cancel can reach it).`,
      n.id,
      "serviceTask",
    );
  }
}
```

(`scopeKindOf` here is the validator-local map at :847, not the engine helper.) Add the reject pair to `tests/unit/bpmn-validator.test.ts`: a compensation boundary + handler inside a subProcess with **no** transaction ancestor → reject with the message above; the same inside `NESTED_TX_BPMN`'s `S` → accept.

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/nested-ledger.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NESTED_TX_BPMN, leaseAndComplete, mintWorkerToken, publishAndStart } from "../helpers";

describe("M5-L1 ledger-write gate (spec §3.3)", () => {
  it("a completed task inside tx > subProcess is ledgered with scope_id = the subProcess", async () => {
    const { instanceId } = await publishAndStart(NESTED_TX_BPMN);
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "stepA", { a: 1 });
    const row = await env.DB.prepare(
      `SELECT scope_id, compensation_status, compensation_element_id FROM saga_steps WHERE instance_id = ? AND element_id = 'A'`,
    ).bind(instanceId).first<{ scope_id: string; compensation_status: string; compensation_element_id: string }>();
    expect(row).toEqual({ scope_id: "S", compensation_status: "pending", compensation_element_id: "undoA" });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/integration/nested-ledger.test.ts`
Expected: FAIL — no `saga_steps` row for `A` (the gate at `forward-task.ts:460` sees immediate scope `S`, not a transaction).

- [ ] **Step 4: Implement the gate**

`src/runtime/forward-task.ts:459-484` — replace the gate and the wiring lookup:

```ts
// Ledger write atomic with advance — for completed compensatable steps with a
// TRANSACTION ANCESTOR (M5-L1 spec §3.3: the gate is ancestry, not the immediate
// scope). scope_id stays the IMMEDIATE scope id — the subtree cursor depends on it.
if (nearestEnclosingTx(graph, node.scopeId ?? null) != null) {
  const wiring = graph.compensations?.[elementId] ?? graph.transactions?.[node.scopeId!]?.compensations?.[elementId];
  // ... unchanged insertSagaStepStmt block, scopeId: node.scopeId! ...
}
```

Add the import `import { nearestEnclosingTx } from "../bpmn/scope-tree";`. Apply the same wiring-lookup change in `ledgerStragglers` (`compensation.ts:199`): `const wiring = graph.compensations?.[t.position_element_id] ?? graph.transactions?.[scopeId]?.compensations?.[t.position_element_id];` and its `scopeId:` insert param becomes `graph.nodes[t.position_element_id]?.scopeId ?? scopeId` (the row carries the straggler's IMMEDIATE scope).

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/integration/nested-ledger.test.ts tests/unit/bpmn-validator.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/forward-task.ts src/runtime/compensation.ts src/bpmn/validator.ts tests/helpers.ts tests/integration/nested-ledger.test.ts tests/unit/bpmn-validator.test.ts
git commit -m "feat(m5-l1): ledger-write gate is transaction-ancestry; flat compensation wiring; handler ancestry validator rule"
```

---### Task 7: Commit shield — two-tier commit in `commitTransaction`

**Files:**
- Modify: `src/runtime/engine.ts` (`commitTransaction` :664-679)
- Test: extend `tests/integration/nested-ledger.test.ts`

**Interfaces:**
- Consumes: `markScopeStepsCommittedStmt` (Task 4), `ownedScopeIds` / `subtreeScopeIds` / `nearestEnclosingTx` / `scopesOf` (Task 2).
- Produces: nested commit → `committedLocal` over `ownedScopeIds(tx)`; outermost commit → sealed `committed` over `subtreeScopeIds(tx)`.

- [ ] **Step 1: Write the failing tests** (extend `tests/integration/nested-ledger.test.ts`)

Add a second fixture to `tests/helpers.ts` — **inner tx commits, outer continues** (used again in Task 8):

```ts
/**
 * M5-L1 commit-shield fixture: outer tx O > subProcess S > inner tx T (compensable
 * task A/undoA; T always COMMITS) > then compensable task B in O > "trip" task with
 * error boundary → O's cancel end. Cancel boundary on O → failed_end.
 */
export const NESTED_COMMIT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="def_nested_commit" targetNamespace="http://example.com">
  <bpmn:process id="proc_nested_commit" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="O"/>
    <bpmn:transaction id="O">
      <bpmn:startEvent id="o_start"/>
      <bpmn:sequenceFlow id="of1" sourceRef="o_start" targetRef="S"/>
      <bpmn:subProcess id="S">
        <bpmn:startEvent id="s_start"/>
        <bpmn:sequenceFlow id="sf1" sourceRef="s_start" targetRef="T"/>
        <bpmn:transaction id="T">
          <bpmn:startEvent id="t_start"/>
          <bpmn:sequenceFlow id="tf1" sourceRef="t_start" targetRef="A"/>
          <bpmn:serviceTask id="A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="stepA" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
          <bpmn:boundaryEvent id="A_comp" attachedToRef="A"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
          <bpmn:serviceTask id="undoA" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="undoA" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
          <bpmn:association id="assocA" sourceRef="A_comp" targetRef="undoA"/>
          <bpmn:sequenceFlow id="tf2" sourceRef="A" targetRef="t_end"/>
          <bpmn:endEvent id="t_end"/>
        </bpmn:transaction>
        <bpmn:sequenceFlow id="sf2" sourceRef="T" targetRef="s_end"/>
        <bpmn:endEvent id="s_end"/>
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="of2" sourceRef="S" targetRef="B"/>
      <bpmn:serviceTask id="B"><bpmn:extensionElements><easy-bpmn:taskDefinition type="stepB" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:boundaryEvent id="B_comp" attachedToRef="B"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="undoB" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="undoB" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:association id="assocB" sourceRef="B_comp" targetRef="undoB"/>
      <bpmn:sequenceFlow id="of3" sourceRef="B" targetRef="trip"/>
      <bpmn:serviceTask id="trip"><bpmn:extensionElements><easy-bpmn:taskDefinition type="trip" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:boundaryEvent id="trip_err" attachedToRef="trip"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>
      <bpmn:sequenceFlow id="of4" sourceRef="trip_err" targetRef="o_cancel"/>
      <bpmn:endEvent id="o_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      <bpmn:sequenceFlow id="of5" sourceRef="trip" targetRef="o_end"/>
      <bpmn:endEvent id="o_end"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="O_cancel" attachedToRef="O"><bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="O_cancel" targetRef="failed_end"/>
    <bpmn:endEvent id="failed_end"/>
    <bpmn:sequenceFlow id="f3" sourceRef="O" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;
```

```ts
it("nested tx commit writes committedLocal over its owned scopes only", async () => {
  const { instanceId } = await publishAndStart(NESTED_COMMIT_BPMN);
  const token = await mintWorkerToken();
  await leaseAndComplete(token, "stepA", {});   // completes A → T commits
  const a = await env.DB.prepare(`SELECT compensation_status s FROM saga_steps WHERE instance_id = ? AND element_id = 'A'`).bind(instanceId).first<{ s: string }>();
  expect(a!.s).toBe("committedLocal"); // NOT terminal 'committed'
});

it("outermost commit seals the whole subtree to committed", async () => {
  const { instanceId } = await publishAndStart(NESTED_COMMIT_BPMN);
  const token = await mintWorkerToken();
  await leaseAndComplete(token, "stepA", {});
  await leaseAndComplete(token, "stepB", {});
  await leaseAndComplete(token, "trip", {});    // trip SUCCEEDS → O commits
  const rows = (await env.DB.prepare(`SELECT element_id, compensation_status s FROM saga_steps WHERE instance_id = ? ORDER BY element_id`).bind(instanceId).all<{ element_id: string; s: string }>()).results!;
  // trip has no compensation boundary → its row stays notRequired (never flipped).
  expect(rows).toEqual([{ element_id: "A", s: "committed" }, { element_id: "B", s: "committed" }, { element_id: "trip", s: "notRequired" }]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/nested-ledger.test.ts`
Expected: FAIL — Task 4's temporary shim seals `[txId]` unconditionally: `A` reads `committed` after T's commit.

- [ ] **Step 3: Implement the two-tier flip** (`commitTransaction`, `engine.ts:664-679`)

```ts
async function commitTransaction(env: Env, instanceId: string, graph: ExecutionGraph, txId: string, endElementId: string, occ: number): Promise<string> {
  const txNode = graph.nodes[txId];
  const outer = txNode?.next ?? null;
  if (await visitApplied(env, instanceId, endElementId, occ, "elementEntered")) return outer ?? endElementId; // write-free rewalk
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  // M5-L1 commit shield (spec §3.2): a NESTED tx (some enclosing tx above it) flips
  // only its OWNED scopes to non-terminal committedLocal; the OUTERMOST commit seals
  // its whole subtree to terminal 'committed'.
  const parentScope = scopesOf(graph)[txId]?.parentId ?? null;
  const enclosingTx = nearestEnclosingTx(graph, parentScope);
  const flip = enclosingTx != null
    ? markScopeStepsCommittedStmt(env.DB, { instanceId, scopeIds: ownedScopeIds(graph, txId), seal: false, now })
    : markScopeStepsCommittedStmt(env.DB, { instanceId, scopeIds: subtreeScopeIds(graph, txId), seal: true, now });
  await dbBatch(env.DB, [
    flip,
    // MARKER: (unchanged comment)
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: endElementId, type: "elementEntered", diagnostics: { elementType: "endEvent", endKind: "none", scope: txId, occurrence: occ } }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: txId, type: "transactionCommitted", diagnostics: { transaction: txId, sealed: enclosingTx == null } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: outer ?? endElementId, status: "running", now }),
  ]);
  return outer ?? endElementId;
}
```

Imports: `import { nearestEnclosingTx, ownedScopeIds, scopesOf, subtreeScopeIds } from "../bpmn/scope-tree";`.

- [ ] **Step 4: Run to verify pass + single-scope no-op slice**

Run: `npx vitest run tests/integration/nested-ledger.test.ts tests/integration/saga-orchestration.test.ts && npm run typecheck`
Expected: PASS (top-level tx: `enclosingTx == null` → seal over `[txId]` ≡ old behavior).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/engine.ts tests/helpers.ts tests/integration/nested-ledger.test.ts
git commit -m "feat(m5-l1): two-tier commit shield — nested committedLocal, outermost seal"
```

---

### Task 8: Compensation runtime — root-relative reverse pass, un-gated barrier, nested-cancel resume, operator /cancel

This is the layer's core runtime task (spec §3.4, §4). It changes `compensation.ts`, the engine's compensate/resume paths, and the operator `/cancel` handler, and lands the main exit gates.

**Files:**
- Modify: `src/runtime/compensation.ts`
- Modify: `src/runtime/engine.ts` (:231-235 resume, :527, :546, cancel-end fast-forward in `driveLeaf`)
- Modify: `src/index.ts` (:466-501 operator cancel)
- Modify: `src/runtime/engine-shared.ts` (`DriveResult` union, if needed)
- Test: `tests/integration/nested-compensation.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 2, 4, 6, 7.
- Produces:

```ts
// compensation.ts — root is now string | null (null = the process root / operator cancel)
export async function beginCompensating(env, instanceId, scopeId: string, cancelEndId: string, occ: number): Promise<void>;
export async function settleAfterCompensation(env, instanceId, graph, rootScopeId: string | null, runStep, waitFor): Promise<DriveResult | { status: "continue"; next: string }>;
export async function drainScopeSubtree(env, graph, instanceId, rootScopeId: string | null): Promise<void>; // also used by Tasks 9/11
```

- [ ] **Step 1: Write the failing gate tests**

Create `tests/integration/nested-compensation.test.ts` (harness imports as in `loop-compensation.test.ts`; `leaseAndFail` / operator `post` helpers as used in `saga-operator.test.ts`):

```ts
describe("M5-L1 nested compensation (spec §3.4 / §4)", () => {
  // GATE 1 (spec §10.1): outer cancel compensates a committed inner tx, reverse order.
  it("outer-tx > subProcess > inner-tx-commits; outer cancel compensates A and B in reverse", async () => {
    const { instanceId } = await publishAndStart(NESTED_COMMIT_BPMN);
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "stepA", {});           // T commits → A committedLocal
    await leaseAndComplete(token, "stepB", {});           // B pending (scope O)
    await leaseAndFail(token, "trip", { errorCode: "BOOM", retryable: false }); // error boundary → o_cancel → O cancels
    // reverse pass: undoB first (higher global seq), then undoA
    await leaseAndComplete(token, "undoB", {});
    await leaseAndComplete(token, "undoA", {});
    const inst = await getInstanceRow(instanceId);
    expect(inst.status).toBe("compensated");
    const rows = await ledgerByElement(instanceId);
    expect(rows["A"]).toBe("compensated");
    expect(rows["B"]).toBe("compensated");
    // reverse order held: undoB's compensationStarted precedes undoA's
    const hist = await historyTypes(instanceId);
    expect(hist.filter((h) => h.type === "compensationStarted").map((h) => h.element_id)).toEqual(["B", "A"]);
  });

  // GATE 4 (spec §10.4): self re-entry shield.
  it("T committed at occ0 then cancelled at occ1: occ0 rows untouched; later outer cancel compensates both", async () => {
    const { instanceId } = await publishAndStart(RE_ENTRY_TX_BPMN, { variables: { round: 1 } });
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "stepA", {});           // T#occ0 commits → A#0 committedLocal
    await leaseAndComplete(token, "bump", { round: 2 });
    await leaseAndComplete(token, "stepA", {});           // T#occ1: A#1 pending; tgw → t_cancel
    await leaseAndComplete(token, "undoA", {});           // T's OWN reverse pass: A#1 only
    let rows = await ledgerByElementOcc(instanceId);      // Map "A#<occ>" → status
    expect(rows.get("A#1")).toBe("compensated");
    expect(rows.get("A#0")).toBe("committedLocal");       // the shield held
    // nested cancel settled non-terminally: the instance CONTINUED via T_cancel → gwm
    await leaseAndComplete(token, "bump", { round: 3 });
    await leaseAndFail(token, "trip", { errorCode: "BOOM", retryable: false }); // O cancels
    await leaseAndComplete(token, "undoA", {});           // occ0 finally compensates (root O ⊐ T)
    rows = await ledgerByElementOcc(instanceId);
    expect(rows.get("A#0")).toBe("compensated");
    expect((await getInstanceRow(instanceId)).status).toBe("compensated");
  });

  // Operator /cancel = process root: retained committedLocal rows compensate; sealed never.
  it("operator /cancel drives committedLocal (retained) rows, skips sealed committed rows", async () => {
    const { instanceId } = await publishAndStart(NESTED_COMMIT_BPMN);
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "stepA", {});   // A committedLocal
    // O still open (B not driven) → operator cancels the instance
    await authedPost(`/instances/${instanceId}/cancel`, {});
    await resumeInline(env, instanceId);
    await leaseAndComplete(token, "undoA", {});
    const rows = await ledgerByElement(instanceId);
    expect(rows["A"]).toBe("compensated");
  });
});
```

Write the small local helpers (`getInstanceRow`, `ledgerByElement`, `historyTypes`) inside the test file with plain `env.DB.prepare` queries (mirror `ledgerRows` from `loop-compensation.test.ts`). Add `RE_ENTRY_TX_BPMN` to `tests/helpers.ts` (FEEL `conditionExpression` shape as in `SAGA_LOOP_BPMN`; start the instance with `variables: { round: 1 }`; the `bump` worker's completion payload sets the next `round`):

```ts
/**
 * M5-L1 re-entry-shield fixture (gate 4): outer tx O loops through inner tx T.
 * round=1: T commits (A → committedLocal). round=2: T's inner XOR routes to its
 * cancel end → T's OWN reverse pass (occ1 only; occ0 shielded), instance continues
 * via T_cancel → merge → bump. round=3: gw default → trip fails → O cancels →
 * occ0's committedLocal row finally compensates (root O is a strict ancestor of T).
 */
export const RE_ENTRY_TX_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="def_reentry" targetNamespace="http://example.com">
  <bpmn:process id="proc_reentry" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="O"/>
    <bpmn:transaction id="O">
      <bpmn:startEvent id="o_start"/>
      <bpmn:sequenceFlow id="of1" sourceRef="o_start" targetRef="gw"/>
      <bpmn:exclusiveGateway id="gw" default="og_trip"/>
      <bpmn:sequenceFlow id="og_T" sourceRef="gw" targetRef="T"><bpmn:conditionExpression>round &lt; 3</bpmn:conditionExpression></bpmn:sequenceFlow>
      <bpmn:transaction id="T">
        <bpmn:startEvent id="t_start"/>
        <bpmn:sequenceFlow id="tf1" sourceRef="t_start" targetRef="A"/>
        <bpmn:serviceTask id="A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="stepA" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
        <bpmn:boundaryEvent id="A_comp" attachedToRef="A"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
        <bpmn:serviceTask id="undoA" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="undoA" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
        <bpmn:association id="assocA" sourceRef="A_comp" targetRef="undoA"/>
        <bpmn:sequenceFlow id="tf2" sourceRef="A" targetRef="tgw"/>
        <bpmn:exclusiveGateway id="tgw" default="tg_ok"/>
        <bpmn:sequenceFlow id="tg_cancel" sourceRef="tgw" targetRef="t_cancel"><bpmn:conditionExpression>round = 2</bpmn:conditionExpression></bpmn:sequenceFlow>
        <bpmn:endEvent id="t_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
        <bpmn:sequenceFlow id="tg_ok" sourceRef="tgw" targetRef="t_end"/>
        <bpmn:endEvent id="t_end"/>
      </bpmn:transaction>
      <bpmn:boundaryEvent id="T_cancel" attachedToRef="T"><bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
      <bpmn:sequenceFlow id="of2" sourceRef="T" targetRef="gwm"/>
      <bpmn:sequenceFlow id="of3" sourceRef="T_cancel" targetRef="gwm"/>
      <bpmn:exclusiveGateway id="gwm" default="of4"/>
      <bpmn:sequenceFlow id="of4" sourceRef="gwm" targetRef="bump"/>
      <bpmn:serviceTask id="bump"><bpmn:extensionElements><easy-bpmn:taskDefinition type="bump" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="of5" sourceRef="bump" targetRef="gw"/>
      <bpmn:sequenceFlow id="og_trip" sourceRef="gw" targetRef="trip"/>
      <bpmn:serviceTask id="trip"><bpmn:extensionElements><easy-bpmn:taskDefinition type="trip" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:boundaryEvent id="trip_err" attachedToRef="trip"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>
      <bpmn:sequenceFlow id="of6" sourceRef="trip_err" targetRef="o_cancel"/>
      <bpmn:endEvent id="o_cancel"><bpmn:cancelEventDefinition/></bpmn:endEvent>
      <bpmn:sequenceFlow id="of7" sourceRef="trip" targetRef="o_end"/>
      <bpmn:endEvent id="o_end"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="O_cancel" attachedToRef="O"><bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="O_cancel" targetRef="failed_end"/>
    <bpmn:endEvent id="failed_end"/>
    <bpmn:sequenceFlow id="f3" sourceRef="O" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;
```

(A single-outgoing XOR `gwm` merges `T`'s commit path and `T_cancel`'s continue path — the merge-through-gateway shape M2 loops already use.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/nested-compensation.test.ts`
Expected: FAIL — cursor still single-scope (`selectScopeStepsForCompensation`), nested cancel settles terminally, `/cancel` misses committedLocal.

- [ ] **Step 3: Implement `compensation.ts`**

(a) **Root-relative cursor + un-gated barrier** in `runCompensation` (:80-167). Replace the `isRegion` gating and the select:

```ts
import { eligibleCommittedLocalScopeIds, nearestEnclosingTx, scopesOf, subtreeScopeIds } from "../bpmn/scope-tree";
// signature: scopeId: string | null (null = process root)

const subtree = subtreeScopeIds(graph, scopeId);
const eligibleCommitted = eligibleCommittedLocalScopeIds(graph, scopeId);
const inSubtree = (elementId: string): boolean => {
  const s = graph.nodes[elementId]?.scopeId ?? null;
  return s == null ? scopeId == null : subtree.includes(s);
};

while (true) {
  // Straggler scan — ALWAYS on (spec §4.1 un-gates the isRegion guard), cohort =
  // subtree membership (spec §4.2). No-op fast path: zero live tokens.
  await ledgerStragglers(env, instanceId, graph, scopeId, subtree);

  const steps = await selectSubtreeStepsForCompensation(env.DB, instanceId, subtree, eligibleCommitted);
  // Barrier tokens filtered to the same subtree (spec §4.2).
  const live = (await listLiveTokens(env.DB, instanceId)).filter((t) => inSubtree(t.position_element_id));
  if (steps.length === 0) return live.length === 0 ? "compensated" : "waiting";
  // ... rest unchanged (filterLineageQuiesced, eligible[0], comp job dispatch, comp-wake)
}
```

`ledgerStragglers` (:190) — new signature `(env, instanceId, graph, rootScopeId: string | null, subtree: string[])`; the cohort test becomes:

```ts
const posScope = graph.nodes[t.position_element_id]?.scopeId ?? null;
if (posScope == null ? rootScopeId != null : !subtree.includes(posScope)) continue; // not in this cohort
```

(b) **`drainScopeSubtree`** — new export (reused by Tasks 9/11 for non-cancel scope exits):

```ts
/**
 * Phase-1 interrupt/drain of a scope subtree (spec §4.3.1 / §5.3.1): settle every
 * live token positioned in the subtree — completed forward job → ledger (retained)
 * + consume; created/locked → abandon the job (late complete no-ops) + discard;
 * failed / no job → discard. Idempotent (INSERT OR IGNORE + status-guarded flips).
 * Unlike the straggler scan this NEVER creates compensation work — retention only.
 */
export async function drainScopeSubtree(env: Env, graph: ExecutionGraph, instanceId: string, rootScopeId: string | null): Promise<void> {
  const subtree = subtreeScopeIds(graph, rootScopeId);
  const live = await listLiveTokens(env.DB, instanceId);
  for (const t of live) {
    const posScope = graph.nodes[t.position_element_id]?.scopeId ?? null;
    if (posScope == null ? rootScopeId != null : !subtree.includes(posScope)) continue;
    const now = nowIso();
    const job = await getForwardJobByElement(env.DB, instanceId, t.position_element_id);
    if (job && job.status === "completed") {
      // identical ledger-retain block to ledgerStragglers (extract a shared
      // `retainStragglerStmts(...)` helper used by both — do NOT copy-paste)
      /* ledger INSERT OR IGNORE + setTokenStatusStmt consumed */
    } else if (job && (job.status === "created" || job.status === "locked")) {
      await dbBatch(env.DB, [abandonJobOnScopeExitStmt(env.DB, job.job_id, now), setTokenStatusStmt(env.DB, t.token_id, "discarded", now)]);
    } else {
      await dbBatch(env.DB, [setTokenStatusStmt(env.DB, t.token_id, "discarded", now)]);
    }
  }
}
```

`abandonJobOnScopeExitStmt`: reuse `abandonJobOnTimerFireStmt` (`src/persistence/jobs.ts:449`, `created/locked → failed`) — import it under its existing name rather than adding a duplicate.

(c) **`beginCompensating`** (:47-60) gains `occ: number` and stamps the occurrence into the marker history row (nested fast-forward, Step 4d):

```ts
historyStmt(env.DB, { ..., type: "transactionCancelled", diagnostics: { transaction: scopeId, via: cancelEndId, traceId: traceIdFor(instanceId), occurrence: occ } }),
```

The `armCohortLeaseExpiryTerminators` call stays (subtree-wide is a superset — acceptable: it only accelerates lease expiry of in-flight jobs).

(d) **Nested settle continues the instance** — `settleAfterCompensation` (:63-76) and `settleSagaCompensated` (:294-312):

```ts
export async function settleAfterCompensation(env, instanceId, graph, rootScopeId: string | null, runStep, waitFor): Promise<DriveResult | { status: "continue"; next: string }> {
  const result = await runCompensation(env, instanceId, graph, rootScopeId, runStep, waitFor);
  if (result === "waiting") return { status: "waiting" };
  if (result === "failed") return { status: "incident" };
  const target = rootScopeId != null ? cancelBoundaryTarget(graph, rootScopeId) : null;
  // Nested root = the cancelled tx has ANY parent scope (spec §4.3 refined):
  // the instance continues on the cancel boundary's failure path after the settle.
  const isNestedRoot = rootScopeId != null && (scopesOf(graph)[rootScopeId]?.parentId ?? null) != null;
  await runStep(`settle:${rootScopeId ?? "process"}`, () => settleSagaCompensated(env, instanceId, graph, rootScopeId, target, isNestedRoot));
  return isNestedRoot && target ? { status: "continue", next: target } : { status: "completed" };
}
```

`settleSagaCompensated` branches (keep the existing terminal body for the top-level/process case verbatim; `elementId` for its history rows: `rootScopeId ?? graph.processId`):

```ts
if (isNestedRoot && failureTarget) {
  // Nested cancel-end (spec §4.3 as refined): the instance CONTINUES on the cancel
  // boundary's failure path — non-terminal settle, status back to running.
  await dbBatch(env.DB, [
    historyStmt(env.DB, { ..., elementId: scopeId!, type: "compensationCompleted", diagnostics: { transaction: scopeId, outcome: "compensated", nested: true } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: failureTarget, status: "running", now }),
  ]);
  return;
}
// ...existing terminal body (sagaFailed / compensated / incident advance) unchanged...
```

Validator prerequisite: a **nested** transaction containing a cancel end MUST carry a cancel boundary (otherwise the failure path has no target). Add to the boundary section of `validator.ts` (after the cancel-boundary host check): collect `cancelEndsByScope`; for each transaction scope with a cancel end and a non-null parent scope, require a cancel boundary attached to it — else `err("Transaction 'T' is nested and contains a cancel end event but has no cancel boundary — the instance would have no failure path to continue on.", txId, "transaction")`. Add the reject pair to the validator tests.

- [ ] **Step 4: Implement the engine + operator sides**

(a) **Walk site** (`engine.ts:527`):

```ts
if (r.kind === "compensate") {
  const settled = await settleAfterCompensation(env, instanceId, graph, r.scopeId, runStep, waitFor);
  if (settled.status === "continue") { cur = settled.next; continue; }
  return settled;
}
```

(b) **Frontier site** (:546): same shape, but `continue` re-enters the outer `while (true)` (the frontier DFS re-walks and fast-forwards through the cancelled tx via (d)):

```ts
if (result.compensate) {
  const settled = await settleAfterCompensation(env, instanceId, graph, result.compensate.scopeId, runStep, waitFor);
  if (settled.status !== "continue") return settled;
  continue;
}
```

(c) **Resume path** (:231-235) — the root becomes explicit (spec §4.3 refined; durable + replay-safe):

```ts
if (inst.status === "compensating") {
  // Root derivation: the latest transactionCancelled history row. An operator
  // cancel writes it WITHOUT an element scope (process root); a cancel-end wrote
  // elementId = the transaction id (beginCompensating).
  const root = await latestCancelRootElement(env.DB, instanceId); // string | null
  const settled = await settleAfterCompensation(env, instanceId, graph, root, opts.runStep, opts.waitFor);
  if (settled.status !== "continue") return settled;
  // nested root settled → fall through into the normal walk below
}
```

`latestCancelRootElement` (add to `src/persistence/history.ts`, following that file's query style) returns the raw `element_id | null` from `SELECT element_id FROM history_events WHERE instance_id = ? AND type = 'transactionCancelled' ORDER BY rowid DESC LIMIT 1`; the ENGINE then maps it to a root: `const root = el != null && graph.nodes[el]?.type === "transaction" ? el : null;` (persistence stays graph-free). The operator-cancel history write (`index.ts:499`) must therefore keep its `elementId` **unset** — verify `recordHistory` there passes no elementId (it does today).

(d) **Cancelled-tx fast-forward** in `driveLeaf` (transaction branch, before `enterTransaction`): a re-walk must not re-enter a nested tx whose occurrence already cancelled+settled:

```ts
if (node.type === "transaction" && (await visitApplied(env, instanceId, cur, occ, "transactionCancelled"))) {
  const target = cancelBoundaryTargetOf(graph, cur);
  if (target) return { kind: "next", next: target };
  return { kind: "completed" }; // top-level cancelled tx: terminal settle owns the instance
}
```

Export the existing private `cancelBoundaryTarget` from `compensation.ts` (rename export `cancelBoundaryTargetOf` or re-import) rather than duplicating the scan. Note `visitApplied` requires the occurrence-stamped marker from Step 3c — old (pre-M5) rows fold to occurrence 0, preserving legacy resumes.

Also pass `occ` at the cancel-end call site (:407): `beginCompensating(env, instanceId, node.scopeId!, cur, occ)`.

(e) **Operator `/cancel`** (`index.ts:466-501`) — root = process:

```ts
import { countCompensableSteps } from "./persistence/saga";
import { eligibleCommittedLocalScopeIds, subtreeScopeIds } from "./bpmn/scope-tree";
// graph is already loaded in this handler for the isRegion check; if not, load via the existing loadGraphForInstance helper
const subtree = subtreeScopeIds(graph, null);
const pending = await countCompensableSteps(env.DB, instanceId, subtree, eligibleCommittedLocalScopeIds(graph, null));
const liveCohort = (await listLiveTokens(env.DB, instanceId)).length; // process root: unfiltered IS the subtree filter
if (pending === 0 && liveCohort === 0) { /* existing empty-ledger terminal branch unchanged */ }
// existing compensating transition branch: armCohortLeaseExpiryTerminators now ALWAYS (drop the isRegion gate)
```

Then delete `countPendingSteps` from `saga.ts` (last call site gone) and `selectScopeStepsForCompensation` (replaced in Step 3a).

- [ ] **Step 5: Run the gates + the full no-op suite**

Run: `npx vitest run tests/integration/nested-compensation.test.ts && npm run test:integration && npm run test:unit && npm run typecheck`
Expected: new tests PASS; every pre-existing test PASSES unmodified (the no-op gate — spec §10.6). The empty-ledger `/cancel` shortcut now runs `listLiveTokens` for non-region instances too; their token read-model exists (`engine.ts:247-253`), so behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/compensation.ts src/runtime/engine.ts src/runtime/engine-shared.ts src/index.ts src/persistence/saga.ts src/persistence/history.ts src/bpmn/validator.ts tests/helpers.ts tests/integration/nested-compensation.test.ts tests/unit/bpmn-validator.test.ts
git commit -m "feat(m5-l1): root-relative reverse pass — subtree cursor/barrier, nested cancel-end resume, operator /cancel = process root"
```

---

### Task 9: Hierarchical error bubbling + error boundaries on scopes

**Files:**
- Modify: `src/runtime/forward-task.ts` (`errorBoundaryTarget` :69-80, business-failure path :520-563, `appliedForwardOutcome` :101-104)
- Modify: `src/bpmn/validator.ts` (error-boundary host rule :1101-1104)
- Modify: `tests/helpers.ts` (fixture)
- Test: `tests/integration/scope-error-bubbling.test.ts` (new)

**Interfaces:**
- Consumes: `scopesOf` (Task 2), `drainScopeSubtree` (Task 8).
- Produces:

```ts
export interface ErrorCatchTarget { boundaryId: string; hostId: string; hostIsScope: boolean; next: string }
export function errorCatchTarget(graph: ExecutionGraph, elementId: string, errorCode: string | null): ErrorCatchTarget | null;
```

- [ ] **Step 1: Fixture + failing tests**

`tests/helpers.ts`:

```ts
/**
 * M5-L1 bubbling fixture: process > subProcess S1 (error boundary catch-all → recover task)
 * > subProcess S2 (no boundary) > task A that fails with a business error. A has no own
 * boundary → the error climbs A → S2 (none) → S1 (caught). Variant without S1's boundary
 * (HAZARD_BUBBLE_BPMN) reaches the root → Hazard.
 */
export const SCOPE_ERR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="def_scope_err" targetNamespace="http://example.com">
  <bpmn:process id="proc_scope_err" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="S1"/>
    <bpmn:subProcess id="S1">
      <bpmn:startEvent id="s1_start"/>
      <bpmn:sequenceFlow id="s1f1" sourceRef="s1_start" targetRef="S2"/>
      <bpmn:subProcess id="S2">
        <bpmn:startEvent id="s2_start"/>
        <bpmn:sequenceFlow id="s2f1" sourceRef="s2_start" targetRef="A"/>
        <bpmn:serviceTask id="A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="failing" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
        <bpmn:sequenceFlow id="s2f2" sourceRef="A" targetRef="s2_end"/>
        <bpmn:endEvent id="s2_end"/>
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="s1f2" sourceRef="S2" targetRef="s1_end"/>
      <bpmn:endEvent id="s1_end"/>
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="S1_err" attachedToRef="S1"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="S1_err" targetRef="recover"/>
    <bpmn:serviceTask id="recover"><bpmn:extensionElements><easy-bpmn:taskDefinition type="recover" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="recover" targetRef="r_end"/>
    <bpmn:endEvent id="r_end"/>
    <bpmn:sequenceFlow id="f4" sourceRef="S1" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;

/** Same shape WITHOUT S1's boundary/recover path — the uncaught error reaches the root. */
export const HAZARD_BUBBLE_BPMN = SCOPE_ERR_BPMN
  .replace(/<bpmn:boundaryEvent id="S1_err"[\s\S]*?<bpmn:endEvent id="r_end"\/>\n?/, "")
  .replace('id="def_scope_err"', 'id="def_hazard_bubble"')
  .replace('id="proc_scope_err"', 'id="proc_hazard_bubble"');
```

`tests/integration/scope-error-bubbling.test.ts`:

```ts
describe("M5-L1 hierarchical error bubbling (spec §5.1)", () => {
  it("an uncaught task error climbs to the nearest enclosing scope boundary", async () => {
    const { instanceId } = await publishAndStart(SCOPE_ERR_BPMN);
    const token = await mintWorkerToken();
    await leaseAndFail(token, "failing", { errorCode: "BIZ", retryable: false });
    await leaseAndComplete(token, "recover", {});   // boundary target ran → bubbling worked
    expect((await getInstanceRow(instanceId)).status).toBe("completed");
    // retained: A has no compensation wiring here, but S2's drain kept no live tokens
    const hist = await historyTypes(instanceId);
    expect(hist.some((h) => h.type === "scopeExited" && h.element_id === "S1")).toBe(true); // abnormal exit audited
  });
  it("no boundary anywhere → Hazard at root (serviceTaskFailure, no auto-compensation)", async () => {
    const { instanceId } = await publishAndStart(HAZARD_BUBBLE_BPMN);
    const token = await mintWorkerToken();
    await leaseAndFail(token, "failing", { errorCode: "BIZ", retryable: false });
    const inst = await getInstanceRow(instanceId);
    expect(inst.status).toBe("incident");
    const inc = await env.DB.prepare(`SELECT kind FROM incidents WHERE instance_id = ?`).bind(instanceId).first<{ kind: string }>();
    expect(inc!.kind).toBe("serviceTaskFailure");
  });
});
```

Also validator pairs in `tests/unit/bpmn-validator.test.ts`: error boundary attached to a subProcess / transaction → **accept**; (existing serviceTask acceptance untouched).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/scope-error-bubbling.test.ts tests/unit/bpmn-validator.test.ts`
Expected: FAIL — validator rejects `S1_err` (host not a serviceTask); runtime would Hazard at A.

- [ ] **Step 3: Validator — widen error-boundary hosts** (:1101-1104)

```ts
} else if (n.boundaryKind === "error") {
  if (attached.type !== "serviceTask" && attached.type !== "subProcess" && attached.type !== "transaction") {
    err(`Error boundary event '${n.id}' must be attached to a service task, a subprocess, or a transaction.`, n.id, "boundaryEvent");
  }
  // ...errorRef handling unchanged...
```

- [ ] **Step 4: Runtime — the chain walk**

Replace `errorBoundaryTarget` (`forward-task.ts:69-80`):

```ts
function matchErrorBoundaryOn(graph: ExecutionGraph, hostId: string, errorCode: string | null): { boundaryId: string; next: string } | null {
  let catchAll: { boundaryId: string; next: string } | null = null;
  for (const [bid, node] of Object.entries(graph.nodes)) {
    if (node.type !== "boundaryEvent" || node.boundaryKind !== "error" || node.attachedToRef !== hostId) continue;
    if (node.errorCode != null && node.errorCode === errorCode && node.next) return { boundaryId: bid, next: node.next };
    if (node.errorCode == null && node.next) catchAll = { boundaryId: bid, next: node.next };
  }
  return catchAll;
}

/**
 * Hierarchical error catch (M5-L1 spec §5.1): the attachment-chain walk — the
 * throwing element first, then each enclosing scope bottom-up; per level exact
 * @errorCode beats catch-all; first level with a match wins. Null → Hazard.
 */
export function errorCatchTarget(graph: ExecutionGraph, elementId: string, errorCode: string | null): ErrorCatchTarget | null {
  const own = matchErrorBoundaryOn(graph, elementId, errorCode);
  if (own) return { ...own, hostId: elementId, hostIsScope: false };
  const scopes = scopesOf(graph);
  for (let s = graph.nodes[elementId]?.scopeId ?? null; s != null; s = scopes[s]?.parentId ?? null) {
    const m = matchErrorBoundaryOn(graph, s, errorCode);
    if (m) return { ...m, hostId: s, hostIsScope: true };
  }
  return null;
}
```

Call-site changes in `forward-task.ts`:
- `appliedForwardOutcome` (:101-104): `const target = errorCatchTarget(graph, elementId, job.error_code); if (target) return { kind: "next", next: target.next };` — write-free re-derivation stays deterministic (graph is immutable; the drain below already happened in the applying step).
- The business-failure applying path (:520-556): where `target` is resolved, use `errorCatchTarget`; after the existing `dbBatch` succeeds and **when `target.hostIsScope`**, run the scope exit inside the same step body:

```ts
if (target.hostIsScope) {
  await drainScopeSubtree(env, graph, instanceId, target.hostId); // idempotent retain-only drain
  await historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: target.hostId, type: "scopeExited", diagnostics: { scope: target.hostId, via: target.boundaryId, abnormal: true } }).run();
}
```

The Hazard fallthrough (:557-568) is unchanged (`errorCatchTarget` null ⇒ same `serviceTaskFailure` incident).

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/integration/scope-error-bubbling.test.ts tests/integration/error-routing.test.ts tests/unit/bpmn-validator.test.ts && npm run typecheck`
Expected: PASS (`error-routing.test.ts` = the M3 precedence ladder, must be untouched: level-0 behavior is byte-identical).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/forward-task.ts src/bpmn/validator.ts tests/helpers.ts tests/integration/scope-error-bubbling.test.ts tests/unit/bpmn-validator.test.ts
git commit -m "feat(m5-l1): hierarchical error bubbling — attachment-chain walk, error boundaries on scopes, abnormal-exit drain"
```

---

### Task 10: Error end event + `uncaughtError` incident kind

**Files:**
- Modify: `src/bpmn/validator.ts` (endEvent classify :686-701; errorRef resolution reuse)
- Modify: `src/runtime/engine.ts` (`driveLeaf` endEvent branch)
- Modify: `src/persistence/instances.ts` (`IncidentKind` :810-838)
- Modify: `specs/002-saga-orchestrator/contracts/openapi.yaml` (`Incident.kind` enum)
- Modify: `tests/helpers.ts` (fixture)
- Test: `tests/integration/error-end-event.test.ts` (new), validator pairs

**Interfaces:**
- Consumes: `errorCatchTarget` (Task 9), `drainScopeSubtree` (Task 8).
- Produces: `endKind === "error"` nodes carrying `errorCode`; incident kind `"uncaughtError"`.

- [ ] **Step 1: Fixture + failing tests**

`tests/helpers.ts`:

```ts
/**
 * M5-L1 error-end fixture: process > subProcess S (error boundary catch-all → recover)
 * > prep task then XOR: fail=true → errEnd (errorRef E1/E_FAIL); default → s_end.
 * ERROR_END_ROOT_BPMN: the same throw at PROCESS level (no boundary) → uncaughtError.
 */
export const ERROR_END_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="def_err_end" targetNamespace="http://example.com">
  <bpmn:error id="E1" name="Fail" errorCode="E_FAIL"/>
  <bpmn:process id="proc_err_end" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="S"/>
    <bpmn:subProcess id="S">
      <bpmn:startEvent id="s_start"/>
      <bpmn:sequenceFlow id="sf1" sourceRef="s_start" targetRef="prep"/>
      <bpmn:serviceTask id="prep"><bpmn:extensionElements><easy-bpmn:taskDefinition type="prep" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:sequenceFlow id="sf2" sourceRef="prep" targetRef="gw"/>
      <bpmn:exclusiveGateway id="gw" default="sf_ok"/>
      <bpmn:sequenceFlow id="sf_fail" sourceRef="gw" targetRef="errEnd"><bpmn:conditionExpression>fail = true</bpmn:conditionExpression></bpmn:sequenceFlow>
      <bpmn:endEvent id="errEnd"><bpmn:errorEventDefinition errorRef="E1"/></bpmn:endEvent>
      <bpmn:sequenceFlow id="sf_ok" sourceRef="gw" targetRef="s_end"/>
      <bpmn:endEvent id="s_end"/>
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="S_err" attachedToRef="S"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="S_err" targetRef="recover"/>
    <bpmn:serviceTask id="recover"><bpmn:extensionElements><easy-bpmn:taskDefinition type="recover" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="recover" targetRef="r_end"/>
    <bpmn:endEvent id="r_end"/>
    <bpmn:sequenceFlow id="f4" sourceRef="S" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;

export const ERROR_END_ROOT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="def_err_end_root" targetNamespace="http://example.com">
  <bpmn:error id="E1" name="Fail" errorCode="E_FAIL"/>
  <bpmn:process id="proc_err_end_root" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="prep"/>
    <bpmn:serviceTask id="prep"><bpmn:extensionElements><easy-bpmn:taskDefinition type="prep" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="prep" targetRef="gw"/>
    <bpmn:exclusiveGateway id="gw" default="f_ok"/>
    <bpmn:sequenceFlow id="f_fail" sourceRef="gw" targetRef="errEnd"><bpmn:conditionExpression>fail = true</bpmn:conditionExpression></bpmn:sequenceFlow>
    <bpmn:endEvent id="errEnd"><bpmn:errorEventDefinition errorRef="E1"/></bpmn:endEvent>
    <bpmn:sequenceFlow id="f_ok" sourceRef="gw" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;
```

(Mirror the `conditionExpression` element shape — `xsi:type`/language attributes — from `SAGA_LOOP_BPMN` in `tests/helpers.ts` if the parser requires them.)

`tests/integration/error-end-event.test.ts`:

```ts
describe("M5-L1 error end event (spec §5.2)", () => {
  it("an error end inside a subProcess routes to the scope's error boundary", async () => {
    const { instanceId } = await publishAndStart(ERROR_END_BPMN, { variables: { fail: true } });
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "prep", {});       // drives the XOR to the error path
    await leaseAndComplete(token, "recover", {});
    expect((await getInstanceRow(instanceId)).status).toBe("completed");
  });
  it("an error end at process level settles an uncaughtError Hazard", async () => {
    const { instanceId } = await publishAndStart(ERROR_END_ROOT_BPMN, { variables: { fail: true } });
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "prep", {});
    const inst = await getInstanceRow(instanceId);
    expect(inst.status).toBe("incident");
    const inc = await env.DB.prepare(`SELECT kind FROM incidents WHERE instance_id = ?`).bind(instanceId).first<{ kind: string }>();
    expect(inc!.kind).toBe("uncaughtError");
  });
});
```

Validator pairs: error end with resolvable `errorRef`+code → accept; dangling `errorRef` → reject; `errorRef` to a code-less `<bpmn:error>` → reject (reuse the boundary messages' phrasing with "Error end event '<id>'").

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/error-end-event.test.ts tests/unit/bpmn-validator.test.ts`
Expected: FAIL — endEvent classify rejects `errorEventDefinition` (`validator.ts:692-700`).

- [ ] **Step 3: Validator**

In the endEvent classify block (:686-701) add the error case:

```ts
} else if (only === ERROR_EVENT_DEFINITION) {
  info.endKind = "error";
  info.errorRef = refId((defs[0] as ModdleElement).errorRef) ?? undefined;
} else { /* existing reject, message now: "Only a none end event, a cancel end event (inside a transaction), or an error end event is supported." */ }
```

Resolve `errorRef → errorCode` for error-end nodes in the same section that resolves boundary errorRefs (:1105-1141) — extract the shared resolution into a small helper `resolveErrorCode(n, danglingErrorRef, errorsById, err, label)` used by both, requiring for an END event that `errorRef` is PRESENT and coded (an error end without a code has no deterministic catch key — reject: `"Error end event '<id>' must reference a declared <bpmn:error> with a non-empty @errorCode."`). Stamp `node.errorCode` in `buildGraph` for endEvents like boundaries (:1552-1559 gains `if (n.type === "endEvent" && n.endKind === "error") { node.errorRef = n.errorRef ?? null; node.errorCode = n.errorCode ?? null; }`).

- [ ] **Step 4: Engine + incident kind**

`IncidentKind` (:838): append

```ts
// COMPOSITION (M5-L1 spec §5.1): an error END EVENT reached the process root
// uncaught (worker-task uncaught errors keep serviceTaskFailure).
| "uncaughtError";
```

`openapi.yaml`: add `uncaughtError` to the `Incident.kind` enum (find it via `grep -n "stepBudget" specs/002-saga-orchestrator/contracts/openapi.yaml`).

`driveLeaf` endEvent branch — insert BEFORE the cancel/commit checks:

```ts
if (node.endKind === "error") {
  const catchT = errorCatchTarget(graph, cur, node.errorCode ?? null); // level 0 is a no-op: boundaries never attach to end events
  if (catchT) {
    const next = await runStep(`err-end:${tag}`, async () => {
      await drainScopeSubtree(env, graph, instanceId, catchT.hostId);
      const inst = await loadInst(env, instanceId);
      await dbBatch(env.DB, [
        historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: cur, type: "errorEndThrown", diagnostics: { errorCode: node.errorCode, caughtBy: catchT.boundaryId, occurrence: occ } }),
        historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: catchT.hostId, type: "scopeExited", diagnostics: { scope: catchT.hostId, via: catchT.boundaryId, abnormal: true, occurrence: occ } }),
        applyTransitionStmt(env.DB, { instanceId, currentElementId: catchT.next, status: "running", now: nowIso() }),
      ]);
      return catchT.next;
    });
    return { kind: "next", next };
  }
  await runStep(`err-end:${tag}`, () =>
    createIncident(env, instanceId, cur, 0, `Uncaught error end event ('${node.errorCode}') reached the process root.`, { errorCode: node.errorCode }, "uncaughtError"),
  );
  return { kind: "incident" };
}
```

Idempotency: the step body re-run is guarded by the transition (applyTransition is last-write-wins on the same target) and `drainScopeSubtree` is idempotent; add a `visitApplied(env, instanceId, cur, occ, "errorEndThrown")` fast-forward guard at the top of the caught branch returning `catchT.next` write-free.

- [ ] **Step 5: Run to verify pass + docs guard**

Run: `npx vitest run tests/integration/error-end-event.test.ts tests/unit/bpmn-validator.test.ts && npm run check:docs && npm run typecheck`
Expected: PASS — `check:docs` §7 validates the `IncidentKind` ↔ openapi enum sync both ways.

- [ ] **Step 6: Commit**

```bash
git add src/bpmn/validator.ts src/runtime/engine.ts src/persistence/instances.ts specs/002-saga-orchestrator/contracts/openapi.yaml tests/helpers.ts tests/integration/error-end-event.test.ts tests/unit/bpmn-validator.test.ts
git commit -m "feat(m5-l1): error end event — publish acceptance, scope throw + bubbling, uncaughtError incident kind"
```

---

### Task 11: Timer boundaries on scopes (Hazard-vs-Cancel)

**Files:**
- Modify: `src/bpmn/validator.ts` (timer host rule :1171-1199)
- Modify: `src/runtime/engine.ts` (scope-entry arm; scope-exit disarm; fired-timer fast-forward in the scope branch)
- Modify: `src/runtime/boundary-timer.ts` (`planBoundaryTimerFire` third host shape :340-397)
- Modify: `tests/helpers.ts` (fixture)
- Test: `tests/integration/scope-boundary-timer.test.ts` (new)

**Interfaces:**
- Consumes: `drainScopeSubtree` (Task 8), `timerBoundaryFor`/`buildBoundaryArm`/`buildBoundaryCancelSettle` (existing M3 machinery — all keyed by `hostElementId`, which now may be a scope id).
- Produces: an armed scope timer whose fire interrupts WITHOUT compensation (retained ledger), and whose disarm rides both normal and abnormal scope exits.

- [ ] **Step 1: Fixture + failing tests**

`tests/helpers.ts`:

```ts
/**
 * M5-L1 Hazard-vs-Cancel fixture (spec §5.3-§5.4): transaction TX with a timer
 * boundary, containing compensable task A (undoA) then receiveTask waitMsg. The
 * timer fires while waitMsg parks → exits TX WITHOUT compensation; A's row is
 * retained pending; POST /cancel afterwards forces the reverse pass.
 */
export const TX_TIMER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="def_tx_timer" targetNamespace="http://example.com">
  <bpmn:message id="m1" name="m1"/>
  <bpmn:process id="proc_tx_timer" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="TX"/>
    <bpmn:transaction id="TX">
      <bpmn:startEvent id="t_start"/>
      <bpmn:sequenceFlow id="tf1" sourceRef="t_start" targetRef="A"/>
      <bpmn:serviceTask id="A"><bpmn:extensionElements><easy-bpmn:taskDefinition type="stepA" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:boundaryEvent id="A_comp" attachedToRef="A"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="undoA" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="undoA" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:association id="assocA" sourceRef="A_comp" targetRef="undoA"/>
      <bpmn:sequenceFlow id="tf2" sourceRef="A" targetRef="waitMsg"/>
      <bpmn:receiveTask id="waitMsg" messageRef="m1"/>
      <bpmn:sequenceFlow id="tf3" sourceRef="waitMsg" targetRef="t_end"/>
      <bpmn:endEvent id="t_end"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="TX_timer" attachedToRef="TX"><bpmn:timerEventDefinition><bpmn:timeDuration>PT1S</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="TX_timer" targetRef="afterTimer"/>
    <bpmn:serviceTask id="afterTimer"><bpmn:extensionElements><easy-bpmn:taskDefinition type="afterTimer" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="afterTimer" targetRef="after_end"/>
    <bpmn:endEvent id="after_end"/>
    <bpmn:sequenceFlow id="f4" sourceRef="TX" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;
```

(Mirror the exact `timeDuration`/`timerEventDefinition` and `messageRef` shapes from this file's existing M3 fixtures if the parser expects different attribute forms.)

`tests/integration/scope-boundary-timer.test.ts` (drive the DO alarm the way the existing boundary-timer integration tests do — grep `tests/integration/` for `armTimer|fireTimer|timer_outcomes` and mirror the established firing harness):

```ts
describe("M5-L1 timer boundary on a transaction (spec §5.3-§5.4)", () => {
  it("fire interrupts WITHOUT compensation; ledger retained; /cancel then compensates", async () => {
    const { instanceId } = await publishAndStart(TX_TIMER_BPMN);
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "stepA", {});               // A ledgered pending (scope TX)
    await fireDueBoundaryTimer(instanceId, "TX_timer");        // harness: fires the armed DO timer
    // token exited on the boundary path — NO compensation job exists
    expect(await countJobs(instanceId, "undoA")).toBe(0);
    const a = await ledgerByElement(instanceId);
    expect(a["A"]).toBe("pending");                            // retained (Hazard-class exit)
    await leaseAndComplete(token, "afterTimer", {});
    expect((await getInstanceRow(instanceId)).status).toBe("completed");
    // NOTE: instance completed with a RETAINED uncompensated row — /cancel is only
    // available pre-terminal, so re-run the scenario without completing afterTimer:
  });
  it("operator /cancel after the timer exit drives the retained rows", async () => {
    const { instanceId } = await publishAndStart(TX_TIMER_BPMN);
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "stepA", {});
    await fireDueBoundaryTimer(instanceId, "TX_timer");
    await authedPost(`/instances/${instanceId}/cancel`, {});   // root = process; retained row eligible
    await resumeInline(env, instanceId);
    await leaseAndComplete(token, "undoA", {});
    expect((await ledgerByElement(instanceId))["A"]).toBe("compensated");
  });
  it("normal commit disarms the timer (no late fire)", async () => {
    const { instanceId } = await publishAndStart(TX_TIMER_BPMN);
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "stepA", {});
    await publishMessage("m1", instanceId);                    // waitMsg resolves → TX commits
    const outcome = await env.DB.prepare(`SELECT outcome FROM timer_outcomes WHERE timer_id LIKE ?`).bind(`%TX_timer%`).first<{ outcome: string }>();
    expect(outcome!.outcome).toBe("cancelled");
  });
});
```

Validator pair: timer boundary on a transaction / subProcess → **accept** (delete the :1180-1185 reject); on a gateway still rejected upstream.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/scope-boundary-timer.test.ts tests/unit/bpmn-validator.test.ts`
Expected: FAIL — validator rejects `TX_timer` (transaction host).

- [ ] **Step 3: Validator** (:1171-1199) — replace the timer host checks:

```ts
} else if (n.boundaryKind === "timer") {
  // M5-L1: a timer may now attach to a scope (subProcess/transaction). Firing on a
  // transaction interrupts WITHOUT compensation (Hazard-vs-Cancel, spec §5.3) — the
  // modeling guidance for rollback-on-timeout is a timer routed to a cancel end INSIDE.
  if (attached.type !== "serviceTask" && attached.type !== "receiveTask" && attached.type !== "subProcess" && attached.type !== "transaction") {
    err(`Boundary timer '${n.id}' must be attached to a service task, a receive task, a subprocess, or a transaction; '${attached.id}' is a ${attached.type}.`, n.id, "boundaryEvent");
  }
  if (outs.length !== 1) { /* unchanged */ }
}
```

- [ ] **Step 4: Runtime**

(a) **Arm at scope entry** — in `enterScope` (Task 5) and `enterTransaction` (:653-662): compose the arm exactly as the receiveTask site does (`engine.ts:1058-1066`):

```ts
const arm = buildBoundaryArm(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: scopeId /* or txId */, occ, now });
await dbBatch(env.DB, [ /* existing stmts */, ...(arm ? arm.stmts : []) ]);
if (arm) await armTimerDO(env, arm.timerId, arm.fireAt);
```

(b) **Disarm at every scope exit** — add `buildBoundaryCancelSettle(graph, env, { instanceId, workspaceId, hostElementId: scopeId, occ, now })` statements to: `commitTransaction`'s batch, `exitScope`'s batch, the nested-cancel `beginCompensating` batch, and the abnormal-exit drain block in Task 9's `hostIsScope` branch and Task 10's error-end branch. On a PK conflict (`isUniqueConstraintViolation`) the timer FIRED first — convert via the existing `convertOnFire` pattern (copy the try/catch shape from `forward-task.ts:491-499`).

(c) **Fire** — `planBoundaryTimerFire` (`boundary-timer.ts:340-397`) third host shape, before the final `return { kind: "skip" }`:

```ts
if (host?.type === "transaction" || host?.type === "subProcess") {
  // GUARD: the scope's visit must still be open — a commit/exit marker for this
  // occurrence means completion won the race.
  const exited = await hasHistoryMarkerForOccurrence(env.DB, instanceId, hostId, host.type === "transaction" ? "transactionCommitted" : "scopeExited", occ)
    || await hasHistoryMarkerForOccurrence(env.DB, instanceId, hostId, "transactionCancelled", occ);
  if (exited) return { kind: "skip" };
  return {
    kind: "fire", next,
    wake: { instanceId, workflowEventType: WAKE_TYPE, timerId: timer.timerId },
    stmts: [
      insertTimerOutcomeStmt(env.DB, { timerId: timer.timerId, outcome: "fired", now }), // THE CLAIM
      flipTimerFiredStmt(env.DB, { timerId: timer.timerId, firedAt: now, now }),
      historyStmt(env.DB, { workspaceId, instanceId, elementId: timer.elementId, type: "timerFired", diagnostics: { attachedToRef: hostId, occurrence: occ, boundaryTarget: next, interruptsScope: true } }),
      historyStmt(env.DB, { workspaceId, instanceId, elementId: hostId, type: "scopeExited", diagnostics: { scope: hostId, via: timer.elementId, abnormal: true, occurrence: occ } }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
    ],
  };
}
```

Note `transactionCommitted` history is NOT occurrence-stamped today (`engine.ts:675`) — add `occurrence: occ` to its diagnostics in `commitTransaction` (backward-safe: the marker helper folds absent to 0).

The **subtree drain moves to the rewalk** (spec §5.4 refined — the fire batch stays single-batch/atomic): in `driveLeaf`'s scope branch (Task 5b), before entering:

```ts
const tb = timerBoundaryFor(graph, cur);
if (tb && (await timerHasFired(env, instanceId, tb, occ))) {
  await runStep(`scope-timer-exit:${tag}`, () => drainScopeSubtree(env, graph, instanceId, cur)); // idempotent
  return { kind: "next", next: tb.node.next! };
}
```

Also verify `settleOverdueBoundaryTimerOnWake` (`boundary-timer.ts:399+`) needs no change — it reuses `planBoundaryTimerFire` verbatim.

- [ ] **Step 5: Run to verify pass + timer regression slice**

Run: `npx vitest run tests/integration/scope-boundary-timer.test.ts tests/integration/saga-dlq-timeout.test.ts tests/unit/bpmn-validator.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bpmn/validator.ts src/runtime/engine.ts src/runtime/boundary-timer.ts tests/helpers.ts tests/integration/scope-boundary-timer.test.ts tests/unit/bpmn-validator.test.ts
git commit -m "feat(m5-l1): timer boundaries on scopes — arm at entry, disarm at every exit, interrupt-without-compensation fire"
```

---

### Task 12: Straggler/barrier gates under nesting + the full no-op gate

**Files:**
- Test: extend `tests/integration/nested-compensation.test.ts`
- Modify (only if a gate fails): `src/runtime/compensation.ts`

**Interfaces:** consumes everything landed; produces the spec §10.5 verification.

- [ ] **Step 1: Write the two gate tests** (extend `nested-compensation.test.ts`).

Fixture `NESTED_PAR_TX_BPMN` in `tests/helpers.ts`: take the exact transaction-with-parallel-region fixture that `tests/integration/parallel-compensation.test.ts`'s straggler/quiescence tests use (the known-legal M4 shape for "cancel while a branch token is in flight") and wrap its compensable branch task `A` in a plain `<bpmn:subProcess id="S">…</bpmn:subProcess>` (inner none-start/none-end around `A`, boundary + `undoA` association staying inside `S`). Everything else — split/join wiring, the cancel trigger, the sibling branch — is copied verbatim from that fixture so only the new nesting varies.

```ts
it("a live token in a DEEPER scope holds the barrier (no wedge, no early settle)", async () => {
  const { instanceId } = await publishAndStart(NESTED_PAR_TX_BPMN);
  const token = await mintWorkerToken();
  await leaseOne(token, "stepA");                        // A locked in the DEEP scope S — not completed
  await triggerCancel(instanceId, token);                 // same cancel trigger as the copied M4 test
  await resumeInline(env, instanceId);
  // barrier: the deep-scope live token must hold the reverse pass open
  expect((await getInstanceRow(instanceId)).status).toBe("compensating");
  await expireLeaseAndRedrive(instanceId);                // the cohort lease-expiry terminator path, as in the M4 test
  // the failed job's token discards; ledger empty → pass settles
  expect((await getInstanceRow(instanceId)).status).toBe("compensated");
});

it("a deeper-scope straggler completing AFTER cancel is ledgered and compensated (no leak)", async () => {
  const { instanceId } = await publishAndStart(NESTED_PAR_TX_BPMN);
  const token = await mintWorkerToken();
  const jobId = await leaseOne(token, "stepA");           // A in flight in S
  await triggerCancel(instanceId, token);
  await completeJob(token, jobId, { late: true });        // straggler lands AFTER cancel
  await resumeInline(env, instanceId);
  const row = await env.DB.prepare(`SELECT scope_id, compensation_status s FROM saga_steps WHERE instance_id = ? AND element_id = 'A'`).bind(instanceId).first<{ scope_id: string; s: string }>();
  expect(row!.scope_id).toBe("S");                        // ledgered with the IMMEDIATE scope
  await leaseAndComplete(token, "undoA", {});             // …and compensated (no leaked effect)
  expect((await ledgerByElement(instanceId))["A"]).toBe("compensated");
});
```

`triggerCancel` / `expireLeaseAndRedrive` / `completeJob` are whatever the copied `parallel-compensation.test.ts` tests already use for those three actions (cancel-end via a failing task or operator `/cancel`; `rewindBackoff` + `resumeInline`; raw `/jobs/{id}/complete`) — mirror them, do not invent a second harness.

- [ ] **Step 2: Run — expect PASS** (the Task 8 subtree cohort/barrier already implements this). If either FAILS, fix `ledgerStragglers`/the barrier filter — the failure pinpoints the cohort test.

Run: `npx vitest run tests/integration/nested-compensation.test.ts`

- [ ] **Step 3: The full no-op gate**

Run: `npm run test && npm run typecheck && npm run check:docs`
Expected: the ENTIRE suite green with zero edits to pre-existing tests. Any legacy failure here is a regression in the single-scope fast path — fix forward before proceeding.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers.ts tests/integration/nested-compensation.test.ts
git commit -m "test(m5-l1): deep-scope straggler + barrier gates; full-suite no-op gate green"
```

---

### Task 13: e2e matrix registry — rewrite the inverted scenario, add the M5-L1 wave

**Files:**
- Modify: `tests/matrix/registry.ts`
- Modify: `tests/integration/matrix/compensation.test.ts` (marker for the rewritten scenario, if the file exists; else the registry row's `directFile` points at `tests/integration/nested-compensation.test.ts`)
- Test: `npm run check:matrix`

**Interfaces:** consumes the shipped runtime; produces registry coverage for M5-L1 must-cover tags.

- [ ] **Step 1: Rewrite `C-COMP-NESTEDTX-BRANCH-01`** (`registry.ts:45`) — the title pins the now-inverted semantics:

```ts
{ id: "C-COMP-NESTEDTX-BRANCH-01", title: "Transaction nested INSIDE one parallel branch — inner commit is committedLocal; outer cancel DOES re-compensate it (M5-L1 commit shield)", axes: ["Compensation:scope-nesting", "Compensation:commit-shield", "Activities:transaction", "Concurrency:fan-out", "Gateways:parallelGateway"], legality: "valid", modes: ["direct", "workflow"], risk: "high", coverage: "new", phase: 1, directFile: "tests/integration/nested-compensation.test.ts", workflowFile: "tests/workflow-mode/matrix.wf.test.ts" },
```

Add the `[C-COMP-NESTEDTX-BRANCH-01]` marker comment to the covering test in `tests/integration/nested-compensation.test.ts` (the gate-1 test), matching the marker syntax `check:matrix` greps (see `scripts/check-matrix.mjs` for the exact pattern).

- [ ] **Step 2: Add the M5-L1 scenario rows** (valid + reject; `phase: 1`, `directFile` = the real covering files from Tasks 5–11, each test gaining its `[<id>]` marker):

```ts
{ id: "S-SUBPROC-LINEAR-01", title: "Plain embedded subProcess on the token path — enter/exit bookkeeping + occurrence fast-forward", axes: ["Activities:subProcess"], legality: "valid", modes: ["direct", "workflow"], risk: "med", coverage: "new", phase: 1, directFile: "tests/integration/subprocess-walk.test.ts", workflowFile: "tests/workflow-mode/matrix.wf.test.ts" },
{ id: "S-COMP-NESTED-COMMIT-01", title: "outer-tx > subProcess > inner-tx-commits; outer cancel compensates the inner rows reverse-by-global-seq (M5-L1 gate 1)", axes: ["Compensation:commit-shield", "Compensation:scope-nesting", "Activities:subProcess", "Activities:transaction"], legality: "valid", modes: ["direct", "workflow"], risk: "high", coverage: "new", phase: 1, directFile: "tests/integration/nested-compensation.test.ts", workflowFile: "tests/workflow-mode/matrix.wf.test.ts" },
{ id: "S-COMP-REENTRY-SHIELD-01", title: "M2 cycle re-enters a committed nested tx — self-cancel shielded, ancestor cancel compensates every occurrence (M5-L1 gate 4)", axes: ["Compensation:commit-shield", "Loops:occurrence", "Activities:transaction"], legality: "valid", modes: ["direct"], risk: "high", coverage: "new", phase: 1, directFile: "tests/integration/nested-compensation.test.ts", workflowFile: "" },
{ id: "S-ERR-BUBBLE-01", title: "Uncaught task error climbs the scope chain to a subProcess boundary; none anywhere → Hazard", axes: ["Events:errorBoundary", "Error:bubbling", "Activities:subProcess"], legality: "valid", modes: ["direct", "workflow"], risk: "high", coverage: "new", phase: 1, directFile: "tests/integration/scope-error-bubbling.test.ts", workflowFile: "tests/workflow-mode/matrix.wf.test.ts" },
{ id: "S-ERR-END-01", title: "Error end event throws from a subProcess to the scope boundary; at root → uncaughtError incident", axes: ["Events:errorEnd", "Error:bubbling"], legality: "valid", modes: ["direct"], risk: "med", coverage: "new", phase: 1, directFile: "tests/integration/error-end-event.test.ts", workflowFile: "" },
{ id: "S-TX-TIMER-01", title: "Timer boundary on a transaction — interrupt WITHOUT compensation, retained ledger, /cancel forces the reverse pass (M5-L1 gate 3)", axes: ["Events:boundaryTimer", "Activities:transaction", "Compensation:retained-ledger", "Operator:cancel"], legality: "valid", modes: ["direct", "workflow"], risk: "high", coverage: "new", phase: 1, directFile: "tests/integration/scope-boundary-timer.test.ts", workflowFile: "tests/workflow-mode/matrix.wf.test.ts" },
{ id: "R-EVENT-SUBPROC-01", title: "Event subprocess (triggeredByEvent) -> interim publish reject (M5-L4 pointer)", axes: ["Activities:subProcess", "Legality:reject"], legality: "reject", modes: ["direct"], risk: "med", coverage: "new", phase: 1, directFile: "tests/matrix/reject.test.ts", workflowFile: "" },
{ id: "R-MI-SUBPROC-01", title: "multiInstanceLoopCharacteristics on a subProcess -> interim publish reject (M5-L3 pointer)", axes: ["Activities:subProcess", "Legality:reject"], legality: "reject", modes: ["direct"], risk: "med", coverage: "new", phase: 1, directFile: "tests/matrix/reject.test.ts", workflowFile: "" },
{ id: "R-SCOPE-DEPTH-01", title: "Scope nesting depth 9 > MAX_SCOPE_DEPTH -> publish reject", axes: ["Activities:subProcess", "Legality:reject"], legality: "reject", modes: ["direct"], risk: "low", coverage: "new", phase: 1, directFile: "tests/matrix/reject.test.ts", workflowFile: "" },
{ id: "R-COMP-NO-TX-ANCESTOR-01", title: "isForCompensation handler with no transaction ancestor -> publish reject (no trigger)", axes: ["Compensation", "Legality:reject"], legality: "reject", modes: ["direct"], risk: "med", coverage: "new", phase: 1, directFile: "tests/matrix/reject.test.ts", workflowFile: "" },
{ id: "R-CANCEL-END-SUBPROC-01", title: "Cancel end whose immediate scope is a subProcess -> publish reject", axes: ["Events:cancelEnd", "Activities:subProcess", "Legality:reject"], legality: "reject", modes: ["direct"], risk: "med", coverage: "new", phase: 1, directFile: "tests/matrix/reject.test.ts", workflowFile: "" },
```

If `tests/matrix/reject.test.ts` does not exist yet (it is a declared-but-absent Phase-1 file), create it with the five `R-*` reject cases above as real publish-reject tests (`validate()` harness, one `it` per scenario, each carrying its `[<id>]` marker) — the validator unit tests from Tasks 3/6 give the fixture XML to reuse. Workflow-mode files are Phase-2/3 declarations only (not authored now), matching the registry's existing convention.

- [ ] **Step 3: Verify + commit**

Run: `npm run check:matrix && npx vitest run tests/matrix/reject.test.ts`
Expected: PASS (all markers found, ≥11 reject scenarios total).

```bash
git add tests/matrix/registry.ts tests/matrix/reject.test.ts tests/integration/
git commit -m "test(m5-l1): matrix wave — commit-shield semantics inversion + M5-L1 must-cover scenarios"
```

---

### Task 14: Docs lockstep + contracts + console enum sweep

**Files:**
- Modify: `docs/bpmn/02-activities.md`, `docs/bpmn/01-events.md`, `docs/bpmn/07-execution-semantics.md`, `docs/bpmn/09-easy-bpmn-profile.md`
- Modify: `CLAUDE.md` (caps list + M5-L1 status line)
- Verify/modify: `specs/002-saga-orchestrator/contracts/openapi.yaml` + `src/contracts/*` (compensation-status enum), `spa/src` (status humanization)

- [ ] **Step 1: `docs/bpmn` lockstep**

- `02-activities.md`: embedded (non-transaction) subProcess moves to supported — semantics per spec §2 (bookkeeping scope, shares variables, no commit).
- `01-events.md`: error end event supported; semantics: throws from its scope, chain-walk catch, `uncaughtError` at root.
- `07-execution-semantics.md`: the scope model — typed hierarchy, commit shield (`committedLocal`/sealed), subtree cursor with global `seq`, two-phase cancel, Hazard-vs-Cancel boundary exits; state `MAX_SCOPE_DEPTH = 8` (literal — check:docs syncs it).
- `09-easy-bpmn-profile.md`: flip M5-L1 constructs from interim to open; generalize rule 10 (compensation reachability = ancestry) and rule 14's family (scope timer = abandon-host generalized); record the modeling guidance (timer→cancel-end-inside for rollback); keep L2–L5 interim markers.
- `CLAUDE.md`: add `MAX_SCOPE_DEPTH` to the caps sentence and mark M5-L1 shipped in the milestone list.

- [ ] **Step 2: Contract surface sweep for `committedLocal`**

```bash
grep -rn "committed" src/contracts/ specs/002-saga-orchestrator/contracts/openapi.yaml spa/src | grep -iv "test"
```

Wherever the compensation-status enum is enumerated (zod schema, openapi, SPA humanization map), add `committedLocal` (display label for the console map, if present: "committed (nested)"). If the ledger status never crosses the API contract (only internal), record that finding in the commit message instead of editing.

- [ ] **Step 3: Verify + commit**

Run: `npm run check:docs && npm run test:contract && npm run typecheck && (npm run typecheck:ui || true)`
Expected: PASS (`typecheck:ui` only if `spa/src` was touched).

```bash
git add docs/bpmn/ CLAUDE.md specs/ src/contracts/ spa/src
git commit -m "docs(m5-l1): bpmn docs lockstep — scope model, error end, Hazard-vs-Cancel; committedLocal contract sweep"
```

---

### Task 15: Workflow-mode + real-CF smoke gate, PR

**Files:**
- Create: `tests/workflow-mode/matrix.wf.test.ts` markers for the M5-L1 `modes: ["workflow"]` scenarios IF the workflow-mode harness (branch `e2e-combination-matrix`) is already merged; otherwise record the deferral in the registry (`phase: 2`) and in the PR description.

- [ ] **Step 1: Local workflow-mode run (if the `test:wf` harness exists on this branch)**

```bash
ls package.json | xargs grep -l "test:wf" && npm run test:wf || echo "workflow-mode harness not on this branch — flip S-* workflow rows to phase 2 and note it"
```

If absent: edit the Task 13 rows with `modes` containing `"workflow"` to `phase: 2` and commit — never leave a declared-but-unrunnable marker.

- [ ] **Step 2: Real-CF smoke (the spec §10 gate — reverse pass on real Workflows)**

Deploy the branch to a preview and drive the nested-cancel scenario over the public API against `bpmn.rntme.com`'s worker (same flow as the M4/TASK-54 validation recorded in the repo docs):

```bash
npm run build:ui && npx wrangler deploy
# then drive NESTED_COMMIT_BPMN over HTTPS: publish draft → publish → start → complete stepA/stepB →
# fail trip (retryable=false) → lease+complete undoB, undoA → GET /instances/{id} expect status=compensated
```

Script the drive as a bash sequence with `curl` (worker credentials via `POST /workers/credentials`); real CF is browser-UA-gated (Bot Fight) — send the requests with the same UA/token pattern the M4 validation used (see `docs/superpowers/specs/` M4 notes). Record the worker version id + instance id in the PR.

- [ ] **Step 3: Final verification + PR**

```bash
npm run test && npm run typecheck && npm run check:docs && npm run check:matrix
git push -u origin m5-l1-embedded-scopes
gh pr create --title "feat(m5-l1): embedded scopes + hierarchical exceptions" --body "<summary: spec link, the 6 exit gates with test pointers, real-CF smoke evidence, constitution v2.5.0>"
```

Backlog: create the flat `TASK-NN` rows for M5-L1 (milestone label `m-5`, mirroring TASK-48..54's granularity — one per plan task group: governance, scope model, ledger/commit shield, compensation, exceptions, timers, tests/docs) and mark them Done against this PR; update the epic TASK-28 notes.

---

## Execution notes

- **Task order is strict for 2→8** (each consumes the previous task's exports). Tasks 9/10/11 are independent of each other after 8; 12–15 close out.
- When an anchor line has drifted, locate by the quoted code, not the number.
- If a step's exact helper name in `tests/helpers.ts` differs (e.g. `leaseAndFail` vs `failJob`), mirror the neighboring integration tests — never invent a second harness.
