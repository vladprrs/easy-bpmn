# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]

**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION]

**Primary Dependencies**: [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION]

**Storage**: [if applicable, e.g., PostgreSQL, CoreData, files or N/A]

**Testing**: [e.g., pytest, XCTest, cargo test or NEEDS CLARIFICATION]

**Target Platform**: [e.g., Linux server, iOS 15+, WASM or NEEDS CLARIFICATION]

**Project Type**: [e.g., library/cli/web-service/mobile-app/compiler/desktop-app or NEEDS CLARIFICATION]

**Performance Goals**: [domain-specific, e.g., 1000 req/s, 10k lines/sec, 60 fps or NEEDS CLARIFICATION]

**Constraints**: [domain-specific, e.g., <200ms p95, <100MB memory, offline-capable or NEEDS CLARIFICATION]

**Scale/Scope**: [domain-specific, e.g., 10k users, 1M LOC, 50 screens or NEEDS CLARIFICATION]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

For each gate, mark PASS, FAIL, or N/A with rationale. Any FAIL requires an
entry in Complexity Tracking before implementation planning may continue.

- **BPMN profile**: Feature uses only standard BPMN 2.0-compatible elements within
  the supported profile (the linear core, the canonical transaction-saga set —
  `bpmn:transaction`, compensation/error/cancel boundary events, `isForCompensation`
  handler, `bpmn:association`, cancel end event, root `bpmn:error` — plus the M2
  conditional set: `bpmn:exclusiveGateway`, FEEL `conditionExpression` on flows
  leaving an exclusiveGateway, the gateway-owned `default` flow, cycles on the
  token path), introduces no custom notation, stays XSD-valid and
  modeler-round-trippable when easy-bpmn extensions + DI are ignored, and rejects
  unsupported standard-namespace flow nodes before publish with the element id +
  a user-visible reason.
- **SAGA / Compensation integrity**: If the feature touches sagas, compensation
  runs in reverse completion order, scoped to its transaction, idempotent +
  at-least-once; compensation is triggered only by transaction Cancel (never by an
  uncaught Error/Hazard); a compensator that exhausts retries settles to
  `compensationFailed` with operator remediation, never blocking forever. N/A only
  with a one-sentence rationale.
- **Immutable version binding**: Published process definitions are immutable, and
  running instances bind to exactly one definition version for their lifetime.
- **Durable idempotency**: Runtime transitions, Service Task calls, callbacks,
  retries, and external messages are safe to replay or receive more than once.
- **Receive Task correlation**: External messages correlate by message name plus
  correlation key to exactly one eligible waiting instance, with deterministic
  responses for missing, ambiguous, duplicate, or late messages.
- **Audit and operator clarity**: State transitions, worker results, waits,
  correlations, completions, and errors are captured in history; operators can
  inspect status, current BPMN element, variables, and actionable errors.
- **MVP scope and platform**: The feature preserves the upload -> publish ->
  start -> service task -> receive message -> complete -> history demo flow on
  the Cloudflare-targeted platform, or records a constitution violation.

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
