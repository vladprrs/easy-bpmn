# M4 Constitution Check (pre-implementation, against constitution v2.3.0)

**Milestone**: M4 — Concurrency (`parallelGateway` AND, `inclusiveGateway` OR, token frontier, AND/OR joins, parallel-branch compensation)
**Recorded**: 2026-06-13 (M4-L1 governance opener, TASK-48)
**Constitution version checked against**: **v2.3.0** (this amendment — Principle I widened with the block-structured M4 concurrency set; Principle VI redefined per causal chain + multi-token completion)
**Spec source**: [`docs/superpowers/specs/2026-06-13-m4-concurrency-design.md`](../../docs/superpowers/specs/2026-06-13-m4-concurrency-design.md)
(approved brainstorming-design output, hardened by a multi-lens adversarial review; the M4 source artifact for
the amendment, the specs/002 deltas, and the Backlog TASK-27 epic slicing into L1–L6 / TASK-48..53).

This record satisfies the Development-Workflow gate ("Plans MUST pass the Constitution Check before Phase 0
research and again after Phase 1 design") for M4. The project's operating mode since M2 is
brainstorming-design → backlog slicing rather than a full Spec Kit `plan.md`; the design doc above **is**
the spec/plan source for M4 (the same recorded deviation from `plan.md:7` that M3 documented, not laundered
as precedent). Both gate checks are mapped onto that flow below.

## Two required gate checks (mapped onto the M4 brainstorming-design flow)

- **Before Phase 0 (design intake):** the M4 scope — block-structured parallel/inclusive concurrency, the
  token frontier, the AND/OR join, and parallel-branch compensation — was checked against constitution
  **v2.2.0** at intake. Result: the accepted set under v2.2.0 did **not** include `parallelGateway` /
  `inclusiveGateway` (Principle I listed only `exclusiveGateway` and `eventBasedGateway` as accepted
  gateways), so the profile-widening layers L1–L4 require an amendment **first** (Principle I's "amend the
  constitution before widening the profile" ordering). That requirement is what this L1 governance task
  discharges. The runtime layers (L2 token foundation; L3 AND; L4 OR; L5 compensation) are gated behind it.
- **After Phase 1 (design hardening → this amendment):** re-checked against the amended **v2.3.0**. The
  amended Principle I now lists the M4 set as accepted, **block-structured (SESE) only**; the validator
  opens publish-time acceptance in this very layer (L1), while the concurrency runtime opens per layer
  (L2–L5) — the **documented interim state** (constitution Principle I note + `docs/bpmn/09-easy-bpmn-profile.md`),
  not a violation. Result: **PASS** — see the Complexity-Tracking note below for the one design choice
  worth recording (the SESE restriction).

## Per-principle confirmation for the M4 set

- **I. Standard BPMN Profile Only — PASS.** `bpmn:parallelGateway` and `bpmn:inclusiveGateway` are standard
  BPMN 2.0 flow nodes. They are accepted **block-structured only**: a publish-time pass (design §4.1) builds
  a per-scope CFG with a virtual SOURCE/SINK and boundary edges, computes dominators/post-dominators, and
  matches each split to its post-dominating join of the **same type** (single-entry via dominance, bijection
  enforced), proving strong single-exit; non-SESE, branch-escaping, mismatched-join, uncontrolled-merge, and
  non-laminar regions are rejected with the offending element id. The only additive binding stays
  `easy-bpmn:taskDefinition` — no new construct introduces notation; files stay XSD-valid and round-trip
  through bpmn-js/Camunda Modeler when `easy-bpmn` + DI are ignored. `complexGateway` (not on the roadmap)
  and the `terminate` end event stay rejected pre-publish with element id + reason.
- **II. Immutable Definitions / Version-Bound Instances — PASS / N/A.** M4-L1 adds no migration path and no
  version mutation. The SESE region map (split↔join topology, branch order in document order) is computed at
  publish and persisted in the immutable version's `parsed_profile` (graph IR), so later layers never
  recompute split↔join matching or branch order from a live graph — reinforcing, not relaxing, the
  immutable-version contract. (The L2 `0007_tokens.sql` migration is additive and version-neutral.)
- **III. Durable, Idempotent Execution — PASS.** This layer ships **no runtime** — only publish-time
  accept/reject and the graph-IR `regions` record change; `parseAndValidate` is a pure, deterministic
  function of the document. The concurrency runtime that lands in L2–L5 keeps every existing durability
  invariant (persist-before-advance; a deciding row claimed by a plain `INSERT` in the advance batch — now
  `join_completions` for the join barrier; at-least-once-safe replay via write-free fast-forward), as the
  design's §5/§7/§13 blockers 1–5/11 require. Nothing in L1 weakens it.
- **IV. Correlation and Receive Task Integrity — PASS.** The at-most-one-active-subscription-per-broker-key
  invariant (`workspace + messageName + correlationKey`) is **protected at publish** by the M4 same-message
  rejection pass (blocker 14, design §4.1 rule 10): two branch catch points (`receiveTask` / message
  `intermediateCatchEvent`) that can be concurrently active inside a region and reference the **same** message
  name are rejected with their element ids, so concurrent same-name waits can never collide at runtime.
  Single-branch message correlation is unchanged.
- **V. Auditability and Operator Clarity — PASS.** Every region rejection states what happened, which element
  (the split, join, or offending member id), and why (no matching join / mismatched type / branch escape /
  uncontrolled merge / non-laminar nesting / same message). Instance inspection is unchanged this layer; the
  per-token `tokens` inspection array + history token tags land in L6 (design §11). No Workflow internals are
  exposed.
- **VI. SAGA / Compensation Integrity — PASS (amended).** The reverse-order compensation requirement is
  redefined **per causal chain (a token lineage)** — ordering between concurrent branches is unconstrained,
  and a straggler completing after a parallel scope began compensating is still ledgered and compensated
  (at-least-once, idempotent) and, within its lineage, before any causally-earlier step. A **multi-token
  completion rule** is added: an instance completes only when zero tokens remain in its frontier. The
  at-least-once / idempotency / Cancel-only-trigger / Hazard-does-not-compensate / `compensationFailed`
  clauses are **unchanged** — only the ordering qualifier changes, because concurrency makes a single global
  completion order ill-defined (design §8/§12, blocker 10). This governance amendment **leads** the L5
  compensation runtime (the Principle-I ordering applied to Principle VI); L1 itself adds no compensation
  behaviour.

## Complexity Tracking

The M4 amendment introduces in-instance concurrency to the profile; the one design choice worth recording
against the Development-Workflow gate is the bounded form chosen.

| Design choice (added scope) | Why needed | Rejected (richer) alternative |
|---|---|---|
| **Block-structured (SESE) parallel/inclusive only** | A balanced split↔join region admits a publish-time post-dominator soundness proof (every activated branch delivers exactly **one** token to its join — no runtime liveness/reachability analysis), preserves the engine's **element-disjointness** invariant (so `uq_jobs_*` / `uq_saga_steps_*` / `uq_timers_*` stay unchanged — occurrence remains sufficient), and makes the AND/OR merge order deterministic (branch document order). | **Free (arbitrary-graph) concurrency** — maximally expressive but unsound by default (a branch can lose its token to an in-region end or escape via a boundary redirect, wedging the join), requiring runtime reachability analysis and a token discriminator on the unique indexes. |

Framed in the gate's own terms: **SESE block-structure is the rejected-simpler-alternative to free
concurrency** — i.e., the design deliberately adopts the simpler bounded subset (SESE) and rejects free
concurrency as the richer-but-unsound option. Free concurrency stays out of scope and would require its own
future amendment (and a deliberate re-opening of the element-disjointness debt — design §4.1).

Result: **PASS** — no unresolved violation; the SESE restriction is a scope bound, not a principle deviation.
