---
id: TASK-27.3
title: >-
  M4-L3: parallelGateway AND — regions-runtime, frontier DFS driver, joins,
  branch-local vars, frontier completion
status: To Do
assignee: []
created_date: '2026-06-13 08:48'
updated_date: '2026-06-13 08:52'
labels:
  - saga
  - engine
  - m4
milestone: m-4
dependencies: []
documentation:
  - docs/superpowers/plans/2026-06-13-m4-concurrency.md
  - docs/superpowers/specs/2026-06-13-m4-concurrency-design.md
modified_files:
  - src/runtime/regions-runtime.ts
  - tests/unit/overlay-merge.test.ts
  - tests/integration/parallel-gateway.test.ts
  - src/runtime/frontier.ts
  - src/runtime/engine.ts
  - src/persistence/tokens.ts
  - src/runtime/forward-task.ts
  - tests/helpers.ts
parent_task_id: TASK-27
priority: high
ordinal: 21300
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Outcome and value

Makes a published `bpmn:parallelGateway` (AND) model execute genuine in-instance concurrency. A `fork` fans tokens down every out-flow so all branches' jobs are leasable at once (real parallelism is worker-side); the matching `join` waits for a token on every branch then produces exactly one token; branch-local variable overlays merge deterministically at the join; the instance completes only when the token frontier is empty. Builds the engine machinery the rest of M4 depends on: the deterministic depth-first re-walk reconstructing the frontier each drive, the append-only `join_arrivals`/`join_completions` claim discipline, branch-scoped variable resolution, and last-token-out completion. L4 (inclusive OR) and L5 (parallel-branch compensation) build directly on this.

This is the WHOLE L3 layer as a single task; the `L3.Y` items below are the internal work breakdown.

## Where this is specified (read first)

- Plan: `docs/superpowers/plans/2026-06-13-m4-concurrency.md`, **Phase L3 (lines 1394–1952)**. Read "How to use this plan" (13–36) and the File Structure table (39–84) first.
- Design (authoritative — **design wins** on disagreement): `docs/superpowers/specs/2026-06-13-m4-concurrency-design.md` — §5.2 (within-pass discipline / multi-wait `Promise.race`), §5.4 (splits, joins, append-only facts), §5.5 (token identity), §5.6 (instance completion / last-token-out), §5.7 (branch-local variables), §6 (nested overlay placement), §14 (testing & exit criteria / manual matrix), §17 (layer↔blocker roadmap).
- Prerequisite: **L2 must be merged first** (graph IR region map, `0007_tokens.sql`, the single-token=1-element-frontier refactor, per-token guards, drive serialization).

## Mode / scope notes that govern this layer (apply verbatim)

- **Mode note (critical, plan line 1398):** CI is `EXECUTION_MODE=direct`, where every live token drives to its park point and returns — no `Promise.race`, no suspend. Direct-mode integration tests fully exercise fan-out, join barrier, branch-local vars, merge, and completion (real parallelism is worker-side: all branches' jobs are leasable, the test drains them in any order). The **multi-wait `Promise.race`** is **workflow-mode-only** and is validated by the **manual matrix (Task L6.6 / design §14)** — it cannot run in CI. This task builds both, but only the direct-mode behaviour is asserted by `npm run test`; record the workflow-mode race path for the L6.6 manual matrix.
- **Single-token-unchanged invariant (L3.4/L3.5):** all new frontier behaviour is gated on `graph.regions` being present. A `null`/root active token keeps the exact M0–M3 path — single-token instances reduce to a 1-element frontier with no split nodes, `driveFrontier` walks one branch from root via `driveLeaf`, `completeInstance` stays byte-identical. The broad `npm run test` regression must stay green.
- **Race-claim discipline (design §5.4):** joins are claimed by a plain `INSERT` of a `join_completions` row composed into the same atomic `dbBatch` as the produced-token write + advance (the `gateway_decisions` plain-INSERT discipline, `src/persistence/gateway-decisions.ts:70-84`). A losing concurrent batch aborts wholesale on the PK and re-reads. `execution_tokens` is a read-model, never a replay input; the join facts are the truth.

## Work breakdown (Task L3.1 – L3.6)

- **L3.1** `src/runtime/regions-runtime.ts`: `mergeBranchOverlays` (deterministic merge §5.7), `fanOutSplit` (one plain-INSERT branch token per activated flow, region_activation = split occurrence), `recordJoinArrival` (INSERT OR IGNORE, idempotent), `joinBarrierSatisfied`, `claimJoinCompletion` (atomic claim §5.4). TDD via `tests/unit/overlay-merge.test.ts` first.
- **L3.2** Branch-scoped variable resolution (§5.7): `resolveScope` in `frontier.ts` (root vars + ancestor overlay chain, nearest wins); thread optional `activeTokenId` into `decideGateway` + forward-task job input/output (branch token reads resolved scope, writes output to its token overlay, not root). Null/root keeps M0–M3.
- **L3.3** The frontier DFS driver: replace the scalar `loop()` walk with a recursive DFS from `startElementId` (document order at each split) that fast-forwards applied visits, fans out at splits, records arrivals + claims completions at joins, drives/parks leaves via the existing per-node drivers (extracted into `driveLeaf`), and collects parked waits in a `WaitCollector`. Build workflow-mode `raceParkedWaits` (`Promise.race`, each wait individually try/caught so one branch timeout never rejects the race, §5.2) + keyed event matching (`matchKeyedEvent`, applied at the matching token, never positionally). Drive with the AND integration test first.
- **L3.4** Frontier-empty completion (last-token-out, §5.6): a `none` end on one branch must not complete the instance while a sibling is live; completion fires via a guarded terminal transition (`running`/`waiting` → `completed`, rows-changed decides the single emitter). Gate on `graph.regions`; single-token keeps `completeInstance` as-is.
- **L3.5** Nested regions + replay determinism: add `NESTED_PARALLEL_BPMN` (outer AND with an inner AND in branch A); assert the inner join output satisfies the enclosing branch at the outer join, and re-drive reconstructs the same frontier with stable branch token ids embedding `splitId#activation:branchFlow`.
- **L3.6** L3 layer gate; record the workflow-mode race path for the L6.6 manual matrix.

Match repo conventions: `…Stmt` builders composed into atomic `dbBatch(...)` (persist-before-advance); keys carry the walk-local occurrence. Do not paste the plan's code blocks verbatim (illustrative); follow the "Implementation notes for Step 2" caveats (drop the illustrative dynamic `import()`; for L3 implement only the AND case of `resolveActivatedFlows`/`requiredFlowsFor`, leave OR for L4; `maxConcurrent` can be a large constant until L6 wires the real cap).

## Carried design blockers

- **2** deterministic DFS · **3** region_activation = split occurrence · **4** atomic join claim · **7** origin-branch keyed · **12** token-id forms + nested frame stack.

> Note: the L3.3 DFS driver is flagged as the highest-risk task in the plan — lean on `npm run test` after every edit and use systematic-debugging if a nested case deadlocks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 L3.1 unit: npx vitest run tests/unit/overlay-merge.test.ts passes — mergeBranchOverlays unions top-level keys with the later branch (split-out-flow document order) winning a conflict, and restricts to the recorded subset for an OR join preserving stored order.
- [ ] #2 L3.1 impl: src/runtime/regions-runtime.ts provides fanOutSplit (one plain-INSERT branch token per activated flow keyed branchTokenId, region_activation=split occurrence, regionActivated/branchForked history), recordJoinArrival (INSERT OR IGNORE, idempotent), joinBarrierSatisfied, and claimJoinCompletion (plain-INSERT join_completions in the same batch as the produced-token write + advance; a losing batch aborts on the PK and re-reads).
- [ ] #3 L3.2: resolveScope layers root vars with each ancestor overlay (nearest wins); decideGateway + forward-task job input/output thread an optional activeTokenId (branch token reads resolved scope, writes output to its token overlay not root); a null/root token keeps the exact M0–M3 path; xor-gateway + saga-orchestration regression unchanged.
- [ ] #4 L3.3 (direct mode): tests/integration/parallel-gateway.test.ts passes — the AND fork makes both branch jobs leasable at once; completing one branch does not complete the instance; the join produces one token only after both arrive; the post-join task is then leasable; the instance completes; the frontier is empty; branch-local overlays merge in doc order (later branch wins, e.g. {base:1,fromA:1,fromB:1,shared:'B'}).
- [ ] #5 L3.3 driver: scalar loop() replaced by a deterministic DFS from startElementId (doc order at splits) that fast-forwards applied visits, fans out at splits, records arrivals + claims completions at joins, drives/parks leaves via existing drivers extracted into driveLeaf, collecting waits in a WaitCollector; workflow-mode raceParkedWaits (Promise.race, each wait try/caught, §5.2) + matchKeyedEvent implemented (not CI-asserted; recorded for the L6.6 manual matrix).
- [ ] #6 L3.4 (last-token-out §5.6): a none end on one branch leaves status not 'completed' while a sibling is live; completion fires via a guarded terminal transition (running/waiting→completed, rows-changed decides the single emitter); the new path is gated on graph.regions and single-token instances keep completeInstance byte-identical to M0–M3.
- [ ] #7 L3.5: NESTED_PARALLEL_BPMN (outer AND with an inner AND region in branch A) runs to completed with the inner-join output satisfying the enclosing branch at the outer join; re-drive reconstructs the same frontier with stable branch token ids embedding splitId#activation:branchFlow (e.g. ${id}:fork#0:f1, ${id}:fork#0:f2).
- [ ] #8 Single-token / M0–M3 regression: full npm run test passes — single-token instances reduce to a 1-element frontier walked from root via driveLeaf, identical to the old loop().
- [ ] #9 L3 gate: npm run typecheck && npm run test && npm run check:docs all pass; the workflow-mode race path is recorded for the L6.6 manual matrix.
<!-- AC:END -->
