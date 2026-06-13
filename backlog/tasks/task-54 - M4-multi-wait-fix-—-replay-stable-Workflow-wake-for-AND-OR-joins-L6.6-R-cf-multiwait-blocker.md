---
id: TASK-54
title: >-
  M4 multi-wait fix — replay-stable Workflow wake for AND/OR joins (L6.6
  R-cf-multiwait blocker)
status: To Do
assignee:
  - claude
created_date: '2026-06-13 20:00'
labels:
  - saga
  - engine
  - m4
  - bug
milestone: m-4
dependencies:
  - TASK-53
documentation:
  - specs/002-saga-orchestrator/quickstart.md
  - docs/superpowers/specs/2026-06-13-m4-concurrency-design.md
priority: high
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## BLOCKING DEFECT found by the L6.6 manual Workflow-mode matrix (2026-06-13)

The M4 **workflow-mode multi-wait does NOT work on real Cloudflare Workflows.** A `parallelGateway`/`inclusiveGateway` AND/OR-join **hangs after the SECOND branch completes** — the surviving branch's job-completion `sendEvent` never resumes the suspended Workflow, so the join never fires and the instance is stuck `running` (the only backstop is the 1-hour `SVC_WAIT_TIMEOUT`). This blocks closing the M4 epic (TASK-53 AC #8/#9). **Single-token M0–M3 flows are unaffected** (M4 is gated on `graph.regions`).

### Evidence (real CF + local — identical, so NOT a miniflare artifact)
- Validated on `bpmn.rntme.com`, Worker Version `1993c802-bf27-4b16-bd29-82d0159b4982` (the M4 branch; remote D1 `0007` applied, R2 enabled), and under local `wrangler dev` (`EXECUTION_MODE=workflow`).
- **AND-join (`PARALLEL_BPMN`): FAIL** on both. Instance `pi_abd7ca7f-…`: history ends `serviceTaskCompleted(B) → branchArrivedAtJoin(B) → jobCompleted(A)` with **no** `serviceTaskCompleted(A)`; token `…:fork#0:f1` left `active` at `A`.
- **Sequential `Start→A→B→End`: PASS** on both → isolates the defect to the multi-wait (not general workflow-mode resume).
- Direct-mode CI (413 tests, incl. the AND/OR-join join LOGIC) is green — the defect is purely the workflow-mode wake mechanism, which CI (`EXECUTION_MODE=direct`) structurally cannot reach.

### Root cause (high confidence)
Cloudflare Workflows re-invokes `run()` from the top on each event (deterministic replay; memoizes `step.do`/`step.waitForEvent` by name). The token-frontier rewalk (`runInstance` → `driveFrontier` → `raceParkedWaits` in `src/runtime/frontier.ts`/`engine.ts`) issues **a different set of `step.waitForEvent` calls on each re-invocation**: when one branch's job completes it shifts from a `step.waitForEvent` to a `step.do` apply, so the per-replay step sequence diverges (inv#1: `waitForEvent(A)`+`waitForEvent(B)`; inv#2: `step.do(svc-apply:B)`+`waitForEvent(A)`). A `Promise.race` over multiple concurrent `step.waitForEvent` does not compose with Cloudflare's one-suspension-point-at-a-time replay model → the surviving branch's `sendEvent` is never matched. This is the **R-cf-multiwait** risk flagged in the design (§5.2, decision 3) — confirmed real.

### Fix direction (re-opens the L3 engine; needs brainstorm → impl → real-CF re-validation)
Replace the per-branch `Promise.race` with a **replay-stable single per-instance `step.waitForEvent`** on one stable event type: every `/jobs/complete`, message, and timer `sendEvent`s THAT type; on each wake the engine re-walks and reconciles against canonical D1 (the "advisory winner, D1 is the truth" philosophy already in §5.2). This keeps the `step.*` sequence identical across replays regardless of which branches have completed. The direct-mode join logic (quickstart Scenarios 27–30 + 413 CI tests) is the regression net. Re-validate by re-running the L6.6 matrix on real CF until the substrate AND-join goes green and WM-1..WM-6 pass.

### Current prod state (operator decision 2026-06-13)
`bpmn.rntme.com` is LEFT on the broken-concurrency M4 (Version `1993c802…`) — pre-revenue, no users, single-token works. Prior M3 is one `wrangler rollback` away. See `specs/002-saga-orchestrator/quickstart.md` → "M4 manual Workflow-mode matrix" for the full record.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The workflow-mode multi-wait presents a replay-stable step sequence across Cloudflare run() re-invocations (a completing branch does not change the set/order of step.waitForEvent calls)
- [ ] #2 On real Cloudflare Workflows, an AND-join (PARALLEL_BPMN) completes after both branches finish in any order — the substrate probe goes green
- [ ] #3 The six L6.6 matrix scenarios (WM-1..WM-6) pass on real CF with recorded evidence in quickstart.md
- [ ] #4 Direct-mode CI stays green (the AND/OR-join logic + all 413 tests), single-token M0–M3 behaviour unchanged
- [ ] #5 After validation: M4 epic (TASK-53) closure unblocked (AC #8/#9), prod re-deployed with the fix
<!-- AC:END -->
