---
id: TASK-3
title: Generate BPMN-lite orchestrator MVP implementation plan
status: Done
assignee:
  - '@Codex'
created_date: '2026-06-07 21:48'
updated_date: '2026-06-07 21:56'
labels:
  - spec-kit
  - planning
  - mvp
  - cloudflare
dependencies: []
documentation:
  - specs/001-bpmn-lite-orchestrator-mvp/spec.md
  - .specify/memory/constitution.md
  - .specify/templates/plan-template.md
modified_files:
  - specs/001-bpmn-lite-orchestrator-mvp/plan.md
  - specs/001-bpmn-lite-orchestrator-mvp/research.md
  - specs/001-bpmn-lite-orchestrator-mvp/data-model.md
  - specs/001-bpmn-lite-orchestrator-mvp/contracts
  - specs/001-bpmn-lite-orchestrator-mvp/quickstart.md
  - AGENTS.md
priority: high
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Generate the Spec Kit planning artifacts for the BPMN-lite orchestrator MVP from specs/001-bpmn-lite-orchestrator-mvp/spec.md. The agreed technical direction is Cloudflare Workers HTTP API plus one Cloudflare Workflow instance per BPMN process instance, a Durable Object correlation broker for messageName + correlationKey matching, and D1 as canonical queryable persistence and audit history. The plan must preserve the product promise of BPMN execution without Camunda/Zeebe operations while retaining workflow-engine-grade runtime constraints.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Spec Kit plan.md is generated for specs/001-bpmn-lite-orchestrator-mvp/spec.md and records the agreed Cloudflare Workers + Workflows + Durable Object broker + D1 architecture.
- [x] #2 research.md resolves technical choices and documents why Workflows-first execution with explicit API, broker, and persistence boundaries was selected over credible alternatives.
- [x] #3 data-model.md captures drafts, immutable versions, process instances, service task jobs, workflow instance binding, message subscriptions, external messages, history events, variables, and incidents.
- [x] #4 contracts/ documents the public interfaces for upload, publish, start, message publish/correlation, instance inspection, and any runtime worker/message contracts needed by the MVP.
- [x] #5 quickstart.md describes runnable end-to-end validation scenarios for upload -> publish -> start -> service task -> receive message -> complete -> inspect history, including duplicate and early-message cases.
- [x] #6 AGENTS.md points the Spec Kit managed section at the generated implementation plan.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Run Spec Kit plan setup for specs/001-bpmn-lite-orchestrator-mvp/spec.md and inspect extension hooks before/after planning.
2. Fill plan.md with the approved architecture: Cloudflare Workers HTTP API, one Cloudflare Workflow instance per BPMN process instance, Durable Object correlation broker, and D1 canonical persistence/history.
3. Generate research.md documenting the Workflows-first execution decision, why the explicit API/broker/persistence boundaries are required, and alternatives considered.
4. Generate data-model.md for drafts, immutable definition versions, process instances, workflow instance binding, service task jobs/attempts, subscriptions, messages, variables, history, and incidents.
5. Generate contracts/ for the MVP public API and runtime contracts: BPMN definition lifecycle, instance start/inspect, external message publish, sample service worker behavior, and event delivery to Workflows.
6. Generate quickstart.md with end-to-end validation scenarios including the happy path, unsupported BPMN rejection, duplicate message publish, early-message buffering, and service task retry/incident behavior.
7. Update AGENTS.md Spec Kit managed section to reference the generated plan and verify all acceptance criteria with repository checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Generated Spec Kit planning artifacts for specs/001-bpmn-lite-orchestrator-mvp using the approved architecture: Cloudflare Workers HTTP API, one Cloudflare Workflow instance per BPMN process instance, Durable Object correlation broker, and D1 canonical persistence/history. The agent-context update script was attempted but skipped because PyYAML is not installed; AGENTS.md was updated manually between the Spec Kit markers with the same plan path. Verification run: required artifact file checks passed; AGENTS.md contains specs/001-bpmn-lite-orchestrator-mvp/plan.md; npx --yes js-yaml parsed contracts/openapi.yaml successfully; rg scans found no unresolved Spec Kit placeholders, no non-ASCII characters in generated artifacts/AGENTS.md, and no trailing whitespace; git diff --check passed for the touched/generated files.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Generated the Spec Kit planning phase for the BPMN-lite orchestrator MVP.

Created plan.md, research.md, data-model.md, quickstart.md, contracts/openapi.yaml, and contracts/runtime-contracts.md under specs/001-bpmn-lite-orchestrator-mvp. The plan records the agreed Workflows-first architecture with explicit boundaries: Cloudflare Workers HTTP API as the product surface, one Cloudflare Workflow instance per BPMN process instance, Durable Object broker for deterministic message correlation and deduplication, and D1 as canonical queryable persistence and audit history.

The research artifact documents the selected approach and alternatives. The data model covers drafts, immutable versions, process instances, Workflow bindings, Service Task jobs/attempts, subscriptions, messages, variables, history events, incidents, and idempotency records. Contracts cover public API endpoints and runtime Worker/Workflow/broker behavior. Quickstart captures the full demo flow plus unsupported BPMN rejection, duplicate messages, early-message buffering, retry/incident behavior, and immutable version binding.

Verification completed: required artifact checks passed; AGENTS.md points at specs/001-bpmn-lite-orchestrator-mvp/plan.md; OpenAPI YAML parsed with npx js-yaml; placeholder, non-ASCII, trailing-whitespace, and git diff --check scans passed. The optional agent-context hook could not run because PyYAML is unavailable, so AGENTS.md was updated manually with the same managed-section result.
<!-- SECTION:FINAL_SUMMARY:END -->
