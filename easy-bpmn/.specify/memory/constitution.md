<!--
Sync Impact Report
Version change: template -> 1.0.0
Modified principles:
- Placeholder Principle 1 -> I. Standard BPMN-Lite Profile Only
- Placeholder Principle 2 -> II. Immutable Definitions and Version-Bound Instances
- Placeholder Principle 3 -> III. Durable, Idempotent Execution
- Placeholder Principle 4 -> IV. Correlation and Receive Task Integrity
- Placeholder Principle 5 -> V. Auditability and Operator Clarity
Added sections:
- MVP Scope and Platform Constraints
- Development Workflow and Quality Gates
Removed sections:
- Placeholder Section 2
- Placeholder Section 3
Templates requiring updates:
- updated: .specify/templates/plan-template.md
- updated: .specify/templates/spec-template.md
- updated: .specify/templates/tasks-template.md
- checked: .specify/templates/commands/*.md (directory not present)
- checked: AGENTS.md
- checked: CLAUDE.md
Follow-up TODOs:
- None
-->

# easy-bpmn Constitution

## Core Principles

### I. Standard BPMN-Lite Profile Only

The MVP MUST execute only standard BPMN 2.0-compatible elements in this profile:
Start Event, Service Task, Receive Task, End Event, Sequence Flow, and Message
correlation. The supported happy path is Start Event -> Service Task ->
Receive Task -> End Event. Features MUST NOT introduce custom notation,
platform-only BPMN semantics, or unsupported runtime behavior. Unsupported BPMN
elements MUST be rejected before publish with a user-visible reason.

Rationale: the product promise depends on making standard BPMN executable without
pretending to support the full BPMN ecosystem in the first slice.

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

## MVP Scope and Platform Constraints

The first release MUST deliver the vertical demo flow: upload BPMN XML, validate
the supported subset, publish an immutable definition version, start an instance
with initial variables, execute a remote Service Task, wait in a Receive Task,
correlate an external message, complete the process, and inspect history.

The Cloudflare stack is the target execution platform for the MVP. The platform
MUST own durable execution, process state storage, remote service worker
invocation, external event waiting, event correlation, and basic execution
history.

The MVP MUST NOT include built-in tasklists, BPMN User Task, forms, assignment,
gateways, timers, boundary events, subprocesses, multi-instance, compensation,
process migration, full Zeebe/Camunda compatibility, a visual BPMN modeler, or
advanced Operate-style UI unless this constitution is amended first.

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

**Version**: 1.0.0 | **Ratified**: 2026-06-07 | **Last Amended**: 2026-06-07
