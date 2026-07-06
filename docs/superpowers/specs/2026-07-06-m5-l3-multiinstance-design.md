# M5-L3 — `multiInstanceLoopCharacteristics` (data-driven fan-out): design

**Date:** 2026-07-06
**Status:** refines `2026-06-20-m5-composition-design.md` §3 thread D + §4 caps + §6 "M5-L3" into an
implementable layer design.
**Governance:** constitution v2.5.0 already accepts `multiInstanceLoopCharacteristics` (parallel AND
sequential, "standard `loopCardinality`/FEEL or an `easy-bpmn:multiInstance` collection binding —
never the standard data-binding attributes") and pre-records `MAX_MI_CARDINALITY` as the layer's
`check:docs`-synced cap. This layer **opens the runtime**; no constitution bump — only the per-layer
Constitution Check (`specs/002-saga-orchestrator/m5-L3-constitution-check.md`) and the lockstep doc
sync (M5-L1/L2 precedent).

## 1. Approach — a self-contained dynamic region owned by one MI driver

**Chosen: a dedicated `src/runtime/multi-instance.ts` driver** (mirroring `call-activity.ts`),
dispatched from `driveLeaf` when `node.multiInstance != null`, for **all three body kinds**
(serviceTask / subProcess / callActivity) in **both modes** (parallel / sequential). The MI activity
stays a single 1-in/1-out node on the token path; iterations are managed inside the driver. The SESE
validator is untouched (an MI node is an ordinary CFG vertex — splits are detected only by gateway
type, `regions.ts:49`), matching the composition design: "the MI activity is its own self-contained
dynamic region, not a publish-time SESE region".

Rejected alternatives:

- **MI as a synthetic publish-time region** (rewrite into parallelGateway fan-out): cardinality is
  runtime data — N flows cannot exist at publish; sequential MI has no gateway analogue; and it would
  fake `gateway_decisions`/join facts for edges that do not exist in the model (a canonicity smell).
- **Sequential-MI-as-implicit-M2-loop through the main walk** (loop the walk back to the element):
  reuses the most machinery for the subProcess body, but forks the execution model per mode
  (sequential = main walk, parallel = driver), doubles the persistence-key scheme, and leaves the
  parallel case unsolved anyway. Uniform driver wins.

**Iteration identity.** One MI arrival = **one walk occurrence** (`occ` of the MI element, from the
ordinary visit counter); iterations are a **second dimension**, `iterationIndex` `0..N-1` — exactly
the `child_instances` precedent (`occurrence, iteration_index` UNIQUE, reserved in 0008 for this
layer). Migration `0009_multi_instance.sql` adds `iteration_index INTEGER NOT NULL DEFAULT 0` to
`service_task_jobs` and `saga_steps` and widens their unique indexes
(`(instance_id, element_id, is_compensation, occurrence, iteration_index)` /
`(instance_id, element_id, occurrence, iteration_index)`). Non-MI writes keep `0` (index rebuild is
backward-compatible; no data change). Workflow step names and job idempotency keys gain an `@{i}`
suffix **only for `i > 0`**, keeping every pre-L3 step name and key byte-identical (replay safety for
in-flight instances across deploy).

## 2. The activation decider (`mi_activations`, migration 0009)

```sql
CREATE TABLE mi_activations (
  instance_id     TEXT    NOT NULL,
  element_id      TEXT    NOT NULL,
  occurrence      INTEGER NOT NULL,
  cardinality     INTEGER NOT NULL,          -- N, pinned at activation
  is_sequential   INTEGER NOT NULL,          -- 0 | 1
  items           TEXT,                      -- JSON array snapshot (NULL = cardinality-only MI)
  settled_kind    TEXT,                      -- NULL (in flight) | 'all' | 'condition'
  settled_count   INTEGER,                   -- k at settle time
  output_applied  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  UNIQUE (instance_id, element_id, occurrence)
);
```

The row is the **`gateway_decisions` analogue**: cardinality / the collection snapshot are FEEL-
evaluated **once**, written persist-before-advance (batch: row + `miActivated` history), and **never
re-evaluated** — the rewalk fast-forward predicate for the whole visit. `settled_kind`/`settled_count`
is the once-only early-completion decider; `output_applied` is the aggregation apply-once flip
(the `output_applied=1` analogue). N = 0 is legal (empty collection): the visit settles immediately
(`settled_kind='all'`, `settled_count=0`, empty aggregation) — BPMN-canonical zero-iteration MI.

**Cardinality sources** (exactly one required, both FEEL over the token-resolved scope):
- standard `loopCardinality` (number-valued FEEL) → cardinality-only MI, `items = NULL`;
- `easy-bpmn:multiInstance` extension element (new moddle type beside `TaskDefinition`):
  `collection` (FEEL, must evaluate to a list), `elementVariable` (optional, default `"item"`),
  `outputVariable` (optional — aggregation only when present).
Both present → publish reject (ambiguous); neither → publish reject (the constitution's permanent
"no recognized cardinality source"). Evaluation failure at runtime (non-number, negative,
non-integer, non-list) → **`conditionFailure`** incident (the existing hard-FEEL-failure kind);
N > effective cap → **`miCardinality`** incident (§6). Both are graceful, before any iteration starts.

**Per-iteration input context** (durable at iteration start, never re-derived): base = the MI
element's resolved scope (root vars or branch overlay via `activeTokenId`, the standard `isBranch`
idiom) + `{ [elementVariable]: items[i] }` (collection MI only) + `{ loopCounter: i }` (0-based,
Camunda-7-aligned; documented). It is captured in the iteration's own artifact — the job's input,
the child's initial variables, or the iteration token's overlay — in the same batch that creates it.

## 3. Forward lifecycle (per body kind)

Engine reaches `mi:el#occ` (dispatch **before** the per-type branches in `driveLeaf`; the
transaction/subProcess descent and callActivity/serviceTask leaf drivers are never consulted for an
MI node). The driver:

1. **Activate** — no `mi_activations` row → evaluate N/items → cap check → one batch (row +
   `miActivated`), inside `runStep("mi-activate:el#occ")`, gated on the D1 read outside the step.
2. **Drive iterations** (index order, deterministic on every rewalk):
   - **parallel**: for each `i` in `0..N-1`, drive iteration `i` one state forward
     (not-started → started; terminal → applied). All live at once.
   - **sequential**: find the first non-finished `i`; drive only it. At most one live iteration.
   - Per-kind iteration mechanics reuse the existing drivers with an `iterationIndex` thread:
     - **serviceTask body**: `driveServiceTask`-equivalent per iteration — job keyed
       `(el, occ, i)`, step names `svc-create:el#occ@i` (…`@0` elided), input = the §2 context.
       The existing forward triad (persist-before-advance, `output_applied`, boundary-timer
       fast-forward) is reused verbatim.
     - **callActivity body**: `driveCallActivity` per iteration with `iterationIndex = i` threaded
       into `childInstanceIdFor` / `insertChildInstanceStmt` / `getChildInstanceForVisit` /
       `markChildOutputAppliedStmt` (all already take it; today hard-coded 0). Child initial vars =
       the §2 context. The child-notify / DO-alarm / `CHILD_WAIT_BACKSTOP_MS` plumbing is untouched
       (`wakeBackstop`'s invoked-children COUNT is already multi-row-safe).
     - **subProcess body**: iteration `i` = a **real branch token**
       `branchTokenId(instanceId, el, occ, "mi#" + i)` whose overlay is seeded with the §2 context;
       the driver walks the body interior (from the scope's `startId`, following `next`/gateway
       outcomes) via the shared `drivers.driveLeaf` with `activeTokenId` = the iteration token —
       interior jobs/gateways/timers get per-iteration occurrences from the **shared walk visits
       map** (index-order sub-walks make them deterministic, the same discipline as the M4 branch
       DFS), and interior variable writes land in the iteration overlay via the existing `isBranch`
       paths. The body's inner **none end** is intercepted by the driver (never `exitScope`, never
       instance completion): it settles the iteration (`miIterationCompleted` marker). Both modes
       (sequential too) use iteration tokens — one uniform isolation/aggregation mechanism.
3. **After every newly-observed iteration completion**: evaluate `completionCondition` (if declared)
   over base vars + the finished iteration's output + `{ nrOfInstances: N,
   nrOfCompletedInstances: k, nrOfActiveInstances }`. True → the **settle decider**
   (`settled_kind='condition'`, `settled_count=k`) + **cancel-remaining**: abandon in-flight
   iteration jobs (`abandonJobOnTimerFireStmt` path), cascade-cancel in-flight iteration children
   (`cancelChildCascade`), mark remaining iteration tokens `discarded` — a NORMAL, non-compensating
   frontier teardown (**never `ledgerStragglers`** — no spurious compensation jobs). Never-started
   iterations simply never start.
4. **Aggregate + advance (apply-once)** — all N settled, or the settle decider present:
   `runStep("mi-apply:el#occ")`, gated on `output_applied = 0` read outside the step. One batch:
   optional `outputVariable` = an array of length N, `[i]` = iteration `i`'s output (the job's
   output variables / the child's final variables / the iteration overlay), `null` at
   never-finished indexes ("collects only the k finished iterations by index"); write to root vars
   or the MI element's own branch overlay (the M4 split, exactly `applyChildTerminal`'s);
   `output_applied = 1`; `miCompleted` history; transition to `node.next`. Without
   `outputVariable`, MI writes **no** variables (documented).
5. **Park** otherwise — `mi-park:el#occ`, `parkWaiting`-style (`status='waiting'`,
   `current_element_id = el`); iteration completions wake the parent through the **existing** seams
   (job completion `deliverJobResult` tickle; child terminal `notifyParentOfChildTerminal` — the
   parked element IS `parent_element_id`).

**Ledger.** Iteration steps are ordinary `saga_steps` rows — `(el, occ, i)`-keyed, `scope_id` = the
**miBody scope** (§5), `pending` on completion. miBody NORMAL completion flips **nothing**
(byte-for-byte the shipped subProcess behavior: only a transaction commit flips statuses); the rows
stay `pending` and compensate **in reverse `seq` order** ("reverse-by-index" for sequential, reverse
completion order for parallel — the existing cursor, zero algorithm change) only when an enclosing
transaction later cancels. Never-completed cancelled iterations ledger nothing (the existing
discard-on-no-job / failed-job rules).

## 4. Errors, boundaries on the MI activity, Hazard

- **Iteration business error** (worker error / error end in the body / child `errored`): the MI
  visit **aborts** — `drainScopeSubtree(graph, instanceId, el)` over the miBody scope (retention
  semantics land exactly right out of the box: completed iteration jobs stay/are ledgered `pending`;
  in-flight abandoned + discarded; live iteration children cascade-cancelled with retained ledgers)
  — then the error routes **as if the MI activity threw it**: matching error boundary on the MI
  activity, else M5-L1 hierarchical bubbling, `uncaughtError` at root. The settle decider records
  the abort so a rewalk never restarts iterations.
- **Technical incident in an iteration** (job retries exhausted, child `incident`): the incident
  parks the saga exactly as today (MI parked; other parallel iterations may keep completing);
  operator `/retry` heals it (children via the existing `retryChildSubtree` cascade, which already
  iterates all `child_instances` rows).
- **Timer boundary on the MI activity = Hazard**: interrupt-without-compensation — the same
  `drainScopeSubtree(el)` retention drain, then route the boundary flow; finished iterations'
  `pending` rows are retained for a later operator `/cancel` (M5-L1 §3.2 semantics, unchanged).
- **Error/timer boundaries on the MI activity: accepted.** A **compensation boundary on the MI
  activity (compensate-the-MI-as-a-unit): DEFERRED** (publish reject with reason), the exact
  analogue of L1's deferred compensate-subProcess-as-unit; per-iteration compensation via the
  iterations' own rows is the supported model. `isForCompensation` on an MI activity → reject.

## 5. Scope model

Every MI activity contributes a **`miBody` `ScopeMeta`** to `graph.scopes`:
- MI-over-subProcess: the subProcess's existing scope entry ships `kind: "miBody"` (same id, parent,
  depth, startId). `scopeKindOf` deliberately keeps returning `null` for it — the plain
  `exitScope`/descend paths must never fire for an MI body (the driver owns entry/exit).
- MI-over-serviceTask / MI-over-callActivity: a synthetic leaf scope
  `{ id: el, kind: "miBody", parentId: enclosing, depth: parent+1, startId: el }`.

This single addition is what makes the shipped M5-L1 subtree machinery (reverse cursor, straggler
cohort, live-token barrier, `drainScopeSubtree`, `cancelChildrenInSubtree`) see iterations with **no
algorithm change**: iteration ledger rows carry `scope_id = el` ∈ `subtreeScopeIds(root)` for any
enclosing cancel root, and iteration tokens (`…:el#occ:mi#i`) cohort through the position's scope
chain. `MAX_SCOPE_DEPTH` counts the miBody scope (validator depth check, publish-time as before).

Two targeted straggler refinements (Task-level, with regression tests): `retainCallStraggler` must
retain the token's **own iteration** row (derive `iterationIndex` from the `mi#i` token id) instead
of `rows[rows.length-1]`, and its ledger-dedup guard becomes iteration-aware; `ledgerStragglers`'
job resolution likewise resolves the iteration's job. `reconstructFrontier`/`syncFrontierReadModel`
(the single-token post-drive sync) must **preserve live `mi#` iteration tokens** instead of marking
them consumed.

## 6. Caps — body-aware `MAX_MI_CARDINALITY` + the step-free park

- **`MAX_MI_CARDINALITY = 200`** — new constant in `src/runtime/engine.ts` beside the other caps,
  added to `SYNCED_CONSTANTS` in `scripts/check-docs.mjs`; test override
  `MAX_MI_CARDINALITY_OVERRIDE`.
- **Body-aware effective cap**, computed at **publish** into `node.multiInstance.bodyStepCost` (a
  static count: 1 for a serviceTask body; the interior step-costing node count for a subProcess
  body; the resolved child graph's step-costing count for a callActivity body) and enforced at
  **runtime activation** (N is data): `effectiveCap = min(MAX_MI_CARDINALITY,
  floor(STEP_BUDGET_SOFT / (bodyStepCost * 4)))` (the ×4 headroom covers create/apply/park/wake
  amplification per iteration). Exceeding it settles the graceful **`miCardinality`** incident
  (new `IncidentKind` member + openapi enum member — `check:docs` #7 enforces both).
- **The step-free park (the composition design's "highest-leverage mitigation") ships in this
  layer**: `svc-park`, `call-park`, and `mi-park` adopt the intermediate-timer pattern — the parked
  predicate is read OUTSIDE the step and the `runStep` is issued **only when the park actually
  changes state** (first visit); a rewalk over an unchanged park is write-free AND step-free. This
  collapses the N-parked-iterations × wakes step cost from ~N²/2 to ~linear and is replay-safe
  (skipping a previously-memoized step name is legal; issuance order of waits is unchanged).

## 7. Validator / publish-time

Accepts (`multiInstanceLoopCharacteristics`, parallel and sequential) **only on** `serviceTask`,
`subProcess`, `callActivity`. All rejects carry element id + reason:

- `standardLoopCharacteristics` (now discriminated by `$type`, its own permanent message);
  MI on a `transaction` / `receiveTask` / any other activity (permanent);
- the standard data bindings `loopDataInputRef` / `loopDataOutputRef` / `inputDataItem` /
  `outputDataItem` → the constitution's **dedicated permanent reject** (these are not flowElements —
  the generic whitelist never reaches them); `complexBehaviorDefinition` /
  `oneBehaviorEventRef` / `noneBehaviorEventRef` (non-`All` behavior) likewise rejected;
- **no recognized cardinality source** (neither `loopCardinality` nor `easy-bpmn:multiInstance`
  `collection`) — permanent; **both** sources — reject (ambiguity);
- `loopCardinality` / `completionCondition` FEEL-parsed at publish (the `parseCondition` pattern;
  a syntax-only `parseFeelExpression` variant for the number-valued cardinality);
- **v1 MI-subProcess body whitelist** (recorded in the Constitution Check as deliberate
  narrowings, each its own reject): inside an MI body only `serviceTask`, `exclusiveGateway`
  (conditions/default/cycles), intermediate **timer** catch, none/error end events, and error/
  timer/compensation boundaries **on inner tasks** are allowed. Rejected in v1: `receiveTask` /
  message catch / `eventBasedGateway` (broker-key collision across concurrent iterations — the
  L2 message-wait precedent), nested `subProcess` / `transaction` / `callActivity` / nested MI,
  and `parallelGateway` / `inclusiveGateway` (the frontier DFS does not recurse under the MI
  sub-walk in v1). Rich bodies are the MI-over-callActivity story (the called process is fully
  general — L2's own publish rules already validated it).
- MI-callActivity composes with L2 publish rules unchanged (`calledElement` binding, depth,
  cycle, message-wait-in-tree); `camunda:`/`zeebe:` MI attributes (e.g. `zeebe:inputCollection`)
  remain tolerated-and-ignored **as extension content**, but a camunda/zeebe-only cardinality
  source without a recognized one still rejects (no silent zero-run).

## 8. Operator surface and console delta (thin)

- Verbs unchanged: `/cancel` = the two-phase root drain (already iterates every `child_instances`
  row and every live token); `/retry` = the child-subtree-first cascade (already MI-tolerant);
  direct child verbs stay 409.
- `InstanceLineageChild` gains `iterationIndex` (api type + openapi + `handleGetInstance` mapping —
  the column is already selected); the SPA lineage strip sorts by
  `occurrence DESC, iterationIndex ASC` and labels MI children `call1 #2·i3`; MI iteration tokens
  are visible through the existing `tokens` block (`mi#i` ids). New history events (free-text, no
  migration): `miActivated`, `miIterationCompleted`, `miCompletionConditionMet`, `miCompleted`.
  Every new transition writes D1 history — the read-only / D1-only invariant re-affirmed.

## 9. Testing and exit criteria

**Unit:** validator accept/reject matrix (`tests/unit/validator-multi-instance.test.ts`) incl. the
three existing MI-reject tests flipped (`bpmn-validator.test.ts:113`, `validator-call-activity.
test.ts:36`, `tests/matrix/reject.test.ts` `R-MI-SUBPROC-01`); expressions coverage for cardinality
parsing; scope-tree miBody math; body-step-cost derivation.

**Integration (direct mode):** parallel + sequential serviceTask MI (jobs keyed `@i`, aggregation
by index, `loopCounter`/`elementVariable`); N=0; MI in an M4 branch (overlay-targeted aggregation);
MI-subProcess both modes (interior occurrences, overlays, inner XOR); completionCondition early
settle + cancel-remaining (no compensation jobs created); MI-callActivity fan-out (N children,
deterministic ids, lineage `iterationIndex`) + per-iteration child compensation under an enclosing
tx cancel; k-finished-compensate-reverse / N−k-owe-nothing; iteration error → MI abort → boundary
routing; Hazard timer on the MI; `miCardinality` + `conditionFailure` incidents (override harness);
idempotent double drives at every stage; step-free park regression (step-count assertions via a
counting `runStep`).

**Matrix:** an `MI-*` registry wave (valid + rejects) with `multiInstance` appended to
`MUST_COVER`; count literals bumped (`registry.test.ts` 86/19, `check-matrix.mjs` 86).

**Workflow mode:** Layer B `matrix.wf.test.ts` MI block (fan-out over real Workflows, MI-callActivity
child fan-out, early completion); the composite-MI step-budget scenario direct-mode via
`STEP_BUDGET_SOFT_OVERRIDE` with the Layer B half `@needs-override`; a **real-CF smoke gates the
merge** (MI-callActivity fan-out + compensation is the mandatory scenario).

**Exit criteria (verbatim from the composition design):** parallel MI over a collection runs N
concurrent iterations and joins; sequential MI loops; MI-callActivity fans out N sub-instances and
compensates each; completionCondition fires early, then an enclosing tx cancels → the k finished
compensate reverse-by-index, the N−k ledger nothing; a composite MI driven to the step-budget
boundary settles a graceful `stepBudget` incident, not an opaque errored Workflow.
