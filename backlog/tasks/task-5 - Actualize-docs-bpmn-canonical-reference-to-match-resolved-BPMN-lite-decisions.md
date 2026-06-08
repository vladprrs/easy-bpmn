---
id: TASK-5
title: Actualize docs/bpmn canonical reference to match resolved BPMN-lite decisions
status: Done
assignee: []
created_date: '2026-06-07 22:33'
updated_date: '2026-06-07 22:33'
labels:
  - docs
  - bpmn
  - canonicity
dependencies:
  - TASK-4
references:
  - .specify/memory/constitution.md
  - specs/001-bpmn-lite-orchestrator-mvp/research.md
modified_files:
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/02-activities.md
  - docs/bpmn/04-flows-and-data.md
  - docs/bpmn/06-xml-serialization.md
  - docs/bpmn/08-engines-and-extensions.md
priority: high
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up to TASK-4. TASK-4 aligned the spec (specs/001) with canonical BPMN, but the canonical reference under docs/bpmn still described the now-resolved binding and validation decisions as open ("TBD" worker binding, "reject anything else" validation, the <message> overstated as carrying name + correlation). This task brings the reference into line so spec and reference are consistent.

Scope: update 09-easy-bpmn-profile.md (the profile contract) and the ## easy-bpmn scope sections (plus the canonical XML example and parsing checklist) where the resolved decisions land. The constitution is intentionally left for a separate amendment; docs/bpmn is updated as the operational reference only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 09 defines "no custom notation" precisely (no new MODEL-namespace tags/attrs, no redefinition of standard-element meaning, no non-standard attribute required to parse) with the operative test being XSD validity plus round-trip through a standard modeler when easy-bpmn extensions and DI are ignored
- [x] #2 09 documents the easy-bpmn:taskDefinition extension (type + retries, http://easy-bpmn/schema/1.0 namespace, routed by type not id/name) and reflects it in the whitelist, runtime-mapping, validation rules, and accept/reject examples
- [x] #3 09 splits rejection: unsupported standard-namespace flow nodes are rejected with a reason; foreign-namespace extensionElements, DI, and documentation are tolerated and ignored
- [x] #4 09 rejects receiveTask instantiate="true" / any non-none instantiation and requires each serviceTask to declare a non-empty taskType
- [x] #5 09 records resolved decisions (worker binding, correlation-key-via-API, bpmn-moddle parser) and remaining open items, cross-referencing research.md
- [x] #6 ## easy-bpmn scope sections updated where decisions land: 02-activities (service task taskType binding + instantiate rejection + correlation honesty), 04-flows-and-data (message carries only name; key via API), 08-engines-and-extensions (binding resolved); 01/03/05 verified unchanged because still accurate
- [x] #7 06-xml-serialization canonical example carries easy-bpmn:taskDefinition + namespace declaration, and the parsing checklist distinguishes reject-flow-nodes from tolerate-extensions
- [x] #8 Stale phrasings removed across docs/bpmn (TBD, "reject anything else", "by task name/type", old "carries name + correlation"); spec and reference are consistent
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Re-read the resolved decisions captured in TASK-4 (research.md) and the current docs/bpmn reference.
2. Rewrite 09-easy-bpmn-profile.md (the profile contract): precise "no custom notation" definition + operative test; dedicated easy-bpmn:taskDefinition extension section; whitelist/runtime-mapping/validation-rules/accept-reject updated; reject-vs-tolerate split; resolved-decisions section.
3. Update the ## easy-bpmn scope sections where the decisions land (02, 04, 08); verify 01/03/05 are still accurate and leave them.
4. Update the canonical XML example and parsing checklist in 06 for coherence.
5. Leave the constitution untouched (separate amendment) and grep docs/bpmn to confirm stale phrasings are gone and new anchors are present.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Structure decision: created as a standalone task with a dependency on TASK-4 (not a subtask). TASK-4 was the spec-side alignment and TASK-5 is the reference-side alignment of the same canonicity initiative; a dependency models 'docs were brought in line with the decisions made in TASK-4' more accurately than a parent/child umbrella.

Namespace chosen for the extension: http://easy-bpmn/schema/1.0, consistent with the existing http://easy-bpmn/demo targetNamespace style already in 06's example. The URI is an identifier and need not resolve.

09 rewritten in full (via Write) rather than piecemeal because the changes were cross-cutting (definition, whitelist, machinery, validation rules 8->10, runtime mapping, examples, open-questions->resolved). Out-of-scope table and runtime-mapping table reproduced verbatim except the Service Task row.

06 was edited for coherence even though it is neither a scope section nor 09: it carried the now-stale serviceTask 'TBD binding' note and a 'reject anything else' checklist line that directly contradicted the resolved decisions. Added easy-bpmn:taskDefinition + xmlns to the canonical example so the reference example is actually runnable under the resolved binding.

01/03/05 scope sections verified and deliberately left unchanged: gateways and swimlanes are fully out (no nuance changed), and 01's none-start/none-end + receive-task-as-task framing is accurate. README/glossary/00/resources also left as accurate at their altitude.

Constitution intentionally NOT modified. 09 frames the precise wording as the operational reading of Principle I and flags that codifying it (and the easy-bpmn: binding) as governance needs a separate constitution amendment + Sync Impact Report + version bump.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Brought the canonical BPMN reference (docs/bpmn) into line with the binding/validation decisions resolved in TASK-4, so spec and reference are now consistent. The constitution is intentionally left for a separate amendment.

Files changed:
- 09-easy-bpmn-profile.md (major): added a precise "no custom notation" definition + operative test (XSD-valid, round-trips in a standard modeler when easy-bpmn extensions/DI ignored); added an easy-bpmn:taskDefinition extension section (type + retries, http://easy-bpmn/schema/1.0, routed by type not id/name); updated whitelist, runtime mapping, accept/reject examples; expanded validation rules from 8 to 10 (namespace-aware parse, no model-based instantiation, service task bound, extensions tolerated); replaced "open questions" with a "resolved decisions & remaining open questions" section cross-referencing research.md.
- 02-activities.md: Service Task taskType binding; Receive Task instantiate="true" rejected + correlation-key-via-API honesty; ## easy-bpmn scope updated.
- 04-flows-and-data.md: ## easy-bpmn scope — <message> carries only its name; correlation key supplied via API in MVP; model-level deferred.
- 06-xml-serialization.md: canonical example now carries easy-bpmn:taskDefinition + xmlns:easy-bpmn; the serviceTask note rewritten; parsing checklist split into reject-flow-nodes vs tolerate-extensions.
- 08-engines-and-extensions.md: ## easy-bpmn scope — worker binding resolved to easy-bpmn:taskDefinition; reuse of camunda/zeebe verbatim recorded as rejected.

Left unchanged (verified still accurate): 00, 01, 03, 05, glossary, README, resources.

Tests: none (reference-documentation change; no project DoD defaults). Verified by grep that stale phrasings (TBD, "reject anything else", "by task name/type", old "carries name + correlation") are gone and the new anchors (easy-bpmn:taskDefinition, taskType, instantiate rejection, tolerate-extensions) are present.

Follow-up / risks: the remaining governance item is a constitution amendment to codify the "no custom notation" wording and the easy-bpmn: binding as Principle-I governance (Sync Impact Report + version bump). Flagged in 09's closing note; not done here. No code is affected by this task.
<!-- SECTION:FINAL_SUMMARY:END -->
