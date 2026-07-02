# M5 Composition — High-Level Decomposition Design

**Date:** 2026-06-20
**Status:** Approved high-level decomposition (brainstorming output), hardened by a 5-lens adversarial
review (BPMN-canonicity · Cloudflare-Workflows feasibility · compensation/idempotency/persistence ·
decomposition/governance · completeness). 49 findings raised, 24 confirmed, 25 refuted; the confirmed set
is folded in below. **This is the milestone-shaping document, not the implementation spec** — each of the
five layers below gets its own deep spec → plan → layered implementation cycle (the first being M5-L1).
**Supersedes** the single `M5 (optional) Composition` roadmap row in
[`2026-06-08-saga-orchestrator-design.md`](./2026-06-08-saga-orchestrator-design.md) §8.

**Constitution at authoring time:** v2.4.0. M5 widens the profile and therefore requires a constitution
amendment **first** (Principle I governance gate). See §5.

---

## 1. Context & goal

M0–M4 have shipped: the linear core, the canonical transaction-saga with reverse-order compensation,
conditional/FEEL branching, the time-&-failure taxonomy, and block-structured (SESE) parallel/inclusive
concurrency with a token frontier. **M5 "composition" is the last roadmap milestone**, and the goal here is
**full roadmap completion** — every composition construct from `docs/bpmn/02-activities.md`:
`callActivity`, the non-transaction `subProcess`, `multiInstance`, and `signal`/`escalation`.

These four BPMN areas are **not one cohesive feature** (unlike M3 "time & failure" or M4 "concurrency").
They have very different blast radii and depend on two new engine capabilities. So M5 is decomposed into
**five ordered layers under a single milestone**, foundation-first. The single governance amendment
(v2.5.0) accepts the whole set up front; the runtime opens per layer with interim markers in
`docs/bpmn/09`, exactly as M3 (L2–L4) and M4 (L1–L6) did (governance decision, §5).

### What stays (the substrate M5 builds on)

- **One Cloudflare Workflow per instance**, single-wake (TASK-54): leaf drivers never suspend — they park
  in D1 and the loop issues one contentless `bpmn_wake` `waitForEvent`; on tickle the engine **re-walks**
  and applies from D1. M5 reuses this verbatim, including cross-instance (parent↔child) waits.
- **D1 canonical**, rewalk/occurrence engine, the M4 token frontier + branch overlays, the per-causal-chain
  reverse-order compensation ledger, immutable version binding, at-least-once + idempotency records.
- **The single correlation broker** (1:1, `workspaceId + messageName + correlationKey`) stays the *message*
  substrate; **signal gets a separate D1-keyed 1:N broadcast substrate** and must not extend the broker
  (§4 thread E, §6 M5-L5).

### The two new engine capabilities (why ordering is foundation-first)

1. **Generalized scope** (thread A) — today `scopeId ∈ {transactionId, null}`; M5 needs a scope *with a
   kind* (`process | transaction | subProcess | callActivity | miBody`) and a *parent* (a hierarchy), with
   compensation, commit semantics, and the straggler/quiescence barrier all made **scope-subtree-aware**.
2. **Hierarchical exception propagation** (thread B) — today an error is caught only by an error boundary
   *on the throwing service task*; M5 needs an uncaught error/escalation to **bubble up the scope stack** to
   the nearest enclosing boundary (root error = Hazard; root escalation = non-fatal).

Three of the five layers depend on these, so they are **front-loaded and designed-complete in M5-L1** — not
widened incrementally (a confirmed review finding: incremental widening silently breaks nested-saga
compensation; see §3.1, §6 M5-L1).

---

## 2. The five layers (one milestone, ordered)

| Layer | Construct group | Risk | Hard dependency |
|-------|-----------------|------|-----------------|
| **M5-L1** | **Embedded scopes + hierarchical exceptions** — non-transaction `subProcess`; error/timer boundary on a `subProcess`/`transaction`; error **end** event; up-scope exception bubbling; the **complete generalized-scope model** (commit semantics per kind, scope-subtree compensation + barrier, reachability validation) | **M–L** (foundation, must be complete) | M4 frontier, M2 occurrence (have) |
| **M5-L2** | **callActivity (reusable sub-saga)** — cross-instance parent/child lifecycle, version binding, child→parent error/escalation, compensation of a committed callActivity (drive the child's reverse pass) | **XL — risk apex** | M5-L1 (exception substrate, scope model) |
| **M5-L3** | **multiInstance (data-driven fan-out)** — parallel + sequential MI on serviceTask/subProcess/callActivity; FEEL cardinality/collection; completionCondition; output aggregation; per-iteration compensation | **XL** | M4 frontier; valuable forms ⊃ M5-L1/L2 |
| **M5-L4** | **escalation + event subprocess** — escalation throw/boundary (interrupting + non-interrupting); event subprocess (`triggeredByEvent`); first throw events; first non-interrupting boundaries | **L** | M5-L1 (scope stack) |
| **M5-L5** | **signal (1:N broadcast)** — signal throw/catch; workspace-scoped broadcast on a separate D1 substrate | **L** | near-independent (own substrate) |

> **Naming note.** These were "M5.1–M5.5" in design discussion; under the chosen governance lane they are
> the five **runtime layers** of the single M5 milestone (`M5-L1 … M5-L5`), each of which subdivides
> further at spec time (e.g. M5-L2 → forward lifecycle, then child compensation). The five share the one
> v2.5.0 amendment (§5).

**Ordering rationale (confirmed sound by the review):**

1. **M5-L1 is the foundation and must be complete**, not partial. Three invariants only *bite* later
   (nesting / MI / callActivity) but **must be baked into the L1 scope migration** or they silently
   corrupt saga integrity: (a) non-terminal commit for nested transactions, (b) scope-subtree straggler
   cohort + barrier, (c) compensation-reachability ancestry check (§3.1).
2. **M5-L2 ⊃ M5-L1.** A child error/escalation propagating to the parent reuses thread B; and
   compensating a committed callActivity is a no-op unless L1 fixed the commit-terminalization trap.
3. **M5-L3 valuable forms ⊃ L1/L2.** MI-over-`subProcess` needs L1; MI-over-`callActivity` (the literal
   exit criterion "multi-instance fan-out compensates each instance") needs L2's child lifecycle.
4. **M5-L4 escalation ⊃ L1** (up-scope stack, event subprocess).
5. **M5-L5 signal is near-independent** — separate broadcast substrate — so it goes last.

---

## 3. The seven cross-cutting threads

Seven engine mechanisms M5 adds or generalizes. The first two are the substrate; the rest are
construct-local. (Thread G — operator console — was added by the review; it was missing from the original
draft.)

### A. Generalized scope

`GraphNode.scopeId` and `saga_steps.scope_id` widen from `{transactionId, null}` to a **scope with a kind**
(`process | transaction | subProcess | callActivity | miBody`) plus a **parent scope id** (a hierarchy).
The engine's scope frame becomes a stack of typed scopes (it already pushes/pops `transaction`). Commit /
complete / cancel semantics differ by kind. **This whole model lands in M5-L1**, designed-complete.

#### 3.1 Three invariants that MUST land in M5-L1 (confirmed blockers)

1. **Commit must not terminalize nested transaction scopes.** Today `markScopeStepsCommittedStmt`
   (`saga.ts:282`) flips a committed transaction's still-pending steps to the **terminal** `'committed'`
   status, permanently removing them from every future reverse pass. That is correct only while a
   transaction is top-level (M0–M4 reality). Once a transaction can nest inside a compensatable enclosing
   scope, this **silently zero-compensates** committed nested scopes when the outer scope cancels — and
   makes the M5-L2 "re-run the child's reverse pass over its retained ledger" default a **no-op**.
   *Fix:* commit shields steps only against **same-scope** re-compensation while keeping them eligible for
   an enclosing compensation root until the **outermost** root commits/completes. Either (a) keep the status
   non-terminal and make the reverse cursor **scope-subtree-aware** (select `pending|compensating|failed`
   rows whose `scope_id` is within the compensation root's subtree, `ORDER BY seq DESC` respecting
   nesting; `'committed'` demoted to "this scope's own cancel boundary won't re-fire"), or (b) add a
   compensation-root dimension and terminalize only at the outermost commit. Regression tests:
   `outer-tx > [subProcess >] inner-tx-that-commits`, then outer cancel → inner steps compensate in reverse;
   a committed callActivity whose child contained a committed transaction → the child reverse pass actually
   runs.

2. **Straggler cohort and the live-token barrier must use scope-subtree membership, not equality.** Today
   `ledgerStragglers` (`compensation.ts:190`) tests `position.scopeId === scopeId` and the barrier reads
   `listLiveTokens(instanceId)` (`compensation.ts:123`) **unfiltered** — coincident only under M4's
   single-compensatable-scope world. Under nesting / dynamic MI, a live token in a *deeper* scope is skipped
   by the scan yet still counted by the barrier (**wedge** — an operator-visible stuck saga), or a forward
   job that completes after cancel in a deeper scope is never ledgered (**leaked uncompensated effect**).
   *Fix:* (i) the cohort test becomes "the position node's scope chain contains the cancelling scope";
   (ii) the barrier's token set is **filtered to the same subtree**; (iii) cancel becomes a two-phase
   scope-subtree operation — first interrupt/drain in-flight tokens in the cancelled scope **and all
   descendant scopes** (each deeper token ledgered if its forward job completed, discarded if
   failed/non-compensatable), then run the reverse pass bottom-up. For dynamic-N MI, each iteration token's
   `miBody` scope chain must reach the cancelling root so subtree-membership catches every in-flight
   iteration. Preserve a **no-op fast path** so single-scope M1–M4 instances keep current behavior exactly.

3. **Compensation-reachability ancestry check.** When `scope_id` generalizes, do **not** relax the
   validator's "compensation handler must be in the same transaction" guard (`validator.ts:~1093`) to "any
   non-process scope." Replace the immediate-parent check with an **ancestry** check: a compensation
   boundary + `isForCompensation` handler is legal **iff some ancestor scope is a transaction**. Reject
   (element id + reason) any compensation wiring whose scope chain reaches the top-level process with no
   enclosing transaction — those handlers have **no trigger** (no Cancel reaches them; easy-bpmn adds no
   compensate-throw). For callActivity, enforce this **per-definition** on the called process at *its own*
   publish (the caller's transaction context is unknown there). Record in `docs/bpmn/09` (generalize rule
   10) and in the v2.5.0 amendment.

#### 3.2 Boundary-on-transaction: the Hazard-vs-Cancel split (M5-L1)

M3 deferred boundary timers on a `transaction` to M5; M5-L1 includes timer (and error) boundaries on a
`subProcess`/`transaction`. A **non-cancel** interrupting boundary firing on a transaction is the sharp
BPMN distinction: it **interrupts without auto-compensation** (Principle VI — no Cancel ⇒ no reverse pass)
and routes its single outgoing flow **out** of the transaction, abandoning the host exactly as rule 14
abandons a host job. The exited scope's completed compensatable `saga_steps` are **retained**, not dropped.
Operator remediation must be specified: `/cancel` must locate and compensate a scope the token has already
**exited** (walk all retained, uncompensated scopes of the instance, not only the active one) — else
effects strand. Modeling guidance: for timer-triggered rollback, route the boundary's outgoing flow to a
**cancel-end inside** the transaction; a timer routed elsewhere is Hazard-class by design. Same rule for a
non-transaction `subProcess` whose completed steps are ledgered against an enclosing transaction.

### B. Hierarchical exception propagation

An uncaught error climbs the scope stack to the nearest enclosing **error boundary**; if it reaches the
process root uncaught it is a **Hazard** (terminate, no auto-compensation — Principle VI verbatim).
**Escalation reuses the up-scope *propagation* only, not the terminal behavior**: an uncaught escalation is
**non-fatal** — an intermediate escalation throw never blocks (the token continues); an escalation end
consumes its path's token; an escalation reaching the root raises **no** terminal incident (at most a
benign diagnostic). (Confirmed: treating uncaught escalation as Hazard contradicts `01-events.md:89`.)

What *throws* a business error from inside an embedded subProcess on a non-service control path? The
canonical modeled throw is the **error end event** (`endEvent + errorEventDefinition`), currently out of
scope. **Decision (recommended): ACCEPT the error end event in M5-L1** — it pairs tightly with the
bubbling substrate; validate `errorRef` resolves to a declared `bpmn:error`, route to the nearest enclosing
error boundary, bubble to Hazard if uncaught (reusing the §4.5 `errorRef → bpmn:error/@id` matching). The
alternative (defer to M5-L4 as a "first throw event"; until then a subProcess error originates only from a
service-task `/jobs/fail`) must be stated explicitly if chosen — it cannot be left as the implicit
"subProcess ends are none-end only" exclusion.

### C. Cross-instance lifecycle (parent/child) — M5-L2, reused by M5-L3

A child = a **separate `process_instances` row + its own Workflow**, linked by
`parent_instance_id / parent_element_id / occurrence` (+ iteration index for MI-callActivity). The parent
token parks; the child's terminal transition writes D1 and tickles the parent's `bpmn_wake`; the parent
rewalk reads the child status from D1 (reuses single-wake). This is a brand-new axis (easy-bpmn has only
ever had one instance per Workflow) and is the **risk apex** — see §6 M5-L2 for the five gating decisions
(idempotent create, bounded self-heal, apply-once, child compensation, correlation key).

### D. Dynamic fan-out (MI) — M5-L3

M4 fan-out is **static** (branch flow ids known at publish, SESE region). MI fan-out is **dynamic**: N
tokens, N = FEEL cardinality / collection length at runtime. Reuses M4 branch overlays (parallel) and M2
occurrence (sequential), but the MI activity is its own **self-contained dynamic region** (not a
publish-time SESE region); the token id encodes the iteration index; the SESE validator must treat an MI
activity as a dynamic region, not reject it as an implicit split. Cardinality is bounded by a **body-aware**
cap, not a flat 256 (§6 M5-L3).

### E. Broadcast correlation (signal) — M5-L5, separate substrate

The correlation broker is structurally **1:1** (single `SUB_KEY` slot, second-subscription reject,
`markConsumed`, delete-on-deliver) and returns **exactly one** matched subscription. A keyless,
workspace-wide signal **cannot route through it**. Signal gets a **separate D1 substrate**: signal
subscriptions keyed by `(workspaceId, signalName)` with **no** per-key uniqueness/consume/delete. On a
signal throw, query the active subs and **fan out at-least-once**, each tickle individually try/caught,
reusing the existing single-wake + `MAX_WAKE_BACKSTOP` self-heal (write D1 first, tickle each parked
instance, let a dropped tickle recover on the instance's own backstop). Bound the O(N) fan-out against the
Worker per-invocation subrequest ceiling (paginate/batch; `MAX_SIGNAL_FANOUT` → incident past it). The
broker-key single-subscription invariant **explicitly does not apply** to signals.

### F. New event flavors — M5-L4/L5

First **throw** events (escalation/signal throw — intermediate throw + end), first **non-interrupting**
boundaries and the **event subprocess** (`triggeredByEvent="true"`). A non-interrupting catch **forks a
token** via the M4 frontier while the host continues. `cancelActivity="false"` is accepted **only** for
signal/escalation boundaries (timer non-interrupting and conditional boundaries stay rejected). The
**compensate-throw** (`compensateEventDefinition` on a throw/end) stays excluded — and the throw-event
whitelist must keep excluding it with an element-id + reason rejection, never silent acceptance.

### G. Operator console (M-UI) — cross-cutting, thin per-layer delta

The shipped read-only console (constitution v2.4.0) is **un-aware** of every M5 surface: instance
inspection is single-instance (no parent/child linkage), the console "saga" is a *draft lineage*
(version-collapsed), not a parent/child instance tree, and there is no surface for MI fan-out tokens,
signal/escalation events, or event subprocesses. Each layer ships a **thin console delta**: (L2)
parent/child navigation (expose `parent_instance_id/parent_element_id` on `GET /instances/{id}`) + a
cross-instance saga tree so callActivity-spanning compensation is one lineage; (L3) MI iteration/token
display; (L4/L5) escalation/signal/event-subprocess visibility. **The read-only / D1-only invariant is
preserved** — re-affirmed as a verification checkbox per layer (every new transition — child terminal, MI
iteration, escalation throw/catch, signal delivery — writes D1 history). Treat as operator-completeness, not
new write surface.

---

## 4. New engine caps (all `check:docs`-synced)

Joining the three existing caps (`MAX_ELEMENT_OCCURRENCES = 1000`, `MAX_CONCURRENT_TOKENS = 256`,
`STEP_BUDGET_SOFT = 20000`):

- **`MAX_SCOPE_DEPTH`** (M5-L1) — nesting depth of scopes (subProcess-in-subProcess).
- **`MAX_CALL_DEPTH`** (M5-L2) — callActivity nesting depth; plus static call-cycle rejection at publish.
- **`MAX_MI_CARDINALITY`** (M5-L3) — **body-aware**, *not* a flat reuse of `MAX_CONCURRENT_TOKENS`. For a
  `subProcess`/`callActivity` MI body the cap is derived from `STEP_BUDGET_SOFT` via the per-fast-forward
  step cost of the body's bookkeeping/gateway (step-costing) nodes — cost is ~quadratic in iteration count
  (composite sequential MI trips near N≈115–150; parallel fan-out near N≈200). A bare-serviceTask body is
  already bounded by `MAX_ELEMENT_OCCURRENCES`. The **highest-leverage** mitigation is to make a
  still-waiting park **step-free on rewalk** (treat an unchanged parked job/branch like an applied service
  task — skip the svc-park `runStep`), collapsing parent-wait/fan-out amplification from ~N²/2 to ~linear.
- **`MAX_SIGNAL_FANOUT`** (M5-L5) — caps the 1:N broadcast against the subrequest ceiling.

Every cap exceeded settles a **graceful, documented incident** (`scopeDepth` / `callDepth` /
`miCardinality` / reuse `concurrencyLimit`/`stepBudget` / `signalFanout`), never an opaque errored Workflow.

---

## 5. Governance plan (one cohesive amendment + layered runtime)

**Chosen lane:** M5 stays **one roadmap milestone**. **One MINOR amendment, v2.5.0**, accepts the *whole*
composition construct set up front; the runtime then ships in **interim-marked layers M5-L1…L5**, exactly as
M3 (accepted v2.2.0, opened L2–L4) and M4 (accepted v2.3.0, opened L1–L6). This is precedent-consistent
("one amendment per roadmap milestone") and consolidates the `check:docs` / `check:matrix` / caps lockstep
into a **single sync** rather than five.

> The original draft justified one-amendment-per-sub-milestone by "heterogeneity"; the review correctly
> rejected that as **unsound** (M3's accepted set was equally heterogeneous — four families — yet shipped
> under one amendment). Heterogeneity cannot distinguish M5, so the precedent-consistent single-amendment
> lane is adopted. (The alternative — relabel the five as real milestones M5–M9, then amend-per-milestone —
> was the only other defensible lane and was not chosen.)

**What v2.5.0 touches:**

- **Principle I** — accepted construct set widened with the whole composition set: non-transaction
  `subProcess`, error/timer boundary on a `subProcess`/`transaction`, error end event, `callActivity`,
  `multiInstanceLoopCharacteristics` (parallel + sequential), `escalation` throw/boundary + event
  subprocess, `signal` throw/catch, first non-interrupting boundaries. Every still-unsupported construct
  (complex gateway, conditional/link events, ad-hoc subprocess, `standardLoopCharacteristics`, top-level
  signal start, non-process `calledElement`, compensate-throw, MI standard data bindings, …) stays rejected
  with element id + reason. The no-custom-notation / XSD-valid / round-trippable clause is unchanged.
- **Principle II** — the called-definition **version binding**: `calledElement` resolves at **parent
  publish** to a concrete `definitionVersionId` (latest published version of that process in the same
  workspace), stored in the derived `parsed_profile` (runtime resolution, **not** a model mutation);
  unresolved ⇒ publish fails. A deliberate divergence from Camunda's runtime `latest` binding, for
  immutability. `camunda:calledElementBinding`/`calledElementVersion` is **tolerated-and-ignored**, not
  honored (a documented surprise).
- **Principle III** — cross-instance idempotency: child create, child output-apply, and signal fan-out are
  all at-least-once with provenance-gated single-apply (§6 M5-L2/L5).
- **Principle IV — additively extended, message invariant verbatim.** Keep "External messages MUST
  correlate by message name plus correlation key to exactly one eligible waiting process instance"
  **verbatim** (it governs messages / Receive Tasks / message intermediate-catch only). Introduce **signal**
  as a *separate* workspace-scoped broadcast class (1:N, no correlation key, broker-key single-subscription
  invariant **not applicable**) as an additive sub-clause. Mark Principle IV "additively extended — message
  invariant unchanged" in the per-principle table (mirroring how 2.4.0 listed "II–IV verbatim"). This keeps
  the bump defensibly **MINOR**.
- **Principle VI** — compensation generalized to a **scope subtree** with the §3.1 invariants
  (non-terminal nested commit, subtree cohort/barrier, reachability); the Cancel-only-trigger /
  Hazard-does-not-compensate / idempotent / at-least-once clauses are unchanged. Compensating a committed
  callActivity = the child's own reverse pass; a child `compensationFailed` surfaces as a parent
  `compensationFailed` incident.

**Each layer additionally carries:** a recorded Constitution Check (`m5-LN-constitution-check.md`), a spec
section appended to `specs/002-saga-orchestrator/spec.md` (as M4 was), its plan + layered runtime + named
test gates, `docs/bpmn` lockstep (primary `02-activities.md`; `01-events.md` for L4/L5; scope/frontier in
`07-execution-semantics.md`; the supported-set + rules in `09`), and `check:docs`/`check:matrix` growth
(M5 adds a wave of must-cover construct tags + reject scenarios to `tests/matrix/registry.ts`).

---

## 6. Per-layer scope + key decisions (`→` = recommended default)

### M5-L1 — Embedded scopes + hierarchical exceptions (foundation)

**Scope:** non-transaction `subProcess` (embedded, one none-start, ≥1 none-end, shares parent variable
scope); error boundary on a `subProcess`; timer boundary on a `subProcess`/`transaction`; error **end**
event; up-scope error bubbling; **the complete generalized-scope model** (thread A, designed-complete) with
the three §3.1 invariants and the §3.2 Hazard-vs-Cancel boundary semantics.

**Decisions:**
1. Commit semantics → **non-terminal for nested transactions** + scope-subtree-aware reverse cursor
   (§3.1.1). *Lands here, not deferred.*
2. Straggler cohort + barrier → **scope-subtree membership**, two-phase cancel (§3.1.2). *Lands here.*
3. Compensation reachability → **ancestry check**, reject unreachable handlers (§3.1.3).
4. Error end event → **ACCEPT in M5-L1** (thread B); document the alternative if deferred.
5. Boundary on a transaction → **interrupt-without-compensation, retained ledger, operator `/cancel` walks
   exited scopes** (§3.2).
6. `compensateEventDefinition` boundary on a `subProcess` (compensate the subProcess as a unit) → **DEFER**;
   in L1 a subProcess's completed steps are simply part of the enclosing transaction's ledger.
7. Event subprocess → **all in M5-L4**; L1 ships only the boundary catch.
8. `MAX_SCOPE_DEPTH` cap.

**Exit criteria / gates:** `outer-tx > subProcess > inner-tx-commits` then outer cancel compensates inner
in reverse; an error thrown in a subProcess bubbles to a scope boundary, and to Hazard at root; a timer on a
transaction interrupts without auto-compensation, steps retained, operator `/cancel` forces the reverse
pass; single-scope M1–M4 instances unchanged (no-op fast path).

### M5-L2 — callActivity (risk apex)

**Scope:** `callActivity` (`calledElement`), parent/child lifecycle (thread C), variable mapping, child
error/escalation → parent, compensation of a committed callActivity, error/compensation boundaries on the
callActivity.

**Five gating decisions (pre-implementation, not detail-later):**
1. **Child-instance idempotency triad** (create + output-apply), mirroring the service-task triad:
   (a) deterministic content-addressed child id `= hash(parentInstanceId, calledElementId, occurrence[,
   iterationIndex])` — the index is **mandatory** for MI-callActivity or all N iterations collide on one id;
   (b) a `child_instances(parent_instance_id, parent_element_id, occurrence[, iteration_index],
   child_instance_id, status)` provenance row with a UNIQUE index, written in the **same persist-before-
   advance batch** that decides to invoke the child, and that row is the **rewalk fast-forward predicate**
   gating `create()` (the analogue of `gateway_decisions` / `matched_subscription_id` / `output_applied=1`);
   (c) idempotent CF create — reuse the deterministic id as the child Workflow id and prefer **`createBatch`**
   (CF-documented idempotent) or wrap `create()` and treat "id already in use" as success; **never** auto-id.
   Do **not** rely on `runStep` memoization (direct mode and post-commit step-retry both re-run the body).
2. **Bounded sub-1h child→parent wake self-heal.** A child Workflow has **no `/jobs/activate` lease
   handshake**, so it can terminate+tickle before the parent arms its next wake — the tickle is droppable in
   the same gap as `W-AND-TICKLE-GAP-01`, and with no armed timer the parent's only recovery is the **1-hour
   `MAX_WAKE_BACKSTOP_MS`** (`wake.ts:23`) — a liveness hole that compounds per nesting level.
   → On the child terminal write, **arm a `JobScheduler`-style durable DO alarm** (the DO already owns DLQ +
   model-timer alarms, `job-scheduler.ts:30/36`) that **retries the parent tickle** until parent history
   shows the child consumed; cap total via `MAX_CALL_DEPTH × bounded-per-level`. Reconcile the
   `MAX_WAKE_BACKSTOP_MS=1h` vs "a few minutes" doc/code drift; make the child-wait path explicitly short.
3. **Child output apply-once decider** — "child terminal → apply output mapping into parent vars" is a
   once-only decider keyed by `(parentInstance, callElement, occurrence)` (`call_output_applied`), committing
   the variable merge + transition-out-of-park in **one atomic `dbBatch`**; cover the **branch-overlay vs
   root-vars** split when the callActivity sits inside an M4 parallel/inclusive region.
4. **Child compensation mechanism** — compensating a committed callActivity means driving an **already-
   terminated child Workflow into a reverse pass** (the project's untested-in-CI operator-resume-after-
   termination path). Concretely: (a) `runCompensation` dispatches on a `saga_steps` **step kind**
   `{worker-task | child-instance}` (a `kind` column or a non-null `child_instance_id`) — worker-task keeps
   `createCompensationJob`; child-instance triggers child compensation; (b) a distinct `completed →
   compensating` entry that **bypasses** the terminal guards (`compensation.ts:51`, `engine.ts:236`),
   CAS-guarded so it's idempotent on `compensating/compensated` and cannot regress a non-completed child;
   (c) the parent parks on a comp-wake satisfied by the child's terminal tickle (reuse thread C single-wake),
   re-reads child status — `compensated` → `markStepCompensated` (write-free fast-forward),
   `compensationFailed` → parent `compensationFailed` incident; (d) an empty/committed-only child ledger =
   the no-op-compensator step (resolves immediately, no parking).
5. **Child correlation key source** — `process_instances.correlation_key` is `TEXT NOT NULL`
   (`0001_mvp_schema.sql:77`) and the child is never API-started, so there is **no key source** for child
   Receive Tasks / message catches. → **v1: at parent publish, REJECT a called process that contains any
   `receiveTask`/message `intermediateCatchEvent` (element id + reason)**, deferring child correlation to a
   fast-follow (keeps the broker invariant trivially sound). Alternative (ii): inherit the parent's
   `correlation_key` into the child row **only together with** a cross-definition extension of the
   one-subscription-per-broker-key guard (calledElement is pinned to a concrete version at parent publish, so
   the child graph is statically co-validatable). Never an implicit empty-string key. Define `brokerKeyOf`
   for child instances explicitly.

**Canonicity docs (lockstep, not behavior):** io-mapping → **pass-through all variables both ways** (v1);
document it as the **Zeebe-aligned** default, diverging from OMG/Camunda-7 "no data crosses"; fix
`02-activities.md:68` ("Requires explicit in/out data mapping") which describes standard BPMN and
contradicts the chosen default; defer `easy-bpmn:ioMapping` as the later escape hatch. Reject **non-process**
`calledElement` (GlobalTask) at publish with element id + reason (don't rely on the generic "unresolved").

**Exit criteria / gates:** a reusable sub-saga commits end-to-end; a child business error propagates to the
parent's callActivity boundary; a committed callActivity compensates by driving the child's reverse pass; a
child `compensationFailed` surfaces as a parent `compensationFailed`; cold inline re-drive of the parent
does not double-start or double-apply the child; the dropped-tickle self-heal scenario reaches terminal once
within the bounded window. Reverse-path matrix scenarios: crash mid child-compensation, lost compensation
tickle, double re-entry, re-drive of a terminated child.

### M5-L3 — multiInstance

**Scope:** `multiInstanceLoopCharacteristics` parallel + sequential on serviceTask/subProcess/callActivity;
FEEL cardinality/collection; `completionCondition`; output aggregation; per-iteration compensation
(thread D).

**Decisions:**
1. parallel + sequential → **both in v1** (sequential = M2 occurrence loop; parallel = M4 overlays).
2. Cardinality source → **standard `loopCardinality` (FEEL over process vars, reusing the M2 engine)** or an
   optional `easy-bpmn:multiInstance(collection)` foreign-namespace binding — both round-trip. A **dedicated
   MI-characteristics validator check** must **REJECT** (element id + reason) any
   `multiInstanceLoopCharacteristics` carrying standard data bindings `loopDataInputRef` /
   `loopDataOutputRef` / `inputDataItem` / `outputDataItem` (these are **not** `flowElements`, so the generic
   whitelist never reaches them — silent acceptance would drop per-iteration binding, violating Principle I);
   and **REJECT** an MI with **no recognized cardinality source** (only `camunda:collection`/
   `zeebe:inputCollection`, or only `loopDataInputRef`) rather than running it zero/once. Extend the
   `09` "no silent skips" wording to cover ItemAwareElement data bindings inside loop characteristics.
3. `completionCondition` → **included.** Evaluate after each iteration completes (M2 FEEL over the merged
   per-iteration overlay). **Cancel-remaining = a NORMAL (non-compensating) frontier discard** of the N−k
   live iteration tokens (reuse `syncFrontierReadModel`'s vanish→consumed teardown, **NOT** `ledgerStragglers`
   — no spurious compensation jobs), then take the MI outgoing flow. `miBody` NORMAL completion does **not**
   mark finished iterations `committed` — they stay `pending` (scope_id = `miBody`, occurrence/token = index)
   and compensate **reverse-by-index** only if an enclosing transaction later cancels (existing reverse pass,
   zero algorithm change). Never-completed cancelled iterations owe no compensation (existing
   discard-on-no-job rule). Output aggregation collects only the k finished iterations by index.
4. **MI-callActivity** = fan-out of child instances (the literal exit criterion); reuse the M5-L2 child triad
   (with iteration index) + the body-aware `MAX_MI_CARDINALITY`.
5. Output aggregation → by index.

**Exit criteria / gates:** parallel MI over a collection runs N concurrent iterations and joins; sequential
MI loops; MI-callActivity fans out N sub-instances and compensates each; `completionCondition` fires early,
then an enclosing tx cancels → the k finished compensate reverse-by-index, the N−k ledger nothing; a
composite MI driven to the step-budget boundary settles a **graceful `stepBudget` incident** (Layer B
real-CF scenario), not an opaque errored Workflow.

### M5-L4 — escalation + event subprocess

**Scope:** escalation throw (intermediate + end), escalation boundary (interrupting + non-interrupting),
event subprocess (`triggeredByEvent="true"`); first throw events; first non-interrupting boundaries
(thread B/F).

**Decisions:**
1. Uncaught escalation → **non-fatal** (token continues / instance completes if other tokens remain; root
   escalation raises no terminal incident). Distinct from error (always-interrupting, Hazard at root).
2. `cancelActivity="false"` → accepted **only** for signal/escalation boundaries; timer non-interrupting and
   conditional boundaries stay rejected. A non-interrupting catch **forks a token** via the M4 frontier.
3. Event subprocess rules → **zero in/out sequence flow**; exactly one start event whose definition is in the
   accepted set (**error / escalation / signal / timer / message** — exclude conditional / link);
   `isInterrupting` honored (interrupting cancels the enclosing scope; non-interrupting forks via the
   frontier); reject `instantiate="true"` / top-level event subprocesses with element id + reason.
4. Preserve the **compensate-throw exclusion** now that throw events exist (element id + reason, never
   silent).

**Exit criteria / gates:** an escalation thrown in a subProcess is caught by an enclosing escalation
boundary (interrupting cancels the host; non-interrupting runs a parallel handler while the host continues);
an uncaught escalation does not terminate the instance; an error event subprocess catches a bubbled error.

### M5-L5 — signal (1:N broadcast)

**Scope:** signal throw (intermediate + end), signal catch (boundary / intermediate / event subprocess
start), workspace-scoped 1:N broadcast on the separate D1 substrate (thread E).

**Decisions:**
1. Broadcast → **workspace-scoped, keyless**, D1 substrate `(workspaceId, signalName)`; fan-out
   at-least-once + per-instance self-heal; `MAX_SIGNAL_FANOUT` cap + incident; bound against the subrequest
   ceiling.
2. Signal **start** → permitted **only** as an event-subprocess start (inside an already-started instance);
   a **top-level signal start event is REJECTED** at publish (element id + reason) — the broadcast mechanism
   deliberately has no instance-creation path (no-model-instantiation invariant). Accept/reject example pair.
3. Signal-catch branch on an `eventBasedGateway` → extend rule 17: branches must reference **distinct
   `signalRef`s** (two on one keyless broadcast would both fire — reject), and define the keyless-broadcast-
   vs-keyed-race interaction on the single `gateway_decisions` row; **or** reject signal-on-event-gateway
   with reason (since signal is the last layer, this is the simpler v1).
4. Drop the "`sendEvent` throws if target not running" framing — under contentless-tickle + D1-truth a
   momentary non-waiting target is harmless.

**Exit criteria / gates:** a signal throw in one instance is delivered at-least-once to all active signal
catches of that name in the workspace; a dropped fan-out tickle self-heals on the target's backstop; a
top-level signal start is rejected at publish; the fan-out cap settles a graceful incident.

---

## 7. Constructs explicitly addressed (accept / defer / reject) — no silent gaps

| Construct | Decision |
|-----------|----------|
| non-transaction `subProcess` (embedded) | **Accept** M5-L1 |
| error / timer boundary on `subProcess` / `transaction` | **Accept** M5-L1 (Hazard-vs-Cancel, §3.2) |
| error **end** event | **Accept** M5-L1 (recommended) |
| `compensateEventDefinition` on a subProcess (compensate-as-unit) | **Defer** (post-M5) |
| `callActivity` (process target) | **Accept** M5-L2 |
| `calledElement` → non-process (GlobalTask) | **Reject** at publish (element id + reason) |
| `camunda:calledElementBinding` / `calledElementVersion` | **Tolerated-and-ignored** (documented surprise) |
| `multiInstanceLoopCharacteristics` (parallel + sequential) | **Accept** M5-L3 |
| MI `loopDataInputRef`/`loopDataOutputRef`/`inputDataItem`/`outputDataItem` | **Reject** (dedicated MI check) |
| MI with no recognized cardinality source | **Reject** |
| `standardLoopCharacteristics` (the loop marker) | **Reject** (out of scope; distinct from M2 cycles) |
| escalation throw / boundary / event-subprocess start | **Accept** M5-L4 (non-fatal) |
| event subprocess (`triggeredByEvent`) | **Accept** M5-L4 (validator rules, §6) |
| non-interrupting boundary (`cancelActivity="false"`) | **Accept** for signal/escalation only |
| `signal` throw / catch / 1:N broadcast | **Accept** M5-L5 |
| top-level (process-level) signal **start** event | **Reject** at publish |
| `compensateEventDefinition` **throw**/end | **Reject** (preserve when throws are introduced) |
| `conditional` / `link` event definitions | **Reject** (remain out of scope) |
| `adHocSubProcess` | **Reject** (out of scope) |
| child-instance correlation key (child Receive/message catch) | **v1 reject called-process-with-message** (§6 M5-L2.5) |

---

## 8. Risks (from the adversarial review)

- **R1 — M5-L2 cross-instance lifecycle is the XL risk apex**, understated in the original draft:
  child-creation double-start (CF `create()` throws on duplicate; auto-id duplicates every rewalk), the lost
  child→parent tickle defaulting to the 1-hour backstop (compounding per nesting level), and
  committed-callActivity compensation requiring re-drive of a **terminated** child Workflow on the
  untested-in-CI (`EXECUTION_MODE=direct`) operator-resume path — these replay the project's own
  documented-fragile paths (`W-BUFFERED-STRAND`, reverse-pass busy-spin) **cross-instance**. Mitigated by the
  five §6 M5-L2 gating decisions; gate the reverse-path matrix scenarios in the e2e matrix.
- **R2 — Thread A scope generalization silently breaking saga integrity** (the §3.1 invariants): the terminal
  `'committed'` status zero-compensating nested scopes, and the single-scope cohort/barrier wedging or
  leaking under nesting/MI. **Must land correctly in M5-L1**, not be widened incrementally.
- **R3 — Fail-closed ethos eroded by silent acceptance** of unsupported standard-namespace constructs (MI
  data bindings slipping past the flow-node whitelist, top-level signal start, non-process `calledElement`,
  silently-overridden camunda binding). Each must become an explicit reject-with-element-id.
- **R4 — Step-budget exhaustion** on composite MI-over-subProcess/callActivity (~quadratic rewalk cost, trips
  near N≈115–150) and parent-wait fan-out (~N²/2, near N≈200). The body-aware cap + step-free park (§4)
  address the root; the `stepBudget` incident is the defined graceful failure mode.
- **R5 — Signal 1:N broadcast** cannot route through the 1:1 broker; the separate D1 substrate + O(N)
  fan-out bound (§3 thread E) is required.
- **R6 — Governance lockstep** — the single-amendment lane (§5) consolidates the `check:docs`/`check:matrix`/
  caps lockstep into one sync; fix the `02-activities.md:68` callActivity-io contradiction in lockstep.
- **R7 — M-UI operator story** (thread G) was silently dropped in the original draft; cross-instance / MI /
  signal / escalation flows are otherwise un-inspectable. The read-only / D1-only invariant is preservable.

---

## 9. Open decisions deferred (tracked, not dropped)

- **M5-L2 io-mapping refinement** — whether/when to add the additive `easy-bpmn:ioMapping` (selective
  propagation / isolation) escape hatch beyond v1 pass-through.
- **M5-L2 child correlation** — promoting option (ii) (inherit key + cross-definition broker-guard) from a
  fast-follow into M5-L2 proper, if real models need child Receive Tasks sooner.
- **M5-L5 signal on `eventBasedGateway`** — full rule-17 extension vs reject-until-needed.
- **Thread G console depth** — thin per-layer deltas vs a consolidated M-UI follow-on.

---

## 10. Next step

Per the brainstorming → decomposition workflow, this milestone-shaping doc is the deliverable for the
*decomposition*; the **first sub-project, M5-L1 (Embedded scopes + hierarchical exceptions)**, gets its own
deep brainstorm → `specs/002-saga-orchestrator` spec section → `writing-plans` → layered implementation,
with the v2.5.0 constitution amendment as its opening governance item. The five layers then ship in order,
each its own spec/plan/test-gate cycle under the single M5 milestone.
