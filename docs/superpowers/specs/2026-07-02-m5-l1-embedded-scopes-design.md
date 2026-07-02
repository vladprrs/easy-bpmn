# M5-L1 — Embedded Scopes + Hierarchical Exceptions: Design

**Date:** 2026-07-02
**Status:** Approved design (brainstorming output). Implements layer M5-L1 of
[`2026-06-20-m5-composition-design.md`](./2026-06-20-m5-composition-design.md) (§6 M5-L1); the layer
decisions recorded there are refined here into implementable semantics. Where this document is more
specific than the decomposition doc, this document wins for M5-L1.
**Constitution at authoring time:** v2.4.0. The **v2.5.0 amendment** (the single MINOR amendment
accepting the whole M5 composition set, per decomposition §5) is the **opening governance item of this
cycle** — it lands before any runtime change, together with `m5-L1-constitution-check.md`.

All `file:line` anchors below were verified against branch `m5-composition-design` on 2026-07-02.

---

## 1. Scope of this layer

**In:**

- Plain embedded **non-transaction `subProcess`** (one none-start, ≥1 end, shares the parent variable
  space; arbitrary nesting: subProcess-in-tx, tx-in-subProcess, tx-in-tx).
- The **complete generalized-scope model** (decomposition thread A): typed scope hierarchy in the
  compiled graph, scope-subtree-aware commit/compensation/straggler/barrier semantics — the three §3.1
  invariants land here, designed-complete.
- **Hierarchical error propagation** (thread B): an uncaught error climbs the scope stack; Hazard at
  root (Principle VI verbatim — no auto-compensation).
- **Error end event** (`endEvent` + `errorEventDefinition`) — accepted (decomposition §6 M5-L1
  decision 4, recommended lane taken).
- **Error and timer boundaries on a `subProcess`/`transaction`**, with the §3.2 Hazard-vs-Cancel
  semantics: a non-cancel interrupting boundary interrupts **without** compensation, ledger retained.
- **`MAX_SCOPE_DEPTH`** cap (publish-time in L1, see §7).

**Out (explicit, with interim validator rejects where applicable):**

- Event subprocess (`triggeredByEvent="true"`) → M5-L4 (interim reject with roadmap pointer).
- `multiInstanceLoopCharacteristics` on any activity → M5-L3 (interim reject).
- `callActivity` → M5-L2 (stays in the whitelist reject).
- `compensateEventDefinition` boundary on a subProcess (compensate-as-unit) → post-M5 (decomposition
  §6 M5-L1 decision 6): in L1 a subProcess's completed steps are simply rows in the enclosing
  transaction's ledger.
- Escalation, signal, non-interrupting boundaries → M5-L4/L5.
- Console UI changes → thread G deltas start at M5-L2; L1 ships only the new history events (§9).

---

## 2. Scope model & graph compilation

The scope hierarchy is a **static property of the immutable definition version**, so it lives in the
compiled graph, not in D1.

- `classifyContainer` (`src/bpmn/validator.ts:381-743`) — today it recurses only for
  `bpmn:Transaction` (`:450-461`) — gains a second recursion branch for plain `bpmn:SubProcess`
  (not `triggeredByEvent`, not `adHocSubProcess`, no loop characteristics). The `scopeKind` union
  (`:384`) widens from `"process" | "transaction"` to `"process" | "transaction" | "subProcess"`.
  The `ScopeKind` *type* is declared with the full M5 union
  (`process | transaction | subProcess | callActivity | miBody`) so L2/L3 extend without churn, but
  only the first three are producible in L1.
- The compiled graph gains
  `ExecutionGraph.scopes: Record<string, { id, kind, parentId: string | null, depth: number }>` —
  one entry per non-process scope; `parentId: null` means the process root. `GraphNode.scopeId`
  (`src/bpmn/graph.ts:136`) keeps its current meaning — the **immediate** enclosing scope id, `null`
  at process level (`validator.ts:1548` unchanged).
- All hierarchy queries are computed in JS from this map and passed to SQL as `IN` lists (scope
  counts are tiny, bounded by `MAX_SCOPE_DEPTH` × model breadth):
  - `subtree(R)` — every scope whose parent chain contains R, **including R**. For R = process root:
    all scopes plus the `null` process level.
  - `nearestEnclosingTx(s)` — walk the parent chain from s **inclusive**; first `kind ===
    "transaction"`; `null` if the chain reaches the root without one.
  - `ownedScopes(T)` (T a transaction) — T plus descendant scopes reachable from T **without passing
    through another transaction**. By construction, `nearestEnclosingTx(s) === T` for every
    `s ∈ ownedScopes(T)`.
  - `strictAncestor(a, b)` — a is on b's parent chain and `a !== b`. The process root is a strict
    ancestor of every scope.
- `isTransactionScope` (`src/runtime/engine-shared.ts:37-39`) generalizes to a `scopes`-map lookup;
  the flow-crossing rule (`validator.ts:789-796`) and the per-scope structural checks (exactly one
  none-start `:857`, ≥1 end `:860`) already key on scope ids and extend to subProcess scopes as-is.

### Engine walk

`driveLeaf` (`src/runtime/engine.ts:325-424`) treats a subProcess node as a bookkeeping scope-entry,
mirroring the transaction steps:

- subProcess node → `runStep("scope:${tag}", enterScope)` → returns the inner start id. `enterScope`
  writes a `scopeEntered` history event (payload: scopeId, kind, occurrence) + transition — the
  analogue of `enterTransaction` (`engine.ts:653-662`).
- inner none-end of a subProcess → `runStep("scope-end:${tag}", exitScope)` → writes `scopeExited`
  and returns the subProcess node's outer `.next`. **No ledger mutation** — completing a subProcess
  neither commits nor seals anything; its steps remain `pending` rows of their scopes, part of
  whatever enclosing transaction's ledger they belong to.
- Fast-forward: `visitApplied` on the history event per occurrence, exactly the transaction pattern
  (the count-vs-existence caveat at `engine.ts:609-611` applies unchanged).
- Occurrence assignment, `MAX_ELEMENT_OCCURRENCES`, and step-name tagging (`scope:el#k`) reuse the
  M2 walk-local counter verbatim.

---

## 3. Saga ledger: the commit shield and sealing

### 3.1 The invariant

> A ledger row is **sealed forever only when the outermost transaction enclosing its committing
> transaction commits**. Until then, a locally-committed row remains eligible for exactly the
> compensation roots that are **strict ancestors of its committing transaction** — and for no other
> root, including later occurrences of the same static scope.

Why row-scope ancestry alone is insufficient (the counterexample that forced the two-tier status):
let transaction T contain subProcess S, with T re-entered by an M2 cycle. T#occ0 commits; a
subtree-wide flip marks both T's and S's rows `committed`. T#occ1 later cancels (root R = T). A
row-scope test "`committed` eligible iff R is a strict ancestor of the row's scope" yields
`strictAncestor(T, S) = true` — occ0's sealed S-rows would wrongly re-compensate. Symmetrically, an
operator `/cancel` (root = process) would capture rows of long-committed **top-level** transactions,
contradicting the correct current semantics. The shield must therefore know the **committing
transaction**, and sealing must happen only at the **outermost** commit. Both are derivable without
schema changes: `nearestEnclosingTx(row.scope_id)` is static, and "outermost" is a property of the
committing transaction's own scope chain.

### 3.2 Status model

`CompensationStatus` (`src/persistence/saga.ts:11-19`) gains one value — **`committedLocal`**
(non-terminal). `committed` keeps its current meaning (terminal, sealed). No D1 migration: the
column is TEXT.

- **Nested commit** — `commitTransaction` (`engine.ts:664-679`) for a transaction T with
  `nearestEnclosingTx(parent(T)) !== null`:
  `UPDATE saga_steps SET compensation_status='committedLocal' WHERE instance_id=? AND scope_id IN
  ownedScopes(T) AND compensation_status IN ('pending','compensating')`.
  (Deeper transactions inside T flipped their own owned rows when they committed.)
- **Outermost commit** — T with no enclosing transaction:
  `... SET compensation_status='committed' WHERE scope_id IN subtree(T) AND compensation_status IN
  ('pending','compensating','committedLocal')`.
  For a top-level single-scope transaction this reduces **byte-for-byte** to today's
  `markScopeStepsCommittedStmt` (`saga.ts:282-292`) — the M1–M4 no-op fast path.
  (`compensated`/`failed`/`notRequired` rows are never touched; a `failed` compensation inside the
  subtree blocks progress via the `compensationFailure` incident long before an outer commit is
  reachable.)
- `markScopeStepsCommittedStmt` accordingly becomes parameterized by (scope-id list, target status).

### 3.3 The ledger-write gate

The forward-completion ledger write is currently gated on the **immediate** scope being a
transaction (`isTransactionScope(graph, node.scopeId)`, `src/runtime/forward-task.ts:459-464`) —
under nesting, a service task inside a subProcess-inside-a-transaction would silently never be
ledgered. The gate generalizes to **`nearestEnclosingTx(node.scopeId) !== null`**; `scope_id` on the
row stays the **immediate** scope id (the §3.4 cursor depends on that). The compensation-wiring
lookup (`graph.transactions[scopeId].compensations[elementId]`, keyed by transaction today)
generalizes to per-scope wiring in the scope map — a task's compensation boundary/handler lives in
its own immediate scope (the association guard, §6, is unchanged). Steps in scopes with **no**
transaction ancestor are not ledgered — exactly today's outside-a-transaction behavior, and
consistent with the §6 ancestry rule that rejects compensation wiring there.

### 3.4 The reverse cursor

`selectScopeStepsForCompensation` (`saga.ts:182-196`) generalizes to a **root-relative subtree
cursor**. For compensation root R:

```sql
SELECT * FROM saga_steps
 WHERE instance_id = ?
   AND scope_id IN <subtree(R)>
   AND ( compensation_status IN ('pending','compensating','failed')
      OR (compensation_status = 'committedLocal'
          AND scope_id IN <eligibleCommittedScopes(R)>) )
 ORDER BY seq DESC
```

where `eligibleCommittedScopes(R) = { s ∈ subtree(R) : strictAncestor(R, nearestEnclosingTx(s)) }` —
computed in JS, shipped as the second `IN` list. Verification against the cases that matter:

| Case | Root R | Row | Outcome |
|---|---|---|---|
| Outer cancel over committed inner tx (decomposition §3.1.1 gate) | outer tx O | `committedLocal`, scope ∈ owned(T), T inside O | `strictAncestor(O, T)` ✓ → compensates, reverse order |
| Self re-entry: T#occ1 cancels after T#occ0 committed | T | `committedLocal`, nearestTx = T | `strictAncestor(T, T)` ✗ → shielded |
| Same, rows in S inside T | T | `committedLocal`, scope = S, nearestTx(S) = T | shielded (the §3.1 counterexample, fixed) |
| Operator `/cancel` | process root | any `committedLocal` | process is a strict ancestor of every tx → eligible |
| Operator `/cancel` vs a committed **top-level** tx | process root | `committed` (sealed at outermost commit) | never selected — current `/cancel` semantics preserved |
| Loop of inner tx inside outer, all iterations committed, outer cancels | O | `committedLocal` occ0..k | all eligible, `seq DESC` runs them newest-first |

Companion statement changes, same predicate family:

- `attachCompensationJobStmt` (`saga.ts:252-263`): the `pending → compensating` CAS widens to
  `('pending','committedLocal') → compensating`.
- `countPendingSteps` (`saga.ts:231-239`) / `getFailedStep` (`:242-249`) and the operator-cancel
  empty-ledger fast path (`src/index.ts:471-481`) become root-relative (root = process for
  `/cancel`), counting `pending|compensating|failed` plus root-eligible `committedLocal`.

### 3.5 Global `seq`

`seq` is currently monotonic per `(instance_id, scope_id)` (`saga.ts:125-175`:
`COALESCE(MAX(seq) …, 0)+1` scoped by instance **and scope**), so cross-scope `ORDER BY seq DESC` is
not a global reverse order. The `INSERT` subquery drops the `scope_id` conjunct: **`seq` becomes
monotonic per instance**. Single-scope instances are unaffected (identical ordering); no data
migration; `uq_saga_steps_forward` and `idx_saga_steps_scope` are untouched. Global `seq DESC` then
yields true reverse-chronological order across nested scopes — "bottom-up" falls out for free, and
`filterLineageQuiesced` (`saga.ts:93-110`) remains valid (token lineage is orthogonal).

---

## 4. Compensation runtime: subtree cohort, barrier, two-phase cancel

### 4.1 Un-gating the region machinery

The straggler scan and live-token barrier are currently **gated on `isRegion = !!graph.regions`**
(`src/runtime/compensation.ts:97,117,123`) — for non-region graphs they are skipped entirely and the
barrier degenerates to "ledger empty ⇒ compensated". That gate was safe only in the
single-compensatable-scope world and **is removed**: the scan and barrier run for every graph, with
the subtree filters below. The token read-model this relies on is already universal — for non-region
graphs the engine maintains a single-token reconstruct after every drive (`engine.ts:247-253`,
best-effort). Staleness there errs in the safe direction only: a stale-live token can delay the
barrier one drive, never release it early. The M1–M4 no-op fast path is preserved structurally: for
a single-scope graph, `subtree(R)` = {R} and the cohort/barrier behave as today.

### 4.2 Subtree cohort and barrier

- **Straggler cohort** (`ledgerStragglers`, `compensation.ts:190`, equality test at `:193`): the
  test becomes `graph.nodes[t.position_element_id]?.scopeId ∈ subtree(R)` (membership in a
  downward-closed set ≡ "the position's scope chain contains R" — decomposition §3.1.2(i)). Per-token
  handling is unchanged: forward job completed → `INSERT OR IGNORE` ledger row + consume token;
  failed / no job → discard; created/locked → leave live.
- **Barrier** (`compensation.ts:129`): `listLiveTokens(instanceId)` is filtered to tokens whose
  position node's `scopeId ∈ subtree(R)` before the `live.length === 0` check — a live token in a
  sibling or ancestor scope no longer wedges (nor is masked by) this root's reverse pass.

### 4.3 Two-phase cancel

Cancel of scope R (cancel-end inside a transaction, or operator `/cancel` with R = process root) is
a **two-phase subtree operation** (decomposition §3.1.2(iii)):

1. **Interrupt/drain** — in-flight tokens in `subtree(R)`: completed forward jobs are ledgered (the
   straggler scan above), failed/non-compensatable discarded, `created|locked` jobs drained via the
   existing lease-expiry terminators, now armed subtree-wide
   (`armCohortLeaseExpiryTerminators`, `src/runtime/forward-task.ts:257`). The barrier holds the
   reverse pass until the subtree quiesces. Same drain, any ACTIVE message subscription owned by an
   element inside `subtree(R)` (a parked `receiveTask`/message `intermediateCatchEvent`) is
   superseded in D1 and its correlation-broker key released best-effort
   (`releaseSubscriptionsInScopeSubtree`, `src/runtime/instance-release.ts`, TASK-72) — mirroring the
   whole-instance `releaseActiveSubscriptionsForInstance` used by operator `/cancel` on a region — so a
   drained wait never strands a broker key until the 1-hour buffered-message TTL.
2. **Reverse pass bottom-up** — the §3.4 cursor; global `seq DESC` interleaves nested scopes
   correctly without any extra ordering machinery.

A **cancel-end inside a nested transaction** T compensates only `subtree(T)` and the instance then
continues on T's cancel-boundary failure path — `beginCompensating` (`compensation.ts:47-60`),
`settleAfterCompensation`/`cancelBoundaryTarget` (`compensation.ts:38-45,74`) become root-relative
but keep their shape; the instance-level `compensating` status and terminal guards
(`compensation.ts:51,296`, `incidents.ts:57`) are unchanged.

---

## 5. Hierarchical exceptions

### 5.1 Error bubbling

`errorBoundaryTarget` (`forward-task.ts:69-80`) — today it consults only boundaries with
`attachedToRef === the throwing element` — generalizes to the **attachment chain walk**: candidates
are evaluated bottom-up, first boundaries on the throwing element itself, then boundaries attached
to each enclosing scope node in turn. At each level the existing precedence applies: exact
`@errorCode` match → catch-all (`errorCode == null`). First match wins. If the walk exhausts the
chain at the process root, the error is a **Hazard**: incident, `status = incident`, no
auto-compensation (Principle VI) — for worker errors the incident kind stays `serviceTaskFailure`
(`forward-task.ts:557-564`); an uncaught **error end event** settles a new incident kind
**`uncaughtError`** (added to `IncidentKind`, `src/persistence/instances.ts:810-838`, and to the
openapi `Incident.kind` enum in the same change — `scripts/check-docs.mjs:194-224` enforces the
sync). Retained `pending` rows of the failed instance stay compensable via operator `/cancel` — the
cancellable set already includes in-transaction Hazard incidents (`index.ts:403-404`), and the
root-relative cursor picks up exited scopes with no extra mechanism.

### 5.2 Error end event

`endEvent + errorEventDefinition` is accepted (validator today rejects it at `validator.ts:692-700`).
`errorRef` must resolve to a declared `bpmn:error` with a non-empty `@errorCode` — the same
publish-time resolution the error boundary uses (`validator.ts:1101-1141`); the code is baked into
the graph node. Runtime: reaching the error end consumes its token and **throws the error from the
scope containing the end event** — the first catch candidates are boundaries attached to that scope
node (boundaries cannot attach to end events), then the chain walk continues upward. Catching is
interrupting: see §5.3. An error end at process level is legal (canonical BPMN) and settles the
`uncaughtError` Hazard immediately.

### 5.3 Interrupting catch on a scope, and Hazard-vs-Cancel (§3.2)

When an error is caught by a boundary on scope B (or a scope timer fires — same shape):

1. **Phase-1 drain of `subtree(B)`** — identical mechanics to §4.3 phase 1: completed effects are
   **ledgered (retained)**, in-flight work drained, live tokens of the subtree consumed.
2. **No reverse pass** — a non-cancel boundary interrupts **without compensation** (Principle VI: no
   Cancel ⇒ no compensation). The retained rows stay `pending`.
3. The token exits on the boundary's single outgoing flow, which lives in B's parent scope
   (attachment-scope rule, `validator.ts:1056-1058`, generalized).

Remediation of retained effects needs no new operator surface: a later cancel of an enclosing
transaction, or operator `/cancel` (root = process), reaches them through the §3.4 subtree cursor —
this is the concrete realization of the decomposition's "operator `/cancel` walks exited scopes".
Modeling guidance (docs `09`): for timer-triggered *rollback*, route the timer boundary's flow to a
**cancel-end inside** the transaction; a timer routed elsewhere is deliberately Hazard-class.

### 5.4 Timer boundaries on scopes

The M3 machinery generalizes with the host = scope node:

- **Arm** in the same batch as scope entry (`buildBoundaryArm`, composed at `engine.ts:1060`, joins
  the `enterScope`/`enterTransaction` batch); DO alarm via the existing `JobScheduler.armTimer`
  (`src/durable-objects/job-scheduler.ts:35-38`). Timer ids carry the scope occurrence tag, so M2
  re-entry re-arms cleanly.
- **Disarm** on any scope exit — normal completion (the `commit:`/`scope-end:` batch) **or** an
  abnormal exit via another boundary/bubbled error (the phase-1 drain batch): each writes the
  `cancelled` `timer_outcomes` row (the existing PLAIN-INSERT race decider, `boundary-timer.ts:1-12`
  makes the fire/cancel race safe in both directions).
- **Fire** reuses `planBoundaryTimerFire` (`boundary-timer.ts:340-397`) with a third host shape
  (scope): outcome row + phase-1 subtree drain (replacing the single-job
  `abandonJobOnTimerFireStmt`) + `timerFired` history + transition to the boundary target. The
  Workflow-mode lost-alarm backstop (`settleOverdueBoundaryTimerOnWake`, `engine.ts:274-275`)
  inherits the same batch, as it does today.

#### 5.4.1 Timer fire on a frozen instance = record-and-apply-at-resume (TASK-73, PR #4 finding #4)

An armed scope timer's DO alarm is unaware of instance status. Once armed at scope entry, the timer is
disarmed on every scope **exit** the walk observes — but an instance can be parked **out** of the
active-forward lane (`running` | `waiting`) into a **frozen** state by a path the arming logic never
sees: `incident` (a *sibling/inner* technical failure freezing the instance under this scope, or another
element's Hazard), `compensating` (an operator `/cancel` of a Hazard), or `compensationFailed`. If such an
overdue alarm fired normally it would silently **unfreeze/interrupt** an instance the engine or operator
deliberately parked, and could race an in-flight `/cancel`/`/retry`.

**Policy (decided):** a timer that comes due while the instance is frozen is **recorded, not applied**.
`fireTimer` (`src/runtime/timers.ts`) checks instance status after the base guards: a *done* instance
(`completed`/`cancelled`/`compensated`) is the unchanged no-op; a *frozen* instance takes the
**suppressed-record** branch — it claims the SAME decider a normal fire would (`timer_outcomes 'fired'` +
the `timers` bookkeeping flip) plus a `timerFired {suppressed:true}` audit, and **nothing else**: no
transition, no job abandon, no scope drain, no subscription supersede. (`running`/`waiting` are the
normal-fire lane — a scope timer legitimately fires while its inner host wait is parked at `waiting`.)

At operator `/retry` → resume → rewalk, the recorded decider makes `timerHasFired` fast-forward the walk
onto the boundary path (`engine.ts` `driveLeaf` scope branch), where `drainScopeSubtree` settles the
interrupted scope's stragglers — so the modeled deadline is **applied after the incident is resolved**,
the freeze is never violated, and no new mechanism is introduced. Because the single-token (non-region)
walk persists no token rows, that drain also abandons any in-flight (`created`/`locked`) forward job
inside the subtree — e.g. the inner task's job re-created by `/retry` (`drainScopeSubtree`'s TASK-73
subtree job scan), so no leasable straggler survives the scope exit.

**Single-decide under a concurrent `/cancel`:** the suppressed claim is a PLAIN `timer_outcomes` INSERT
(the gateway_decisions race contract), so a concurrent `cancelArmedTimersForInstance` sweep that claimed
the decider first aborts the suppressed batch on the PK → no-op; conversely the sweep skips a timer that
already has a decider. The timer is decided exactly once in either interleaving.

**eventGateway timers** decide on `gateway_decisions` (built with their transition inside
`planEventGatewayTimerFire`) — splitting that batch is out of scope here, and an EBG timer is not a scope
timer. On a frozen instance its fire is **not lost**: the timer stays armed and the DO alarm is re-armed
for a short backoff, so the deadline is re-evaluated once the freeze clears.

---

## 6. Validator delta

| Rule | Change |
|---|---|
| `bpmn:SubProcess` (plain, embedded) | **Accept**: recurse `classifyContainer` with `scopeKind="subProcess"`; today it falls to the generic whitelist reject (`validator.ts:632-640`) |
| `triggeredByEvent="true"` | **Interim reject** with M5-L4 roadmap pointer (element id + reason) |
| `adHocSubProcess` | **Reject** (permanent, element id + reason) |
| `multiInstanceLoopCharacteristics` / `standardLoopCharacteristics` on any activity | **Interim reject** → M5-L3 / permanent reject respectively |
| Error end event | **Accept** (replaces the reject at `validator.ts:692-700`); `errorRef` → `bpmn:error/@errorCode` resolution required, dangling/empty rejected (reuse `:1114-1136`) |
| Cancel end event | Immediate scope MUST be a transaction (today: "inside transaction"; the rule becomes explicit about *immediate* under nesting) |
| Error boundary hosts | serviceTask (existing, `:1102`) **+ subProcess + transaction** |
| Timer boundary hosts | serviceTask/receiveTask (existing) **+ subProcess + transaction** — the M5-deferral reject at `validator.ts:1180-1185` is removed |
| Cancel boundary hosts | transaction only (**unchanged**, `:1157`) |
| Compensate boundary hosts | serviceTask only (**unchanged**, `:1061`; compensate-subProcess-as-unit deferred post-M5) |
| Compensation association guard (`validator.ts:1091-1096`) | **Unchanged** — boundary and handler must share an immediate scope |
| Handler-in-transaction guard (`validator.ts:1432-1439`) | Becomes the **ancestry check** (decomposition §3.1.3): legal iff **some ancestor scope is a transaction**; a chain reaching the process root without one is rejected (element id + reason: the handler has no trigger). Note the decomposition cites one guard; there are two — only this one changes. |
| Boundary count per activity (`:1266-1275`), non-interrupting reject (`:493-499`) | Unchanged, now also covering scope hosts |
| Flow crossing a scope boundary (`:789-796`) | Unchanged mechanism, now exercised by nested scopes |
| Per-scope structure: exactly one none-start (`:857`), ≥1 end (`:860`), SESE regions per scope (`validateRegions`, scope-filtered at `src/bpmn/regions.ts:98-110`, invoked per scope `validator.ts:1377-1392`) | Unchanged mechanism, applies to subProcess scopes |
| `MAX_SCOPE_DEPTH` | **New publish-time reject** (§7) |

---

## 7. Caps

**`MAX_SCOPE_DEPTH = 8`**, defined in `src/runtime/engine.ts` beside the existing three caps and
appended to `SYNCED_CONSTANTS` in `scripts/check-docs.mjs` (`:172`).

Deliberate refinement of decomposition §4: in L1 scope depth is **fully static** (no callActivity,
no MI), so the cap is enforced by the **validator at publish** (element id + reason) — fail-closed,
zero runtime surface. The `scopeDepth` *runtime incident* named by the decomposition becomes
reachable only when M5-L2 introduces dynamic depth (call chains) and is deferred to that layer; the
v2.5.0 amendment records the cap, `docs/bpmn/09` + `specs/002` record the value (check:docs-synced).

---

## 8. Governance, docs, and process lockstep

Ordered opening sequence of the cycle:

1. Merge the docs-only `m5-composition-design` branch to `main`; branch `m5-l1-embedded-scopes` off
   `main`.
2. **Constitution v2.5.0** — the single M5 amendment exactly per decomposition §5 (Principles I, II,
   III, IV additively, VI generalized to scope subtrees with the §3 invariants of this document).
3. `specs/002-saga-orchestrator/`: M5-L1 section appended to `spec.md` (M4 pattern),
   `m5-L1-constitution-check.md`, plan update.
4. `docs/bpmn` lockstep: `02-activities.md` (embedded subProcess), `01-events.md` (error end),
   `07-execution-semantics.md` (scope model, commit shield, two-phase cancel),
   `09-easy-bpmn-profile.md` (rules generalized; **interim markers for L2–L5**; modeling guidance
   from §5.3).
5. Contracts: `Incident.kind` += `uncaughtError`; wherever `compensation_status` surfaces in the
   inspection API/openapi, the enum gains `committedLocal` (verify the exact contract surface at
   plan time — `check:docs` §7 will catch a miss).
6. `tests/matrix/registry.ts`: new must-cover tags (`Activities:subProcess`, `Events:errorEnd`,
   scope-host boundary tags, `Compensation:nested-tx`) + reject scenarios (event subprocess, adHoc,
   MI interim, scope depth, cancel-end outside a transaction, handler with no transaction ancestor).
   **`C-COMP-NESTEDTX-BRANCH-01` (`registry.ts:45`) is rewritten** — it currently pins the pre-M5
   behavior ("inner commit terminalizes; outer cancel never re-compensates"), which this layer
   inverts by design.
7. Backlog: flat top-level `TASK-NN` tasks labeled `m-5` (the M3/M4 pattern), not epic subtasks.

---

## 9. Operator console (thread G) — L1 delta

History-only. The new event types `scopeEntered` / `scopeExited` (free-form strings,
`src/persistence/history.ts:12,24`) flow through the existing history endpoints and SSE stream;
every new transition of this layer (scope entry/exit, scope-boundary fire, error bubble, nested
commit/cancel) writes D1 history — the read-only / D1-only invariant is re-affirmed as a
verification checkbox. No SPA change in L1; parent/child navigation and richer scope visualization
start with M5-L2 per the decomposition.

---

## 10. Testing & exit gates

**Unit**

- Table-driven eligibility matrix for the §3.4 cursor over a seeded `saga_steps` fixture — every row
  of the §3.4 case table, including the re-entry counterexample and `/cancel`-vs-sealed rows.
- Scope-map compilation: kinds, parents, depths, `ownedScopes`, `nearestEnclosingTx`, subtree
  closure; `MAX_SCOPE_DEPTH` boundary (depth 8 accepted, 9 rejected).
- Validator accept/reject pairs for every §6 row (including tolerate-and-ignore of foreign-namespace
  extension content inside a subProcess).

**Integration** (the decomposition's exit gates, verbatim, plus the new invariants)

1. `outer-tx > subProcess > inner-tx-commits`, then outer cancel → inner steps compensate in
   reverse (global-`seq` order asserted).
2. Error thrown by a service task inside a subProcess bubbles to the subProcess boundary; with no
   boundary anywhere, settles a Hazard at root; an error **end event** does the same from a
   non-service control path.
3. Timer boundary on a transaction fires → interrupts **without** compensation, ledger retained;
   operator `/cancel` then drives the reverse pass over the exited scope.
4. Self re-entry shield: T commits at occ0 (nested), re-enters, cancels at occ1 → occ0 rows (incl.
   rows in T's child subProcess) untouched; a later ancestor cancel compensates both occurrences.
5. Two-phase cancel: a straggler job in a **deeper** scope completing after cancel is ledgered and
   compensated (no leak); a live deeper-scope token holds the barrier (no wedge, no early settle).
6. **No-op gate:** the entire existing M1–M4 suite green with zero test edits (single-scope fast
   path byte-compatible), except the deliberately rewritten `C-COMP-NESTEDTX-BRANCH-01`.

**Matrix / real CF**

- New scenarios registered in both Layer A (direct) and Layer B (workflow-mode) per §8.6.
- **Real-CF smoke** for the nested-cancel reverse pass (gate before layer closure): the reverse pass
  is the project's historically replay-fragile path — the M4 busy-spin defect only reproduced on
  real Cloudflare Workflows.

---

## 11. Deferred / open items (tracked)

- Compensate-a-subProcess-as-a-unit (`compensateEventDefinition` boundary on a subProcess) — post-M5.
- `scopeDepth` runtime incident — becomes reachable and lands in M5-L2.
- Event subprocess — M5-L4; until then the interim reject stands.
- Console scope-tree visualization — M5-L2+ (thread G).
- Whether `compensation_status` needs `committedLocal` surfaced distinctly in the console job/step
  humanization — decide with the L2 console delta; L1 exposes it via the contract enum only.
