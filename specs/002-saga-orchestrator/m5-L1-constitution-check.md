# M5-L1 Constitution Check (pre-implementation, against constitution v2.5.0)

**Milestone**: M5-L1 — Embedded scopes + hierarchical exceptions (the foundation layer of the M5
composition milestone: non-transaction `subProcess`, the complete generalized-scope model, scope-subtree
compensation, hierarchical error bubbling, the error end event, error/timer boundaries on scopes)
**Recorded**: 2026-07-02 (M5-L1 governance opener, Task 1)
**Constitution version checked against**: **v2.5.0** (this amendment — Principle I widened with the whole
M5 composition set up front; Principle II gains the `calledElement` version-binding clause; Principle III
gains the cross-instance idempotency clause; Principle IV additively extended with the signal broadcast
class; Principle VI generalized to scope-subtree compensation)
**Spec source**: [`docs/superpowers/specs/2026-06-20-m5-composition-design.md`](../../docs/superpowers/specs/2026-06-20-m5-composition-design.md)
(the 5-layer decomposition, adversarially hardened) §6 M5-L1 +
[`docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md`](../../docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md)
(the M5-L1 layer design, referenced below as "spec §N" — where more specific than the decomposition doc,
the layer design wins for M5-L1), and the implementation plan
[`docs/superpowers/plans/2026-07-02-m5-l1-embedded-scopes.md`](../../docs/superpowers/plans/2026-07-02-m5-l1-embedded-scopes.md).

This record satisfies the Development-Workflow gate ("Plans MUST pass the Constitution Check before Phase 0
research and again after Phase 1 design") for M5-L1. The project's operating mode since M2 is
brainstorming-design → backlog slicing rather than a full Spec Kit `plan.md`; the two design docs above
**are** the spec/plan source for M5-L1 (the same recorded deviation from `plan.md:7` that M3 and M4
documented, not laundered as precedent). Both gate checks are mapped onto that flow below.

## Two required gate checks (mapped onto the M5-L1 brainstorming-design flow)

- **Before Phase 0 (design intake):** the M5-L1 scope — embedded `subProcess`, the generalized scope
  hierarchy, scope-subtree commit/compensation/barrier semantics, hierarchical error bubbling, the error
  end event, and error/timer boundaries on scopes — was checked against constitution **v2.4.0** at intake.
  Result: the accepted set under v2.4.0 did **not** include any composition construct (Principle I's MVP
  exclusion list still named non-transaction subprocesses, `callActivity`, multi-instance/loop
  characteristics, and signal/escalation events), so the profile-widening M5-L1 runtime requires an
  amendment **first** (Principle I's "amend the constitution before widening the profile" ordering). That
  requirement is what this task (Task 1) discharges.
- **After Phase 1 (design hardening → this amendment):** re-checked against the amended **v2.5.0**. The
  amended Principle I now lists the **whole** M5 composition set as accepted-in-governance, with the M5-L1
  subset (embedded `subProcess`, scope-hosted error/timer boundaries, the error end event) opening at the
  **validator/runtime** level in this very layer, while M5-L2…L5 stay interim-rejected with a roadmap
  pointer — the **documented interim state** (constitution Principle I note + `docs/bpmn/09-easy-bpmn-
  profile.md`), not a violation, exactly the M3/M4 precedent. Result: **PASS** — see Complexity Tracking
  below for the two deliberate refinements worth recording.

## Per-principle confirmation for the M5-L1 layer

- **I. Standard BPMN Profile Only — PASS.** `bpmn:subProcess` (plain, embedded — not `triggeredByEvent`,
  not `adHocSubProcess`, no loop characteristics), the error **end** event (`endEvent` +
  `errorEventDefinition`), and error/timer `boundaryEvent`s hosted on a `subProcess`/`transaction` are all
  standard BPMN 2.0 elements/definitions, now accepted by v2.5.0 and opened at the validator in this layer
  (design §6 table). `classifyContainer` gains a second recursion branch for `bpmn:SubProcess` (design §2);
  the `ScopeKind` union is declared with the full M5 shape up front (`process | transaction | subProcess |
  callActivity | miBody`) but only the first three are producible in L1 — no premature widening of what the
  *validator* accepts. `triggeredByEvent="true"` (event subprocess), `multiInstanceLoopCharacteristics` on
  any activity, and `callActivity` stay **interim-rejected** with an M5-L4/L3/L2 roadmap pointer
  respectively (design §1 "Out", §6 table); `adHocSubProcess` and `standardLoopCharacteristics` stay
  **permanently rejected**. `compensateEventDefinition` boundary on a subProcess (compensate-as-unit) is
  explicitly **deferred post-M5** (decomposition §6 M5-L1 decision 6) — a completed subProcess's steps are
  simply rows in the enclosing transaction's ledger, not a separately compensatable unit. The
  ancestry-based compensation-reachability guard (below, under Principle VI) is a **new validator rule**,
  not a relaxation — it rejects, rather than silently accepts, a wider class of unreachable compensation
  wiring than the pre-M5 immediate-parent check did. No new MODEL-namespace notation is introduced; the
  only additive binding stays `easy-bpmn:taskDefinition`; every accepted file stays XSD-valid and
  round-trips through a standard modeler when `easy-bpmn` + DI are ignored (design §2, §6).
- **II. Immutable Definitions / Version-Bound Instances — PASS / N/A.** M5-L1 adds no migration path and no
  version mutation. The scope hierarchy (`ExecutionGraph.scopes`: kind, parent, depth) is a **static
  property of the immutable definition version**, computed at publish and persisted in `parsed_profile`
  (design §2) — later drives never recompute it from a live graph, reinforcing the immutable-version
  contract exactly as the M4 region map did. The `calledElement` version-binding clause the amendment adds
  to Principle II is **recorded now, not exercised**: M5-L1 ships no `callActivity` runtime; it lands in
  M5-L2.
- **III. Durable, Idempotent Execution — PASS.** Scope entry/exit (`scopeEntered`/`scopeExited`) are
  ordinary `runStep`-memoized bookkeeping steps, fast-forwarding write-free from a landed history event
  exactly like `enterTransaction`/commit (design §2 "Engine walk"). The commit-shield status transition
  (`committedLocal` → `committed`) is a single `dbBatch` `UPDATE` keyed by scope-id `IN`-lists, no new race
  surface (design §3.2). The straggler ledger write stays `INSERT OR IGNORE`; the reverse-cursor CAS
  (`pending`/`committedLocal` → `compensating`) widens its `IN` set but keeps the same claim discipline
  (design §3.4, §4.1). The cross-instance idempotency clause the amendment adds to Principle III (child
  create/apply, signal fan-out) is **recorded now, not exercised**: M5-L1 has no cross-instance or
  broadcast execution; it lands in M5-L2/L5.
- **IV. Correlation and Receive Task Integrity — PASS / N/A.** M5-L1 introduces no message or signal
  construct and touches no correlation path. The amendment's additive signal sub-clause is **recorded now,
  not exercised**; it lands in M5-L5. Un-guarded-wait semantics (Principle IV, M4 single-wake) are
  unaffected — a scope-hosted timer boundary uses the same `JobScheduler` DO alarm arm/disarm/fire
  machinery as an activity-hosted one (design §5.4), just with a scope node as the host.
- **V. Auditability and Operator Clarity — PASS.** Every new transition writes D1 history: `scopeEntered` /
  `scopeExited` (design §2), `transactionCancelled`/`compensationCompleted` diagnostics gain `nested`/root
  fields (design §4.3, plan Task 8), and an uncaught error end event settles the new incident kind
  `uncaughtError` (design §5.1) — added to `IncidentKind` and the openapi `Incident.kind` enum together
  when the runtime lands (not this governance commit; `check:docs` guard 7 enforces the two-way sync at
  that point). Every rejection in the §6 validator-delta table states the offending element id and reason.
  No Cloudflare Workflow internal is exposed; the M-UI console gets a history-only delta this layer (design
  §9) — no SPA change, the read-only/D1-only invariant re-affirmed.
- **VI. SAGA / Compensation Integrity — PASS (amended, and this is where M5-L1 does the load-bearing work).**
  The three §3.1 decomposition invariants land **designed-complete** in this layer, not widened
  incrementally (a confirmed review finding: incremental widening silently breaks nested-saga
  compensation — decomposition §2):
  1. **Non-terminal nested commit.** `commitTransaction` for a transaction with an enclosing transaction
     flips only its **owned** scopes to `committedLocal` (non-terminal); only the **outermost** commit
     flips a subtree to `committed` (terminal, sealed) — for a top-level single-scope transaction this is
     **byte-for-byte** today's `markScopeStepsCommittedStmt` behavior (design §3.2), preserving the M1–M4
     no-op fast path exactly.
  2. **Scope-subtree cohort and barrier.** The straggler scan and live-token barrier, previously gated on
     `isRegion` and skipped entirely outside the M4 concurrency world, are **un-gated** and run for every
     graph with subtree-membership filters (design §4.1–§4.2); for a single-scope graph `subtree(R) = {R}`
     and behavior is unchanged.
  3. **Ancestry-based compensation reachability.** The `validator.ts:1432-1439` "handler in same
     transaction" guard becomes "legal iff **some ancestor scope is a transaction**" (design §6 table,
     decomposition §3.1.3) — a chain reaching the process root with no enclosing transaction is rejected
     with element id + reason, because such a handler has no Cancel trigger. This is a **tightening**, not
     a relaxation: it still rejects everything the old immediate-parent check rejected, plus catches the
     new nested-scope case the old check could not see.
  The Hazard-vs-Cancel boundary semantics (design §3.2, §5.3) keep "compensation MUST be triggered only by
  a transaction Cancel, never an uncaught Error" **verbatim**: a non-cancel interrupting boundary on a
  scope interrupts **without** auto-compensation, its subtree's completed effects **retained** (not
  dropped, not compensated) as `pending` rows reachable by a later ancestor cancel or operator `/cancel`
  (design §5.3) — this is the concrete mechanism realizing the amendment's "operator `/cancel` walks
  exited scopes." Cancel-only-trigger, idempotent, at-least-once, and `compensationFailed` clauses are
  **unchanged**. Global `seq` becomes per-instance-monotonic (was per-`(instance, scope)`) so cross-scope
  `ORDER BY seq DESC` yields true reverse-chronological order — single-scope instances see identical
  ordering (design §3.5).

## Complexity Tracking

The M5-L1 layer generalizes the compensation substrate to a typed scope hierarchy; two design choices are
worth recording against the Development-Workflow gate as **deliberate refinements** of the decomposition
doc, made at layer-design time (design doc wins over decomposition doc where more specific, per its own
front matter).

| Refinement | What the decomposition doc said | What M5-L1 does instead | Why |
|---|---|---|---|
| **(a) `MAX_SCOPE_DEPTH` enforcement point** | Decomposition §4 lists `MAX_SCOPE_DEPTH` alongside the other three new caps without specifying whether it is a publish-time reject or a runtime incident. | **Publish-time validator reject** (element id + reason), not a runtime incident. The `scopeDepth` runtime incident named by the decomposition is deferred to **M5-L2** (spec §7). | In L1 scope depth is **fully static** — no `callActivity`, no `multiInstance` — so nesting depth is knowable in full at publish; enforcing it there is fail-closed with zero runtime surface. Depth only becomes *dynamic* (and hence needs a runtime incident) once M5-L2 introduces cross-instance call chains, where depth cannot be bounded by static analysis of one definition alone. |
| **(b) Nested cancel-end resumes the instance** | Decomposition §3.2/§4.3 describes cancel as a two-phase subtree operation and states the top-level instance-level `compensating` status and terminal guards are "unchanged" — read in isolation this could be taken to mean every cancel settles the instance terminally. | A cancel-end **inside a nested transaction** compensates only `subtree(T)` and the instance then **continues running** on the cancel boundary's failure-path target in the parent scope — a **non-terminal settle** (`settleSagaCompensated` branches on whether the compensation root has a non-null parent scope; status returns to `running`, not a terminal `compensated`/`sagaFailed`). Only a **root-level** cancel (no enclosing scope — a top-level transaction's cancel-end, or an operator `/cancel`) settles the instance terminally, exactly as M1–M4 today. (Design §4.3, refined further in plan Task 8's `settleAfterCompensation`/`settleSagaCompensated` split.) | A nested transaction's cancel boundary, by BPMN's own semantics, is a **local** failure-recovery mechanism — its single outgoing flow is a token-path node the process continues from, not a process-terminal event. Treating every nested cancel as instance-terminal would make nested transactions unable to model "try this sub-saga, and on its rollback, continue with a fallback path" — a canonical saga pattern the M5-L1 scope explicitly targets (embedded transactions). This does **not** touch Principle VI's Cancel-only-trigger / idempotent / at-least-once / `compensationFailed` clauses, which govern *how* compensation runs, not whether the *instance* terminates afterward — instance continuation after a settled compensation is an engine/control-flow concern the constitution has never constrained for the top-level case either (a transaction with a cancel boundary routing back into the process already "continues" today). |

Both refinements are **narrowings or clarifications of unspecified behavior**, not violations of an
existing constitutional guarantee — no rejected simpler alternative applies to either; they are recorded
here per the Development-Workflow gate's Complexity Tracking convention (mirroring M4's SESE-restriction
entry) because a future reader of the decomposition doc alone could otherwise reasonably expect different
behavior.

Result: **PASS** — no unresolved violation; both refinements are scope-bound clarifications made at the
layer-design level, consistent with "the design doc wins over the decomposition doc where more specific"
(M5-L1 design doc front matter).
