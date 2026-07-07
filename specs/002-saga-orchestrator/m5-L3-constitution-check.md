# M5-L3 Constitution Check (pre-implementation, against constitution v2.5.0)

**Milestone**: M5-L3 — `multiInstanceLoopCharacteristics` (data-driven fan-out: parallel and sequential
multi-instance on `serviceTask`/`subProcess`/`callActivity`; the persisted `mi_activations` activation
decider; per-iteration execution keyed by `iterationIndex`; `completionCondition` early settle with
non-compensating cancel-remaining; output aggregation by index; per-iteration compensation via the
`miBody` scope; the body-aware `MAX_MI_CARDINALITY` cap; the step-free park mitigation)
**Recorded**: 2026-07-06 (M5-L3 governance opener, Task 1)
**Constitution version checked against**: **v2.5.0 (unchanged — no new amendment for this layer)**. The
whole M5 composition set, including `multiInstanceLoopCharacteristics`'s Principle I accepted-construct
clause (parallel and sequential, standard `loopCardinality`/FEEL or an `easy-bpmn:multiInstance`
collection binding — never the standard data-binding attributes), and the pre-recorded
`MAX_MI_CARDINALITY` cap, was accepted **up front** by the single M5 amendment recorded at the M5-L1
opener. M5-L3 only **opens the runtime** for that already-recorded clause — the design doc's own
governance note states this explicitly ("this layer opens the runtime; no constitution bump — only the
per-layer Constitution Check … and the lockstep doc sync (M5-L1/L2 precedent)").
**Spec source**: [`docs/superpowers/specs/2026-06-20-m5-composition-design.md`](../../docs/superpowers/specs/2026-06-20-m5-composition-design.md)
(the 5-layer decomposition, adversarially hardened) §6 M5-L3 (the five gating decisions: parallel +
sequential both in v1, the cardinality-source choice + its dedicated rejects, `completionCondition` with
non-compensating cancel-remaining, MI-callActivity fan-out reusing the M5-L2 child triad, and
by-index output aggregation) +
[`docs/superpowers/specs/2026-07-06-m5-l3-multiinstance-design.md`](../../docs/superpowers/specs/2026-07-06-m5-l3-multiinstance-design.md)
(the M5-L3 layer design, referenced below as "spec §N" — where more specific than the decomposition doc,
the layer design wins for M5-L3, per its own front matter, mirroring the M5-L1/L2 precedent), and the
implementation plan
[`docs/superpowers/plans/2026-07-06-m5-l3-multiinstance.md`](../../docs/superpowers/plans/2026-07-06-m5-l3-multiinstance.md).

This record satisfies the Development-Workflow gate ("Plans MUST pass the Constitution Check before Phase 0
research and again after Phase 1 design") for M5-L3. As with M3/M4/M5-L1/M5-L2, the project's operating mode
is brainstorming-design → backlog slicing rather than a full Spec Kit `plan.md`; the two design docs above
**are** the spec/plan source for M5-L3 (the same recorded deviation from `plan.md:7` that M3, M4, M5-L1, and
M5-L2 documented, not laundered as precedent). Both gate checks are mapped onto that flow below.

## Two required gate checks (mapped onto the M5-L3 brainstorming-design flow)

- **Before Phase 0 (design intake):** the M5-L3 scope — `multiInstanceLoopCharacteristics` (parallel and
  sequential) on `serviceTask`/`subProcess`/`callActivity`, FEEL cardinality/collection, `completionCondition`,
  output aggregation, and per-iteration compensation — was already checked against constitution **v2.5.0**
  at the M5-L1 opener: the amendment accepted the **whole** M5 composition set up front, naming MI's
  Principle I accepted-construct clause and pre-recording `MAX_MI_CARDINALITY` as this layer's cap by name,
  while leaving the *runtime* "accepted-in-governance, interim-rejected-at-publish" until this layer opens it
  (constitution Principle I MVP-scope paragraph; `docs/bpmn/09-easy-bpmn-profile.md` interim markers). No
  further amendment is required before design work on this layer — the recorded v2.5.0 clause is the intake
  checkpoint, exactly the ordering the M5-L1 and M5-L2 records established for their own layers.
- **After Phase 1 (design hardening → this layer design):** re-checked against the **same** v2.5.0. The
  layer design (spec, all sections) stays within the recorded clause — no new BPMN construct beyond
  `multiInstanceLoopCharacteristics` itself, no widened correlation surface (the v1 MI-subProcess body
  whitelist in spec §7 narrows, rather than widens, what publish accepts inside an MI body), no relaxation
  of the constitution's permanent data-binding / no-cardinality-source rejects. Result: **PASS** — see
  Complexity Tracking below for the deliberate v1 narrowings worth recording.

## Per-principle confirmation for the M5-L3 layer

- **I. Standard BPMN Profile Only — PASS.** `multiInstanceLoopCharacteristics` (parallel and sequential) was
  accepted by the v2.5.0 M5 amendment and is now opened at the validator by this layer (spec §7), on
  exactly the three body kinds the constitution's accepted set covers: `serviceTask`, `subProcess`,
  `callActivity` (MI on a `transaction`/`receiveTask`/any other activity stays permanently rejected).
  Cardinality is sourced from **exactly one** of the standard `loopCardinality` (number-valued FEEL) or the
  `easy-bpmn:multiInstance` extension element (`collection`/`elementVariable`/`outputVariable` FEEL); both
  present is a publish reject (ambiguous), neither present is the constitution's own **permanent** "no
  recognized cardinality source" reject. The standard data-binding attributes (`loopDataInputRef` /
  `loopDataOutputRef` / `inputDataItem` / `outputDataItem`) are the constitution's dedicated **permanent**
  reject — not `flowElements`, so the generic whitelist never reaches them, and silent acceptance would drop
  per-iteration binding — and `complexBehaviorDefinition` / `oneBehaviorEventRef` / `noneBehaviorEventRef`
  (non-`All` behavior) are likewise rejected (behavior=`All`-only, Complexity Tracking below).
  `standardLoopCharacteristics` is discriminated by `$type` and carries its own permanent reject message.
  `easy-bpmn:multiInstance` is **ordinary extension content** inside the standard
  `<bpmn:extensionElements>` escape hatch — no new MODEL-namespace tag, no redefinition of a standard
  element's runtime meaning; the only additive binding otherwise stays `easy-bpmn:taskDefinition`.
  `camunda:`/`zeebe:` MI attributes (e.g. `zeebe:inputCollection`) remain tolerated-and-ignored as extension
  content, but a camunda/zeebe-only cardinality source without a recognized one still rejects (no silent
  zero-run). Every accepted file stays XSD-valid and round-trips through a standard modeler when `easy-bpmn`
  extensions and Diagram Interchange are ignored. `escalation`, `signal`, and the event subprocess
  (`triggeredByEvent="true"`) all stay **interim-rejected** with their own M5-L4/L5 roadmap pointers — this
  layer widens the validator by exactly one construct.
- **II. Immutable Definitions / Version-Bound Instances — PASS (untouched by this layer).** M5-L3 introduces
  no new version-binding surface: MI-over-`callActivity` reuses the M5-L2 `calledElement` resolution
  unchanged — the pinned `calledDefinitionVersionId` recorded in the caller's derived `parsed_profile` at the
  caller's own publish time — with an `iterationIndex` threaded through the existing child-triad plumbing
  (`childInstanceIdFor` / `insertChildInstanceStmt` / `getChildInstanceForVisit` /
  `markChildOutputAppliedStmt`, all already parameterized on it). No migration path and no version mutation
  are added by MI.
- **III. Durable, Idempotent Execution — PASS (this is where the recorded cross-instance-idempotency
  discipline extends to a second dimension).** The `mi_activations` row (migration 0009) is the
  `gateway_decisions` analogue: cardinality/collection are FEEL-evaluated **once**, written
  persist-before-advance in the same batch as the `miActivated` history event, and never re-evaluated — the
  rewalk fast-forward predicate for the whole MI visit. `settled_kind`/`settled_count` is the once-only
  early-completion decider; `output_applied` is the aggregation apply-once flip, the exact analogue of the
  existing `output_applied=1` / `matched_subscription_id` triad. Migration 0009 widens the unique indexes on
  `service_task_jobs` and `saga_steps` to `(…, occurrence, iteration_index)` — the `child_instances`
  precedent from M5-L2, extended in place — so duplicate worker callbacks, duplicate child creates, and
  duplicate parent wakes at a given iteration remain single-apply exactly as at iteration `0` today; non-MI
  writes keep `iteration_index = 0` and are byte-identical to pre-L3 behavior (no data change, no double-
  advance risk introduced for existing instances).
- **IV. Correlation and Receive Task Integrity — PASS / N/A, verbatim (this layer's deliberate scope
  narrowing keeps it trivially sound).** MI introduces **no new correlation construct** and does not touch
  the message-correlation broker; the message-name-plus-correlation-key invariant is unchanged. The **v1
  MI-subProcess body whitelist** (spec §7; Complexity Tracking below) rejects `receiveTask` / message
  `intermediateCatchEvent` / `eventBasedGateway` anywhere inside an MI body, for the same reason the M5-L2
  call-tree message-wait reject exists: N concurrent iterations racing for the same broker key would collide
  against the one-subscription-per-broker-key invariant, and a v1 reject keeps this principle sound by
  construction rather than by a new per-iteration correlation-key derivation scheme.
- **V. Auditability and Operator Clarity — PASS.** New D1 history events (`miActivated`,
  `miIterationCompleted`, `miCompletionConditionMet`, `miCompleted`, per spec §3/§8) record every meaningful
  MI transition; iteration steps are ordinary `saga_steps`/`service_task_jobs`/`child_instances` rows
  (`(el, occ, i)`-keyed), independently inspectable with no new storage class. `GET /instances/{id}`'s
  existing `lineage` block gains `iterationIndex` on child rows (spec §8) — the D1-only inspection invariant
  holds, no Cloudflare Workflow internal is exposed. Every publish-time reject (data bindings, ambiguous or
  missing cardinality source, non-`All` behavior, MI-subProcess body-whitelist violations, `MAX_MI_CARDINALITY`
  overflow at activation) states the offending element id and reason.
- **VI. SAGA / Compensation Integrity — PASS (this is where the M5-L1 scope-subtree generalization takes
  runtime effect for iterations).** Each MI activity contributes a `miBody` `ScopeMeta` (spec §5) — the
  single addition that lets the shipped M5-L1 subtree machinery (reverse cursor, straggler cohort,
  live-token barrier, `drainScopeSubtree`) see iterations with **no algorithm change**: iteration ledger rows
  carry `scope_id = el` and stay `pending` on miBody NORMAL completion (byte-for-byte the shipped subProcess
  behavior — only an enclosing transaction commit flips statuses), compensating in reverse `seq` order only
  when an enclosing transaction later cancels. `completionCondition`'s cancel-remaining is a **NORMAL,
  non-compensating frontier discard** of the N−k live iterations (abandon in-flight jobs, cascade-cancel
  live iteration children, mark remaining iteration tokens `discarded`) — explicitly **never**
  `ledgerStragglers`, so no spurious compensation jobs are created for iterations that never ran. The
  Cancel-only-trigger, Hazard-does-not-auto-compensate, idempotent, and at-least-once clauses are unchanged:
  a Hazard timer boundary on the MI activity interrupts via the same `drainScopeSubtree` retention drain
  (finished iterations' `pending` rows retained for a later operator `/cancel`), never auto-compensating. A
  committed MI-callActivity iteration compensates by driving that iteration's child instance's own reverse
  pass, reusing the M5-L2 child-compensation mechanism per iteration index unchanged.

## Complexity Tracking

Four design choices are worth recording against the Development-Workflow gate as **deliberate v1 scope
narrowings** — not deviations from an existing constitutional guarantee, and not widenings of the
already-recorded v2.5.0 clause — made at layer-design time (design doc wins over decomposition doc where
more specific, per its own front matter, mirroring the M5-L1/L2 precedent).

| Refinement | What the decomposition doc said | What M5-L3 does instead | Why |
|---|---|---|---|
| **(a) MI-subProcess body whitelist** | Decomposition §6 M5-L3 does not enumerate an MI-body construct whitelist; it treats MI-over-`subProcess` as reusing the L1 scope machinery generically ("MI-over-`subProcess` needs L1"). | The layer design **narrows** what is legal inside an MI body (spec §7): only `serviceTask`, `exclusiveGateway` (conditions/default/cycles), intermediate **timer** catch, none/error end events, and error/timer/compensation boundaries **on inner tasks** are accepted, each its own reject with element id + reason. Rejected in v1: `receiveTask` / message catch / `eventBasedGateway` (the broker-key collision across concurrent iterations — the M5-L2 message-wait precedent), nested `subProcess` / `transaction` / `callActivity` / nested MI, and `parallelGateway` / `inclusiveGateway` (the frontier DFS does not recurse under the MI sub-walk in v1). Rich bodies are the MI-over-`callActivity` story instead — the called process is fully general, since L2's own publish rules already validate it independently. | Extending the message-correlation broker or the frontier DFS to recurse under a dynamic, runtime-cardinality sub-walk in the same layer that also introduces the `mi_activations` decider and the body-aware cap would compound two unproven mechanisms at once. A v1 whitelist keeps Principle IV (broker-key single-subscription) and the SESE frontier discipline trivially sound with zero new surface, while still reaching every exit criterion (parallel/sequential fan-out, `completionCondition`, per-iteration compensation) through the serviceTask/callActivity bodies plus a restricted subProcess body. Richer bodies are a fast-follow once this layer is validated on real Cloudflare, the same incremental-hardening discipline M3/M4/M5-L2 applied to their own riskiest mechanisms. |
| **(b) Compensate-the-MI-as-a-unit: deferred** | Decomposition §6 M5-L3 decision 3 describes only per-iteration compensation ("`miBody` NORMAL completion does not mark finished iterations `committed`... compensate reverse-by-index"); it does not address a compensation boundary hosted directly on the MI activity itself. | A **compensation boundary on the MI activity** (`isForCompensation` targeting the MI activity as a unit) is rejected at publish with reason (spec §4) — the exact analogue of the M5-L1 deferred compensate-subProcess-as-unit narrowing. Per-iteration compensation via each iteration's own `miBody`-scoped ledger rows is the supported v1 model. | A single compensation handler for "the whole MI activity" would need its own aggregate-undo semantics distinct from the existing per-step reverse cursor, and no exit criterion requires it — every exit criterion (parallel/sequential compensation, MI-callActivity per-iteration compensation, k-finished-compensate-reverse) is satisfied by the per-iteration model alone. Deferring the unit-level form keeps this layer's compensation surface identical in shape to what M5-L1 already shipped and validated, rather than inventing a second compensation-boundary kind in the same layer that also introduces the activation decider and the two new caps. |
| **(c) `behavior = All`-only** | Decomposition §6 M5-L3 does not name `complexBehaviorDefinition` / MI completion-behavior variants at all. | The layer design rejects `complexBehaviorDefinition`, `oneBehaviorEventRef`, and `noneBehaviorEventRef` (spec §7) — any non-`All` MI completion behavior — at publish with element id + reason. Only the BPMN-default `All` behavior (every iteration must run to completion or be settled by `completionCondition`) is supported. | `completionCondition` already provides the one early-settle mechanism this layer's exit criteria require ("`completionCondition` fires early... the k finished compensate reverse-by-index"); the `One`/`None` behavior variants are additional completion-timing semantics with no exit criterion driving them and no precedent elsewhere in the accepted profile. Rejecting them explicitly (rather than silently misinterpreting `complexBehaviorDefinition` as `All`) keeps Principle I's "no silent gaps" discipline intact. |
| **(d) MI-subProcess on a token-path cycle (host re-visit)** | Decomposition §6 M5-L3 does not address re-visiting an MI activity via a token-path cycle; MI-over-`subProcess` is treated as reusing the L1 scope/occurrence machinery generically. | MI-subProcess on a token-path cycle (host re-visit at occurrence > 0) — a **loud runtime `scopeReentry` incident** at the MI driver (Task 7, `src/runtime/multi-instance.ts`), the exact analogue of the TASK-71 loud runtime backstop. Interior keys have no host-occurrence dimension: the strided interior occurrence is `k*N + i`, independent of the MI activity's own occurrence, so a host re-visit would reuse the same interior occurrence namespace and collide. Applies ONLY to subProcess-MI hosts — serviceTask/callActivity MI on a cycle stay legal (their per-iteration keys already carry the host occ). | Rejected alternative: widening every interior key (gateway_decisions, interior jobs/saga_steps, iteration tokens) with a host-visit dimension. That would touch the shared leaf drivers (which have no MI awareness) and the unique indexes across four tables just to support a repetition shape that the MI body itself already expresses (loop the body, or route the cycle around the MI activity). A deterministic loud incident keeps the strided interior-occurrence scheme trivially sound with zero new key surface, matching the incremental-hardening discipline the other three narrowings apply. |

All four narrowings are **v1 scope decisions carved out at layer-design time**, not violations of an
existing constitutional guarantee — for (a)–(c) no rejected simpler alternative applies beyond what the
table above already records; (d) records its rejected alternative (widening every interior key with a
host-visit dimension) inline. They are recorded here per the Development-Workflow gate's Complexity Tracking
convention (mirroring the M5-L1 and M5-L2 precedent) because a future reader of the decomposition doc alone
could otherwise expect richer MI-subProcess bodies, MI-as-a-unit compensation, non-`All` completion
behavior, or a cyclic MI-subProcess host re-visit in v1.

Result: **PASS** — no unresolved violation; all four narrowings are scope-bound v1 decisions made at the
layer-design level, consistent with "the design doc wins over the decomposition doc where more specific"
(M5-L3 design doc front matter).
