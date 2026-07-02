# M5-L2 Constitution Check (pre-implementation, against constitution v2.5.0)

**Milestone**: M5-L2 — `callActivity` (reusable sub-saga: cross-instance parent/child lifecycle, the
publish-time `calledElement` version binding, child→parent error bubbling, compensation of a committed
`callActivity` by driving the child's own reverse pass — the composition milestone's "risk apex" layer)
**Recorded**: 2026-07-02 (M5-L2 governance opener, Task 1)
**Constitution version checked against**: **v2.5.0 (unchanged — no new amendment for this layer)**. The
whole M5 composition set, including `callActivity`'s Principle II publish-time version-binding clause, the
Principle III cross-instance create/apply idempotency clause, and the Principle VI child-compensation
clause, was accepted **up front** by the single M5 amendment recorded at the M5-L1 opener. M5-L2 only
**opens the runtime** for those already-recorded clauses — the design doc's own governance note states this
explicitly ("no new constitution version is required, only the per-layer Constitution Check and the
lockstep doc sync — precedent: M5-L1").
**Spec source**: [`docs/superpowers/specs/2026-06-20-m5-composition-design.md`](../../docs/superpowers/specs/2026-06-20-m5-composition-design.md)
(the 5-layer decomposition, adversarially hardened) §6 M5-L2 (the five gating decisions) +
[`docs/superpowers/specs/2026-07-02-m5-l2-callactivity-design.md`](../../docs/superpowers/specs/2026-07-02-m5-l2-callactivity-design.md)
(the M5-L2 layer design, referenced below as "spec §N" — where more specific than the decomposition doc,
the layer design wins for M5-L2, per its own front matter, mirroring the M5-L1 precedent), and the
implementation plan
[`docs/superpowers/plans/2026-07-02-m5-l2-callactivity.md`](../../docs/superpowers/plans/2026-07-02-m5-l2-callactivity.md).

This record satisfies the Development-Workflow gate ("Plans MUST pass the Constitution Check before Phase 0
research and again after Phase 1 design") for M5-L2. As with M3/M4/M5-L1, the project's operating mode is
brainstorming-design → backlog slicing rather than a full Spec Kit `plan.md`; the two design docs above
**are** the spec/plan source for M5-L2 (the same recorded deviation from `plan.md:7` that M3, M4, and M5-L1
documented, not laundered as precedent). Both gate checks are mapped onto that flow below.

## Two required gate checks (mapped onto the M5-L2 brainstorming-design flow)

- **Before Phase 0 (design intake):** the M5-L2 scope — `callActivity`, parent/child lifecycle, variable
  pass-through, child error/escalation bubbling to the parent, and compensation of a committed
  `callActivity` — was already checked against constitution **v2.5.0** at the M5-L1 opener: the amendment
  accepted the **whole** M5 composition set up front, naming `callActivity`'s Principle II version-binding
  clause, Principle III cross-instance idempotency clause, and Principle VI child-compensation clause by
  name, while leaving the *runtime* "accepted-in-governance, interim-rejected-at-publish" until this layer
  opens it (constitution Principle I MVP-scope paragraph; `docs/bpmn/09-easy-bpmn-profile.md` interim
  markers). No further amendment is required before design work on this layer — the recorded v2.5.0 clauses
  are the intake checkpoint, exactly the ordering the M5-L1 record established for its own layer.
- **After Phase 1 (design hardening → this layer design):** re-checked against the **same** v2.5.0. The
  layer design (spec, all sections) stays within the recorded clauses — no new BPMN construct, no widened
  correlation surface (the v1 message-wait call-tree reject in spec §7 narrows, rather than widens, what
  publish accepts), no relaxation of Principle II/III/VI's already-recorded text. Result: **PASS** — see
  Complexity Tracking below for the two deliberate v1 narrowings worth recording.

## Per-principle confirmation for the M5-L2 layer

- **I. Standard BPMN Profile Only — PASS.** `bpmn:callActivity` is a standard BPMN 2.0 flow node, now
  opened at the validator by this layer (spec §7): `calledElement` resolution to the latest published
  version of a process in the same workspace (Principle II, below); an explicit reject for a non-process
  `calledElement` (GlobalTask), distinct from the generic "unresolved" reject; a static DFS call-cycle
  reject over the resolved call tree (child versions are pinned at publish, so the call graph is immutable);
  and the new publish-time cap `MAX_CALL_DEPTH = 4` (`src/runtime/engine.ts`, alongside the other caps,
  under the `check:docs` lockstep sync) — call depth is statically computable at publish
  (`1 + max(child depths)`), the same discipline `MAX_SCOPE_DEPTH` established in M5-L1. Boundaries hosted
  **on** a `callActivity` (error/timer/compensation) are legal exactly as on any other activity, reusing
  M5-L1 mechanics unchanged. `multiInstanceLoopCharacteristics`, `escalation`, `signal`, and the event
  subprocess (`triggeredByEvent="true"`) all stay **interim-rejected** with their own M5-L3/L4/L5 roadmap
  pointers — this layer widens the validator by exactly one construct. `camunda:calledElementBinding` /
  `calledElementVersion` are tolerated-and-ignored, not honored (a documented surprise, consistent with the
  general foreign-namespace-extension tolerance rule). No new MODEL-namespace notation is introduced; the
  only additive binding stays `easy-bpmn:taskDefinition`; every accepted file stays XSD-valid and
  round-trips through a standard modeler when `easy-bpmn` + DI are ignored.
- **II. Immutable Definitions / Version-Bound Instances — PASS (this is where the recorded clause takes
  runtime effect).** The constitution's `callActivity` version-binding clause (Principle II, added by the
  M5 amendment, "recorded now, not exercised" at the M5-L1 opener) opens here: `calledElement` MUST resolve,
  **at the calling definition's own publish time**, to a concrete `calledDefinitionVersionId` — the latest
  published version of the referenced process in the same workspace — recorded in the caller's derived
  `parsed_profile`; an unresolved `calledElement` fails publish (spec §7). This binds the caller to one
  immutable child version for the life of every instance created from it, a deliberate divergence from
  Camunda's runtime `latest` binding. No migration path and no version mutation are added.
- **III. Durable, Idempotent Execution — PASS (this is where the child create/apply half of the recorded
  clause takes runtime effect; the signal-fan-out half still lands in M5-L5).** The `child_instances` row is
  the provenance row of the child-idempotency triad: written in the same persist-before-advance `dbBatch`
  that decides to invoke the child, and it — not Workflow step memory, not `runStep` memoization — is the
  rewalk fast-forward predicate gating `create()` (spec §2, §3), the exact analogue of `gateway_decisions` /
  `matched_subscription_id` / `output_applied=1`. The deterministic content-addressed child id
  (`hash(parentInstanceId, elementId, occurrence, iterationIndex)`) plus treating CF "id already in use" as
  success makes child creation idempotent under at-least-once replay. The apply-once decider on parent wake
  (spec §3 step 5) merges child output into parent variables in one atomic `dbBatch`, keyed by
  `(parentInstance, element, occurrence, iteration)`, and no-ops on a duplicate wake against the same row
  status — mirroring the existing service-task and message idempotency triads exactly as the amendment's
  clause requires.
- **IV. Correlation and Receive Task Integrity — PASS / N/A, narrowed by design (this layer's deliberate
  scope entry, not a widening).** M5-L2 introduces no new correlation construct and does not touch the
  message-correlation broker; the amendment's separate `signal` sub-clause is still recorded-now-not-
  exercised (lands M5-L5). The **v1 message-wait call-tree reject** (spec §7; Complexity Tracking below)
  keeps this invariant trivially sound by construction: a `receiveTask` or message `intermediateCatchEvent`
  anywhere in the resolved call tree (including grandchildren) is rejected at the caller's publish, because
  a child is never API-started and `process_instances.correlation_key` is `NOT NULL` — there is no key
  source for a child wait. The called process itself stays publishable and API-startable standalone; only
  *calling* it is restricted. Un-guarded-wait / single-wake semantics (Principle IV, M4 TASK-54) are
  unaffected — the child→parent wake handshake reuses the same `WAKE_TYPE` single-wake protocol, not a
  parallel wait mechanism (spec §1, §3).
- **V. Auditability and Operator Clarity — PASS.** New D1 history events (`callActivityInvoked`, per spec
  §3) record child creation; the child's own instance row and history are independently inspectable
  (ordinary `process_instances`/`instance_history` rows, no new storage class). `GET /instances/{id}` gains
  a `lineage` block (`parent {instanceId, elementId}` + `children[] {elementId, occurrence, childInstanceId,
  status}`) via a direct `child_instances` read — the D1-only inspection invariant holds, no Cloudflare
  Workflow internal is exposed (spec §6). Cascading operator semantics are explicit and documented:
  `/cancel` and `/retry` on a parent cascade into the child subtree (drain-then-compensate;
  subtree-first retry); `/cancel`/`/retry` **directly on a child** returns `409` naming the
  `parentInstanceId` ("operate via the saga root") — the second deliberate v1 narrowing recorded below.
  Every rejection at the validator (unresolved `calledElement`, GlobalTask target, call cycle,
  `MAX_CALL_DEPTH` overflow, call-tree message wait) states the offending element id and reason.
- **VI. SAGA / Compensation Integrity — PASS (amended by v2.5.0 at the M5-L1 opener; this is where the
  child-compensation half of that generalization takes runtime effect).** "Compensating a committed
  `callActivity` means driving the **child instance's own reverse pass**; a child that settles
  `compensationFailed` surfaces as the parent's own `compensationFailed` incident" (the constitution's
  verbatim Principle VI clause) is realized exactly as designed (spec §5): step-kind dispatch on
  `saga_steps.child_instance_id` routes a `child`-kind step to a distinct, narrow `{completed, cancelled} →
  compensating` CAS entry point that bypasses the ordinary terminal guards in `compensation.ts`/`engine.ts`
  — idempotent on `compensating|compensated`, unable to regress a child in `errored`/`running`/`incident`. A
  child with no committed ledger steps is a no-op compensator that resolves without parking. The dead
  child's reverse pass runs via the same inline-drive path that already carries operator-resume-after-
  termination today (`executor.ts` `deliverJobResult` fallback) — no new execution mechanism, reuse of an
  existing (if under-exercised) code path. The Hazard-class timer-boundary drain on a `callActivity`
  extends M5-L1's "interrupt without auto-compensation, retained ledger" verbatim across the instance
  boundary: draining a subtree containing a running child cancels the child instance (terminate its
  Workflow, CAS to `cancelled`, release resources recursively down to `MAX_CALL_DEPTH`, reusing the TASK-72
  release path) while the child's committed ledger rows stay retained, not auto-compensated (spec §4) — the
  Cancel-only-trigger, idempotent, and at-least-once clauses are unchanged. Cancel-path routing (spec §4)
  drives the child's reverse pass exactly when an enclosing parent transaction cancels, consistent with the
  ancestry-based compensation-reachability guard M5-L1 already established.

## Complexity Tracking

The M5-L2 layer is the composition milestone's designated "risk apex" (decomposition doc §6, "XL — risk
apex"); two design choices are worth recording against the Development-Workflow gate as **deliberate v1
scope narrowings** — not deviations from an existing constitutional guarantee, and not widenings of the
already-recorded v2.5.0 clauses — made at layer-design time (design doc wins over decomposition doc where
more specific, per its own front matter, mirroring the M5-L1 precedent).

| Refinement | What the decomposition doc said | What M5-L2 does instead | Why |
|---|---|---|---|
| **(a) Message-wait call-tree reject** | Decomposition §6 M5-L2 decision 5 names the missing child-correlation-key problem and recommends (`→`) "v1: at parent publish, REJECT a called process that contains any `receiveTask`/message `intermediateCatchEvent` (element id + reason)," while also sketching a non-chosen alternative (ii) — inherit the parent's correlation key together with a cross-definition extension of the broker-key guard — as a fast-follow candidate. | The layer design **confirms and sharpens** the `→` default as the shipped v1 behavior (spec §7): the reject scans the **entire resolved call tree**, including grandchildren, not just the immediately-called process, because a grandchild has the identical missing-key problem. The called process itself stays publishable and API-startable standalone; only *calling* it into a chain is restricted. Alternative (ii) is recorded as an explicit fast-follow, not built now. | `process_instances.correlation_key` is `NOT NULL` and a child is never API-started, so there is no key source for a child wait — a v1 reject keeps the one-subscription-per-broker-key invariant (Principle IV) trivially sound with zero new broker-key surface, rather than extending the broker guard across a still-unproven cross-instance lifecycle in the same layer that is already the composition milestone's designated risk apex. Deferring the richer option to a fast-follow, once the child triad itself is validated on real Cloudflare, is the same incremental-hardening discipline M3/M4 applied to their own riskiest mechanisms. |
| **(b) Direct-child-operator-verb 409** | The decomposition doc's M5-L2 section does not address the operator surface for cancel/retry on a child instance at all — this is new ground the layer design covers first. | `POST /instances/{id}/cancel` and `POST /instances/{id}/retry` reject with `409` when `id` is a child (`parent_instance_id != NULL`), naming the `parentInstanceId` in the response body ("operate via the saga root") — one check shared by both handlers (spec §6, "cascade down; direct child operations are forbidden — user decision"). Cascading semantics are the only supported path: parent `/cancel` drains and cancels running children recursively, then runs child reverse passes; parent `/retry` cascades subtree-first. | A child instance's lifecycle is entirely a function of its parent callActivity step — allowing an independent operator verb directly on a child would let its status diverge from what the parent's own step-state machine believes (the exact class of desync Principle III's provenance-gating exists to prevent), and would require the child to re-derive "was I cancelled by my own operator action or by my parent's drain" with no clean answer for a subsequent parent cascade. Forcing all control through the root keeps a single, auditable operator entry point per saga (Principle V) and needs no new state on the child row beyond the existing `parent_instance_id` back-reference already in the data model (spec §2). |

Both narrowings are **v1 scope decisions carved out at layer-design time**, not violations of an existing
constitutional guarantee — no rejected simpler alternative applies to either beyond what the table above
already records; they are recorded here per the Development-Workflow gate's Complexity Tracking convention
(mirroring the M5-L1 and M4 SESE-restriction precedent) because a future reader of the decomposition doc
alone could otherwise expect the richer child-correlation option or an unrestricted per-instance operator
surface in v1.

Result: **PASS** — no unresolved violation; both narrowings are scope-bound v1 decisions made at the
layer-design level, consistent with "the design doc wins over the decomposition doc where more specific"
(M5-L2 design doc front matter).
