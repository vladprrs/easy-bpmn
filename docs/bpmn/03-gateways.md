# 03 — Gateways

A **gateway** controls how tokens **branch** and **merge**. Drawn as a **diamond**; the inner symbol
says which kind. A gateway is a *split* when it has multiple outgoing flows, a *join* (merge) when it
has multiple incoming flows. The same element type is used for both — meaning depends on direction.

> Gateways do **not** do work. They are pure routing. (Compare: a *conditional sequence flow* from a
> task does data-based routing without a gateway — see [`04-flows-and-data.md`](./04-flows-and-data.md).)

## The five gateway types

| Gateway | Symbol | XML element | Split behavior | Join behavior |
|---------|--------|-------------|----------------|---------------|
| **Exclusive (XOR)** | `X` (or empty diamond) | `exclusiveGateway` | Take **exactly one** outgoing flow — the first whose condition is true (else the `default`). | Pass through each arriving token immediately (no waiting). |
| **Parallel (AND)** | `+` | `parallelGateway` | Take **all** outgoing flows (fork). | **Wait** for a token on *every* incoming flow, then emit one (synchronize). |
| **Inclusive (OR)** | `O` (circle) | `inclusiveGateway` | Take **all** outgoing flows whose condition is true (≥1; else `default`). | Wait for all tokens that *could still arrive* on incoming flows, then merge. |
| **Event-based** | pentagon in double circle | `eventBasedGateway` | **Supported (M3-L4)**: wait, then take the path of whichever **event** (message catch / timer) happens *first*. | (Used as a split only; ≤1 timer branch.) |
| **Complex** | `*` | `complexGateway` | Custom split/merge via an `activationCondition` expression. | Custom synchronization. Rarely used; poorly supported. |

### Exclusive (XOR) — `exclusiveGateway`
Data-based decision: evaluates outgoing flows' `conditionExpression`s **in order** and takes the first
true one. Define a `default` flow (gateway attribute `default="flowId"`) for the "else" case to
guarantee one path is always taken.

```text
        ┌──[ amount > 1000 ]──→ Manual review
( X )───┤
        └──[ default ]────────→ Auto approve
```

### Parallel (AND) — `parallelGateway`
- **Split**: forks one token into N (one per outgoing flow). No conditions are evaluated.
- **Join**: blocks until *all* incoming flows have delivered a token, then emits one. This is the
  classic "wait for both branches to finish."

> A common deadlock: an AND-join waiting for a branch that an upstream XOR-split never activated.
> Match split/merge types.

### Inclusive (OR) — `inclusiveGateway`
- **Split**: takes *every* outgoing flow whose condition is true (so 1..N branches activate).
- **Join**: the tricky one — it must wait for exactly the tokens that the corresponding split
  produced, which requires the engine to reason about which upstream paths are still "live."

### Event-based gateway — `eventBasedGateway`
Routing by **occurrence**, not data. Its outgoing flows lead to **catching events** (or receive tasks):
message catch, timer, signal, conditional. The instance waits; whichever fires **first** wins, the
others are cancelled.

```text
                ┌──→ ◎(message) ──→ Process reply
( evt-based )───┤
                └──→ ◎(timer 24h) ──→ Escalate
```
Classic "wait for reply OR timeout." Must be followed *only* by catching events / receive tasks.

### Complex gateway — `complexGateway`
For routing logic the others can't express (e.g. "proceed when 2 of 3 branches arrive"). Driven by an
`activationCondition`. Avoid: it's hard to read and many engines (incl. Camunda) don't support it.

## Split / merge cheat sheet

| You want… | Use |
|-----------|-----|
| One of several paths (decision) | Exclusive (XOR) split + Exclusive join |
| All paths in parallel | Parallel (AND) split + Parallel join |
| Some paths based on conditions | Inclusive (OR) split + Inclusive join |
| Whichever external event comes first | Event-based gateway |
| Merge alternative paths without sync | Exclusive join (or just point flows at the same node) |

## Gateways and `default` flow

`exclusiveGateway` and `inclusiveGateway` (and forking activities) may name a **default** outgoing flow
via the `default` attribute. The default has *no* condition and is taken only when no other condition
is true — preventing "stuck token / no path" errors.

---

## `easy-bpmn` scope

**The exclusive (XOR) gateway is IN scope since M2** (constitution v2.1.0, conditional sagas). What
M2 executes, anywhere a token node can appear (process level and inside a `transaction`):

- **`exclusiveGateway`** — data-driven **split** (1 in, N out) and **pass-through join** (N in, 1 out;
  no waiting). A 1-out gateway is a pass-through/merge and needs no conditions.
- **FEEL conditions** — every **non-default** outgoing flow of a split MUST carry a
  `conditionExpression` (`tFormalExpression`, FEEL, evaluated via `feelin` with Camunda-compatible
  semantics). Conditions are FEEL-parsed at publish; evaluated at runtime in **document order**, first
  `true` wins. FEEL null-tolerance is standard semantics: a missing variable makes a comparison
  `null` → not `true` → flow not taken (not an error).
- **`default` flow** — the gateway-owned no-match fallback (`default="flowId"`); MUST reference one of
  the gateway's own outgoing flows and MUST NOT carry a condition. No `true` condition + no default →
  terminal incident `kind=noPath` (a **Hazard** inside a transaction: no auto-compensation; operator
  `/cancel` is available).
- **Cycles on the token path** — loops back through an XOR gateway are legal; each iteration is
  discriminated by an **occurrence** counter (jobs, ledger rows, subscriptions, branch decisions).
  A walk-local counter exceeding `MAX_ELEMENT_OCCURRENCES = 1000` → terminal incident
  `kind=loopLimit`.
- **Audit/replay** — every gateway visit persists a `gateway_decisions` row atomically with the
  transition; crash/replay reuses the recorded branch, never re-evaluates.

Conditions live **only** on flows leaving an `exclusiveGateway`: a `conditionExpression` on any other
flow (the "conditional sequence flow from a task" pattern above) and any implicit split (>1 outgoing
flow on a non-gateway node) are still **rejected** before publish with element id + reason.

Of the other gateway types, `eventBasedGateway` is **supported since M3-L4** (the timer/message race,
below); the remaining three stay out of scope, each rejected before publish with a user-visible reason
and its roadmap pointer (kept in lockstep with `DEFERRED_GATEWAY_REASONS` in `src/bpmn/profile.ts`):

| Gateway | Status |
|---------|--------|
| `parallelGateway` | Deferred to **M4** (concurrency) — AND-splits need multiple concurrent tokens. |
| `inclusiveGateway` | Deferred to **M4** (concurrency) — OR-splits activate multiple branches at once. |
| `eventBasedGateway` | **Supported since M3-L4** (TASK-46) — races timer/message branch catches and routes on the first event to occur (≥2 branches, every target a single-incoming intermediate catch, ≤1 timer branch, distinct messages). |
| `complexGateway` | Not on the roadmap; deferred to a later milestone. |

See [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md) for the full profile (validation rules,
runtime mapping) and `docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md` for the M2
design.
