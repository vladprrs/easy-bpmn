# M4 — Concurrency (parallel + inclusive gateways, token set, joins) — Design

**Date:** 2026-06-13
**Status:** Approved design (brainstorming output), hardened by a 6-lens adversarial review grounded in the
shipped M1/M2/M3 code (replay/occurrence determinism, Cloudflare-Workflows feasibility, inclusive/SESE
semantics, compensation/straggler correctness, persistence/idempotency, completeness). Source artifact for
the `specs/002-saga-orchestrator` M4 deltas and the Backlog.md M4 milestone tasks.
**Supersedes for M4 scope:** the M4 row in `docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md`
§8 (which named only `parallelGateway`); this design widens M4 to `parallelGateway` **and**
`inclusiveGateway`, both block-structured.
**Governance:** constitution `2.2.0 → 2.3.0` (MINOR), amended **first** (the M3-style ordering) before any
M4 construct's runtime ships.

---

## 1. Context & goal

`easy-bpmn` today executes a **single-token** instance: the engine (`src/runtime/engine.ts`) re-walks the
graph from `startElementId` on every drive over a scalar cursor `cur`, assigning each element visit a
walk-local **occurrence** (0-based, never derived from D1 row counts). Already-applied visits fast-forward
write-free from append-only facts (completed jobs with `output_applied=1`, consumed subscriptions, fired
timers, recorded `gateway_decisions`); gateway branch choices are persisted once and never re-evaluated.
M1 (transaction-saga), M2 (`exclusiveGateway` + FEEL + cycles), and M3 (interrupting boundary/intermediate
timers, message intermediate catch, `eventBasedGateway`, free error routing) have all shipped. The Worker
is live at `bpmn.rntme.com`.

**M4 introduces genuine concurrency within one instance:** a `parallelGateway` (AND) or `inclusiveGateway`
(OR) splits control into several **concurrent tokens** that run their branches, then re-synchronise at a
matching join. This is the token model of `docs/bpmn/07-execution-semantics.md` made executable: multiple
tokens, an AND-join that waits for one token on every branch, an OR-join that waits for exactly the
branches its split activated, and an instance that completes only when **zero tokens remain**.

The whole difficulty is that the engine's heart — a scalar-cursor rewalk inside **one Cloudflare Workflow
per instance** — is single-token, and several shipped mechanisms (timer fire-guards, instance completion,
operator verbs, compensation) silently assume exactly one live position. M4 must grow a concurrent token
set while preserving the two invariants that make the engine provably durable: **the walk is the replay**
(every decision re-derives from append-only facts, never from mutable live state) and **persist-before-
advance** (every effect is durably recorded before the token moves).

### What stays
- One Cloudflare Workflow per instance; D1 the canonical store; the single DO correlation broker.
- Rewalk-from-start with walk-local occurrence; append-only facts as the only replay inputs.
- Immutable version binding; persist-before-advance; at-least-once + idempotency everywhere.
- `easy-bpmn:taskDefinition type` routing; the pull worker data plane.

### What must reopen
1. **The validator/profile** (`src/bpmn/profile.ts`, `src/bpmn/validator.ts`): `parallelGateway` and
   `inclusiveGateway` are rejected via `DEFERRED_GATEWAY_REASONS` (profile.ts:44-54, emitted at
   validator.ts:438-445). Flip both to *accept-and-validate* (mirroring how `eventBasedGateway` graduated
   in M3); keep `complexGateway` rejected. Add the SESE block-structure validator (§4).
2. **The engine** (`src/runtime/engine.ts`): the scalar `cur` loop becomes a **token-frontier rewalk**;
   instance completion becomes frontier-empty; every `current_element_id`-based staleness guard becomes
   per-token; compensation grows cohort capture, per-token terminators, lineage-ordered reverse, and a
   quiescence barrier.

---

## 2. Locked decisions (user-approved; not re-litigated)

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Construct set** | `bpmn:parallelGateway` (AND split/join) **and** `bpmn:inclusiveGateway` (OR split/join). `complexGateway` stays rejected. |
| 2 | **Topology** | **Block-structured only.** Every parallel/inclusive split is paired with exactly one matching join of the **same type**; the region is single-entry/single-exit (SESE) and properly nested. XOR (M2), cycles, transaction scope, and M3 timers/boundary events remain free **inside** a region (subject to the branch-confinement rule, §4). Validated at publish. |
| 3 | **Concurrency strategy** | **Token-frontier + multi-wait race within one Workflow** (keep Workflow-per-instance). The scalar cursor becomes a set of live token positions; at a split, branches are fanned out and their jobs made leasable (non-blocking, no outbound call); the drive collects all parked frontier waits and issues one `Promise.race` over several `step.waitForEvent`; any event re-walks from start. **Real parallelism is worker-side** (all branches leasable at once; external workers run them concurrently). |
| 4 | **Variables** | **Branch-local scopes that merge at the join.** Each token carries a `variables_overlay` delta over its parent scope; reads resolve the overlay chain to the root `process_instances.variables`; writes go to the token's own overlay; at a join the joined branches' deltas merge into the produced token in **deterministic split out-flow document order**, later-in-order wins on key conflict; the merge folds up at region exit. |
| 5 | **Compensation of parallel branches** | **Straggler-catching.** On scope cancel (error→cancel end \| operator `/cancel`) the live-token cohort is recorded; a late forward `complete` still writes its `saga_steps` ledger row (`INSERT OR IGNORE`) but does not advance; reverse compensation re-scans so stragglers are caught; the instance settles `compensated` only when the ledger is drained **and** every cohort token is terminal. |

> The 14 hardening blockers below are all *mechanism refinements that the locked decisions imply* — none
> changes a decision. They are woven into §3–§9 and indexed in the **Hardening ledger** (§13).

---

## 3. The canonical concurrency contract (how it is drawn in BPMN)

A concurrent region is a **block-structured** pair of standard gateways. Forward steps inside a branch are
ordinary `serviceTask`/`receiveTask`/`exclusiveGateway`/`eventBasedGateway`/`transaction` nodes — exactly
the M1/M2/M3 set. The only new flow nodes are `parallelGateway` and `inclusiveGateway`; no additive
binding beyond the existing `easy-bpmn:taskDefinition`. Files stay XSD-valid and round-trip through
bpmn-js / Camunda Modeler.

```xml
<bpmn:process id="FulfilOrder" isExecutable="true">
  <bpmn:startEvent id="Start"/>

  <!-- AND split: reserve stock and authorize payment concurrently -->
  <bpmn:parallelGateway id="fork"/>
  <bpmn:serviceTask id="reserveStock"><bpmn:extensionElements>
      <easy-bpmn:taskDefinition type="reserve-stock" retries="3"/></bpmn:extensionElements></bpmn:serviceTask>
  <bpmn:serviceTask id="authorizePayment"><bpmn:extensionElements>
      <easy-bpmn:taskDefinition type="authorize-payment" retries="2"/></bpmn:extensionElements></bpmn:serviceTask>
  <bpmn:parallelGateway id="join"/>     <!-- AND join: waits for BOTH branches -->

  <bpmn:serviceTask id="confirmOrder"><bpmn:extensionElements>
      <easy-bpmn:taskDefinition type="confirm-order"/></bpmn:extensionElements></bpmn:serviceTask>
  <bpmn:endEvent id="Done"/>

  <bpmn:sequenceFlow id="s0" sourceRef="Start"            targetRef="fork"/>
  <bpmn:sequenceFlow id="f1" sourceRef="fork"             targetRef="reserveStock"/>
  <bpmn:sequenceFlow id="f2" sourceRef="fork"             targetRef="authorizePayment"/>
  <bpmn:sequenceFlow id="j1" sourceRef="reserveStock"     targetRef="join"/>
  <bpmn:sequenceFlow id="j2" sourceRef="authorizePayment" targetRef="join"/>
  <bpmn:sequenceFlow id="s1" sourceRef="join"             targetRef="confirmOrder"/>
  <bpmn:sequenceFlow id="s2" sourceRef="confirmOrder"     targetRef="Done"/>
</bpmn:process>
```

`fork` forks tokens down `f1` and `f2`; `join` waits for a token from **every** branch `fork` forked,
then produces one token onto `s1`. An `inclusiveGateway` split additionally carries a FEEL
`conditionExpression` on each out-flow (and an optional `default`); it activates the subset whose
conditions are true, and its matching `inclusiveGateway` join waits for exactly that recorded subset.

---

## 4. Profile & SESE validation (L1 — no runtime)

`parallelGateway` and `inclusiveGateway` move out of `DEFERRED_GATEWAY_REASONS` into
`SUPPORTED_NODE_TYPES` (mirroring `eventBasedGateway`'s M3 graduation); `complexGateway` stays rejected
with its existing roadmap reason. `parallelGateway`/`inclusiveGateway` are added to the multi-outgoing
allow-list in the linearity check (today only `exclusiveGateway`/`eventBasedGateway` may have >1 outgoing
token edge — validator.ts:867-878).

**Inclusive split** is subject to the same condition/default rules as `exclusiveGateway` (reuse the M2
check at validator.ts:935-968): every non-default out-flow MUST carry a non-empty FEEL condition (parsed
at publish), and the gateway may name one `default`. (Runtime zero-activation handling: §6.4.)

### 4.1 The SESE region validator (the load-bearing publish-time pass)

Block structure alone does **not** make the join barrier sound — a branch that loses its token to an
in-region end event or an escaping boundary redirect would deadlock the join. The validator therefore
enforces **strong single-exit** via dominators, per scope (process and each `transaction` independently;
flows already cannot cross a transaction boundary — validator.ts:773):

1. **Build a CFG.** Vertices = token-path nodes + each `transaction` as one vertex + error/cancel/timer
   boundary events (compensation boundaries/handlers are off the token path, excluded). Edges = every
   sequence flow, **plus** `activity → attached boundary` and `boundary → boundary-target` for each
   error/cancel/timer boundary. Add a virtual `SOURCE → scope-start` and `endEvent → virtual SINK` (every
   end event and any successor-less node connects to SINK).
2. **Dominators / post-dominators.** Compute `idom` from SOURCE and `ipdom` toward SINK (iterative
   Cooper-Harvey-Kennedy — ample at these graph sizes).
3. **Matched pair.** For each split `S` (`parallelGateway`/`inclusiveGateway`, >1 outgoing): `J := ipdom(S)`
   must be a gateway of the **same type** with >1 incoming and `idom(J) == S`; else reject naming `S`
   ("no matching join" / "single-entry violated"). The split↔join map must be a **bijection** (a join
   matched by two splits, or an unmatched multi-incoming parallel/inclusive gateway, is rejected).
4. **Region & strong single-exit.** `R(S,J) = { X : S dom X and J postdom X }`. Because the CFG includes
   the virtual SINK and boundary edges, `J postdom S` **automatically rejects** (a) a `none`/`cancel` end
   event inside the region (a path to SINK not through `J`) and (b) any boundary whose outgoing target
   leaves the region or reaches an end. With this, every activated branch delivers **exactly one** token
   to `J` — no liveness/reachability analysis is ever needed at runtime.
5. **Branch confinement.** Each branch is itself single-entry (the split out-flow) / single-exit (the join
   in-flow): every flow and every boundary redirect of a node in a branch MUST land in the **same branch
   sub-region**, and the branch's only edge back into the enclosing scope is its join in-flow. Reject any
   edge crossing into a sibling branch, into the split, or past the join, with element id. *(Blocker:
   without this the AND/OR-join silently mis-counts.)*
6. **No uncontrolled merge.** Inside a region, no node other than the matching join may have >1 incoming
   sequence flow, except an `exclusiveGateway` pass-through merge (single-token by XOR semantics). A
   service/receive task, intermediate catch, or end event with two incoming flows inside a region is
   rejected — concurrent branch tokens would execute it twice instead of synchronising.
7. **Laminar nesting.** Any two regions must be nested or disjoint; reject partial overlap.
8. **Cycles.** A loop may be wholly inside a single branch (it bumps occurrence as in M2) or wholly
   outside the region, but a sequence flow whose endpoints lie on opposite sides of a region boundary is
   rejected ("loop crosses the region of split S / join J").
9. **Transaction inside a branch.** Allowed; its internal SESE is validated by recursion. **Both** its
   exits — the normal outgoing and any cancel/error/timer boundary outgoing — must stay in-region and
   reach `J`; a transaction exit that leaves the region or reaches an end is rejected.
10. **Concurrent same-message rejection.** Within a region (and across regions that can be simultaneously
    active), no two branch catch points (`receiveTask`, message `intermediateCatchEvent`, or
    `eventBasedGateway` message branch) may reference the **same message name** — the broker permits one
    active subscription per `workspace+messageName+correlationKey`, so concurrent same-name waits would
    collide and incident the instance. Reject with the offending element ids. *(Blocker.)*
11. **Terminate stays rejected.** `terminate` end events remain out of scope (deferred); `EndKind` is not
    widened beyond `none | cancel`.

Region validation runs as a dedicated pass **after** the degree/linearity and gateway-condition passes,
emitting its own errors with element ids (not suppressed by unrelated prior errors); the existing
reachability BFS (validator.ts:1356) is retained as a backstop.

**Element-disjointness invariant.** SESE guarantees every element id belongs to at most one branch of at
most one enclosing region, so two concurrent tokens can never visit the same element. M4 therefore adds
**no token discriminator** to `uq_jobs_instance_element_kind`, `uq_saga_steps_forward`, or `uq_timers_visit`
— occurrence (per-element walk-local) remains sufficient. A publish-time test asserts no element is
reachable on two concurrent branches, so relaxing SESE later re-opens this debt deliberately.

---

## 5. Engine — token-frontier rewalk + multi-wait race (L2/L3)

### 5.1 The drive
The scalar `cur` becomes a **frontier**: the set of live token positions, reconstructed each drive by a
**deterministic depth-first traversal of the immutable graph from `startElementId`**, descending each
split's `outgoing[]` in stored document order (identical to the order `exclusiveGateway` evaluates
conditions). This order — never a SQL row order — is what keeps occurrence assignment and the
`Promise.race` array replay-stable. *(Blocker: token-processing order pinned to graph traversal, not
`execution_tokens` row order.)*

Per branch, the traversal fast-forwards already-applied visits **write-free** from the same append-only
facts as today (job `output_applied=1`, consumed subscription, fired timer, recorded `gateway_decisions`),
extended with the join facts below. A branch reaching a live wait (a job to dispatch then await, a message
catch, a timer) parks; a split not yet fanned out is fanned out; a branch reaching its join records arrival.

After the traversal the drive has a set of parked frontier waits and issues **one multi-wait**:
`Promise.race` over one `step.waitForEvent` per parked token. Any resolution → persist → **re-walk from
start**. Repeat until the frontier is empty.

### 5.2 Within-pass discipline (Cloudflare-Workflows blocker)
The rewalk loop runs inside one `run()` pass, so a naïve "re-walk from start" would re-invoke
already-completed `step.do` and still-parked `step.waitForEvent` by the **same name** within one pass —
which the platform does **not** guarantee to memoize within a pass. Therefore:

- Every `(element, occurrence)` whose work is recorded in D1 fast-forwards **write-free and MUST NOT call
  `runStep`** — extend the existing predicate set with the join facts (§5.4).
- Parked waits are held in an **in-memory `Map<stepName, Promise<WaitOutcome>>`** keyed by
  `wait*:elementId#occurrence`; a `waitForEvent` is created only for a parked token not already in the Map
  and reused otherwise; `Promise.race` iterates the Map's values. Each `waitForEvent` name is thus issued
  **at most once per `run()` invocation**.
- Each parked `waitForEvent` is **individually wrapped** (try/catch → `{kind:"timeout"}`, as the current
  `waitFor` does) before entering the race, so one branch's timeout settles only that slot and never
  rejects the race or strands siblings.
- Re-calling a step name is permitted **only across genuine Workflow replays** (`run` re-invoked), where it
  is memoized by name. The `Promise.race` winner's identity is **advisory**: on any resolution the engine
  re-walks and reconciles against canonical D1 (a winner already reflected in D1 is a no-op fast-forward),
  so the documented winner-flip-on-replay is harmless.
- A delivered event payload is applied to a parked token **only when its `workflowEventType` +
  `correlationKey` match that token's subscription at the live `(element, occurrence)`** — never
  positionally (today `driveReceiveTask` applies a `pending` event to the first receive node it reaches; M4
  makes this match-keyed).

### 5.3 Per-token staleness guards (blocker)
`process_instances.current_element_id` and `status` become **derived, inspection-only read-models** that
NO correctness guard reads. Every guard that today compares `inst.current_element_id` to an element id —
`planIntermediateCatchFire` (intermediate-timer.ts:209), `planEventGatewayTimerFire` (event-gateway.ts:583),
`parkWaiting` (incidents.ts:32) — is re-expressed as a **per-token predicate**: the timer/wake fires iff a
token at that `(element, occurrence)` is still `status='waiting'` and no decider row exists. (The
boundary-timer fire already does this correctly via the per-`(element,occurrence)` job/subscription row —
boundary-timer.ts:377,398 — the other two become symmetric.) `current_element_id` is the sole live token's
position when the frontier has exactly one token, **NULL** otherwise; inspection surfaces the frontier from
`execution_tokens` (§7). This guard migration lands in **L2**, before parallelism is enabled, so
single-token instances reduce to exactly one matching row and M1/M2/M3 behaviour is unchanged.

### 5.4 Splits, joins, and the append-only facts (blocker)
`execution_tokens` is **not** the replay predicate. Its `position_element_id` and `status` are a
denormalised read-model the rewalk recomputes each drive (for operator inspection and compensation cohort
capture; the `MAX_CONCURRENT_TOKENS` count is taken from the **in-memory reconstructed frontier**, §9, not
these rows); they are **never read as a replay-decision input** (occurrence assignment, join-fire, fan-out).
`variables_overlay` is
authoritative mutable state, made idempotent by the existing `output_applied` marker exactly like
`process_instances.variables` today. All fast-forward / barrier decisions consult **append-only facts**:

- **Split fan-out** is a single `dbBatch` that plain-`INSERT`s one `execution_tokens` row per activated
  branch (PK = deterministic `token_id`) and, for an inclusive split, the `gateway_decisions` activated-set
  row (§6); a concurrent duplicate fan-out aborts wholesale on the `token_id` PK and re-reads. On rewalk
  the activated branch set is derived from the static `outgoing[]` (AND — always all) or the recorded
  `gateway_decisions` subset (OR) — **never** from a `COUNT` over `execution_tokens`.
- **Branch arrival** at a join records `join_arrivals(instance_id, join_id, activation, branch_flow_id)`
  via `INSERT OR IGNORE` (duplicate arrival = no-op). The traversal **halts** on that branch — the join
  node is NOT entered and nothing downstream is walked from that branch, so the join and the post-region
  path are visited exactly **once per activation** (preserving `join.occurrence == region_activation`).
- **Join completion** is claimed by a single **plain `INSERT`** into
  `join_completions(instance_id, join_id, activation, produced_token_id)` composed into the **same
  `dbBatch`** as the merged-overlay write, the source tokens' transition to `status='merged'`, the
  produced token row, and the advance to the join's out-flow. A losing concurrent arrival's batch aborts on
  the PK and re-reads the recorded produced token. The required arrival count is read from persisted state
  — AND = `count(split.outgoing)`; OR = the recorded activated subset — never a live count. This is the
  exact `gateway_decisions` plain-INSERT race discipline (gateway-decisions.ts:70-84).

### 5.5 Token identity (blocker)
Three token-id forms, all replay-stable:
- **Root token:** `${instanceId}:#root` (`region_id`/`branch_flow_id`/`parent_token_id` NULL,
  `region_activation` 0).
- **Branch token:** `${instanceId}:${splitId}#${activation}:${branchFlowId}`, where `activation` is the
  **split gateway's walk-local occurrence** at the moment the walk enters the region (computed by the same
  in-memory counter as `MAX_ELEMENT_OCCURRENCES`, never a `COUNT` over `execution_tokens`; it naturally
  increments on each loop re-entry of the region). *(Blocker: `region_activation` = split occurrence.)*
- **Produced (post-join) token:** re-uses its `parent_token_id` — a SESE region consumes the parent token
  at the split and returns the frontier to exactly one token in the enclosing scope at the join. Token
  branch identity is therefore a **stack of `(region_id, region_activation, branch_flow_id)` frames**:
  entering a split pushes a frame, the matching join pops that activation's frames and restores the
  enclosing frame — so a nested region's join output satisfies its enclosing branch at the outer join.
  *(Mirrors the variables-overlay fold-up at region exit, §6.)*

`region_activation` and a branch element's own walk-local occurrence are **separate axes**: a cycle inside
a branch makes a branch element's occurrence exceed `region_activation`; the two are never conflated in any
key. Per-element persistence (jobs, subscriptions, `gateway_decisions`, `saga_steps`, timers) keeps keying
on each element's own occurrence.

### 5.6 Instance completion (blocker — last-token-out race)
A `none` end event marks its token `status='consumed'` in one batch that **also** runs a guarded terminal
transition conditioned on no other token being in a live status (`active|waiting|arrivedAtJoin`) — evaluated
against the drive's reconstructed frontier and committed via a conditional UPDATE whose rows-changed result
decides which single drive emits the terminal `completed` + end history event. The per-instance drive
serialization (§10) already prevents concurrent end events; the conditional UPDATE is the defensive
belt-and-suspenders so that even absent serialization they neither double-complete nor strand an empty
frontier. A `Hazard`/incident on any one token transitions the **whole instance** to
`incident` (sibling live tokens frozen in place); operator `/cancel` then runs the §8 straggler-catching
reverse pass over the recorded cohort.

### 5.7 Branch-local variables (blocker — read/write call sites)
Inside a region, variable resolution is **token-scoped**:
- **Reads** (FEEL flow conditions, `exclusiveGateway`/OR-split decisions, service-task job input, payload
  templating) resolve the token's `variables_overlay` chain — token overlay, then each ancestor token's
  overlay in order, terminating at root `process_instances.variables`, nearest wins. A gateway evaluated
  inside a branch records this **resolved** snapshot in `gateway_decisions.variables_snapshot`; the
  recorded decision is the fast-forward predicate and is never re-evaluated, so a sibling branch's writes
  never retroactively change a recorded branch.
- **Writes** (service-task output, applied message payload) go to the token's **own** overlay. Root
  `process_instances.variables` is mutated only by the join fold-up.
- Outside any region (frontier size 1) reads/writes resolve directly against root — preserving M0–M3
  behaviour. The specific call sites needing scope-aware resolution: `decideGateway` (engine.ts:519 reads
  `inst.variables`), `applyMessage`, and the forward-task output apply path (engine.ts:870 writes
  `applyTransitionStmt`).

**Deterministic merge at a join:** `produced.overlay` starts as a copy of the parent token's overlay; then
for each required branch token in **split out-flow document order** (the region map's stored
`branchFlowIds[]`), shallow-assign that branch's own top-level overlay keys (later branch overrides
earlier). The merge is **shallow** (top-level key union): concurrent writes to distinct sub-keys of the
same object variable resolve as last-writer-wins on the top-level key, and variable deletion is not
representable — identical to the engine's existing `mergeVariables()` semantics (a documented constraint,
not a regression; deep-merge is a separate post-M4 decision). An OR-join restricts the merge to the
`gateway_decisions`-recorded activated subset but preserves the stored order.

---

## 6. Inclusive (OR) gateway specifics (L4)

1. **Split activation.** The activated set = `{ flows whose FEEL condition is true }`, evaluated in
   document order against the token-resolved scope. The full evaluation and the explicit activated-flow set
   are recorded in `gateway_decisions`; on rewalk the recorded set is reused verbatim and never
   re-evaluated (same contract as `exclusiveGateway`).
2. **Schema.** `gateway_decisions.chosen_flow_id` cannot represent a multi-branch activation. Add an
   `activated_flow_ids` JSON column (the activated set in document order); for an inclusive split
   `chosen_flow_id` holds the document-order-first activated flow as a sentinel. (Migration delta in §7.)
3. **OR-join.** Waits for exactly the recorded activated subset, keyed by **origin branch** (§5.4), then
   merges and fires via the same `join_completions` claim.
4. **Zero activation.** If no condition is true: take the `default` flow (the activated singleton); with no
   default, raise the existing terminal **`noPath`** incident (a Hazard inside a transaction) — an
   inclusive split never silently drops its token. An OR-join whose recorded activated subset is empty
   produces its single output token immediately.

**Barrier keyed by origin branch, not incoming flow (blocker).** Each token carries the split out-flow it
descended from (`branch_flow_id`) for the region's lifetime; internal XOR routing and cycles do not change
it. A branch is "satisfied" the instant any token carrying its `branch_flow_id` reaches the join, on
whatever physical in-flow. This makes the strict `|out(S)| == |in(J)|` bijection unnecessary (an internal
XOR arm may point straight at the join). `docs/bpmn/03-gateways.md` is amended: "wait for a token on every
incoming flow" → "wait for a token from every activated branch of the matching split".

---

## 7. Persistence deltas (`migrations/0007_tokens.sql`)

Latest shipped migration is `0006_timers.sql`; no `execution_tokens` table exists. `0007` is additive.

```sql
-- Token frontier read-model (position/status NEVER a replay input; overlay is authoritative state).
CREATE TABLE execution_tokens (
  token_id            TEXT PRIMARY KEY,                 -- root: '<inst>:#root'; branch: '<inst>:<split>#<activation>:<branchFlow>'
  instance_id         TEXT NOT NULL,
  region_id           TEXT,                             -- enclosing split id; NULL for root
  region_activation   INTEGER NOT NULL DEFAULT 0,       -- split's walk-local occurrence; 0 for root
  parent_token_id     TEXT,                             -- token consumed at the split; NULL for root
  branch_flow_id      TEXT,                             -- split out-flow taken; NULL for root/produced
  position_element_id TEXT NOT NULL,                    -- DERIVED read-model; not a replay input
  status              TEXT NOT NULL DEFAULT 'active',   -- active|waiting|arrivedAtJoin|consumed|merged|discarded
  variables_overlay   TEXT NOT NULL DEFAULT '{}',       -- JSON delta over parent; or {"__r2":"<key>"}
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_tokens_instance_status ON execution_tokens (instance_id, status);
CREATE INDEX idx_tokens_region          ON execution_tokens (instance_id, region_id, region_activation, status);

-- Append-only join facts (the actual replay predicates).
CREATE TABLE join_arrivals (
  instance_id TEXT NOT NULL, join_id TEXT NOT NULL, activation INTEGER NOT NULL,
  branch_flow_id TEXT NOT NULL, arrived_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, join_id, activation, branch_flow_id)            -- INSERT OR IGNORE
);
CREATE TABLE join_completions (
  instance_id TEXT NOT NULL, join_id TEXT NOT NULL, activation INTEGER NOT NULL,
  produced_token_id TEXT NOT NULL, decided_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, join_id, activation)                            -- PLAIN INSERT in the advance batch
);

-- Inclusive-split activation set (single chosen_flow_id cannot represent a subset).
ALTER TABLE gateway_decisions ADD COLUMN activated_flow_ids TEXT;           -- JSON array, document order; NULL for XOR/EBG
```

`process_instances.current_element_id` is retained as a **nullable, denormalised representative position**
(the sole live token's position when frontier = 1, NULL otherwise); not authoritative for any wake
decision (§5.3). No backfill is required for existing M1/M2/M3 instances — they have a single implicit
root token, materialised lazily on the next drive.

The region map (publish-time topology) persists `{ splitId → { joinId, type: 'and'|'or', branchFlowIds[]
(document order), enclosingScopeId } }` alongside the existing element topology, so the deterministic merge
order and the OR-join wait set never recompute order from the live graph.

---

## 8. Compensation of parallel branches (L5 — straggler-catching)

The existing reverse pass (`runCompensation` in `compensation.ts`, `selectScopeStepsForCompensation
ORDER BY seq DESC` re-scan) **is** the straggler catcher; M4 tightens its barrier, terminator, and ordering
predicates. All within the locked straggler-catching decision.

### 8.1 Cohort capture & teardown
Reaching a `cancel` end (or an uncaught Hazard) anywhere inside scope `X`, or operator `/cancel`, is a
**scope-wide event**. The engine records the live-token cohort (`execution_tokens` for `X`), then in the
transition into `compensating` it abandons every cohort token's in-flight forward job *only as far as
arming a terminator* (§8.2), cancels every cohort token's armed boundary timer, **releases every cohort
token's active broker subscription**, and discards any region join-barrier state wholly inside `X`. A
half-satisfied join never fires: `arrivedAtJoin` tokens are treated as consumed (steps already ledgered);
in-flight tokens get terminators; the branch-local overlays of unmerged branches are **discarded**, never
folded into the enclosing scope.

> **Operator `/cancel` must NOT eagerly fail region jobs (blocker).** Today `handleCancelInstance`
> (index.ts:366) calls `abandonActiveForwardJobs`, flipping `locked` jobs to `failed` so a late `complete`
> gets a 0-row no-op — which would **leak** an executed side-effect (no ledger row → never compensated),
> contradicting decision 5. In M4, a forward job belonging to a live region cohort token is left in place
> with a terminator armed (§8.2) so its late `complete` lands as a straggler. Only genuinely never-leased
> or lease-expired jobs are discarded. The single-token (non-region) M1 path may retain eager abandon for
> behaviour-compatibility.

### 8.2 Guaranteed per-token terminator (blocker — barrier-hang)
The quiescence barrier MUST never depend on a future `/jobs/activate` poll. At cancel the engine arms a
terminator for **every** live cohort token by sub-state:
- **Never-leased job** (`created`, attempt 0): its already-armed `JobScheduler` DLQ activation alarm MUST
  fire even while the instance is `compensating` (relax `terminateUnleasableJob`'s
  `inst.status==='compensating'` early-return for cohort jobs) → `failed` → token `discarded`.
- **In-flight leased job** (`locked`): arm a **new per-job lease-expiry alarm** at `lock_expires_at` (today
  reclaim is poll-only inside `leaseOnce`) → on fire, if still un-completed, `locked → failed` → token
  `discarded`; else no-op.
- **Completed-but-unapplied job:** ledger synchronously at the cancel scan → token `consumed` (no timer).
- **Token parked at a message/timer catch:** swept synchronously when its subscription/timer is cancelled
  → `discarded` (a pure wait owes no compensation).
- **Token inside a committed nested sub-transaction:** excluded (`committed`).

### 8.3 Straggler-ledger-insert in the compensating drive (blocker — premature settle)
On any drive while `compensating`, **before** the reverse pass, scan cohort tokens whose forward job is now
`completed` but unledgered, write their `saga_steps` row (`INSERT OR IGNORE`, `seq=MAX+1`, status pending)
and flip the token to `consumed`. The reverse pass returns `compensated` **only** when no `saga_steps` row
for the scope is in `(pending|compensating|failed)` **AND** `execution_tokens` holds no scope token in a
live status. If the ledger is drained but cohort tokens remain, the pass parks (`waiting`) on the
terminators — so a late straggler is always ledgered and compensated before the terminal transition.

### 8.4 Reverse order per causal chain (blocker — Principle VI)
Strict global reverse-seq is wrong across a causal chain: a straggler downstream of an already-compensated
predecessor **in the same branch** would otherwise be compensated *after* it. Therefore the reverse pass is
gated on **lineage quiescence**: a completed step is eligible for compensation only when its token lineage
(via `parent_token_id`) has **no live (`active|waiting`) descendant token** (`selectScopeStepsForCompensation`
gains an EXISTS-anti-join against `execution_tokens` on the lineage). When a lineage quiesces, its steps
compensate in strict descending `seq` — so a causally-downstream straggler is always compensated before its
predecessor. **Cross-branch order is unconstrained** (concurrent branches have no happens-before relation).

`saga_steps.seq` is assigned **once** at `INSERT OR IGNORE` (deduped by `(instance,element,occurrence)`) and
is an ordering field only — it MUST NOT appear in any step name or persistence key (compensation steps stay
keyed `comp-create/comp-done:elementId#occurrence`). Under parallel branches it is seeded by completion
order; the per-instance drive serialization invariant (§10) makes it a strict total order with no
collisions.

### 8.5 Generalised cohort capture
Any terminal forward transition that strands a frontier — `serviceTaskFailure`, `poison`, `loopLimit`,
`concurrencyLimit`, `compensationFailure`, `stepBudget` — captures the live-token cohort exactly as
scope-cancel does; late completes for cohort tokens ledger-but-don't-advance, fail/lease-expiry discards. A
join whose required branch set can no longer be satisfied never fires, and because the instance is already
terminal this is not a wedge (covered by an integration test).

---

## 9. Status lifecycle, incidents, limits

- **Status enum:** no new instance statuses (`running|waiting|compensating|compensated|compensationFailed|
  cancelled|completed|incident` suffice); only the completion rule changes (frontier-empty, §5.6).
- **`MAX_CONCURRENT_TOKENS = 256`** (new, in `src/runtime/engine.ts`). Caps the number of `execution_tokens`
  in a **live** status (`active|waiting|arrivedAtJoin`); `consumed|merged|discarded` do not count. Counted
  from the **walk-local reconstructed frontier** during the deterministic rewalk (in-memory, like
  `MAX_ELEMENT_OCCURRENCES`), **never** a live `COUNT` over `execution_tokens` (else the incident fires
  nondeterministically on replay). Evaluated at each split fan-out; exceeding it settles a terminal
  **`concurrencyLimit`** incident, claimed once. Independent of `MAX_ELEMENT_OCCURRENCES = 1000` (which
  bounds visits per element): nested splits multiply the frontier, and a split inside a loop accumulates
  un-merged tokens across activations — both bounded by the token cap; whichever cap is crossed first
  during a rewalk settles its incident.
- **`STEP_BUDGET_SOFT` (≈20000)** + `wrangler.jsonc` workflows `limits.steps = 25000`. The platform
  hard-errors the instance at the step ceiling (an opaque errored Workflow, violating the "view-only
  incident" invariant). The engine maintains a per-instance cumulative `runStep`/`waitForEvent` counter and
  settles a terminal **`stepBudget`** incident at the soft budget (< the platform ceiling). Forward steps
  of all live tokens, in-region loops, and the reverse-compensation pass must jointly fit; the three caps
  (`MAX_CONCURRENT_TOKENS`, `MAX_ELEMENT_OCCURRENCES`, step budget) enforce this together.
- **New incident kinds** `concurrencyLimit` and `stepBudget` are added to the `IncidentKind` union
  (`src/persistence/instances.ts`) **and** the `openapi.yaml` `Incident.kind` enum **simultaneously**
  (`check:docs` guard #5 enforces equality).

### 9.1 Cloudflare-Workflows state & event budget
- Cumulative persisted Workflow state is bounded by **step count** (small outputs), not payload size:
  payloads crossing the event channel (`sendEvent`/`waitForEvent`) MUST be **small envelopes**
  (`messageId`, `correlationKey`, a D1/R2 reference); the engine resolves the body from D1/R2 inside a
  `step.do`. `step.do` return values stay element-id/cursor-sized.
- `variables_overlay` and the resolved scope chain live in **D1** (`execution_tokens`), explicitly out of
  Workflow step outputs. An overlay exceeding `OVERLAY_INLINE_MAX_BYTES` (measured via `payloadByteSize`)
  is stored in R2 under the deterministic key `overlays/${instanceId}/${tokenId}.json` (written before the
  D1 commit — deterministic key makes crash-retry byte-identical) with the column holding
  `{"__r2":"<key>"}`. A new R2 binding is introduced in L6 (none today).
- At a join the **merged** overlay is checked against `MAX_EVENT_PAYLOAD_BYTES` before it is written to
  `process_instances.variables` or delivered; on exceed, raise the existing `serviceTaskOutputRejected`/
  poison incident path — never a silent truncation.
- Under these constraints `MAX_CONCURRENT_TOKENS = 256` is within the ~1 GB cumulative-state cap.

### 9.2 Per-token wait fan-in
Each parked frontier token contributes exactly one `step.waitForEvent` to the race, but a parked
`eventBasedGateway` token additionally holds up to *M* broker subscriptions + 1 armed timer, and a parked
message catch holds one subscription (+ optional boundary timer). Simultaneous subscription/timer count is
bounded by `MAX_CONCURRENT_TOKENS × per-token branch fan-out`; L6 sizes the step and DO/subrequest budgets
against that product. The broker's single-active-subscription-per-key invariant guarantees one `sendEvent`
resolves exactly one parked wait (§4 rule 10 forbids the colliding model at publish).

---

## 10. Drive serialization (blocker — direct-mode seq collision)

All engine drives for one instance are **serialized**: in Workflow mode by the single Workflow instance; in
direct mode (the entire CI harness — `vitest.config.ts` forces `EXECUTION_MODE=direct`) by a **per-instance
drive lock** (a D1-backed advisory lock, or routing all callbacks through one coordinating point). `seq` is
assigned strictly monotonically under this serialization; concurrent branch completions apply one drive at a
time, so no two `saga_steps` rows for an instance share a `seq` and the reverse pass `ORDER BY seq DESC` is a
strict total order. Real parallelism is **worker-side only** (decision 3); the engine never drives one
instance concurrently. The `saga.ts` docstring ("true completion order") is updated to "deterministic
serialized walk-order rank; equals completion order within a causal chain, not across concurrent branches".

---

## 11. API & observability deltas (L6)

- **`GET /instances/{id}`** gains a `tokens` array, each `{ tokenId, positionElementId, status, regionId,
  regionActivation, branchFlowId, parentTokenId, variablesOverlay? }`, read from `execution_tokens` (D1,
  never Workflow state). `currentElementId` is retained for single-token instances and is null when >1
  token is live (the `tokens` array is authoritative). `contracts/openapi.yaml` + the contract test are
  updated in lockstep (governance gate). Large overlays return by R2 reference.
- **`GET /instances/{id}/history`** stays globally ordered by insertion (rowid = deterministic single-
  threaded rewalk order). History events emitted inside a region carry `tokenId`, `regionId`,
  `regionActivation` in their `diagnostics` JSON (no new column); the join's merge event records the
  contributing branch token ids. Clients reconstruct a per-branch timeline by filtering on `diagnostics.tokenId`.
- **Operator `/cancel`** is **frontier-wide**: abandons every cohort token's in-flight job (terminator-armed,
  §8.2), cancels every armed timer, releases every active broker subscription before entering
  `compensating`. No live broker subscription may survive a cancel (else the key leaks). **`/retry`**
  re-drives by reconstructing the frontier from `execution_tokens` (fast-forwarding applied splits/joins/
  branch steps write-free) rather than re-forking any split; the `compensationFailed → compensating` edge
  resumes the reverse pass over the cohort.
- New history event types (free-text `history_events.type`): `regionActivated`, `branchForked`,
  `branchArrivedAtJoin`, `joinCompleted`, plus per-token `spanId` in `diagnostics`. No schema change.

---

## 12. Governance & docs (L1 + L6)

- **Constitution `2.2.0 → 2.3.0` (MINOR), amended first.** Sync Impact Report. Principle I's accepted set
  widens with `parallelGateway` (AND) and `inclusiveGateway` (OR), **block-structured (SESE) only**, with
  the no-custom-notation / XSD-valid / round-trippable clause unchanged; `complexGateway` and `terminate`
  end stay excluded. MVP-scope exclusion trims `parallel`/`inclusive` from the gateway line.
- **Principle VI amendment (blocker):** compensation runs in reverse order of completion **within each
  causal chain (a token lineage)**; order **between concurrent branches is unconstrained**; a straggler
  completing after a parallel scope began compensating is still ledgered and compensated (at-least-once,
  idempotent) and, within its lineage, before any causally-earlier step. Pair with the **multi-token
  completion rule** (frontier-empty completion). The at-least-once/idempotent clauses are unchanged.
- **`specs/002-saga-orchestrator`:** M4 deltas folded into `spec.md`, `plan.md`, `data-model.md` (the §7
  tables), `contracts/{openapi.yaml, runtime-contracts.md}` (tokens array, new incident kinds); a new
  `m4-constitution-check.md` (two-gate record mirroring `m3-constitution-check.md` — Before-Phase-0 against
  v2.2.0, After-Phase-1 against v2.3.0, per-principle confirmation).
- **`docs/bpmn`:** `07-execution-semantics.md` flips parallel/inclusive from "out (M4)" to shipped;
  `03-gateways.md` join wording amended (origin-branch keyed, §6); `09-easy-bpmn-profile.md` moves
  parallel/inclusive from "Still deferred" to the supported set, `DEFERRED_GATEWAY_REASONS` pointer flip in
  lockstep.
- **`check:docs` guards:** add `MAX_CONCURRENT_TOKENS` and `STEP_BUDGET_SOFT` to the constant-sync guard
  (engine source ↔ docs/bpmn ↔ specs/002, like `MAX_ELEMENT_OCCURRENCES`); flip the gateway-reference guard
  so parallel/inclusive are "shipped" (the flip lands in the same commit as the profile change);
  `IncidentKind` ↔ openapi enum equality covers the two new kinds.

---

## 13. Hardening ledger (blocker → resolution → owning layer)

| # | Blocker (lens) | Resolved in | Layer |
|---|----------------|-------------|-------|
| 1 | Scalar `current_element_id` fire-guards strand parallel tokens | §5.3 per-token predicates | **L2** |
| 2 | Token-processing order not replay-stable | §5.1 deterministic DFS in document order | L2/L3 |
| 3 | `region_activation` derivation | §5.5 = split's walk-local occurrence | L3 |
| 4 | Join barrier lacks atomic claim | §5.4 `join_completions` plain-INSERT in advance batch | L3 |
| 5 | Re-walk re-invokes steps within one `run()` pass | §5.2 write-free fast-forward + in-memory step Map | L2/L3 |
| 6 | SESE doesn't kill OR-join reachability | §4.1 strong single-exit via post-dominators + virtual SINK | **L1** |
| 7 | Barrier key ambiguous (by-branch vs by-flow) | §6 origin-branch keyed; doc 03 amended | L3/L4 |
| 8 | Quiescence barrier hangs (no terminator) | §8.2 per-token terminators | L5 |
| 9 | Reverse pass settles prematurely on empty ledger | §8.3 ledger-empty AND tokens-terminal predicate | L5 |
| 10 | Principle VI violated within a causal chain | §8.4 lineage-quiescence-ordered reverse | L5 |
| 11 | `execution_tokens` conflates facts + mutable state | §5.4/§7 read-model vs append-only join facts | L2 |
| 12 | `token_id` undefined for root/post-join token | §5.5 three id forms + frame stack | L3 |
| 13 | Boundary redirect escapes the branch | §4.1 rule 5 branch confinement | **L1** |
| 14 | Two branches on same `messageName` collide on broker key | §4.1 rule 10 publish rejection | **L1** |

**Majors also folded in:** instance-completion last-token-out race (§5.6), individually-wrapped waits +
advisory winner + match-keyed payload (§5.2), step-budget incident (§9), small event envelopes + R2 overlay
offload + join-time 1 MiB bound (§9.1), per-instance drive serialization + seq monotonicity (§10),
forward-incident generalised cohort capture (§8.5), uncontrolled-merge rejection (§4.1 rule 6), inclusive
zero-activation default/noPath (§6.4), shallow-merge documented constraint (§5.7), mid-branch FEEL
overlay-chain reads (§5.7), nested-region token-identity stack (§5.5), frontier-wide operator verbs (§11),
inspection `tokens` array + history token tags (§11), `activated_flow_ids` for OR replay (§6/§7),
element-disjointness invariant for unchanged unique indexes (§4.1), manual Workflow-mode validation matrix
(§14).

---

## 14. Testing & exit criteria

Integration tests mirror M2/M3 patterns; CI is `EXECUTION_MODE=direct`. Because every multi-wait /
suspend-resume / step-budget behaviour lives only in Workflow mode, a **manual Workflow-mode validation
matrix** (wrangler dev + a deployed instance) is a **blocking Definition-of-Done gate before L3 and L5
close**, with results recorded in the L6 quickstart. Minimum scenarios:

**Direct-mode integration (CI):**
- AND split/join: 3 branches run, join waits for all, instance completes on empty frontier.
- OR split/join: only true-condition branches activate; join waits for exactly them; default branch;
  zero-activation → `noPath`.
- Branch-local vars: branches write own scope; merge at join deterministic (document order); same-key
  collision = later-in-order wins; sibling write does not leak before join.
- Nested regions: inner join output satisfies the enclosing branch at the outer join.
- Parallel transaction: business error in one branch → cancel → reverse-compensation of completed steps
  across all branches, lineage-ordered; straggler completing after cancel ledgered + compensated;
  quiescence barrier holds until terminal.
- Replay/rewalk (direct re-drive): the same frontier reconstructs; occurrence/`region_activation`
  deterministic; a nested loop inside a branch bumps element occurrence while `region_activation` stays
  stable.
- Validator: unbalanced / mismatched-join-type / non-SESE / boundary-escaping / uncontrolled-merge /
  cross-region-cycle / same-message-name region all rejected with element ids; `complexGateway` and
  `terminate` rejected.
- Caps: `MAX_CONCURRENT_TOKENS` → `concurrencyLimit`; a join whose required branch is terminal never wedges.

**Manual Workflow-mode matrix (DoD gate, L3 & L5):**
1. Two parallel message catches, deliver A then B → each applies exactly once, join proceeds, no
   duplicate-step-name error.
2. Crash/restart mid-race after delivering A → re-walk fast-forwards A write-free, re-races B, no re-apply.
3. Deliver A and B near-simultaneously then force replay → identical final state regardless of race winner.
4. One branch times out while a sibling is live → no `unhandledRejection`, sibling completes.
5. In-region loops approaching the budget → graceful `stepBudget`/`concurrencyLimit` incident, not an
   opaque errored Workflow.
6. Cancel a region with parked + in-flight straggler branches → quiescence barrier + per-causal-chain
   reverse-seq ordering across suspend/resume.

---

## 15. Risks

- **R-engine:** the token-frontier refactor touches the heart of `engine.ts`. Mitigated by **L2** shipping
  it behind a no-op (single-token = a 1-element frontier; the `current_element_id` guard migration lands
  here too) before any split is enabled.
- **R-replay-determinism:** occurrence/`region_activation`/merge/frontier must be deterministic across
  replays — pinned to in-memory walk-local counters and document order everywhere; covered by replay tests.
- **R-cf-multiwait:** concurrent `waitForEvent` + within-pass re-walk are only partially testable in
  direct mode — the §14 manual matrix is the only place they are exercised (a DoD gate, not optional).
- **R-state-budget:** parallel × loops × reverse pass multiply steps and state — three independent caps
  (§9) + small event envelopes + R2 overlay offload; the worst-case multiplication is documented next to
  the workflows config.
- **R-governance:** unqualified "reverse-order" in Principle VI would contradict the multi-token
  implementation — the §12 amendment redefines it per causal chain before any runtime ships.

---

## 16. Open questions (deferred, tracked)

- **Deep variable merge:** shallow top-level merge is the M4 contract (matches `mergeVariables`); deep merge
  / per-sub-key concurrent writes are a separate post-M4 decision if a real model needs them.
- **`inclusiveGateway` join with an upstream loop re-activating the region** while a prior activation is
  still merging — forbidden by §4.1 rule 8 (no region-crossing cycle) for M4; a future relaxation would
  need a per-activation barrier already keyed by `region_activation`.
- **Signal/broadcast fan-out to multiple waiting branches** (the same-message-name case §4.1 rule 10
  rejects) is deferred to M5 (signal semantics), not solved by broker fan-out (which would break the locked
  single-subscription-per-key architecture).
- **Drive lock implementation for direct mode** (§10): D1 advisory lock vs single coordinating point — an
  L2 implementation choice, not a semantic one.

---

## 17. Layer roadmap & backlog mapping

Mirrors the M3 per-layer slicing (TASK-38..47 → L0–L5). M4 continues L1–L6 layering; each layer opens its
constructs and ships their runtime, governance amended first.

| Layer | Scope | Carries blockers |
|-------|-------|------------------|
| **M4-L1** | Governance 2.3.0 (Principle I + VI + multi-token completion) + Sync Impact; profile flip (parallel/inclusive → supported, complex/terminate rejected); **SESE region validator** (post-dominators, strong single-exit, branch confinement, bijection, laminar nesting, no-uncontrolled-merge, cycle/transaction/boundary rules, same-message rejection, inclusive condition/default rules, element-disjointness test). **No runtime.** | 6, 13, 14 |
| **M4-L2** | Graph IR (`parallelGateway`/`inclusiveGateway` nodes + region map); `0007_tokens.sql` (`execution_tokens` read-model + `join_arrivals` + `join_completions` + `gateway_decisions.activated_flow_ids`); **token-frontier engine refactor** (single-token = 1-element frontier, no behaviour change); **migrate all `current_element_id` staleness guards to per-token lookups**; `current_element_id` → derived nullable; per-instance **drive serialization** (direct-mode lock); in-memory step-name Map + write-free fast-forward extended to token statuses. | 1, 2, 5, 11 |
| **M4-L3** | `parallelGateway` AND: atomic fan-out claim; multi-wait `Promise.race` (wrapped, dedup by step name, advisory winner, match-keyed payload); join barrier (`join_arrivals`/`join_completions`); frontier-empty completion (atomic last-token-out); branch-local scopes + deterministic merge-at-join; `region_activation` = split occurrence; token-id forms + nested-region frame stack. | 2, 3, 4, 7, 12 |
| **M4-L4** | `inclusiveGateway` OR: split activation recorded in `gateway_decisions` + `activated_flow_ids`; OR-join waits for recorded subset (origin-branch keyed); zero-activation default/`noPath`; empty-activated immediate produce. | 7 |
| **M4-L5** | Compensation of parallel branches: cohort capture + scope-wide teardown; per-token terminators (DLQ-while-compensating, lease-expiry alarm); straggler-ledger-insert in compensating drive; lineage-quiescence-ordered reverse; quiescence barrier (ledger-empty AND tokens-terminal); operator `/cancel` non-eager-abandon for region cohort + frontier-wide sweep; half-satisfied-join cancel; generalised forward-incident cohort capture; Principle VI per-causal-chain runtime. | 8, 9, 10 |
| **M4-L6** | `MAX_CONCURRENT_TOKENS` + `concurrencyLimit`; `STEP_BUDGET_SOFT` + `stepBudget` + `limits.steps=25000`; R2 binding + overlay offload + join-time 1 MiB bound; small event envelopes; observability (per-token spans, history token tags); inspection `tokens` array + openapi/contract updates; docs/bpmn 03/07/09 + `check:docs` guards; manual Workflow-mode validation matrix; quickstart scenarios; epic closure. | — |

**Next step after this design:** `writing-plans` for the M4 implementation plan, then slice the M4 backlog
tasks per L1–L6 above.
