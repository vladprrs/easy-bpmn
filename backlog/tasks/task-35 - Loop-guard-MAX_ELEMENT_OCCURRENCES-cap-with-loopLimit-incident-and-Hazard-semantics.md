---
id: TASK-35
title: >-
  Loop guard: MAX_ELEMENT_OCCURRENCES cap with loopLimit incident and Hazard
  semantics
status: Done
assignee:
  - Claude
created_date: '2026-06-09 20:30'
updated_date: '2026-06-11 07:40'
labels:
  - saga
  - engine
  - runtime
  - incidents
  - tests
milestone: M2
dependencies:
  - TASK-32
references:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - src/runtime/engine.ts
  - wrangler.jsonc
documentation:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
priority: medium
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
M2 design 2026-06-09 §5 (loop guard), §2 decision 2, risk R-M2-5. With cycles legal, a modeling error or adversarial data can loop forever, burning the Workflow step budget (wrangler limits.steps 25000; ~5 steps per task iteration). Add MAX_ELEMENT_OCCURRENCES = 1000 as an engine constant: when a walk-local visit counter exceeds it, settle a terminal incident kind=loopLimit (element id + occurrence count in diagnostics). Inside a transaction this is Hazard semantics (saga design §4.5): no auto-compensation; operator POST /instances/{id}/cancel stays available to force the reverse pass. The guard counts walk-local visits, NOT lease attempts — technical retries of a single iteration must not consume the cap. Document the per-iteration step cost and the cap rationale next to the limits.steps setting.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A model looping past the cap settles a terminal incident kind=loopLimit carrying the element id and occurrence count; instance status and incident resolution are consistent with the M1 incident lifecycle.
- [x] #2 Inside a transaction the cap is a Hazard: no auto-compensation; a subsequent operator /cancel runs the reverse pass over the completed iterations (integration test).
- [x] #3 Technical retries (re-lease, fail retryable=true) of one iteration do not consume the cap — only completed-visit re-entries count.
- [x] #4 Per-iteration step cost and the 1000-visit cap rationale are documented next to the workflow limits.steps configuration (wrangler config comment or linked doc).
- [x] #5 Constitution gate: integration test for the loopLimit path; npm run test green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: subagent-driven (implementer + spec review + quality review) on branch m2-conditional-sagas. NOTE: the guard MECHANISM already landed in TASK-32 (MAX_ELEMENT_OCCURRENCES=1000 engine constant, walk-local visit counter, loopLimit incident at the top of the walk loop upstream of node dispatch) — this task owes the BEHAVIORAL CONTRACT: tests, Hazard semantics, retry-non-consumption proof, and docs.

1. Verify/adjust the guard: counts walk-local VISITS only (technical retries — re-lease, fail retryable=true — must not consume the cap: a retried iteration is the SAME visit/occurrence; pin by test); incident carries element id + occurrence count in diagnostics; terminal per the M1 incident lifecycle.
2. Hazard inside a transaction: loopLimit -> no auto-compensation; subsequent operator /cancel runs the reverse pass over completed iterations (needs the owed saga-loop fixture: compensatable step inside a transaction inside a cycle — SAGA_LOOP_BPMN in tests/helpers.ts; carried from TASK-33/36 notes).
3. Loop-cap test economics: 1000 real iterations × HTTP drains is too slow — verify whether MAX_ELEMENT_OCCURRENCES can be exercised via an injected tight gateway-only cycle (pure pass-through gateways loop without jobs; TASK-34 confirmed the guard wraps gateway visits and decision rows stay bounded) or expose the constant for a test override only if unavoidable (prefer the real constant; a gateway-only cycle of 1000 visits is fast).
4. Docs: per-iteration step cost + cap rationale next to the workflow limits config (wrangler.jsonc comment or linked doc; check whether limits.steps is even set — the map said no limits field exists; document against the platform default budget). Address the TASK-34 carry: weigh the 1000-visit cap against the Cloudflare Workflows TOTAL step budget (~2 steps/gateway visit, ~5/task iteration) and write the rationale down.
5. Poison-strikes note (carried from TASK-32): strikes are per (instance, element) across occurrences — review whether a loop should share one poison budget; document the decision (changing it is TASK-36+ scope if at all).
Constitution gate: integration test for the loopLimit path; npm run test green.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Guard mechanism found as TASK-32 left it (engine.ts: MAX_ELEMENT_OCCURRENCES=1000, walk-local visit counter, loopLimit incident at the top of the walk loop upstream of dispatch, 'incident' in TERMINAL_INSTANCE_STATUSES so a re-drive is a no-op). Diagnostics enrichment needed: incident payloadContext carried only {reason, occurrence}; now carries {elementId, occurrence, cap} (element id was already in incidents.element_id + the reason text).

SAGA_LOOP_BPMN (tests/helpers.ts) — the owed saga-loop fixture, publishes through the real validator: Tx_loop { Tx_start → reserveItem (compensation boundary → releaseItem) → GW_more [f_more `more = true` → reserveItem | f_spin `spin = true` → GW_more SELF-LOOP | f_done default → finalize] → finalize (error boundary FINALIZE_FAILED → Tx_cancel) → Tx_ok }, cancel boundary → Failed. The f_spin self-loop is the loop-guard lever: a worker output arming spin=true makes GW_more revisit itself with zero jobs, tripping the REAL cap in seconds; inert for TASK-36 (which drives f_more N times then business-fails finalize).

Tests (tests/integration/loop-limit.test.ts, 3 tests, ~15s file): AC1 injected pure-gateway self-loop (engine-harness graph) trips the cap in ~7s — incident kind=loopLimit/open, elementId+occurrence+cap in payloadContext, decision rows bounded at exactly 1000, re-drive writes nothing, /cancel with empty ledger → cancelled. AC2 SAGA_LOOP_BPMN: 2 compensatable iterations then spin → loopLimit at GW_more INSIDE the transaction; both ledger rows stranded 'pending' (no auto-compensation, zero comp jobs); /cancel → compensating → release-item jobs leased in REVERSE occurrence order (1 then 0) → compensated; incident resolution settled. AC3 LOOP_XOR_BPMN: iteration 0 of T_switch fails retryable → backoff rewind → re-lease SAME jobId (attempt 2) → completes; loop exits normally; jobs = T_charge#0(1), T_switch#0(2 attempts), T_switch#1(1); GW_retry decisions exactly 0..2; zero incidents.

AC4: wrangler.jsonc workflows block now documents the verified platform budget (10,000 steps/instance default on Workers Paid, raisable to 25,000 via limits.steps, 1,024 on Free — Cloudflare docs 2026-06-11; the design's 25,000 figure is the configurable max, not the default), per-iteration step cost (~3-5/service-task iteration, ~1-2/gateway visit), and the honest caveat: a hot multi-element cycle in workflow mode (e.g. 3 tasks + gateway ≈ 13k steps over 1000 iterations) can exhaust the 10k default before any single element trips its 1000-visit cap; remedy = set limits.steps 25000. No limits field set (no production behavior change).

Poison-strikes decision (carried from TASK-32): KEPT — serviceTaskOutputRejected strikes stay per (instance, element) ACROSS occurrences; a loop shares one poison budget (a poison-looping element should die fast, not earn POISON_THRESHOLD×1000 strikes). Documented at the strike-count site in applyForwardCompletion; per-occurrence budgets are TASK-36+ scope if ever needed.

No test-only cap override added: the gateway-only-cycle economics made the real constant fast enough (preferred path).

Two-stage review done. Spec review: compliant (fixture publishes through the real validator incl. the GW_more self-loop; Hazard asserts zero comp jobs BEFORE /cancel and reverse occurrence order after; AC3 pins exact job table + same-jobId re-lease; wrangler figures verified against live Cloudflare docs — 10,000 steps default on Workers Paid / 25,000 max via limits.steps / 1,024 Free; step.sleep excluded). Quality review: With fixes -> 6ac3763: loopLimit incident resolution assertion tightened from not-'open' to exactly 'compensating'; rewindBackoff scoped by instance_id.

GAP RECORDED (carry to TASK-36/37): incident resolution 'compensated' is an enum member that is NEVER written — /cancel sets 'compensating' and the compensation settle path never advances it. TASK-36 (touches the settle path) should either advance resolution on settle or drop the dead member; the loop-limit test pins current behavior and must be updated in lockstep. Carry to TASK-37: design doc §5/§11 still reads as if 25k is the running step budget — correct to 10k default / 25k max (the wrangler.jsonc block is already right). Test-helper dedup: leaseAndComplete/leaseOne now have 3+ per-file copies — hoist a parameterized version into tests/helpers.ts on next touch (TASK-36).

Poison decision documented at the strike site: serviceTaskOutputRejected strikes stay per (instance, element) ACROSS occurrences — a poison-looping element dies fast instead of earning POISON_THRESHOLD×1000.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Loop-guard behavioral contract delivered: loopLimit incident diagnostics enriched to {elementId, occurrence, cap}; Hazard semantics inside a transaction pinned end-to-end (no auto-compensation; operator /cancel reverse-passes the completed iterations in reverse occurrence order) via the new SAGA_LOOP_BPMN fixture (compensatable step in a transaction in a cycle, with an inert f_spin gateway self-loop as the cap lever — designed for TASK-36 reuse); technical-retry non-consumption proven (same job row/occurrence across retryable fails, attempt_count grows, no extra gateway visits, no incident); step-budget rationale documented next to the workflows config in wrangler.jsonc against the VERIFIED platform limit (10k default / 25k max via limits.steps, not the design's assumed 25k) including the multi-element-cycle caveat; poison shared-budget decision documented in-code. Tests 229/229 ×2 (3 new, all against the real 1000 constant — cap trips run in ~7s each); typecheck + check:docs + wrangler deploy --dry-run clean.
<!-- SECTION:FINAL_SUMMARY:END -->
