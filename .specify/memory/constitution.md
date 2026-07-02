<!--
Sync Impact Report — 2.4.0 -> 2.5.0 (2026-07-02)
Rationale (MINOR): materially widens Principle I's accepted construct set with
the WHOLE M5 composition set up front — the last roadmap milestone — while
preserving every existing principle (per the versioning policy: "MINOR = ...
materially expand guidance while preserving existing principles"; same class as
the M2/M3/M4 scope-widening amendments). Per the chosen governance lane
(decomposition doc §5): M5 stays ONE roadmap milestone; this ONE amendment
accepts the whole composition construct set; the runtime then ships in
interim-marked layers M5-L1...L5, exactly as M3 (accepted v2.2.0, opened
L2-L4) and M4 (accepted v2.3.0, opened L1-L6) did. This amendment is the
OPENING governance item of the M5-L1 cycle — it lands before any M5 runtime
change (the Principle-I-compliant ordering, as M3 and M4 amended first).
Source: docs/superpowers/specs/2026-06-20-m5-composition-design.md (the
5-layer decomposition, adversarially hardened, §5 governance plan) +
docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md (the M5-L1
layer design that refines the accepted set into implementable semantics for
this first layer) + the recorded Constitution Check,
specs/002-saga-orchestrator/m5-L1-constitution-check.md.
Scope of the amendment (what v2.5.0 authorises, up front, across all 5 layers):
- Principle I — accepted construct set widened with the WHOLE composition set:
  non-transaction `subProcess` (embedded), error/timer boundary on a
  `subProcess`/`transaction`, an error END event, `callActivity`,
  `multiInstanceLoopCharacteristics` (parallel AND sequential), `escalation`
  throw/boundary + event subprocess, `signal` throw/catch, and the FIRST
  non-interrupting boundaries (signal/escalation only — timer/conditional
  non-interrupting boundaries stay rejected). Every still-unsupported construct
  stays rejected with element id + reason: `complexGateway`, `conditional`/
  `link` event definitions, `adHocSubProcess`, `standardLoopCharacteristics`,
  a top-level (process-level) `signal` START event, a non-process
  `calledElement` (GlobalTask), the `compensateEventDefinition` throw/end, and
  MI standard data bindings (`loopDataInputRef`/`loopDataOutputRef`/
  `inputDataItem`/`outputDataItem`). The runtime opens per layer M5-L1...L5,
  each with its own interim marker in docs/bpmn/09-easy-bpmn-profile.md,
  exactly as the M3 (L2-L4) and M4 (L1-L6) amendments did.
- Principle II — the called-definition version binding: `calledElement`
  resolves at PARENT PUBLISH to a concrete `definitionVersionId` (latest
  published version of that process in the same workspace), stored in the
  derived `parsed_profile` (a runtime resolution, not a model mutation);
  unresolved => publish fails. A deliberate divergence from Camunda's runtime
  `latest` binding, for immutability. Recorded now; lands in M5-L2.
- Principle III — cross-instance idempotency: child-instance create, child
  output-apply, and signal fan-out are all at-least-once with
  provenance-gated single-apply (mirroring the existing service-task/message
  idempotency triads). Recorded now; lands in M5-L2/L5.
- Principle IV — additively extended, message invariant VERBATIM. The
  existing external-message correlation invariant ("message name plus
  correlation key to exactly one eligible waiting process instance") is kept
  VERBATIM — it governs messages / Receive Tasks / message intermediate-catch
  only. `signal` is introduced as a SEPARATE workspace-scoped broadcast class
  (1:N, no correlation key; the broker-key single-subscription invariant is
  explicitly NOT applicable to signals) as an additive sub-clause. This keeps
  the bump defensibly MINOR.
- Principle VI — compensation generalized to a SCOPE SUBTREE: nested commit is
  non-terminal (`committedLocal`) and seals only at the outermost transaction's
  commit; the straggler cohort and the live-token barrier use scope-subtree
  membership, not equality; compensation wiring is legal iff SOME ancestor
  scope is a transaction (an ancestry check, not an immediate-parent check).
  Compensating a committed `callActivity` = driving the child's own reverse
  pass; a child `compensationFailed` surfaces as a parent `compensationFailed`
  incident. The Cancel-only-trigger / Hazard-does-not-compensate / idempotent
  / at-least-once clauses are UNCHANGED.
- New engine caps recorded (joining the three existing M2-M4 caps):
  `MAX_SCOPE_DEPTH` (M5-L1, nesting depth of scopes — enforced at PUBLISH TIME
  in L1 since scope depth is fully static there; the `scopeDepth` runtime
  incident becomes reachable, and is deferred, to M5-L2 once callActivity
  makes depth dynamic), `MAX_CALL_DEPTH` (M5-L2, callActivity nesting depth),
  `MAX_MI_CARDINALITY` (M5-L3, body-aware multi-instance fan-out cap), and
  `MAX_SIGNAL_FANOUT` (M5-L5, broadcast fan-out cap against the subrequest
  ceiling). No numeric value is fixed by this amendment; each is fixed and
  `check:docs`-synced in its own layer.
Modified sections:
- Principle I: accepted construct set widened per the above; the still-
  rejected set is named explicitly (no silent gaps).
- Principle II: version-bound `calledElement` resolution clause added.
- Principle III: cross-instance / broadcast idempotency clause added.
- Principle IV: additive signal sub-clause; message invariant marked verbatim.
- Principle VI: scope-subtree generalization of compensation.
- MVP Scope and Platform Constraints: non-transaction `subProcess`,
  `callActivity`, ad-hoc subprocesses, multi-instance/loop characteristics,
  signal/escalation/conditional events, and non-interrupting boundary timers
  are removed from the exclusion list only to the DEGREE this amendment
  authorises (signal/escalation non-interrupting boundaries only; conditional
  boundaries and `adHocSubProcess` stay excluded); an in-scope recap paragraph
  for the M5 composition set is appended (mirroring the M2/M3/M4 recaps),
  naming the interim-layer-opening discipline.
Unchanged:
- Principle V verbatim (auditability/operator-clarity already covers the new
  history event types this milestone adds; no new principle needed).
- The no-custom-notation / XSD-valid / round-trippable / reject-with-element-
  id-and-reason clause of Principle I is unchanged.
Templates requiring updates:
- checked: .specify/templates/spec-template.md (BPMN Profile Impact prompt is
  already generic enough to cover subProcess/callActivity/MI/signal/
  escalation without a wording change).
- checked: AGENTS.md / tasks-template.md (no construct-list hardcoding found).
- deferred: .specify/templates/plan-template.md — the Constitution Check
  "BPMN profile" gate's descriptive text still enumerates only the M1-M4
  accepted sets (it does not yet name the M5 composition set). This mirrors
  how the M4 amendment's own follow-up owed a CLAUDE.md update at epic closure
  rather than at the governance-opening commit: the gate's STRUCTURE (mark
  PASS/FAIL/N/A, cite the profile) needs no change and the check remains
  meaningful — Task 1's own recorded Constitution Check
  (specs/002-saga-orchestrator/m5-L1-constitution-check.md) demonstrates that
  — but the template's construct-list prose should gain the M5 set at or
  before the next feature plan that exercises it. Task 1's file scope is
  governance + this layer's spec/profile-doc lockstep only; this template
  edit is intentionally out of scope for this commit.
Follow-up TODOs:
- specs/002-saga-orchestrator/m5-L1-constitution-check.md records the M5-L1
  layer-specific Constitution Check (this amendment's companion artifact).
- specs/002-saga-orchestrator/spec.md gains an M5-L1 section (M4-shape).
- docs/bpmn/09-easy-bpmn-profile.md gains M5 composition-set interim markers:
  M5-L1 constructs marked "runtime opening in this layer"; M5-L2...L5
  constructs marked "accepted (v2.5.0), runtime not yet open — publish still
  rejects (interim)".
- .specify/templates/plan-template.md's BPMN-profile gate prose gains the M5
  composition set (deferred, see above).
- openapi.yaml Incident.kind gains `uncaughtError` and `compensation_status`
  surfaces gain `committedLocal` when the M5-L1 runtime lands (not this
  governance-opening commit — check:docs will catch a miss).
- Each subsequent layer (M5-L2...L5) carries its own recorded Constitution
  Check, its own spec.md section, its own docs/bpmn lockstep, and its own
  check:docs/check:matrix growth — this amendment does not re-open per layer.
-->

<!--
Sync Impact Report — 2.3.1 -> 2.4.0 (2026-06-14)
Rationale (MINOR): materially widens product scope — it removes "advanced
Operate-style UI" from the MVP exclusion list and opens the M-UI / Operator
Console milestone (a read-only operator console) while PRESERVING every existing
principle (per the versioning policy: "MINOR = ... materially expand guidance
while preserving existing principles"; same class as the M2/M3/M4 scope-widening
amendments). No core principle is redefined or removed: Principle V (Auditability
& Operator Clarity) already MANDATES that operators inspect instance status,
current element, variables, and history and that errors explain what/where/next —
the console is the UI realisation of that existing principle, not a new one. The
console introduces NO new BPMN construct (Principle I's accepted set is unchanged)
and changes no execution / immutability / idempotency / correlation / saga
semantics (Principles II-IV, VI verbatim).
Source: docs/superpowers/specs/2026-06-14-operator-console-ui-design.md (the
adversarially-reviewed operator-console design) + its implementation plan
docs/superpowers/plans/2026-06-14-operator-console-ui.md.
Scope of the amendment (what M-UI authorises):
- A read-only React SPA served by the SAME Worker as static assets (same-origin),
  plus new read/aggregation API endpoints (projects/attention/sagas, instance
  jobs+attempts, message search, raw BPMN XML, an SSE history live-tail) and a
  session-cookie auth layer (`/ui/login|logout|me`). All inspection reads D1 only
  (the existing inspection invariant is unchanged); the SPA exposes NO Cloudflare
  Workflow internals.
- The ONLY write surface remains the two EXISTING operator controls (cancel,
  retry). The console adds no new write/mutation verb and no instance-start UI.
Modified sections:
- MVP Scope and Platform Constraints: "or advanced Operate-style UI unless this
  constitution is amended first" REMOVED from the exclusion list (a visual BPMN
  modeler stays excluded — the console is a viewer, never an editor); the
  milestone parenthetical notes M-UI adds the read-only console; an in-scope recap
  paragraph for the M-UI console is appended (mirroring the M2/M3/M4 recaps).
Unchanged principles:
- I-VI verbatim (Principle V already covers operator inspection; the console is its
  UI surface). No accepted BPMN construct added or removed.
Templates requiring updates:
- checked: .specify/templates/plan-template.md (Constitution Check — no
  BPMN-profile or saga-ordering change; the UI milestone carries the standard
  audit-history / operator-visible-error / inspection-reads-D1 gates already
  present).
- checked: .specify/templates/spec-template.md (no construct-set change).
- checked: AGENTS.md / tasks-template.md (no construct list change).
Follow-up TODOs:
- openapi.yaml + runtime-contracts.md amended in lockstep with the new endpoints
  (per the governance gate); check:docs stays green.
- M5 (composition) still requires its own amendment before widening the BPMN
  profile further; M-UI widens only the operator-UI scope, not the profile.
-->

<!--
PATCH addendum — 2.3.0 -> 2.3.1 (2026-06-14)
Rationale (PATCH): clarifies wording only — no principle is redefined, removed,
or scope-widened (per the versioning policy: "PATCH = clarify wording … or make
non-semantic refinements"). Records the M4 single-wake (TASK-54) standard-BPMN
un-guarded-wait semantics in Principle IV: an un-guarded receive task / message
intermediate catch (no modeled deadline) waits INDEFINITELY; un-guarded Service
Task liveness is the job-activation DLQ (`jobActivationTimeout`); the M3 leaf
`waitTimeout` durable-wait cap is RETIRED (its incident kind is now unproduced,
kept as a vestigial enum value until the dead-code sweep). `compensationFailure`
remains the compensation retry-exhaustion terminal (Principle VI — unchanged, and
its "MUST NOT silently block forever" clause already reads as retry-exhaustion).
Aligned in lockstep: docs/bpmn/09-easy-bpmn-profile.md (the DLQ/liveness note) and
specs/002-saga-orchestrator/contracts/openapi.yaml (Incident.kind description).
Templates: no change (no construct-set or quality-gate change). The 2.2.0 -> 2.3.0
Sync Impact Report below is unchanged.

Sync Impact Report
Version change: 2.2.0 -> 2.3.0
Rationale (MINOR): materially expands Principle I's accepted construct set with
the M4 in-instance concurrency gateways (`parallelGateway` / `inclusiveGateway`,
block-structured / SESE only) while preserving every existing principle (per the
versioning policy: "MINOR = ... materially expand guidance while preserving
existing principles"). Same MINOR class as the 2.0.0 -> 2.1.0 (M2) and
2.1.0 -> 2.2.0 (M3) bumps. Like M3 — and unlike M2, which amended AFTER the
validator opened the constructs — M4 amends FIRST, as the opening governance item
before any M4 concurrency construct's runtime ships (the Principle-I-compliant
ordering). The single behaviour THIS amendment authorises is publish-time
accept/reject: a block-structured parallel/inclusive region validates, a
non-SESE one is rejected with the offending element ids; no engine concurrency
runs yet. The concurrency runtime (token frontier, branch fan-out, the AND/OR
join barrier, parallel-branch compensation) ships in later M4 layers (L2-L5).
Source: M4 concurrency design
(docs/superpowers/specs/2026-06-13-m4-concurrency-design.md §4, §6, §12, §17).
Modified principles:
- I. Standard BPMN Profile Only (accepted construct set widened with the M4
  concurrency set: `bpmn:parallelGateway` (AND) and `bpmn:inclusiveGateway` (OR),
  BLOCK-STRUCTURED only — each split paired with exactly one matching join of the
  SAME type forming a single-entry/single-exit (SESE) region, validated at
  publish; `complexGateway` and the `terminate` end event stay excluded; the
  no-custom-notation / XSD-valid / round-trippable /
  reject-unsupported-flow-node-with-element-id-and-reason clause is unchanged)
- VI. SAGA / Compensation Integrity (reverse-order compensation REDEFINED per
  causal chain (a token lineage); order between concurrent branches is
  unconstrained; a straggler completing after a parallel scope began compensating
  is still ledgered + compensated, idempotent under at-least-once, and ordered
  within its lineage. A multi-token (frontier-empty) completion rule is added: an
  instance completes only when zero tokens remain. The at-least-once /
  idempotency / Cancel-only-trigger / Hazard-does-not-compensate /
  compensationFailed clauses are unchanged — only the ORDERING qualifier becomes
  per-causal-chain, because concurrency makes a single global completion order
  ill-defined.)
Modified sections:
- MVP Scope and Platform Constraints (exclusion list requalified: `parallel` and
  `inclusive` dropped from the gateway line — `complex` stays excluded; the
  milestone parenthetical updated — M4 parallel/inclusive concurrency is added by
  THIS amendment, M5 composition remains pending; in-scope recap extended with
  the M4 SESE concurrency set and its publish-time-only interim note.)
Unchanged principles:
- II-V verbatim.
Templates requiring updates:
- updated: .specify/templates/plan-template.md (Constitution Check BPMN-profile
  gate names the M4 SESE parallel/inclusive set; SAGA gate ordering qualified per
  causal chain)
- updated: .specify/templates/spec-template.md (BPMN Profile Impact prompt covers
  the M4 concurrency constructs)
- checked: .specify/templates/tasks-template.md (no construct list; generic
  saga/compensation test guidance still accurate)
- checked: AGENTS.md
- deferred: CLAUDE.md (its v2.2.0 references describe M3 as shipped — historically
  accurate; the CLAUDE.md M4 profile-lockstep + reject-list-invariant updates land
  with the M4 runtime layers / epic closure (L6), not this publish-time-only
  governance opener)
Constitution-impacting file changes (this amendment):
- .specify/memory/constitution.md (Principle I, Principle VI, MVP Scope, version
  footer)
- .specify/templates/plan-template.md, .specify/templates/spec-template.md
- specs/002-saga-orchestrator/m4-constitution-check.md (recorded Constitution
  Check)
- docs/bpmn/{03-gateways,07-execution-semantics,09-easy-bpmn-profile}.md +
  scripts/check-docs.mjs (profile-doc lockstep — landed in the M4-L1 validator/
  docs commits, not this governance commit)
Follow-up TODOs:
- M4 validator runtime layers (L2 token foundation; L3 parallelGateway AND; L4
  inclusiveGateway OR; L5 parallel-branch compensation) open the accepted
  concurrency runtime; this amendment only opens publish-time validation.
- M5 (composition) still requires its own amendment before widening the profile
  further.
- CLAUDE.md M4 profile-lockstep + reject-list-invariant update owed at M4 epic
  closure (L6).
-->

# easy-bpmn Constitution

## Core Principles

### I. Standard BPMN Profile Only

The platform MUST execute only standard BPMN 2.0-compatible elements in this
profile. The currently accepted construct set is:

- the linear core — None Start Event, Service Task, Receive Task, None End Event,
  Sequence Flow, and Message correlation;
- the canonical transaction-saga set — `bpmn:transaction` (the saga scope), the
  compensation / error / cancel `boundaryEvent`, an `isForCompensation` Service
  Task (compensation handler), `bpmn:association` (compensation wiring), a cancel
  `endEvent` (only inside a transaction), and a root `bpmn:error`; and
- the conditional set (M2) — `bpmn:exclusiveGateway` (data-driven XOR split and
  pass-through join), FEEL `conditionExpression` (evaluated in document order)
  on sequence flows leaving an exclusiveGateway, the gateway-owned `default`
  flow, and cycles (loops) on the token path (conditions appear ONLY on flows
  leaving an exclusiveGateway); and
- the time-&-failure-taxonomy set (M3) — an **interrupting** boundary
  `timerEventDefinition` on a `serviceTask`/`receiveTask` (never on a
  `transaction`), a timer or message `intermediateCatchEvent` on the token path,
  the `bpmn:eventBasedGateway` (a deterministic race over its timer/message
  catch-event branches), and **free error-boundary routing** (any number of
  distinct-`errorCode` interrupting error boundaries plus at most one catch-all
  per activity, each routing to any token-path node in the same scope). Timer
  triggers are static ISO-8601 `timeDate`/`timeDuration` literals only. This set
  was declared **accepted** by the M3 amendment, and its runtime opened per
  validator layer (boundary timers, then intermediate catch + eventBasedGateway);
  the whole set has now **fully shipped** and the interim "M3 — not yet
  implemented" rejection is retired (see
  `docs/bpmn/09-easy-bpmn-profile.md`); and
- the in-instance concurrency set (M4) — `bpmn:parallelGateway` (the AND split
  and join) and `bpmn:inclusiveGateway` (the OR split and join),
  **block-structured only**: every split MUST pair with exactly one matching join
  of the **same type**, forming a single-entry/single-exit (SESE) region,
  validated **at publish** (a non-block-structured, branch-escaping,
  mismatched-join, or uncontrolled-merge region — or two concurrent branches
  awaiting the same message name — is rejected with the offending element id).
  The M4 amendment opened **publish-time validation** first; the concurrency runtime
  (the token frontier, branch fan-out, the AND/OR join barrier, and parallel-branch
  compensation) has since **fully shipped** across the M4 runtime layers (the
  single-wake engine, TASK-54, re-validated GREEN on real Cloudflare Workflows
  2026-06-14). The inclusive split obeys the same FEEL `conditionExpression` /
  gateway-owned `default` rules as the `exclusiveGateway` split. Every gateway
  type other than `exclusiveGateway`, `eventBasedGateway`, `parallelGateway`, and
  `inclusiveGateway` remains excluded — `complexGateway` is not on the roadmap,
  and the `terminate` end event stays out of scope; and
- the composition set (M5) — non-transaction `bpmn:subProcess` (embedded, one
  none-start, at least one end, sharing the parent variable scope; arbitrary
  nesting of subProcess/transaction); error and timer `boundaryEvent`s hosted
  on a `subProcess` or a `transaction` (a non-cancel interrupting boundary
  **interrupts without auto-compensation** — Principle VI — and its completed,
  compensatable effects are **retained**, not dropped); an error **end**
  event (`endEvent` + `errorEventDefinition`, bubbling exactly like a worker
  error); `bpmn:callActivity` (`calledElement` resolved to a concrete process
  version at the **caller's** publish — Principle II);
  `multiInstanceLoopCharacteristics` (parallel **and** sequential, standard
  `loopCardinality`/FEEL or an `easy-bpmn:multiInstance` collection binding —
  never the standard data-binding attributes, see below); `escalation` throw
  (intermediate + end) and boundary (interrupting and **non-interrupting**),
  plus the event subprocess (`triggeredByEvent="true"`, one recognized start
  definition, zero in/out sequence flow); `signal` throw (intermediate + end)
  and catch (boundary — **non-interrupting** allowed — intermediate, and
  event-subprocess start; never a top-level/process-level signal start); and
  the first **non-interrupting** boundary events, accepted **only** for
  signal/escalation (timer and conditional non-interrupting boundaries stay
  rejected). Every still-unsupported construct remains rejected before
  publish with the offending element id and a reason, named explicitly (no
  silent gaps): `complexGateway`; `conditional`/`link` event definitions;
  `adHocSubProcess`; `standardLoopCharacteristics`; a top-level (process-level)
  `signal` **start** event; a non-process `calledElement` (a GlobalTask);
  `compensateEventDefinition` on a throw or end event (the compensate-as-unit
  boundary on a subProcess is likewise deferred, post-M5); and MI's standard
  ItemAwareElement data bindings (`loopDataInputRef`/`loopDataOutputRef`/
  `inputDataItem`/`outputDataItem`) or an MI with no recognized cardinality
  source. This set was declared **accepted, in full, up front** by the single
  M5 amendment (v2.5.0); the runtime then opens **per layer** (M5-L1 embedded
  scopes + hierarchical exceptions, M5-L2 `callActivity`, M5-L3
  `multiInstance`, M5-L4 escalation + event subprocess, M5-L5 signal), each
  layer's construct subset moving from "accepted-in-governance,
  interim-rejected-at-publish" to "runtime open" as its layer ships — exactly
  the ordering discipline the M3 and M4 amendments established (see
  `docs/bpmn/09-easy-bpmn-profile.md` for the current per-layer interim
  markers).

A saga is modeled in **canonical BPMN**: the only additive binding is
`easy-bpmn:taskDefinition` carried inside the standard `<bpmn:extensionElements>`
escape hatch. Features MUST NOT introduce custom notation (no new MODEL-namespace
tags, no redefining a standard element's runtime meaning, no non-standard
attribute required to parse), platform-only BPMN semantics, or unsupported
runtime behavior. Every accepted file MUST stay XSD-valid and round-trip through a
standard modeler (bpmn-js / Camunda Modeler) when the `easy-bpmn` extensions and
Diagram Interchange are ignored. Unsupported standard-namespace **flow nodes**
MUST be rejected before publish with the offending element id and a user-visible
reason; ignorable extension content (foreign-namespace `<extensionElements>`,
Diagram Interchange, `documentation`, text annotations) MUST be tolerated and
ignored, never rejected.

Each later milestone widens this profile only by amending this constitution
first — exactly as this M5 amendment does for the whole composition set
(and as the M4 amendment did for the block-structured parallel/inclusive
concurrency set, and the M3 amendment did for timers, intermediate catch
events, the `eventBasedGateway`, and the failure taxonomy). M5 is the last
roadmap milestone: no further profile-widening amendment is anticipated
after its runtime layers close.

Rationale: the product promise depends on making standard BPMN executable without
inventing a notation or pretending to support the full BPMN ecosystem at once.

### II. Immutable Definitions and Version-Bound Instances

Publishing a process definition MUST create an immutable version. Running process
instances MUST bind to exactly one published definition version for their entire
lifetime. Changes to a BPMN XML document MUST produce a new definition version,
not mutate a published one. MVP work MUST NOT include runtime migration between
definition versions.

A `callActivity`'s `calledElement` MUST resolve, **at the calling definition's
own publish time**, to a concrete `definitionVersionId` — the latest published
version of the referenced process in the same workspace — recorded in the
caller's derived `parsed_profile`; an unresolved `calledElement` MUST fail
publish. This binds the caller to one immutable child version for the life of
every instance created from it, deliberately diverging from Camunda's runtime
`latest` binding semantics (`camunda:calledElementBinding`/
`calledElementVersion` are tolerated-and-ignored, not honored — a documented
surprise). This clause is recorded by the M5 amendment; it takes runtime effect
in M5-L2.

Rationale: deterministic execution and debuggable history require stable process
metadata after an instance starts.

### III. Durable, Idempotent Execution

Runtime state transitions, remote service worker calls, callbacks, retries, and
external messages MUST be safe to replay or receive more than once. Service Task
execution MUST persist worker output variables before advancing the instance.
Duplicate callbacks, duplicate external events, and retry attempts MUST NOT
corrupt variables, skip required states, or create duplicate completion effects.

This extends to cross-instance and broadcast execution: a `callActivity` child
instance's **creation**, the **application of its output** into the parent's
variables, and a `signal`'s **fan-out delivery** to every active catch MUST
each be safe under at-least-once delivery — provenance-gated so a duplicate
create/apply/deliver is a no-op against the same provenance key, mirroring the
existing service-task and message idempotency triads. This clause is recorded
by the M5 amendment; it takes runtime effect in M5-L2 (child create/apply) and
M5-L5 (signal fan-out).

Rationale: the platform replaces a user-managed workflow cluster, so durability
and idempotency are product requirements, not implementation details.

### IV. Correlation and Receive Task Integrity

External messages MUST correlate by message name plus correlation key to exactly
one eligible waiting process instance. Missing, ambiguous, duplicate, or late
messages MUST have deterministic outcomes and clear API responses. A Receive
Task wait state MUST be durable, and applying a received payload MUST be atomic
with the transition that continues the instance. An **un-guarded** receive task
or message `intermediateCatchEvent` — one carrying **no modeled deadline** (no
boundary timer) — has no timeout and waits **indefinitely** (standard BPMN: no
deadline ⇒ no expiry); operational liveness for an un-guarded **Service Task**
instead comes from the job-activation DLQ (`jobActivationTimeout`), not an
engine-level wait cap (M4 single-wake, TASK-54; the prior M3 leaf `waitTimeout`
cap is retired). Human work remains outside the platform; the platform receives
only the fact of that work as a BPMN-compatible message.

This correlation invariant governs messages — Receive Tasks and the message
`intermediateCatchEvent` — only, and is kept **verbatim** by the M5 amendment
(additively extended, not redefined). `signal` (M5) is a **separate,
workspace-scoped 1:N broadcast class**: a signal throw is delivered
at-least-once to every eligible active signal catch (boundary, intermediate,
or event-subprocess start) by `(workspaceId, signalName)`, with **no**
correlation key and **no** per-key uniqueness — the broker-key
single-active-subscription invariant above explicitly does **not** apply to
signals, which route through their own D1 substrate, never the message
correlation broker. This clause is recorded by the M5 amendment; it takes
runtime effect in M5-L5.

Rationale: event correlation is the bridge between external systems and durable
process execution, so weak matching would make the core flow unreliable.

### V. Auditability and Operator Clarity

Every key state transition MUST be recorded in audit history, including instance
start, current BPMN element changes, Service Task invocation/result, Receive Task
wait state, message correlation, completion, and errors. Operators MUST be able
to inspect instance status, current BPMN element, variables, and execution
history. Errors MUST explain what happened, which BPMN element was involved, and
what action is available next.

Rationale: the MVP is successful only when users can prove what happened during
execution without deploying a separate observability stack.

### VI. SAGA / Compensation Integrity

When a transaction-saga is cancelled, the orchestrator MUST compensate the
transaction's successfully completed activities **in reverse order of completion
within each causal chain (a token lineage)**, scoped to that transaction; ordering
**between concurrent branches is unconstrained**. A straggler activity that
completes after a parallel scope has begun compensating is still ledgered and
compensated (at-least-once, idempotent) and, within its lineage, before any
causally-earlier step. An instance completes only when **zero tokens remain in its
frontier** (multi-token completion). Each compensating action MUST be **idempotent** and
safe under **at-least-once** delivery (duplicate compensation callbacks MUST NOT
compensate twice), and MUST receive both the original step input and the captured
step output. Compensation MUST be triggered **only** by a transaction Cancel (an
error boundary event routing to a cancel end event, or an operator cancel), and
MUST NOT be triggered by an uncaught Error — an Error that reaches the transaction
boundary uncaught is a **Hazard** that terminates the instance and propagates, it
does not auto-compensate. A compensator that exhausts its own retries MUST settle
the instance into a deterministic, operator-visible terminal state
(`compensationFailed`) with operator-resumable remediation; it MUST NOT silently
block forever. Each meaningful saga transition (transaction entered/cancelled,
compensation started/completed/failed) MUST be written to D1 audit history.

Compensation generalizes to a **scope subtree** (M5): a transaction MAY nest
inside another scope (a `subProcess`, or another `transaction`), and "the
transaction's successfully completed activities" above means every completed,
compensatable step whose scope chain is rooted in the cancelling scope. A
nested transaction's commit is **non-terminal** (`committedLocal`): its rows
remain eligible for compensation by any **strict ancestor** transaction's
cancel until the **outermost** enclosing transaction commits, at which point
they seal (`committed`, terminal) — commit MUST NOT terminalize a nested
scope's rows against its own enclosing scopes. The straggler cohort and the
live-token barrier are **scope-subtree membership** tests (a token's position
is within the cancelling scope's subtree), not scope-equality tests, so a live
or straggling token in a deeper nested scope is neither missed (a leaked
uncompensated effect) nor wrongly excluded from the barrier (a wedge).
Compensation wiring (a compensation boundary + its `isForCompensation`
handler) is legal **iff some ancestor scope is a transaction** — an ancestry
check, not an immediate-parent check — so a handler with no reachable Cancel
trigger is rejected at publish with element id + reason. Compensating a
committed `callActivity` means driving the **child instance's own reverse
pass**; a child that settles `compensationFailed` surfaces as the parent's own
`compensationFailed` incident. The Cancel-only-trigger, Hazard-does-not-
auto-compensate, idempotent, and at-least-once clauses above are **unchanged**
by this generalization. This paragraph is recorded by the M5 amendment and
takes runtime effect starting in M5-L1 (subtree commit/cohort/barrier/
ancestry) and M5-L2 (child compensation).

Rationale: a saga's correctness is its rollback behavior; weak ordering,
non-idempotent compensators, or an ambiguous compensator-failure outcome would
make the orchestrator unsafe for the multi-microservice transactions it exists to
coordinate.

## MVP Scope and Platform Constraints

The first release MUST deliver the vertical demo flow: upload BPMN XML, validate
the supported subset, publish an immutable definition version, start an instance
with initial variables, execute a remote Service Task, wait in a Receive Task,
correlate an external message, complete the process, and inspect history.

The Cloudflare stack is the target execution platform for the MVP. The platform
MUST own durable execution, process state storage, remote service worker
invocation, external event waiting, event correlation, and basic execution
history.

The platform MUST NOT include built-in tasklists, BPMN User Task, forms,
assignment, complex gateways, conditional
or default sequence flows that do not leave an `exclusiveGateway`, timer
**start** events, non-interrupting **timer or conditional** boundary events,
`timeCycle` triggers, `conditional` / `link` events, a top-level (process-level)
`signal` **start** event, non-catch message events (message
**throw**/end — the only accepted message-shaped waits are the Receive Task and
the M3 message `intermediateCatchEvent`), `adHocSubProcess`, a non-process
`calledElement` (GlobalTask), `standardLoopCharacteristics`, MI's standard
ItemAwareElement data bindings (`loopDataInputRef`/`loopDataOutputRef`/
`inputDataItem`/`outputDataItem`) or an MI with no recognized cardinality
source, `compensateEventDefinition` on a throw or end event (and the
compensate-a-subProcess-as-a-unit boundary), process migration, full
Zeebe/Camunda compatibility, or a visual BPMN modeler unless this constitution
is amended first. (Each of these is added only by its own later milestone
amendment; the **M-UI read-only operator console** is added by the M-UI
amendment (a viewer + the existing cancel/retry controls, never an editor);
the M4 in-instance concurrency set — block-structured `parallelGateway` (AND)
and `inclusiveGateway` (OR) — is added by the M4 amendment, as the M3
time-&-failure-taxonomy set was by the prior one; the M5 composition set —
non-transaction `subProcess`, `callActivity`, `multiInstanceLoopCharacteristics`,
`escalation`, `signal`, and the first non-interrupting signal/escalation
boundaries — is added by the M5 amendment, opening per runtime layer M5-L1
through M5-L5.)

The accepted saga set — the `bpmn:transaction` scope, compensation / error /
cancel boundary events, the `isForCompensation` handler, `bpmn:association`, the
cancel end event, and root `bpmn:error` — is in scope (Principle I); only those
specific constructs were removed from this exclusion list. The accepted
conditional set — `bpmn:exclusiveGateway`, FEEL `conditionExpression` on flows
leaving it, the gateway-owned `default` flow, and cycles on the token path —
is likewise in scope (Principle I, the M2 amendment). The accepted M3
time-&-failure-taxonomy set — an interrupting boundary `timerEventDefinition` on
a `serviceTask`/`receiveTask`, a timer/message `intermediateCatchEvent`, the
`bpmn:eventBasedGateway`, and free error-boundary routing (static ISO-8601 timer
triggers only) — is in scope as of the M3 amendment (Principle I); the validator
opened each construct as its runtime layer shipped, and the whole M3 set has now
fully shipped — the interim "M3 — not yet implemented" rejection is retired (see
`docs/bpmn/09-easy-bpmn-profile.md`). The accepted M4 concurrency set —
block-structured (SESE) `bpmn:parallelGateway` (AND) and `bpmn:inclusiveGateway`
(OR), each split paired with one matching same-type join — is in scope as of this
M4 amendment (Principle I); the M4 amendment opened **publish-time validation** first
(a non-SESE / mismatched / branch-escaping / uncontrolled-merge / same-message
region is rejected with element ids), and the concurrency runtime has since
**fully shipped** across the M4 runtime layers (re-validated GREEN on real
Cloudflare Workflows 2026-06-14). Only `parallel` and `inclusive` were removed from the exclusion list
above (`complex` stays). Nothing else was removed.

The M-UI amendment additionally removed **only** "advanced Operate-style UI" from
the exclusion list above (a visual BPMN modeler and any instance-start /
model-editing write surface stay excluded). The accepted **M-UI operator
console** — a read-only React SPA served same-origin by the Worker, session-cookie
auth (`/ui/login|logout|me`), read/aggregation endpoints
(projects/attention/sagas, instance jobs+attempts, message search, raw BPMN XML,
an SSE history live-tail), BPMN viewing with a live execution overlay, and the
EXISTING cancel/retry operator controls — is in scope as of the M-UI amendment
(Principle V — the console is the UI surface of the operator-clarity principle, not
a new principle). It adds no BPMN construct (Principle I unchanged) and changes no
execution / immutability / idempotency / correlation / saga semantics. All console
inspection reads D1 only; no Cloudflare Workflow internal is exposed (the existing
inspection invariant is preserved).

The accepted M5 composition set — non-transaction `bpmn:subProcess` (embedded);
error and timer boundary events on a `subProcess`/`transaction`; an error end
event; `bpmn:callActivity` (with parent-publish-time version binding, Principle
II); `multiInstanceLoopCharacteristics` (parallel and sequential); `escalation`
throw/boundary/event-subprocess; `signal` throw/catch; and the first
non-interrupting boundary events (signal/escalation only) — is in scope, in
full, as of this M5 amendment (Principle I). Unlike the exclusion-list removal
pattern of earlier amendments, this single amendment accepts the **whole**
composition set up front; the validator/runtime instead open **per layer**
(M5-L1 embedded scopes + hierarchical exceptions; M5-L2 `callActivity`; M5-L3
`multiInstance`; M5-L4 escalation + event subprocess; M5-L5 signal), each
construct moving from "accepted-in-governance, interim-rejected-at-publish" to
"runtime open" as its own layer ships and records its own Constitution Check
and `docs/bpmn/09-easy-bpmn-profile.md` lockstep — exactly the ordering
discipline the M3 (L2-L4) and M4 (L1-L6) amendments established. `complexGateway`,
`conditional`/`link` events, `adHocSubProcess`, `standardLoopCharacteristics`, a
top-level `signal` start event, a non-process `calledElement`, and
`compensateEventDefinition` throw/end stay excluded — M5 is the last roadmap
milestone; no construct outside this named set is anticipated.

The first demo flow MUST run without requiring users to deploy their own workflow
cluster, broker, BPMN engine, or dedicated operations stack.

## Development Workflow and Quality Gates

Feature specifications MUST describe the user-visible process lifecycle impact
and explicitly list any BPMN elements or external events the feature touches.
Plans MUST pass the Constitution Check before Phase 0 research and again after
Phase 1 design. Any violation MUST be listed in Complexity Tracking with a
specific reason and a rejected simpler alternative.

Runtime, API, and persistence work MUST include contract or integration tests for
the relevant constitution-critical behavior: BPMN subset validation, immutable
version binding, Service Task worker contracts, Receive Task correlation,
idempotency/retry handling, audit history, and operator-visible errors. Pure
documentation or scaffolding work may mark a gate as not applicable only with an
explicit rationale in the plan.

Generated tasks MUST preserve user-story independence while also surfacing
foundation tasks for validation, persistence, worker contracts, event
correlation, idempotency, audit history, and error reporting when those concerns
are in scope.

## Governance

This constitution supersedes conflicting project practices for easy-bpmn.
Amendments require an updated constitution, a Sync Impact Report, semantic
version bump reasoning, and review of dependent Spec Kit templates. Work tracked
in Backlog MUST reference constitution-impacting file changes when it modifies
project governance or quality gates.

Versioning policy:
- MAJOR versions redefine or remove core principles, or expand product scope in a
  way that invalidates existing governance.
- MINOR versions add principles, add governance sections, or materially expand
  guidance while preserving existing principles.
- PATCH versions clarify wording, fix mistakes, or make non-semantic refinements.

Compliance review is required for each generated spec, plan, and tasks artifact.
Plans with unresolved constitution violations MUST NOT proceed to implementation
until the violation is either removed or explicitly accepted through the
Complexity Tracking section.

**Version**: 2.5.0 | **Ratified**: 2026-06-07 | **Last Amended**: 2026-07-02
