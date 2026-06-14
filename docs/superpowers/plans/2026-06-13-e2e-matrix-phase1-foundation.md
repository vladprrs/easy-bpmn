# E2E Combination Matrix — Phase 1 (Foundation + Direct-Mode Layer A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the shared matrix substrate (scenario registry + `check:matrix` drift-guard + fixtures) and the **direct-mode Layer A** coverage for all `C-*` and `R-*` scenarios that are independent of TASK-54 — green in CI.

**Architecture:** A single source-of-truth registry (`tests/matrix/registry.ts`) indexes all 60 scenarios from the design spec by stable id. A Node drift-guard (`scripts/check-matrix.mjs`, mirroring the existing `scripts/check-docs.mjs`) fails CI when a registered scenario lacks a `[<id>]` marker in its declared test file(s), or when a supported construct / reject rule is uncovered. Direct-mode tests run in the existing `@cloudflare/vitest-pool-workers` harness (`EXECUTION_MODE=direct`) and reuse the helpers + fixtures in `tests/helpers.ts`. Workflow-mode (`W-*`) is **out of scope for this plan** — Phases 2–3.

**Tech Stack:** TypeScript · Vitest 4 + `@cloudflare/vitest-pool-workers` · D1 / Durable Objects / R2 / Workflows (workerd/miniflare) · Node 20 (guard scripts) · `bpmn-moddle` (BPMN), `feelin` (FEEL).

**Spec:** `docs/superpowers/specs/2026-06-13-e2e-combination-matrix-design.md` (Appendix A = the 60-scenario detail keyed by id; this plan implements the Phase-1 subset).

---

## Scope of this plan (Phase 1 only)

In scope (46 scenarios):
- **Foundation:** registry, `check:matrix` guard, `tests/matrix/` + `tests/fixtures/matrix/` scaffold, npm/CI wiring.
- **15 `extends-existing` `C-*`:** already covered in direct mode by the 43 existing integration tests — wired in by adding a `[<id>]` marker to the relevant `it(...)` title.
- **20 `new` `C-*`:** new direct-mode tests + ~9 new fixtures.
- **11 `R-*`:** publish-validation reject tests (10 reuse existing reject fixtures; 1 new fixture for `R-LOOP-CROSS-01`).

Out of scope (deferred to their own plans):
- **Phase 2:** Workflow-mode infra (`BASE_URL` driver, probe promotion) + `W-REG-*` single-token regressions.
- **Phase 3:** `W-*` concurrency scenarios (`@needs-task54`, the M4-closure gate).

> **Test nature (read before writing any `C-*` test):** M4 direct-mode behavior (L1–L6) is **already shipped**. These `C-*` tests are **characterization/coverage** tests over working code — a freshly-written test is expected to **PASS**. If one **FAILS**, you have found either a real bug or a wrong expectation: STOP, invoke `superpowers:systematic-debugging`, and either fix the expectation (if you misread the spec) or file a backlog task for the bug (do NOT weaken the assertion to make it green). `R-*` tests assert a publish is *rejected* — they pass when the publish returns a non-2xx with the offending element id.

---

## File Structure

**Create:**
- `tests/matrix/registry.ts` — scenario index (source of truth; one object per line). Seed: `docs/superpowers/plans/assets/2026-06-13-matrix-registry.seed.ts`.
- `tests/matrix/registry.test.ts` — unit test that the registry is well-formed (60 rows, unique ids, valid enums).
- `tests/matrix/reject.test.ts` — all 11 `R-*` publish-validation tests (parametrized).
- `tests/integration/matrix/concurrency.test.ts` — new `C-AND-*` / `C-OR-NESTAND` / `C-BRANCH-*` direct tests.
- `tests/integration/matrix/compensation.test.ts` — new `C-COMP-*` / `C-ERR-BRANCH-COMP` / `C-IDEMP-COMP-DUP` direct tests.
- `tests/integration/matrix/errors.test.ts` — new `C-BRANCH-NOPATH` direct test.
- `tests/integration/matrix/caps-loops.test.ts` — new `C-LOOP-*` / `C-BRANCH-DLQ` / `C-BRANCH-RETRY` direct tests.
- `tests/integration/matrix/idempotency-operator.test.ts` — new `C-IDEMP-*` / `C-OP-RETRY-COMPFAILED` direct tests.
- `tests/fixtures/matrix/fixtures.ts` — the ~9 new BPMN fixtures (exported consts), importing the surgery base fixtures from `../../helpers`.
- `scripts/check-matrix.mjs` — the drift-guard.

**Modify:**
- `package.json` — add `check:matrix` + `test:matrix` scripts; fold `check:matrix` into the CI guard step.
- `tests/helpers.ts` — only if a new fixture needs a shared sub-builder (prefer `tests/fixtures/matrix/fixtures.ts`).
- The 5 existing integration tests that own `extends-existing` scenarios — add `[<id>]` markers to `it(...)` titles (Milestone 2).
- `.github/workflows/*.yml` (CI) — add `npm run check:matrix` (Milestone 5).

**Reuse (already in `tests/helpers.ts`):** `publishAndStart`, `createDraft`, `publishDraft`, `startInstance`, `get`, `post`, `mintWorkerToken`, `leaseOne`, `leaseAndComplete`, `authedPost`, `drainSampleWorkers`, `rewindBackoff`, `publishMessage`; fixtures `PARALLEL_BPMN`, `NESTED_PARALLEL_BPMN`, `INCLUSIVE_BPMN`, `PARALLEL_SAGA_BPMN`, `PARALLEL_MESSAGE_DISTINCT_BPMN`, `PARALLEL_SAME_MESSAGE_BPMN`, `PARALLEL_DEADLOCK_BPMN`, `PARALLEL_MISMATCH_BPMN`, `SAGA_LOOP_BPMN`, `sagaBpmn()`, `deferredGatewayBpmn()`.

---

## Milestone 0 — Scaffolding & npm wiring

### Task 0.1: Create the directory scaffold

**Files:**
- Create: `tests/matrix/.gitkeep`, `tests/integration/matrix/.gitkeep`, `tests/fixtures/matrix/.gitkeep`

- [ ] **Step 1: Create the directories**

```bash
mkdir -p tests/matrix tests/integration/matrix tests/fixtures/matrix
touch tests/matrix/.gitkeep tests/integration/matrix/.gitkeep tests/fixtures/matrix/.gitkeep
```

- [ ] **Step 2: Verify vitest picks up the new integration dir**

Run: `npx vitest run tests/integration/matrix --reporter=dot`
Expected: PASS with "no test files found" (0 tests) — confirms the glob includes the new dir without error.

- [ ] **Step 3: Commit**

```bash
git add tests/matrix/.gitkeep tests/integration/matrix/.gitkeep tests/fixtures/matrix/.gitkeep
git commit -m "test(m4): scaffold tests/matrix + tests/integration/matrix + tests/fixtures/matrix"
```

### Task 0.2: Add npm scripts

**Files:**
- Modify: `package.json:7-16` (scripts block)

- [ ] **Step 1: Add the scripts**

In `package.json`, add to `"scripts"`:

```json
    "check:matrix": "node scripts/check-matrix.mjs",
    "test:matrix": "vitest run tests/matrix tests/integration/matrix"
```

- [ ] **Step 2: Verify the script is registered (it will fail until 1.x lands)**

Run: `npm run check:matrix`
Expected: FAIL with "Cannot find module .../scripts/check-matrix.mjs" — confirms the script entry exists.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(m4): add check:matrix + test:matrix npm scripts"
```

---

## Milestone 1 — Registry + drift-guard (TDD the guard)

### Task 1.1: Install the scenario registry

**Files:**
- Create: `tests/matrix/registry.ts`
- Source: `docs/superpowers/plans/assets/2026-06-13-matrix-registry.seed.ts`

- [ ] **Step 1: Copy the pre-generated seed into place**

```bash
cp docs/superpowers/plans/assets/2026-06-13-matrix-registry.seed.ts tests/matrix/registry.ts
```

The seed defines `export interface Scenario`, the `Mode`/`Legality`/`Coverage` types, and `export const SCENARIOS: Scenario[]` with all 60 rows (one object literal per line — the `check:matrix` line-parser depends on the one-per-line shape; keep it).

- [ ] **Step 2: Typecheck it**

Run: `npx tsc --noEmit`
Expected: PASS (the seed is plain typed data).

- [ ] **Step 3: Commit**

```bash
git add tests/matrix/registry.ts
git commit -m "test(m4): seed e2e combination matrix registry (60 scenarios)"
```

### Task 1.2: Registry well-formedness test

**Files:**
- Create: `tests/matrix/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
      // A declared mode implies a file to carry its [id] marker.
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
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/matrix/registry.test.ts`
Expected: PASS (the seed already satisfies these). If it FAILS, the seed was edited — fix the seed, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/matrix/registry.test.ts
git commit -m "test(m4): registry well-formedness checks"
```

### Task 1.3: The `check:matrix` drift-guard

**Files:**
- Create: `scripts/check-matrix.mjs`

- [ ] **Step 1: Write the guard (full code)**

```js
#!/usr/bin/env node
// E2E combination-matrix drift-guard (sibling of scripts/check-docs.mjs).
//
// Runs in Node (not the workers runtime) so it can read test files off disk.
// Fails CI when the registry and the tests drift apart:
//   1. Every registered scenario, for each mode it declares AT OR BELOW the
//      active phase, has a `[<id>]` marker in its declared test file.
//   2. Every must-cover construct tag appears in >=1 registry row.
//   3. >=11 reject (R-*) scenarios are registered.
// Workflow-mode gaps ABOVE the active phase are WARNINGS (Phases 2-3 flip them
// to failures by raising MATRIX_PHASE).
//
// MATRIX_PHASE (env, default 1) = the highest phase whose coverage is enforced.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const ACTIVE_PHASE = Number(process.env.MATRIX_PHASE ?? "1");
const registryText = readFileSync(join(repoRoot, "tests/matrix/registry.ts"), "utf8");

// Parse the one-object-per-line registry rows.
const rows = [];
for (const line of registryText.split("\n")) {
  const idM = line.match(/^\s*\{\s*id:\s*"([^"]+)"/);
  if (!idM) continue;
  rows.push({
    id: idM[1],
    modes: (line.match(/modes:\s*\[([^\]]*)\]/)?.[1] ?? "")
      .split(",").map((s) => s.replace(/["\s]/g, "")).filter(Boolean),
    phase: Number(line.match(/phase:\s*(\d)/)?.[1] ?? "1"),
    directFile: line.match(/directFile:\s*"([^"]*)"/)?.[1] ?? "",
    workflowFile: line.match(/workflowFile:\s*"([^"]*)"/)?.[1] ?? "",
  });
}

const failures = [];
const warnings = [];

const fileHasMarker = (file, id) =>
  file && existsSync(join(repoRoot, file)) &&
  readFileSync(join(repoRoot, file), "utf8").includes(`[${id}]`);

function checkMode(r, mode, file) {
  if (!r.modes.includes(mode)) return;
  const bucket = r.phase <= ACTIVE_PHASE ? failures : warnings;
  if (!file) { failures.push(`${r.id}: declares '${mode}' but has no ${mode}File`); return; }
  if (!fileHasMarker(file, r.id)) {
    bucket.push(`${r.id}: no "[${r.id}]" marker found in ${file} (${mode} mode, phase ${r.phase})`);
  }
}

for (const r of rows) {
  checkMode(r, "direct", r.directFile);
  checkMode(r, "workflow", r.workflowFile);
}

// 2) Construct coverage: each tag must appear somewhere in the registry text.
const MUST_COVER = [
  "exclusiveGateway", "parallelGateway", "inclusiveGateway", "eventBasedGateway",
  "boundaryTimer", "intermediateTimer", "messageCatch", "serviceTask", "receiveTask",
  "transaction", "Compensation", "straggler", "quiescence", "noPath", "loopLimit",
  "jobActivationTimeout", "concurrencyLimit", "stepBudget", "poison",
  "Idempotency", "Operator",
];
for (const tag of MUST_COVER) {
  if (!new RegExp(tag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i").test(registryText)) {
    failures.push(`construct tag "${tag}" is referenced by no scenario in tests/matrix/registry.ts`);
  }
}

// 3) Reject-rule coverage.
const rejectCount = rows.filter((r) => r.id.startsWith("R-")).length;
if (rejectCount < 11) failures.push(`only ${rejectCount} reject (R-*) scenarios registered; expected >= 11`);

if (rows.length !== 60) warnings.push(`registry has ${rows.length} scenarios (expected 60)`);

for (const w of warnings) console.warn("  (warn) " + w);
if (failures.length > 0) {
  console.error(`Matrix drift-check FAILED (MATRIX_PHASE=${ACTIVE_PHASE}):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(
  `Matrix drift-check passed: ${rows.length} scenarios, ${rejectCount} rejects, ` +
  `all phase<=${ACTIVE_PHASE} markers present (${warnings.length} deferred-phase warnings).`,
);
```

- [ ] **Step 2: Run it — expect FAIL listing missing markers**

Run: `npm run check:matrix`
Expected: FAIL — it lists every phase-1 scenario (`C-*` + `R-*`) as missing its `[id]` marker (no matrix tests exist yet), and warns on the phase-2/3 `W-*` rows. This is the red bar Milestones 2–4 turn green.

- [ ] **Step 3: Sanity-check the construct-coverage + reject-count rules pass already**

Run: `npm run check:matrix 2>&1 | grep -E "construct tag|reject \(R-\*\)" || echo "construct+reject rules OK"`
Expected: `construct+reject rules OK` (the registry text already references every MUST_COVER tag and has 11 `R-*`). If a `construct tag "X"` failure prints, add tag `X` to the `axes` of the most relevant scenario row in `registry.ts` (keep it one-line) and re-run.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-matrix.mjs tests/matrix/registry.ts
git commit -m "test(m4): check:matrix drift-guard (registry <-> tests, phased)"
```

---

## Milestone 2 — Wire in the 15 `extends-existing` direct scenarios

These scenarios are already covered in direct mode by existing integration tests. Wiring = adding the `[<id>]` marker to the **one** existing `it(...)` title whose body already exercises that behavior, so `check:matrix` sees the coverage. No new assertions unless noted.

> Process for each row below: open the `directFile`, find the `it("...")` that matches the scenario, prepend `[<id>] ` to its title string. Run that file. Commit per file.

### Task 2.1: Mark `parallel-gateway.test.ts` scenarios

**Files:** Modify `tests/integration/parallel-gateway.test.ts`

- [ ] **Step 1: Add markers to the matching `it` titles**
  - `[C-AND-2BRANCH-01]` → the "fans out both branches … join waits for both, completes on empty frontier" test.
  - `[C-AND-VARMERGE-01]` → "merges branch-local variables at the join in document order (later branch wins a conflict)".
  - `[C-AND-NESTED-01]` → "nested regions: the inner join output satisfies the enclosing branch at the outer join (L3.5)".

- [ ] **Step 2: Run the file**

Run: `npx vitest run tests/integration/parallel-gateway.test.ts`
Expected: PASS (titles changed, behavior unchanged).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/parallel-gateway.test.ts
git commit -m "test(m4): tag C-AND-2BRANCH/VARMERGE/NESTED in parallel-gateway.test.ts"
```

### Task 2.2: Mark the remaining `extends-existing` scenarios

**Files:** Modify, one marker each (verify the `directFile` in `registry.ts` for the exact file, then confirm the target `it` body matches the scenario):

- [ ] `[C-AND-INTX-01]` → in `tests/integration/parallel-compensation.test.ts`, the AND-fork-inside-transaction **commit** (no-failure) path. If only failure paths exist, add a small `it("[C-AND-INTX-01] AND fork/join inside a transaction commits with both branch outputs merged")` driving `PARALLEL_SAGA_BPMN` with no steer flag (both branches + settle complete) and asserting `status === "completed"`.
- [ ] `[C-OR-SUBSET-01]` and `[C-OR-NOPATH-01]` → `tests/integration/inclusive-gateway.test.ts` (the activation-subset test and the zero-activation-noPath test).
- [ ] `[C-BRANCH-MSG-01]` → `tests/integration/parallel-message.test.ts` (distinct-message-per-branch overlay/merge test).
- [ ] `[C-BRANCH-EBG-01]` → `tests/integration/event-gateway.test.ts` (the "EBG inside a parallel branch" test).
- [ ] `[C-COMP-STRAGGLER-01]` and `[C-COMP-QUIESCE-01]` → `tests/integration/parallel-compensation.test.ts` (straggler-catching test; quiescence-barrier test).
- [ ] `[C-ERR-PRECEDENCE-01]` → `tests/integration/error-routing.test.ts` (the exact→catch-all→Hazard precedence test; if it is not on a parallel branch, that branch-confinement angle is a Phase-3 `W` concern — the precedence ladder itself is the direct coverage).
- [ ] `[C-ERR-HAZARD-01]` → `tests/integration/parallel-compensation.test.ts` or `service-task-incident.test.ts` (uncaught-error-in-a-branch → Hazard freeze; then `/cancel`).
- [ ] `[C-CAP-TRIO-01]` → `tests/integration/wait-cap-incidents.test.ts` (or the concurrencyLimit/stepBudget/poison cap test).
- [ ] `[C-BRANCH-POISON-01]` → the branch service-task output >1MiB poison test (likely `payload-limit.test.ts`).
- [ ] `[C-OP-CANCEL-MIDFAN-01]` → `tests/integration/parallel-compensation.test.ts` (operator `/cancel` from the incident/empty-ledger state).

> For each: confirm the marked `it` body genuinely exercises the scenario (read it). If the existing test does NOT cover it, treat the row as a **new** test instead — author it in the matching `tests/integration/matrix/*.test.ts` file following the Milestone-3 exemplar, and update its `registry.ts` `coverage` to `"new"` and `directFile` to the matrix file.

- [ ] **Step (per file): Run + commit** the touched file: `npx vitest run <file>` (Expected: PASS), then `git commit`.

- [ ] **Step (final): re-run the guard**

Run: `npm run check:matrix`
Expected: the 15 `extends-existing` ids no longer appear as failures; only the 20 new `C-*` and 11 `R-*` remain red.

---

## Milestone 3 — New direct-mode `C-*` tests

> **Convention for every test below:** `it("[<ID>] <short title>", async () => { … })`. Use the `tests/helpers.ts` API. The **first assertion of every test must be that the model publishes** (`publishAndStart` returns `instance.status === 201`) so a malformed/illegal fixture fails loudly rather than mid-drive. New fixtures live in `tests/fixtures/matrix/fixtures.ts` and must mirror the structure of `PARALLEL_BPMN` / `PARALLEL_SAGA_BPMN`; the SESE validator (`src/bpmn/regions.ts`) is strict, so each new region must be single-entry/single-exit with a matching same-type join.

### Task 3.1: New fixtures file (author the ~9 SESE-valid models)

**Files:**
- Create: `tests/fixtures/matrix/fixtures.ts`

- [ ] **Step 1: Author the fixtures (one export each), each a valid model unless its scenario is a reject**

Author these consts (structural spec — mirror `PARALLEL_BPMN`; bind every service task with `<easy-bpmn:taskDefinition type="…"/>`; keep regions balanced):

1. `PARALLEL_3ASYM_BPMN` — `fork → (A | B1→B2→B3 | recvC[messageRef Mc]) → join → End`. Three branches off one `parallelGateway`, matched by one `parallelGateway` join; branch B is a 3-task chain; branch C is a `receiveTask`. (C-AND-3ASYM-01)
2. `PARALLEL_BRANCH_TIMER_BPMN` — `fork → (svcA[interrupting boundaryTimer timeDuration=PT30S → altA] | svcB) → join → End`, where `altA` is an in-region service task flowing to `join`. (C-AND-BTIMER-01/02)
3. `OR_NEST_AND_BPMN` — `inclusiveGateway split (b1: innerFork→(x|y)→innerJoin ; b2: svc ; default: log) → inclusiveGateway join → End`. The nested AND region lives wholly inside OR branch b1. (C-OR-NESTAND-01)
4. `PARALLEL_BRANCH_ITIMER_BPMN` — `fork → (svcA → intermediateCatch[timerEventDefinition timeDuration=PT30S] → svcA2 | svcB) → join → End`. (C-BRANCH-ITIMER-01)
5. `PARALLEL_SAGA_MULTISTEP_BPMN` — like `PARALLEL_SAGA_BPMN` but each branch is a 2-task chain, each task carrying its own compensation boundary+handler: `tx{ fork → (A1[compA1]→A2[compA2] | B1[compB1]→B2[compB2]) → join → settle[errBoundary→Tx_cancel] }`. (C-COMP-LINEAGE-REVERSE-01, C-IDEMP-COMP-DUP-01)
6. `PARALLEL_NESTEDTX_BRANCH_BPMN` — `outerTx{ fork → (branchA{ innerTx{ a1[comp] → innerNoneEnd } → a2[comp] } | branchB[comp]) → join → settle[err→outer Tx_cancel] }`. The inner `transaction` is one CFG vertex inside branch A; its commit (inner none-end) terminalizes a1's scope. (C-COMP-NESTEDTX-BRANCH-01)
7. `PARALLEL_LOOP_BRANCH_BPMN` — `tx{ fork → (loopBranch{ svcA[comp] → xorGW —(loop cond)→ back to svcA / (default)→ exit } | svcB[comp]) → join → settle[err→Tx_cancel] }`. The loop is wholly inside branch A. (C-COMP-LOOP-BRANCH-01)
8. `PARALLEL_BRANCH_NOPATH_BPMN` — `fork → (svcA → xorGW[two conditional out-flows, NO default] | svcB) → join → End`. (C-BRANCH-NOPATH-01)
9. `PARALLEL_LOOP_INBRANCH_BPMN` — `fork → (svcA → xorGW —(cond)→ back to svcA / (default)→ exit | svcB) → join → End` (process-level, no tx — distinct from #7). (C-LOOP-INBRANCH-01, C-LOOP-LIMIT-BRANCH-01 via a `spin`-style self-loop variant)
10. `PARALLEL_BRANCH_ERR_COMP_BPMN` — `tx{ fork → (svcA[errBoundary @E1 → altA[comp]] | svcB[comp]) → join → settle[err→Tx_cancel] }`. (C-ERR-BRANCH-COMP-01)
11. `PARALLEL_LOOP_CROSS_BPMN` (a **reject** fixture) — `fork → (A→B) → join → post`, plus a back-edge `post → B` re-entering the region. Used by `R-LOOP-CROSS-01` (Milestone 4). Derive by string surgery from `PARALLEL_BPMN` (add one `<sequenceFlow>` from a post-join node back to `B`).

- [ ] **Step 2: Smoke-publish every valid fixture**

Add a temporary test `tests/fixtures/matrix/_publish.smoke.test.ts` that imports each *valid* fixture and asserts `publishAndStart(fx, …).instance.status === 201` (and that `PARALLEL_LOOP_CROSS_BPMN` is rejected). Run:

Run: `npx vitest run tests/fixtures/matrix/_publish.smoke.test.ts`
Expected: PASS — all valid fixtures publish; the cross-loop one rejects. **If a valid fixture rejects**, the region is not SESE: read the validator error (it names the offending element id) and fix the model. Delete this smoke file after it goes green (or keep it as a fixture sanity test — your call; the markers it lacks make it invisible to `check:matrix`).

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/matrix/fixtures.ts
git commit -m "test(m4): SESE-valid matrix fixtures (parallel branch timer/itimer/loop/nested-tx/multistep, OR-nest-AND, +reject cross-loop)"
```

### Task 3.2: `concurrency.test.ts` — exemplar (C-AND-3ASYM-01), fully worked

**Files:**
- Create: `tests/integration/matrix/concurrency.test.ts`

- [ ] **Step 1: Write the test (full code — this is the pattern every later `C-*` test copies)**

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, get, mintWorkerToken, leaseOne, authedPost, publishMessage } from "../../helpers";
import { PARALLEL_3ASYM_BPMN } from "../../fixtures/matrix/fixtures";
import { listTokens } from "../../../src/persistence/tokens";

const complete = (t: string, j: { jobId: string; lockToken: string }, out: Record<string, unknown> = {}) =>
  authedPost(`/jobs/${j.jobId}/complete`, t, { lockToken: j.lockToken, outputVariables: out });

describe("matrix: concurrency corners (direct mode)", () => {
  it("[C-AND-3ASYM-01] short branches park at the join until the long branch drains (last-token-out)", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_3ASYM_BPMN, { correlationKey: "asym1", variables: {} });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Short branch A completes; receive-branch C is satisfied by a message; long branch B is a 3-task chain.
    await complete(token, await leaseOne(token, "svc-a"), { a: 1 });
    await publishMessage({ messageName: "Mc", correlationKey: "asym1", messageId: "mc-1", payload: { c: 1 } });

    // The join must NOT be satisfied while branch B is mid-chain.
    let inst = await get(`/instances/${id}`);
    expect(inst.body.status).not.toBe("completed");

    // Drain the long branch B step by step.
    await complete(token, await leaseOne(token, "svc-b1"), { b1: 1 });
    inst = await get(`/instances/${id}`);
    expect(inst.body.status).not.toBe("completed"); // still mid-B
    await complete(token, await leaseOne(token, "svc-b2"), { b2: 1 });
    await complete(token, await leaseOne(token, "svc-b3"), { b3: 1 });

    // Now all three origin-branch tokens have arrived → the join fires once; drain the post-join task.
    await complete(token, await leaseOne(token, "after-join"), {});
    inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.variables).toMatchObject({ a: 1, c: 1, b1: 1, b2: 1, b3: 1 });

    // Frontier empty; one join_arrivals row per branch; exactly one join token emitted.
    const rows = await listTokens(env.DB, id);
    expect(rows.filter((r) => ["active", "waiting", "arrivedAtJoin"].includes(r.status))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/integration/matrix/concurrency.test.ts`
Expected: PASS. If FAIL → invoke `superpowers:systematic-debugging` (real bug or wrong task-type names in the fixture — reconcile fixture `type=` with the lease `taskType`).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/matrix/concurrency.test.ts
git commit -m "test(m4): [C-AND-3ASYM-01] asymmetric AND last-token-out"
```

### Task 3.3: `concurrency.test.ts` — remaining scenarios

Add one `it("[<ID>] …")` per row, in the same file, following the Task-3.2 pattern. Each spec below is complete (fixture · drive · assertions); write the `it`, run the file (Expected: PASS), commit after each.

- [ ] **`[C-AND-BTIMER-01]`** — fixture `PARALLEL_BRANCH_TIMER_BPMN`. Drive: start; before completing `svcA`'s job, fire branch A's interrupting boundary-timer alarm (short `PT30S`; in direct mode trigger the timer's Durable Object alarm — use the same alarm-firing helper the existing `boundary-timer.test.ts` uses, e.g. `runDurableObjectAlarm`/`fireTimer`); complete `altA` and `svcB`; lease/complete the post-join task. Assert: the boundary timer interrupts `svcA` (its job is cancelled — a later lease of its taskType returns 0 jobs), the branch token follows the redirect to `altA` staying in-region, sibling `svcB` is unaffected, the join waits for the redirected-A token **and** B, and the instance reaches `completed`.

- [ ] **`[C-AND-BTIMER-02]`** — fixture `PARALLEL_BRANCH_TIMER_BPMN`. Drive: start; **complete `svcA`'s job promptly** (before firing the timer); THEN fire the branch boundary-timer alarm (and a duplicate fire); complete `svcB`; finish. Assert: the completed `svcA` fast-forwards the branch token onto the join's normal out-flow (`altA` is NOT taken — leasing its taskType returns 0 jobs); the late timer alarm is an idempotent no-op (`fireTimer` finds the job already settled) — no new history, root scope untouched; the duplicate alarm is also a no-op; the join fires exactly once; terminal `completed`.

- [ ] **`[C-OR-NESTAND-01]`** — fixture `OR_NEST_AND_BPMN`. Drive: start with variables activating OR branch b1 (the nested-AND one) **and** b2; lease/complete the nested AND's `x` and `y`, then b2's service task; finish. Assert: the nested AND-join folds onto the OR-branch-b1 token; the OR-join waits on the recorded activated subset including the folded b1 token; instance `completed`; merged vars include x, y, and b2 outputs.

- [ ] **`[C-BRANCH-ITIMER-01]`** — fixture `PARALLEL_BRANCH_ITIMER_BPMN`. Drive: start; complete `svcA`; fire branch A's intermediate-timer alarm (`PT30S`, direct-mode alarm trigger); complete `svcA2` and `svcB`; finish. Assert: branch A parks at the timer (armed timer keyed to the branch token), sibling B proceeds independently, the join waits for both, instance `completed`.

(C-AND-2BRANCH / VARMERGE / NESTED / OR-SUBSET / OR-NOPATH / BRANCH-MSG / BRANCH-EBG are `extends-existing` — handled in Milestone 2, not here.)

### Task 3.4: `compensation.test.ts` — 7 scenarios

**Files:** Create `tests/integration/matrix/compensation.test.ts` (same imports as Task 3.2 plus `drainSampleWorkers`, `rewindBackoff`). One `it("[<ID>] …")` each; run + commit per scenario.

- [ ] **`[C-COMP-LINEAGE-REVERSE-01]`** — fixture `PARALLEL_SAGA_MULTISTEP_BPMN`. Drive: complete A1,A2,B1,B2; make `settle` raise its business error (steer the sample worker via a variable, mirroring `PARALLEL_SAGA_BPMN`'s `failSettle`) → `Tx_cancel`; `drainSampleWorkers` for the comp task types; read `GET /instances/{id}/history`. Assert: **within** branch A, `compA2` runs strictly before `compA1`; **within** branch B, `compB2` before `compB1` (per-lineage reverse = saga `seq` DESC over the same `token_id`); **cross-branch** order is NOT pinned (assert only the per-lineage suffix order, never a global A-before-B total order); every step ends `compensationStatus="compensated"`; instance terminal `compensated`; exactly one root token at end.

- [ ] **`[C-COMP-FAILED-01]`** — fixture `PARALLEL_SAGA_BPMN` (steer `failSettle`) and configure the `comp-a` sample worker to exhaust its retries. Drive: trigger cohort compensation; drain comps so `compA` exhausts. Assert: `markStepCompensationFailed` → `compensationFailure` incident + status `compensationFailed`; sibling B lineage compensated; instance is operator-resumable (`POST /retry` is accepted); no partial double-apply.

- [ ] **`[C-COMP-FAILED-INFLIGHT-01]`** — fixture `PARALLEL_SAGA_BPMN`. Drive: reach cohort compensation with **branch B's forward job still locked** (lease it, never complete); make `compA` exhaust → `compensationFailed`; then fire B's lease-expiry terminator and/or complete B late; finally `POST /retry` (after making `compA` succeed). Assert: status `compensationFailed` + open `compensationFailure` incident the **instant** `compA` fails (does not wait for B); B's terminator firing on the `compensationFailed` instance is a guarded no-op (`terminateUnleasableJob` returns when `status!=='compensating'`); a late B complete is not advanced past the terminal; `/retry` resumes `compensating`, the barrier re-scans, B is straggler-ledgered+compensated before the final terminal; no double-apply on any lineage.

- [ ] **`[C-COMP-NESTEDTX-BRANCH-01]`** — fixture `PARALLEL_NESTEDTX_BRANCH_BPMN`. Drive: drive branch A's inner tx to commit (`a1` done, inner none-end) then `a2`; drive branch B; `settle` fails → outer `Tx_cancel`; drain comps. Assert: inner-tx step `a1` is `compensation_status="committed"` after the inner commit and is **never** re-compensated by the outer cancel (scope_id filter + committed-terminal both exclude it); outer-scope steps (`a2`, branch B) ARE compensated in their lineages; no double-apply of `compA1`; quiescence holds until both branch lineages drain; terminal `compensated`.

- [ ] **`[C-COMP-LOOP-BRANCH-01]`** — fixture `PARALLEL_LOOP_BRANCH_BPMN`. Drive: loop branch A 3 iterations (`svcA:el#0,#1,#2`, each ledgered with the same `token_id`); drive B; `settle` fails → cancel; drain comps. Assert: three comp jobs for `svcA` in **reverse occurrence order** (#2,#1,#0), each seeded with its own iteration's captured input/output, all carrying the **same** branch `token_id`; `filterLineageQuiesced` blocks the looped lineage's steps only while that token is live; sibling B compensated independently; cross-branch order unconstrained; terminal `compensated`.

- [ ] **`[C-IDEMP-COMP-DUP-01]`** — fixture `PARALLEL_SAGA_MULTISTEP_BPMN`. Drive: trigger cohort compensation; complete the `compA2` comp job, then **re-POST the same `/jobs/{id}/complete`** (same lockToken); let the pass continue. Assert: `compA2`'s step flips to `compensated` exactly once; the second complete is a stable no-op (no second `compensationCompleted` history, no cursor double-advance); `compA1` and branch B still compensate in correct per-lineage reverse order; final ledger identical to a single-delivery run; terminal `compensated`.

- [ ] **`[C-ERR-BRANCH-COMP-01]`** — fixture `PARALLEL_BRANCH_ERR_COMP_BPMN`. Drive: fail `svcA` with business error `E1` → routes to `altA` in-region; complete `altA` and `svcB`; `settle` fails → `Tx_cancel`; drain comps. Assert: `saga_steps` has **no** row for `svcA` (failed+routed owes no compensation); `altA` and `svcB` each have a ledger row with their branch `token_id`; cancel compensates `altA` + `svcB` in their lineages; no comp job is ever created for `svcA`; terminal `compensated`; deterministic regardless of node-iteration order.

### Task 3.5: `errors.test.ts` — 1 scenario

**Files:** Create `tests/integration/matrix/errors.test.ts`.

- [ ] **`[C-BRANCH-NOPATH-01]`** — fixture `PARALLEL_BRANCH_NOPATH_BPMN`. Drive: start with variables that make branch A's XOR match no condition (and it has no default); keep B in-flight (lease, don't complete). Assert: a `noPath` (or `conditionFailure` if you inject a hard FEEL error) incident is raised on branch A; whole instance goes `incident` (no sibling wedge/runaway); B token frozen; deterministic; terminal within the test. Then run + commit.

### Task 3.6: `caps-loops.test.ts` — 4 scenarios

**Files:** Create `tests/integration/matrix/caps-loops.test.ts`.

- [ ] **`[C-LOOP-INBRANCH-01]`** — fixture `PARALLEL_LOOP_INBRANCH_BPMN`. Drive: loop branch A 3 iterations; complete B; finish. Assert: each branch-A iteration is its own occurrence (`svcA:el#0,#1,#2`) with fresh job rows; sibling B occurrences independent; no cross-token occurrence collision; join waits for looped-A + B; `completed`.

- [ ] **`[C-LOOP-LIMIT-BRANCH-01]`** — fixture `PARALLEL_LOOP_INBRANCH_BPMN` driven into a self-loop past `MAX_ELEMENT_OCCURRENCES` (use the `spin`-style pure-gateway self-loop the existing `SAGA_LOOP_BPMN` uses to burn the cap without 1000 real jobs). Assert: a `loopLimit` incident on the looping element (cap=1000), **not** `stepBudget` nor `concurrencyLimit`; Hazard semantics if inside a tx (no auto-compensation); sibling B frozen; terminal within the test.

- [ ] **`[C-BRANCH-DLQ-01]`** — fixture `PARALLEL_BPMN` (reuse). Drive: start; **never** `/jobs/activate` for `reserve-stock` (branch A); fire branch A's per-job `JobScheduler` alarm at `activation_expires_at` (mirror the DLQ-timer firing in `saga-dlq-timeout.test.ts`; if `ACTIVATION_TTL_MS` is env-overridable, shorten it); poll to terminal; then `POST /cancel`. Assert: `terminateUnleasableJob` writes a terminal incident `kind="jobActivationTimeout"` (NOT `waitTimeout`, NOT `serviceTaskFailure`) tagged with the branch token; instance `incident`; live sibling `authorize-payment` token frozen (cohort capture), not advanced past the join; a duplicate/late alarm is an idempotent no-op (D1 re-read guard); operator `/cancel` then settles the frozen cohort.

- [ ] **`[C-BRANCH-RETRY-01]`** — fixture `PARALLEL_SAGA_BPMN` (`retries` on branch A) or `PARALLEL_BPMN`. Drive: lease branch-A job, `POST /jobs/{id}/fail` `retryable:true`; assert it parks behind backoff (`status='locked'`, `lock_token` NULL, future `lock_expires_at`); `rewindBackoff` then re-lease (and exercise lease-expiry reclaim); on the **success** variant complete A; on the **exhaust** variant fail past `retries`; complete B throughout. Assert: each retry parks `lock_expires_at = computeBackoffMs(attempt)` and bumps `attempt_count` on the **same** occurrence-keyed `svcA:el#0` row (no collision with B's rows); sibling B advances independently while A backs off; an expired in-flight branch lease reclaims (attempt bump) not a fresh job; success variant → join fires once with A's output; exhaust variant → `serviceTaskFailure` Hazard, sibling B frozen; deterministic terminal.

### Task 3.7: `idempotency-operator.test.ts` — 3 scenarios

**Files:** Create `tests/integration/matrix/idempotency-operator.test.ts`.

- [ ] **`[C-IDEMP-DUP-01]`** — reuse `PARALLEL_BPMN` (for the duplicate **worker callback** half) and `PARALLEL_MESSAGE_DISTINCT_BPMN` (for the duplicate **message** half) as two `it` bodies under the one marker, OR one combined fixture `fork→(svcA | msgCatchB)`. Drive: complete `svcA` twice (same `lock_token` / replayed); publish `msgB` twice (same `workspace+name+correlationKey+messageId`); finish. Assert: the completed job (`output_applied=1`) fast-forwards write-free → branch A advances once; the duplicate publish returns the stable prior outcome → branch B advances once; the join fires once; no duplicate history step; merged vars identical to a single-delivery run.

- [ ] **`[C-IDEMP-MSGTIMING-01]`** — reuse `PARALLEL_MESSAGE_DISTINCT_BPMN`. Drive: publish `msgA` **before** branch A registers its subscription (early-buffered); fan out; A registers and claims the buffered `msgA`; after A advances, publish a **new** `msgA` messageId (late). Assert: the early `msgA` is buffered then claimed by branch A's subscription at registration (at-most-one active subscription per broker key); the late `msgA` records `outcome=late` and does NOT re-advance branch A; the join is unaffected.

- [ ] **`[C-OP-RETRY-COMPFAILED-01]`** — reuse the `C-COMP-FAILED-01` setup (`PARALLEL_SAGA_BPMN`, `failSettle`, `comp-a` exhausts) to reach `compensationFailed`; then make the compensator succeed and `POST /instances/{id}/retry`. Assert: `/retry` re-drives only the failed compensator (conditional reset on `compensationFailure` status); already-compensated sibling lineages are NOT re-run; the `compensationFailure` incident is closed; instance reaches `compensated`; no double-apply.

---

## Milestone 4 — `R-*` reject tests (publish-validation)

### Task 4.1: Reject-test harness + the 10 reuse-fixture rejects

**Files:**
- Create: `tests/matrix/reject.test.ts`

- [ ] **Step 1: Write the parametrized reject test (full code)**

```ts
import { describe, it, expect } from "vitest";
import { createDraft, publishDraft } from "../helpers";
import {
  PARALLEL_DEADLOCK_BPMN, PARALLEL_MISMATCH_BPMN, PARALLEL_SAME_MESSAGE_BPMN,
} from "../helpers";
import {
  R_BOUNDARY_ON_GW_BPMN, R_MERGE_UNCONTROLLED_BPMN, R_JOIN_NOFORK_BPMN,
  R_MERGE_NONLAMINAR_BPMN, R_INSTANTIATE_BPMN, R_NONINT_TIMER_BPMN,
  R_COND_OFF_XOR_BPMN, R_BRANCH_ESCAPE_BPMN, PARALLEL_LOOP_CROSS_BPMN,
} from "../fixtures/matrix/fixtures";

// Each row: [scenarioId, fixture, a substring the rejection reason should contain].
const REJECTS: Array<[string, string, RegExp]> = [
  ["R-BOUNDARY-ON-GW-01",     R_BOUNDARY_ON_GW_BPMN,     /boundary|gateway/i],
  ["R-MERGE-UNCONTROLLED-01", R_MERGE_UNCONTROLLED_BPMN, /merge|incoming/i],
  ["R-JOIN-MISMATCH-01",      PARALLEL_MISMATCH_BPMN,    /join|type|mismatch/i],
  ["R-JOIN-NOFORK-01",        R_JOIN_NOFORK_BPMN,        /join|split|match/i],
  ["R-MERGE-NONLAMINAR-01",   R_MERGE_NONLAMINAR_BPMN,   /laminar|overlap|region/i],
  ["R-LOOP-CROSS-01",         PARALLEL_LOOP_CROSS_BPMN,  /region|escape|loop|entry/i],
  ["R-SAMEMSG-01",            PARALLEL_SAME_MESSAGE_BPMN, /message/i],
  ["R-INSTANTIATE-01",        R_INSTANTIATE_BPMN,        /instantiate/i],
  ["R-NONINT-TIMER-01",       R_NONINT_TIMER_BPMN,       /interrupt|cancelActivity/i],
  ["R-COND-OFF-XOR-01",       R_COND_OFF_XOR_BPMN,       /condition|gateway/i],
  ["R-BRANCH-ESCAPE-01",      R_BRANCH_ESCAPE_BPMN,      /escape|region|branch/i],
];

describe("matrix: publish-validation rejects (direct mode)", () => {
  for (const [id, bpmn, reason] of REJECTS) {
    it(`[${id}] rejects at publish with the offending element id`, async () => {
      const draft = await createDraft(bpmn);
      expect(draft.status).toBe(201);
      const pub = await publishDraft(draft.body.draftId);
      expect(pub.status, `${id} should reject`).toBeGreaterThanOrEqual(400);
      const text = JSON.stringify(pub.body);
      expect(text, `${id} reason`).toMatch(reason);
      // The constitution requires an element id in the reason — assert at least one id-looking token.
      expect(text).toMatch(/[A-Za-z_][A-Za-z0-9_-]*/);
    });
  }
});
```

> Reuse from `helpers.ts`: `PARALLEL_DEADLOCK_BPMN` covers `R-JOIN-NOFORK`-adjacent deadlock — but `R-JOIN-NOFORK-01` is specifically a dangling multi-incoming join with no split; author `R_JOIN_NOFORK_BPMN` (a `parallelGateway` join with 2 incomings and no matching split). `PARALLEL_MISMATCH_BPMN` and `PARALLEL_SAME_MESSAGE_BPMN` already exist and are imported directly.

- [ ] **Step 2: Author the 7 new reject fixtures in `tests/fixtures/matrix/fixtures.ts`** (`R_BOUNDARY_ON_GW_BPMN`, `R_MERGE_UNCONTROLLED_BPMN`, `R_JOIN_NOFORK_BPMN`, `R_MERGE_NONLAMINAR_BPMN`, `R_INSTANTIATE_BPMN`, `R_NONINT_TIMER_BPMN`, `R_COND_OFF_XOR_BPMN`, `R_BRANCH_ESCAPE_BPMN`). Each is a minimal model violating exactly one rule (see spec Appendix B for the rule + citation). Prefer string-surgery off `PARALLEL_BPMN` where natural (e.g. `R_MERGE_UNCONTROLLED_BPMN` = add a second incoming to a non-join task; `R_BRANCH_ESCAPE_BPMN` = redirect a branch flow to a node outside the region). `R_INSTANTIATE_BPMN` can use `deferredGatewayBpmn` + `instantiate="true"`, or `INSTANTIATE_RECEIVE_BPMN` from helpers (then drop the local fixture and import that).

- [ ] **Step 3: Run it**

Run: `npx vitest run tests/matrix/reject.test.ts`
Expected: PASS (all 11 reject). If any **publishes** (status 2xx), the fixture does not actually violate the rule — read the validator and fix the fixture, not the test.

- [ ] **Step 4: Commit**

```bash
git add tests/matrix/reject.test.ts tests/fixtures/matrix/fixtures.ts
git commit -m "test(m4): [R-*] 11 publish-validation reject tests + fixtures"
```

---

## Milestone 5 — Green guard + CI + close-out

### Task 5.1: Drive `check:matrix` to green for Phase 1

- [ ] **Step 1: Run the guard**

Run: `npm run check:matrix`
Expected: PASS — "all phase<=1 markers present" with only deferred-phase (`W-*`) warnings. If any `C-*`/`R-*` still fails, the named scenario has no `[id]` marker in its `directFile`: either add the marker (Milestone 2/3/4) or correct the `directFile` in `registry.ts`.

- [ ] **Step 2: Run the full direct suite**

Run: `npm run test && npm run typecheck && npm run check:docs && npm run check:matrix`
Expected: all PASS.

- [ ] **Step 3: Commit any registry `directFile` corrections**

```bash
git add tests/matrix/registry.ts
git commit -m "test(m4): reconcile registry directFile mappings to land check:matrix green"
```

### Task 5.2: Wire `check:matrix` into CI

**Files:**
- Modify: the CI workflow that runs `npm run check:docs` (under `.github/workflows/`).

- [ ] **Step 1: Add the step**

Next to the existing `npm run check:docs` step, add:

```yaml
      - name: Matrix drift-check
        run: npm run check:matrix
```

- [ ] **Step 2: Verify the workflow YAML parses**

Run: `npx --yes js-yaml .github/workflows/<file>.yml >/dev/null && echo "yaml ok"`
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/
git commit -m "ci(m4): run check:matrix in CI (phase 1 enforced)"
```

### Task 5.3: File the surfaced defect + close-out

- [ ] **Step 1: File the `W-BUFFERED-STRAND` backlog task** (the code-confirmed apply-from-D1 provenance hole for buffer-claimed messages — `matched_subscription_id` left NULL; spec §7). Use the Backlog MCP (`task_create`) under milestone M4; reference `W-BUFFERED-STRAND-01` and the spec.

- [ ] **Step 2: Update `easy_bpmn` memory** noting Phase 1 of the e2e matrix landed (registry + `check:matrix` + Layer A direct), and that Phases 2–3 (Workflow-mode) remain, with Phase 3 gated on TASK-54.

- [ ] **Step 3: Final verification before handoff**

Run: `npm run test && npm run typecheck && npm run check:docs && npm run check:matrix`
Expected: all PASS. Report the green output verbatim (per `superpowers:verification-before-completion`).

---

## Self-Review (run against the spec)

- **Spec coverage:** Phase-1 portion of the spec (§2 Layer A, §3.1 substrate, §6 drift-guard, §9 stats) → Milestones 0–5. The 46 phase-1 scenarios (35 `C-*` + 11 `R-*`) each map to a task (Milestone 2 for the 15 `extends-existing`, Milestone 3 for the 20 new, Milestone 4 for the 11 rejects). Phase-2/3 (`W-*`) explicitly deferred — not a gap.
- **Placeholder scan:** the only "author this" steps are the BPMN fixtures (Task 3.1, 4.1) and CI YAML edit (5.2) — each carries a concrete structural spec or a reuse target, not a vague "add a fixture". Reject reasons use tolerant regexes (the exact wording is the validator's, asserted to contain the rule keyword + an id token).
- **Type/name consistency:** `Scenario`/`SCENARIOS` (registry), `[<id>]` marker convention, `directFile`/`workflowFile`/`phase` fields, and `MATRIX_PHASE` env are used identically across the guard, the registry test, and every test task. Fixture export names in `tests/fixtures/matrix/fixtures.ts` match their importers in Tasks 3.2–3.7 and 4.1.
- **Known risk:** authoring 9 SESE-valid + 8 reject fixtures is the main execution risk; Task 3.1 Step 2 (smoke-publish) front-loads that risk before any drive logic is written.
