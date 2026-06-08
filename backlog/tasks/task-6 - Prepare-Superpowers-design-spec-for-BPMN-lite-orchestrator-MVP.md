---
id: TASK-6
title: Prepare Superpowers design spec for BPMN-lite orchestrator MVP
status: In Progress
assignee:
  - codex
created_date: '2026-06-07 22:41'
updated_date: '2026-06-07 22:58'
labels:
  - documentation
  - superpowers
  - bpmn-lite
dependencies: []
documentation:
  - specs/001-bpmn-lite-orchestrator-mvp/spec.md
  - specs/001-bpmn-lite-orchestrator-mvp/plan.md
  - specs/001-bpmn-lite-orchestrator-mvp/research.md
  - specs/001-bpmn-lite-orchestrator-mvp/data-model.md
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/openapi.yaml
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/runtime-contracts.md
  - specs/001-bpmn-lite-orchestrator-mvp/quickstart.md
modified_files:
  - docs/superpowers/specs/2026-06-07-bpmn-lite-orchestrator-mvp-design.md
  - >-
    backlog/docs/superpowers/specs/2026-06-07-bpmn-lite-orchestrator-mvp-design/doc-1
    - BPMN-lite-Orchestrator-MVP-Superpowers-Design.md
  - >-
    backlog/tasks/task-6 -
    Prepare-Superpowers-design-spec-for-BPMN-lite-orchestrator-MVP.md
priority: medium
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create a Superpowers brainstorming design/spec that distills the existing Spec Kit BPMN-lite orchestrator MVP artifacts into an implementation-ready design, without changing runtime code. The spec must preserve the product constraints already captured in specs/001-bpmn-lite-orchestrator-mvp, especially canonical BPMN compatibility, immutable published versions, Workflows-first execution, Durable Object message correlation, D1 auditability, idempotency, and MVP scope boundaries.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Existing Spec Kit artifacts under specs/001-bpmn-lite-orchestrator-mvp are reviewed and reflected accurately in the Superpowers design.
- [x] #2 The design proposes clear approaches/trade-offs and records the selected approach after user approval.
- [x] #3 The written spec is saved under docs/superpowers/specs with the 2026-06-07 BPMN-lite MVP topic name and contains no unresolved placeholders or contradictory requirements.
- [x] #4 The design document is committed to git after user approval and self-review, with no runtime implementation changes included.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Treat specs/001-bpmn-lite-orchestrator-mvp as the source of truth for product requirements, contracts, and architecture. Do not change runtime code.
2. Prepare a Superpowers design/spec in hybrid form: implementation bridge plus risk/decomposition map.
3. Keep the spec compact and implementation-facing: summarize the approved runtime architecture, module boundaries, invariants, sequencing, validation strategy, risks, and explicitly out-of-scope items instead of restating the full Spec Kit feature spec.
4. Preserve the key resolved decisions: Workflows-first execution, one Cloudflare Workflow per process instance, Durable Object correlation broker per workspace/message/correlation key, D1 as canonical queryable audit store, bpmn-moddle parser, easy-bpmn:taskDefinition taskType/retries in extensionElements, API-supplied correlation key for MVP, idempotency and duplicate handling guarantees.
5. Note observed documentation drift without expanding scope: specs/001 is authoritative over the lingering docs/bpmn wording that mentions Durable Object per instance.
6. Present design sections for user approval, then write docs/superpowers/specs/2026-06-07-bpmn-lite-orchestrator-mvp-design.md, self-review for placeholders/contradictions/ambiguity, commit the design doc, and ask for final user review before invoking writing-plans.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
User approved the hybrid format: implementation bridge plus risk/decomposition map. User then approved all design sections: source-of-truth role, runtime architecture, module boundaries/invariants, decomposition/risk map, and error handling/testing. Wrote canonical spec to docs/superpowers/specs/2026-06-07-bpmn-lite-orchestrator-mvp-design.md and kept the Backlog-managed document copy created by the document pipeline. Self-review pass found no unresolved TODO/TBD/placeholders and git diff --check passed. The mention of 'Durable Object per instance' in the spec is intentional documentation-drift context; the design makes specs/001 authoritative and records one Cloudflare Workflow per process instance plus DO correlation broker as the implementation architecture.

Committed the approved design/spec artifacts. No runtime implementation files were changed. TASK-6 remains ready for user review before the Superpowers workflow proceeds to writing-plans.
<!-- SECTION:NOTES:END -->
