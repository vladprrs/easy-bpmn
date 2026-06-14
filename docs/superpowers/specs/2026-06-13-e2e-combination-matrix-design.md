# E2E Combination Matrix — Design

**Status:** Approved (design) · **Date:** 2026-06-13 · **Branch:** `m4-concurrency`
**Owner topic:** comprehensive e2e tests for *all supported elements, all corners, and their combinations*, across **direct-mode** and **Workflow-mode**.

> Source-of-truth note: this design is grounded in the actual engine code (every claim below is traceable to a `file:line` citation in Appendix A/B). Where the prompt's mental model and the code disagreed, the code wins — see the corrections in §8.

---

## 1. Problem & motivation

The orchestrator has **413 passing test cases across 58 files** (11 unit · 4 contract · 43 integration *files*), but **every one runs `EXECUTION_MODE=direct`** (forced in `vitest.config.ts`). The real Cloudflare Workflow suspend/resume path — `step.do` memoization + `step.waitForEvent` parking + deterministic replay — has **zero automated coverage**.

That gap is not academic: the **M4 multi-wait AND/OR-join hangs on real Cloudflare Workflows** (L6.6 / `R-cf-multiwait`). It escaped CI *precisely because* CI is direct-mode only — the `raceParkedWaits` multi-wait path (`frontier.ts`) is never invoked in direct mode. The TASK-54 single-wake fix is designed + probe-validated but not fully wired.

So "all corners, all elements, all combinations" must sit on a **two-layer** harness: direct-mode for semantics (fast, CI-gated) **and** Workflow-mode for the suspend/resume/replay reality that the production defect lives in.

### Goals
- Systematic, **auditable** coverage of every supported construct and every high-risk **combination corner**, weighted toward M4 concurrency interactions.
- A **Workflow-mode** layer that would have caught L6.6 and that becomes the executable **M4-closure acceptance gate**.
- A **drift-guard** so coverage cannot silently rot as the profile grows.

### Non-goals
- Implementing TASK-54 (single-wake) — separate, in-flight work; this effort *targets* the post-fix contract and is expected to land after it.
- Load/perf testing beyond the cap-trio scenario.
- Exhaustive all-pairs combinatorics — we use a **risk-curated** matrix (~60 scenarios), not naive ~100+ pairs.

---

## 2. Approach (selected: hybrid "Approach C")

A shared substrate drives **both** layers from **one fixture per scenario family**:

- **Layer A — direct-mode (vitest, CI-gated):** semantics of every element + every combination corner. Extends the existing `tests/integration/*`. All 11 reject-path (`R-*`) publish-validation tests live here.
- **Layer B — Workflow-mode (`wrangler dev` primary + real-CF smoke gate):** suspend/resume, replay, multi-wait, self-heal, apply-from-D1. Driven **only** over the public HTTP API.

Key enabling fact: the project **already defaults to `EXECUTION_MODE=workflow`** in `wrangler.jsonc`; only `vitest.config.ts` overrides it to `direct`. So `npm run dev` (→ `wrangler dev`, `http://localhost:8787`) drives every instance through the **real** `ProcessWorkflow` + `step.waitForEvent` under workerd/miniflare, no code change needed. The probe confirmed the L6.6 hang and the single-wake fix reproduce **locally byte-for-byte** (`local == edge`), so `wrangler dev` is a viable *automated* Workflow-mode layer; real CF remains the final certification gate.

Rejected alternatives:
- **A (matrix-as-data / fully parametrized):** elegant but BPMN-generation-by-parameter is brittle and many corners need bespoke assertions.
- **B (two hand-written suites, manual coverage doc):** clear but coverage tracking drifts.
- **C wins** because it keeps A's auditability (a registry + drift-guard) and B's bespoke assertions, while reusing **one BPMN model across both modes** (e.g. `parallel + boundary-timer` proves merge semantics in direct **and** suspend/resume in Workflow).

---

## 3. Harness architecture

### 3.1 Shared substrate
- `tests/fixtures/matrix/*.bpmn` — one BPMN model per scenario family (e.g. `parallel-branch-timer.bpmn`, `or-nest-and.bpmn`, `comp-lineage.bpmn`). Reused by both layers.
- `tests/helpers.ts` (extended) — drive-recipes already present (`drainSampleWorkers`, `leaseAndComplete`, `publishMessage`, `rewindBackoff`, `runDurableObjectAlarm`) **plus** a new **`BASE_URL`-parameterized HTTP driver** so the identical drive sequence runs against vitest-`SELF`, `wrangler dev`, and a deployed `*.workers.dev`.
- `tests/matrix/registry.ts` — the **single source-of-truth** registry of all 60 scenarios: `{id, title, axes[], legality, modes[], risk, fixture, coverage, existingRef}`.

### 3.2 File / directory layout
```
tests/
  matrix/
    registry.ts            # 60 scenarios — source of truth for coverage
    reject.test.ts         # all R-* (direct, publish-validation), parametrized over registry
  fixtures/matrix/*.bpmn   # one model per scenario family
  integration/matrix/      # Layer A: C-* direct-mode tests (extend existing integration tests)
  workflow-mode/
    driver.ts              # BASE_URL HTTP driver + bounded-poll-to-terminal
    run.config.ts          # vitest project / node runner — NOT in the default CI run
    *.wf.test.ts           # Layer B: W-* + the C-* re-run in workflow mode
    probe/                 # promoted /tmp/cf-wf-probe — CF-semantics regression (B hangs / C completes)
docs/superpowers/specs/2026-06-13-e2e-combination-matrix-design.md   # this doc + full table
specs/002-saga-orchestrator/                                          # links the matrix as an acceptance appendix
```

### 3.3 Run wiring
- `npm run test` (default CI) → unit + contract + Layer A direct-mode matrix + `reject.test.ts`. Stays fast and deterministic; gates every PR.
- `npm run test:wf` (new) → Layer B against `BASE_URL` (defaults to `http://localhost:8787`; override for real CF). Not in the default CI run (needs a live Worker / credentials).
- `npm run check:matrix` (new) → drift-guard (§6), runs in CI.

---

## 4. Workflow-mode mechanics & assertion model

Layer B asserts **only over the HTTP API** (`GET /instances/{id}`, `GET /instances/{id}/history`, `POST /jobs/*`, `POST /messages` — never Workflow internals), across four axes:

1. **Bounded-timeout completion (liveness / hang-detector).** Drive, then poll `GET /instances/{id}.status` until terminal `{completed | compensated | incident/failed}` **or** a bounded wall-clock deadline. Terminal-within-bound = PASS; still `running`/`waiting` past the deadline = FAIL — this is exactly the L6.6 symptom (an instance sat `running` for the full 1-hour `SVC_WAIT_TIMEOUT`). Requires injecting a **short `MAX_WAKE_BACKSTOP`** (seconds) via a `wrangler dev`/preview var so a genuinely lost wake self-heals inside the window.
2. **Deterministic final state (safety/idempotency).** Run with **swapped branch-completion order** (A-then-B vs B-then-A) and across a forced replay; deep-equal the two final `GET /instances/{id}` bodies (merged variables + status) and the saga ledger. No double-apply; each token reaches the join exactly once regardless of race winner.
3. **History-tag exactly-once (audit).** `GET /instances/{id}/history` contains each meaningful transition exactly once (`serviceTaskCompleted(A)` **and** `(B)`, `branchArrivedAtJoin` for both, per-token tags `tokenId/regionId/regionActivation/spanId`).
4. **Self-heal on lost wake.** Commit the awaited result to D1 **without** delivering the tickle (e.g. INSERT the correlated `external_messages` row, or persist the `jobs` outcome, with no `sendEvent`) → the instance must self-heal within the backstop.

### 4.1 Single-wake contract the tests target (post-TASK-54)
- **One constant event type** `WAKE_TYPE="bpmn_wake"` (underscore — event types forbid dots: `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`) for **all** instances and **all** causes (job result, message, timer). The wake is a **pure contentless tickle** ("state changed in D1, re-walk"); its payload is advisory/ignored.
- **Leaf drivers park, never suspend** — forward-task, `driveReceiveTask`, EBG/intermediate-timer catches, branch drivers record their park in D1 (job row / subscription / armed timer) and return parked. No leaf calls a suspending `waitFor` (exactly the direct-mode path where `waitFor===null`).
- **The drive loop owns the single wait** — `engine.ts loop` issues exactly **one** `step.waitForEvent({name: \`wake#${k}\`, workflowEventType: WAKE_TYPE, timeout: wakeBackstop(...)})` per parked pass, increments `k`, re-walks. Exactly one `waitForEvent` pending at a time is the only shape Probe B/C proved survives real-CF replay.
- **Apply-from-D1 is mandatory** — because the wake carries no data, every apply reads from D1 (jobs already do; the **new** work is message / EBG-message-branch apply reading the matched row, not the event payload).
- **Timer-aware backstop** — `wakeBackstop = min(timeToNextArmedTimer, MAX_WAKE_BACKSTOP)` keeps known-deadline waits O(1) steps (a 7-day timer stays cheap and fires on time).

### 4.2 CF-semantics constraints (Appendix B has the full list)
Steps cache by **name not order** (the *set* of pending `waitForEvent` must be replay-stable → deterministic `wake#k`); `waitForEvent` timeout **throws** (the catch *is* the self-heal path); ~1 MiB event-payload limit (wake never approaches it; oversized message/worker payloads rejected **before** delivery); `sendEvent` is instance-scoped so one global type never collides; real CF occasionally **lost** a wake to KV eventual consistency → the engine persists to D1 **before** `sendEvent` (read-your-writes), tickle is the fast primary, timeout is the rare backstop.

### 4.3 Real-CF gate (DoD)
Deploy to a **separate Worker name + separate D1** (never `bpmn.rntme.com`): `wrangler d1 migrations apply easy_bpmn --remote` → `wrangler deploy`, record the Version id. Drive the same HTTP sequence against `<name>.workers.dev`. Models use **short PT durations** (real wall-clock). Clean up `workspaceId="default"` test instances afterward. The probe truth-table (B hangs, C completes, C self-heals) re-validates the CF mechanism itself.

---

## 5. Phasing & relationship to TASK-54

- **Phase 1 — independent of TASK-54, green immediately, in CI:** shared substrate + registry + drift-guard + **Layer A** (all `C-*` direct + 11 `R-*`). Closes "all elements + all combination corners" at the semantics level.
- **Phase 2 — Workflow-mode infra + single-token regressions:** `driver.ts` + probe promotion + `W-REG-LINEAR/TIMER` (single-token paths work on `wrangler dev` **today**).
- **Phase 3 — Workflow-mode concurrency (the M4-closure gate):** `W-AND-*`, `W-SELFHEAL`, `W-APPLYFROMD1`, `W-JOIN-FOLD-REPLAY`, `W-COMP-CRASH-REPLAY`, etc. Authored now, held `.skip` with tag `@needs-task54` (expected-red) until the fix lands, then flipped to a required gate. These are the executable M4-closure criterion (including the auto-WM-2/3/4 from the manual matrix).

**Highest-risk core of the closure gate (8):** `C-AND-2BRANCH-01` (cheapest real-CF wake-path / hang detector), `W-SELFHEAL-01`, `W-AND-TICKLE-GAP-01` (the genuine concurrent dropped-tickle race), `W-APPLYFROMD1-01`, `W-BUFFERED-STRAND-01`, `W-AND-CRASH-01`, `W-JOIN-FOLD-REPLAY-01`, `W-COMP-CRASH-REPLAY-01`.

**Manual WM-matrix automation:** `W-AND-CRASH-01` = **WM-2**, `W-AND-NEARSIM-01` = **WM-3**, `W-AND-BRANCHTIMEOUT-01` = **WM-4** (explicit). `W-REG-LINEAR-01` (WM-1), `W-SELFHEAL-01` (WM-5?), `W-APPLYFROMD1-01` (WM-6?) are **inferred** — confirm against the L6.6 WM doc during planning.

---

## 6. Drift-guard `npm run check:matrix`

In the spirit of the existing `check:docs`, fails CI when:
- (a) a registered scenario lacks a test in **each** declared `mode`;
- (b) a supported flow-node from `src/bpmn/profile.ts` is covered by **zero** scenarios;
- (c) a reject rule from the legality set (Appendix B) is covered by **zero** `R-*` scenarios;
- (d) a **new** supported construct lands without a registry entry.

This keeps the registry, the doc table, and the tests in lockstep.

---

## 7. A real defect this matrix surfaced (not just a test)

`W-BUFFERED-STRAND-01` is **code-confirmed**, not hypothetical: an **early-buffered** message claimed at branch registration has **no apply-from-D1 provenance** — `matched_subscription_id` is left NULL — so a terminated-Workflow **inline re-drive strands it** (the message is lost). Action: file a backlog task for the fix; the scenario stays in the matrix as its acceptance test. (See Appendix A for the scenario row and citation.)

---

## 8. Code corrections folded into this design
- **No `payloadLimit` incident kind.** Oversized join-overlay → `poison` (`regions-runtime.ts:307-318`); oversized event payloads are rejected **before** delivery (not an incident). Full `IncidentKind` enum in Appendix B.
- **Constitution v2.3.0 (M4) is shipped in docs but the multi-wait AND/OR-join is not production-verified** — it hangs on real CF (L6.6). The Concurrency/Replay multi-wait values are spec-complete, not proven, until Phase 3 passes on real CF.
- **Caps:** `MAX_CONCURRENT_TOKENS=256`, `STEP_BUDGET_SOFT=20000`, `MAX_ELEMENT_OCCURRENCES=1000` (all `engine.ts`), `MAX_EVENT_PAYLOAD_BYTES=1_000_000` (`payload.ts:7`), `OVERLAY_INLINE_MAX_BYTES=512KiB` R2-offload (`tokens.ts:129`). The first two have env overrides (`*_OVERRIDE`) useful for cap tests.

---

## 9. Coverage statistics

- **Total:** 60 scenarios.
- **By legality:** 49 valid · 11 reject.
- **By mode:** 11 direct-only (all `R-*`) · 13 workflow-only · 36 both (incl. `W-BUFFERED-STRAND` as `[workflow, direct]`).
- **By coverage:** 31 new · 29 extends-existing · 0 duplicate.
- **By axis family:** Parallel-AND 5 · Inclusive-OR 3 · Branch-scoped events 5 · Compensation×concurrency 9 · Error/Hazard/noPath 3 · Caps/poison/loops/DLQ/retry 6 · Idempotency 2 · Operator 2 · Workflow-mode replay 14 · Legality rejects 11.

---

> **Appendices A (full 60-scenario matrix), B (legality rules + IncidentKind enum), and C (axes inventory)** are generated from the registry below to keep `file:line` evidence exact.


---

## Appendix A — Full scenario matrix (60, generated from registry)
Each scenario: **id** · risk · legality · modes · coverage(existingRef). Then rationale / fixture / drive / assertions.

### 1. Parallel-AND

#### `C-AND-2BRANCH-01` — 2-branch AND fork/join — forward completion + Workflow-mode liveness (L6.6 hang detector)
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/parallel-gateway.test.ts (direct only — no Workflow-mode liveness))
- **axes:** Concurrency:fan-out, Gateways:parallelGateway, Activities:serviceTask, Replay:multi-wait
- **rationale:** The headline regression class: the multi-wait AND-join HANGS on real Cloudflare Workflows (L6.6) yet is green in direct mode. The danger is a join that never wakes under real step.waitForEvent (lost/shrinking-membership wake). This is the cheapest model that exercises the exact wake path CI cannot reach.
- **fixture:** Start -> parGW fork -> (svcA | svcB) -> parGW join -> End (PARALLEL_BPMN)
- **drive:** publishAndStart(PARALLEL_BPMN); lease+complete svcA and svcB (both leasable concurrently); poll GET /instances/{id} to terminal within a bounded wall-clock deadline
- **assertions:** both branch jobs leasable concurrently; post-join task NOT leasable until both complete; status reaches completed within the bounded deadline (FAIL = stuck running/waiting past deadline, the L6.6 symptom); history has serviceTaskCompleted(A)+serviceTaskCompleted(B)+join-fired exactly once each; tokens[] collapses to one root token at completion

#### `C-AND-3ASYM-01` — 3-branch asymmetric AND — short branches park at join until the long branch drains (last-token-out)
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (—)
- **axes:** Concurrency:fan-out, Concurrency:join-barrier, Gateways:parallelGateway
- **rationale:** >2-branch forward completion is untested (parallel-caps' 4-branch only faults). Asymmetric branch lengths catch a join that fires on N-1 arrivals or an instance that 'completes' while the long branch is still live — the last-token-out bug.
- **fixture:** fork -> (svcA | svcB1->svcB2->svcB3 | recvC) -> join -> End
- **drive:** start; complete short branches A and C; assert join not satisfied; advance long branch B step-by-step; complete B; assert join fires
- **assertions:** join_arrivals has one row per branchFlowId; join satisfied only after ALL three origin-branch tokens arrive; instance never 'completed' while B token live; merged vars include all three branches; exactly one join token emitted

#### `C-AND-VARMERGE-01` — Branch-local overlay isolation + merge-order conflict (later doc-order branch wins)
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/parallel-gateway.test.ts (var merge, direct))
- **axes:** Concurrency:overlay, Concurrency:merge-order, Gateways:parallelGateway
- **rationale:** Branch overlays must be invisible cross-branch before the join and merge in split out-flow DOCUMENT order (later branch wins a conflict). Catches premature cross-branch variable leakage (resolveScope) or a non-deterministic/arrival-order merge winner.
- **fixture:** fork -> (svcA writes k="A" | svcB writes k="B") -> join -> svcC reads k
- **drive:** start; branch A writes k="A", branch B writes k="B"; complete both in both orders; read merged k at post-join svcC
- **assertions:** sibling write NOT visible to the other branch pre-join (nearest-wins overlay chain); at join k resolves to the later doc-order branch deterministically (not arrival order); non-conflicting keys union; root region folds onto process_instances.variables exactly once

#### `C-AND-NESTED-01` — Nested laminar AND-in-AND — inner join folds onto the enclosing branch token
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/parallel-gateway.test.ts (NESTED_PARALLEL, direct))
- **axes:** Concurrency:nesting, Gateways:parallelGateway, Replay:multi-wait
- **rationale:** Inner join must fold onto the enclosing-branch token overlay (not root), which then satisfies the outer join. Under Workflow mode this is two stacked multi-waits, so the pending wake-name set must stay replay-stable across both join levels — the precise shape the L6.6 shrinking-membership race violated.
- **fixture:** outer fork -> (branch1{ inner fork->(x|y)->inner join } | branch2) -> outer join (NESTED_PARALLEL_BPMN)
- **drive:** start; drive inner x,y; drive branch2; assert outer join waits on inner-join completion; poll to terminal
- **assertions:** inner-join overlay folds onto the enclosing token (nested overlay, not root); outer join satisfied only after folded inner token + branch2; four region lifecycle events per level; completes within bound in workflow mode (no nested-join hang)

#### `C-AND-INTX-01` — AND fork/join wholly inside a transaction — forward commit, no failure
- **risk** med · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/parallel-compensation.test.ts (same fixture, failure path only))
- **axes:** Concurrency, Activities:transaction, Gateways:parallelGateway
- **rationale:** The forward-commit path of AND-inside-a-transaction is the precondition for parallel-branch compensation but is only ever exercised via the failure fixture. Catches a region inside a transaction vertex that mis-records compensatable steps or commits before last-token-out.
- **fixture:** tx{ start -> fork -> (svcA | svcB) -> join -> none-end(commit) } (PARALLEL_SAGA_BPMN, no failSettle)
- **drive:** publishAndStart(PARALLEL_SAGA_BPMN) with no failure trigger; complete both branch jobs
- **assertions:** both branch steps recorded in saga ledger with token_id; tx folds branch overlays before commit; none-end commits with NO compensation; instance completed; one root token at end

#### `C-AND-BTIMER-01` — Interrupting boundary timer fires ON a parallel-branch service task — sibling continues (timer WINS)
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (—)
- **axes:** Events:boundaryTimer, Concurrency:fan-out, Gateways:parallelGateway, Replay:timer-self-heal
- **rationale:** A boundary timer on a task inside one AND branch firing mid-fan-out and redirecting to an in-region alternate path that still reaches the join, while the sibling is live. Untested (boundary-timer.test is M3 single-token). Catches the interrupted branch losing its token (deadlocking the join) or the redirect escaping the region; workflow mode also exercises timer-aware backstop sizing on a branch token.
- **fixture:** fork -> (svcA[boundaryTimer PT -> altA] | svcB) -> join -> End
- **drive:** start; let branch A's boundary timer fire (short PT, fast-forward) before A's job completes; assert A redirects to altA; complete altA and svcB
- **assertions:** boundary timer interrupts svcA (job cancelled), token follows redirect to altA staying in-region; sibling B unaffected; join waits for the redirected-A token + B; armed timer re-armed across each rewalk (self-heal) in workflow mode; completes within bound

#### `C-AND-BTIMER-02` — Branch boundary timer LOSES — job completes first; the armed branch timer's later alarm is a no-op on the branch token, not root
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (tests/integration/boundary-timer-backstop.test.ts (single-token) + matrix C-AND-BTIMER-01 (timer-wins half only))
- **axes:** Events:boundaryTimer, Concurrency:overlay, Replay:timer-self-heal, Replay:apply-from-D1
- **rationale:** Renumbered from C-BTIMER-LOSER-01 into the C-AND-BTIMER family (01=timer wins, 02=timer loses). C-AND-BTIMER-01 only covers the timer WINNING. The dual — the worker completing svcA BEFORE its interrupting boundary timer fires, leaving the timer armed, then a later/duplicate alarm arriving — is untested on a branch and is exactly where the code is fragile: forward-task notes poison/DLQ terminals deliberately leave the host boundary timer 'armed', so the stray-alarm-no-op path is load-bearing. A loser alarm must settle on the BRANCH token's already-advanced job as a no-op (not re-interrupt, not fire on root scope, not double-resolve the branch decision), mirroring the EBG loser-settlement gap (C-BRANCH-EBG-01). Workflow mode also pins timer-aware backstop sizing on the branch token for the completed-before-deadline case.
- **fixture:** fork -> (svcA[interrupting boundaryTimer PT -> altA] | svcB) -> join -> End; complete svcA before PT
- **drive:** start; complete svcA's job promptly (before the boundary timer's fire_at); THEN force the branch boundary-timer alarm to fire (and a duplicate); complete svcB; poll to terminal
- **assertions:** completed svcA fast-forwards the branch token to the join's normal out-flow (altA NOT taken); the late branch boundary-timer alarm is an idempotent no-op on the branch token (fireTimer finds the job already settled), never advancing root scope nor re-arming a phantom redirect; duplicate alarm also no-op; sibling B independent; join fires once; deterministic terminal within bound

### 2. Inclusive-OR

#### `C-OR-SUBSET-01` — Inclusive OR activation subsets (1-of-3, 2-of-3, all-3, default) — join over recorded subset
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/inclusive-gateway.test.ts (direct))
- **axes:** Gateways:inclusiveGateway, Concurrency:OR-subset, Flows:conditional, Flows:default
- **rationale:** The OR-join must wait for EXACTLY the recorded activated subset (requiredFlowsFor over gateway_decisions.activated_flow_ids), never all branches. A join waiting on a non-activated branch deadlocks; a join ignoring the subset fires early. Default taken when no condition is true.
- **fixture:** orGW split (c1|c2|c3 + default) -> orGW join -> End (INCLUSIVE_BPMN)
- **drive:** run with vars selecting 1 true, then 2 true, then all 3 true, then none (default); each to terminal
- **assertions:** only true-condition branches fork; join waits for exactly the recorded subset; default taken when none true; exactly one join token per case; non-activated branches never produce jobs; completes within bound (workflow)

#### `C-OR-NOPATH-01` — OR split with zero activation and no default -> noPath terminal mid-concurrency
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/inclusive-gateway.test.ts (noPath, direct))
- **axes:** Gateways:inclusiveGateway, Error:noPath, Flows:conditional
- **rationale:** A zero-activation OR with no default must raise a terminal noPath incident with NO fan-out row and NO jobs, not a silent stall. In Workflow mode confirm the instance terminates (incident) rather than hanging on a never-satisfied join.
- **fixture:** orGW split (c1|c2 all false, no default) -> join -> End
- **drive:** start with vars making every condition false; poll to terminal
- **assertions:** noPath incident raised at the split before fan-out; no gateway_decisions fan-out row; zero branch jobs; instance terminal 'incident'; reaches terminal within bound (no hang)

#### `C-OR-NESTAND-01` — OR-split branch containing a nested AND fork/join (mixed nesting)
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (—)
- **axes:** Gateways:inclusiveGateway, Gateways:parallelGateway, Concurrency:nesting
- **rationale:** Mixed nesting (AND inside an activated OR branch) is entirely untested — NESTED_PARALLEL is AND-in-AND and inclusive tests are flat OR. Catches overlay-fold bugs where an inner AND-join folds onto the wrong scope, and the OR-join-over-subset interacting with a nested barrier.
- **fixture:** orGW split (branch1{ fork->(x|y)->join } | branch2) -> orGW join -> End
- **drive:** activate branch1 (with nested AND) + branch2; drive x,y; complete branch2; poll to terminal
- **assertions:** nested AND-join folds onto OR-branch1 token; OR-join waits on the recorded subset including the folded branch1; laminar region events at both levels; completes within bound

### 3. Branch-scoped events

#### `C-BRANCH-ITIMER-01` — Intermediate catch timer (single ISO-8601 delay) inside a parallel branch
- **risk** med · **legality** valid · **modes** direct, workflow · **coverage** new (—)
- **axes:** Events:intermediateTimer, Concurrency:fan-out
- **rationale:** A single-token delay node inside an AND branch (1-in/1-out). Untested in-region. Catches a branch-token timer that arms on the root scope instead of the branch, or whose fire is not confined to its branch; in workflow mode the branch wait must size the backstop to the timer deadline.
- **fixture:** fork -> (svcA -> timerCatch(PT) -> svcA2 | svcB) -> join
- **drive:** start; complete svcA; let branch-A intermediate timer elapse (fast-forward); complete svcA2 and svcB
- **assertions:** branch A token parks at the timer; armed timer keyed to the branch token; sibling B proceeds independently; join waits for both; timer fires on time (timer-aware backstop) in workflow mode

#### `C-BRANCH-MSG-01` — Distinct message intermediate catches per branch — apply-from-D1 routing to own overlay
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/parallel-message.test.ts (direct))
- **axes:** Events:messageCatch, Idempotency:correlation, Concurrency:overlay, Replay:apply-from-D1
- **rationale:** Each branch waits on a DISTINCT message; the matched payload must land on its OWN branch overlay (not consumed positionally) and merge at the join in doc order. Workflow mode is the primary apply-from-D1 surface: the wake is contentless, so the payload must be read from the external_messages row via matched_subscription_id, NOT the waitForEvent result.
- **fixture:** fork -> (msgCatchA | msgCatchB) -> join -> svcC (PARALLEL_MESSAGE_DISTINCT_BPMN)
- **drive:** start; publishMessage(msgA, payloadA); publishMessage(msgB, payloadB); assert each routes to its own branch; poll to terminal
- **assertions:** payloadA on branch-A overlay, payloadB on branch-B overlay (no positional cross-routing); doc-order merge at join; pre-join leak guard (A not visible to B); in workflow mode payload sourced from the D1 external_messages row, not the event; completes within bound

#### `C-BRANCH-EBG-01` — eventBasedGateway inside a parallel branch — winner on branch overlay + loser (timer) settlement
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/event-gateway.test.ts (in-region message-wins only; loser settlement is the new part))
- **axes:** Gateways:eventBasedGateway, Events:messageCatch, Events:timer, Concurrency:overlay
- **rationale:** EBG (timer vs message race) inside an AND branch. Covered today: message-wins-on-branch-overlay. Gap: the loser (timer) branch settlement on the BRANCH token — a stray alarm must no-op and a loser fireTimer must convert on the branch token, not root. Catches a loser alarm firing on root scope or double-resolving the branch's gateway_decisions row.
- **fixture:** fork -> (EBG -> (msgWin | timerLose) | svcB) -> join
- **drive:** case1: deliver msg before timer (message wins). case2: let timer fire (timer wins) then send a late stray msg -> must no-op. complete svcB; poll to terminal
- **assertions:** winning message payload on branch overlay merges up; single gateway_decisions row per branch occurrence; loser branch's stray alarm is a no-op on the branch token; timer-wins path settles the branch token; sibling B independent

### 4. Compensation x concurrency

#### `C-COMP-STRAGGLER-01` — Straggler completion after cancel begins — ledgered then compensated in lineage
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/parallel-compensation.test.ts (straggler, direct))
- **axes:** Compensation:straggler, Concurrency, Operator:cancel
- **rationale:** A branch job that COMPLETES after cancel began must be ledgered (INSERT OR IGNORE) + consumed + compensated in its lineage; a FAILED or never-leased token is discarded. Catches a late branch completion leaking as a 0-row no-op or escaping compensation entirely.
- **fixture:** tx{ fork -> (svcA | svcB) -> join -> fail } with operator /cancel while svcB is leased-not-completed
- **drive:** start PARALLEL_SAGA_BPMN; lease svcB but do not complete; POST /cancel; THEN complete svcB late
- **assertions:** late svcB completion ledgered as a straggler then consumed; compensator for B runs in B's lineage (reverse completion order); never-leased/failed tokens discarded; no 0-row no-op; instance reaches compensated terminal

#### `C-COMP-QUIESCE-01` — Quiescence barrier — saga-failed settles only when ledger drained AND all cohort tokens terminal (steady-state, no crash)
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/parallel-compensation.test.ts (partial — barrier under mixed token states is the new part))
- **axes:** Compensation:quiescence, Concurrency, Replay:multi-wait
- **rationale:** The terminal must park (waiting) on per-token lease-expiry terminators until the ledger is drained AND no cohort token is live (filterLineageQuiesced: a step is eligible only once its lineage has no live descendant). The subtlest concurrency-compensation invariant: catches premature saga-failed settlement while a branch token is still in-flight, and the parked/in-flight/never-leased terminators all resolving. This is the STEADY-STATE barrier; the crash-mid-reverse-pass replay sibling is W-COMP-CRASH-REPLAY-01.
- **fixture:** tx{ fork -> (svcA done | svcB parked at wait | svcC in-flight leased) -> join -> fail }
- **drive:** trigger failure with one branch parked, one in-flight, one never-leased; observe the barrier; resolve each terminator
- **assertions:** instance stays compensating/waiting until every cohort token reaches terminal AND ledger drained; parked + in-flight + never-leased terminators all resolve; only then does saga-failed settle; no double-compensation; in workflow mode the barrier wakes on each terminator (the multi-wait shape TASK-54 collapses to one bpmn_wake)

#### `C-COMP-FAILED-01` — compensationFailed mid-reverse in one lineage -> compensationFailure incident, operator-resumable (both branches already terminal)
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (—)
- **axes:** Compensation:failure, Error:compensationFailure, Concurrency
- **rationale:** A compensator that exhausts retries (or whose wait times out) in one branch lineage -> terminal compensationFailed instance + open compensationFailure incident, leaving sibling lineages' compensation intact. Catches a failed compensator silently dropping or corrupting cross-lineage rollback. The live-cohort complement (compensationFailed while a sibling token is still in-flight) is C-COMP-FAILED-INFLIGHT-01.
- **fixture:** tx{ fork -> (svcA[+compHandlerA that fails] | svcB[+compHandlerB]) -> join -> fail }
- **drive:** trigger cohort compensation; make compHandlerA exhaust its retries
- **assertions:** markStepCompensationFailed -> compensationFailure incident + status compensationFailed; sibling B lineage compensation unaffected/completed; instance operator-resumable via /retry; no partial double-apply

#### `C-COMP-FAILED-INFLIGHT-01` — compensationFailed declared in one lineage while a SIBLING cohort token is still in-flight — no leak, barrier-aware
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (parallel-compensation.test.ts (compensationFailed only with both branches already terminal))
- **axes:** Compensation:failure, Compensation:quiescence, Error:compensationFailure, Concurrency:in-flight-token
- **rationale:** runCompensation returns 'failed' and writes the compensationFailed TERMINAL on the FIRST failed comp step (compensation.ts L134-137) — it does NOT first drain the rest of the cohort. C-COMP-FAILED-01 only ever fails a comp AFTER the join fired (both branches already terminal), so the dangerous state — compensationFailed declared while a sibling cohort token is STILL leased/parked with an armed lease-expiry terminator — is never reached. The intersection is sharp: the armed terminator later fires onto a now-compensationFailed (non-'compensating') instance and must no-op (terminateUnleasableJob guards on status==='compensating'); a straggler that completes after the terminal must not be silently advanced/leaked (runInstanceInner early-returns on the terminal status, so ledgerStragglers never runs). Catches a terminator re-driving a terminal instance, or a post-terminal straggler side-effect leaking unledgered/uncompensated.
- **fixture:** tx{ fork -> (A done [compA fails] | B leased-not-completed, terminator armed) -> ... -> cancel }
- **drive:** reach cohort compensation with B's forward job still locked; make compA exhaust retries -> compensationFailed; THEN let B's lease-expiry terminator fire AND/OR complete B late; finally operator /retry
- **assertions:** status compensationFailed + open compensationFailure incident the instant compA fails (does not wait for B); B's armed terminator firing on the compensationFailed instance is a guarded no-op (terminateUnleasableJob: linst.status!=='compensating' -> return); a late B complete is NOT advanced past the terminal; operator /retry (after fixing compA) resumes 'compensating' and the barrier re-scans -> B is straggler-ledgered+compensated before the final terminal; no double-apply on any sibling lineage

#### `C-COMP-LINEAGE-REVERSE-01` — Per-lineage reverse-order compensation over a MULTI-STEP branch (cross-branch order unconstrained)
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (loop-compensation.test.ts (reverse-by-occurrence but ROOT token only — token_id NULL, filterLineageQuiesced no-op); parallel-compensation.test.ts (1 step per branch))
- **axes:** Compensation:per-lineage-reverse, Concurrency:lineage-quiescence, Gateways:parallelGateway, Activities:transaction
- **rationale:** The headline compensation invariant — per-lineage reverse order — is STRUCTURALLY UNTESTED. Every saga fixture (PARALLEL_SAGA_BPMN) has exactly ONE compensatable step per branch, so selectScopeStepsForCompensation ORDER BY seq DESC and filterLineageQuiesced over a non-null token_id lineage are vacuous: with one row per lineage, any order passes. A bug that compensates a branch FORWARD (A1 then A2 instead of A2 then A1), or that uses a single global seq order across branches (imposing a spurious cross-branch happens-before), would be completely invisible today. This is the cheapest fixture that makes within-lineage reverse order observable AND proves cross-branch order is free.
- **fixture:** tx{ fork -> (A1->A2 [each w/ comp handler] | B1->B2 [each w/ comp handler]) -> join -> settle(fail) -> cancel-end }
- **drive:** start; complete A1,A2,B1,B2; settle raises business error -> Tx_cancel; drain comp workers; read compensationStarted history order + saga seq
- **assertions:** WITHIN branch A: compA2 runs strictly before compA1; WITHIN branch B: compB2 before compB1 (reverse completion order, seq DESC over the same token_id lineage); CROSS-branch interleaving is NOT pinned — assert only the per-lineage suffix order, never a global A-before-B/B-before-A total order (concurrent branches have no happens-before); every step reaches compensationStatus='compensated'; instance terminal compensated; one root token at end

#### `C-COMP-NESTEDTX-BRANCH-01` — Transaction nested INSIDE one parallel branch — inner commit terminalizes its scope; outer cancel never re-compensates it
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (helpers SAGA_CROSS_SCOPE_ASSOC_BPMN / nested-tx fixtures (sequential scopes only))
- **axes:** Compensation:scope-nesting, Activities:transaction, Concurrency:fan-out, Gateways:parallelGateway
- **rationale:** Entirely uncovered: every nested-tx fixture in helpers (SAGA_CROSS_SCOPE_ASSOC etc.) is SEQUENTIAL (Tx1 -> Tx2), never tx-inside-a-region-branch. A <transaction> is a SESE node so it is legal inside a branch, and it carries its OWN scope_id. When the inner tx commits, markScopeStepsCommittedStmt flips its steps to 'committed' (scope_id=inner); a later OUTER region cancel runs selectScopeStepsForCompensation filtered by scope_id=outer, which MUST skip the committed inner steps. Catches an outer cohort cancel re-compensating already-committed inner-tx steps (double-apply across scope levels) while a sibling branch is concurrently live. This is also the LEGAL form of the dropped C-COMP-BRANCHCANCEL-01 (an inner cancel-end is reachable inside its own single-token inner scope).
- **fixture:** outerTx{ fork -> (branchA{ innerTx{ a1 [comp] -> commit } -> a2 [comp] } | branchB [comp]) -> join -> settle(fail) -> outer cancel-end }
- **drive:** start; drive branchA's innerTx to commit (a1 done, inner none-end) then a2; drive branchB; settle fails -> outer Tx_cancel; drain comps
- **assertions:** inner-tx step a1 is compensation_status='committed' after inner commit and is NEVER re-compensated by the outer cancel (scope_id filter + committed terminal both exclude it); outer-scope steps (a2, branchB) ARE compensated in their lineages; no double-apply of compA1; quiescence holds until both branch lineages drain; deterministic terminal compensated

#### `C-COMP-LOOP-BRANCH-01` — Loop inside a parallel branch then cancel — per-occurrence reverse compensation within a NON-ROOT lineage (token_id set)
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (loop-compensation.test.ts (root token only); C-LOOP-INBRANCH-01 (forward loop, no compensation))
- **axes:** Compensation:per-lineage-reverse, Loops:occurrence, Concurrency:lineage-quiescence, Activities:transaction
- **rationale:** loop-compensation.test.ts proves occurrence-keyed reverse compensation (seq DESC over occurrences) but ONLY at the root/single-token path where token_id is NULL and filterLineageQuiesced is a pure no-op. The branch variant activates BOTH mechanisms at once — N occurrence-keyed ledger rows that all share ONE non-null branch token_id, compensated in reverse occurrence order, AND gated by lineage-quiescence against a live sibling. This is the exact combination (occurrence reverse x token_id lineage filter) that no test reaches. Catches a per-occurrence row whose token_id mis-tags the lineage (blocking or unblocking the wrong step), or reverse occurrence order breaking once token_id is non-null.
- **fixture:** tx{ fork -> (loopBranch{ svcA[comp] -> xor back to svcA, 3x -> exit } | svcB[comp] live) -> join -> settle(fail) -> cancel }
- **drive:** start; loop branch A 3 iterations (svcA:el#0,#1,#2 each ledgered w/ same token_id); drive B; settle fails -> cancel; drain comps
- **assertions:** three compensation jobs for svcA in REVERSE occurrence order (#2,#1,#0), each seeded with its own iteration's captured input/output; all carry the SAME branch token_id; filterLineageQuiesced blocks the looped lineage's steps only while that token is live (no-op once consumed); sibling B compensated independently; cross-branch order unconstrained; terminal compensated

#### `C-IDEMP-COMP-DUP-01` — At-least-once on the COMPENSATION callback — duplicate comp-job complete / replayed wait-comp advances the reverse pass once
- **risk** med · **legality** valid · **modes** direct, workflow · **coverage** new (duplicate-worker-callback.test.ts (forward root token only); loop-compensation.test.ts item 2 (occurrence dedup, root token))
- **axes:** Idempotency:dupCompensation, Compensation, Replay:apply-from-D1, Concurrency
- **rationale:** Everything is at-least-once including worker callbacks, but every idempotency test targets FORWARD jobs (output_applied / lock_token guards) or root-token compensation. A duplicate /jobs/{id}/complete on a COMPENSATION job (or a Workflow replay of the wait-comp:* step) under a multi-lineage cohort is untested. Compensation jobs do not use the output_applied marker; the reverse pass relies on the saga step's compensation_status flip (markStepCompensated) + the selectScope status filter to dedup. Catches a duplicate comp callback double-writing compensationCompleted, advancing the seq-DESC cursor twice (skipping a sibling lineage's step), or re-running an already-'compensated' handler.
- **fixture:** C-COMP-LINEAGE-REVERSE fixture; deliver compA2 /jobs/complete TWICE (same lockToken / replay) mid reverse pass
- **drive:** trigger cohort compensation; complete the compA2 comp job, then re-POST the same complete; let the pass continue to compA1 and branch B
- **assertions:** compA2's step flips to 'compensated' exactly once; the second complete is a stable no-op (no second compensationCompleted history, no cursor double-advance); compA1 and branch B still compensate in their correct per-lineage reverse order (no skipped lineage); merged final ledger identical to the single-delivery run; terminal compensated

#### `C-ERR-BRANCH-COMP-01` — Branch business-error redirect inside a tx, then cancel — failed-then-routed step owes NO compensation; only the redirect-target ledgers
- **risk** med · **legality** valid · **modes** direct, workflow · **coverage** new (C-ERR-PRECEDENCE-01 (forward routing only, no tx/ledger); error-routing.test.ts (single-token))
- **axes:** Compensation, Events:errorBoundary, Error:routing, Concurrency:fan-out
- **rationale:** C-ERR-PRECEDENCE-01 is FORWARD-only (no transaction, no ledger). The saga consequence of an in-branch redirect is uncovered: a forward job that FAILED with a business error and was routed (markFailedJobHandled, no output_applied) writes NO saga_steps row (only completed compensatable steps ledger), while the post-redirect altA completion DOES. So a later cohort cancel must compensate altA + the sibling, and must NEVER attempt to compensate the failed-and-routed svcA (a failed forward job executed no committed side-effect). Catches a redirect that erroneously ledgers the failed step (compensating a side-effect that never committed) or that drops altA's ledger row (leaking altA's effect).
- **fixture:** tx{ fork -> (svcA[errBoundary @E1 -> altA[comp handler]] | svcB[comp handler]) -> join -> settle(fail) -> cancel }
- **drive:** start; fail svcA with business error E1 -> routes to altA in-region; complete altA and svcB; settle fails -> Tx_cancel; drain comps
- **assertions:** saga_steps has NO row for svcA (failed+routed, owes no compensation); altA and svcB each have a ledger row with their branch token_id; cancel compensates altA + svcB in their lineages; no comp job is ever created for svcA; terminal compensated; deterministic regardless of node-iteration order

### 5. Error / Hazard / noPath

#### `C-ERR-PRECEDENCE-01` — Error-boundary on a branch task — confinement + precedence ladder (exact @errorCode beats catch-all; non-matching -> catch-all; none -> Hazard), sibling continues to join
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/error-routing.test.ts (root-token ladder) + merges matrix C-ERR-BOUNDARY-01 (confinement; its single-error drive never reached the precedence it asserted))
- **axes:** Events:errorBoundary, Error:routing, Error:precedence, Concurrency:fan-out
- **rationale:** Merges the former C-ERR-BOUNDARY-01 (in-region routing + branch confinement) with the precedence resolver it asserted but never reached. An interrupting error boundary on a task inside one AND branch must free-route to an in-region token-path node that reaches the join while the sibling is live (confinement); AND a branch task carrying BOTH an exact @errorCode=E1 boundary and a catch-all must route E1 to exact (exact wins, forward-task.ts:79-80), an undeclared E2 to catch-all, and (catch-all removed) E2 to an uncaught-error Hazard. C-ERR-BOUNDARY-01's single-error drive never co-located exact+catch-all so the resolver was never exercised; this corner does. Catches the error redirect escaping the region (confinement), the interrupted branch deadlocking the join, or the precedence resolver picking the wrong boundary.
- **fixture:** fork -> (svcA[boundary @errorCode=E1 -> altExact ; catch-all boundary -> altCatch] | svcB) -> join -> End
- **drive:** case1 fail svcA with E1 (-> altExact, in-region). case2 fail svcA with undeclared E2 (-> altCatch, in-region). case3 same model minus the catch-all, fail with E2 (-> uncaught Hazard). complete svcB in all; poll to terminal
- **assertions:** E1 routes to the exact boundary target staying in-region (exact wins over catch-all); E2 routes to the catch-all target in-region; with no catch-all E2 -> serviceTaskFailure Hazard (no matching boundary), sibling frozen; token follows the redirect staying in-region reaching the join; sibling B unaffected in the routed cases; join waits for redirected-A + B; resolution deterministic regardless of boundary/node-iteration order

#### `C-ERR-HAZARD-01` — Uncaught error in one branch -> Hazard freezes instance (no wedge), sibling frozen, then /cancel reverse pass
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/parallel-compensation.test.ts (hazardBranchB, direct))
- **axes:** Error:Hazard, Compensation, Concurrency
- **rationale:** An uncaught Error / forward-retry exhaustion in branch B is a Hazard inside the tx: instance -> 'incident' with sibling A frozen (NOT auto-compensated), operator /cancel available. Catches auto-compensation firing on a Hazard (forbidden by Principle VI) or a sibling wedge/runaway.
- **fixture:** tx{ fork -> (svcA | svcB exhausts retries) -> join } (PARALLEL_SAGA hazardBranchB)
- **drive:** start; make svcB exhaust forward retries (no error boundary); then POST /cancel
- **assertions:** serviceTaskFailure incident, status 'incident'; NO auto-compensation (Hazard); sibling A token frozen, not advanced; operator /cancel then runs the reverse pass over the cohort; deterministic final state

#### `C-BRANCH-NOPATH-01` — XOR/OR split inside one AND branch dead-ends (noPath/conditionFailure) while sibling in flight
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (—)
- **axes:** Error:noPath, Error:conditionFailure, Concurrency, Gateways:exclusiveGateway
- **rationale:** A single-token incident (noPath, or a hard-FEEL conditionFailure) inside one branch while the sibling branch is still running — the interaction of a per-token incident with a live cohort. Untested. Catches the incident failing to terminate the whole instance (sibling runaway) or the live sibling masking the incident.
- **fixture:** fork -> (svcA -> xorGW[no true cond, no default] | svcB live) -> join
- **drive:** start; drive branch A's XOR to a noPath (or inject a hard FEEL error -> conditionFailure); keep B in-flight
- **assertions:** noPath/conditionFailure incident raised on branch A; whole instance goes 'incident' (no sibling wedge/runaway); B token frozen; deterministic; terminal within bound

### 6. Caps / poison / loops / DLQ / retry

#### `C-CAP-TRIO-01` — Concurrency caps trio under load — concurrencyLimit, stepBudget, join-payload poison
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/parallel-caps.test.ts (direct))
- **axes:** Concurrency:caps, Error:concurrencyLimit, Error:stepBudget, Error:poison
- **rationale:** The three concurrency incident kinds. concurrencyLimit: fan-out past MAX_CONCURRENT_TOKENS (terminal, counted in-memory not SQL COUNT). stepBudget: per-drive counter crosses STEP_BUDGET_SOFT (graceful) — critically, in Workflow mode each wake = one re-walk = one budget unit, so a hot parallel x loop shape must terminate gracefully, not become an opaque errored Workflow. poison: join-time merged overlay > MAX_EVENT_PAYLOAD_BYTES (1MiB) -> terminal poison, never silent truncation. The branch-OUTPUT 3-strike poison (a different code path/rule) is C-BRANCH-POISON-01.
- **fixture:** wide fork (MAX_CONCURRENT_TOKENS_OVERRIDE) / branch self-loop (STEP_BUDGET_SOFT_OVERRIDE) / branches whose merged overlay > 1MiB at the join
- **drive:** use test-only cap overrides + injected-graph (parallel-caps pattern) to trip each deterministically; repeat the decisive cases in workflow mode with short overrides
- **assertions:** concurrencyLimit raised at the split (no partial fan-out leaked into the live frontier); stepBudget graceful incident below the platform step ceiling; join-overlay union > 1MiB raises poison at the join; each terminal within bound; no double-apply on the failing drive

#### `C-BRANCH-POISON-01` — Branch service-task OUTPUT merge > 1MiB — 3-strike poison on the branch (distinct from join-overlay poison), boundary timer left armed
- **risk** med · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/saga-poison-job.test.ts (root-token strikes) + parallel-caps.test.ts (join-overlay poison only))
- **axes:** Error:poison, Error:payloadLimit, Concurrency:overlay, Events:boundaryTimer
- **rationale:** C-CAP-TRIO-01 covers ONLY the join-merge poison (regions-runtime.ts:307, raised IMMEDIATELY at the join). The other poison trigger — a single branch service task whose applied/merged OUTPUT overlay crosses MAX_EVENT_PAYLOAD_BYTES (forward-task.ts:463) — uses a SEPARATE rule: a 3-strike POISON_THRESHOLD counter (serviceTaskOutputRejected history events, shared per element across occurrences), and on poisoning it deliberately leaves the host boundary timer 'armed'. Neither the 3-strike accrual nor the armed-timer interaction is tested on a branch. Also untested: a fat branch INPUT overlay (resolveScope chain) > 1MiB raising serviceTaskFailure at branch ingress (forward-task.ts:259), NOT poison — a classification a careless test would conflate.
- **fixture:** fork -> (svcA[+boundaryTimer] returns >1MiB output | svcB) -> join; svcA completes 3x over-limit
- **drive:** start; complete svcA with an over-1MiB output three times (strikes 1,2 re-open and re-attempt; strike 3 terminal); keep svcB live; also a variant where svcA's resolved INPUT overlay alone exceeds 1MiB
- **assertions:** strikes 1-2 record serviceTaskOutputRejected and re-open svcA (no advance); strike 3 -> terminal poison incident on svcA's element (poisonJob history), NOT a join-overlay poison and NOT serviceTaskFailure; the host boundary timer is left armed (no decider claim) and its later alarm no-ops; INPUT-overlay-over-limit variant -> serviceTaskFailure at ingress (distinct kind); sibling B frozen; deterministic terminal within bound

#### `C-LOOP-INBRANCH-01` — Loop wholly inside a parallel branch — per-branch occurrence keying
- **risk** med · **legality** valid · **modes** direct, workflow · **coverage** new (—)
- **axes:** Loops:occurrence, Concurrency:fan-out, Gateways:exclusiveGateway
- **rationale:** A cycle (back-edge through an XOR) confined to one AND branch, bumping occurrence per iteration with fresh occurrence-keyed job/ledger/subscription rows. Untested in-region. Catches an occurrence collision between the looping branch and the sibling (element-disjointness invariant) or a back-edge tripping branch-confinement at runtime.
- **fixture:** fork -> (svcA -> xorLoop(back to svcA, k times) -> exit | svcB) -> join
- **drive:** start; loop branch A 3 iterations; complete branch B; poll to terminal
- **assertions:** each branch-A iteration is its own occurrence (svcA:el#0,#1,#2) with fresh job rows; sibling B occurrences independent; no cross-token occurrence collision; join waits for looped-A + B; completes

#### `C-LOOP-LIMIT-BRANCH-01` — Loop inside a branch hits MAX_ELEMENT_OCCURRENCES -> loopLimit incident (not stepBudget)
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (—)
- **axes:** Loops:cap, Error:loopLimit, Concurrency
- **rationale:** A real occurrence-keyed loop inside an AND branch exceeding 1000 visits must raise loopLimit (a Hazard inside a tx), NOT stepBudget. parallel-caps trips stepBudget via a pure-gateway self-loop; the loopLimit-in-branch path is untested — the wrong cap firing would mask an unbounded branch loop.
- **fixture:** fork -> (svcA -> xor self-loop > MAX_ELEMENT_OCCURRENCES | svcB) -> join
- **drive:** drive branch A's loop past 1000 occurrences (real jobs or injected graph); poll to terminal
- **assertions:** loopLimit incident on the looping element (cap=1000), NOT stepBudget nor concurrencyLimit; Hazard semantics if inside a tx (no auto-compensation); sibling B token frozen; terminal within bound

#### `C-BRANCH-DLQ-01` — Never-leased branch service job hits ACTIVATION_TTL_MS -> jobActivationTimeout via per-job JobScheduler DLQ, sibling frozen
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (tests/integration/saga-dlq-timeout.test.ts (root-token DLQ, no concurrency / no live sibling))
- **axes:** Error:jobActivationTimeout, Concurrency:fan-out, Replay:timer-self-heal, Operator:cancel
- **rationale:** jobActivationTimeout is a first-class incident kind with its OWN DLQ machinery (per-job JobScheduler DO alarm -> terminateUnleasableJob, forward-task.ts:340), entirely distinct from waitTimeout (W-AND-BRANCHTIMEOUT, the durable-wait cap). NO scenario in the matrix trips it. Under a token set the un-leased branch job's alarm must terminate the instance AND the cohort-capture must freeze the LIVE sibling (the generalised freeze), and the alarm must re-arm per branch token. C-COMP-QUIESCE uses a 'never-leased' token only as a quiescence terminator, never as the primary jobActivationTimeout trigger on a live cohort.
- **fixture:** fork -> (svcA never activated [no /jobs/activate poll] | svcB leased) -> join -> End; short ACTIVATION_TTL override
- **drive:** start PARALLEL_BPMN; lease svcB (or leave both unleased); never poll svcA; let svcA's JobScheduler alarm fire at activation_expires_at; poll to terminal; then POST /cancel
- **assertions:** svcA's per-job JobScheduler alarm fires -> terminateUnleasableJob writes terminal incident kind='jobActivationTimeout' (NOT waitTimeout, NOT serviceTaskFailure) with the branch token tag; instance status 'incident'; live sibling svcB token frozen (cohort capture), not advanced past the join; duplicate/late alarm is an idempotent no-op (D1 re-read guard); reaches terminal within bound in workflow mode (alarm re-armed across rewalk); operator /cancel then settles the frozen cohort

#### `C-BRANCH-RETRY-01` — Retryable /jobs/fail + full-jitter backoff + lease-expiry reclaim on an occurrence-keyed branch job, sibling proceeds, then exhaustion
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (tests/integration/saga-backoff.test.ts / jobs-retryable-reclaim.test.ts (root-token only))
- **axes:** Retry:backoff, Retry:reclaim, Concurrency:fan-out, Error:serviceTaskFailure
- **rationale:** saga-backoff / jobs-retryable-reclaim / saga-dlq-timeout are ALL root-token and no matrix scenario exercises the per-branch retry loop. A branch job that fails retryably must park into lock_expires_at via computeBackoffMs, become re-leasable on its OWN occurrence-keyed row while the sibling advances independently, and an EXPIRED in-flight branch lease must reclaim with an attempt_count bump (index.ts:756) routing to the SAME exhaustion path. C-ERR-HAZARD only 'exhausts forward retries' as a black box — the attempt-count rows, backoff schedule, and reclaim mechanics on a branch token are untested, and an occurrence/branch collision in the job row keying would silently corrupt the retry budget.
- **fixture:** tx{ fork -> (svcA[retries=3] | svcB) -> join -> commit }; branch A fails retryably twice (backoff+reclaim) then succeeds; separately a variant where A exhausts
- **drive:** start; lease svcA, POST /jobs/{id}/fail retryable=true; assert backoff park; re-lease after backoff (and via lease-expiry reclaim); on the success variant complete A; on the exhaust variant fail past retries; complete svcB throughout
- **assertions:** each retry on the branch job parks lock_expires_at = computeBackoffMs(attempt) and bumps attempt_count on the SAME occurrence-keyed svcA:el#0 row (no collision with svcB's rows); sibling B advances independently while A backs off; an expired in-flight branch lease reclaims (attempt bump) not a fresh job; success variant -> join fires once with A's output; exhaustion variant -> serviceTaskFailure Hazard (no auto-compensation), sibling B frozen; deterministic terminal within bound

### 7. Idempotency x concurrency

#### `C-IDEMP-DUP-01` — Duplicate worker callback + duplicate message into ONE branch of a token set
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (duplicate-message.test.ts / duplicate-worker-callback.test.ts (root-token only))
- **axes:** Idempotency:dupJob, Idempotency:dupMessage, Concurrency, Replay:apply-from-D1
- **rationale:** At-least-once into a single branch: a duplicate job complete (lock_token / output_applied guard) and a duplicate message publish (broker dedup, stable prior outcome) must NEVER advance that branch twice. Dedup is only covered at root token. Especially dangerous in Workflow mode where the wake re-walks the whole graph.
- **fixture:** fork -> (svcA | msgCatchB) -> join — duplicate svcA complete; duplicate publish msgB (same messageId)
- **drive:** complete svcA twice (same lock_token / replayed); publish msgB twice (same workspace+name+correlationKey+messageId); poll to terminal
- **assertions:** completed job output_applied=1 fast-forwards write-free -> branch A advances once; duplicate publish returns the stable prior outcome -> branch B advances once; join fires once; no duplicate history step; merged vars identical to the single-delivery run

#### `C-IDEMP-MSGTIMING-01` — Early-buffered and late message correlated into a token-set branch
- **risk** med · **legality** valid · **modes** direct, workflow · **coverage** new (early-message-buffer.test.ts / late-message.test.ts (root-token only))
- **axes:** Idempotency:earlyBuffer, Idempotency:late, Events:messageCatch, Concurrency
- **rationale:** Message timing into a branch key: an early message (published before the branch's catch is eligible) buffered 1h and claimed at branch registration (earliestBuffered); a late message (new messageId after the branch advanced) recorded 'late'. Both only covered at root token. Catches a buffered message mis-claimed by the wrong branch subscription or a late message double-advancing a branch. (The apply-from-D1 PROVENANCE hole for buffer-claimed messages is the deeper W-BUFFERED-STRAND-01.)
- **fixture:** fork -> (msgCatchA | svcB) -> join — publish msgA BEFORE A registers; publish a new msgA AFTER A advances
- **drive:** publish msgA early (buffered); fan out; A registers and claims the buffered msgA; after A advances, publish a new msgA messageId (late)
- **assertions:** early msgA buffered then claimed by branch-A subscription at registration; at-most-one active subscription per broker key; late msgA recorded outcome=late, branch A not re-advanced; join unaffected

### 8. Operator verbs

#### `C-OP-CANCEL-MIDFAN-01` — Operator /cancel mid-fan-out before any branch completes — empty-ledger operatorResolved
- **risk** med · **legality** valid · **modes** direct, workflow · **coverage** extends-existing (tests/integration/parallel-compensation.test.ts (operator cancel; mid-fan-out empty-ledger timing is the new part))
- **axes:** Operator:cancel, Concurrency, Compensation
- **rationale:** /cancel issued after fork but before any branch job completes (empty/near-empty ledger): it closes open incidents as operatorResolved and settles armed timers rather than running a reverse pass over nothing. Catches a mid-fan-out cancel leaking live branch tokens or failing to settle branch-armed timers.
- **fixture:** tx{ fork -> (svcA leased | svcB parked, timer armed) -> join } — POST /cancel before any completion
- **drive:** start; fan out; lease A (do not complete); B parked with an armed timer; POST /instances/{id}/cancel
- **assertions:** empty ledger -> no compensation pass; both live branch tokens terminated; branch-B armed timer settled; open incidents -> operatorResolved; instance canceled terminal; a late branch completion is ledgered per C-COMP-STRAGGLER (not leaked)

#### `C-OP-RETRY-COMPFAILED-01` — Operator /retry on compensationFailed in one lineage — re-drive from the failed compensator
- **risk** high · **legality** valid · **modes** direct, workflow · **coverage** new (—)
- **axes:** Operator:retry, Compensation:failure, Concurrency
- **rationale:** After a compensationFailed terminal (C-COMP-FAILED-01 / C-COMP-FAILED-INFLIGHT-01), /retry is a conditional reset keyed on the incident/failed status that re-drives from the failed compensator, NOT from the start. Catches /retry re-running already-compensated lineages (double-apply) or re-forking the original region.
- **fixture:** continue from a C-COMP-FAILED state; fix the compensator; POST /instances/{id}/retry
- **drive:** reach compensationFailed; make the compensator succeed on retry; POST /retry; poll to terminal
- **assertions:** retry re-drives only the failed compensator (conditional reset on compensationFailure status); already-compensated sibling lineages NOT re-run; compensationFailure incident closed; instance reaches compensated terminal; no double-apply

### 9. Workflow-mode replay / self-heal / apply-from-D1

#### `W-AND-CRASH-01` — (WM-2) Crash mid-race -> re-walk fast-forwards committed branches without re-apply
- **risk** high · **legality** valid · **modes** workflow · **coverage** new (loop-replay-workflow.test.ts / xor-replay-workflow.test.ts (harness template, not joins))
- **axes:** Replay:crash, Concurrency:join-barrier, Replay:fast-forward
- **rationale:** The core determinism guarantee: a crash/replay after one branch committed (job output_applied=1, join_arrival INSERTed) must fast-forward write-free on re-walk and NOT re-produce. join_arrivals/join_completions are plain-INSERT race claims; a replay must abort on the PK and re-read the winner. Catches double-apply / duplicate-step Workflow errors on replay — and there is no join replay harness today (only loop/XOR sims).
- **fixture:** PARALLEL_BPMN; force a Workflow replay after branch A commits, before B
- **drive:** (wrangler dev / real CF) complete A; force replay/suspend-resume; complete B; poll to terminal
- **assertions:** re-walk fast-forwards A (completed job, consumed subscription, recorded join_arrival) with zero writes; no duplicate serviceTaskCompleted(A); join_completion claimed once; final state identical to the no-crash run; terminal within bound

#### `W-AND-NEARSIM-01` — (WM-3) Swapped-order determinism — sequential A-then-B vs B-then-A reach a deep-equal final state (NOT a concurrent race; the concurrent dropped-tickle case is W-AND-TICKLE-GAP-01)
- **risk** high · **legality** valid · **modes** workflow · **coverage** new (—)
- **axes:** Replay:multi-wait, Concurrency:merge-order, Replay:determinism
- **rationale:** Deliver both branch results across SWAPPED completion order (A-then-B vs B-then-A); merged variables + status + saga ledger must deep-equal. Catches a race-winner-dependent merge or a lost wake when two events arrive close together. NOTE (critic-confirmed): the drive is sequential swapped-order, which tests merge-order DETERMINISM, not a true concurrent tickle race; the genuine 'two tickles faster than the loop re-arms, one dropped in the gap' hazard is isolated by W-AND-TICKLE-GAP-01.
- **fixture:** PARALLEL_BPMN with branch-local conflicting writes; run twice with swapped completion order
- **drive:** run A-then-B to terminal; /reset (new instance); run B-then-A; deep-equal final GET /instances/{id} bodies + ledger
- **assertions:** both runs reach completed within bound; merged vars identical (doc-order merge, not arrival-order); each token reaches the join exactly once regardless of winner; no duplicate-apply; per-token history tag counts equal across runs

#### `W-AND-TICKLE-GAP-01` — Two near-simultaneous bpmn_wake tickles — one consumed by wake#k, the second dropped in the inter-wait gap, recovered by the backstop (not a hang)
- **risk** high · **legality** valid · **modes** workflow · **coverage** new (W-AND-NEARSIM-01 (sequential swapped-order, not concurrent) + W-SELFHEAL-01 (fully-lost wake, different injection))
- **axes:** Replay:multi-wait, Replay:self-heal, Concurrency:merge-order, Replay:determinism
- **rationale:** The realistic L6.6-adjacent production race the single-wake correctness argument explicitly leans on but the matrix never isolates. Every external completion sendEvent's a contentless bpmn_wake; when branch A and branch B complete within the same instant both tickle. The single waitForEvent({name:bpmn_wake#k}) consumes ONE; the SECOND arrives while run() is mid re-walk, before wake#k+1 is armed. CF's event buffer window is short and NOT a durability guarantee, so the second tickle can be DROPPED. If the re-walk drains only A from D1 (B's commit raced) and parks again on B, wake#k+1 waits for a tickle that already came and went -> the ONLY thing that saves liveness is the bounded backstop self-heal. W-AND-NEARSIM-01's drive is sequential swapped-order (not concurrent); W-SELFHEAL-01 injects a FULLY lost wake (never sent). Neither exercises 'sent-but-dropped-in-the-gap'. Catches a permanent hang when two events tickle faster than the loop re-arms.
- **fixture:** PARALLEL_BPMN (both branches park at the join) with a short MAX_WAKE_BACKSTOP override
- **drive:** on real CF / wrangler dev (workflow mode): complete branch A and branch B as close to simultaneously as possible (both sendEvent bpmn_wake); deliberately drop/lose the second tickle's effect by completing both while run() is suspended on a single wake; poll to terminal within the backstop bound
- **assertions:** instance reaches completed even when the second tickle is dropped (self-heal: wake#k+1 times out -> re-walk -> drains B from D1); each branch reaches the join exactly once; merged vars deep-equal the both-tickles-delivered run (doc-order merge, not arrival-order); a self-heal counter / wake-timeout history tag records the dropped tickle; NEVER stuck running past the backstop

#### `W-AND-BRANCHTIMEOUT-01` — (WM-4) One branch durable-wait times out while sibling live -> graceful escape, no unhandledRejection, no hang
- **risk** high · **legality** valid · **modes** workflow · **coverage** new (wait-cap-incidents.test.ts (single-token, no join starvation))
- **axes:** Replay:multi-wait, Error:waitTimeout, Concurrency
- **rationale:** A branch token parked at a join/receive whose sibling never arrives -> its durable-wait cap elapses -> waitTimeout. In Workflow mode the waitForEvent timeout THROWS (Error: Execution timed out); the throw must be caught (the self-heal/escape path), never surface as an unhandledRejection or leave the instance stuck running. The exact L6.6-adjacent failure (AND-join starvation); untested even in direct mode (wait-cap is single-token).
- **fixture:** fork -> (svcA completes | recvB never correlated) -> join — short MAX_WAKE_BACKSTOP + branch wait cap
- **drive:** complete A; never deliver B's message; poll past the branch wait cap
- **assertions:** branch B's wait cap elapses -> waitTimeout incident (not a silent hang); the waitForEvent throw is caught -> re-walk; no unhandledRejection / no duplicate-step error; instance reaches terminal incident within bound (NOT stuck running for the full 1h SVC_WAIT_TIMEOUT)

#### `W-SELFHEAL-01` — Lost wake -> self-heal via timer-aware bounded backstop (result committed to D1, no tickle)
- **risk** high · **legality** valid · **modes** workflow · **coverage** new (/tmp/cf-wf-probe ProbeC (substrate template))
- **axes:** Replay:self-heal, Replay:apply-from-D1, Concurrency:join-barrier
- **rationale:** The post-TASK-54 resilience contract: commit an awaited result to D1 WITHOUT sending bpmn_wake (models a FULLY lost/raced wake on real CF KV consistency); the instance must still complete within MAX_WAKE_BACKSTOP because wake#k times out -> throws -> caught -> re-walk -> apply-from-D1 drains it. The safety net the whole single-wake design hinges on; catches a permanent hang when the tickle is lost. (The 'sent-but-dropped-in-the-gap' variant is W-AND-TICKLE-GAP-01.)
- **fixture:** PARALLEL_BPMN (both branches parked at join) OR a single receiveTask; inject a short MAX_WAKE_BACKSTOP
- **drive:** park at the wait; INSERT the external_messages row with matched_subscription_id (or persist the job outcome) WITHOUT calling WorkflowExecutor.deliver/sendEvent; poll past the backstop
- **assertions:** status flips to completed within ~backstop (not stuck running); self-heal evidence recorded (wake-timeout counter / history tag, the engine analog of ProbeC timeout:k); final vars carry the would-have-been-event payload (proves apply-from-D1, not the lost event); deep-equals the tickled happy-path run; negative control WITH the tickle completes faster

#### `W-APPLYFROMD1-01` — Apply-from-D1 correctness — message/EBG payload applied from the D1 row, not the event
- **risk** high · **legality** valid · **modes** workflow · **coverage** new (direct-mode apply-from-D1 white-box tests (structure only; runtime path is workflow-only))
- **axes:** Replay:apply-from-D1, Events:messageCatch, Idempotency:correlation
- **rationale:** Because bpmn_wake is a contentless tickle, every apply must source data from D1 (getCorrelatedMessageForSubscription via matched_subscription_id), NOT the waitForEvent result. This is the PRIMARY new regression surface (jobs/timers already re-read D1; message/EBG-message apply is the new path). Catches a payload silently read from the empty event instead of the matched external_messages row.
- **fixture:** single receiveTask (or EBG message branch); deliver via POST /messages then assert payload provenance
- **drive:** start; POST /messages with payload P; let the wake drive apply; inspect applied vars; repeat with the wake suppressed
- **assertions:** applied variables equal P sourced from the external_messages row (matched_subscription_id set at POST time), independent of the event payload; identical when the wake is suppressed (self-heal) — payload still P; atomic apply with the transition out of wait; no double-apply on replay

#### `W-BUFFERED-STRAND-01` — Early-buffered message claimed at branch registration has NO apply-from-D1 provenance — terminated-Workflow inline re-drive strands it
- **risk** high · **legality** valid · **modes** workflow, direct · **coverage** new (early-message-buffer.test.ts (root-token, direct, no termination/apply-from-D1) + apply-from-d1.test.ts (live-correlation path only))
- **axes:** Replay:apply-from-D1, Idempotency:earlyBuffer, Events:messageCatch, Replay:self-heal, Concurrency:overlay
- **rationale:** CODE-CONFIRMED HOLE in the single-wake self-heal net. registerReceive (engine.ts:1055) returns {kind:'correlated'} for a broker-buffered message claimed at registration BEFORE it persists an active subscription, and the broker's markConsumed (correlation-broker.ts:263) only writes its own DO CONSUMED_KEY — it never sets external_messages.matched_subscription_id (only the live POST /messages path at index.ts:647 does). But getCorrelatedMessageForSubscription (messages.ts:163) requires final_outcome='correlated' AND matched_subscription_id. Therefore a buffered-then-claimed message is INVISIBLE to apply-from-D1. In pure workflow replay the step.do cache for recv:tag hides this; but the executor's catch->inline-drive fallback for a TERMINATED Workflow (operator resume) re-walks with NO step cache: the broker buffer is already consumed/deleted, the new registration parks an active subscription, and apply-from-D1 returns null forever -> PERMANENT STRAND until the wait-cap waitTimeout. The exact intersection of apply-from-D1, lost-wake self-heal, and correlation provenance — the safety net the whole TASK-54 design hinges on has a documented hole for buffered messages.
- **fixture:** fork -> (msgCatchA | svcB) -> join ; publish msgA BEFORE branch A registers (buffered), then force a Workflow-termination inline re-drive after the buffer is claimed but before the apply commits
- **drive:** publish msgA early (buffered 1h); fan out so A registers and the broker delivers the buffered msgA; assert external_messages.matched_subscription_id is NULL for that row (provenance gap); then terminate the Workflow and trigger the executor catch->runInstance(waitFor:null) inline re-drive (or suppress the apply and re-walk); poll past the backstop
- **assertions:** WHITE-BOX (direct/CI-reachable): a buffer-claimed message leaves external_messages.matched_subscription_id NULL while final_outcome stays non-'correlated' -> getCorrelatedMessageForSubscription returns null (proves the hole). RUNTIME (workflow): after a terminated-Workflow inline re-drive, branch A either (a) recovers the buffered payload from D1 within bound, or (b) is provably stranded — the test must FAIL on (b) and the fix must set matched_subscription_id (or persist the claimed event) on the buffer-claim path so apply-from-D1 covers it; join must not fire on B alone; no waitTimeout strand

#### `W-GWREUSE-01` — Gateway-decision reuse across real suspend/resume — OR activated-subset and XOR branch reused verbatim, never re-evaluated (promotes the simulated xor-replay harness to real CF)
- **risk** med · **legality** valid · **modes** workflow · **coverage** extends-existing (inclusive-gateway.test.ts (rewalk, direct) + xor-replay-workflow.test.ts (simulated harness, now promoted to real CF; absorbs former W-REG-XOR-01))
- **axes:** Replay:gateway-reuse, Gateways:inclusiveGateway, Gateways:exclusiveGateway, Flows:conditional
- **rationale:** An existing gateway_decisions (instance, gateway, occurrence) row — OR activated_flow_ids and XOR chosen branch alike — must be reused verbatim after a REAL Workflow suspend/resume, conditions NEVER re-evaluated even if variables changed since. Direct mode covers rewalk-verbatim and a simulated xor-replay harness exists; the real suspend/resume path is unverified. Merges the former W-REG-XOR-01 (promote the simulated xor-replay-workflow harness to a real Workflow) — its only unique angle was harness-vs-real-CF fidelity, which this corner subsumes by mutating the condition variable across the boundary. Catches a resume re-evaluating a condition (different branch on replay -> split-brain) and a divergence between the simulated step.do/waitFor harness and real CF memoization.
- **fixture:** INCLUSIVE_BPMN (OR subset) and XOR_BPMN; mutate a condition variable across a suspend/resume boundary
- **drive:** split records the subset (OR) / chosen branch (XOR); suspend/resume; change the condition var; resume drive; poll to terminal
- **assertions:** recorded OR activated subset AND XOR chosen branch reused verbatim post-resume; conditions not re-evaluated despite changed vars; OR-join still waits on the original recorded subset; deterministic final state matching both the direct rewalk and the simulated-harness expectation

#### `W-JOIN-FOLD-REPLAY-01` — Crash AFTER a join_completion is claimed but BEFORE the post-join leaf parks — replay must fast-forward the join WITHOUT re-folding branch overlays
- **risk** high · **legality** valid · **modes** workflow · **coverage** new (W-AND-CRASH-01 (crashes before the join, not the fold) + loop-replay-workflow.test.ts (harness template, single-token))
- **axes:** Replay:crash, Replay:fast-forward, Concurrency:join-barrier, Concurrency:overlay, Replay:determinism
- **rationale:** The single most dangerous variable-corruption replay point, and it is currently protected by exactly one guard with ZERO replay regression coverage. claimJoinCompletion (regions-runtime.ts:276-277) fast-forwards on an existing join_completions row WITHOUT re-running mergeBranchOverlays; if that idempotency ever regresses, a replay RE-FOLDS the branch overlays onto the parent token / root vars a second time -> silent variable corruption (a doc-order-later branch's value re-applied, or a non-conflicting key double-merged). W-AND-CRASH-01 crashes mid-race BEFORE the join, so it never replays the join-fold itself. This corner crashes at the worst moment: branches committed, arrivals recorded, join_completion INSERTed and overlays folded, but the post-join svcC not yet parked. The re-walk must read the existing completion and resume the PARENT token at outTarget with the SAME merged vars — not re-merge.
- **fixture:** fork -> (svcA writes k='A' | svcB writes k='B') -> join -> svcC reads k ; force a Workflow replay after claimJoinCompletion commits, before svcC parks
- **drive:** complete both branches so the join fires and folds overlays (k resolves to the doc-order winner); force a suspend/resume (replay) at the point svcC is about to register; resume; complete svcC; poll to terminal
- **assertions:** on replay claimJoinCompletion hits the existing-completion fast-forward (kind:'advance', NO mergeBranchOverlays call, zero overlay writes); k at svcC equals the pre-crash merged value (no double-fold); join_completions has exactly one row for the activation; root process_instances.variables folded exactly once; final vars + ledger deep-equal the no-crash run

#### `W-COMP-CRASH-REPLAY-01` — Crash mid-compensation reverse pass under the single-wake barrier — replay must not re-run already-applied compensators
- **risk** high · **legality** valid · **modes** workflow · **coverage** extends-existing (parallel-compensation.test.ts (direct, no crash/replay) + C-COMP-QUIESCE-01 (steady-state barrier, no crash))
- **axes:** Replay:crash, Compensation:quiescence, Replay:multi-wait, Replay:fast-forward, Concurrency
- **rationale:** Compensation is the most write-heavy multi-step reverse pass AND its quiescence/lease-expiry barrier is precisely the per-token multi-wait shape TASK-54 must collapse to the single bpmn_wake (compensation.ts is among the park-not-suspend files). A crash after some lineage compensators ran (saga ledger half-drained, some terminators settled) must replay-resume ENTIRELY from D1: re-walk skips the already-compensated steps (their compensation ledger rows / consumed markers), re-arms only still-armed terminators, and does NOT re-issue a compensator (double-compensation = the worst saga bug: an inventory release run twice). C-COMP-QUIESCE-01 tests the barrier with mixed live-token states but has NO crash/replay; W-AND-CRASH-01 only covers the FORWARD path. The reverse-pass replay under single-wake is entirely untested and is exactly where apply-from-D1 + idempotency markers + the collapsed barrier must compose.
- **fixture:** tx{ fork -> (svcA[+compA] | svcB[+compB] | svcC[+compC]) -> join -> fail } ; trigger cohort compensation, run compA, then force a replay before compB/compC complete
- **drive:** complete all branches, trigger the post-join failure -> cohort compensation begins; let compensator A run and commit; force a Workflow suspend/resume (or terminated-Workflow inline re-drive) mid-reverse-pass; resume; let compB/compC run; poll to terminal
- **assertions:** on replay compA is NOT re-issued (its compensation ledger row / consumed marker fast-forwards write-free); the barrier re-arms only still-pending terminators (no duplicate lease-expiry timers); reverse order preserved across the crash; instance reaches compensated terminal exactly once; no double-apply on any compensator; final ledger deep-equals a no-crash compensation run

#### `W-WAKE-TERMINAL-01` — At-least-once bpmn_wake delivered to an already-terminal instance is a clean no-op (no re-drive, no duplicate history, no Workflow error)
- **risk** med · **legality** valid · **modes** workflow · **coverage** new (C-IDEMP-DUP-01 (data-layer dedup, not the post-terminal tickle) + duplicate-message.test.ts / duplicate-worker-callback.test.ts)
- **axes:** Idempotency:dupMessage, Idempotency:dupJob, Replay:self-heal, Concurrency
- **rationale:** The at-least-once TAIL of the wake protocol, untested. Everything sends a contentless bpmn_wake; a duplicate /jobs/complete, a retried message publish, or a late timer DO-alarm can sendEvent(bpmn_wake) AFTER the instance already reached completed/compensated/incident and run() has returned. CF sendEvent to a finished Workflow instance may throw or be dropped; the executor has a catch->runInstance(waitFor:null) inline fallback for terminated Workflows — but on a TERMINAL instance that inline re-drive must short-circuit (isTerminalInstanceStatus -> reconstructFrontier returns []) and not re-emit history, re-fire a join, or surface an unhandledRejection. The data-layer idempotency rows (C-IDEMP-DUP-01) cover duplicate job/message at the persistence layer but NOT the duplicate TICKLE landing post-terminal at the wake layer. Catches a late tickle re-driving a completed saga or erroring the Worker.
- **fixture:** PARALLEL_BPMN (or DEMO_BPMN); drive to a terminal state, THEN deliver a stray/duplicate bpmn_wake (duplicate job-complete / retried publish / late timer alarm)
- **drive:** start; complete all branches to terminal; then re-POST a duplicate /jobs/complete (same lock_token) and a duplicate /messages (same messageId) and let a stale timer alarm fire — each emits a bpmn_wake to the finished instance; poll/inspect
- **assertions:** each stray tickle is a no-op: no new history events, no second join fire, instance status unchanged, no duplicate-step Workflow error / unhandledRejection; the executor catch->inline-drive fallback on a terminal instance returns immediately (terminal-status short-circuit) and writes nothing; GET body byte-identical before/after the strays

#### `W-TIMER-MIXED-BACKSTOP-01` — Timer-aware backstop with a MIXED frontier — one branch timer-waiting, one branch message-waiting; backstop must grow back when the branch timer fires/cancels (no hot re-walk loop)
- **risk** med · **legality** valid · **modes** workflow · **coverage** new (boundary-timer-backstop.test.ts / intermediate-timer-backstop.test.ts (single-token, direct) + C-BRANCH-ITIMER-01 (timer + service sibling, no re-grow assertion))
- **axes:** Replay:timer-self-heal, Events:intermediateTimer, Events:messageCatch, Concurrency:fan-out, Error:stepBudget
- **rationale:** wakeBackstop (wake.ts:31) reads getEarliestArmedTimerForInstance — INSTANCE-wide, not token-scoped (timers.ts query: WHERE instance_id=? AND status='armed' ORDER BY fire_at). In a parallel region with one branch parked on a timer (PT30S) and a sibling parked on a message (NO model deadline), the backstop is sized to the timer. The untested invariants: (1) once the branch timer FIRES, it must leave 'armed' status so the next backstop GROWS back to MAX_WAKE_BACKSTOP — otherwise a stale/cancelled-but-still-armed row pins the backstop short and the instance HOT-RE-WALKS every fire_at interval, burning the step budget; (2) a CANCELLED boundary timer (host task completed normally) must drop out of the min() the same way; (3) the message branch still completes via tickle/backstop after the timer drops. All existing timer-backstop coverage (W-REG-TIMER-01, C-AND-BTIMER-01, C-BRANCH-ITIMER-01) is single-deadline or timer-with-completing-service-sibling; none has a no-deadline MESSAGE sibling forcing the backstop to re-grow. Catches the instance-wide query mis-sizing the backstop under a heterogeneous frontier.
- **fixture:** fork -> (svcA -> timerCatch(PT) -> svcA2 | msgCatchB) -> join ; deliver B's message only after A's timer has fired
- **drive:** start; let branch A's intermediate timer fire (DO alarm -> bpmn_wake), advance A; while B is still parked on its message, observe the backstop re-size; then deliver msgB; poll to terminal
- **assertions:** after A's timer fires its row leaves 'armed' so getEarliestArmedTimerForInstance returns null -> the next wakeBackstop = MAX_WAKE_BACKSTOP (not still PT); NO hot re-walk loop while B waits (per-drive step counter / wake#k count stays O(1), well under stepBudgetSoft); B completes via its tickle/backstop; a cancelled boundary timer on a completed host likewise drops out of the backstop; join fires once both arrive; terminal within bound

#### `W-REG-LINEAR-01` — Single-token regression — linear Start->Service->Receive->End suspend/resume in Workflow mode
- **risk** med · **legality** valid · **modes** workflow · **coverage** extends-existing (tests/integration/demo-flow.test.ts (direct))
- **axes:** Replay:single-token, Activities:serviceTask, Activities:receiveTask
- **rationale:** Confirm the unified single-wake model does not regress the M0 happy path: a service-task park + a receive-task message wait across real step.waitForEvent suspend/resume. Catches the single-wake loop breaking the simplest path (step-name collision, double-apply) — a regression the 413 direct-mode tests cannot see. Plausibly the direct automation of the manual WM-1 single-token regression.
- **fixture:** DEMO_BPMN (Start -> svc -> receive -> End)
- **drive:** start; lease+complete the service task; POST /messages to satisfy the receive; poll to terminal
- **assertions:** each transition exactly once; service output applied once, receive payload applied atomically; reaches completed within bound; no duplicate-step Workflow error; final vars identical to the direct-mode run

#### `W-REG-TIMER-01` — Single-token regression — boundary timer backstop on a real Workflow (timer-aware sizing)
- **risk** med · **legality** valid · **modes** workflow · **coverage** extends-existing (boundary-timer-backstop.test.ts / intermediate-timer-backstop.test.ts (direct))
- **axes:** Replay:single-token, Events:boundaryTimer, Replay:timer-self-heal
- **rationale:** A boundary/intermediate timer on a single-token task must fire on time under the timer-aware backstop (wakeBackstop = min(timeToNearestArmedTimer+slack, MAX_WAKE_BACKSTOP)) — a known-deadline wait stays O(1) steps and fires on schedule. Catches the unified backstop either missing the timer deadline or re-walking every backstop interval (step-budget blowup) on a long timer. The multi-token re-grow variant is W-TIMER-MIXED-BACKSTOP-01.
- **fixture:** boundary-timer-backstop fixture (svc[boundaryTimer PT] -> alt) — short PT in workflow
- **drive:** start; let the timer fire (short PT); assert the redirect is taken; poll to terminal
- **assertions:** timer fires on time (backstop sized to fire_at, not MAX_WAKE_BACKSTOP); DO-alarm-first, step.sleep not used; redirect taken; O(1) re-walks for a long timer (no step-budget blowup); terminal within bound

### 10. Legality rejects (direct, publish-validation)

#### `R-BOUNDARY-ON-GW-01` — Boundary event attached to a parallel/inclusive/exclusive gateway -> publish reject
- **risk** med · **legality** reject · **modes** direct · **coverage** extends-existing (tests/unit/bpmn-validator.test.ts)
- **axes:** Events:boundary, Gateways, Legality:reject
- **rationale:** Boundary events cannot attach to gateways (per-kind attachment requires a service/receive task or transaction). Catches a modeler hanging a timer/error boundary on a fork gateway — a parse-time corruption of the region CFG (boundaries are routing vertices).
- **fixture:** fork parGW with a boundaryEvent attached to it
- **drive:** POST /definitions/drafts -> /publish; expect reject
- **assertions:** publish rejected with the offending boundary element id + reason (boundary cannot attach to a gateway); no version created

#### `R-MERGE-UNCONTROLLED-01` — Uncontrolled merge — task with >1 incoming flow inside a region -> reject
- **risk** high · **legality** reject · **modes** direct · **coverage** extends-existing (tests/unit/regions.test.ts)
- **axes:** Concurrency:merge, Legality:reject
- **rationale:** Inside a region only the matching join or a merge-safe gateway may have >1 incoming. A service/receive task, intermediate catch, or end with >1 incoming would execute twice under concurrent tokens instead of synchronising — the single most dangerous silent-corruption combo if it slipped past publish.
- **fixture:** fork -> (A->M | B->M) where M is a serviceTask with 2 incoming (no join gateway)
- **drive:** POST draft -> /publish; expect reject
- **assertions:** publish rejected with the element id of the uncontrolled-merge node; the region validator emits its own error (not suppressed by unrelated prior errors)

#### `R-JOIN-MISMATCH-01` — Mismatched join type — AND split closed by an inclusive join (or vice-versa) -> reject
- **risk** high · **legality** reject · **modes** direct · **coverage** extends-existing (tests/unit/bpmn-validator.test.ts (PARALLEL_MISMATCH))
- **axes:** Gateways:parallelGateway, Gateways:inclusiveGateway, Legality:reject
- **rationale:** The post-dominating join must be the SAME type as the split (jNode.type !== s.type). Catches an AND fork closed by an OR join — it would synchronise on the wrong subset semantics (wait for a recorded subset that an AND fork never records).
- **fixture:** parGW fork -> (A|B) -> inclusiveGW join (PARALLEL_MISMATCH_BPMN)
- **drive:** POST draft -> /publish; expect reject
- **assertions:** publish rejected (mismatched join type) with the split+join gateway ids; no version

#### `R-JOIN-NOFORK-01` — Dangling multi-incoming parallel/inclusive JOIN with no matching split -> publish reject
- **risk** med · **legality** reject · **modes** direct · **coverage** extends-existing (tests/unit/regions.test.ts)
- **axes:** Gateways:parallelGateway, Gateways:inclusiveGateway, Concurrency:merge, Legality:reject
- **rationale:** regions.ts:226 is a DISTINCT validator branch ('Concurrent join is not matched by any split of the same type — an unmatched multi-incoming parallel/inclusive gateway is rejected') with no matrix scenario. It is NOT R-MERGE-UNCONTROLLED-01 (a TASK with >1 incoming, line 198), NOT R-JOIN-MISMATCH-01 (a wrong-TYPE join that a split does match, line 160), and NOT R-BRANCH-ESCAPE-01. It catches a modeler drawing a join gateway fed by two flows that were never forked (a merge-without-a-fork) — at runtime the second arrival would have no recorded join membership and either deadlock or fire twice. Validator-completeness gap: each reject rule needs its own coverage so an unrelated prior error cannot mask it.
- **fixture:** two independent flows (e.g. two start-ish paths or a non-region split) converging into one parallelGateway acting as a join, with no matching parallel split dominating them
- **drive:** POST /definitions/drafts -> /publish; expect reject
- **assertions:** publish rejected naming the unmatched join gateway id with the line-226 reason (unmatched multi-incoming join); no version created; the region validator emits THIS error specifically (not suppressed by, nor conflated with, an uncontrolled-merge or mismatch error)

#### `R-MERGE-NONLAMINAR-01` — Two regions partially overlap (non-laminar nesting) -> reject
- **risk** high · **legality** reject · **modes** direct · **coverage** extends-existing (tests/unit/regions.test.ts)
- **axes:** Concurrency:nesting, Legality:reject
- **rationale:** Any two regions must nest or be disjoint; partial overlap is rejected (laminar check). Catches interleaved fork/join pairs whose member-sets cross — the structural invariant that makes overlay folding sound.
- **fixture:** fork1 ... fork2 ... join1 ... join2 with overlapping member-sets (interleaved)
- **drive:** POST draft -> /publish; expect reject
- **assertions:** publish rejected (partial overlap / non-laminar) with the region element ids

#### `R-LOOP-CROSS-01` — Loop (sequence flow) crossing a region boundary -> reject
- **risk** high · **legality** reject · **modes** direct · **coverage** new (—)
- **axes:** Loops, Concurrency:confinement, Legality:reject
- **rationale:** A cycle whose endpoints lie on opposite sides of a region boundary (a back-edge re-entering the region middle, or a member->non-member edge) is rejected — surfaced via branch-escape / single-entry checks. Catches a loop that would smuggle a token across the join, breaking last-token-out.
- **fixture:** fork -> (A->B) -> join, with a back-edge from a post-join node into B (inside the region)
- **drive:** POST draft -> /publish; expect reject
- **assertions:** publish rejected (loop crosses the region / branch escape / single-entry violation) with the offending edge's element id

#### `R-SAMEMSG-01` — Same message name awaited by two concurrent branches -> reject
- **risk** high · **legality** reject · **modes** direct · **coverage** extends-existing (tests/unit/bpmn-validator.test.ts (PARALLEL_SAME_MESSAGE))
- **axes:** Events:messageCatch, Idempotency:correlation, Concurrency, Legality:reject
- **rationale:** The broker permits one active subscription per workspace+messageName+correlationKey; two simultaneously-active branch catch points on the same message name collide. Catches a token set that would lose/misroute a correlated message at runtime.
- **fixture:** fork -> (msgCatch "Pay" | msgCatch "Pay") -> join (PARALLEL_SAME_MESSAGE_BPMN)
- **drive:** POST draft -> /publish; expect reject
- **assertions:** publish rejected (concurrent same-message) with both offending element ids

#### `R-INSTANTIATE-01` — instantiate="true" on a parallel/inclusive gateway, EBG, or receiveTask -> reject
- **risk** med · **legality** reject · **modes** direct · **coverage** extends-existing (tests/unit/bpmn-validator.test.ts (INSTANTIATE_RECEIVE))
- **axes:** Activities:receiveTask, Gateways, Legality:reject
- **rationale:** Instances start via the API only; instantiate="true" (message-start-by-instantiation) is rejected on gateways/EBG/receiveTask. Catches a model that would self-instantiate, bypassing the version-binding contract.
- **fixture:** receiveTask instantiate="true" (INSTANTIATE_RECEIVE_BPMN); also parGW/EBG instantiate variants
- **drive:** POST draft -> /publish for each carrier; expect reject
- **assertions:** publish rejected for each instantiate carrier with the element id

#### `R-NONINT-TIMER-01` — Non-interrupting boundary timer (cancelActivity="false") -> reject
- **risk** med · **legality** reject · **modes** direct · **coverage** extends-existing (tests/unit/bpmn-validator.test.ts)
- **axes:** Events:boundaryTimer, Legality:reject
- **rationale:** A non-interrupting boundary needs a second concurrent token — deferred. Only interrupting boundary timers are supported. Catches a model that would silently spawn an extra token outside the region machinery.
- **fixture:** svc[boundaryTimer cancelActivity="false"]
- **drive:** POST draft -> /publish; expect reject
- **assertions:** publish rejected (non-interrupting boundary not supported) with the element id

#### `R-COND-OFF-XOR-01` — conditionExpression on a flow not leaving an exclusive/inclusive gateway -> reject
- **risk** med · **legality** reject · **modes** direct · **coverage** extends-existing (tests/unit/bpmn-validator.test.ts)
- **axes:** Flows:conditional, Gateways:parallelGateway, Legality:reject
- **rationale:** Conditions are only supported on outgoing flows of an exclusive/inclusive gateway (element-presence check, even an empty body). Catches a conditionExpression on a parallel-split out-flow or a plain task out-flow — concurrency fan-out must be unconditional.
- **fixture:** parGW fork with a conditionExpression on one out-flow
- **drive:** POST draft -> /publish; expect reject
- **assertions:** publish rejected (condition only on exclusive/inclusive split) with the flow id

#### `R-BRANCH-ESCAPE-01` — Branch escape — a node inside the region edges to a target outside the region not through the join -> reject (covers the unreachable branch-internal cancel-end)
- **risk** high · **legality** reject · **modes** direct · **coverage** extends-existing (tests/unit/regions.test.ts (absorbs the reject-form of the dropped C-COMP-BRANCHCANCEL-01))
- **axes:** Concurrency:confinement, Events:cancelEnd, Legality:reject
- **rationale:** Branch confinement: every member's out-edge (including a boundary redirect) must stay in-region or be the join in-edge (regions.ts Rule 5, lines 202-209). Catches a branch (or a boundary-timer/error redirect) jumping to a sibling branch, the split, or past the join — the escape that deadlocks the join by stealing a token. This ALSO absorbs the dropped, mis-marked C-COMP-BRANCHCANCEL-01: a branch error-boundary/boundary-timer routing to the transaction's cancel-end is an escape because the cancel-end lies OUTSIDE the single-exit region — which is precisely why a transaction cancel can only be triggered by a POST-JOIN settle, never from inside a live parallel region. The legal nested-tx cancel-end form lives in C-COMP-NESTEDTX-BRANCH-01.
- **fixture:** fork -> (A -> [edge to a post-join node OR the tx cancel-end] | B) -> join
- **drive:** POST draft -> /publish; expect reject
- **assertions:** publish rejected (branch escape / confinement) with the escaping edge's element id; a branch edge targeting the transaction cancel-end is rejected for the same reason


---

## Appendix B — Legality rules & IncidentKind enum (generated)

### B.1 Valid combination corners (happy-path, with what makes them legal)

- **AND parallelGateway split (1-in/N-out) paired with exactly one matching parallelGateway join (N-in/1-out), each branch a service/receive task**  
  _Canonical SESE region: J=ipdom(S) is same-type with >1 incoming and idom(J)==S (regions.ts:140-171); split↔join bijection holds._
- **OR inclusiveGateway split with per-branch FEEL conditions + a gateway-owned default, paired with a matching inclusiveGateway join**  
  _Inclusive split obeys the SAME condition/default rules as exclusive (validator.ts:931-997) and forms an 'or' region (regions.ts:217); conditions ARE legal leaving an inclusiveGateway (validator.ts:777)._
- **Boundary timer (interrupting) on a service task inside a parallel branch, its redirect flow landing on a node still inside the region (reaching the join)**  
  _Timer boundaries are CFG routing vertices (regions.ts:110-114,131-136); legal while branch confinement holds — the redirect must reach J, not escape (regions.ts:204-211)._
- **Interrupting error boundary on a service task inside a branch, routing to an in-region token-path node that reaches the join**  
  _Error/cancel/timer boundaries are modeled as routing vertices in the region CFG (regions.ts:109-110); confinement satisfied because the redirect target post-dominates to J._
- **bpmn:transaction wholly inside a parallel/inclusive branch, with its own internal saga (compensation boundary + isForCompensation handler + association)**  
  _Transaction is a single CFG vertex (regions.ts:106-107), recursed for its own SESE (validator.ts:459); legal if BOTH normal and cancel/error/timer-boundary exits stay in-region (design §4.1 rule 9)._
- **eventBasedGateway (timer/message race) inside a parallel branch whose branch catches re-converge through an exclusiveGateway XOR merge before the AND-join**  
  _EBG is an accepted token node; its catch branches must merge via a merge-SAFE exclusiveGateway pass-through (regions.ts:192-195) — a bare multi-incoming convergence would be an uncontrolled merge._
- **Message intermediate catch (unique message name) inside a token-set branch**  
  _Allowed at process level and inside a transaction (validator.ts:541-575); only rejected when two concurrently-active catch points share a message name (validator.ts:1424-1428)._
- **Timer intermediate catch (single ISO-8601 delay) inside a parallel branch**  
  _Single-token delay with exactly 1 in / 1 out (validator.ts:1284-1295); a delay node is a plain CFG member, confined to its branch._
- **Nested laminar regions: a parallel (or inclusive) region wholly nested inside one branch of an enclosing parallel/inclusive region**  
  _Two regions that nest (one member-set ⊂ the other) pass the laminar check (regions.ts:233-244); only partial overlap is rejected._
- **Loop (cycle) wholly inside a single branch — token-path edges back through an exclusiveGateway, bumping occurrence**  
  _Cycles are legal (degree-check not acyclicity, validator.ts:886); a loop confined to one branch never crosses a region boundary (design §4.1 rule 8)._
- **exclusiveGateway XOR split + XOR pass-through join (and a loop) inside a parallel branch**  
  _An exclusiveGateway is a merge-safe gateway, so its >1-incoming join is exempt from the uncontrolled-merge rule (regions.ts:192-195); single-token by XOR semantics._
- **Service task with compensation boundary + isForCompensation handler reached only by <association>, inside a transaction inside a parallel branch**  
  _Compensation boundaries/handlers are OFF the token path (regions.ts:107) so they are excluded from the region CFG and never trip confinement/merge checks._

### B.2 Reject combinations (publish-validation, with citation)

- **parallelGateway split with no matching same-type join (e.g. branches end at separate end events)** — J=ipdom(S) is not a same-type gateway with >1 incoming, or strong single-exit fails (an in-region end event opens a path to SINK not through J) — region not single-entry/single-exit.  
  `src/bpmn/regions.ts:159-160 (+ strong single-exit via post-dominators, regions.ts:144-151; design §4.1 rule 4)`
- **Mismatched join type: parallelGateway split closed by an inclusiveGateway join (or vice-versa)** — The post-dominating join must be a gateway of the SAME type as the split.  
  `src/bpmn/regions.ts:159 (jNode.type !== s.type)`
- **Split and its join not single-entry (join not dominated by the split — an extra edge enters the join from outside)** — idom(J) != S — region nesting is not properly balanced.  
  `src/bpmn/regions.ts:163-165`
- **One join matched by two splits (bijection violation)** — The split↔join map must be a bijection; a join claimed by two splits is rejected.  
  `src/bpmn/regions.ts:167-169`
- **Unmatched multi-incoming parallelGateway/inclusiveGateway (a join gateway with no owning split)** — An unmatched multi-incoming parallel/inclusive gateway is rejected (bijection 'other half').  
  `src/bpmn/regions.ts:224-227`
- **Uncontrolled merge: a service task / receive task / intermediate catch / end event with >1 incoming flow inside a region** — Only the matching join or a merge-safe gateway may have >1 incoming; concurrent branch tokens would execute the node twice instead of synchronising at the join.  
  `src/bpmn/regions.ts:188-200 (design §4.1 rule 6)`
- **Multi-incoming eventBasedGateway inside a region** — An EBG is a SPLIT, never a synchronising join, and is NOT merge-safe — a multi-incoming EBG inside a region is an uncontrolled merge.  
  `src/bpmn/regions.ts:184-187,192-198`
- **Branch escape / boundary-redirect escape: a node inside the region has an edge to a target outside the region that does not pass through the join** — Branch confinement — every member's out-edge (incl. a boundary redirect) must stay in the region or be the join in-edge.  
  `src/bpmn/regions.ts:204-211 (design §4.1 rule 5)`
- **A none or cancel end event placed inside a parallel/inclusive region** — An in-region end opens a path to the virtual SINK not through J, so J fails to post-dominate S → the split reports no matching join / single-entry violation; the branch would lose its token and deadlock the join.  
  `src/bpmn/regions.ts:128,144-151,159 (design §4.1 rule 4)`
- **Two regions that partially overlap (non-laminar nesting)** — Any two regions must be nested or disjoint; partial overlap is rejected.  
  `src/bpmn/regions.ts:230-244 (design §4.1 rule 7)`
- **A loop (sequence flow) whose endpoints lie on opposite sides of a region boundary** — A region-crossing cycle is rejected — caught as a branch-escape edge (member→non-member) or as a single-entry violation when the back-edge re-enters the region middle.  
  `src/bpmn/regions.ts:204-211 + 163-165 (design §4.1 rule 8)`
- **Transaction inside a branch whose cancel/error/timer-boundary exit (or normal exit) leaves the region** — Both transaction exits must stay in-region and reach J; a boundary/normal exit that escapes is a confinement violation.  
  `src/bpmn/regions.ts:204-211 (design §4.1 rule 9)`
- **The same message name awaited by two catch points (receiveTask / message intermediateCatch / EBG message branch) that can be simultaneously active inside a parallel/inclusive region** — The broker permits one active subscription per workspace+messageName+correlationKey; concurrent same-name waits collide. Use distinct message names.  
  `src/bpmn/validator.ts:1394-1429 (design §4.1 rule 10)`
- **conditionExpression on a flow that does NOT leave an exclusiveGateway or inclusiveGateway** — Conditions are only supported on outgoing flows of an exclusive or inclusive gateway (element-presence check, even an empty condition body).  
  `src/bpmn/validator.ts:777-784`
- **A non-default outgoing flow of an exclusive/inclusive split carrying no (or empty) condition** — Every non-default flow of a split must carry a FEEL condition.  
  `src/bpmn/validator.ts:968-975`
- **A default flow that carries a conditionExpression, or a default attribute referencing a flow that does not leave that gateway** — The default must not carry a condition and must reference one of the gateway's own outgoing flows.  
  `src/bpmn/validator.ts:943-960`
- **A default attribute on a non-gateway node (activity default = implicit split)** — A default flow is only supported on an exclusiveGateway (and inclusiveGateway split).  
  `src/bpmn/validator.ts:645-652`
- **conditionExpression with a non-FEEL language attribute** — Conditions must be FEEL — leave language unset or set a FEEL identifier.  
  `src/bpmn/validator.ts:979-985`
- **Implicit split: >1 outgoing sequence flow on a non-gateway node (task, event, end)** — Implicit splits are not supported — route branching through a gateway (only exclusive/eventBased/parallel/inclusive may have >1 out).  
  `src/bpmn/validator.ts:886-900`
- **A boundary event attached to a parallel/inclusive/exclusive gateway** — Boundary events cannot attach to gateways; per-kind attachment rules require a service/receive task or transaction.  
  `src/bpmn/validator.ts:1016-1024 (exclusive); per-kind serviceTask/transaction checks 1061,1102,1157,1186-1191; profile rule 4 (09-easy-bpmn-profile.md:372)`
- **Non-interrupting boundary timer (cancelActivity="false")** — A non-interrupting boundary needs a second token — deferred to concurrency; only interrupting boundary timers are supported.  
  `src/bpmn/validator.ts:493-499`
- **Boundary or intermediate timer using timeCycle, a FEEL expression, a non-parsing literal, or zero/two time children** — A timer needs exactly one static ISO-8601 timeDate or timeDuration; timeCycle (repetition needs extra tokens) and FEEL are rejected.  
  `src/bpmn/validator.ts:96-125 (readTimerTrigger) called at 500 / 528`
- **More than one timer boundary on a single activity** — At most one timer boundary per activity (multiple static timers make one dead or arrival-time-dependent).  
  `src/bpmn/validator.ts:1266-1275`
- **Boundary timer attached to a transaction** — A timer on a transaction would terminate the scope without compensation (deferred to M5); attach it to a task inside the transaction routing to a cancel end.  
  `src/bpmn/validator.ts:1180-1185`
- **A boundary event (any kind) attached to an intermediate catch event** — Boundary events attach to an activity or transaction, never to an intermediate catch (it is an event, not an activity).  
  `src/bpmn/validator.ts:1047-1055`
- **instantiate="true" on a parallel/inclusive gateway, eventBasedGateway, or receiveTask** — Instances start via the API only; remove instantiate.  
  `src/bpmn/validator.ts:623-625 (parallel/inclusive); 598-604 (EBG); 726-732 (receiveTask)`
- **eventGatewayType="Parallel" on an eventBasedGateway** — A Parallel event gateway waits for ALL events at once (extra concurrent tokens — deferred); only the default exclusive event gateway is supported.  
  `src/bpmn/validator.ts:605-612`
- **eventBasedGateway with <2 branches, a branch target that is not a single-incoming intermediate catch, >1 timer branch, or duplicate message branches** — EBG needs >=2 branches, every target a catch whose only incoming is from the gateway, <=1 timer branch, and distinct message names.  
  `src/bpmn/validator.ts:1313-1367`
- **An intermediate catch event with >1 incoming flow (a join into it)** — A timer/message catch is a single-token node, not a join; exactly one incoming is required.  
  `src/bpmn/validator.ts:1284-1295`
- **A terminate end event (or any non-none, non-cancel end-event definition)** — Only a none end event or a cancel end event (inside a transaction) is supported; EndKind is not widened beyond none|cancel.  
  `src/bpmn/validator.ts:686-701 (design §4.1 rule 11)`
- **A cancel end event outside any transaction** — A cancel end event is allowed only inside a <transaction>.  
  `src/bpmn/validator.ts:865-873`
- **userTask / sendTask / manualTask / scriptTask / businessRuleTask / abstract task / callActivity / non-transaction subProcess / adHocSubProcess** — Not in the supported flow-node whitelist — rejected with element id + the supported-set hint.  
  `src/bpmn/validator.ts:632-640 (SUPPORTED_NODE_TYPES lookup, src/bpmn/profile.ts:7-36)`
- **multiInstanceLoopCharacteristics / standardLoopCharacteristics marker on an activity or transaction** — Loop/multi-instance characteristics (the activity markers) are not supported — distinct from accepted cycles drawn as sequence flows.  
  `src/bpmn/validator.ts:655-661 (activity); 451-457 (transaction)`
- **complexGateway** — Complex gateways are not on the roadmap; deferred with a roadmap pointer.  
  `src/bpmn/validator.ts:439-447 + src/bpmn/profile.ts:50-55 (DEFERRED_GATEWAY_REASONS)`
- **A sequence flow crossing a transaction boundary (connecting nodes in different scopes)** — Flows must connect nodes in the same scope.  
  `src/bpmn/validator.ts:789-796`
- **collaboration / choreography / pools (participants) / lanes** — easy-bpmn runs a single executable process; collaborations, pools, and lanes are unsupported.  
  `src/bpmn/validator.ts:278-286 (collaboration/choreography); 332-334 (lanes)`
- **Boundary event with no / multiple / unsupported event definitions (message/signal/escalation/conditional boundary)** — Only timer, compensation, error, and cancel boundary events are supported.  
  `src/bpmn/validator.ts:472-485`

### B.3 SESE validation rules

Rule 1 (CFG build): Per scope (process + each transaction independently), build a control-flow graph whose vertices are token-path nodes + each transaction as one vertex + error/cancel/timer boundary events (compensation boundaries/handlers excluded — off token path). Edges = every sequence flow, plus activity->attached-boundary and boundary->boundary-target; add virtual SOURCE->scope-start and end-event/successor-less-node->virtual SINK. (regions.ts:105-136)

Rule 2 (Dominators/post-dominators): Compute idom from SOURCE and ipdom toward SINK via iterative Cooper-Harvey-Kennedy. (regions.ts:51-95,139-141)

Rule 3 (Matched pair + bijection): For each split S (parallel/inclusive with >1 outgoing), J:=ipdom(S) must be a gateway of the SAME type with >1 incoming and idom(J)==S, else reject ('no matching join' / 'single-entry violated'). The split<->join map must be a bijection: a join claimed by two splits, or an unmatched multi-incoming parallel/inclusive gateway, is rejected. (regions.ts:154-171,224-227)

Rule 4 (Region & strong single-exit): R(S,J) = { X : S dom X and J postdom X }. Because the CFG carries the virtual SINK and boundary edges, J postdom S automatically rejects (a) a none/cancel end inside the region and (b) any boundary whose target leaves the region or reaches an end — guaranteeing every activated branch delivers exactly one token to J. (regions.ts:144-174)

Rule 5 (Branch confinement): Each branch is single-entry (split out-flow) / single-exit (join in-flow). Every flow and boundary redirect of a member must land in the same region (members union join); an edge crossing into a sibling branch, into the split, or past the join is rejected with element id. (regions.ts:204-211)

Rule 6 (No uncontrolled merge): Inside a region, no node other than the matching join may have >1 incoming flow, except a merge-safe gateway — exclusiveGateway (XOR single-token pass-through), or a nested matched parallel/inclusive JOIN. A service/receive task, intermediate catch, end event, or an eventBasedGateway (a split, not a synchroniser) with >1 incoming is rejected — concurrent tokens would execute it twice instead of synchronising. (regions.ts:184-200)

Rule 7 (Laminar nesting): Any two regions must be nested (one member-set subset of the other) or disjoint; partial overlap is rejected. (regions.ts:230-244)

Rule 8 (Cycles): A loop may be wholly inside a single branch (bumping occurrence as in M2) or wholly outside the region, but a sequence flow whose endpoints lie on opposite sides of a region boundary is rejected ('loop crosses the region') — surfaced via the confinement/single-entry checks. (regions.ts:163-165,204-211; design §4.1 rule 8)

Rule 9 (Transaction inside a branch): Allowed; its internal SESE is validated by recursion, and BOTH its normal outgoing exit and any cancel/error/timer-boundary outgoing must stay in-region and reach J. (validator.ts:450-461; regions.ts:106-107,204-211; design §4.1 rule 9)

Rule 10 (Concurrent same-message rejection): Within a region (and across simultaneously-active regions), no two branch catch points (receiveTask, message intermediateCatchEvent, EBG message branch) may reference the same message name — the broker permits one active subscription per workspace+messageName+correlationKey, so concurrent same-name waits collide. Rejected with offending element ids. (validator.ts:1394-1429)

Rule 11 (Terminate stays rejected): terminate end events remain out of scope; EndKind is not widened beyond none|cancel — only a none end (commit) or a cancel end inside a transaction is accepted. (validator.ts:686-701; design §4.1 rule 11)

Element-disjointness invariant: SESE guarantees every element id belongs to at most one branch of at most one enclosing region, so two concurrent tokens never visit the same element — M4 adds no token discriminator to the per-element uniqueness keys; occurrence (per-element walk-local) stays sufficient. (design §4.1, doc lines 177-181)

Region validation runs as a dedicated pass AFTER degree/linearity and gateway-condition passes, emits its own element-id errors (not suppressed by unrelated prior errors), and the reachability BFS is retained as a backstop. (validator.ts:1369-1392,1442-1477)

### B.4 Full IncidentKind enum & error taxonomy

- Error-code routing precedence — exact @errorCode boundary → single catch-all (errorRef-less) → null = uncaught business error (Hazard); deterministic regardless of node-iteration order
- Hazard — an uncaught Error / technical exhaustion / noPath / loopLimit inside a transaction terminates the instance and does NOT auto-compensate (operator /cancel available)
- Incident kind: serviceTaskFailure — forward retry exhaustion or uncaught-business-error Hazard
- Incident kind: compensationFailure — a compensator exhausted its retries (accompanies compensationFailed)
- Incident kind: poison — poison-job termination (no compensation); ALSO the join-time merged-overlay-over-1MiB terminal
- Incident kind: loopLimit — element exceeded MAX_ELEMENT_OCCURRENCES=1000 visits
- Incident kind: noPath — XOR/OR split with no true condition and no default
- Incident kind: jobActivationTimeout — un-leasable forward job past its activation TTL (per-job JobScheduler DLQ)
- Incident kind: waitTimeout — an un-guarded service-task/receive-task durable-wait cap elapsed
- Incident kind: conditionFailure — hard FEEL evaluation error on an exclusive/inclusive split flow
- Incident kind: concurrencyLimit — fan-out would exceed MAX_CONCURRENT_TOKENS (terminal)
- Incident kind: stepBudget — per-drive step counter crossed STEP_BUDGET_SOFT (graceful)
- Incident kind: timeout — LEGACY (M1), retained in the enum/API for compatibility, never written by current code

_Citations:_ /home/coder/project/src/runtime/forward-task.ts:61-82 (errorBoundaryTarget: exact → catch-all → null/Hazard); /home/coder/project/src/runtime/forward-task.ts:632-639 (uncaught-business + technical-exhaustion → serviceTaskFailure Hazard); /home/coder/project/src/persistence/instances.ts:783-809 (full IncidentKind enum); /home/coder/project/src/runtime/incidents.ts:81-103 (raiseConcurrencyLimit, raiseStepBudget); /home/coder/project/src/runtime/regions-runtime.ts:307-318 (join over-1MiB → poison); /home/coder/project/specs/002-saga-orchestrator/data-model.md:451-463 (timeout split: serviceTaskFailure|compensationFailure|conditionFailure|jobActivationTimeout|waitTimeout|poison|loopLimit|noPath)


---

## Appendix C — Axes inventory (generated)

### Gateways

The four gateway flow-node types the validator accepts (each opened in its own validator pass), plus the one explicitly deferred. Determines split/join semantics under test.

- exclusiveGateway — data-driven XOR; split (1-in N-out, FEEL conditions in document order, first-true-wins, else default, else terminal noPath) + pass-through join (N-in 1-out, no waiting)
- parallelGateway — block-structured (SESE) AND; fork split (1-in N-out, no conditions) paired with exactly one matching parallelGateway join (synchronise, waits for a token from every activated branch)
- inclusiveGateway — block-structured (SESE) OR; split takes every out-flow whose FEEL condition is true (≥1, else gateway-owned default, else noPath) + matching inclusiveGateway join waiting for exactly the recorded activated subset
- eventBasedGateway — deterministic race over ≥2 intermediate-catch (timer/message) branches; ≤1 timer branch, distinct messages; decides on a single gateway_decisions row; instantiate=true / eventGatewayType=Parallel reject
- complexGateway — REJECTED (not on the roadmap); any implicit split (>1 outgoing sequence flow on a non-gateway node) also rejected

_Citations:_ /home/coder/project/src/bpmn/profile.ts:7-36 (SUPPORTED_NODE_TYPES: exclusiveGateway/eventBasedGateway/parallelGateway/inclusiveGateway); /home/coder/project/src/bpmn/profile.ts:50-55 (DEFERRED_GATEWAY_REASONS: complexGateway only); /home/coder/project/docs/bpmn/09-easy-bpmn-profile.md:229,238-240 (gateway constraints); /home/coder/project/docs/bpmn/09-easy-bpmn-profile.md:368-369 (implicit-split rule); /home/coder/project/src/bpmn/regions.ts:49 (isSplitType = parallel|inclusive)

### Events

Start/end/boundary/intermediate event variants discriminated by child eventDefinition. Boundary and intermediate-catch kinds are the high-variance dimension.

- None Start Event — no child eventDefinition; exactly one per scope; instances start via API
- None End Event — plain completion; a transaction's none-end = commit
- Cancel End Event — endEvent + cancelEventDefinition; only inside a transaction → triggers reverse-order compensation
- Boundary: compensation — boundaryEvent + compensateEventDefinition; neither interrupting nor non-interrupting; 0 outgoing seq flow + exactly 1 association to an isForCompensation handler
- Boundary: error — boundaryEvent + errorEventDefinition; interrupting; on a serviceTask; free routing to any token-path node in same scope (M3-L2)
- Boundary: cancel — boundaryEvent + cancelEventDefinition; interrupting; only on the transaction; its out-flow is the saga-failed path
- Boundary: timer — boundaryEvent + timerEventDefinition; interrupting only (cancelActivity false rejects); on serviceTask/receiveTask, never a transaction; ≤1 per activity; one static ISO-8601 timeDate|timeDuration
- Intermediate catch: timer — intermediateCatchEvent + timerEventDefinition; a delay step on the token path; exactly 1 incoming + 1 outgoing; process-level or inside a transaction
- Intermediate catch: message — intermediateCatchEvent + messageEventDefinition; correlation wait identical to a receiveTask; exactly 1 incoming + 1 outgoing; reuses registerReceive/applyMessage

_Citations:_ /home/coder/project/src/bpmn/profile.ts:58-64 (event-definition discriminators: Compensate/Error/Cancel/Timer/Message); /home/coder/project/specs/002-saga-orchestrator/data-model.md:57-58 (endEvent.kind none|cancel|compensate; boundaryEvent.kind error|cancel|compensate|timer); /home/coder/project/docs/bpmn/09-easy-bpmn-profile.md:232-238,242 (boundary + intermediate-catch + cancel-end constraints); /home/coder/project/docs/bpmn/09-easy-bpmn-profile.md:398-419 (validation rules 14/15/16 timer-boundary, timer-catch, message-catch)

### Activities

The executable work-bearing nodes and the saga scope that contains them.

- Service Task — serviceTask bound by easy-bpmn:taskDefinition type (routing key, never id/name) + retries; durable pull job (status created→locked), persist-output-before-advance
- Receive Task — receiveTask with messageRef; durable wait state resumed by a correlated message; instantiate=true rejected; payload applied atomically with the transition
- Compensation Handler — serviceTask isForCompensation=true; off the token path, reached only via a compensation boundary's association; own taskType; must live in a transaction
- Transaction — bpmn:transaction saga scope: one none-start, supported children, none-end (commit), optional cancel-end; records compensatable steps in the saga ledger

_Citations:_ /home/coder/project/src/bpmn/profile.ts:8-14 (StartEvent/ServiceTask/ReceiveTask/EndEvent/Transaction/BoundaryEvent); /home/coder/project/docs/bpmn/09-easy-bpmn-profile.md:224-243 (whitelist table: Service/Receive/Compensation Handler/Transaction); /home/coder/project/docs/bpmn/09-easy-bpmn-profile.md:439-441 (runtime mapping for Service/Receive/Transaction); /home/coder/project/src/bpmn/profile.ts:76-77 (DEFAULT_SERVICE_TASK_ATTEMPTS)

### Flows

Sequence-flow variants. Conditions are scoped strictly to flows leaving an exclusive/inclusive split; everything else is plain.

- Plain sequence flow — everywhere except leaving a multi-out exclusive/inclusive gateway; must connect nodes in the same scope (may not cross a transaction boundary); cycles legal
- Conditional FEEL flow — conditionExpression (tFormalExpression, parsed via feelin at publish) on every non-default out-flow of a multi-out exclusiveGateway / inclusiveGateway split; evaluated in document order
- Default flow — the gateway-owned default attribute referencing one of its own out-flows; carries no condition; taken when no condition is true

_Citations:_ /home/coder/project/docs/bpmn/09-easy-bpmn-profile.md:228-229 (sequenceFlow + exclusiveGateway condition/default rules); /home/coder/project/docs/bpmn/09-easy-bpmn-profile.md:374-378 (validation rule 5: conditions only on gateway splits, flows scoped, cycles legal); /home/coder/project/src/runtime/regions-runtime.ts:106-142 (inclusive split: per-flow FEEL eval in document order, default fallback, noPath)

### Concurrency (token frontier)

M4 multi-token machinery: fan-out, join barriers, branch-local variable overlays, merge order, and the live caps. The core M4 dimension.

- Token fan-out — at a split the DFS frontier forks one branch token per activated out-flow (document order), plain-INSERT branch tokens claim the fan-out batch (PK race)
- AND-join barrier — join satisfied once a token from EVERY branchFlowId (region.branchFlowIds) has arrived (origin-branch keyed via join_arrivals)
- OR-join activation subset — split records activated_flow_ids in gateway_decisions; join waits for exactly that recorded subset (requiredFlowsFor filters branchFlowIds to the recorded set)
- Branch-local variable overlays — each branch token carries a delta overlay over the parent scope; resolveScope layers ancestor overlays root→token, nearest wins
- Merge order — at the join overlays merge in split out-flow DOCUMENT order (region.branchFlowIds), later branch wins (mergeBranchOverlays); root region folds onto process_instances.variables, nested onto the enclosing token overlay
- Caps: MAX_CONCURRENT_TOKENS=256 — a fan-out pushing the in-memory live frontier past it → terminal concurrencyLimit (counted in-memory, never SQL COUNT)
- Caps: STEP_BUDGET_SOFT=20000 — per-drive cumulative runStep/waitForEvent count crossing it → graceful stepBudget incident (below platform ceiling)
- Caps: MAX_EVENT_PAYLOAD_BYTES=1_000_000 — join-time merged overlay exceeding it → terminal poison incident; OVERLAY_INLINE_MAX_BYTES=512KiB — branch overlays above it offload to R2

_Citations:_ /home/coder/project/src/runtime/frontier.ts:170-312 (driveFrontier: split fan-out, join barrier, leaf walk; liveTokens cap at 236-240; stepBudget at 206-210; loopLimit at 211-215); /home/coder/project/src/runtime/regions-runtime.ts:44-56 (mergeBranchOverlays document-order merge), 175-180 (requiredFlowsFor AND/OR), 194-211 (fanOutSplit), 248-251 (joinBarrierSatisfied), 273-358 (claimJoinCompletion + poison bound at 307-318); /home/coder/project/src/runtime/frontier.ts:44-61 (resolveScope nearest-wins overlay chain); /home/coder/project/src/runtime/engine.ts:158 (MAX_ELEMENT_OCCURRENCES=1000), :169 (MAX_CONCURRENT_TOKENS=256), :180 (STEP_BUDGET_SOFT=20000); /home/coder/project/src/runtime/payload.ts:7 (MAX_EVENT_PAYLOAD_BYTES=1_000_000); /home/coder/project/src/persistence/tokens.ts:129 (OVERLAY_INLINE_MAX_BYTES=512*1024, R2 offload)

### Compensation

Saga rollback semantics, redefined per causal chain (token lineage) in constitution v2.3.0 for concurrency, with straggler-catching and a quiescence barrier.

- Reverse-order per lineage — each completed compensatable step compensated in reverse completion order within its token lineage; order BETWEEN concurrent branches unconstrained (filterLineageQuiesced: a step is eligible only once its lineage has no live descendant)
- Per-occurrence (loop) compensation — each loop iteration is its own occurrence-keyed ledger row, compensated separately; compensation job inherits the forward occurrence
- Straggler ledger — a token whose forward job COMPLETED after cancel began is ledgered (INSERT OR IGNORE) + consumed; FAILED or no-job tokens discarded (ledgerStragglers)
- Quiescence barrier — settle the saga-failed terminal ONLY when the ledger is drained AND no cohort token is live; otherwise park (waiting) on per-token lease-expiry terminators
- Compensator retry exhaustion — a compensator that exhausts retries (or its wait times out) → terminal compensationFailed instance + open compensationFailure incident, operator-resumable
- Trigger only by Cancel — compensation triggered only by a transaction Cancel (error-boundary→cancel-end, or operator cancel); an uncaught Error is a Hazard, never auto-compensates

_Citations:_ /home/coder/project/src/runtime/compensation.ts:80-147 (runCompensation: resumable reverse pass, lineage-quiescence ordering, barrier at 115); /home/coder/project/src/runtime/compensation.ts:170-209 (ledgerStragglers cohort scan); /home/coder/project/src/runtime/compensation.ts:252-271 (markStepCompensationFailed → compensationFailure incident + compensationFailed status); /home/coder/project/src/runtime/compensation.ts:47-60 (beginCompensating arms cohort lease-expiry terminators); /home/coder/project/.specify/memory/constitution.md:193-213 (Principle VI: per-causal-chain ordering, multi-token completion, Hazard-no-compensation)

### Error / failure taxonomy

Error-boundary routing precedence and the complete persisted incident-kind enum (terminal vs graceful, Hazard semantics inside a transaction).

- Error-code routing precedence — exact @errorCode boundary → single catch-all (errorRef-less) → null = uncaught business error (Hazard); deterministic regardless of node-iteration order
- Hazard — an uncaught Error / technical exhaustion / noPath / loopLimit inside a transaction terminates the instance and does NOT auto-compensate (operator /cancel available)
- Incident kind: serviceTaskFailure — forward retry exhaustion or uncaught-business-error Hazard
- Incident kind: compensationFailure — a compensator exhausted its retries (accompanies compensationFailed)
- Incident kind: poison — poison-job termination (no compensation); ALSO the join-time merged-overlay-over-1MiB terminal
- Incident kind: loopLimit — element exceeded MAX_ELEMENT_OCCURRENCES=1000 visits
- Incident kind: noPath — XOR/OR split with no true condition and no default
- Incident kind: jobActivationTimeout — un-leasable forward job past its activation TTL (per-job JobScheduler DLQ)
- Incident kind: waitTimeout — an un-guarded service-task/receive-task durable-wait cap elapsed
- Incident kind: conditionFailure — hard FEEL evaluation error on an exclusive/inclusive split flow
- Incident kind: concurrencyLimit — fan-out would exceed MAX_CONCURRENT_TOKENS (terminal)
- Incident kind: stepBudget — per-drive step counter crossed STEP_BUDGET_SOFT (graceful)
- Incident kind: timeout — LEGACY (M1), retained in the enum/API for compatibility, never written by current code

_Citations:_ /home/coder/project/src/runtime/forward-task.ts:61-82 (errorBoundaryTarget: exact → catch-all → null/Hazard); /home/coder/project/src/runtime/forward-task.ts:632-639 (uncaught-business + technical-exhaustion → serviceTaskFailure Hazard); /home/coder/project/src/persistence/instances.ts:783-809 (full IncidentKind enum); /home/coder/project/src/runtime/incidents.ts:81-103 (raiseConcurrencyLimit, raiseStepBudget); /home/coder/project/src/runtime/regions-runtime.ts:307-318 (join over-1MiB → poison); /home/coder/project/specs/002-saga-orchestrator/data-model.md:451-463 (timeout split: serviceTaskFailure|compensationFailure|conditionFailure|jobActivationTimeout|waitTimeout|poison|loopLimit|noPath)

### Loops / cycles

How the rewalk/occurrence engine discriminates repeated visits of the same element and caps them.

- Occurrence discrimination — every drive re-walks from the start element; a walk-local visit counter assigns each visit a 0-based occurrence; step names + persistence keys carry it (e.g. svc-create:el#2, gw:el#1)
- Per-occurrence persistence — each re-visit gets a fresh job row / ledger row / message subscription / gateway_decisions row keyed element#occurrence; occurrence never derived from live D1 counts
- MAX_ELEMENT_OCCURRENCES=1000 — visiting an element more than this → terminal loopLimit incident (Hazard inside a transaction)
- Cycle-aware fast-forward — already-applied visits fast-forward write-free; a per-occurrence gateway_decisions row is the per-visit fast-forward predicate (visit k fast-forwards only on its own occurrence-k row)

_Citations:_ /home/coder/project/src/runtime/engine.ts:152-158 (MAX_ELEMENT_OCCURRENCES=1000 + loopLimit); /home/coder/project/src/runtime/engine.ts:426-432 (loopLimit incident raise); /home/coder/project/src/runtime/frontier.ts:186-215 (per-walk visit counter nextOcc + occ>=maxOccurrences → loopLimit); /home/coder/project/src/runtime/engine.ts:679-719 (gateway_decisions per-occurrence fast-forward predicate); /home/coder/project/docs/bpmn/09-easy-bpmn-profile.md:443 (cycles runtime mapping)

### Idempotency / correlation

At-least-once delivery handling in the Durable Object correlation broker and worker job path: every duplicate/late/early case has a deterministic outcome.

- Duplicate worker callback — job lease + lock_token guard; a completed job with output_applied=1 fast-forwards write-free, never advances twice
- Duplicate message publish — same messageId in a broker key returns the STABLE prior outcome (dedup record), never double-advances
- Late message — arriving after the subscription is gone returns the stable buffered/no-match outcome (outcome=late, not buffered)
- Early / buffered message — arriving before a subscription is buffered for a fixed 1-hour TTL, claimed at registration (earliestBuffered); at most one active subscription per broker key
- Atomic payload apply — a correlated message's payload is applied atomically with the transition out of the wait (receiveTask + message intermediate catch share the machinery)

_Citations:_ /home/coder/project/src/durable-objects/correlation-broker.ts:3-4 (uniqueness, dedup+stable duplicate response, early buffering 1h TTL, late detection); /home/coder/project/src/durable-objects/correlation-broker.ts:88-109 (earliestBuffered consume); /home/coder/project/src/durable-objects/correlation-broker.ts:149-169 (stable duplicate response via dedup); /home/coder/project/src/durable-objects/correlation-broker.ts:208 (early message → 1h buffer); /home/coder/project/src/runtime/engine.ts:24 (completed job output_applied=1 fast-forward); /home/coder/project/docs/bpmn/09-easy-bpmn-profile.md:439-440 (idempotent across retries/duplicate callbacks; atomic apply)

### Operator verbs

The two operator control actions on a running/failed instance (no Workflow internals exposed).

- cancel — POST /instances/{id}/cancel; cancels a running saga (reverse-order compensation) or, on an empty ledger / Hazard, closes all open incidents as operatorResolved and settles armed timers
- retry — POST /instances/{id}/retry; a conditional reset keyed on the current incident/failed status, re-driving from the failed element

_Citations:_ /home/coder/project/specs/002-saga-orchestrator/data-model.md:267-270 (cancel = reverse pass; retry = conditional reset on incident/failed status); /home/coder/project/specs/002-saga-orchestrator/data-model.md:465-468 (operator /cancel on empty ledger → operatorResolved + settles armed timers); /home/coder/project/docs/bpmn/09-easy-bpmn-profile.md:444 (operator cancel triggers reverse-order compensation); /home/coder/project/CLAUDE.md (Public API surface: POST /instances/{id}/cancel, /retry)

### Replay / rewalk

Determinism guarantees of the rewalk-from-start engine across Workflow suspend/resume and crash/replay — the property every other axis must hold under.

- Gateway-decision reuse — an existing gateway_decisions (instance, gateway, occurrence) row is reused verbatim on replay; conditions are NEVER re-evaluated even if variables changed (same for OR split activated_flow_ids)
- Write-free fast-forward — already-applied visits move the cursor with zero writes: a completed job (output_applied=1), a consumed subscription, a bookkeeping node whose marker history landed, a recorded join_completion
- Join/split race claims — fan-out, join_arrivals, and join_completions are plain-INSERT race claims; a losing concurrent batch aborts on the PK and re-reads the winner (fast-forward, never double-produce)
- Suspend/resume (Workflow mode) — step.do memoizes side effects by step NAME and step.waitForEvent parks for worker/message callbacks; multi-wait races a waitForEvent per collected token wait (direct-mode tests never exercise this — Workflow-only path)
- Timer self-heal — every rewalk re-arms armed timers it walks past (DO-alarm-first, step.sleep not used)

_Citations:_ /home/coder/project/src/runtime/engine.ts:34-41 (rewalk fast-forward predicate, recorded branch reused never re-evaluated); /home/coder/project/src/runtime/engine.ts:560-634 (bookkeeping visitApplied markers, one per visit, fast-forward on existence); /home/coder/project/src/runtime/regions-runtime.ts:94-96 (OR rewalk reuses recorded activatedFlowIds), :273-357 (join_completions plain-INSERT claim + fast-forward on UNIQUE loser); /home/coder/project/src/runtime/frontier.ts:328-353 (raceParkedWaits Workflow-mode multi-wait, advisory, not exercised in CI); /home/coder/project/specs/002-saga-orchestrator/data-model.md:443 (every rewalk re-arms armed timers, self-healing)
