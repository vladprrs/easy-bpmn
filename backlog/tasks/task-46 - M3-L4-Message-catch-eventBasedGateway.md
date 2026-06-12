---
id: TASK-46
title: 'M3-L4: Message catch + eventBasedGateway'
status: Done
assignee: []
created_date: '2026-06-11 17:19'
updated_date: '2026-06-12 17:55'
labels:
  - saga
  - engine
  - broker
  - validator
milestone: m-3
dependencies:
  - TASK-44
documentation:
  - docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md
  - src/persistence/gateway-decisions.ts
  - src/durable-objects/correlation-broker.ts
modified_files:
  - src/runtime/event-gateway.ts
  - src/runtime/engine.ts
  - src/runtime/timers.ts
  - src/runtime/executor.ts
  - src/runtime/boundary-timer.ts
  - src/bpmn/validator.ts
  - src/bpmn/graph.ts
  - src/bpmn/profile.ts
  - src/contracts/api.ts
  - src/durable-objects/correlation-broker.ts
  - src/runtime/broker-types.ts
  - src/index.ts
  - src/persistence/instances.ts
  - scripts/check-docs.mjs
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/03-gateways.md
  - docs/bpmn/01-events.md
  - tests/integration/event-gateway.test.ts
  - tests/unit/bpmn-validator.test.ts
  - tests/unit/correlation-broker.test.ts
priority: medium
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Design §4.5 + §3 items 3–4 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). (1) Standalone intermediateCatchEvent + messageEventDefinition: receiveTask wait/correlation/resume semantics on the same subscription machinery (it is an event, not an activity — no boundary events, no taskDefinition). (2) eventBasedGateway: arrival = one D1 batch (occurrence-keyed subscription rows for every message branch, each storing the EBG visit's wait event type in the EXISTING message_subscriptions.workflow_event_type column + timer row + park), then best-effort broker registrations (DO RPC cannot ride a dbBatch — M1 registerReceive pattern; rewalk re-registers idempotently as the crash-recovery story). The race decides SOLELY on gateway_decisions via its documented contract (src/persistence/gateway-decisions.ts:70-84): plain INSERT (never OR IGNORE) composed into the same batch as the transition; loser's batch aborts wholesale and converts. NOTE: this is new concurrent-writer behavior — XOR's decideGateway is check-first with no contender; the EBG has two genuine writers (broker delivery vs fireTimer). Message-wins batch: decision INSERT + apply payload atomically + cancel timer (bookkeeping; EBG timers have NO timer_outcomes row) + supersede losing subscriptions + ebgDecision history. Timer-wins batch: decision INSERT + timer fired + supersede ALL subscriptions + timerFired + ebgDecision + transition; a losing fireTimer converts (flips its row to cancelled, no-ops). Buffered tie-break: branches registered and buffered claims evaluated in model document order — first hit wins. Delivery plumbing: the deliver path must honor the stored workflow_event_type instead of re-deriving from messageName (executor.ts:44-50; relax the profile.ts:64-75 symmetry contract for EBG subscriptions; receive-task path unchanged). Validator: EBG ≥2 outgoing flows; targets are intermediateCatchEvents (timer|message) whose only incoming flow is from this gateway; at most one timer branch (honest reason: restricted for determinism — NOT 'dead branch', false for a date+duration mix); message branches reference distinct messages (same broker key would hit the one-active-subscription invariant, correlation-broker.ts:83 — must fail at publish); instantiate=\"true\" rejected (instances start via API); eventGatewayType=\"Parallel\" rejected (M4-class). check:docs guard 5 (scripts/check-docs.mjs:139-159) flips together with DEFERRED_GATEWAY_REASONS (profile.ts:39).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 EBG races: message wins / timer wins / early-buffered message wins at registration / TWO buffered branches resolve by model-document-order tie-break; the decision is replay-stable and losing subscriptions are superseded (§7 gate 5 / exit criterion 3).
- [x] #2 Standalone message catch correlates and advances like a receiveTask, in publish-before and publish-after orders (§7 gate 9).
- [x] #3 A losing fireTimer aborts on the gateway_decisions conflict and converts; a losing message delivery does the same — both orders tested via runDurableObjectAlarm in direct mode.
- [x] #4 Validator accept/reject matrix for every EBG rule (targets, extra incoming flows, second timer branch, duplicate messages, instantiate, Parallel type) with element id + reason.
- [x] #5 Broker unit tests: supersede, buffered claims, at-most-one-active-subscription preserved; delivery honors the stored workflow_event_type (receive-task path regression green).
- [x] #6 check:docs guard 5 and DEFERRED_GATEWAY_REASONS flipped together; docs/bpmn/09 markings flipped; check:docs green.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
M3-L4 complete: standalone message intermediate catch (46a, commit 8f7dc36/bcb0373) + eventBasedGateway (46b).

**eventBasedGateway runtime** (`src/runtime/event-gateway.ts`, ~660 lines): a deterministic timer/message race deciding on a single `gateway_decisions` row claimed by a PLAIN INSERT in the same dbBatch as the transition (the M2 decider contract — but with TWO genuine concurrent writers: broker message-apply vs `fireTimer`, so the loser's batch aborts wholesale and converts). Token arrival registers every message branch + arms the timer branch in one atomic park batch (keyed by the GATEWAY's visit occurrence), then best-effort broker registration; early-buffered messages win at registration in model-document-order tie-break. Message-wins consumes the winner + supersedes losers + cancels the timer (bookkeeping flip, NO `timer_outcomes` — `gateway_decisions` is the EBG timer's sole decider); timer-wins supersedes ALL message branches. The winner advances straight to the catch's single outgoing flow (the catch is never re-dispatched). Wired into `engine.ts` dispatch and `timers.ts` `fireTimer`; a Workflow-mode lost-alarm backstop mirrors the catch path.

**Delivery path** (§4.5/R3): `executor.deliver` + the broker correlated result now honor the subscription's STORED `workflow_event_type`, so an EBG's per-visit gateway type wakes one `waitForEvent` for any branch. Byte-identical for the receiveTask/standalone-catch path (regression-green).

**Validator**: full EBG accept/reject matrix — ≥2 branches, every target a single-incoming intermediate catch (timer/message), ≤1 timer branch, distinct messages, `instantiate`/`Parallel` rejected; `next:null` IR; exempt from the implicit-split rule.

**Governance lockstep**: `check:docs` guard 5 dropped the EBG→M3 deferred-pointer requirement together with its removal from `DEFERRED_GATEWAY_REASONS`; docs/bpmn/09 moves EBG into the supported set (+rule 17) and retires the M3 interim section; 03-gateways.md / 01-events.md flipped to "shipped".

**Review**: two-stage adversarial review (spec-compliance + code-quality). Fixed: B1 (early-buffered apply split into its own memoized step so a Workflow-mode crash between broker-consume and decision-commit replays the captured event — the receive-task recv→msg pattern); operator-/cancel sweep no longer writes a `timer_outcomes` row for EBG timers; park-batch UNIQUE guard (S1); rewalk no longer re-opens a resolved branch (S2); decision fast-forward drops a pending message for the decided gateway (S3).

Tests: 9 EBG integration scenarios (message-wins, timer-wins, loser-fireTimer no-op, loser-message superseded, early-buffered, two-buffered document-order tie-break, operator-/cancel settlement, rewalk fast-forward) + the §4.5 stored-type assertion; 11 validator matrix unit tests; 1 broker unit test (stored type on correlate). Full suite 359 green; typecheck / check:docs / wrangler dry-run clean.

Commits: e7405f9 (validator) → runtime → docs → operator-cancel test → review fixes (on branch m3-time-failure-taxonomy).
<!-- SECTION:FINAL_SUMMARY:END -->
