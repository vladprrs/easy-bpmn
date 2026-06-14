---
id: TASK-27
title: >-
  EPIC M4 — Concurrency (parallel gateway, token set, AND-join, parallel-branch
  compensation)
status: Done
assignee: []
created_date: '2026-06-08 08:18'
updated_date: '2026-06-14 08:23'
labels:
  - epic
  - saga
  - engine
milestone: m-4
dependencies: []
references:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§8 M4
  - §9
  - §5 execution_tokens stub)
  - docs/bpmn/07-execution-semantics.md
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/07-execution-semantics.md
  - docs/superpowers/plans/2026-06-13-m4-concurrency.md
  - docs/superpowers/specs/2026-06-13-m4-concurrency-design.md
priority: low
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Epic placeholder for milestone M4 (design §8) — the largest engine change. Replace the single current_element_id scalar cursor with a concurrent token set (execution_tokens table); add bpmn:parallelGateway split/join with an AND-join barrier; and make compensation correct for partially-completed parallel branches. Open decision (design §9): how to express a concurrent token set within ONE Cloudflare Workflow (parallel step.do vs child workflows) while preserving replay-safety and the ≤1 MiB event / ≤1 GB cumulative-state limits. Target semantics: docs/bpmn/07-execution-semantics.md (token lifecycle). To be sliced when M3 lands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A follow-up spec/plan slices M4 into concrete tasks before implementation.
- [x] #2 The CF-Workflows concurrency strategy (design §9) is resolved and recorded before implementation.
- [x] #3 Parallel branches run concurrently, join correctly, and a failure compensates all completed branches (per concrete task tests).
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Deferred epic. When M3 is complete: resolve the concurrency strategy (§9), spec/plan the execution_tokens model + parallel gateway + AND-join + parallel-branch compensation, then slice into tasks.
<!-- SECTION:PLAN:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-06-13 08:51
---
Sliced into 6 layer-subtasks (TASK-27.1 … TASK-27.6), mirroring the M3 TASK-38..47 per-layer model, from the approved plan `docs/superpowers/plans/2026-06-13-m4-concurrency.md` (design `docs/superpowers/specs/2026-06-13-m4-concurrency-design.md`). Linear dependency chain L1→L2→L3→L4→L5→L6; implement in order (governance first). The 35 plan Task LX.Y items are the work breakdown inside each layer-subtask.

- TASK-27.1 M4-L1 — governance 2.3.0 + profile flip + SESE region validator (publish-time only; blockers 6/13/14)
- TASK-27.2 M4-L2 — token foundation: 0007_tokens.sql, tokens persistence, root-token read-model, per-token guards, drive lock (no behaviour change; blockers 1/2/5/11)
- TASK-27.3 M4-L3 — parallelGateway AND: regions-runtime, frontier DFS driver, joins, branch-local vars, frontier completion (blockers 2/3/4/7/12)
- TASK-27.4 M4-L4 — inclusiveGateway OR: recorded activation subset, OR-join over the subset, default/noPath (blocker 7)
- TASK-27.5 M4-L5 — parallel-branch compensation: lineage-quiescence reverse, straggler ledger-insert, quiescence barrier, per-token terminators, non-eager /cancel (blockers 8/9/10)
- TASK-27.6 M4-L6 — caps, R2 overlay offload, inspection tokens, observability, docs, manual Workflow-mode matrix (DoD gate), epic closure

AC #1 (sliced) and #2 (CF-Workflows concurrency strategy resolved — one Workflow per instance + token-frontier rewalk + Promise.race over waitForEvent + R2 overlay offload, design §2/§5/§9) are satisfied by this slicing. AC #3 (runtime correctness) is delivered across L3–L5 and verified by the L6.6 manual Workflow-mode matrix.

Note: the plan mislabels the manual matrix as 'Task L6.7' in three places (lines 1398, 1820, 1951) — it is actually L6.6; L6.7 is the gate/closure task. The backlog tasks use the corrected L6.6 reference.
---

created: 2026-06-13 08:57
---
Correction (numbering): the earlier comment's TASK-27.1….6 subtasks were a mistake — M4 layers should be flat top-level tasks grouped by milestone m-4, like M3's TASK-38..47. Those 6 subtasks have been archived and recreated as flat tasks:

- TASK-48 M4-L1 — governance 2.3.0 + profile flip + SESE region validator (publish-time only; blockers 6/13/14)
- TASK-49 M4-L2 — token foundation: 0007_tokens.sql, tokens persistence, root-token read-model, per-token guards, drive lock (no behaviour change; blockers 1/2/5/11)
- TASK-50 M4-L3 — parallelGateway AND: regions-runtime, frontier DFS driver, joins, branch-local vars, frontier completion (blockers 2/3/4/7/12)
- TASK-51 M4-L4 — inclusiveGateway OR: recorded activation subset, OR-join over the subset, default/noPath (blocker 7)
- TASK-52 M4-L5 — parallel-branch compensation: lineage-quiescence reverse, straggler ledger-insert, quiescence barrier, per-token terminators, non-eager /cancel (blockers 8/9/10)
- TASK-53 M4-L6 — caps, R2 overlay offload, inspection tokens, observability, docs, manual Workflow-mode matrix (DoD gate), epic closure

Linear dependency chain TASK-48→49→50→51→52→53; implement in order (governance first). This epic (TASK-27) stays as the M4 epic; the 6 tasks reference it and share milestone m-4.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## EPIC M4 — Concurrency: SHIPPED (2026-06-14)

Block-structured in-instance concurrency for the BPMN-lite saga orchestrator, delivered across six layers (TASK-48..53) plus the TASK-54 single-wake fix, validated GREEN on real Cloudflare Workflows and merged to `main`.

**Capabilities shipped.** SESE (single-entry/single-exit) `parallelGateway` AND + `inclusiveGateway` OR regions; a deterministic token-frontier DFS engine (migration `0007_tokens.sql`: `execution_tokens`/`join_arrivals`/`join_completions`/`gateway_decisions.activated_flow_ids`/`saga_steps.token_id`); AND/OR-join barrier with branch-local variable overlays + merge; OR-join over the recorded activation subset (default/noPath); parallel-branch reverse compensation with straggler-catching + quiescence barrier + lineage-ordered reverse; concurrency caps (`MAX_CONCURRENT_TOKENS=256`→`concurrencyLimit`, `STEP_BUDGET_SOFT=20000`→`stepBudget`); R2 overlay offload past the ~1 MiB Workflows event-payload limit; inspection `tokens` array + per-token observability tags. Governance: constitution v2.3.0 (block-structured SESE) + v2.3.1 (standard-BPMN un-guarded-wait policy).

**The L6.6 blocker + its resolution (the milestone's hard lesson).** The L6.6 manual Workflow-mode matrix caught that the original multi-wait `Promise.race` over concurrent `step.waitForEvent` did NOT compose with Cloudflare Workflows' deterministic replay — AND/OR-joins hung after the 2nd branch on real CF, invisible to direct-mode CI. **TASK-54** resolved it by unifying the whole workflow-mode engine onto a single replay-stable `bpmn_wake` (leaf-park + one `step.waitForEvent` per parked pass + apply-from-D1 + contentless executor tickle; dead multi-wait machinery removed). Real-CF re-validation then caught a second regression (multi-step compensation busy-spin in workflow mode), also fixed (compensation single-wake). 

**Real-CF re-validation (Worker `f194b722`, bpmn.rntme.com, EXECUTION_MODE=workflow) — ALL GREEN:** AND-join completes (L6.6 gone); single-token M1–M3 + apply-from-D1 (receiveTask + eventBasedGateway) + conditional + timer + parallel & single-token reverse compensation all pass. WM-1/WM-6 executed on real CF; WM-2/3/4/5 (not externally forceable) covered by the now-green workflow-mode replay harnesses in CI. Full record in quickstart.md → "M4 manual Workflow-mode matrix".

**Gate.** 419 tests, typecheck, check:docs, `wrangler deploy --dry-run` all green. Single-token M0–M3 behaviour byte-unchanged (whole feature gated on `graph.regions`). Merged `m4-concurrency` → `main` (`61101c7`), pushed; Workers Builds CD redeploys from main. **Next milestone: M5 (composition).**
<!-- SECTION:FINAL_SUMMARY:END -->
