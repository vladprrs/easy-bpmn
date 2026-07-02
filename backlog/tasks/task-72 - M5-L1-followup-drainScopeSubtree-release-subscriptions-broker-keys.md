---
id: TASK-72
title: 'M5-L1 follow-up: drainScopeSubtree does not release active message subscriptions/broker keys'
status: To Do
assignee: []
created_date: '2026-07-02 00:00'
updated_date: '2026-07-02 00:00'
labels:
  - saga
  - engine
  - durable-objects
  - m5
  - follow-up
milestone: m-5
dependencies:
  - TASK-70
documentation:
  - docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md
priority: high
ordinal: 32800
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Follow-up from the M5-L1 final whole-branch review (PR #4) Important finding #3, reviewer-sanctioned._

`drainScopeSubtree` (the abnormal-exit / straggler drain used by error bubbling, timer fires, and cancel)
settles forward jobs and ledger rows for the drained subtree, but does **not** release any active message
subscriptions or correlation-broker keys held by `receiveTask` waits inside that subtree. This can strand
a broker key: a receive-task wait that was live when its host scope got drained keeps its subscription
registered (and the DO broker key occupied) even though the instance has moved on, until the fixed 1-hour
buffered-message TTL expires it — no correctness violation for the instance itself, but a
resource/observability leak and a latent double-delivery risk if a late message arrives before expiry.

**Fix direction:** supersede the subscription + release the broker key in the per-token settle step of
`drainScopeSubtree`, mirroring the existing M3 "fire batch" release pattern used for interrupting boundary
timers/messages (the same machinery `releaseActiveSubscriptionsForInstance` from M4-L5, TASK-52, already
does at the whole-instance level — this needs the scoped, per-token equivalent inside a subtree drain).
Also amend the M5-L1 design doc's drain semantics section to document the release as part of the drain
contract, not an afterthought.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `drainScopeSubtree`'s per-token settle releases (supersedes) any active message subscription held by a receiveTask wait inside the drained subtree
- [ ] #2 The correlation-broker key for a released subscription is freed (best-effort, matching the `releaseActiveSubscriptionsForInstance` pattern), not left to expire via the 1-hour TTL
- [ ] #3 Integration test: a receiveTask wait inside a nested scope that gets abnormally drained (timer fire or error bubbling) no longer has an active subscription afterward
- [ ] #4 `docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md` drain-semantics section amended to document subscription/broker-key release as part of the drain contract
- [ ] #5 Full suite stays green; no regression to the M3/M4 whole-instance release paths
<!-- AC:END -->
