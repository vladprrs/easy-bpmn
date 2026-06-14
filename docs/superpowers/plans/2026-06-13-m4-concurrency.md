# M4 — Concurrency (parallel + inclusive gateways, token frontier, joins) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `easy-bpmn` execute genuine in-instance concurrency — `bpmn:parallelGateway` (AND) and `bpmn:inclusiveGateway` (OR), block-structured (SESE), with branch-local variables that merge at a join, straggler-catching compensation, and frontier-empty completion — while preserving the two engine invariants (the walk is the replay; persist-before-advance).

**Architecture:** Keep **one Cloudflare Workflow per instance**, **D1 canonical**, **single DO correlation broker**. The engine's scalar cursor `cur` becomes a **token frontier** reconstructed each drive by a deterministic depth-first re-walk from `startElementId` (document order at every split). Splits fan branches out as **leasable jobs** (real parallelism is worker-side); the drive collects all parked frontier waits and issues **one `Promise.race`** over several `step.waitForEvent`; any event re-walks from start. Joins are claimed by append-only `join_arrivals` / `join_completions` facts (the exact `gateway_decisions` plain-INSERT race discipline). `execution_tokens` is a denormalised read-model, **never** a replay input.

**Tech Stack:** TypeScript on Cloudflare Workers (workerd) · D1 (SQLite) · Durable Objects · Cloudflare Workflows · `bpmn-moddle` · `feelin` (FEEL) · Vitest + `@cloudflare/vitest-pool-workers` (forced `EXECUTION_MODE=direct`).

---

## How to use this plan

This plan implements the approved design `docs/superpowers/specs/2026-06-13-m4-concurrency-design.md`. **Read that design once before starting** — every task cites the section it implements (e.g. "design §5.4"). When this plan and the design disagree, the design wins; fix the plan.

The work is sliced into **six layers that each ship working, testable software on their own** (mirroring how M3 shipped as TASK-38..47). Implement them **in order** — each builds on the last, and **governance is amended first** (the M3 ordering rule). Layer-to-blocker mapping is the design's §17 table.

| Layer | Ships | Carries design blockers |
|-------|-------|-------------------------|
| **L1** | Constitution 2.3.0 + profile flip + the SESE region validator. **No runtime.** | 6, 13, 14 |
| **L2** | Graph IR (region map) + `0007_tokens.sql` + token-frontier refactor (single-token = 1-element frontier, **no behaviour change**) + per-token guard migration + drive serialization. | 1, 2, 5, 11 |
| **L3** | `parallelGateway` AND: fan-out, multi-wait race, join barrier, branch-local vars + merge, frontier-empty completion, token-id forms. | 2, 3, 4, 7, 12 |
| **L4** | `inclusiveGateway` OR: recorded activation set, OR-join over the recorded subset, zero-activation default/`noPath`. | 7 |
| **L5** | Compensation of parallel branches: cohort capture, per-token terminators, straggler ledger-insert, lineage-ordered reverse, quiescence barrier, frontier-wide operator verbs. | 8, 9, 10 |
| **L6** | `MAX_CONCURRENT_TOKENS` + `STEP_BUDGET_SOFT` + R2 overlay offload + observability + inspection `tokens` array + openapi/docs/`check:docs` + manual Workflow-mode matrix + epic closure. | — |

**Conventions used throughout (already true in this codebase — match them exactly):**

- **Persistence builders** named `…Stmt` return a `D1PreparedStatement` and are composed into atomic `dbBatch(env.DB, [...])` transitions (persist-before-advance). `dbBatch` is `src/persistence/db.ts`.
- **Step keys / persistence keys carry the occurrence**: `svc-create:el#2`, `gw:el#1`, `wait-job:el#2`. The walk-local occurrence is from the in-memory `visits` counter, **never** a D1 row count.
- **A plain `INSERT` of a decider row** (gateway_decisions / timer_outcomes / **join_completions**) composed into the same batch as the advance is the race claim: a losing concurrent batch aborts wholesale on the PK and re-reads. See `src/persistence/gateway-decisions.ts:70-84`.
- **Tests** run `EXECUTION_MODE=direct`. Integration tests drive the pull plane via `tests/helpers.ts` (`publishAndStart`, `leaseAndComplete`, `drainSampleWorkers`, `leaseOne`, `publishMessage`, `get`, `post`). BPMN fixtures are inline XML strings in `tests/helpers.ts`.
- **Run after every code change:** `npm run typecheck`. **Run before every commit of a layer:** `npm run typecheck && npm run test && npm run check:docs`.
- **Commit messages** mirror the repo style: `feat(m4): …`, `test(m4): …`, `docs(m4): …`, ending with the existing `Co-Authored-By` trailer the repo uses (check `git log -1`).

---

## File Structure

**New files**

| File | Responsibility | Layer |
|------|----------------|-------|
| `src/bpmn/regions.ts` | Pure SESE region analysis: CFG build, dominators/post-dominators, split↔join matching, region/branch validation. Produces `RegionInfo[]` + region errors. No moddle, no runtime. | L1 |
| `migrations/0007_tokens.sql` | `execution_tokens` read-model + `join_arrivals` + `join_completions` append-only facts + `gateway_decisions.activated_flow_ids`. Additive over `0006_timers.sql`. | L2 |
| `src/persistence/tokens.ts` | Statement builders + reads for `execution_tokens`, `join_arrivals`, `join_completions`; token-id helpers; overlay (de)serialisation. | L2/L3 |
| `src/runtime/frontier.ts` | In-memory `Token`/`Frontier` model, the deterministic DFS reconstruction, the wait collector, and the branch-scope variable resolver. | L2/L3 |
| `src/runtime/regions-runtime.ts` | Split fan-out, join arrival/completion claim, deterministic merge-at-join (AND + OR). | L3/L4 |
| `src/persistence/drive-lock.ts` | D1-backed per-instance advisory drive lock (direct-mode serialization). | L2 |
| `tests/unit/regions.test.ts` | Pure SESE validator unit tests. | L1 |
| `tests/integration/parallel-gateway.test.ts` | AND split/join, branch-local vars, frontier completion. | L3 |
| `tests/integration/inclusive-gateway.test.ts` | OR split/join, default, zero-activation. | L4 |
| `tests/integration/parallel-compensation.test.ts` | Straggler-catching reverse pass, quiescence barrier. | L5 |
| `tests/integration/parallel-caps.test.ts` | `concurrencyLimit` / `stepBudget`. | L6 |
| `tests/integration/migration-0007-tokens.test.ts` | Migration shape assertions (mirrors `migration-0004-conditional.test.ts`). | L2 |
| `specs/002-saga-orchestrator/m4-constitution-check.md` | Two-gate constitution record (mirrors `m3-constitution-check.md`). | L1 |

**Modified files**

| File | Change | Layer |
|------|--------|-------|
| `.specify/memory/constitution.md` | 2.2.0 → 2.3.0: Principle I accepted-set widens (parallel/inclusive, SESE); Principle VI per-causal-chain; multi-token completion; Sync Impact Report. | L1 |
| `src/bpmn/profile.ts` | Move `ParallelGateway`/`InclusiveGateway` out of `DEFERRED_GATEWAY_REASONS` into `SUPPORTED_NODE_TYPES`; keep `ComplexGateway` deferred. | L1 |
| `src/bpmn/graph.ts` | `NodeType`/`ElementType` add `parallelGateway`/`inclusiveGateway`; `ExecutionGraph` adds `regions?`. | L1/L2 |
| `src/bpmn/validator.ts` | Classify parallel/inclusive; add them to the multi-out allow-list; inclusive split condition/default rules; call `validateRegions` as a dedicated pass; write `regions` into the graph. | L1 |
| `src/runtime/engine.ts` | Frontier rewalk; split/join dispatch; multi-wait race; frontier-empty completion; `MAX_CONCURRENT_TOKENS`; `STEP_BUDGET_SOFT`. | L2/L3/L6 |
| `src/runtime/incidents.ts` | `parkWaiting` per-token guard; `concurrencyLimit`/`stepBudget` incident helpers. | L2/L6 |
| `src/runtime/intermediate-timer.ts` | `planIntermediateCatchFire` per-token guard. | L2 |
| `src/runtime/event-gateway.ts` | `planEventGatewayTimerFire` per-token guard. | L2 |
| `src/runtime/compensation.ts` | Cohort capture, lineage-quiescence-ordered reverse, ledger-empty-AND-tokens-terminal barrier, straggler ledger-insert. | L5 |
| `src/runtime/forward-task.ts` | `terminateUnleasableJob` cohort relaxation; lease-expiry terminator. | L5 |
| `src/persistence/saga.ts` | `selectScopeStepsForCompensation` lineage anti-join; docstring fix. | L5 |
| `src/persistence/instances.ts` | `IncidentKind` += `concurrencyLimit`, `stepBudget`. | L6 |
| `src/persistence/gateway-decisions.ts` | `activated_flow_ids` column read/write. | L4 |
| `src/index.ts` | `handleGetInstance` `tokens` array; `handleCancelInstance` frontier-wide sweep + non-eager region abandon. | L5/L6 |
| `src/contracts/api.ts` | `ProcessInstanceInspection.tokens`; `InstanceStatusValue` unchanged. | L6 |
| `src/durable-objects/job-scheduler.ts` | (none — re-used as the lease-expiry terminator DO via existing `armTimer`/alarm). | L5 |
| `src/persistence/jobs.ts` | `failLeasedJobConditional` (lease-expiry terminator claim). | L5 |
| `wrangler.jsonc` | `workflows.limits.steps = 25000`; R2 binding `OVERLAYS`. | L6 |
| `specs/002-saga-orchestrator/contracts/openapi.yaml` | `Incident.kind` enum += two kinds; `ProcessInstance`/inspection `tokens`. | L6 |
| `docs/bpmn/03-gateways.md`, `07-execution-semantics.md`, `09-easy-bpmn-profile.md` | Flip parallel/inclusive to shipped; origin-branch join wording. | L1/L6 |
| `scripts/check-docs.mjs` | `MAX_CONCURRENT_TOKENS`/`STEP_BUDGET_SOFT` constant-sync; gateway-pointer flip; enum equality covers the two new kinds. | L1/L6 |

---

## Phase L1 — Governance, profile flip, SESE region validator (no runtime)

**Ships:** A published M4 file with `parallelGateway`/`inclusiveGateway` is *accepted-and-validated* (or rejected with element-id reasons when its concurrent region is not block-structured/SESE). **Zero runtime** — the engine still rejects nothing it accepted before and runs nothing new. Carries blockers **6** (strong single-exit), **13** (branch confinement), **14** (same-message rejection).

> **Why governance first:** the constitution gates publish-profile scope. Per the M3 ordering rule, amend `constitution.md` and the profile docs **before** the validator flip ships, so the accepted-set never runs ahead of governance.

### Task L1.1: Constitution 2.3.0 + M4 constitution-check record

**Files:**
- Modify: `.specify/memory/constitution.md`
- Create: `specs/002-saga-orchestrator/m4-constitution-check.md`

- [ ] **Step 1: Read the current constitution and the M3 check record**

Run: `sed -n '1,40p' .specify/memory/constitution.md && echo '---M3 CHECK---' && cat specs/002-saga-orchestrator/m3-constitution-check.md`
Note the version header line, Principle I (accepted construct set), Principle VI (compensation order), the MVP-scope exclusion line, and the Sync Impact Report format.

- [ ] **Step 2: Bump the version + Sync Impact Report**

Edit the version header `2.2.0` → `2.3.0` and prepend a Sync Impact Report block (match the M3 one's shape) stating: MINOR bump; Principle I accepted-set widens with `parallelGateway` (AND) and `inclusiveGateway` (OR), **block-structured (SESE) only**, no-custom-notation / XSD-valid / round-trippable clause unchanged; `complexGateway` and `terminate` end stay excluded; MVP-scope exclusion trims `parallel`/`inclusive` from the gateway line; Principle VI redefined per causal chain; multi-token (frontier-empty) completion rule added.

- [ ] **Step 3: Amend Principle I (accepted set)**

In Principle I, add to the accepted gateway list: "`parallelGateway` and `inclusiveGateway`, **block-structured only** — every split is paired with exactly one matching join of the same type forming a single-entry/single-exit (SESE) region, validated at publish." Keep `complexGateway` and `terminate` end explicitly excluded.

- [ ] **Step 4: Amend Principle VI (compensation order)**

Replace the unqualified "reverse order of completion" wording with: "Compensation runs in reverse order of completion **within each causal chain (a token lineage)**; order **between concurrent branches is unconstrained**. A straggler completing after a parallel scope began compensating is still ledgered and compensated (at-least-once, idempotent) and, within its lineage, before any causally-earlier step." Add the **multi-token completion rule**: "an instance completes only when zero tokens remain in the frontier." Leave the at-least-once / idempotent clauses unchanged.

- [ ] **Step 5: Trim the MVP-scope exclusion line**

Find the MVP-scope line that lists `parallel`/`inclusive`/`complex`/`eventBased` gateways as out-of-scope and remove `parallel`/`inclusive` from it (leave `complex`).

- [ ] **Step 6: Write the two-gate constitution-check record**

Create `specs/002-saga-orchestrator/m4-constitution-check.md` mirroring `m3-constitution-check.md`: a **Before-Phase-0** gate evaluated against **v2.2.0** (the accepted set did not yet include parallel/inclusive) and an **After-Phase-1** gate against **v2.3.0** (it now does, SESE-gated), with a per-principle confirmation line for I–VI and a Complexity-Tracking note that the SESE block-structure restriction is the rejected-simpler-alternative to free concurrency.

- [ ] **Step 7: Commit**

```bash
git add .specify/memory/constitution.md specs/002-saga-orchestrator/m4-constitution-check.md
git commit -m "docs(m4): constitution 2.3.0 — parallel/inclusive (SESE) + Principle VI per-causal-chain + multi-token completion"
```

### Task L1.2: Widen the graph IR node types (compile-time only)

**Files:**
- Modify: `src/bpmn/graph.ts`

- [ ] **Step 1: Add the two node types**

In `src/bpmn/graph.ts`, add `| "parallelGateway"` and `| "inclusiveGateway"` to **both** the `ElementType` union (after `"eventBasedGateway"`) and the `NodeType` union (after `"eventBasedGateway"`). Add a one-line doc comment on each mirroring the existing `eventBasedGateway` comment: "M4 concurrency — a split fans out concurrent tokens; `next` is null, the engine reads `outgoing[]` (split) or the recorded join facts (join)."

- [ ] **Step 2: Add the region map to `ExecutionGraph`**

In `graph.ts`, define and export the region-info type and add an optional field to `ExecutionGraph`:

```typescript
/**
 * One block-structured concurrent region (M4 design §4.1/§7), keyed by its split
 * id. Persisted in the graph IR (parsed_profile) at publish, so the engine never
 * recomputes split↔join matching or branch order from the live graph: `type`
 * picks the AND/OR join semantics, `branchFlowIds` is the split's outgoing flow
 * ids in DOCUMENT ORDER (the deterministic merge + OR-wait order), and
 * `enclosingScopeId` is the process id or transaction id the region lives in.
 */
export interface RegionInfo {
  splitId: string;
  joinId: string;
  type: "and" | "or";
  branchFlowIds: string[];
  enclosingScopeId: string;
}
```

Add to `ExecutionGraph` (after `errors?`): `/** Concurrent regions keyed by split id (M4); absent on non-concurrent graphs. */ regions?: Record<string, RegionInfo>;`

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (unions widened; `regions` optional, no consumer yet). If `validator.ts`'s `buildGraph` `node.type` switch becomes non-exhaustive anywhere, that is expected — the new types are not yet produced; no error should appear because nothing narrows on them.

- [ ] **Step 4: Commit**

```bash
git add src/bpmn/graph.ts
git commit -m "feat(m4): graph IR — parallel/inclusive node types + region map field"
```

### Task L1.3: The pure SESE region validator — failing tests first

**Files:**
- Create: `tests/unit/regions.test.ts`

> The region validator is a **pure function** over the classification data the validator already builds (`nodes`, `flows`, `outgoing`, `incoming`). We TDD it in isolation first (no moddle), then wire it into `validator.ts` (Task L1.5). The unit test calls `validateRegions` directly with hand-built inputs.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/regions.test.ts`. These pin the algorithm (design §4.1 rules 1–11). `mkNode`/`mkFlow`/`build` are local helpers that assemble the `RegionInput` shape Task L1.4 defines.

```typescript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/regions.test.ts`
Expected: FAIL — `Cannot find module '../../src/bpmn/regions'`.

### Task L1.4: Implement `validateRegions` (the SESE pass)

**Files:**
- Create: `src/bpmn/regions.ts`

- [ ] **Step 1: Implement the module**

Create `src/bpmn/regions.ts`. This is a self-contained pure module: build a CFG with a virtual `SOURCE`/`SINK` and boundary edges, compute dominators and post-dominators (iterative Cooper–Harvey–Kennedy), match each split to `ipdom(split)`, and validate the design §4.1 rules. It emits `{ reason, elementId }` errors and a `Record<splitId, RegionInfo>`.

```typescript
// Pure SESE region analysis (M4-L1, design §4.1). No moddle, no runtime.
//
// Validates that every parallelGateway/inclusiveGateway split is paired with
// exactly one matching join of the SAME type forming a single-entry/single-exit
// (SESE) region, and produces the region map the engine persists. Operates on the
// classification data validator.ts already builds for one scope.

const VIRTUAL_SOURCE = " SOURCE";
const VIRTUAL_SINK = " SINK";

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

    // Rule 6 — no uncontrolled merge: inside the region, only the join (or an
    // exclusiveGateway pass-through merge) may have >1 incoming token flow.
    for (const x of members) {
      if (x === j || x === s.id) continue;
      const xNode = nodeById.get(x);
      if (xNode?.type === "boundaryEvent") continue;
      const inc = (incoming.get(x) ?? []).filter(inScope);
      if (inc.length > 1 && xNode?.type !== "exclusiveGateway") {
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
```

> **Note (rule 8 cycle, rule 10 same-message):** rule 8 (no region-crossing cycle) is **subsumed** by branch confinement above — a back-edge whose endpoints straddle the join violates the confinement/post-dominator check. Rule 10 (concurrent same-message rejection) needs message names, which live on `NodeInfo.messageName`; it is implemented as a **separate** validator pass in Task L1.6 (it spans regions, not one region's CFG).

- [ ] **Step 2: Run the unit tests**

Run: `npx vitest run tests/unit/regions.test.ts`
Expected: PASS (all cases). If the nested-region test fails on region count, verify `splits` only includes >1-outgoing gateways and `dominators` numbers vertices from the right entry.

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/bpmn/regions.ts tests/unit/regions.test.ts
git commit -m "feat(m4): pure SESE region validator (dominators, single-exit, branch confinement) + unit tests"
```

### Task L1.5: Wire the profile flip + classification + region pass into the validator — failing tests first

**Files:**
- Modify: `tests/unit/bpmn-validator.test.ts`
- Modify: `tests/helpers.ts` (add fixtures)

- [ ] **Step 1: Add M4 fixtures to `tests/helpers.ts`**

Append these exported fixtures (after `MULTI_INSTANCE_BPMN`). They are the accept/reject corpus for L1 and the run corpus for L3/L4.

```typescript
/** Balanced AND region: fork → {reserve-stock, authorize-payment} → join. ACCEPTED from M4-L1. */
export const PARALLEL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_par" targetNamespace="x">
  <bpmn:process id="P_par" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>s0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="fork"/>
    <bpmn:parallelGateway id="fork"><bpmn:incoming>s0</bpmn:incoming><bpmn:outgoing>f1</bpmn:outgoing><bpmn:outgoing>f2</bpmn:outgoing></bpmn:parallelGateway>
    <bpmn:sequenceFlow id="f1" sourceRef="fork" targetRef="A"/>
    <bpmn:sequenceFlow id="f2" sourceRef="fork" targetRef="B"/>
    <bpmn:serviceTask id="A" name="Reserve"><bpmn:extensionElements><easy-bpmn:taskDefinition type="reserve-stock"/></bpmn:extensionElements><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>j1</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:serviceTask id="B" name="Authorize"><bpmn:extensionElements><easy-bpmn:taskDefinition type="authorize-payment"/></bpmn:extensionElements><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>j2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:parallelGateway id="join"><bpmn:incoming>j1</bpmn:incoming><bpmn:incoming>j2</bpmn:incoming><bpmn:outgoing>s1</bpmn:outgoing></bpmn:parallelGateway>
    <bpmn:sequenceFlow id="j1" sourceRef="A" targetRef="join"/>
    <bpmn:sequenceFlow id="j2" sourceRef="B" targetRef="join"/>
    <bpmn:sequenceFlow id="s1" sourceRef="join" targetRef="C"/>
    <bpmn:serviceTask id="C" name="Confirm"><bpmn:extensionElements><easy-bpmn:taskDefinition type="confirm-order"/></bpmn:extensionElements><bpmn:incoming>s1</bpmn:incoming><bpmn:outgoing>s2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="s2" sourceRef="C" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>s2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/** Inclusive (OR) split with two FEEL-conditional branches + default, matching OR join. ACCEPTED from M4-L1. */
export const INCLUSIVE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_inc" targetNamespace="x">
  <bpmn:process id="P_inc" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>s0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="fork"/>
    <bpmn:inclusiveGateway id="fork" default="f_def"><bpmn:incoming>s0</bpmn:incoming><bpmn:outgoing>f_email</bpmn:outgoing><bpmn:outgoing>f_sms</bpmn:outgoing><bpmn:outgoing>f_def</bpmn:outgoing></bpmn:inclusiveGateway>
    <bpmn:sequenceFlow id="f_email" sourceRef="fork" targetRef="Email"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">wantsEmail = true</bpmn:conditionExpression></bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_sms" sourceRef="fork" targetRef="Sms"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">wantsSms = true</bpmn:conditionExpression></bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_def" sourceRef="fork" targetRef="Log"/>
    <bpmn:serviceTask id="Email"><bpmn:extensionElements><easy-bpmn:taskDefinition type="send-email"/></bpmn:extensionElements><bpmn:incoming>f_email</bpmn:incoming><bpmn:outgoing>j1</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:serviceTask id="Sms"><bpmn:extensionElements><easy-bpmn:taskDefinition type="send-sms"/></bpmn:extensionElements><bpmn:incoming>f_sms</bpmn:incoming><bpmn:outgoing>j2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:serviceTask id="Log"><bpmn:extensionElements><easy-bpmn:taskDefinition type="log-only"/></bpmn:extensionElements><bpmn:incoming>f_def</bpmn:incoming><bpmn:outgoing>j3</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:inclusiveGateway id="join"><bpmn:incoming>j1</bpmn:incoming><bpmn:incoming>j2</bpmn:incoming><bpmn:incoming>j3</bpmn:incoming><bpmn:outgoing>s1</bpmn:outgoing></bpmn:inclusiveGateway>
    <bpmn:sequenceFlow id="j1" sourceRef="Email" targetRef="join"/>
    <bpmn:sequenceFlow id="j2" sourceRef="Sms" targetRef="join"/>
    <bpmn:sequenceFlow id="j3" sourceRef="Log" targetRef="join"/>
    <bpmn:sequenceFlow id="s1" sourceRef="join" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>s1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/** AND split whose branch loses its token to a none end → join can never fire. REJECTED (non-SESE). */
export const PARALLEL_DEADLOCK_BPMN = PARALLEL_BPMN
  .replace('<bpmn:sequenceFlow id="j2" sourceRef="B" targetRef="join"/>', '<bpmn:sequenceFlow id="j2" sourceRef="B" targetRef="Eb"/>\n    <bpmn:endEvent id="Eb"><bpmn:incoming>j2</bpmn:incoming></bpmn:endEvent>')
  .replace('<bpmn:incoming>j1</bpmn:incoming><bpmn:incoming>j2</bpmn:incoming>', '<bpmn:incoming>j1</bpmn:incoming>');

/** AND split, INCLUSIVE join — mismatched join type. REJECTED. */
export const PARALLEL_MISMATCH_BPMN = PARALLEL_BPMN.replace(
  '<bpmn:parallelGateway id="join">', '<bpmn:inclusiveGateway id="join">',
).replace('<bpmn:outgoing>s1</bpmn:outgoing></bpmn:parallelGateway>\n    <bpmn:sequenceFlow id="j1"', '<bpmn:outgoing>s1</bpmn:outgoing></bpmn:inclusiveGateway>\n    <bpmn:sequenceFlow id="j1"');

/** Two parallel branches both wait on the SAME message name → broker key collision. REJECTED (blocker 14). */
export const PARALLEL_SAME_MESSAGE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D_pm" targetNamespace="x">
  <bpmn:message id="M" name="Approval"/>
  <bpmn:process id="P_pm" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>s0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="fork"/>
    <bpmn:parallelGateway id="fork"><bpmn:incoming>s0</bpmn:incoming><bpmn:outgoing>f1</bpmn:outgoing><bpmn:outgoing>f2</bpmn:outgoing></bpmn:parallelGateway>
    <bpmn:sequenceFlow id="f1" sourceRef="fork" targetRef="R1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="fork" targetRef="R2"/>
    <bpmn:receiveTask id="R1" messageRef="M"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>j1</bpmn:outgoing></bpmn:receiveTask>
    <bpmn:receiveTask id="R2" messageRef="M"><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>j2</bpmn:outgoing></bpmn:receiveTask>
    <bpmn:parallelGateway id="join"><bpmn:incoming>j1</bpmn:incoming><bpmn:incoming>j2</bpmn:incoming><bpmn:outgoing>s1</bpmn:outgoing></bpmn:parallelGateway>
    <bpmn:sequenceFlow id="j1" sourceRef="R1" targetRef="join"/>
    <bpmn:sequenceFlow id="j2" sourceRef="R2" targetRef="join"/>
    <bpmn:sequenceFlow id="s1" sourceRef="join" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>s1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
```

- [ ] **Step 2: Add failing validator unit tests**

In `tests/unit/bpmn-validator.test.ts`, add a describe block (import the new fixtures + `parseAndValidate`). Mirror the existing `deferredGatewayBpmn` rejection tests' style.

```typescript
import { PARALLEL_BPMN, INCLUSIVE_BPMN, PARALLEL_DEADLOCK_BPMN, PARALLEL_MISMATCH_BPMN, PARALLEL_SAME_MESSAGE_BPMN, deferredGatewayBpmn } from "../helpers";

describe("M4 concurrency profile", () => {
  it("accepts a balanced AND region and records the region map", async () => {
    const r = await parseAndValidate(PARALLEL_BPMN);
    expect(r.ok).toBe(true);
    expect(r.graph?.regions?.["fork"]).toMatchObject({ joinId: "join", type: "and", branchFlowIds: ["f1", "f2"] });
    expect(r.graph?.nodes["fork"].type).toBe("parallelGateway");
  });
  it("accepts a balanced OR region with conditional branches + default", async () => {
    const r = await parseAndValidate(INCLUSIVE_BPMN);
    expect(r.ok).toBe(true);
    expect(r.graph?.regions?.["fork"]).toMatchObject({ joinId: "join", type: "or" });
  });
  it("still rejects complexGateway with a roadmap pointer", async () => {
    const r = await parseAndValidate(deferredGatewayBpmn("complexGateway"));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.elementId === "G" && /complex/i.test(i.reason))).toBe(true);
  });
  it("rejects a deadlocking AND region (branch loses its token to an end)", async () => {
    const r = await parseAndValidate(PARALLEL_DEADLOCK_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /fork|region|single-exit|matching join/i.test(i.reason))).toBe(true);
  });
  it("rejects a mismatched join type", async () => {
    const r = await parseAndValidate(PARALLEL_MISMATCH_BPMN);
    expect(r.ok).toBe(false);
  });
  it("rejects two concurrent branches on the same message name (blocker 14)", async () => {
    const r = await parseAndValidate(PARALLEL_SAME_MESSAGE_BPMN);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /same message|broker key|distinct message/i.test(i.reason))).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/unit/bpmn-validator.test.ts -t "M4 concurrency"`
Expected: FAIL — parallel/inclusive still rejected via `DEFERRED_GATEWAY_REASONS`; `r.ok` is false for the accept cases and `regions` is undefined.

### Task L1.6: Implement the validator wiring

**Files:**
- Modify: `src/bpmn/profile.ts`
- Modify: `src/bpmn/validator.ts`

- [ ] **Step 1: Flip the profile entries**

In `src/bpmn/profile.ts`: delete the `"bpmn:ParallelGateway"` and `"bpmn:InclusiveGateway"` entries from `DEFERRED_GATEWAY_REASONS` (leave `"bpmn:ComplexGateway"`). Add to `SUPPORTED_NODE_TYPES`:

```typescript
  // M4 concurrency (TASK-…): block-structured AND/OR splits. The validator opens
  // them in its own classification + region-validation passes (SESE-gated); these
  // entries are the type mapping, not the accept gate.
  "bpmn:ParallelGateway": "parallelGateway",
  "bpmn:InclusiveGateway": "inclusiveGateway",
```

Update the `DEFERRED_GATEWAY_REASONS` doc comment so it no longer claims parallel/inclusive are deferred (only complex remains).

- [ ] **Step 2: Classify parallel/inclusive in `validator.ts`**

In `classifyContainer`, after the `eventBasedGateway` block (validator.ts ~line 596-614) and before the generic `SUPPORTED_NODE_TYPES[$type]` lookup, add:

```typescript
      // M4: parallelGateway (AND) / inclusiveGateway (OR). The split/join shape,
      // SESE block-structure, and (for inclusive) the condition/default rules are
      // validated in dedicated passes after adjacency is built. instantiate is
      // rejected here (instances start via the API only).
      if ($type === "bpmn:ParallelGateway" || $type === "bpmn:InclusiveGateway") {
        const nodeType = SUPPORTED_NODE_TYPES[$type]!;
        if (el.instantiate === true) {
          err(`Gateway '${id ?? ""}' has instantiate="true". Instances start via the API only; remove instantiate.`, id, localTypeName($type));
        }
        const info: NodeInfo = { id: id ?? "", type: nodeType, name: (el.name as string) ?? undefined, scopeId };
        if (nodeType === "inclusiveGateway") info.defaultFlowId = refId(el.default);
        nodes.push(info);
        continue;
      }
```

> **Note:** `NodeInfo.defaultFlowId` already exists (used by exclusiveGateway). Reuse it for the inclusive split's `default`. The graph-build step (Step 6) widens `defaultFlowByGateway` to include inclusive gateways.

- [ ] **Step 3: Add parallel/inclusive to the multi-out allow-list**

In the linearity check (validator.ts ~line 871), change the condition so parallel/inclusive may also have >1 outgoing token edge:

```typescript
        if (out.length > 1 && n.type !== "exclusiveGateway" && n.type !== "eventBasedGateway" && n.type !== "parallelGateway" && n.type !== "inclusiveGateway") {
```

- [ ] **Step 4: Inclusive split condition/default rules (reuse the XOR rule)**

The exclusive-gateway split rule block (validator.ts ~line 904-969) is keyed on `n.type !== "exclusiveGateway"`. Generalise it to also cover the **inclusive split** (a >1-out inclusiveGateway): change `if (n.type !== "exclusiveGateway") continue;` to `if (n.type !== "exclusiveGateway" && n.type !== "inclusiveGateway") continue;`, and in the two reject messages replace the literal `"exclusive gateway"` wording with a computed label `const gwLabel = n.type === "inclusiveGateway" ? "inclusive gateway" : "exclusive gateway";`. The per-flow FEEL parse, the default-must-not-carry-condition rule, and the default-ownership rule then apply identically. (An inclusive split with **no** conditions and just a default is allowed — same as exclusive.)

Also generalise the "conditions only leave an exclusiveGateway" per-flow rule (validator.ts ~line 761): `if (f.hasConditionElement && src.type !== "exclusiveGateway")` → `&& src.type !== "exclusiveGateway" && src.type !== "inclusiveGateway"`.

- [ ] **Step 5: The region pass + same-message rejection**

After the eventBasedGateway branch-rules block (validator.ts ~line 1339) and before the "Compensation handlers must live inside a transaction" check, add the region pass. Import at top: `import { validateRegions, type RegionInput, type RegionInfoOut } from "./regions";`.

```typescript
  // -------------------------------------------------------------------------
  // M4 SESE region validation (design §4.1): per scope, match each parallel/
  // inclusive split to its post-dominating join, validate strong single-exit,
  // branch confinement, bijection, laminar nesting, uncontrolled-merge. Runs as
  // its OWN pass after degree/linearity + gateway-condition, emitting region
  // errors with element ids (the reachability BFS below stays a backstop).
  // -------------------------------------------------------------------------
  const regionsByScope: Record<string, RegionInfoOut> = {};
  for (const sid of scopeIds) {
    const scopeNodesForRegion = nodes.filter((n) => n.scopeId === sid);
    const flowsForRegion = flows.filter((f) => f.scopeId === sid);
    const input: RegionInput = {
      scopeId: sid,
      scopeKind: scopeKindOf.get(sid)!,
      scopeNodes: scopeNodesForRegion as unknown as RegionInput["scopeNodes"],
      flows: flowsForRegion as unknown as RegionInput["flows"],
      outgoing,
      incoming,
      nodeById: nodeById as unknown as RegionInput["nodeById"],
    };
    const result = validateRegions(input);
    for (const e of result.errors) err(e.reason, e.elementId, "parallelGateway");
    Object.assign(regionsByScope, result.regions);
  }

  // Rule 10 — concurrent same-message rejection (blocker 14): two catch points
  // (receiveTask | message intermediateCatch | EBG message branch) on the SAME
  // message name that can be SIMULTANEOUSLY active (both inside a region's branch
  // set, or in two simultaneously-active regions) would collide on the broker key.
  // SESE guarantees branch element-disjointness, so simultaneity ⇔ "both are
  // reachable while some region is active". Conservative-but-sound: reject any two
  // catch points sharing a message name when at least one is inside ANY region.
  {
    const memberOfAnyRegion = new Set<string>();
    for (const r of Object.values(regionsByScope)) {
      // members are recomputed cheaply: a node is in r's region if its scope is r's
      // and it lies between split and join — approximate via the branch confinement
      // set already proven sound. Reuse validateRegions by collecting member ids it
      // implies through branchFlowIds reachability:
      const seen = new Set<string>();
      const queue = r.branchFlowIds.map((fid) => flows.find((f) => f.id === fid)?.target).filter(Boolean) as string[];
      while (queue.length) {
        const cur = queue.shift()!;
        if (cur === r.joinId || seen.has(cur)) continue;
        seen.add(cur);
        for (const t of outgoing.get(cur) ?? []) queue.push(t);
      }
      for (const m of seen) memberOfAnyRegion.add(m);
    }
    const byMessage = new Map<string, string[]>();
    for (const n of nodes) {
      if (n.messageName && (n.type === "receiveTask" || n.type === "intermediateCatchEvent")) {
        (byMessage.get(n.messageName) ?? byMessage.set(n.messageName, []).get(n.messageName)!).push(n.id);
      }
    }
    for (const [msg, ids] of byMessage) {
      if (ids.length > 1 && ids.some((id) => memberOfAnyRegion.has(id))) {
        err(`Message '${msg}' is awaited by ${ids.length} catch points (${ids.join(", ")}) that can be concurrently active inside a parallel/inclusive region — the broker permits one active subscription per message+correlationKey, so concurrent same-name waits collide. Use distinct message names.`, ids.find((id) => memberOfAnyRegion.has(id)) ?? ids[0], "receiveTask");
      }
    }
  }
```

- [ ] **Step 6: Write `regions` into the built graph + mark gateways `next: null`**

In `buildGraph`: (a) widen `defaultFlowByGateway` to include inclusive gateways — change the loop `if (n.type === "exclusiveGateway" && n.defaultFlowId)` to `if ((n.type === "exclusiveGateway" || n.type === "inclusiveGateway") && n.defaultFlowId)`; (b) widen the gateway `next: null` rule — change `n.type === "exclusiveGateway" || n.type === "eventBasedGateway"` to also `|| n.type === "parallelGateway" || n.type === "inclusiveGateway"`; (c) add `regions` to the returned graph: in the final `return { … }`, add `...(Object.keys(regionsByScope).length > 0 ? { regions: regionsByScope } : {})`. (`regionsByScope` is in closure scope — it is declared above `buildGraph`'s call site, so move its declaration above `const graph = processStart ? buildGraph(...)` if needed, or capture it; simplest: declare `regionsByScope` before the region pass which already precedes `buildGraph`.)

- [ ] **Step 7: Run the validator tests**

Run: `npx vitest run tests/unit/bpmn-validator.test.ts && npm run typecheck`
Expected: PASS — the M4 accept/reject cases pass and **no existing validator test regresses** (parallel/inclusive were only ever in rejection fixtures via `deferredGatewayBpmn`, which now only covers `complexGateway`/`eventBasedGateway`; confirm those two still reject).

- [ ] **Step 8: Commit**

```bash
git add src/bpmn/profile.ts src/bpmn/validator.ts tests/unit/bpmn-validator.test.ts tests/helpers.ts
git commit -m "feat(m4): validator opens parallel/inclusive (SESE-gated) + same-message rejection; profile flip"
```

### Task L1.7: Docs flip + `check:docs` gateway-pointer guard

**Files:**
- Modify: `docs/bpmn/03-gateways.md`, `docs/bpmn/07-execution-semantics.md`, `docs/bpmn/09-easy-bpmn-profile.md`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: See what the guard requires today**

Run: `npm run check:docs` (passes today) then read `scripts/check-docs.mjs` lines 159-170 — guard #5 requires `parallelGateway` and `inclusiveGateway` to appear on a line that also names milestone `M4` in `03-gateways.md`. After M4 ships they are **supported**, so the guard must flip to require a "shipped/supported" marker instead.

- [ ] **Step 2: Update the docs**

In `docs/bpmn/03-gateways.md`: move parallel/inclusive from the deferred list to the supported set; amend the join wording per design §6 — "wait for a token on every incoming flow" → "wait for a token from every **activated branch** of the matching split". Keep `exclusiveGateway`, `noPath`, `loopLimit` markers present (guard #5 also checks those).
In `docs/bpmn/07-execution-semantics.md`: flip parallel/inclusive from "out (M4)" to shipped.
In `docs/bpmn/09-easy-bpmn-profile.md`: move parallel/inclusive from "Still deferred" to the supported set; keep the canonical order-saga example markers (`id="OrderSaga"`, `id="reserveStock"`, `easy-bpmn:taskDefinition`, `errorRef="Err_shipping"`) and the "one Cloudflare Workflow per process instance" phrase intact.

- [ ] **Step 3: Flip the guard**

In `scripts/check-docs.mjs`, replace the `[["parallelGateway", "M4"], ["inclusiveGateway", "M4"]]` pointer check (lines ~160-170) with a positive "named in the supported set" check: require `03-gateways.md` to contain `parallelGateway` and `inclusiveGateway` AND no longer assert an `M4`-on-same-line pointer. Concretely, change the loop to:

```javascript
for (const needle of ["exclusiveGateway", "parallelGateway", "inclusiveGateway", "noPath", "loopLimit"]) {
  if (!gatewaysText.includes(needle)) {
    failures.push(`03-gateways.md is missing the gateway construct/incident marker: ${needle}`);
  }
}
// parallel/inclusive are SHIPPED in M4 — they must NOT be marked deferred anymore.
if (/\b(parallel|inclusive)\s+gateways?[^.]*\b(deferred|out of scope|M4 \(deferred\))/i.test(stripEmphasis(gatewaysText))) {
  failures.push(`03-gateways.md still marks parallel/inclusive gateways as deferred — they ship in M4.`);
}
```

(Delete the now-removed `[gateway, milestone]` loop and the `gatewayLines` variable if unused.)

- [ ] **Step 4: Run + commit**

```bash
npm run check:docs
git add docs/bpmn/03-gateways.md docs/bpmn/07-execution-semantics.md docs/bpmn/09-easy-bpmn-profile.md scripts/check-docs.mjs
git commit -m "docs(m4): flip parallel/inclusive to shipped; origin-branch join wording; check:docs guard"
```

### Task L1.8: L1 layer gate

- [ ] **Step 1: Full suite + guards**

Run: `npm run typecheck && npm run test && npm run check:docs`
Expected: ALL PASS. L1 is shippable: the publish profile accepts block-structured parallel/inclusive (region map recorded), rejects non-SESE/mismatched/same-message models with element ids, and runs no new runtime (the engine has no `parallelGateway` handler yet — but no instance can reach one, because no test starts a parallel model until L3, and a started parallel instance would hit the existing `non-token`/default branch; L2 makes the frontier safe first).

> **Guard:** do **not** start an instance of a parallel/inclusive model until L3. L1 only validates publish.

## Phase L2 — Token foundation: schema, persistence, guard migration, drive serialization (no behaviour change)

**Ships:** `0007_tokens.sql`; `src/persistence/tokens.ts`; the root token materialised lazily so every M1/M2/M3 instance carries one read-model token; the three scalar `current_element_id` staleness guards migrated to **per-token predicates**; a per-instance **drive lock** in direct mode. **The entire existing test suite stays green — this layer changes no observable behaviour.** Carries blockers **1** (per-token fire-guards), **2** (deterministic frontier seed), **5** (write-free fast-forward extended), **11** (read-model vs facts).

> **Scope boundary (read this):** L2 establishes the token *foundation* and migrates the correctness-critical guards. It does **not** yet drive multiple tokens — the engine still walks one path. The genuine multi-token **driving** (DFS fan-out + multi-wait race) lands in **L3**, where splits are first reachable at runtime. This split keeps L2 a verifiable no-behaviour-change change (full suite green = proof).

### Task L2.1: Migration `0007_tokens.sql` + migration test

**Files:**
- Create: `migrations/0007_tokens.sql`
- Create: `tests/integration/migration-0007-tokens.test.ts`

- [ ] **Step 1: Write the failing migration test**

Mirror `tests/integration/migration-0004-conditional.test.ts`. It asserts the new tables/columns exist by querying `sqlite_master` / `pragma_table_info` against the test D1 (migrations are auto-applied by `tests/apply-migrations.ts`).

```typescript
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("migration 0007_tokens", () => {
  it("creates execution_tokens with the read-model columns", async () => {
    const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info('execution_tokens')`).all<{ name: string }>();
    const names = (cols.results ?? []).map((r) => r.name);
    for (const c of ["token_id", "instance_id", "region_id", "region_activation", "parent_token_id", "branch_flow_id", "position_element_id", "status", "variables_overlay", "created_at", "updated_at"]) {
      expect(names).toContain(c);
    }
  });
  it("creates join_arrivals and join_completions with composite PKs", async () => {
    const t = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('join_arrivals','join_completions')`).all<{ name: string }>();
    expect((t.results ?? []).map((r) => r.name).sort()).toEqual(["join_arrivals", "join_completions"]);
  });
  it("adds gateway_decisions.activated_flow_ids and saga_steps.token_id", async () => {
    const g = await env.DB.prepare(`SELECT name FROM pragma_table_info('gateway_decisions')`).all<{ name: string }>();
    expect((g.results ?? []).map((r) => r.name)).toContain("activated_flow_ids");
    const s = await env.DB.prepare(`SELECT name FROM pragma_table_info('saga_steps')`).all<{ name: string }>();
    expect((s.results ?? []).map((r) => r.name)).toContain("token_id");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/migration-0007-tokens.test.ts`
Expected: FAIL — tables/column don't exist.

- [ ] **Step 3: Write the migration (copy the 0006 header style)**

Create `migrations/0007_tokens.sql`:

```sql
-- Token frontier (M4-L2) — additive D1 deltas over 0006_timers.sql.
--
-- execution_tokens is a DENORMALISED READ-MODEL: position_element_id + status are
-- recomputed by the deterministic rewalk each drive (operator inspection +
-- compensation cohort capture); they are NEVER read as a replay-decision input.
-- variables_overlay is authoritative mutable branch state, made idempotent by the
-- existing output_applied marker exactly like process_instances.variables.
--
-- join_arrivals / join_completions are the APPEND-ONLY join facts (the real replay
-- predicates): arrival via INSERT OR IGNORE (duplicate = no-op), completion via a
-- PLAIN INSERT composed into the advance batch (the gateway_decisions race
-- discipline — a losing concurrent batch aborts wholesale on the PK and re-reads).
--
-- CREATE … IF NOT EXISTS / additive ALTER, matching the 0004/0006 convention so a
-- partial/re-applied run is a no-op.

CREATE TABLE IF NOT EXISTS execution_tokens (
  token_id            TEXT PRIMARY KEY,                 -- root: '<inst>:#root'; branch: '<inst>:<split>#<activation>:<branchFlow>'
  instance_id         TEXT NOT NULL,
  region_id           TEXT,                             -- enclosing split id; NULL for root
  region_activation   INTEGER NOT NULL DEFAULT 0,       -- split's walk-local occurrence; 0 for root
  parent_token_id     TEXT,                             -- token consumed at the split; NULL for root
  branch_flow_id      TEXT,                             -- split out-flow taken; NULL for root/produced
  position_element_id TEXT NOT NULL,                    -- DERIVED read-model; not a replay input
  status              TEXT NOT NULL DEFAULT 'active',   -- active|waiting|arrivedAtJoin|consumed|merged|discarded
  variables_overlay   TEXT NOT NULL DEFAULT '{}',       -- JSON delta over parent; or {"__r2":"<key>"}
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_instance_status ON execution_tokens (instance_id, status);
CREATE INDEX IF NOT EXISTS idx_tokens_region          ON execution_tokens (instance_id, region_id, region_activation, status);

CREATE TABLE IF NOT EXISTS join_arrivals (
  instance_id    TEXT NOT NULL,
  join_id        TEXT NOT NULL,
  activation     INTEGER NOT NULL,
  branch_flow_id TEXT NOT NULL,
  arrived_at     TEXT NOT NULL,
  PRIMARY KEY (instance_id, join_id, activation, branch_flow_id)             -- INSERT OR IGNORE
);

CREATE TABLE IF NOT EXISTS join_completions (
  instance_id       TEXT NOT NULL,
  join_id           TEXT NOT NULL,
  activation        INTEGER NOT NULL,
  produced_token_id TEXT NOT NULL,
  decided_at        TEXT NOT NULL,
  PRIMARY KEY (instance_id, join_id, activation)                            -- PLAIN INSERT in the advance batch
);

-- Inclusive-split activation set (single chosen_flow_id cannot represent a subset).
ALTER TABLE gateway_decisions ADD COLUMN activated_flow_ids TEXT;            -- JSON array, document order; NULL for XOR/EBG/parallel

-- The branch token that produced a ledger row (M4-L5, design §8.4): NULL on the
-- single-token (M1-M3 / root) path. The lineage-quiescence-ordered reverse pass
-- uses it to compensate a step only once its branch lineage has no live token.
ALTER TABLE saga_steps ADD COLUMN token_id TEXT;
```

- [ ] **Step 4: Run the migration test**

Run: `npx vitest run tests/integration/migration-0007-tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/0007_tokens.sql tests/integration/migration-0007-tokens.test.ts
git commit -m "feat(m4): 0007_tokens migration — execution_tokens read-model + join facts + activated_flow_ids"
```

### Task L2.2: `src/persistence/tokens.ts` — builders, reads, token-id helpers

**Files:**
- Create: `src/persistence/tokens.ts`
- Create: `tests/unit/tokens.test.ts`

- [ ] **Step 1: Write failing unit tests for the id helpers**

```typescript
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
```

Run: `npx vitest run tests/unit/tokens.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `tokens.ts`**

```typescript
// execution_tokens read-model + join facts (M4-L2/L3). Statement builders + reads.
// execution_tokens.position_element_id/status are NEVER a replay input; the join
// facts (join_arrivals INSERT OR IGNORE, join_completions PLAIN INSERT) are.

import { dbAll, dbFirst, stmt } from "./db";
import { parseJson, toJson, type JsonObject } from "../util";

export type TokenStatus = "active" | "waiting" | "arrivedAtJoin" | "consumed" | "merged" | "discarded";
export const LIVE_TOKEN_STATUSES: TokenStatus[] = ["active", "waiting", "arrivedAtJoin"];

export interface TokenRow {
  token_id: string;
  instance_id: string;
  region_id: string | null;
  region_activation: number;
  parent_token_id: string | null;
  branch_flow_id: string | null;
  position_element_id: string;
  status: string;
  variables_overlay: string;
  created_at: string;
  updated_at: string;
}

export const rootTokenId = (instanceId: string) => `${instanceId}:#root`;
export const branchTokenId = (instanceId: string, splitId: string, activation: number, branchFlowId: string) =>
  `${instanceId}:${splitId}#${activation}:${branchFlowId}`;

export function parseTokenId(tokenId: string): { kind: "root" } | { kind: "branch"; splitId: string; activation: number; branchFlowId: string } | { kind: "unknown" } {
  const rest = tokenId.slice(tokenId.indexOf(":") + 1);
  if (rest === "#root") return { kind: "root" };
  const m = rest.match(/^(.+)#(\d+):(.+)$/);
  if (m) return { kind: "branch", splitId: m[1]!, activation: Number(m[2]), branchFlowId: m[3]! };
  return { kind: "unknown" };
}

/** Upsert a token row (read-model). Position/status are derived; safe to overwrite. */
export function upsertTokenStmt(db: D1Database, input: {
  tokenId: string; instanceId: string; regionId?: string | null; regionActivation?: number;
  parentTokenId?: string | null; branchFlowId?: string | null; positionElementId: string;
  status: TokenStatus; variablesOverlay?: JsonObject; now: string;
}): D1PreparedStatement {
  return stmt(db,
    `INSERT INTO execution_tokens
       (token_id, instance_id, region_id, region_activation, parent_token_id, branch_flow_id, position_element_id, status, variables_overlay, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token_id) DO UPDATE SET position_element_id = excluded.position_element_id, status = excluded.status, updated_at = excluded.updated_at`,
    [input.tokenId, input.instanceId, input.regionId ?? null, input.regionActivation ?? 0, input.parentTokenId ?? null,
     input.branchFlowId ?? null, input.positionElementId, input.status, toJson(input.variablesOverlay ?? {}), input.now, input.now]);
}

/** Plain INSERT of a branch token at split fan-out (design §5.4): the token_id PK is the race claim. */
export function insertBranchTokenStmt(db: D1Database, input: {
  tokenId: string; instanceId: string; regionId: string; regionActivation: number;
  parentTokenId: string; branchFlowId: string; positionElementId: string; variablesOverlay: JsonObject; now: string;
}): D1PreparedStatement {
  return stmt(db,
    `INSERT INTO execution_tokens
       (token_id, instance_id, region_id, region_activation, parent_token_id, branch_flow_id, position_element_id, status, variables_overlay, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [input.tokenId, input.instanceId, input.regionId, input.regionActivation, input.parentTokenId,
     input.branchFlowId, input.positionElementId, toJson(input.variablesOverlay), input.now, input.now]);
}

export function setTokenStatusStmt(db: D1Database, tokenId: string, status: TokenStatus, now: string): D1PreparedStatement {
  return stmt(db, `UPDATE execution_tokens SET status = ?, updated_at = ? WHERE token_id = ?`, [status, now, tokenId]);
}

export async function getToken(db: D1Database, tokenId: string): Promise<TokenRow | null> {
  return dbFirst<TokenRow>(db, `SELECT * FROM execution_tokens WHERE token_id = ?`, [tokenId]);
}
export async function listTokens(db: D1Database, instanceId: string): Promise<TokenRow[]> {
  return dbAll<TokenRow>(db, `SELECT * FROM execution_tokens WHERE instance_id = ? ORDER BY rowid`, [instanceId]);
}
export async function listLiveTokens(db: D1Database, instanceId: string): Promise<TokenRow[]> {
  return dbAll<TokenRow>(db, `SELECT * FROM execution_tokens WHERE instance_id = ? AND status IN ('active','waiting','arrivedAtJoin') ORDER BY rowid`, [instanceId]);
}
export const parseOverlay = (row: TokenRow): JsonObject => parseJson<JsonObject>(row.variables_overlay, {});

// ---- join facts ----
export function insertJoinArrivalStmt(db: D1Database, input: { instanceId: string; joinId: string; activation: number; branchFlowId: string; now: string }): D1PreparedStatement {
  return stmt(db, `INSERT OR IGNORE INTO join_arrivals (instance_id, join_id, activation, branch_flow_id, arrived_at) VALUES (?, ?, ?, ?, ?)`,
    [input.instanceId, input.joinId, input.activation, input.branchFlowId, input.now]);
}
export function insertJoinCompletionStmt(db: D1Database, input: { instanceId: string; joinId: string; activation: number; producedTokenId: string; now: string }): D1PreparedStatement {
  return stmt(db, `INSERT INTO join_completions (instance_id, join_id, activation, produced_token_id, decided_at) VALUES (?, ?, ?, ?, ?)`,
    [input.instanceId, input.joinId, input.activation, input.producedTokenId, input.now]);
}
export async function getJoinArrivals(db: D1Database, instanceId: string, joinId: string, activation: number): Promise<string[]> {
  const rows = await dbAll<{ branch_flow_id: string }>(db, `SELECT branch_flow_id FROM join_arrivals WHERE instance_id = ? AND join_id = ? AND activation = ?`, [instanceId, joinId, activation]);
  return rows.map((r) => r.branch_flow_id);
}
export async function getJoinCompletion(db: D1Database, instanceId: string, joinId: string, activation: number): Promise<{ produced_token_id: string } | null> {
  return dbFirst<{ produced_token_id: string }>(db, `SELECT produced_token_id FROM join_completions WHERE instance_id = ? AND join_id = ? AND activation = ?`, [instanceId, joinId, activation]);
}
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/tokens.test.ts && npm run typecheck
git add src/persistence/tokens.ts tests/unit/tokens.test.ts
git commit -m "feat(m4): tokens persistence — execution_tokens builders, join facts, token-id forms"
```

### Task L2.3: Per-token staleness guards (blocker 1)

**Files:**
- Modify: `src/runtime/incidents.ts` (`parkWaiting`)
- Modify: `src/runtime/intermediate-timer.ts` (`planIntermediateCatchFire`)
- Modify: `src/runtime/event-gateway.ts` (`planEventGatewayTimerFire`)

> These three currently read the scalar `inst.current_element_id` to decide whether a wake/park is still live (events/timers map confirms: `incidents.ts:32`, `intermediate-timer.ts:209`, `event-gateway.ts:583`). Under concurrency a sibling token may have moved the cursor, so the scalar read is stale. The **correct template already exists** in `boundary-timer.ts` (`planBoundaryTimerFire`): it keys on the per-`(element,occurrence)` job/subscription row, never `current_element_id`. Migrate the three to the same predicate.

- [ ] **Step 1: `parkWaiting` — guard on the live wait row, not the cursor**

In `src/runtime/incidents.ts`, `parkWaiting` takes `(env, instanceId, elementId, kind)`. Add an `occ` parameter and replace the scalar guard. First change the signature and the guard:

```typescript
export async function parkWaiting(env: Env, instanceId: string, elementId: string, occ: number, kind: "serviceTask" | "receiveTask"): Promise<void> {
  const inst = await loadInst(env, instanceId);
  // Idempotent re-park (M4 per-token): a rewalk landing on an already-parked wait
  // is WRITE-FREE. Guard on the LIVE per-(element,occurrence) row, never the scalar
  // current_element_id (a sibling token may have moved it — design §5.3).
  const job = kind === "serviceTask" ? await getForwardJob(env.DB, instanceId, elementId, occ) : null;
  const sub = kind === "receiveTask" ? await getSubscriptionForVisit(env.DB, instanceId, elementId, occ) : null;
  const alreadyParked = inst.status === "waiting" &&
    ((kind === "serviceTask" && job && (job.status === "created" || job.status === "locked")) ||
     (kind === "receiveTask" && sub?.status === "active"));
  if (alreadyParked) return;
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "serviceTaskWaiting", diagnostics: { kind } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now: nowIso() }),
  ]);
}
```

Add imports to `incidents.ts`: `import { getForwardJob, getSubscriptionForVisit } from "../persistence/instances";`. Update the **one** caller — `forward-task.ts:166` `parkWaiting(env, instanceId, elementId, "serviceTask")` → `parkWaiting(env, instanceId, elementId, occ, "serviceTask")` (the `occ` is in scope there).

> **Note:** the receiveTask park path does not call `parkWaiting` (it parks inline in `registerReceive` via `applyTransitionStmt`). The `receiveTask` branch of the guard is defensive for L3 symmetry; only the `serviceTask` caller exists today.

- [ ] **Step 2: `planIntermediateCatchFire` — guard on the timer decider, not the cursor**

In `src/runtime/intermediate-timer.ts` (~line 209), replace `if (inst.current_element_id !== timer.elementId) return { kind: "skip" };` with a decider-based per-token guard. The intermediate catch's decider is its `timer_outcomes` row; if it is already decided, skip. The existing module already reads it in its backstop — reuse `getTimerOutcome`:

```typescript
  // Per-token guard (M4, design §5.3): fire iff this catch visit is still the live
  // wait — i.e. no timer_outcomes decider claimed it yet. NEVER read the scalar
  // current_element_id (a concurrent sibling token may have moved it).
  if (await getTimerOutcome(env.DB, timer.timerId)) return { kind: "skip" };
```

Ensure `getTimerOutcome` is imported (it already is, used by the backstop). Remove the `inst.current_element_id` read. (Keep the `node`/`next`/`occ` derivation unchanged — the plain INSERT of `timer_outcomes 'fired'` in the fire batch remains the atomic claim, so a concurrent operator `/cancel` that settled the timer `cancelled` makes this INSERT abort and re-read as skip.)

- [ ] **Step 3: `planEventGatewayTimerFire` — drop the redundant cursor guard**

In `src/runtime/event-gateway.ts` (~line 583), the line above it (`~581`) already checks `if (await getGatewayDecision(env.DB, instanceId, gwId, occ)) return { kind: "skip" };` — for an EBG the `gateway_decisions` row **is** the sole per-token decider (events map confirms it). The scalar `if (inst.current_element_id !== gwId) return { kind: "skip" };` is therefore both stale-prone and redundant. **Delete** that line.

- [ ] **Step 4: Run the affected suites**

Run: `npx vitest run tests/integration/intermediate-timer.test.ts tests/integration/event-gateway.test.ts tests/integration/wait-cap-incidents.test.ts tests/integration/saga-pull-jobs.test.ts && npm run typecheck`
Expected: PASS — the guards now key on per-token rows; single-token behaviour is identical (one token ⇒ exactly one matching row).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/incidents.ts src/runtime/intermediate-timer.ts src/runtime/event-gateway.ts src/runtime/forward-task.ts
git commit -m "feat(m4): migrate current_element_id fire-guards to per-token predicates (blocker 1)"
```

### Task L2.4: Frontier seed + root-token read-model (no behaviour change)

**Files:**
- Create: `src/runtime/frontier.ts`
- Modify: `src/runtime/engine.ts`
- Create/append: `tests/integration/saga-topology.test.ts` (or a focused new test)

> L2 materialises a single **root token** read-model and writes it after each drive. The reconstruction here is the **single-token derivation** (read the instance; one token at `current_element_id`); L3 replaces the body with the deterministic DFS that descends splits. This keeps L2 behaviour-identical.

- [ ] **Step 1: Write the failing test (root token appears)**

Add to a new `tests/integration/token-readmodel.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, leaseAndComplete, mintWorkerToken, DEMO_BPMN } from "../helpers";
import { listTokens } from "../../src/persistence/tokens";

describe("root token read-model (M4-L2, no behaviour change)", () => {
  it("a single-token instance carries exactly one root token at its live position", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: "c1", variables: {} });
    const id = instance.body.instanceId;
    await leaseAndComplete(token, "external-check", { ok: true });
    const rows = await listTokens(env.DB, id);
    expect(rows.filter((r) => r.status !== "consumed" && r.status !== "merged")).toHaveLength(1);
    expect(rows[0].token_id).toBe(`${id}:#root`);
  });
});
```

Run: `npx vitest run tests/integration/token-readmodel.test.ts` → FAIL (no token rows written yet).

- [ ] **Step 2: Implement `frontier.ts` (single-token seed)**

```typescript
// In-memory token frontier (M4-L2 seed; L3 grows it to the deterministic DFS).
//
// L2: derive the single root token from the instance (one live position). L3
// replaces reconstructFrontier with a depth-first re-walk from startElementId that
// descends each split's outgoing[] in DOCUMENT ORDER, fast-forwarding applied
// visits write-free and forking at splits.

import type { Env } from "../env";
import type { ExecutionGraph } from "../bpmn/graph";
import { isTerminalInstanceStatus, nowIso } from "../util";
import { dbBatch } from "../persistence/db";
import { rootTokenId, upsertTokenStmt, setTokenStatusStmt, listLiveTokens } from "../persistence/tokens";
import { loadInst } from "./engine-shared";

export interface Token {
  tokenId: string;
  positionElementId: string;
  occurrence: number;
  regionId: string | null;
  regionActivation: number;
  branchFlowId: string | null;
  parentTokenId: string | null;
}

/** L2: the single live token derived from the instance cursor (or [] when terminal/at end). */
export async function reconstructFrontier(env: Env, graph: ExecutionGraph, instanceId: string): Promise<Token[]> {
  const inst = await loadInst(env, instanceId);
  if (isTerminalInstanceStatus(inst.status)) return [];
  const pos = inst.current_element_id;
  if (!pos || !graph.nodes[pos]) return [];
  return [{ tokenId: rootTokenId(instanceId), positionElementId: pos, occurrence: 0, regionId: null, regionActivation: 0, branchFlowId: null, parentTokenId: null }];
}

/** Write the read-model after a drive: upsert the frontier's tokens; mark vanished live tokens consumed. */
export async function syncFrontierReadModel(env: Env, instanceId: string, frontier: Token[]): Promise<void> {
  const now = nowIso();
  const live = await listLiveTokens(env.DB, instanceId);
  const liveById = new Map(live.map((r) => [r.token_id, r]));
  const stmts: D1PreparedStatement[] = [];
  const present = new Set<string>();
  for (const t of frontier) {
    present.add(t.tokenId);
    stmts.push(upsertTokenStmt(env.DB, {
      tokenId: t.tokenId, instanceId, regionId: t.regionId, regionActivation: t.regionActivation,
      parentTokenId: t.parentTokenId, branchFlowId: t.branchFlowId, positionElementId: t.positionElementId, status: "active", now,
    }));
  }
  for (const r of live) if (!present.has(r.token_id)) stmts.push(setTokenStatusStmt(env.DB, r.token_id, "consumed", now));
  if (stmts.length) await dbBatch(env.DB, stmts);
}
```

- [ ] **Step 3: Call `syncFrontierReadModel` at the end of every drive**

In `src/runtime/engine.ts` `runInstance`, wrap the return so the read-model is synced after the walk settles. Import `reconstructFrontier, syncFrontierReadModel` from `./frontier`. Replace the final `return loop(...)` with:

```typescript
  const result = await loop(env, instanceId, graph, opts.runStep, opts.waitFor, opts.incomingEvent);
  // M4-L2: refresh the token read-model from the settled cursor (single-token in
  // L2; L3 grows the frontier). Best-effort + non-fatal — it never blocks the drive.
  try {
    await syncFrontierReadModel(env, instanceId, await reconstructFrontier(env, graph, instanceId));
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", message: "frontier read-model sync failed", instanceId, error: err instanceof Error ? err.message : String(err) }));
  }
  return result;
```

(Leave the early `compensating`/terminal returns above untouched; the read-model is a best-effort denormalisation, not a correctness input.)

- [ ] **Step 4: Run the new test + a broad regression slice**

Run: `npx vitest run tests/integration/token-readmodel.test.ts tests/integration/demo-flow.test.ts tests/integration/saga-orchestration.test.ts tests/integration/loop-rewalk.test.ts && npm run typecheck`
Expected: PASS — the root token shows up; existing flows are byte-identical (the sync is additive).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/frontier.ts src/runtime/engine.ts tests/integration/token-readmodel.test.ts
git commit -m "feat(m4): root-token read-model + frontier seed (single-token, no behaviour change)"
```

### Task L2.5: Per-instance drive lock (direct-mode serialization, blocker for §10)

**Files:**
- Create: `src/persistence/drive-lock.ts`
- Modify: `src/runtime/engine.ts` (`runInstance` wraps direct-mode drives) — **only when `waitFor` is null** (direct mode).

> In workflow mode the single Workflow instance already serialises drives. In direct mode (the CI harness, and production inline-resume paths) concurrent worker callbacks can drive one instance at once, racing `saga_steps.seq`. A D1-backed advisory lock serialises them. Design §16 leaves the mechanism open; this is the chosen one.

- [ ] **Step 1: Write the lock module**

```typescript
// Per-instance advisory drive lock for direct-mode serialization (M4-L2, design §10).
// A D1 row IS the lock; INSERT OR IGNORE acquires, DELETE releases. A stale lock
// (holder crashed) is stolen after LOCK_TTL_MS so an instance can never wedge.

import { stmt } from "./db";

const LOCK_TTL_MS = 30_000;

export async function acquireDriveLock(db: D1Database, instanceId: string, now: string): Promise<boolean> {
  await stmt(db, `CREATE TABLE IF NOT EXISTS drive_locks (instance_id TEXT PRIMARY KEY, acquired_at TEXT NOT NULL)`, []).run();
  const res = await stmt(db, `INSERT OR IGNORE INTO drive_locks (instance_id, acquired_at) VALUES (?, ?)`, [instanceId, now]).run();
  if ((res.meta?.changes ?? 0) > 0) return true;
  // Steal if stale.
  const cutoff = new Date(new Date(now).getTime() - LOCK_TTL_MS).toISOString();
  const stolen = await stmt(db, `UPDATE drive_locks SET acquired_at = ? WHERE instance_id = ? AND acquired_at < ?`, [now, instanceId, cutoff]).run();
  return (stolen.meta?.changes ?? 0) > 0;
}

export async function releaseDriveLock(db: D1Database, instanceId: string): Promise<void> {
  await stmt(db, `DELETE FROM drive_locks WHERE instance_id = ?`, [instanceId]).run();
}

/** Run `fn` under the drive lock, retrying acquisition briefly; serialises concurrent direct-mode drives. */
export async function withDriveLock<T>(db: D1Database, instanceId: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 50; i++) {
    if (await acquireDriveLock(db, instanceId, new Date().toISOString())) {
      try { return await fn(); } finally { await releaseDriveLock(db, instanceId); }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  // Lock contended past the budget — proceed unlocked rather than dropping the
  // drive (the seq monotonicity is best-effort under extreme contention; the
  // join_completions/saga_steps unique discipline is the real correctness gate).
  return fn();
}
```

> **`new Date()` caveat:** workflow scripts forbid `new Date()`, but `drive-lock.ts` runs in the **Worker/engine** runtime (not a Workflow script), where it is allowed — same as every `nowIso()` call in the codebase.

- [ ] **Step 2: Wrap direct-mode drives**

In `engine.ts` `runInstance`, when `opts.waitFor === null` (direct mode), wrap the body in `withDriveLock`. Workflow mode (a real `waitFor`) is already serialised by the Workflow, so leave it unwrapped:

```typescript
export async function runInstance(env: Env, instanceId: string, opts: RunOptions): Promise<DriveResult> {
  if (opts.waitFor === null) {
    return withDriveLock(env.DB, instanceId, () => runInstanceInner(env, instanceId, opts));
  }
  return runInstanceInner(env, instanceId, opts);
}
```

Rename the existing `runInstance` body to `runInstanceInner` (same signature). Import `withDriveLock` from `../persistence/drive-lock`.

- [ ] **Step 3: Run the concurrency-sensitive suites**

Run: `npx vitest run tests/integration/duplicate-worker-callback.test.ts tests/integration/duplicate-message.test.ts tests/integration/saga-operator.test.ts && npm run typecheck`
Expected: PASS — serialised drives don't regress dedup/idempotency.

- [ ] **Step 4: Commit**

```bash
git add src/persistence/drive-lock.ts src/runtime/engine.ts
git commit -m "feat(m4): per-instance direct-mode drive lock (seq serialization, design §10)"
```

### Task L2.6: L2 layer gate (proof of no behaviour change)

- [ ] **Step 1: Full suite + guards**

Run: `npm run typecheck && npm run test && npm run check:docs`
Expected: **ALL PASS, zero regressions.** The token foundation (schema, persistence, root read-model, per-token guards, drive lock) is in place; behaviour is unchanged. L3 now builds the multi-token driver on top.

## Phase L3 — `parallelGateway` AND: fan-out, join barrier, branch-local vars, merge, frontier completion

**Ships:** A published AND model runs: `fork` fans tokens down every out-flow (all branches' jobs leasable at once), the matching `join` waits for a token on every branch then produces one token, branch-local variable overlays merge deterministically at the join, and the instance completes only when the frontier is empty. Carries blockers **2** (deterministic DFS), **3** (`region_activation` = split occurrence), **4** (atomic join claim), **7** (origin-branch keyed), **12** (token-id forms + nested frame stack).

> **Mode note (critical):** CI is `EXECUTION_MODE=direct`, where every live token drives to its **park point and returns** — no `Promise.race`, no suspend. Direct-mode integration tests fully exercise fan-out, join barrier, branch-local vars, merge, and completion (real parallelism is worker-side: all branches' jobs are leasable, the test drains them in any order). The **multi-wait `Promise.race`** is **workflow-mode-only** and is validated by the **manual matrix** (Task L6.7 / design §14) — it cannot run in CI. This task builds both, but only the direct-mode behaviour is asserted by `npm run test`.

### Task L3.1: `regions-runtime.ts` — fan-out, join claim, overlay merge

**Files:**
- Create: `src/runtime/regions-runtime.ts`
- Create: `tests/unit/overlay-merge.test.ts`

- [ ] **Step 1: Failing unit test for the deterministic merge**

```typescript
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
});
```

Run: `npx vitest run tests/unit/overlay-merge.test.ts` → FAIL.

- [ ] **Step 2: Implement `regions-runtime.ts`**

```typescript
// Concurrent-region runtime (M4-L3/L4): split fan-out, join arrival/completion
// claim, and the deterministic merge-at-join. All race-claimed via plain INSERT
// into join_completions composed in the advance batch (the gateway_decisions
// discipline). execution_tokens is a read-model; the join facts are the truth.

import type { Env } from "../env";
import type { ExecutionGraph, RegionInfo } from "../bpmn/graph";
import { mergeVariables, nowIso, type JsonObject } from "../util";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import { applyTransitionStmt } from "../persistence/instances";
import {
  branchTokenId, insertBranchTokenStmt, insertJoinArrivalStmt, insertJoinCompletionStmt,
  getJoinArrivals, getJoinCompletion, setTokenStatusStmt, upsertTokenStmt, getToken, parseOverlay, type TokenRow,
} from "../persistence/tokens";
import { loadInst } from "./engine-shared";

/** Deterministic merge (design §5.7): start from the parent overlay, then for each
 *  required branch in split-out-flow document order, shallow-assign its top-level
 *  keys (later branch wins). `branches` may be a subset (OR join); `order` is the
 *  region's stored branchFlowIds. */
export function mergeBranchOverlays(
  parentOverlay: JsonObject,
  order: string[],
  branches: { branchFlowId: string; overlay: JsonObject }[],
): JsonObject {
  const byFlow = new Map(branches.map((b) => [b.branchFlowId, b.overlay]));
  let merged: JsonObject = { ...parentOverlay };
  for (const flowId of order) {
    const ov = byFlow.get(flowId);
    if (ov) merged = mergeVariables(merged, ov);
  }
  return merged;
}

/** Fan out a split (design §5.4): plain-INSERT one branch token per activated flow,
 *  composed with the marker history + the split's own bookkeeping. The token_id PK
 *  is the race claim. `activatedFlowIds` is all out-flows (AND) or the recorded
 *  subset (OR). region_activation = the split's walk-local occurrence. */
export async function fanOutSplit(env: Env, instanceId: string, graph: ExecutionGraph, region: RegionInfo, splitId: string, activation: number, parentTokenId: string, parentOverlay: JsonObject, activatedFlowIds: string[], extraStmts: D1PreparedStatement[]): Promise<void> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: splitId, type: "regionActivated", diagnostics: { splitId, type: region.type, activation, activatedFlowIds } }),
  ];
  for (const flowId of activatedFlowIds) {
    const flow = graph.nodes[splitId]!.outgoing.find((f) => f.flowId === flowId)!;
    const tid = branchTokenId(instanceId, splitId, activation, flowId);
    stmts.push(
      insertBranchTokenStmt(env.DB, { tokenId: tid, instanceId, regionId: splitId, regionActivation: activation, parentTokenId, branchFlowId: flowId, positionElementId: flow.targetId, variablesOverlay: {}, now }),
      historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: splitId, type: "branchForked", diagnostics: { tokenId: tid, branchFlowId: flowId, target: flow.targetId, activation } }),
    );
  }
  await dbBatch(env.DB, [...extraStmts, ...stmts]);
}

/** Record one branch's arrival at a join (design §5.4): INSERT OR IGNORE; duplicate = no-op. */
export async function recordJoinArrival(env: Env, instanceId: string, joinId: string, activation: number, branchFlowId: string, branchTokenIdStr: string): Promise<void> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  await dbBatch(env.DB, [
    insertJoinArrivalStmt(env.DB, { instanceId, joinId, activation, branchFlowId, now }),
    setTokenStatusStmt(env.DB, branchTokenIdStr, "arrivedAtJoin", now),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: joinId, type: "branchArrivedAtJoin", diagnostics: { joinId, activation, branchFlowId, tokenId: branchTokenIdStr } }),
  ]);
}

/** Are all required branches present for this join activation? required = AND: all
 *  region.branchFlowIds; OR: the recorded activated subset (passed in). */
export async function joinBarrierSatisfied(env: Env, instanceId: string, joinId: string, activation: number, requiredFlowIds: string[]): Promise<boolean> {
  const arrived = new Set(await getJoinArrivals(env.DB, instanceId, joinId, activation));
  return requiredFlowIds.every((f) => arrived.has(f));
}

/** Claim the join (design §5.4): plain-INSERT join_completions in the SAME batch as
 *  the produced-token write, the source tokens → 'merged', and the advance to the
 *  join's out-flow. A losing concurrent batch aborts on the PK and re-reads. Returns
 *  the produced token's next element id (the join out-flow target). */
export async function claimJoinCompletion(env: Env, instanceId: string, graph: ExecutionGraph, region: RegionInfo, joinId: string, activation: number, requiredFlowIds: string[], parentTokenId: string): Promise<string> {
  const existing = await getJoinCompletion(env.DB, instanceId, joinId, activation);
  const joinNode = graph.nodes[joinId]!;
  const outTarget = joinNode.outgoing[0]!.targetId; // a join has exactly one out-flow (SESE)
  if (existing) return outTarget; // already produced → fast-forward

  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const parent = await getToken(env.DB, parentTokenId);
  const parentOverlay = parent ? parseOverlay(parent) : {};
  // Gather the required branch tokens' overlays in stored order.
  const branchTokens: { branchFlowId: string; overlay: JsonObject; tokenId: string }[] = [];
  for (const flowId of requiredFlowIds) {
    const tid = branchTokenId(instanceId, region.splitId, activation, flowId);
    const row = await getToken(env.DB, tid);
    branchTokens.push({ branchFlowId: flowId, overlay: row ? parseOverlay(row) : {}, tokenId: tid });
  }
  const mergedOverlay = mergeBranchOverlays(parentOverlay, region.branchFlowIds, branchTokens);

  const stmts: D1PreparedStatement[] = [
    insertJoinCompletionStmt(env.DB, { instanceId, joinId, activation, producedTokenId: parentTokenId, now }), // THE CLAIM
    // The produced token re-uses parentTokenId (SESE: region consumes the parent at
    // the split and returns one token to the enclosing scope at the join, §5.5).
    upsertTokenStmt(env.DB, { tokenId: parentTokenId, instanceId, regionId: parent?.region_id ?? null, regionActivation: parent?.region_activation ?? 0, parentTokenId: parent?.parent_token_id ?? null, branchFlowId: parent?.branch_flow_id ?? null, positionElementId: outTarget, status: "active", variablesOverlay: mergedOverlay, now }),
    ...branchTokens.map((b) => setTokenStatusStmt(env.DB, b.tokenId, "merged", now)),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: joinId, type: "joinCompleted", diagnostics: { joinId, activation, producedTokenId: parentTokenId, contributingTokenIds: branchTokens.map((b) => b.tokenId), outTarget } }),
  ];
  // Root produced token writes the merge up to process_instances.variables; a nested
  // region's merged overlay stays on its parent (enclosing-branch) token (§5.5/§6).
  if (parentTokenId === `${instanceId}:#root`) {
    stmts.push(applyTransitionStmt(env.DB, { instanceId, variables: mergedOverlay, currentElementId: outTarget, status: "running", now }));
  } else {
    stmts.push(applyTransitionStmt(env.DB, { instanceId, currentElementId: null, status: "running", now }));
  }
  await dbBatch(env.DB, stmts);
  return outTarget;
}

export { getToken, parseOverlay, type TokenRow };
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/overlay-merge.test.ts && npm run typecheck
git add src/runtime/regions-runtime.ts tests/unit/overlay-merge.test.ts
git commit -m "feat(m4): regions-runtime — fan-out, join arrival/completion claim, deterministic merge"
```

### Task L3.2: Branch-scoped variable resolution (blocker — read/write call sites, §5.7)

**Files:**
- Modify: `src/runtime/frontier.ts` (add `resolveScope`)
- Modify: `src/runtime/engine.ts` (`decideGateway` reads), `src/runtime/forward-task.ts` (job input + output write)

> Inside a region, a token's variables are its overlay chain (token → ancestor overlays → root `process_instances.variables`, nearest wins). Outside any region (frontier size 1), reads/writes resolve directly against root — preserving M0–M3. We thread the **active token** into the read/write call sites.

- [ ] **Step 1: Add `resolveScope` to `frontier.ts`**

```typescript
import { rootTokenId as _root, getToken, parseOverlay } from "../persistence/tokens";

/** Resolve a token's effective variable scope: root variables with each ancestor
 *  overlay layered on (nearest wins). For the root token this is just `rootVars`. */
export async function resolveScope(env: Env, instanceId: string, rootVars: JsonObject, tokenId: string): Promise<JsonObject> {
  if (tokenId === _root(instanceId)) return rootVars;
  // Walk parent chain root→token, layering overlays (nearest last so it wins).
  const chain: JsonObject[] = [];
  let cur: string | null = tokenId;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const row = await getToken(env.DB, cur);
    if (!row) break;
    chain.push(parseOverlay(row));
    cur = row.parent_token_id;
  }
  let scope: JsonObject = { ...rootVars };
  for (let i = chain.length - 1; i >= 0; i--) scope = { ...scope, ...chain[i] };
  return scope;
}
```

(Add `import { mergeVariables, type JsonObject } from "../util";` if not present.)

- [ ] **Step 2: Thread the active token into `decideGateway` (engine.ts:518)**

`decideGateway` currently does `const variables = parseJson<JsonObject>(inst.variables, {});`. Add an optional `activeTokenId?: string` parameter; when present, resolve the scope:

```typescript
export async function decideGateway(env: Env, instanceId: string, elementId: string, occ: number, node: GraphNode, activeTokenId?: string): Promise<GatewayOutcome> {
  // ... recorded fast-forward unchanged ...
  const inst = await loadInst(env, instanceId);
  const variables = activeTokenId
    ? await resolveScope(env, instanceId, parseJson<JsonObject>(inst.variables, {}), activeTokenId)
    : parseJson<JsonObject>(inst.variables, {});
  // ... rest unchanged ...
```

The recorded `gateway_decisions.variables_snapshot` then captures the **resolved** scope (already the `variables` it uses). Import `resolveScope` from `./frontier`.

- [ ] **Step 3: Thread the active token into forward-task input + output**

In `forward-task.ts`, `createForwardJob` reads `inst.variables` for the job input; `applyForwardCompletion` merges output into `inst.variables`. Add an `activeTokenId?: string` param to both `driveForwardServiceTask` and its callees. When the token is a **branch** token (not root), the job input is the resolved scope and the output is written to the **token's overlay** (not root `process_instances.variables`):

- `createForwardJob`: `const variables = activeTokenId && !isRoot ? await resolveScope(...) : parseJson(inst.variables, {})`.
- `applyForwardCompletion`: when branch token, replace the `applyTransitionStmt({ variables: merged, ... })` with: write the merge into the **token overlay** via `upsertTokenStmt(... variablesOverlay: mergedOverlay, status:'active', positionElementId: next ...)` and an `applyTransitionStmt({ currentElementId: null, status:'running' })` (no root variable write). For the root token keep the existing `applyTransitionStmt({ variables: merged, ... })`.

> Implementation detail: pass `activeTokenId` down from the frontier driver (Task L3.3). A `null`/root token keeps the **exact M0–M3 path** (the `isRoot` branch), so single-token instances are unchanged.

- [ ] **Step 4: Typecheck + targeted regression**

Run: `npm run typecheck && npx vitest run tests/integration/xor-gateway.test.ts tests/integration/saga-orchestration.test.ts`
Expected: PASS — `activeTokenId` defaults undefined ⇒ root path ⇒ unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/frontier.ts src/runtime/engine.ts src/runtime/forward-task.ts
git commit -m "feat(m4): branch-scoped variable resolution (overlay chain reads, token-overlay writes)"
```

### Task L3.3: The frontier DFS driver (fan-out, join, park-collect)

**Files:**
- Modify: `src/runtime/frontier.ts` (replace `reconstructFrontier` with the DFS; add the `WaitCollector`)
- Modify: `src/runtime/engine.ts` (`loop` calls the DFS driver)

> This replaces the scalar `loop()` walk with a recursive DFS that, from `startElementId`, fast-forwards applied visits, **fans out** at a split (descending `outgoing[]` in document order), **records arrivals + claims completions** at a join, and **drives or parks** each live token. It reuses the existing per-node drivers (`driveForwardServiceTask`, `driveReceiveTask`, `driveIntermediateCatch`, `driveEventBasedGateway`, `decideGateway`, bookkeeping) unchanged for the **leaf** drive; the DFS adds split/join handling and threads `activeTokenId`.

- [ ] **Step 1: Write the AND integration test FIRST (drives the design)**

Create `tests/integration/parallel-gateway.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, drainSampleWorkers, get, mintWorkerToken, leaseOne, authedPost, PARALLEL_BPMN } from "../helpers";
import { listTokens } from "../../src/persistence/tokens";

describe("parallelGateway AND (M4-L3, direct mode)", () => {
  it("fans out both branches (both jobs leasable at once), join waits for both, completes on empty frontier", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_BPMN, { correlationKey: "p1", variables: {} });
    const id = instance.body.instanceId;

    // After fan-out, BOTH branch jobs are leasable concurrently (real parallelism is worker-side).
    const a = await authedPost("/jobs/activate", token, { taskType: "reserve-stock", workerId: "w" });
    const b = await authedPost("/jobs/activate", token, { taskType: "authorize-payment", workerId: "w" });
    expect(a.body.jobs).toHaveLength(1);
    expect(b.body.jobs).toHaveLength(1);

    // Complete B first, then A — the join must wait for BOTH before producing.
    await authedPost(`/jobs/${b.body.jobs[0].jobId}/complete`, token, { lockToken: b.body.jobs[0].lockToken, outputVariables: { paid: true } });
    let inst = await get(`/instances/${id}`);
    expect(["running", "waiting"]).toContain(inst.body.status); // join not yet satisfied (A pending)
    await authedPost(`/jobs/${a.body.jobs[0].jobId}/complete`, token, { lockToken: a.body.jobs[0].lockToken, outputVariables: { reserved: true } });

    // Now the post-join confirm task is leasable; drain it to completion.
    await drainSampleWorkers({ taskTypes: ["confirm-order"], token });
    inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");

    const rows = await listTokens(env.DB, id);
    expect(rows.filter((r) => ["active", "waiting", "arrivedAtJoin"].includes(r.status))).toHaveLength(0); // frontier empty
    expect(rows.some((r) => r.branch_flow_id === "f1")).toBe(true);
    expect(rows.some((r) => r.branch_flow_id === "f2")).toBe(true);
  });

  it("merges branch-local variables at the join in document order (later branch wins a conflict)", async () => {
    const { instance, versionId } = await publishAndStart(PARALLEL_BPMN, { correlationKey: "p2", variables: { base: 1 } });
    const id = instance.body.instanceId;
    const token = await mintWorkerToken();
    // reserve-stock (f1) writes shared='A'; authorize-payment (f2) writes shared='B'; f2 is later in order.
    const a = await leaseOne(token, "reserve-stock");
    await authedPost(`/jobs/${a.jobId}/complete`, token, { lockToken: a.lockToken, outputVariables: { shared: "A", fromA: 1 } });
    const b = await leaseOne(token, "authorize-payment");
    await authedPost(`/jobs/${b.jobId}/complete`, token, { lockToken: b.lockToken, outputVariables: { shared: "B", fromB: 1 } });
    await drainSampleWorkers({ taskTypes: ["confirm-order"], token });
    const inst = await get(`/instances/${id}`);
    expect(inst.body.variables).toMatchObject({ base: 1, fromA: 1, fromB: 1, shared: "B" });
  });
});
```

Run: `npx vitest run tests/integration/parallel-gateway.test.ts` → FAIL (the engine has no split handler; the token hits the `non-token` default-branch incident, or fan-out never happens).

- [ ] **Step 2: Implement the DFS driver in `frontier.ts`**

Replace `reconstructFrontier` (the L2 seed) with the real DFS and add the `WaitCollector`. The DFS reuses the engine's per-node leaf drivers via a small dispatch interface passed in (to avoid an import cycle engine↔frontier). Add:

```typescript
export interface ParkedWait { name: string; workflowEventType: string; timeout: string; tokenId: string; }

export interface LeafDrivers {
  // Drive one live leaf node for `activeTokenId`; returns next element id, or null
  // if it parked (a wait), or a terminal signal. Implemented in engine.ts by
  // delegating to the existing drive* functions in PARK mode (never awaiting).
  driveLeaf(cur: string, scopeId: string | null, occ: number, activeTokenId: string, collector: WaitCollector): Promise<{ kind: "next"; next: string } | { kind: "parked" } | { kind: "incident" } | { kind: "completed" }>;
}

export class WaitCollector {
  readonly waits = new Map<string, ParkedWait>();
  add(w: ParkedWait) { if (!this.waits.has(w.name)) this.waits.set(w.name, w); }
  get size() { return this.waits.size; }
}

interface WalkResult { parked: boolean; advanced: boolean; completed: boolean; incident: boolean; }

/** One drive pass: DFS from start, fan out splits, settle joins, drive/park leaves.
 *  Returns whether anything advanced (→ caller re-walks) and the collected waits. */
export async function driveFrontier(env: Env, graph: ExecutionGraph, instanceId: string, drivers: LeafDrivers, maxConcurrent: number): Promise<{ result: WalkResult; collector: WaitCollector; tokenCount: number }> {
  const visits = new Map<string, number>();
  const collector = new WaitCollector();
  let advanced = false, completed = false, incident = false, liveTokens = 0;

  const nextOcc = (id: string) => { const o = visits.get(id) ?? 0; visits.set(id, o + 1); return o; };

  // Recursive branch walk. `tokenId` is the active token; `scopeId` the BPMN scope.
  async function walk(cur: string, scopeId: string | null, tokenId: string): Promise<void> {
    let node = graph.nodes[cur];
    while (node) {
      const occ = nextOcc(cur);
      const region = graph.regions?.[cur];

      // ---- SPLIT ----
      if (region && (node.type === "parallelGateway" || node.type === "inclusiveGateway")) {
        const { fanOut, activatedFlowIds } = await import("./regions-runtime").then((m) => ({ fanOut: m.fanOutSplit, activatedFlowIds: undefined })) as any; // see note
        const activated = await resolveActivatedFlows(env, graph, instanceId, region, cur, occ, tokenId); // AND: all; OR: recorded/evaluated
        if (liveTokens + activated.length > maxConcurrent) { incident = true; await raiseConcurrencyLimit(env, instanceId, cur, occ); return; }
        const fannedOut = await splitAlreadyFannedOut(env, instanceId, cur, occ, activated);
        if (!fannedOut) { await fanOutSplitFor(env, graph, instanceId, region, cur, occ, tokenId, activated); advanced = true; }
        for (const flowId of activated) {
          const childId = branchTokenId(instanceId, cur, occ, flowId);
          const childTarget = graph.nodes[cur]!.outgoing.find((f) => f.flowId === flowId)!.targetId;
          await walk(childTarget, scopeId, childId);
        }
        return; // the split's continuation is owned by the join below
      }

      // ---- JOIN ----
      const joinRegion = joinRegionFor(graph, cur);
      if (joinRegion && (node.type === "parallelGateway" || node.type === "inclusiveGateway") && tokenId !== rootTokenId(instanceId)) {
        const parsed = parseTokenId(tokenId);
        const activation = parsed.kind === "branch" ? parsed.activation : 0;
        const branchFlowId = parsed.kind === "branch" ? parsed.branchFlowId : "";
        const required = await requiredFlowsFor(env, graph, instanceId, joinRegion, activation);
        await recordJoinArrival(env, instanceId, joinRegion.joinId, activation, branchFlowId, tokenId);
        advanced = true;
        if (await joinBarrierSatisfied(env, instanceId, joinRegion.joinId, activation, required)) {
          const parentId = (await getToken(env.DB, tokenId))?.parent_token_id ?? rootTokenId(instanceId);
          const outTarget = await claimJoinCompletion(env, instanceId, graph, joinRegion, joinRegion.joinId, activation, required, parentId);
          // Continue from the join's out-flow in the ENCLOSING scope, on the produced (parent) token.
          cur = outTarget; node = graph.nodes[cur]; scopeId = joinRegion.enclosingScopeId === graph.processId ? null : joinRegion.enclosingScopeId;
          await walk(cur, scopeId, parentId);
        }
        return; // this branch halts (arrived); siblings/parent continue
      }

      // ---- LEAF (forward task / receive / catch / EBG / bookkeeping / end) ----
      const r = await drivers.driveLeaf(cur, scopeId, occ, tokenId, collector);
      if (r.kind === "completed") { completed = true; return; }
      if (r.kind === "incident") { incident = true; return; }
      if (r.kind === "parked") { liveTokens++; return; }
      // advanced one step → continue this branch
      advanced = true;
      cur = r.next; node = graph.nodes[cur];
    }
  }

  await walk(graph.startElementId, null, rootTokenId(instanceId));
  return { result: { parked: collector.size > 0, advanced, completed, incident }, collector, tokenCount: liveTokens };
}
```

> **Implementation notes for Step 2** (resolve before committing — these are small helpers in `regions-runtime.ts` / `frontier.ts`, not placeholders): `resolveActivatedFlows` returns `region.branchFlowIds` for an AND region (always all) and, for an OR region, the recorded `gateway_decisions.activated_flow_ids` (L4 — for L3 AND-only, implement the AND case and `throw` on OR so L4 fills it); `splitAlreadyFannedOut` checks `getToken(branchTokenId(...))` exists for the first activated flow; `fanOutSplitFor` calls `regions-runtime.fanOutSplit` (import it directly at top — drop the dynamic `import()` shown above, which was illustrative); `joinRegionFor(graph, cur)` finds the region whose `joinId === cur`; `requiredFlowsFor` = `region.branchFlowIds` (AND) or recorded subset (OR); `raiseConcurrencyLimit` is the L6 incident (for L3, `maxConcurrent` can be a large constant so it never trips — wire the real cap in L6). The `import { rootTokenId, branchTokenId, parseTokenId, getToken } from "../persistence/tokens"` and `import { recordJoinArrival, joinBarrierSatisfied, claimJoinCompletion, fanOutSplit } from "./regions-runtime"` go at the top.

- [ ] **Step 3: Implement `driveLeaf` + restructure `loop()` in `engine.ts`**

In `engine.ts`, extract the existing per-node-kind dispatch (the big `if (node.type === …)` chain inside `loop`) into a `driveLeaf(cur, scopeId, occ, activeTokenId, collector)` method that returns the `LeafDrivers` outcomes. Reuse the existing `enterStart`, `enterTransaction`, `commitTransaction`, `decideGateway`, `driveForwardServiceTask`, `driveReceiveTask`, `driveIntermediateCatch`, `driveEventBasedGateway`, end-event handling — but:
- pass `activeTokenId` to `decideGateway` and `driveForwardServiceTask` (Task L3.2);
- in **direct mode** (`waitFor === null`), a wait-reaching driver returns `{ kind: "parked" }` (it already wrote its park);
- in **workflow mode**, instead of `await waitFor(...)`, register a `ParkedWait` in `collector` and return `{ kind: "parked" }` (the await happens in the post-DFS race, Step 4).

Then replace `loop()`'s body with the re-walk loop:

```typescript
async function loop(env, instanceId, graph, runStep, waitFor, incomingEvent): Promise<DriveResult> {
  const drivers = makeLeafDrivers(env, instanceId, graph, runStep, waitFor, incomingEvent);
  while (true) {
    const { result, collector } = await driveFrontier(env, graph, instanceId, drivers, MAX_CONCURRENT_TOKENS);
    if (result.incident) return { status: "incident" };
    if (result.completed) return { status: "completed" };
    if (result.advanced) continue;        // something moved → re-walk from start
    if (collector.size === 0) {
      // No live waits and nothing advanced → frontier empty → completion (claimed
      // inside the end-event leaf). Defensive: settle completion if a token vanished.
      return await settleFrontierCompletion(env, instanceId, graph);
    }
    if (!waitFor) return { status: "waiting" };           // DIRECT mode parks; resume on next callback
    // WORKFLOW mode: race the parked waits (manual-matrix-validated, design §5.2/§14).
    const outcome = await raceParkedWaits(collector, waitFor);
    incomingEvent = matchKeyedEvent(outcome);             // apply at its matching token on the re-walk
  }
}
```

> `makeLeafDrivers`, `raceParkedWaits` (a `Promise.race` over `waitFor(w)` for each collected wait, each individually try/caught to `{kind:"timeout"}` so one branch's timeout never rejects the race — design §5.2), `settleFrontierCompletion` (Task L3.5), and `matchKeyedEvent` (returns the delivered `MessageEventPayload` so the re-walk applies it at the token whose subscription matches its `workflowEventType`+`correlationKey`, never positionally — §5.2) are concrete functions to add in this step. Keep them small; the heavy lifting is in the existing drive functions.

- [ ] **Step 4: Run the AND test (direct mode)**

Run: `npx vitest run tests/integration/parallel-gateway.test.ts && npm run typecheck`
Expected: PASS — both branches fan out (both jobs leasable), the join waits for both, overlays merge in document order, the instance completes on empty frontier.

- [ ] **Step 5: Broad regression (single-token unchanged)**

Run: `npm run test`
Expected: PASS — single-token instances reduce to a 1-element frontier (no `regions`, no split nodes), so `driveFrontier` walks exactly one branch from root via `driveLeaf`, identical to the old `loop()`. Fix any regression before proceeding (most likely: a bookkeeping node's occurrence or a `non-token` default landing).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/frontier.ts src/runtime/engine.ts tests/integration/parallel-gateway.test.ts
git commit -m "feat(m4): token-frontier DFS driver — fan-out, join barrier, multi-wait race scaffold (AND)"
```

### Task L3.4: Frontier-empty completion (last-token-out race, §5.6)

**Files:**
- Modify: `src/runtime/incidents.ts` (`completeInstance` → frontier-guarded) or add `settleFrontierCompletion` in `frontier.ts`/`engine.ts`

- [ ] **Step 1: Failing test — a `none` end on one branch must NOT complete the instance while a sibling is live**

Add to `parallel-gateway.test.ts` a case where one branch ends at the join but completion only fires once the produced token reaches the final end with no other live token. (The existing AND test already asserts `status === "completed"` only after both branches and the post-join task; extend with an explicit assertion that mid-flight status is never `completed`.)

```typescript
it("never completes while any token is live (last-token-out)", async () => {
  const token = await mintWorkerToken();
  const { instance } = await publishAndStart(PARALLEL_BPMN, { correlationKey: "p3", variables: {} });
  const id = instance.body.instanceId;
  const a = await leaseOne(token, "reserve-stock");
  await authedPost(`/jobs/${a.jobId}/complete`, token, { lockToken: a.lockToken, outputVariables: {} });
  const mid = await get(`/instances/${id}`);
  expect(mid.body.status).not.toBe("completed"); // B + join + confirm still pending
});
```

Run → should already pass if Task L3.3 is correct; if it FAILS (premature completion), implement Step 2.

- [ ] **Step 2: Implement the frontier-guarded end + completion settle**

Change the end-event leaf (in `driveLeaf`, the `endEvent` `node.endKind === "none"` non-transaction case) so it does **not** unconditionally call `completeInstance`. Instead: mark **this token** `consumed` (one batch) and run a **guarded** terminal transition conditioned on no other live token. Add to `engine.ts`:

```typescript
async function settleFrontierCompletion(env: Env, instanceId: string, graph: ExecutionGraph): Promise<DriveResult> {
  const live = await listLiveTokens(env.DB, instanceId);
  if (live.length > 0) return { status: "waiting" }; // a sibling is still live → not done
  const now = nowIso();
  // Guarded terminal UPDATE: only running/waiting → completed; the rows-changed
  // result decides which single drive emits the terminal event (belt-and-braces
  // even without the drive lock — design §5.6).
  const changed = await transitionStatusGuarded(env.DB, instanceId, ["running", "waiting"], "completed", now);
  if (changed > 0) {
    const inst = await loadInst(env, instanceId);
    await historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: inst.current_element_id ?? graph.endElementIds[0] ?? "", type: "instanceCompleted", diagnostics: {} }).run();
  }
  return { status: "completed" };
}
```

In the `endEvent` none-leaf: mark the active token `consumed` (via `setTokenStatusStmt` in the `completeInstance` batch), then return `{ kind: "completed" }` so the loop calls `settleFrontierCompletion`. For the **single-token (no regions)** case keep `completeInstance` writing the terminal directly (its `isTerminalInstanceStatus` guard already makes it idempotent) — guard the new frontier path on `graph.regions` being present so M0–M3 instances are byte-identical.

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/integration/parallel-gateway.test.ts && npm run test
git add src/runtime/engine.ts src/runtime/frontier.ts
git commit -m "feat(m4): frontier-empty completion (last-token-out guarded transition, §5.6)"
```

### Task L3.5: Nested regions + replay determinism (direct re-drive)

**Files:**
- Modify: `tests/integration/parallel-gateway.test.ts` (nested + replay cases)
- Add fixture `NESTED_PARALLEL_BPMN` to `tests/helpers.ts`

- [ ] **Step 1: Add the nested fixture**

In `tests/helpers.ts`, add `NESTED_PARALLEL_BPMN`: an outer AND `fork`/`join` where branch A is itself an inner AND `if`/`ij` region (structure mirrors the `validateRegions` nested-accept unit test: `fork → {if → {A1,A2} → ij, B} → join`). Give A1/A2/B distinct `taskDefinition` types.

- [ ] **Step 2: Failing nested + replay tests**

```typescript
it("nested regions: inner join output satisfies the enclosing branch at the outer join", async () => {
  const token = await mintWorkerToken();
  const { instance } = await publishAndStart(NESTED_PARALLEL_BPMN, { correlationKey: "n1", variables: {} });
  const id = instance.body.instanceId;
  await drainSampleWorkers({ taskTypes: ["inner-a1", "inner-a2", "outer-b", "after-join"], token });
  const inst = await get(`/instances/${id}`);
  expect(inst.body.status).toBe("completed");
});

it("re-drive reconstructs the same frontier (occurrence + region_activation stable)", async () => {
  const token = await mintWorkerToken();
  const { instance } = await publishAndStart(PARALLEL_BPMN, { correlationKey: "r1", variables: {} });
  const id = instance.body.instanceId;
  const a = await leaseOne(token, "reserve-stock");
  await authedPost(`/jobs/${a.jobId}/complete`, token, { lockToken: a.lockToken, outputVariables: {} });
  // Re-fetch (a read re-drives nothing) then complete B; the branch token ids must be stable.
  const rows1 = await listTokens(env.DB, id);
  const b = await leaseOne(token, "authorize-payment");
  await authedPost(`/jobs/${b.jobId}/complete`, token, { lockToken: b.lockToken, outputVariables: {} });
  await drainSampleWorkers({ taskTypes: ["confirm-order"], token });
  const rows2 = await listTokens(env.DB, id);
  // branch token ids embed splitId#activation:branchFlow — deterministic across drives.
  expect(rows2.filter((r) => r.branch_flow_id).map((r) => r.token_id).sort()).toEqual(
    expect.arrayContaining([`${id}:fork#0:f1`, `${id}:fork#0:f2`]),
  );
});
```

- [ ] **Step 3: Make them pass**

The nested case should work if the region-frame recursion (Task L3.3 `walk` recursing per branch, with the join continuing on the parent token in the enclosing scope) is correct. The most likely fix: ensure `claimJoinCompletion` for the **inner** join writes its merged overlay onto the **inner parent** (branch-A token), so the outer join then merges branch-A's overlay. Debug with `systematic-debugging` if it deadlocks (usually `requiredFlowsFor` returning the wrong branch set, or `joinRegionFor` matching the wrong region under nesting).

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/integration/parallel-gateway.test.ts && npm run typecheck
git add tests/integration/parallel-gateway.test.ts tests/helpers.ts
git commit -m "test(m4): nested AND regions + replay determinism (stable token ids / activation)"
```

### Task L3.6: L3 layer gate

- [ ] **Step 1: Full suite + guards**

Run: `npm run typecheck && npm run test && npm run check:docs`
Expected: ALL PASS. AND concurrency runs in direct mode: fan-out, join barrier, branch-local merge, nested regions, frontier completion, replay determinism. **The workflow-mode `Promise.race` path is implemented but unverified in CI** — record it for the Task L6.7 manual matrix.

## Phase L4 — `inclusiveGateway` OR: recorded activation, OR-join over the subset, zero-activation

**Ships:** A published OR model runs: the split activates the subset of branches whose FEEL conditions are true (recorded in `gateway_decisions.activated_flow_ids`), the matching join waits for exactly that recorded subset (origin-branch keyed), zero true conditions take the `default` (or raise terminal `noPath`), and an empty recorded subset produces the join's output token immediately. Carries blocker **7** (origin-branch keyed).

### Task L4.1: `gateway_decisions.activated_flow_ids` read/write

**Files:**
- Modify: `src/persistence/gateway-decisions.ts`

- [ ] **Step 1: Add the column to the INSERT + the view**

In `insertGatewayDecisionStmt`, add `activatedFlowIds?: string[] | null` to the input and the column to the SQL:

```typescript
  return stmt(db,
    `INSERT INTO gateway_decisions
       (decision_id, instance_id, element_id, occurrence, chosen_flow_id, is_default, evaluations, variables_snapshot, activated_flow_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.decisionId, input.instanceId, input.elementId, input.occurrence, input.chosenFlowId,
     input.isDefault ? 1 : 0, toJson(input.evaluations), input.variablesSnapshot ? toJson(input.variablesSnapshot) : null,
     input.activatedFlowIds ? toJson(input.activatedFlowIds) : null, input.now]);
```

Add `activated_flow_ids: string | null;` to `GatewayDecisionRow`, `activatedFlowIds: string[] | null;` to `GatewayDecisionView`, and in `mapGatewayDecision` add `activatedFlowIds: row.activated_flow_ids ? parseJson<string[]>(row.activated_flow_ids, []) : null,`.

> **Backward-compat:** every existing `insertGatewayDecisionStmt` caller (XOR in `engine.ts`, EBG in `event-gateway.ts`) omits `activatedFlowIds` ⇒ it binds `null` (the column default). No behaviour change for XOR/EBG.

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/persistence/gateway-decisions.ts
git commit -m "feat(m4): gateway_decisions.activated_flow_ids read/write (OR-split subset)"
```

### Task L4.2: OR split activation + OR join over the recorded subset

**Files:**
- Modify: `src/runtime/regions-runtime.ts` (`resolveActivatedFlows`, `requiredFlowsFor`)
- Modify: `tests/helpers.ts` (a zero-activation fixture)
- Create: `tests/integration/inclusive-gateway.test.ts`

- [ ] **Step 1: Write the failing OR integration tests**

```typescript
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, drainSampleWorkers, get, INCLUSIVE_BPMN } from "../helpers";
import { getGatewayDecision } from "../../src/persistence/gateway-decisions";

describe("inclusiveGateway OR (M4-L4, direct mode)", () => {
  it("activates only the true-condition branches; the join waits for exactly them", async () => {
    const { instance } = await publishAndStart(INCLUSIVE_BPMN, { correlationKey: "i1", variables: { wantsEmail: true, wantsSms: false } });
    const id = instance.body.instanceId;
    // Only the email branch + (NOT) default → activated = [f_email]. (default only when NONE true)
    await drainSampleWorkers({ taskTypes: ["send-email", "send-sms", "log-only"] });
    const dec = await getGatewayDecision(env.DB, id, "fork", 0);
    expect(dec?.activatedFlowIds).toEqual(["f_email"]);
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
  });

  it("activates two branches when two conditions are true; join waits for both", async () => {
    const { instance } = await publishAndStart(INCLUSIVE_BPMN, { correlationKey: "i2", variables: { wantsEmail: true, wantsSms: true } });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: ["send-email", "send-sms", "log-only"] });
    const dec = await getGatewayDecision(env.DB, id, "fork", 0);
    expect((dec?.activatedFlowIds ?? []).sort()).toEqual(["f_email", "f_sms"]);
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  it("takes the default when no condition is true", async () => {
    const { instance } = await publishAndStart(INCLUSIVE_BPMN, { correlationKey: "i3", variables: { wantsEmail: false, wantsSms: false } });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: ["send-email", "send-sms", "log-only"] });
    const dec = await getGatewayDecision(env.DB, id, "fork", 0);
    expect(dec?.activatedFlowIds).toEqual(["f_def"]);
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});
```

Run → FAIL (`resolveActivatedFlows` throws on OR — the L3 stub).

- [ ] **Step 2: Implement OR activation in `regions-runtime.ts`**

Replace the L3 OR stub. `resolveActivatedFlows` for an OR region: if a `gateway_decisions` row exists for `(instance, split, occ)` use its recorded `activatedFlowIds` (fast-forward, never re-evaluate); else evaluate each non-default out-flow's FEEL condition in document order against the **token-resolved scope**, collect the true set, fall back to `default` when empty, and **record** the decision (plain INSERT of the gateway_decisions row with `activatedFlowIds`) — this record is part of the fan-out batch so it shares the fan-out's atomic claim. For `noPath` (no condition true, no default) raise the terminal `noPath` incident (reuse `createIncident(..., "noPath")`).

```typescript
import { getGatewayDecision, insertGatewayDecisionStmt, type GatewayFlowEvaluation } from "../persistence/gateway-decisions";
import { evaluateCondition, normalizeFeelValue, ExpressionEvaluationError } from "./expressions";
import { resolveScope } from "./frontier";
import { newId, parseJson } from "../util";

export async function resolveActivatedFlows(env: Env, graph: ExecutionGraph, instanceId: string, region: RegionInfo, splitId: string, occ: number, activeTokenId: string): Promise<{ activated: string[]; recordStmts: D1PreparedStatement[]; incident?: boolean }> {
  if (region.type === "and") return { activated: region.branchFlowIds, recordStmts: [] };
  const recorded = await getGatewayDecision(env.DB, instanceId, splitId, occ);
  if (recorded?.activatedFlowIds) return { activated: recorded.activatedFlowIds, recordStmts: [] };

  const node = graph.nodes[splitId]!;
  const inst = await loadInst(env, instanceId);
  const scope = await resolveScope(env, instanceId, parseJson(inst.variables, {}), activeTokenId);
  const activated: string[] = [];
  const evaluations: GatewayFlowEvaluation[] = [];
  let defaultFlowId: string | null = null;
  for (const f of node.outgoing) {
    if (f.isDefault) { defaultFlowId = f.flowId; continue; }
    const expr = f.conditionExpression!;
    try {
      const e = evaluateCondition(expr, scope);
      evaluations.push({ flowId: f.flowId, expression: expr, result: e.taken, value: normalizeFeelValue(e.value) });
      if (e.taken) activated.push(f.flowId);
    } catch (err) {
      if (err instanceof ExpressionEvaluationError) { await createIncident(env, instanceId, splitId, 0, `inclusiveGateway '${splitId}' condition on flow '${f.flowId}' failed: ${err.message}`, { flowId: f.flowId, occurrence: occ }, "conditionFailure"); return { activated: [], recordStmts: [], incident: true }; }
      throw err;
    }
  }
  if (activated.length === 0 && defaultFlowId) activated.push(defaultFlowId);
  if (activated.length === 0) { await createIncident(env, instanceId, splitId, 0, `inclusiveGateway '${splitId}' activated no branch and has no default flow.`, { occurrence: occ, evaluations: evaluations.map((e) => ({ ...e })) }, "noPath"); return { activated: [], recordStmts: [], incident: true }; }

  const recordStmts = [insertGatewayDecisionStmt(env.DB, {
    decisionId: newId("gwd"), instanceId, elementId: splitId, occurrence: occ,
    chosenFlowId: activated[0]!, isDefault: activated.length === 1 && activated[0] === defaultFlowId,
    evaluations, variablesSnapshot: null, activatedFlowIds: activated, now: nowIso(),
  })];
  return { activated, recordStmts };
}

export async function requiredFlowsFor(env: Env, graph: ExecutionGraph, instanceId: string, region: RegionInfo, activation: number): Promise<string[]> {
  if (region.type === "and") return region.branchFlowIds;
  const dec = await getGatewayDecision(env.DB, instanceId, region.splitId, activation);
  // OR: the recorded subset, in stored document order.
  const set = new Set(dec?.activatedFlowIds ?? []);
  return region.branchFlowIds.filter((f) => set.has(f));
}
```

Import `createIncident` from `./incidents`. In the DFS driver (`frontier.ts` Task L3.3 Step 2), wire `resolveActivatedFlows`'s `recordStmts` into `fanOutSplit`'s `extraStmts` (so the OR activation record + the branch tokens commit atomically), and bail the branch when `incident` is true.

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/integration/inclusive-gateway.test.ts && npm run typecheck
git add src/runtime/regions-runtime.ts src/runtime/frontier.ts tests/integration/inclusive-gateway.test.ts tests/helpers.ts
git commit -m "feat(m4): inclusiveGateway OR — recorded activation subset, OR-join over the subset, default/noPath"
```

### Task L4.3: Empty-activated immediate produce + L4 gate

**Files:**
- Modify: `tests/integration/inclusive-gateway.test.ts`

- [ ] **Step 1: Edge — an OR join whose recorded subset is satisfiable produces exactly once**

The zero-true-with-default case (Task L4.2 test 3) already covers a single-branch activation. Add a guard test that the OR join never double-produces and never waits for a non-activated branch:

```typescript
it("the OR join produces exactly one token and ignores non-activated branches", async () => {
  const { instance } = await publishAndStart(INCLUSIVE_BPMN, { correlationKey: "i4", variables: { wantsEmail: true, wantsSms: false } });
  const id = instance.body.instanceId;
  await drainSampleWorkers({ taskTypes: ["send-email", "send-sms", "log-only"] });
  const inst = await get(`/instances/${id}`);
  expect(inst.body.status).toBe("completed");
  // No sms/log job was ever created (non-activated branches never forked).
  const hist = (await get(`/instances/${id}/history`)).body.events;
  expect(hist.some((e: any) => e.diagnostics?.taskType === "send-sms")).toBe(false);
});
```

> **Note (zero-activation with empty subset):** design §6.4 says "an OR-join whose recorded activated subset is empty produces its single output token immediately." With our validator requiring a `default` or raising `noPath`, the activated subset is **never empty** at runtime (a split always yields ≥1 branch). So `requiredFlowsFor` returning `[]` cannot happen for a fanned-out OR region; the immediate-produce path is unreachable-by-construction and needs no special case. (If a future relaxation allows empty activation, `joinBarrierSatisfied([])` already returns `true` ⇒ immediate completion — verify with a comment.)

- [ ] **Step 2: L4 gate**

Run: `npm run typecheck && npm run test && npm run check:docs`
Expected: ALL PASS. OR concurrency runs: recorded activation, subset join, default, `noPath`, conditionFailure, no double-produce.

```bash
git add tests/integration/inclusive-gateway.test.ts
git commit -m "test(m4): OR join single-produce + non-activated-branch isolation"
```

## Phase L5 — Compensation of parallel branches (straggler-catching)

**Ships:** A parallel transaction whose one branch hits a business error → `cancel` end compensates the completed steps across **all** branches in **lineage-ordered** reverse; a straggler completing **after** cancel still writes its ledger row and is compensated; the quiescence barrier holds the terminal until the ledger is drained **and** every cohort token is terminal; operator `/cancel` is frontier-wide and does **not** eagerly fail region-cohort jobs (no leaked side-effect). Carries blockers **8** (per-token terminators), **9** (ledger-empty-AND-tokens-terminal barrier), **10** (Principle VI per causal chain).

> **Single-token invariant:** every change below is **gated on `graph.regions` being present** (or on `token_id` being non-null). M1–M3 instances have no branch tokens, so the reverse pass behaves **exactly** as today. The existing compensation suite (`loop-compensation`, `saga-operator`, `saga-orchestration`) must stay green throughout.

### Task L5.1: Carry `token_id` on ledger rows + lineage-quiescence-ordered reverse (blocker 10)

**Files:**
- Modify: `src/persistence/saga.ts` (`insertSagaStepStmt` token_id; `selectScopeStepsForCompensation` lineage filter; docstring)
- Modify: `src/runtime/forward-task.ts` (pass `activeTokenId` into `insertSagaStepStmt`)

- [ ] **Step 1: Carry `token_id` on the ledger insert**

In `saga.ts` `insertSagaStepStmt`, add `tokenId?: string | null` to the input, append `token_id` to the column list + a `?` value bound to `input.tokenId ?? null`, and add `token_id: string | null;` to `SagaStepRow` and `tokenId: string | null;` to `SagaStepView` (+ `mapSagaStep`). In `forward-task.ts` `applyForwardCompletion`, pass `tokenId: activeTokenId ?? null` into the `insertSagaStepStmt` call (the `activeTokenId` threaded in Task L3.2).

- [ ] **Step 2: Lineage-quiescence filter (code-level anti-join)**

Add a helper to `saga.ts` that, given the candidate steps and the instance's live tokens, drops steps whose lineage still has a **live descendant** (a live token equal to or descended-from the step's `token_id`). For `token_id IS NULL` (root/M1-M3 lineage) the step is **always eligible** (no change to existing behaviour).

```typescript
import { listLiveTokens, type TokenRow } from "./tokens";

/** A step is BLOCKED iff some live token is the step's token or a descendant of it.
 *  Root-lineage steps (token_id NULL) are never blocked. */
export function filterLineageQuiesced(steps: SagaStepView[], liveTokens: TokenRow[]): SagaStepView[] {
  if (liveTokens.length === 0) return steps;
  const parentOf = new Map(liveTokens.map((t) => [t.token_id, t.parent_token_id]));
  const ancestorsOf = (tid: string): Set<string> => {
    const out = new Set<string>(); let cur: string | null = tid; const guard = new Set<string>();
    while (cur && !guard.has(cur)) { guard.add(cur); out.add(cur); cur = parentOf.get(cur) ?? null; }
    return out;
  };
  const blocked = new Set<string>();
  for (const t of liveTokens) for (const a of ancestorsOf(t.token_id)) blocked.add(a);
  return steps.filter((s) => s.tokenId == null || !blocked.has(s.tokenId));
}
```

Then change `runCompensation` (in `compensation.ts`) to apply the filter for region instances. After `const steps = await selectScopeStepsForCompensation(...)`, add:

```typescript
    const live = await listLiveTokens(env.DB, instanceId);
    const eligible = filterLineageQuiesced(steps, live);
    if (eligible.length === 0 && steps.length > 0) {
      // Ledger not drained but every remaining step's branch still has a live token
      // (a straggler is in flight) → park on the terminators; the next drive re-checks.
      if (!waitFor) return "waiting";
      // workflow mode: park on a short re-check via the existing wait machinery is not
      // available here, so return waiting and let the terminator alarms re-drive.
      return "waiting";
    }
    if (steps.length === 0) return "compensated";
    const step = eligible[0]!; // highest seq among eligible (selectScope orders seq DESC)
```

(Replace the existing `if (steps.length === 0) return "compensated"; const step = steps[0]!;` lines.) Import `filterLineageQuiesced` from `../persistence/saga` and `listLiveTokens` from `../persistence/tokens`.

- [ ] **Step 3: Docstring fix (design §10)**

In `saga.ts`, change the `insertSagaStepStmt` docstring phrase "so the reverse pass walks steps in true completion order" → "deterministic serialized walk-order rank; equals completion order within a causal chain (a token lineage), not across concurrent branches".

- [ ] **Step 4: Regression (single-token compensation unchanged)**

Run: `npx vitest run tests/integration/loop-compensation.test.ts tests/integration/saga-orchestration.test.ts tests/integration/saga-operator.test.ts && npm run typecheck`
Expected: PASS — `token_id` is NULL on these, so `filterLineageQuiesced` is a no-op.

- [ ] **Step 5: Commit**

```bash
git add src/persistence/saga.ts src/runtime/compensation.ts src/runtime/forward-task.ts
git commit -m "feat(m4): ledger token_id + lineage-quiescence-ordered reverse pass (Principle VI per causal chain)"
```

### Task L5.2: Cohort capture + straggler ledger-insert + quiescence barrier (blockers 8, 9)

**Files:**
- Modify: `src/runtime/compensation.ts` (`runCompensation` straggler scan + barrier)
- Create: `tests/helpers.ts` fixture `PARALLEL_SAGA_BPMN`
- Create: `tests/integration/parallel-compensation.test.ts`

- [ ] **Step 1: Add the parallel-saga fixture**

In `tests/helpers.ts`, add `PARALLEL_SAGA_BPMN`: a `<transaction>` containing an AND `fork`/`join`, where each branch has a compensatable service task (compensation boundary → handler), and one branch's task can raise a business error routed to a `cancel` end (mirror `SAGA_XOR_BPMN`'s compensation+error+cancel wiring, but with the two branches concurrent). Use `taskDefinition` types that the sample worker can fail on demand (check `src/runtime/service-task.ts` `invokeSampleWorker` for the failure-trigger convention used by `LOOP_XOR_BPMN`/`SAGA_XOR_BPMN`).

- [ ] **Step 2: Failing parallel-compensation test**

```typescript
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, drainSampleWorkers, get, PARALLEL_SAGA_BPMN } from "../helpers";
import { listTokens } from "../../src/persistence/tokens";
import { getSagaStepsForInstance } from "../../src/persistence/saga";

describe("parallel-branch compensation (M4-L5)", () => {
  it("business error in one branch → reverse-compensates completed steps across all branches; quiescence holds until terminal", async () => {
    const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, { correlationKey: "pc1", variables: { failBranchB: true } });
    const id = instance.body.instanceId;
    // Drain both branches: A completes (ledgered), B raises the business error → cancel → compensate.
    await drainSampleWorkers({ taskTypes: ["branch-a", "branch-b", "comp-a", "comp-b"] });
    const inst = await get(`/instances/${id}`);
    expect(["compensated", "compensationFailed"]).toContain(inst.body.status);
    const steps = await getSagaStepsForInstance(env.DB, id);
    // Branch A's completed step must have been compensated (not stranded).
    expect(steps.some((s) => s.elementId === "branchA" && s.compensationStatus === "compensated")).toBe(true);
    // Frontier is empty at the terminal.
    const live = (await listTokens(env.DB, id)).filter((r) => ["active", "waiting", "arrivedAtJoin"].includes(r.status));
    expect(live).toHaveLength(0);
  });
});
```

Run → likely FAIL (straggler A's ledger row isn't scanned during compensation, or the barrier settles before the cohort is terminal).

- [ ] **Step 3: Straggler ledger-insert + barrier in `runCompensation`**

At the **top of each `runCompensation` pass** (before `selectScopeStepsForCompensation`), scan cohort tokens whose forward job is now `completed` but unledgered, write their `saga_steps` row (`INSERT OR IGNORE`, inheriting occurrence), and flip the token `consumed`. Then the barrier returns `compensated` only when **no scope step is pending/compensating/failed AND no scope token is in a live status**:

```typescript
    // M4-L5 (design §8.3): catch stragglers — a cohort token whose forward job
    // completed AFTER cancel began. Ledger it (INSERT OR IGNORE) so the reverse pass
    // compensates it; flip the token consumed. Then re-evaluate the barrier.
    await ledgerStragglers(env, instanceId, graph, scopeId);
    const remaining = await countScopeStepsNeedingCompensation(env.DB, instanceId, scopeId);
    const liveScopeTokens = (await listLiveTokens(env.DB, instanceId)).length;
    if (remaining === 0 && liveScopeTokens === 0) return "compensated";
    if (remaining === 0 && liveScopeTokens > 0) {
      // Ledger drained but cohort tokens remain in flight → park on terminators.
      return "waiting";
    }
```

`ledgerStragglers` (new, in `compensation.ts`): list the scope's `arrivedAtJoin|active|waiting` tokens; for each, `getForwardJob` at the token's position; if `completed` and no `getSagaStep(...)`, write `insertSagaStepStmt(... compensationStatus: wiring ? 'pending' : 'notRequired', tokenId ...)` + `setTokenStatusStmt(token, 'consumed')` in one batch. `countScopeStepsNeedingCompensation` is `countPendingSteps` scoped to `scopeId` (add a `scopeId` arg or reuse `selectScopeStepsForCompensation(...).length`). Reuse existing builders; this is the §8.3 "before the reverse pass" scan.

- [ ] **Step 4: Run + iterate**

Run: `npx vitest run tests/integration/parallel-compensation.test.ts && npm run typecheck`
Expected: PASS. If it hangs/parks forever, the terminators (Task L5.3) aren't driving cohort jobs terminal — implement L5.3, then re-run.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/compensation.ts tests/helpers.ts tests/integration/parallel-compensation.test.ts
git commit -m "feat(m4): straggler ledger-insert + ledger-drained-AND-tokens-terminal quiescence barrier"
```

### Task L5.3: Per-token terminators (blocker 8)

**Files:**
- Modify: `src/runtime/forward-task.ts` (`terminateUnleasableJob` cohort relaxation)
- Modify: `src/persistence/jobs.ts` (`failLeasedJobConditional`)
- Modify: `src/runtime/compensation.ts` (`beginCompensating`/cohort teardown arms a lease-expiry alarm per in-flight cohort job)

- [ ] **Step 1: Relax the DLQ compensating early-return for cohort jobs**

In `forward-task.ts` `terminateUnleasableJob`, the guard `if (!inst || isTerminalInstanceStatus(inst.status) || inst.status === "compensating") return;` (line ~327) prevents the un-leasable-job DLQ from firing while the instance is compensating — which would hang the quiescence barrier (a never-leased cohort job never goes terminal). Relax it so a **compensating** instance still terminates an un-leasable forward job:

```typescript
  const inst = await getInstanceRow(env.DB, job.instance_id);
  if (!inst || isTerminalInstanceStatus(inst.status)) return;
  // M4-L5 (design §8.2): while COMPENSATING, an un-leasable cohort forward job MUST
  // still be terminated so the quiescence barrier can drain — relax the old
  // compensating early-return. The atomic claim below (created→failed) keeps it safe.
```

(Delete `|| inst.status === "compensating"` from the early-return.) The downstream settle batch already uses `transitionStatusGuardedStmt(..., ["running","waiting"], "incident", ...)` — that is a 0-row no-op for a `compensating` instance (it never regresses the status), so the job flips `created→failed` (its token then `discarded` on the next compensating drive's straggler scan) without disturbing the compensation. Confirm by re-reading the function: the `failUnleasableJobConditional` claim is the only state-changing write that must fire; the guarded transition is defensive.

> **Token → discarded:** the next `runCompensation` pass's straggler scan (Task L5.2) must also discard cohort tokens whose forward job is now `failed`. Extend `ledgerStragglers` (or add a sibling sweep) to: for a cohort token whose job is `failed` (terminator fired), `setTokenStatusStmt(token, 'discarded')` (a failed forward job owes no compensation — it never completed).

- [ ] **Step 2: Lease-expiry terminator for in-flight cohort jobs**

Add `failLeasedJobConditional` to `jobs.ts` (the in-flight twin of `failUnleasableJobConditional`):

```typescript
/** Claim a still-leased job as failed at/after its lease expiry (M4-L5 terminator). */
export async function failLeasedJobConditional(db: D1Database, jobId: string, now: string): Promise<number> {
  const res = await stmt(db, `UPDATE service_task_jobs SET status = 'failed', lock_token = NULL, updated_at = ? WHERE job_id = ? AND status = 'locked'`, [now, jobId]).run();
  return res.meta?.changes ?? 0;
}
```

When the scope enters `compensating` (in `beginCompensating`, or in `handleCancelInstance`'s teardown for region cohorts — Task L5.4), arm a `JobScheduler` **timer** alarm (`armTimer`) at each in-flight cohort job's `lock_expires_at`, with a dispatch that calls `failLeasedJobConditional` then re-drives the instance (so the straggler scan discards the token). Reuse the existing `JOB_SCHEDULER` DO: it already dispatches `fireTimer` for `timer:` markers; add a thin `lease-expiry` marker path, **or** simpler — register the in-flight job in the existing un-leasable DLQ flow by re-arming its `JobScheduler.arm(jobId, lock_expires_at)` and teaching `terminateUnleasableJob` to also handle a `locked` cohort job during compensation (claim via `failLeasedJobConditional`). The second option avoids a new DO marker:

In `terminateUnleasableJob`, after the `created/attempt 0` claim, add a `locked`-cohort branch:
```typescript
  if (job.status === "locked" && inst.status === "compensating") {
    if (!job.lock_expires_at || isoIsBefore(now, job.lock_expires_at)) return; // not yet expired
    const claimed = await failLeasedJobConditional(env.DB, jobId, now);
    if (claimed === 0) return;
    await getExecutorReDrive(env, inst.instance_id); // re-drive so the straggler scan discards the token
    return;
  }
```

> Keep `getExecutorReDrive` a thin `resumeInline(env, instanceId)` call (already imported in the engine surface). Re-arm the alarm at `lock_expires_at` when a cohort job is leased during compensation.

- [ ] **Step 3: Run + commit**

Run: `npx vitest run tests/integration/parallel-compensation.test.ts tests/integration/saga-dlq-timeout.test.ts && npm run typecheck`
Expected: PASS — terminators drive cohort jobs terminal so the barrier drains; the single-token DLQ test is unaffected (no `compensating` cohort).

```bash
git add src/runtime/forward-task.ts src/persistence/jobs.ts src/runtime/compensation.ts
git commit -m "feat(m4): per-token terminators (DLQ-while-compensating + lease-expiry claim)"
```

### Task L5.4: Operator `/cancel` — non-eager region abandon + frontier-wide sweep (blocker, §8.1)

**Files:**
- Modify: `src/index.ts` (`handleCancelInstance`)

- [ ] **Step 1: Failing test — a late `complete` after `/cancel` must still be ledgered + compensated (no leak)**

```typescript
it("operator /cancel of a parallel region does NOT leak a late-completing branch", async () => {
  const token = await mintWorkerToken();
  const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, { correlationKey: "pc2", variables: {} });
  const id = instance.body.instanceId;
  // Lease branch A but DON'T complete it yet; cancel the instance.
  const a = await leaseOne(token, "branch-a");
  await post(`/instances/${id}/cancel`, {});
  // A late complete arrives AFTER cancel — it must land as a straggler (ledger row), not no-op.
  await authedPost(`/jobs/${a.jobId}/complete`, token, { lockToken: a.lockToken, outputVariables: { didWork: true } });
  await drainSampleWorkers({ taskTypes: ["comp-a", "comp-b"] });
  const steps = await getSagaStepsForInstance(env.DB, id);
  expect(steps.some((s) => s.elementId === "branchA")).toBe(true); // ledgered, not leaked
});
```

(Imports: `leaseOne`, `post`, `authedPost`, `mintWorkerToken` from helpers.)

Run → FAIL: `handleCancelInstance` calls `abandonActiveForwardJobs` which flips A's `locked → failed`, so the late `complete` 0-row no-ops and leaks (no ledger row).

- [ ] **Step 2: Make region-cohort abandon non-eager**

In `handleCancelInstance` (index.ts:366), replace the unconditional `await abandonActiveForwardJobs(env.DB, instanceId, now);` with a region-aware branch:

```typescript
  const graph = await loadGraphForInstance(env, instanceId).catch(() => null);
  const isRegionInstance = !!graph?.regions && Object.keys(graph.regions).length > 0;
  if (isRegionInstance) {
    // M4-L5 (design §8.1): do NOT eagerly fail region-cohort forward jobs — a late
    // `complete` must land as a straggler (ledgered, then compensated), not no-op and
    // leak the executed side-effect. Leave them in place; the per-token terminators
    // (lease-expiry / DLQ) drive genuinely abandoned jobs terminal. Still release
    // active broker subscriptions so no broker key leaks.
    await releaseActiveSubscriptionsForInstance(env, instanceId, now);
  } else {
    await abandonActiveForwardJobs(env.DB, instanceId, now); // single-token path keeps eager abandon
  }
```

`releaseActiveSubscriptionsForInstance` (a small helper — list `message_subscriptions` for the instance with `status='active'`, best-effort broker supersede + mark `superseded`) prevents a leaked broker key without failing the jobs. `loadGraphForInstance` is already exported from `engine.ts`.

- [ ] **Step 3: Run + full compensation slice**

Run: `npx vitest run tests/integration/parallel-compensation.test.ts tests/integration/saga-operator.test.ts && npm run typecheck`
Expected: PASS — the late complete is ledgered + compensated; single-token `/cancel` is unchanged (the `else` branch).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(m4): operator /cancel — non-eager region abandon + frontier-wide subscription release"
```

### Task L5.5: Generalised forward-incident cohort capture + L5 gate (blocker §8.5)

**Files:**
- Modify: `tests/integration/parallel-compensation.test.ts`

- [ ] **Step 1: Edge — a forward incident on one branch strands the frontier without wedging**

```typescript
it("a technical incident on one branch leaves the instance 'incident' with the sibling frozen (not wedged)", async () => {
  const { instance } = await publishAndStart(PARALLEL_SAGA_BPMN, { correlationKey: "pc3", variables: { hazardBranchB: true } });
  const id = instance.body.instanceId;
  await drainSampleWorkers({ taskTypes: ["branch-a", "branch-b"] }); // B exhausts retries → Hazard
  const inst = await get(`/instances/${id}`);
  expect(inst.body.status).toBe("incident");
  // operator /cancel then runs the straggler-catching reverse pass over the cohort.
  await post(`/instances/${id}/cancel`, {});
  await drainSampleWorkers({ taskTypes: ["comp-a", "comp-b"] });
  expect(["compensated", "compensationFailed", "cancelled"]).toContain((await get(`/instances/${id}`)).body.status);
});
```

> **Why this already works:** a forward Hazard transitions the **whole instance** to `incident` (design §5.6) via the existing `createIncident` (one-way status table); sibling live tokens are simply frozen (no drive advances them). Operator `/cancel` from `incident` is already `CANCELLABLE_FROM`, and Task L5.4 makes its teardown straggler-safe. The generalised cohort capture is the **same** machinery — no new code if L5.1–L5.4 are correct. If the test wedges, the gap is `createIncident` not being reached because a sibling branch's drive returns `waiting` first; ensure the DFS surfaces an `incident` result from any branch (Task L3.3 `walk` sets `incident = true` and returns) so the loop returns `{status:"incident"}`.

- [ ] **Step 2: L5 gate**

Run: `npm run typecheck && npm run test && npm run check:docs`
Expected: ALL PASS. Straggler-catching compensation works end to end; single-token sagas are unchanged.

```bash
git add tests/integration/parallel-compensation.test.ts
git commit -m "test(m4): generalised forward-incident cohort capture (frozen siblings, /cancel reverse)"
```

## Phase L6 — Caps, R2 overlay offload, observability, inspection API, docs, manual matrix, closure

**Ships:** the three caps (`MAX_CONCURRENT_TOKENS` + `concurrencyLimit`, `STEP_BUDGET_SOFT` + `stepBudget`, plus the platform `limits.steps`); R2 overlay offload for large branch overlays; the inspection `tokens` array + openapi/contract; per-token observability; docs/`check:docs` finalisation; the **manual Workflow-mode validation matrix** (DoD gate); spec deltas + epic closure.

### Task L6.1: `MAX_CONCURRENT_TOKENS` + `STEP_BUDGET_SOFT` + two incident kinds

**Files:**
- Modify: `src/persistence/instances.ts` (`IncidentKind`), `src/contracts/api.ts` (doc), `specs/002-saga-orchestrator/contracts/openapi.yaml`
- Modify: `src/runtime/engine.ts` (constants + budget counter), `src/runtime/incidents.ts` (`concurrencyLimit`/`stepBudget` helpers), `src/runtime/frontier.ts` (cap wiring)
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: Failing tests for both caps**

Create `tests/integration/parallel-caps.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { publishAndStart, get } from "../helpers";
// A fixture that fans out beyond MAX_CONCURRENT_TOKENS via nested splits inside a loop,
// or set MAX_CONCURRENT_TOKENS low via a test-only override. Simplest: a deep nested
// fixture FANOUT_BPMN with > cap branches when the cap is lowered for the test.
import { CONCURRENCY_BOMB_BPMN } from "../helpers";

describe("concurrency caps (M4-L6)", () => {
  it("a fan-out exceeding MAX_CONCURRENT_TOKENS settles a terminal concurrencyLimit incident", async () => {
    const { instance } = await publishAndStart(CONCURRENCY_BOMB_BPMN, { correlationKey: "cap1", variables: {} });
    const inst = await get(`/instances/${instance.body.instanceId}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident?.kind).toBe("concurrencyLimit");
  });
});
```

Add `CONCURRENCY_BOMB_BPMN` to helpers (a nested-region fixture whose live frontier exceeds the cap — easiest to author against a **lowered** cap; see Step 4 for a test-time override hook, or build a fixture with > 256 concurrent leaf tokens). Run → FAIL.

- [ ] **Step 2: Add the incident kinds (single-sourced)**

In `src/persistence/instances.ts` `IncidentKind`, append:

```typescript
  // CONCURRENCY (M4-L6): concurrencyLimit — a fan-out exceeded MAX_CONCURRENT_TOKENS
  // live tokens; stepBudget — the engine's cumulative runStep/waitForEvent count
  // crossed STEP_BUDGET_SOFT (a graceful incident BELOW the platform step ceiling).
  | "concurrencyLimit"
  | "stepBudget";
```

In `specs/002-saga-orchestrator/contracts/openapi.yaml`, append `concurrencyLimit, stepBudget` to the `Incident.kind` `enum: [...]` (line ~1060) and extend the description. In `src/contracts/api.ts`, extend the `Incident.kind` doc comment to mention the two kinds. (`check:docs` guard #7 asserts the union == the openapi enum set — they must match exactly.)

- [ ] **Step 3: Constants + budget counter in `engine.ts`**

Add next to `MAX_ELEMENT_OCCURRENCES`:

```typescript
/**
 * Live-token frontier cap (M4 design §9). Caps execution_tokens in a LIVE status
 * (active|waiting|arrivedAtJoin); counted from the in-memory reconstructed frontier
 * during the rewalk (NEVER a live COUNT — that would fire nondeterministically on
 * replay). Exceeding it at a split fan-out settles a terminal `concurrencyLimit`.
 */
export const MAX_CONCURRENT_TOKENS = 256;

/**
 * Soft step budget (M4 design §9). The engine maintains a per-drive cumulative
 * runStep/waitForEvent counter; crossing this settles a graceful `stepBudget`
 * incident BELOW the platform ceiling (wrangler workflows limits.steps = 25000),
 * so a hot parallel×loop shape never becomes an opaque errored Workflow.
 */
export const STEP_BUDGET_SOFT = 20000;
```

Wrap `runStep`/the wait calls with a counter: in `loop`, maintain `let steps = 0;` and increment per `runStep`/`waitFor` issuance; when `steps > STEP_BUDGET_SOFT`, settle `createIncident(..., "stepBudget")` and return `{status:"incident"}`. The cleanest non-invasive way: count inside `makeLeafDrivers`' `runStep` wrapper and in `raceParkedWaits`, sharing a closure counter; check the threshold at the top of each `driveFrontier` re-walk in `loop`.

- [ ] **Step 4: Wire `MAX_CONCURRENT_TOKENS` into fan-out**

In `frontier.ts` `driveFrontier`, the `if (liveTokens + activated.length > maxConcurrent)` guard (Task L3.3) already exists; pass `MAX_CONCURRENT_TOKENS` from `loop`. Implement `raiseConcurrencyLimit` = `createIncident(env, instanceId, splitId, 0, "Fan-out exceeded MAX_CONCURRENT_TOKENS live tokens.", { cap: MAX_CONCURRENT_TOKENS, splitId }, "concurrencyLimit")`. Count `liveTokens` from the **in-memory reconstructed frontier** during the walk (the `liveTokens` accumulator), never a SQL COUNT (design §9). For a test-time lower cap, accept an env override (e.g. read `env.MAX_CONCURRENT_TOKENS_OVERRIDE` when present) so `CONCURRENCY_BOMB_BPMN` can trip it without 256 real branches; document the override as test-only.

- [ ] **Step 5: `check:docs` constant-sync for the two new constants**

In `scripts/check-docs.mjs` guard #6, generalise the `MAX_ELEMENT_OCCURRENCES` literal-sync to also cover `MAX_CONCURRENT_TOKENS` and `STEP_BUDGET_SOFT`: loop over the three constant names, read each from `engine.ts`, and assert every `<NAME> = <n>` literal under `docs/bpmn/` + `specs/002-saga-orchestrator/` matches. (Refactor the single-constant block into a `for (const name of ["MAX_ELEMENT_OCCURRENCES", "MAX_CONCURRENT_TOKENS", "STEP_BUDGET_SOFT"]) { … }` loop reusing the existing regex shape.)

- [ ] **Step 6: Run + commit**

```bash
npx vitest run tests/integration/parallel-caps.test.ts && npm run typecheck && npm run check:docs
git add src/persistence/instances.ts src/contracts/api.ts specs/002-saga-orchestrator/contracts/openapi.yaml src/runtime/engine.ts src/runtime/incidents.ts src/runtime/frontier.ts scripts/check-docs.mjs tests/integration/parallel-caps.test.ts tests/helpers.ts
git commit -m "feat(m4): MAX_CONCURRENT_TOKENS/concurrencyLimit + STEP_BUDGET_SOFT/stepBudget + constant-sync guard"
```

### Task L6.2: R2 overlay offload + join-time payload bound

**Files:**
- Modify: `wrangler.jsonc` (R2 binding + workflows `limits.steps`)
- Modify: `src/env.ts` (R2 binding type)
- Modify: `src/persistence/tokens.ts` (overlay R2 (de)serialisation)
- Modify: `src/runtime/regions-runtime.ts` (join-time `MAX_EVENT_PAYLOAD_BYTES` bound)

- [ ] **Step 1: Add the R2 binding + step limit to `wrangler.jsonc`**

Add to `wrangler.jsonc`: under `workflows[0]`, `"limits": { "steps": 25000 }`; and a new top-level `"r2_buckets": [{ "binding": "OVERLAYS", "bucket_name": "easy-bpmn-overlays" }]`. Add `OVERLAYS: R2Bucket;` to the `Env` interface in `src/env.ts`. For tests, `@cloudflare/vitest-pool-workers` provides a local R2 — no extra config (confirm by running the suite; if the binding is missing in tests, add it to `vitest.config.ts` miniflare bindings as `r2Buckets: ["OVERLAYS"]`).

- [ ] **Step 2: Overlay offload in `tokens.ts`**

Add `OVERLAY_INLINE_MAX_BYTES` (e.g. `512 * 1024`) and helpers that store an overlay exceeding it in R2 under the deterministic key `overlays/${instanceId}/${tokenId}.json` (written **before** the D1 commit — deterministic key makes crash-retry byte-identical), with the column holding `{"__r2":"<key>"}`:

```typescript
export const OVERLAY_INLINE_MAX_BYTES = 512 * 1024;
export async function writeOverlay(env: { OVERLAYS: R2Bucket }, instanceId: string, tokenId: string, overlay: JsonObject): Promise<JsonObject> {
  const json = toJson(overlay);
  if (json.length <= OVERLAY_INLINE_MAX_BYTES) return overlay;
  const key = `overlays/${instanceId}/${tokenId}.json`;
  await env.OVERLAYS.put(key, json);
  return { __r2: key };
}
export async function readOverlay(env: { OVERLAYS: R2Bucket }, raw: JsonObject): Promise<JsonObject> {
  if (raw && typeof raw === "object" && "__r2" in raw && typeof raw.__r2 === "string") {
    const obj = await env.OVERLAYS.get(raw.__r2);
    return obj ? JSON.parse(await obj.text()) : {};
  }
  return raw;
}
```

Thread `writeOverlay`/`readOverlay` through `upsertTokenStmt`'s overlay write (in `forward-task.ts` token-overlay write and `claimJoinCompletion`) and `parseOverlay`/`resolveScope` reads. (Keep inline for the common small case — the offload is the tail.)

- [ ] **Step 3: Join-time 1 MiB bound**

In `claimJoinCompletion`, before writing the merged overlay to `process_instances.variables` (root) or delivering it, check `payloadByteSize(mergedOverlay) <= MAX_EVENT_PAYLOAD_BYTES`; on exceed, raise the existing `serviceTaskOutputRejected`/`poison` incident path (design §9.1) — never a silent truncation. Import `MAX_EVENT_PAYLOAD_BYTES, payloadByteSize` from `./payload`.

- [ ] **Step 4: Run + commit**

```bash
npm run typecheck && npx vitest run tests/integration/parallel-gateway.test.ts && npx wrangler deploy --dry-run
git add wrangler.jsonc src/env.ts src/persistence/tokens.ts src/runtime/regions-runtime.ts vitest.config.ts
git commit -m "feat(m4): R2 overlay offload + join-time 1 MiB bound + workflows limits.steps=25000"
```

### Task L6.3: Inspection `tokens` array + contract test

**Files:**
- Modify: `src/contracts/api.ts` (`ProcessInstanceInspection.tokens`), `src/index.ts` (`handleGetInstance`), `specs/002-saga-orchestrator/contracts/openapi.yaml`
- Modify: `tests/contract/api.test.ts` or `tests/contract/runtime-contracts.test.ts`

- [ ] **Step 1: Failing contract test**

Add to a contract test: start a parallel instance, fan it out, and assert `GET /instances/{id}` returns a `tokens` array with `{tokenId, positionElementId, status, regionId, regionActivation, branchFlowId, parentTokenId}` and that `currentElementId` is `null` while >1 token is live.

- [ ] **Step 2: Implement**

In `src/contracts/api.ts`, add a `tokenInspectionSchema` (zod) and `tokens?: TokenInspection[]` to `ProcessInstanceInspection` (mirror `timerInspectionSchema`). In `handleGetInstance` (index.ts:310), read `listTokens(env.DB, instanceId)` and map to the `tokens` array (large overlays returned by R2 reference, not inlined); set the response `currentElementId` to `null` when >1 live token (the `tokens` array is authoritative). Add the `tokens` array + nullable `currentElementId` to the openapi `ProcessInstance`/inspection schema (line ~645/673).

- [ ] **Step 3: Run + commit**

```bash
npm run test:contract && npm run typecheck && npm run check:docs
git add src/contracts/api.ts src/index.ts specs/002-saga-orchestrator/contracts/openapi.yaml tests/contract
git commit -m "feat(m4): GET /instances tokens array + openapi/contract (currentElementId null when >1 token)"
```

### Task L6.4: Observability — per-token history tags

**Files:**
- Modify: `src/runtime/regions-runtime.ts`, `src/runtime/forward-task.ts`, `src/runtime/engine.ts` (history diagnostics)

- [ ] **Step 1: Confirm the new history event types are emitted**

The L3/L4 work already emits `regionActivated`, `branchForked`, `branchArrivedAtJoin`, `joinCompleted` (free-text `history_events.type` — no schema change). Verify a parallel run's history contains all four (add an assertion to `parallel-gateway.test.ts`).

- [ ] **Step 2: Tag in-region events with `tokenId`/`regionId`/`regionActivation`/`spanId`**

For every history event emitted **inside a region** (forward task, gateway, message, the join merge), include `tokenId`, `regionId`, `regionActivation`, and a per-token `spanId` in the `diagnostics` JSON (no new column — design §11). Thread `activeTokenId` + its region frame into the history-writing call sites (already plumbed for the drivers in L3.2/L3.3). The join's `joinCompleted` event already records the contributing branch token ids.

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/integration/parallel-gateway.test.ts && npm run typecheck
git add src/runtime/regions-runtime.ts src/runtime/forward-task.ts src/runtime/engine.ts tests/integration/parallel-gateway.test.ts
git commit -m "feat(m4): per-token history tags (tokenId/regionId/regionActivation/spanId in diagnostics)"
```

### Task L6.5: Spec deltas + docs finalisation

**Files:**
- Modify: `specs/002-saga-orchestrator/{spec.md, plan.md, data-model.md, contracts/runtime-contracts.md, quickstart.md}`
- Modify: `docs/bpmn/09-easy-bpmn-profile.md` (final), `docs/bpmn/03-gateways.md`, `docs/bpmn/07-execution-semantics.md`

- [ ] **Step 1: Fold the M4 deltas into the spec**

In `specs/002-saga-orchestrator/`: add the M4 row/section to `spec.md` and `plan.md`; document the §7 tables (`execution_tokens`, `join_arrivals`, `join_completions`, `gateway_decisions.activated_flow_ids`, `saga_steps.token_id`) in `data-model.md`; add the tokens array + new incident kinds to `contracts/runtime-contracts.md`; add M4 quickstart scenarios to `quickstart.md` (the AND/OR/compensation flows + the manual matrix results placeholder).

- [ ] **Step 2: Verify the constant literals match**

Wherever the specs/docs cite `MAX_CONCURRENT_TOKENS = 256` or `STEP_BUDGET_SOFT = 20000`, they must match `engine.ts` (the `check:docs` guard #6 from Task L6.1 enforces this).

- [ ] **Step 3: Run + commit**

```bash
npm run check:docs
git add specs/002-saga-orchestrator docs/bpmn
git commit -m "docs(m4): specs/002 M4 deltas + data-model token tables + quickstart"
```

### Task L6.6: Manual Workflow-mode validation matrix (DoD gate — NOT CI)

**Files:**
- Modify: `specs/002-saga-orchestrator/quickstart.md` (record results)

> **This is a blocking Definition-of-Done gate (design §14).** The multi-wait `Promise.race`, suspend/resume across splits, step-budget, and the within-`run()` step-name dedup live **only in workflow mode** and cannot run under `EXECUTION_MODE=direct`. Run them by hand against `wrangler dev` (or a deployed instance) and record the outcomes in `quickstart.md`. **Do not close the epic until all six pass.**

- [ ] **Step 1: Bring up workflow mode**

Run: `npm run dev` (this is `wrangler dev`; `EXECUTION_MODE=workflow` from `wrangler.jsonc`). Apply local D1 migrations first: `npx wrangler d1 migrations apply easy_bpmn --local`.

- [ ] **Step 2: Execute the six scenarios (design §14), recording PASS/FAIL + evidence**

- [ ] 2a. **Two parallel message catches** (publish a model with two distinct-message receive branches under an AND region; deliver A then B). Expect: each applies exactly once, the join proceeds, **no duplicate-step-name error**.
- [ ] 2b. **Crash/restart mid-race after delivering A** (kill/restart `wrangler dev` after A, before B). Expect: re-walk fast-forwards A write-free, re-races B, no re-apply.
- [ ] 2c. **Deliver A and B near-simultaneously then force replay.** Expect: identical final state regardless of race winner (the documented winner-flip-on-replay is harmless).
- [ ] 2d. **One branch times out while a sibling is live.** Expect: no `unhandledRejection`, the sibling completes (each `waitForEvent` is individually wrapped before the race — design §5.2).
- [ ] 2e. **In-region loops approaching the budget.** Expect: a graceful `stepBudget`/`concurrencyLimit` incident, **not** an opaque errored Workflow.
- [ ] 2f. **Cancel a region with parked + in-flight straggler branches.** Expect: the quiescence barrier + per-causal-chain reverse-seq ordering hold across suspend/resume.

- [ ] **Step 3: Record + commit**

Record each scenario's result + evidence (history excerpts, instance JSON) under an "M4 manual Workflow-mode matrix" heading in `quickstart.md`.

```bash
git add specs/002-saga-orchestrator/quickstart.md
git commit -m "docs(m4): manual Workflow-mode validation matrix results (DoD gate)"
```

### Task L6.7: L6 gate + epic closure

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npm run test && npm run check:docs && npx wrangler deploy --dry-run`
Expected: ALL PASS.

- [ ] **Step 2: Constitution two-gate confirmation**

Confirm `specs/002-saga-orchestrator/m4-constitution-check.md`'s After-Phase-1 gate (against v2.3.0) is satisfied by the shipped runtime (every constitution-critical behaviour — SESE validation, immutable version binding, Service Task worker contract, Receive Task correlation, idempotency/retry, audit history, operator-visible errors — has a contract or integration test). Tick each principle.

- [ ] **Step 3: Backlog epic closure**

Use the Backlog.md MCP workflow (read `backlog://workflow/overview` first) to: create the M4 milestone + the L1–L6 tasks (mirroring the M3 TASK-38..47 slicing), mark each done as it ships, and close the M4 epic. Record the manual-matrix results as the epic's Definition-of-Done evidence.

- [ ] **Step 4: Finish the branch**

REQUIRED SUB-SKILL: Use superpowers:finishing-a-development-branch to merge/PR `m4-concurrency`. PR body should summarise the six layers, link the design doc, and note the manual-matrix evidence.

---

## Self-Review (run after the plan, before execution)

**Spec coverage** — every design section maps to a task:

| Design § | Task(s) |
|----------|---------|
| §2 locked decisions | Whole plan (construct set L1; topology L1; token-frontier L2/L3; branch-local vars L3.2; straggler compensation L5) |
| §4 profile + SESE validator (blockers 6, 13, 14) | L1.3–L1.6 |
| §5.1 deterministic DFS (blocker 2) | L3.3 |
| §5.2 within-pass discipline / multi-wait (blocker 5) | L3.3 (race) + L6.6 (manual) |
| §5.3 per-token guards (blocker 1) | L2.3 |
| §5.4 split/join append-only facts (blockers 4, 11) | L2.1, L2.2, L3.1, L3.3 |
| §5.5 token-id forms (blocker 12) | L2.2, L3.1, L3.3 |
| §5.6 frontier-empty completion | L3.4 |
| §5.7 branch-local vars + merge | L3.1, L3.2 |
| §6 inclusive OR (blocker 7) | L4 |
| §7 persistence deltas | L2.1, L4.1, L5.1 |
| §8 straggler compensation (blockers 8, 9, 10) | L5 |
| §9 caps + state budget | L6.1, L6.2 |
| §10 drive serialization | L2.5 |
| §11 API + observability | L6.3, L6.4 |
| §12 governance + docs + check:docs | L1.1, L1.7, L6.1, L6.5 |
| §14 testing + manual matrix | L3.5, L4, L5, L6.6 |

**Type consistency** — names used identically across tasks: `RegionInfo`/`RegionInfoOut` (graph IR vs regions.ts internal — converted at the validator boundary, L1.6 Step 5); `Token`, `WaitCollector`, `ParkedWait`, `LeafDrivers`, `driveFrontier` (frontier.ts, L2.2/L3.3); `rootTokenId`/`branchTokenId`/`parseTokenId` (tokens.ts, L2.2); `fanOutSplit`/`recordJoinArrival`/`joinBarrierSatisfied`/`claimJoinCompletion`/`mergeBranchOverlays`/`resolveActivatedFlows`/`requiredFlowsFor` (regions-runtime.ts, L3.1/L4.2); `resolveScope` (frontier.ts, L3.2); `filterLineageQuiesced`/`ledgerStragglers` (saga.ts/compensation.ts, L5); `MAX_CONCURRENT_TOKENS`/`STEP_BUDGET_SOFT` (engine.ts, L6.1). `activeTokenId` is the single thread-through name for the active token across `decideGateway`, the forward drivers, `resolveActivatedFlows`, and the history tags.

**Known soft spots (flagged for the implementer):**
- **L3.3 is the highest-risk task** (the DFS driver + leaf-driver extraction). Budget extra time; lean on `npm run test` (full single-token regression) after every edit. The illustrative `await import(...)` in the L3.3 snippet must be replaced with a top-level import (noted in-task).
- **Workflow-mode multi-wait** is unverifiable in CI — Task L6.6 is a real DoD gate, not optional.
- **`CONCURRENCY_BOMB_BPMN`** (L6.1) is easiest with a **test-only** `MAX_CONCURRENT_TOKENS` override; document it as test-only so it can never lower the production cap.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-13-m4-concurrency.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Best fit here: the layers are ordered and each task is self-contained with explicit verify commands, so a fresh subagent per task with a two-stage review keeps the high-risk L3.3 honest.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**





