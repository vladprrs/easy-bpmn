---
id: TASK-4
title: Align BPMN-lite MVP spec with canonical BPMN (no custom notation)
status: Done
assignee: []
created_date: '2026-06-07 22:21'
updated_date: '2026-06-07 22:21'
labels:
  - spec
  - bpmn
  - canonicity
dependencies:
  - TASK-2
  - TASK-3
references:
  - .specify/memory/constitution.md
  - start.md
documentation:
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/06-xml-serialization.md
  - docs/bpmn/08-engines-and-extensions.md
modified_files:
  - specs/001-bpmn-lite-orchestrator-mvp/spec.md
  - specs/001-bpmn-lite-orchestrator-mvp/plan.md
  - specs/001-bpmn-lite-orchestrator-mvp/research.md
  - specs/001-bpmn-lite-orchestrator-mvp/data-model.md
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/runtime-contracts.md
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/openapi.yaml
  - specs/001-bpmn-lite-orchestrator-mvp/quickstart.md
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A canonicity audit of the BPMN-lite Orchestrator MVP spec (specs/001) against the canonical BPMN reference (docs/bpmn) found that the "BPMN-lite profile" left several canonicity-critical points under-specified or non-canonical, risking the product's core promise of "standard BPMN 2.0, no custom notation":

- "No custom notation" was never defined, yet the spec unavoidably needs Service Task worker binding and retry metadata (core BPMN has no standard mechanism for either).
- The Service Task→worker binding and the correlation-key source were left as open questions; the runtime contract implicitly routed workers by the tool-generated element id.
- The validator's "reject anything not whitelisted" rule contradicted BPMN's requirement that conformant tools tolerate/ignore foreign-namespace extension elements, DI, and documentation.
- The chosen parser (fast-xml-parser) cannot do canonical namespace-aware parsing, contradicting the reference's bpmn-moddle recommendation.

Outcome: bring every spec artifact into line with the canonical reference so the product executes only standard BPMN 2.0, carries binding solely in the standard <extensionElements> escape hatch under an easy-bpmn namespace, keeps files XSD-valid and round-trippable in standard modelers, and records the open binding decisions honestly. docs/bpmn is the canonical research reference and is intentionally left unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 "No custom notation" is defined precisely in spec.md (no new MODEL-namespace tags/attributes, no redefinition of standard-element runtime meaning, no non-standard attribute required to parse) with the operative test being BPMN 2.0 XSD validity plus round-trip through a standard modeler when easy-bpmn extensions and DI are ignored
- [x] #2 Validation rejects only unsupported standard-namespace flow nodes/constructs; foreign-namespace extensionElements, Diagram Interchange, and documentation are tolerated and ignored (spec FR-002/FR-003/FR-003a, data-model validation rules, quickstart Scenario 2)
- [x] #3 Service Task worker is routed by a stable author-defined taskType carried in <extensionElements> under the easy-bpmn namespace, never by element id or name (spec FR-011/FR-011a, data-model BPMN Element + Service Task Job, runtime-contracts worker request, openapi BpmnElement.taskType)
- [x] #4 Correlation-key source is stated honestly as API-supplied at instance start and not model-derived, with model-level (subscription/FEEL) correlation explicitly deferred (spec FR-013, data-model, runtime-contracts, openapi description, research decision)
- [x] #5 receiveTask instantiate="true" and any non-none instantiation path is listed as rejected before publish (spec Edge Cases)
- [x] #6 Parser decision reconciled to bpmn-moddle for namespace-aware parsing, with fast-xml-parser recorded as a rejected alternative (research decision, plan Primary Dependencies)
- [x] #7 The extension-vocabulary decision (mint easy-bpmn namespace vs reuse camunda/zeebe verbatim) is recorded in research.md as a Decision with rationale and rejected alternatives
- [x] #8 docs/bpmn reference files are left unchanged
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the full canonical reference (docs/bpmn 00-09, glossary, resources, README) plus the sources of truth (start.md, .specify/memory/constitution.md) and the whole spec (spec, plan, research, data-model, both contracts, quickstart, checklist).
2. Identify where the spec diverges from canonical BPMN or risks inventing a notation, concentrated in: definition of "no custom notation", Service Task worker binding, correlation-key source, validator extension-tolerance, and the XML parser choice.
3. Apply alignment edits across all seven specs/001 artifacts; leave docs/bpmn untouched as the canonical reference.
4. Record the two open binding decisions (extension vocabulary; correlation-key source) as Phase 0 research Decisions with rationale and rejected alternatives so they are reviewable and reversible.
5. Cross-check consistency (grep) so the same canonical terms appear coherently across spec, data-model, contracts, and quickstart.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Central reversible decision recorded in research.md: carry worker binding + retry metadata in standard <bpmn:extensionElements> under a dedicated easy-bpmn namespace, rather than reusing camunda:/zeebe: verbatim. Rationale: reusing the Zeebe/Camunda vocabulary would make files look compatible while not honoring their execution semantics (FEEL, ioMapping), implying a compatibility the constitution explicitly excludes. Minting a clearly-distinct, additive, ignorable namespace under the standard extension mechanism is the constitution-safe default. If the team later prefers reuse of the Operaton/Camunda external-task vocabulary, flip that single Decision and the dependent binding fields (data-model BPMN Element/Service Task Job, runtime-contracts worker request, openapi BpmnElement).

Key reframing: 'no custom notation' is NOT violated by the standard extensionElements escape hatch under a foreign namespace - that is BPMN-sanctioned and every engine uses it. The operative test added to the spec is XSD validity + round-trip through a standard modeler when extensions/DI are ignored. Custom notation = new MODEL-namespace tags/attrs, redefining standard-element meaning, or requiring a non-standard attribute to parse.

Parser: switched the research/plan decision from fast-xml-parser to bpmn-moddle. The original rationale conflated parsing with executing - bpmn-moddle is a pure namespace-aware parser/serializer that imports no engine semantics, so it does not pull unsupported BPMN behavior into the lite profile, while solving the #1 canonical parser gotcha (match {MODEL-ns}localName, not prefix).

Worker routing changed from elementId (in the original runtime-contracts worker request) to a stable author-defined taskType, matching how canonical engines decouple the worker handle from tool-regenerated ids.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Aligned the BPMN-lite Orchestrator MVP spec (specs/001) with the canonical BPMN reference so the product holds to "standard BPMN 2.0, no custom notation". docs/bpmn left unchanged (canonical reference).

What changed, by finding:
- F1 Defined "no custom notation" precisely + an operative test (XSD-valid, round-trips in a standard modeler when easy-bpmn extensions/DI are ignored). [spec.md Constitution Alignment]
- F2 Service Task worker now routed by a stable author-defined taskType in <extensionElements> under the easy-bpmn namespace, never by element id/name. [spec FR-011/FR-011a; data-model BPMN Element + Service Task Job; runtime-contracts worker request; openapi BpmnElement.taskType]
- F3 Correlation key stated honestly as API-supplied at instance start, not model-derived; model-level (subscription/FEEL) correlation explicitly deferred. [spec FR-013; data-model; runtime-contracts; openapi; research Decision]
- F4 Split validation into reject (unsupported standard-namespace flow nodes/constructs) vs tolerate-and-ignore (foreign-namespace extensions, DI, documentation), matching BPMN's required extension tolerance. [spec FR-002/FR-003/FR-003a; data-model; quickstart Scenario 2]
- F5 Parser reconciled to bpmn-moddle (namespace-aware); fast-xml-parser recorded as rejected alternative. [research Decision; plan Primary Dependencies + Constitution Check]
- F6 receiveTask instantiate="true" / any non-none instantiation now explicitly rejected before publish. [spec Edge Cases]
- Central decision (mint easy-bpmn namespace vs reuse camunda/zeebe) recorded in research.md with rationale + rejected alternatives; reversible.

Files: spec.md, plan.md, research.md, data-model.md, contracts/runtime-contracts.md, contracts/openapi.yaml, quickstart.md (all under specs/001-bpmn-lite-orchestrator-mvp).

Tests: none (spec/documentation-only change; no project DoD defaults configured). Consistency verified by grep across the seven artifacts.

Follow-up / risks: the implementing feature must (a) honor the bpmn-moddle choice and namespace-aware {MODEL-ns}localName matching, (b) define the easy-bpmn moddle extension descriptor for taskType/retries, and (c) re-confirm the extension-vocabulary decision before code lands. The constitution itself (Principle I) and docs/bpmn (09 open questions, 06 whitelist wording) still describe these as open / "reject anything else" — a future amendment may want to fold the same precision back into governance, but that is out of scope here and was intentionally not changed.
<!-- SECTION:FINAL_SUMMARY:END -->
