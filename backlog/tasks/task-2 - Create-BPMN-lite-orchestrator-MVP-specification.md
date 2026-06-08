---
id: TASK-2
title: Create BPMN-lite orchestrator MVP specification
status: Done
assignee:
  - Codex
created_date: '2026-06-07 21:21'
updated_date: '2026-06-07 21:25'
labels:
  - spec-kit
  - mvp
  - documentation
dependencies: []
documentation:
  - easy-bpmn/start.md
  - easy-bpmn/.specify/memory/constitution.md
  - easy-bpmn/.specify/templates/spec-template.md
modified_files:
  - easy-bpmn/specs
  - easy-bpmn/.specify/feature.json
priority: high
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create the Spec Kit feature specification for the easy-bpmn MVP using start.md plus the clarified product context from the brainstorming discussion. The specification should be product-first, proving 'BPMN without Camunda/Zeebe ops', while preserving Zeebe-like runtime constraints for Service Task jobs, message correlation, retries, incidents, idempotency, and execution history.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Spec directory under easy-bpmn/specs is created with a completed spec.md for the BPMN-lite orchestrator MVP.
- [x] #2 Spec captures the approved A+C framing: product-first vertical demo flow plus explicit Zeebe-like runtime constraints.
- [x] #3 Spec includes no unresolved placeholders or [NEEDS CLARIFICATION] markers.
- [x] #4 Specification quality checklist is created and all validation items are checked.
- [x] #5 Spec Kit feature pointer .specify/feature.json references the created feature directory.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Run the mandatory before_specify git feature hook once with short name bpmn-lite-orchestrator-mvp.
2. Create the next sequential Spec Kit feature directory under specs/ and persist .specify/feature.json to point to it.
3. Write a completed spec.md from the active spec template using the approved A+C framing: product-first vertical slice with Zeebe-like runtime constraints as explicit requirements and edge cases.
4. Create checklists/requirements.md and validate all Spec Kit quality criteria; update the spec until no placeholders or [NEEDS CLARIFICATION] markers remain.
5. Record after_specify optional hooks for the user rather than executing them automatically, then finalize TASK-2.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
User selected A+C framing after brainstorming: product-first vertical slice plus balanced runtime constraints. Clarified decisions include Draft + immutable published versions, Zeebe-like durable Service Task job lifecycle, messageName + correlationKey correlation, fixed TTL early-message buffering, messageId deduplication scoped by messageName + correlationKey, duplicate publish response stability, business timeline plus diagnostics with raw payload snapshots, and view-only incident state.

Verification completed before finalization: placeholder/clarification scan on specs/001-bpmn-lite-orchestrator-mvp/spec.md returned no matches; requirements checklist has no unchecked items; jq confirmed .specify/feature.json points to specs/001-bpmn-lite-orchestrator-mvp; spec.md, checklist, and feature.json all exist. Mandatory before_specify hook ran once and returned BRANCH_NAME=001-bpmn-lite-orchestrator-mvp, FEATURE_NUM=001, but skipped git branch creation because the git extension did not detect a repository inside easy-bpmn.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Created the Spec Kit feature specification for the BPMN-lite orchestrator MVP at specs/001-bpmn-lite-orchestrator-mvp/spec.md and persisted .specify/feature.json for downstream Spec Kit commands.

The spec uses the approved A+C framing: it leads with the product-first vertical demo flow for 'BPMN without Camunda/Zeebe operations' and captures runtime constraints as observable requirements: draft plus immutable published versions, durable Service Task job lifecycle, at-least-once worker delivery, idempotent callbacks/messages, per-Service-Task retry policy via BPMN-compatible metadata, fixed-TTL early-message buffering, messageId deduplication scoped by messageName + correlationKey, stable duplicate publish responses, view-only incidents, and execution history with business timeline plus diagnostics and raw payload snapshots.

Created and validated specs/001-bpmn-lite-orchestrator-mvp/checklists/requirements.md with all checklist items checked. No unresolved placeholders or [NEEDS CLARIFICATION] markers remain in the spec. Optional after_specify hooks were not executed automatically.
<!-- SECTION:FINAL_SUMMARY:END -->
