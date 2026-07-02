---
id: TASK-71
title: 'M5-L1 follow-up: runtime re-entry backstop + validator error-end traversal edge + 09-profile modeling caveat'
status: Done
assignee: []
created_date: '2026-07-02 00:00'
updated_date: '2026-07-02 18:40'
labels:
  - saga
  - engine
  - bpmn
  - m5
  - follow-up
milestone: m-5
dependencies:
  - TASK-70
documentation:
  - docs/superpowers/plans/2026-07-02-m5-l1-embedded-scopes.md
  - docs/bpmn/09-easy-bpmn-profile.md
priority: high
ordinal: 32700
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
_Follow-up from the M5-L1 final whole-branch review (PR #4), reviewer-sanctioned._

The C1 fix (`5dd9aa9`) closed the *statically reachable* case of re-entering a scope after an abnormally
skipped occurrence (fired scope timer / nested cancel) by rejecting unguarded-flow reachability from the
abnormal boundary path back into the scope at publish time. A **residual dynamic gap** remains and is
documented as deliberate-misuse-only: a **condition-guarded loop-back** whose FEEL guard evaluates true
only after the abnormal skip is still publishable, because the validator's static BFS cannot prove a
guarded edge is unreachable — the guard could be false at publish-review time and true at runtime. If hit,
this desyncs the walk's occurrence namespace at runtime (silent corruption, not a crash).

**Design direction (reviewer-provided):** add a walk-local `skippedScopes` set (analogous to the existing
`scopeEntryOcc` map), checked at scope descend — if the scope being (re-)entered is in the set, raise a
deterministic incident instead of letting the walk silently desync. Needs an incident-kind decision
(new kind vs reuse `uncaughtError`/technical), contract (openapi) + docs (`docs/bpmn/09`,
`runtime-contracts.md`) lockstep, and integration tests exercising both host kinds (transaction + plain
subProcess).

**Two smaller companion items from the same review thread:**
1. The C1 validator's BFS doesn't model **error-END-mediated exits** of hopped-over containers — a
   *static*, addable reachability route through error-end traversal that the current walk misses (a second,
   smaller static hole, rated Minor).
2. `docs/bpmn/09-easy-bpmn-profile.md` needs the modeling guidance: "route abnormal boundary paths
   forward; guarded retry loops must only re-enter after commit."

Note: as a side effect of the C1 fix, a top-level-tx cancel loop-back now over-rejects a decorative shape
that used to be accepted — this was sanctioned in the PR discussion and does not need re-litigating here.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Decide and document the incident kind raised when the walk descends into a walk-local `skippedScopes`-flagged scope
- [x] #2 Implement the `skippedScopes` set check at scope descend, alongside `scopeEntryOcc`
- [x] #3 A condition-guarded loop-back into an abnormally-skipped scope raises the deterministic incident instead of desyncing the occurrence namespace, with an integration test for both host kinds (transaction + subProcess)
- [x] #4 Extend the C1 validator BFS to model error-END-mediated exits of hopped-over containers (the second static reachability hole)
- [x] #5 `docs/bpmn/09-easy-bpmn-profile.md` gains the modeling caveat on abnormal boundary paths and guarded retry loops
- [x] #6 openapi + `runtime-contracts.md` updated in lockstep with the new incident kind (if a new kind is chosen)
<!-- AC:END -->
