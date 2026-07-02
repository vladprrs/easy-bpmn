# 07 — Execution Semantics

How a BPMN process *runs*. The spec defines this with a **token** model. Understanding it is what
separates "drawing flowcharts" from "building an engine."

## The token model

- A **token** represents a thread of control — "the process is *here* right now."
- A **start event** **creates** a token.
- A token **moves** along sequence flows from node to node.
- A node may **consume** an incoming token and **produce** one or more outgoing tokens.
- An **end event** **consumes** a token.
- When an instance has **zero remaining tokens**, the **instance completes**.

Multiple tokens can exist at once (after a parallel split), which is how BPMN models concurrency within
one instance.

## Instance lifecycle

```text
created → active → (waiting ⇄ active)* → completed
                              ↘ terminated (terminate end / cancel)
                              ↘ incident/failed (unhandled error)
```

| State | Meaning |
|-------|---------|
| **Active** | At least one token is moving / work is executing. |
| **Waiting (wait state)** | All live tokens are parked at catch points (receive task, message/timer catch, event-based gateway). The instance is **durably persisted** and consumes no compute until something external arrives. |
| **Completed** | No tokens remain; ended normally. |
| **Terminated** | A terminate end event (or transaction cancel) discarded all tokens. |
| **Failed / incident** | An error reached the top with no handler. |

> **Wait states are the whole point of a durable engine.** Between a receive task arriving and the
> message coming back, there's nothing to run — the engine must persist the position and variables, and
> resume *exactly once* when the trigger fires. This is `easy-bpmn`'s reason to exist (constitution,
> Principle III).

## Node execution rules

### Tasks
- The token enters; the work runs; on completion the token leaves via the outgoing flow.
- **Service task**: invoke the implementation (worker). In `easy-bpmn`, **persist the worker's output
  variables *before* advancing** the token — so a crash after the call but before the advance replays
  safely.
- **Receive task / message catch**: a **wait state**. Token parks until a correlated message arrives.

### Events
- **Start**: create token, instantiate.
- **Throwing intermediate** (signal/message/escalation/link): emit, continue immediately.
- **Catching intermediate**: wait for trigger, then continue.
- **End**: consume token. **Terminate** end is special — it discards *all* tokens in the instance
  immediately (and in the enclosing scope), forcing instant completion.

### Gateways
| Gateway | Split (multiple out) | Join (multiple in) |
|---------|----------------------|--------------------|
| **Exclusive (XOR)** | consume 1 token, produce 1 on the first flow whose condition is true (else default) | pass each token straight through (no sync) |
| **Parallel (AND)** | consume 1, produce 1 on *every* out flow | **wait for 1 from every activated branch** of the matching split, then produce 1 |
| **Inclusive (OR)** | produce 1 on each out flow whose condition holds | wait for 1 from every **activated branch** of the matching split (the recorded subset), then produce 1 |
| **Event-based** | park; the **first** event to fire wins; cancel the rest | — |

**Deadlock & token-leak hazards** (relevant once gateways are in scope):
- AND-join waiting on a branch a XOR-split never produced ⇒ **deadlock**.
- XOR-join after an AND-split ⇒ **token leak** (extra tokens flow through, work runs twice).
- Rule of thumb: pair each split with a matching join type.

## Messages & correlation

A catching message event / receive task is satisfied only by a message that **correlates** to *this*
instance.

- **Message vs signal**: a *message* targets **one** instance (by correlation); a *signal* is a
  **broadcast** to all matching catchers.
- **Correlation** = picking which waiting instance an incoming message belongs to. Engines correlate by
  message name + a key derived from instance variables.
- **`easy-bpmn` rule (constitution, Principle IV):** correlate by **`messageName` + `correlationKey`**
  to **exactly one** eligible waiting instance. Missing / ambiguous / duplicate / late messages MUST
  have **deterministic** outcomes and clear API responses. Applying the payload MUST be **atomic** with
  the transition that resumes the instance.

## Idempotency & durability (engine-builder essentials)

The hard part of a workflow engine isn't the happy path — it's *exactly-once effects over an unreliable
world*. `easy-bpmn` requires (constitution, Principle III):

- **Replay-safe transitions.** Every state transition can be re-attempted without corrupting state.
- **Idempotent service calls.** A retried worker call / duplicate callback must not double-apply output
  or double-advance the token.
- **Idempotent messages.** A duplicate or late external message must not resume an instance twice.
- **Persist-before-advance.** Worker output is persisted before the token moves on.

Common implementation tools: a monotonic per-instance version/sequence, dedup keys on
callbacks/messages, and atomic "apply payload + advance" writes. (On Cloudflare this maps to **one
Cloudflare Workflow per process instance** for durable execution, plus a **single Durable Object
correlation broker** — keyed by `workspaceId + messageName + correlationKey` — as the strongly
consistent serialization point for message correlation; D1 stays the canonical store. See
[`08-engines-and-extensions.md`](./08-engines-and-extensions.md).)

## Error, escalation, compensation, transactions

`easy-bpmn` status: **error, compensation, and transaction are IN since M1** (the transaction-saga
profile — see [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md)); **escalation remains out of
scope** (rejected before publish).

- **Error**: a thrown error searches *outward* for a matching error boundary event / error event
  sub-process. Unhandled ⇒ the (sub)process fails. Errors are always interrupting. (`easy-bpmn` M1:
  error boundary events on saga steps route a business failure to the cancel end event.)
- **Escalation**: like an error but may be **non-interrupting**; used for "notify, but keep going."
  (`easy-bpmn`: out of scope.)
- **Compensation**: after an activity has *successfully completed*, a compensation trigger runs its
  registered compensation handler to *undo* it (e.g. "refund the charge"). Handlers run in reverse
  order of completion. (`easy-bpmn` M1: compensation boundary events + `isForCompensation` handlers
  wired by `association`.)
- **Transaction sub-process**: groups work with all-or-nothing semantics. A **cancel end** inside it
  triggers a **cancel boundary** event, which runs compensation for completed activities and rolls the
  scope back. (`easy-bpmn` M1: `bpmn:transaction` is the saga container.)

## Audit history

Every key transition should be recorded (constitution, Principle V): instance start, current-element
changes, service-task invocation/result, receive-task wait, message correlation, completion, and
errors. Operators inspect status, current element, variables, and history. History is also what makes
replay/debugging tractable.

---

## `easy-bpmn` execution model

The MVP happy path — a single token walks a straight line:

```text
none start  → create token, persist instance (bound to definition version)
            → token to Service Task
serviceTask → call remote worker (RPC-like); on result, PERSIST output vars, then advance
            → token to Receive Task
receiveTask → WAIT STATE: persist & park. External system POSTs message.
            → correlate by messageName + correlationKey to this one instance (atomic apply + advance)
            → token to End
none end    → consume token; no tokens left ⇒ instance completed
```

The engine stayed **single-token at runtime through M3**, but the line is no longer straight: **since M1**
the token may pass through a `bpmn:transaction` whose steps carry **boundary events**
(error/cancel/compensation — an interrupting boundary *redirects* the token, it never forks it),
**since M2** it may **branch and loop through an XOR `exclusiveGateway`** (FEEL conditions, default
flow, occurrence-counted cycles — the token takes exactly one outgoing flow), and **since M3** it may
**wait on timers and message intermediate catches and race them through an `eventBasedGateway`**.
**Since M4** a block-structured `parallelGateway` (AND) / `inclusiveGateway` (OR) region runs as
**genuine multi-token concurrency** (constitution v2.3.0): the engine maintains a **token frontier** —
the set of live token positions inside one instance — reconstructed each drive by the same
re-walk-from-start as M2, now descending every split's out-flows in document order. The runtime
mechanics (shipped across M4-L2…L6):

- **Split (fan-out).** The parent token is consumed and one **branch token** is produced per activated
  out-flow — an AND split takes **all** out-flows; an OR (`inclusiveGateway`) split takes the subset
  whose FEEL conditions are true (≥1, else the gateway-owned `default`, else terminal `noPath`). The
  branches' jobs all become leasable at once, so external workers run them **concurrently** (real
  parallelism is worker-side; the engine itself never drives one instance concurrently).
- **Single wake.** Each drive re-walks the frontier and fast-forwards already-applied visits write-free;
  all parked tokens share **one** replay-stable `bpmn_wake` tickle (TASK-54) instead of a `Promise.race`
  over per-token `step.waitForEvent`s. Any token's external event (worker callback, message correlation,
  timer fire) fires that single wake, and the drive re-walks from start and reconciles against canonical
  D1. (The shrinking-membership multi-`waitForEvent` race was the L6.6 hang TASK-54 replaced.)
- **Join (synchronise).** An **AND-join** waits for a token from **every activated branch**; an
  **OR-join** for exactly the recorded activated subset — keyed by the token's **origin branch**
  (the split out-flow it descended from), not by physical in-flow. The join merges the joined branches'
  **branch-local variable overlays** in split out-flow **document order** (shallow; later-in-order wins
  on a key conflict), then produces one token onto the join's outgoing flow.
- **Completion.** The instance completes when the **frontier is empty** (every token consumed at an end
  event) — not when a single cursor reaches an end. A Hazard/incident on any one token freezes its live
  siblings in place and transitions the whole instance.
- **Compensation.** Cancelling a parallel scope catches stragglers and compensates **per token lineage**
  (causal chain) in reverse — ordering **between** concurrent branches is unconstrained (they have no
  happens-before relation). A late `complete` after cancel still ledgers its step and is compensated.
- **Caps.** A split fan-out exceeding `MAX_CONCURRENT_TOKENS = 256` live tokens settles a terminal
  `concurrencyLimit` incident; a per-drive step counter crossing `STEP_BUDGET_SOFT = 20000` (below the
  platform `limits.steps = 25000` ceiling) settles a graceful `stepBudget` incident. See the profile and
  constants in [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).

**Since M5-L1** the engine composes scopes: a plain embedded `subProcess` nests with `transaction` in
either order (subProcess-in-tx, tx-in-subProcess, tx-in-tx), up to `MAX_SCOPE_DEPTH = 8`. The runtime
mechanics:

- **Typed scope hierarchy.** The compiled graph carries a static `scopes` map — one entry per non-process
  scope, keyed by its element id, recording `kind` (`"transaction" | "subProcess"`), `parentId` (`null` at
  the process root), and `depth`. It is computed once at publish from the immutable definition version,
  never recomputed from live state during a Workflow replay. All hierarchy questions — a scope's
  **subtree** (itself + every descendant), its **nearest enclosing transaction** (walking the parent chain
  inclusive), a transaction's **owned scopes** (itself + descendants not passing through another
  transaction), and **strict-ancestor** tests — are pure functions over this map.
- **`MAX_SCOPE_DEPTH = 8`** (in `src/runtime/engine.ts`) bounds scope nesting depth. Because M5-L1 scope
  depth is fully static (no `callActivity`, no `multiInstance` yet), the cap is enforced **at publish** by
  the validator (element id + reason) — a fail-closed, zero-runtime-surface check. A future dynamic-depth
  layer (call chains) will need a runtime incident instead; M5-L1 does not.
- **Bookkeeping scope entry/exit.** A `subProcess` node is a walk-local bookkeeping visit — entering it
  writes a `scopeEntered` history event (mirroring `enterTransaction`), its inner none end writes
  `scopeExited`, and neither touches the saga ledger. A `transaction` still opens a ledger scope exactly as
  before; commit semantics generalize per the shield below.
- **The two-tier commit shield.** A ledger row is sealed **terminal** (`committed`) only when the
  **outermost** transaction enclosing its committing transaction commits. A **nested** transaction's commit
  (one with an enclosing transaction) flips only its **owned** scopes' rows to a non-terminal
  `committedLocal` — still eligible for compensation, but only under a compensation root that is a
  **strict ancestor** of the committing transaction. This shields a `committedLocal` row from its **own**
  transaction re-cancelling on a **later occurrence** (an M2 cycle re-entering the same nested
  transaction), while remaining reachable to an **ancestor**'s cancel (or operator `/cancel`, root = the
  process). For a top-level, single-scope transaction this collapses byte-for-byte to the pre-M5
  `pending|compensating|committedLocal → committed` flip — the M1–M4 no-op fast path is unchanged.
- **The root-relative reverse cursor.** Compensating root `R` (a nested cancel end, a top-level cancel end,
  or operator `/cancel` with `R` = the process root) selects every `saga_steps` row whose scope is in
  `subtree(R)` and whose status is `pending`/`compensating`/`failed`, **or** `committedLocal` **and**
  eligible — i.e. its nearest enclosing transaction has `R` as a strict ancestor. `seq` is monotonic **per
  instance** (not per scope, as before M5-L1), so `ORDER BY seq DESC` over this set yields true
  bottom-up, reverse-chronological order across nested scopes with no extra ordering machinery — a single
  compensation pass interleaves rows from different nested scopes correctly.
- **Two-phase cancel.** Cancelling scope `R` is (1) an interrupt/drain phase over `subtree(R)` — a
  completed forward job still in flight is ledgered (never lost), a `created`/`locked` job is drained via
  the existing lease-expiry terminators armed subtree-wide, and the live-token barrier holds until the
  subtree quiesces — then (2) the reverse pass over the cursor above. A **cancel end inside a nested
  transaction** compensates only `subtree(T)`; the instance then **continues running** on the cancel
  boundary's outgoing (failure) path in the parent scope — a **non-terminal** settle. Only a **top-level**
  transaction's cancel end, or an operator `/cancel` (root = the process), settles the instance terminally
  (`compensated`, or saga-failed on `compensationFailed`).
- **Hierarchical error bubbling.** An uncaught error — from a service task, or from an **error end event**
  (`endEvent` + `errorEventDefinition`, also new in M5-L1) — searches for a catching boundary by walking
  the **attachment chain** outward: boundaries on the throwing element's own scope first, then boundaries
  on each enclosing scope in turn, applying the existing exact-`@errorCode` → catch-all precedence at every
  level. The walk exhausting at the process root with no catch is a Hazard: a terminal incident (worker
  errors keep `serviceTaskFailure`; an uncaught error end event settles the new kind `uncaughtError`) —
  no auto-compensation (Principle VI unchanged).
- **Hazard-vs-Cancel on a scope catch.** A **non-cancel** interrupting catch on scope `B` — an error
  boundary, or a scope-hosted boundary **timer** firing — runs phase 1 (drain `subtree(B)`, retaining
  completed effects as `pending`/`committedLocal` rows) but runs **no reverse pass**: Principle VI reserves
  compensation for a transaction Cancel, never an uncaught error or a non-cancel timer. A fired scope timer
  defers its subtree drain to the **next engine rewalk** (idempotent, retain-only) rather than draining
  inside the fire transition, so the fire batch stays a single atomic persist-before-advance write; a
  plan-time guard (`ancestorScopeExitedAfterEntry`) makes a stray fire of an already-drained descendant
  scope's timer a no-op. The retained effects remain reachable: a **later** cancel of an enclosing
  transaction, or operator `/cancel`, walks the exited subtree via the reverse cursor above and compensates
  them then. See [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md) for the modeling guidance (route a
  rollback-intended timer to a cancel end **inside** the transaction — that is Cancel, not Hazard).

Every arrow is an audited, replay-safe, idempotent transition. That constrained model — multi-token,
**block-structured (SESE)** concurrency, and (since M5-L1) an arbitrarily nested but statically bounded
scope tree — is precisely what makes the engine *provably* durable. See
[`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).
