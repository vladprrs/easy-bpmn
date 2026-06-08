<!--
Sync Impact Report
Version change: 1.0.0 -> 2.0.0
Rationale (MAJOR): expands product scope from the linear MVP profile to the
canonical BPMN transaction-saga, in a way that invalidates the prior governance
(the old MVP Scope list forbade compensation, transaction subprocess, and the
saga boundary events). Per the versioning policy ("MAJOR = expand product scope
in a way that invalidates existing governance"). Source: SAGA orchestrator design
(docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md §7, §2 decision #7).
Modified principles:
- I. Standard BPMN-Lite Profile Only -> I. Standard BPMN Profile Only (widened to
  the canonical-saga construct set; the no-custom-notation / XSD-valid /
  round-trippable / reject-unsupported-flow-node-with-element-id-and-reason clause
  is preserved verbatim in intent)
Added principles:
- VI. SAGA / Compensation Integrity
Modified sections:
- MVP Scope and Platform Constraints (exclusion list trimmed to remove only the
  M1-shipped constructs: transaction subprocess, compensation, saga boundary
  events; gateways/timers/non-transaction subprocess/multi-instance/user-task/
  forms/migration/full-Camunda-Zeebe-compat/visual-modeler remain excluded)
Templates requiring updates:
- updated: .specify/templates/plan-template.md (Constitution Check: widened BPMN
  profile gate + new SAGA/Compensation-integrity gate)
- updated: .specify/templates/spec-template.md (BPMN Profile Impact prompt covers
  saga/compensation constructs)
- updated: .specify/templates/tasks-template.md (constitution-critical test list
  adds compensation ordering, saga state transitions, worker auth/workspace
  isolation, operator remediation)
- checked: AGENTS.md
- checked: CLAUDE.md (Known doc drift note resolved separately)
Follow-up TODOs:
- M2-M5 each still require their own amendment before adding gateways, timers,
  parallelism, or composition.
-->

# easy-bpmn Constitution

## Core Principles

### I. Standard BPMN Profile Only

The platform MUST execute only standard BPMN 2.0-compatible elements in this
profile. The currently accepted construct set is:

- the linear core — None Start Event, Service Task, Receive Task, None End Event,
  Sequence Flow, and Message correlation; and
- the canonical transaction-saga set — `bpmn:transaction` (the saga scope), the
  compensation / error / cancel `boundaryEvent`, an `isForCompensation` Service
  Task (compensation handler), `bpmn:association` (compensation wiring), a cancel
  `endEvent` (only inside a transaction), and a root `bpmn:error`.

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

Each later milestone (gateways/conditions, timers, parallelism, composition)
widens this profile only by amending this constitution first.

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
with the transition that continues the instance. Human work remains outside the
platform; the platform receives only the fact of that work as a BPMN-compatible
message.

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
transaction's successfully completed activities **in reverse completion order**,
scoped to that transaction. Each compensating action MUST be **idempotent** and
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
assignment, gateways and conditional/default sequence flows, timer / signal /
escalation / conditional / message events, non-transaction subprocesses,
`callActivity`, ad-hoc subprocesses, multi-instance / loop characteristics,
process migration, full Zeebe/Camunda compatibility, a visual BPMN modeler, or
advanced Operate-style UI unless this constitution is amended first. (Each of
these is added only by its own later milestone amendment — M2 gateways/conditions,
M3 timers/event taxonomy, M4 parallelism, M5 composition.)

The accepted saga set — the `bpmn:transaction` scope, compensation / error /
cancel boundary events, the `isForCompensation` handler, `bpmn:association`, the
cancel end event, and root `bpmn:error` — is in scope (Principle I); only those
specific constructs were removed from this exclusion list.

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

**Version**: 2.0.0 | **Ratified**: 2026-06-07 | **Last Amended**: 2026-06-08
