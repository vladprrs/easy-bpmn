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
  and the `terminate` end event stays out of scope.

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

Each later milestone (composition) widens this profile only by amending this
constitution first — exactly as this M4 amendment does for the block-structured
parallel/inclusive concurrency set (and as the M3 amendment did for timers,
intermediate catch events, the `eventBasedGateway`, and the failure taxonomy).

Rationale: the product promise depends on making standard BPMN executable without
inventing a notation or pretending to support the full BPMN ecosystem at once.

### II. Immutable Definitions and Version-Bound Instances

Publishing a process definition MUST create an immutable version. Running process
instances MUST bind to exactly one published definition version for their entire
lifetime. Changes to a BPMN XML document MUST produce a new definition version,
not mutate a published one. MVP work MUST NOT include runtime migration between
definition versions.

Rationale: deterministic execution and debuggable history require stable process
metadata after an instance starts.

### III. Durable, Idempotent Execution

Runtime state transitions, remote service worker calls, callbacks, retries, and
external messages MUST be safe to replay or receive more than once. Service Task
execution MUST persist worker output variables before advancing the instance.
Duplicate callbacks, duplicate external events, and retry attempts MUST NOT
corrupt variables, skip required states, or create duplicate completion effects.

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
**start** events, non-interrupting boundary timers, `timeCycle` triggers,
signal / escalation / conditional events, non-catch message events (message
**throw**/end — the only accepted message-shaped waits are the Receive Task and
the M3 message `intermediateCatchEvent`), non-transaction
subprocesses, `callActivity`, ad-hoc subprocesses, multi-instance / loop
characteristics (`multiInstanceLoopCharacteristics` /
`standardLoopCharacteristics` markers — distinct from the accepted cycles on
the token path), process migration, full Zeebe/Camunda compatibility, a visual
BPMN modeler, or advanced Operate-style UI unless this constitution is amended
first. (Each of these is added only by its own later milestone amendment —
M5 composition; the M4 in-instance concurrency set — block-structured
`parallelGateway` (AND) and `inclusiveGateway` (OR) — is added by THIS amendment,
as the M3 time-&-failure-taxonomy set was by the prior one.)

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

**Version**: 2.3.1 | **Ratified**: 2026-06-07 | **Last Amended**: 2026-06-14
