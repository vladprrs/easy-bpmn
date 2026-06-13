---
id: TASK-53
title: >-
  M4-L6: Caps, R2 overlay offload, observability, inspection tokens, docs,
  manual Workflow-mode matrix, epic closure
status: To Do
assignee: []
created_date: '2026-06-13 08:56'
updated_date: '2026-06-13 12:46'
labels:
  - saga
  - engine
  - m4
milestone: m-4
dependencies:
  - TASK-52
documentation:
  - docs/superpowers/plans/2026-06-13-m4-concurrency.md
  - docs/superpowers/specs/2026-06-13-m4-concurrency-design.md
modified_files:
  - tests/integration/parallel-caps.test.ts
  - src/runtime/engine.ts
  - src/runtime/incidents.ts
  - src/runtime/frontier.ts
  - src/runtime/regions-runtime.ts
  - src/runtime/forward-task.ts
  - src/persistence/instances.ts
  - src/persistence/tokens.ts
  - src/contracts/api.ts
  - src/index.ts
  - src/env.ts
  - wrangler.jsonc
  - vitest.config.ts
  - scripts/check-docs.mjs
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - specs/002-saga-orchestrator/contracts/runtime-contracts.md
  - specs/002-saga-orchestrator/spec.md
  - specs/002-saga-orchestrator/plan.md
  - specs/002-saga-orchestrator/data-model.md
  - specs/002-saga-orchestrator/quickstart.md
  - specs/002-saga-orchestrator/m4-constitution-check.md
  - docs/bpmn/03-gateways.md
  - docs/bpmn/07-execution-semantics.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - tests/helpers.ts
  - tests/contract/api.test.ts
  - tests/contract/runtime-contracts.test.ts
priority: medium
ordinal: 21600
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Part of **EPIC TASK-27** (M4 — Concurrency), milestone `m-4`. Layer task M4-L6 (closing layer); do after M4-L5 (TASK-52)._

## M4-L6 — finalisation layer for the concurrency milestone

**Outcome / value.** The closing layer of M4 (parallel + inclusive gateways, token-frontier, joins). Forward semantics, OR-gateway, and parallel-branch compensation already shipped in L2–L5. L6 hardens the milestone for production and closes the epic: it bounds the new concurrency (so a runaway fan-out or a hot parallel×loop shape degrades into a *graceful, operator-visible incident* instead of an opaque errored Workflow), keeps large branch overlays under the Cloudflare Workflows ~1 MiB event-payload limit, makes the live token set inspectable via the public API, adds per-token observability, folds all M4 deltas into the spec/docs and the `check:docs` guard, executes the **manual Workflow-mode validation matrix** that CI structurally cannot run, and performs the governance + backlog closure.

## Plan + design references (read first)

- Plan: `docs/superpowers/plans/2026-06-13-m4-concurrency.md`, **Phase L6 (lines 2433–2683)**. Do not paste plan code; follow the cited steps per task.
- Design (authoritative — **design wins**): `docs/superpowers/specs/2026-06-13-m4-concurrency-design.md` — §9 (status lifecycle, incidents, limits), §9.1 (Cloudflare-Workflows state & event budget), §11 (API & observability deltas), §14 (testing & exit criteria), §5.2 (the within-pass discipline that makes §14 a manual gate).

## Mode / scope notes (honour the earlier layers' invariants)

- The caps are counted from the **in-memory reconstructed frontier during the rewalk, NEVER a live SQL `COUNT`** — a COUNT would fire nondeterministically on Workflow replay (design §9). `MAX_CONCURRENT_TOKENS` is checked at split fan-out; `STEP_BUDGET_SOFT` is a per-drive cumulative `runStep`/`waitForEvent` counter checked below the platform step ceiling.
- **CI cannot test the multi-wait race.** Tests run `EXECUTION_MODE=direct`; the multi-wait `Promise.race`, suspend/resume across splits, the step-budget counter, and the within-`run()` step-name dedup live **only in workflow mode** (design §5.2). That is exactly why Task L6.6 exists.
- The whole concurrency feature is **gated on `graph.regions`** — a single-token (no parallel/inclusive) instance must behave identically to pre-M4. Anything L6 adds (tokens array, history tags, caps) must keep the single-token path unchanged.

**The L6.6 manual matrix is a blocking Definition-of-Done gate, NOT CI (verbatim, design §14):** "The multi-wait `Promise.race`, suspend/resume across splits, step-budget, and the within-`run()` step-name dedup live **only in workflow mode** and cannot run under `EXECUTION_MODE=direct`. Run them by hand against `wrangler dev` (or a deployed instance) and record the outcomes in `quickstart.md`. **Do not close the epic until all six pass.**"

## Work breakdown (constituent Task L6.Y items)

- **L6.1** `MAX_CONCURRENT_TOKENS` (256) + `STEP_BUDGET_SOFT` (20000) constants in `engine.ts`, the per-drive budget counter, fan-out cap wiring (with a documented *test-only* env override so the bomb fixture can trip the cap without 256 real branches), the two new incident kinds `concurrencyLimit`/`stepBudget` single-sourced into `IncidentKind` + openapi enum + api doc, and `check:docs` guard #6 generalised to constant-sync all three constants.
- **L6.2** R2 overlay offload: `OVERLAYS` R2 binding + `workflows.limits.steps = 25000` in `wrangler.jsonc`, `Env` type, `OVERLAY_INLINE_MAX_BYTES` write/read helpers in `tokens.ts` (deterministic R2 key, written before the D1 commit so crash-retry is byte-identical), threaded through the overlay write/read call sites; plus the join-time `MAX_EVENT_PAYLOAD_BYTES` bound in `claimJoinCompletion` routing an oversized merged overlay to the existing `serviceTaskOutputRejected`/`poison` incident path — never a silent truncation (§9.1).
- **L6.3** Inspection `tokens` array: `tokenInspectionSchema` + `ProcessInstanceInspection.tokens` in `api.ts`, `handleGetInstance` reads `listTokens` and maps `{tokenId, positionElementId, status, regionId, regionActivation, branchFlowId, parentTokenId}` (large overlays by R2 reference), sets `currentElementId` to `null` when >1 live token, + the openapi schema delta and a contract test (§11).
- **L6.4** Per-token observability: verify the L3/L4 history event types (`regionActivated`, `branchForked`, `branchArrivedAtJoin`, `joinCompleted`) are emitted, and tag every in-region history event with `tokenId`/`regionId`/`regionActivation`/`spanId` in the `diagnostics` JSON (no new column).
- **L6.5** Spec/docs finalisation: fold the M4 deltas into `specs/002-saga-orchestrator/{spec.md, plan.md, data-model.md, contracts/runtime-contracts.md, quickstart.md}` (token tables, tokens array, new incident kinds, AND/OR/compensation quickstart scenarios), and finalise `docs/bpmn/{03-gateways.md, 07-execution-semantics.md, 09-easy-bpmn-profile.md}`; cited constant literals must match `engine.ts`.
- **L6.6** Manual Workflow-mode validation matrix (the blocking DoD gate above): bring up `wrangler dev` in workflow mode (apply local D1 migrations first) and execute the six §14 scenarios, recording PASS/FAIL + evidence under an "M4 manual Workflow-mode matrix" heading in `quickstart.md`.
- **L6.7** L6 gate + epic closure: full verification gate, confirm the After-Phase-1 constitution gate vs v2.3.0, drive the Backlog.md MCP closure of the M4 milestone + L1–L6 tasks with the manual-matrix as DoD evidence, finish the `m4-concurrency` branch via the finishing-a-development-branch sub-skill (PR body summarises the six layers, links the design doc, notes the manual-matrix evidence).

## Carried design blockers

- none (caps, observability, docs, manual matrix, closure).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 L6.1: tests/integration/parallel-caps.test.ts passes — a fan-out exceeding MAX_CONCURRENT_TOKENS (CONCURRENCY_BOMB_BPMN against a documented test-only cap override) settles a terminal concurrencyLimit incident; crossing STEP_BUDGET_SOFT settles a graceful stepBudget incident below the platform ceiling.
- [ ] #2 L6.1: MAX_CONCURRENT_TOKENS=256 and STEP_BUDGET_SOFT=20000 defined in engine.ts, counted from the in-memory reconstructed frontier (never a SQL COUNT); IncidentKind gains exactly concurrencyLimit+stepBudget and equals the openapi Incident.kind enum (check:docs guard #7); api.ts doc mentions both; check-docs guard #6 constant-syncs all three constants between engine.ts and docs/bpmn + specs/002.
- [ ] #3 L6.2: wrangler.jsonc declares workflows[0].limits.steps=25000 + an OVERLAYS R2 binding; Env has OVERLAYS: R2Bucket; npx wrangler deploy --dry-run passes; overlays > OVERLAY_INLINE_MAX_BYTES are stored in R2 under deterministic key overlays/${id}/${tokenId}.json (written before the D1 commit) with the column holding {"__r2":"<key>"}, small overlays inline, reads transparently rehydrate.
- [ ] #4 L6.2: claimJoinCompletion checks payloadByteSize(mergedOverlay) ≤ MAX_EVENT_PAYLOAD_BYTES before writing/delivering and on exceed raises the existing serviceTaskOutputRejected/poison incident (never a silent truncation); parallel-gateway.test.ts still passes.
- [ ] #5 L6.3: GET /instances/{id} returns a tokens array of {tokenId, positionElementId, status, regionId, regionActivation, branchFlowId, parentTokenId} (large overlays by R2 reference) and currentElementId is null while >1 token is live; a contract test asserts this; the openapi inspection schema is updated; npm run test:contract passes.
- [ ] #6 L6.4: a parallel run's history contains regionActivated, branchForked, branchArrivedAtJoin and joinCompleted events (asserted in parallel-gateway.test.ts), and every in-region history event carries tokenId/regionId/regionActivation/spanId in its diagnostics JSON with no new column.
- [ ] #7 L6.5: specs/002-saga-orchestrator/{spec,plan,data-model,contracts/runtime-contracts,quickstart}.md carry the M4 deltas (token tables, tokens array, two new incident kinds, AND/OR/compensation quickstart scenarios); docs/bpmn/{03,07,09} flip parallel/inclusive to shipped; npm run check:docs passes with cited constant literals matching engine.ts.
- [ ] #8 L6.6 (blocking DoD gate, NOT CI): the six §14 manual Workflow-mode scenarios (parallel message catches; crash-restart mid-race; near-simultaneous deliver+replay; one branch times out while sibling live; in-region loops near budget ⇒ graceful incident not an opaque errored Workflow; cancel a region with parked + in-flight stragglers) are run against wrangler dev (workflow mode, local D1 applied) and recorded PASS with evidence under an 'M4 manual Workflow-mode matrix' heading in quickstart.md.
- [ ] #9 L6.7: the After-Phase-1 constitution gate in m4-constitution-check.md is satisfied vs v2.3.0 with each constitution-critical behaviour ticked (SESE validation, immutable version binding, Service Task contract, Receive Task correlation, idempotency/retry, audit history, operator-visible errors); the Backlog M4 milestone + L1–L6 tasks are closed with the manual-matrix as DoD evidence; the m4-concurrency branch is finished (PR) via finishing-a-development-branch.
- [ ] #10 L6 gate: npm run typecheck && npm run test && npm run check:docs && npx wrangler deploy --dry-run all pass.
<!-- AC:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: claude
created: 2026-06-13 12:46
---
**L3 adversarial-review carry-overs (deferred to L6).** The L3 review (TASK-50) confirmed and fixed three direct-mode bugs in `179f7aa` (branch-scoped `applyMessage`, match-keyed receive routing, `claimJoinCompletion` PK-race). Three findings were deferred here:

1. **`applyEbgMessage` not branch-scoped** (event-gateway.ts, see the in-code `M4-L3 review DEFERRED` comment near the merge): an `eventBasedGateway` whose MESSAGE branch wins INSIDE a parallel branch still merges its payload to root `process_instances.variables` instead of the branch token overlay. EBG-in-region is exotic/untested. Fix mirrors `applyForwardCompletion`/`applyMessage`: thread `activeTokenId` through `driveEventBasedGateway` → `applyEbgMessage`, branch-scope the write. Needs an EBG-in-branch fixture.
2. **`matchKeyedEvent` discards the winning `tokenId`** (frontier.ts): the workflow-mode re-walk applies the raced event positionally, not at the winning token. Mitigated for distinct message names by the L3 messageName guard (the validator rejects same-name-in-two-branches), but full origin-branch keying is workflow-mode-only — already covered by the L6.6 manual matrix scenarios 1 & 3.
3. **Workflow-mode multi-wait timeout re-loop** (engine.ts loop): if `raceParkedWaits` times out with all branches still parked, the loop re-walks/re-races with no circuit breaker (direct mode parks instead, so CI is unaffected). Single-token M3 raised a `waitTimeout` incident; the multi-wait path does not. Covered by L6.6 manual-matrix scenario 4 (one branch times out while a sibling is live) — wire a graceful incident/escape there.
---
<!-- COMMENTS:END -->
