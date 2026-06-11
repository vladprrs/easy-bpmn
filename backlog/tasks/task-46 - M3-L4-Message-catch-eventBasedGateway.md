---
id: TASK-46
title: 'M3-L4: Message catch + eventBasedGateway'
status: To Do
assignee: []
created_date: '2026-06-11 17:19'
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
priority: medium
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Design §4.5 + §3 items 3–4 (docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md). (1) Standalone intermediateCatchEvent + messageEventDefinition: receiveTask wait/correlation/resume semantics on the same subscription machinery (it is an event, not an activity — no boundary events, no taskDefinition). (2) eventBasedGateway: arrival = one D1 batch (occurrence-keyed subscription rows for every message branch, each storing the EBG visit's wait event type in the EXISTING message_subscriptions.workflow_event_type column + timer row + park), then best-effort broker registrations (DO RPC cannot ride a dbBatch — M1 registerReceive pattern; rewalk re-registers idempotently as the crash-recovery story). The race decides SOLELY on gateway_decisions via its documented contract (src/persistence/gateway-decisions.ts:70-84): plain INSERT (never OR IGNORE) composed into the same batch as the transition; loser's batch aborts wholesale and converts. NOTE: this is new concurrent-writer behavior — XOR's decideGateway is check-first with no contender; the EBG has two genuine writers (broker delivery vs fireTimer). Message-wins batch: decision INSERT + apply payload atomically + cancel timer (bookkeeping; EBG timers have NO timer_outcomes row) + supersede losing subscriptions + ebgDecision history. Timer-wins batch: decision INSERT + timer fired + supersede ALL subscriptions + timerFired + ebgDecision + transition; a losing fireTimer converts (flips its row to cancelled, no-ops). Buffered tie-break: branches registered and buffered claims evaluated in model document order — first hit wins. Delivery plumbing: the deliver path must honor the stored workflow_event_type instead of re-deriving from messageName (executor.ts:44-50; relax the profile.ts:64-75 symmetry contract for EBG subscriptions; receive-task path unchanged). Validator: EBG ≥2 outgoing flows; targets are intermediateCatchEvents (timer|message) whose only incoming flow is from this gateway; at most one timer branch (honest reason: restricted for determinism — NOT 'dead branch', false for a date+duration mix); message branches reference distinct messages (same broker key would hit the one-active-subscription invariant, correlation-broker.ts:83 — must fail at publish); instantiate=\"true\" rejected (instances start via API); eventGatewayType=\"Parallel\" rejected (M4-class). check:docs guard 5 (scripts/check-docs.mjs:139-159) flips together with DEFERRED_GATEWAY_REASONS (profile.ts:39).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 EBG races: message wins / timer wins / early-buffered message wins at registration / TWO buffered branches resolve by model-document-order tie-break; the decision is replay-stable and losing subscriptions are superseded (§7 gate 5 / exit criterion 3).
- [ ] #2 Standalone message catch correlates and advances like a receiveTask, in publish-before and publish-after orders (§7 gate 9).
- [ ] #3 A losing fireTimer aborts on the gateway_decisions conflict and converts; a losing message delivery does the same — both orders tested via runDurableObjectAlarm in direct mode.
- [ ] #4 Validator accept/reject matrix for every EBG rule (targets, extra incoming flows, second timer branch, duplicate messages, instantiate, Parallel type) with element id + reason.
- [ ] #5 Broker unit tests: supersede, buffered claims, at-most-one-active-subscription preserved; delivery honors the stored workflow_event_type (receive-task path regression green).
- [ ] #6 check:docs guard 5 and DEFERRED_GATEWAY_REASONS flipped together; docs/bpmn/09 markings flipped; check:docs green.
<!-- AC:END -->
