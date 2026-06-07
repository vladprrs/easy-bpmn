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
| **Parallel (AND)** | consume 1, produce 1 on *every* out flow | **wait for 1 on every** in flow, then produce 1 |
| **Inclusive (OR)** | produce 1 on each out flow whose condition holds | wait for all tokens that *can still arrive*, then produce 1 |
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
callbacks/messages, and atomic "apply payload + advance" writes. (On Cloudflare this maps naturally to a
**Durable Object** per instance — single-threaded, transactional storage. See
[`08-engines-and-extensions.md`](./08-engines-and-extensions.md).)

## Error, escalation, compensation, transactions (advanced — out of MVP)

For completeness; none are in the MVP.

- **Error**: a thrown error searches *outward* for a matching error boundary event / error event
  sub-process. Unhandled ⇒ the (sub)process fails. Errors are always interrupting.
- **Escalation**: like an error but may be **non-interrupting**; used for "notify, but keep going."
- **Compensation**: after an activity has *successfully completed*, a compensation trigger runs its
  registered compensation handler to *undo* it (e.g. "refund the charge"). Handlers run in reverse
  order of completion.
- **Transaction sub-process**: groups work with all-or-nothing semantics. A **cancel end** inside it
  triggers a **cancel boundary** event, which runs compensation for completed activities and rolls the
  scope back.

## Audit history

Every key transition should be recorded (constitution, Principle V): instance start, current-element
changes, service-task invocation/result, receive-task wait, message correlation, completion, and
errors. Operators inspect status, current element, variables, and history. History is also what makes
replay/debugging tractable.

---

## `easy-bpmn` execution model (MVP)

A single token walks a straight line:

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

No concurrency (no parallel tokens), no branching (no gateways), no timers, no boundary events. Every
arrow is an audited, replay-safe, idempotent transition. That constrained model is precisely what makes
the MVP *provably* durable. See [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).
