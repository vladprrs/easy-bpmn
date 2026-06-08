---
id: TASK-10
title: >-
  Update the easy-bpmn BPMN profile reference to the canonical saga profile (M0
  governance)
status: To Do
assignee: []
created_date: '2026-06-08 08:17'
labels:
  - governance
  - bpmn
  - docs
  - saga
  - profile
milestone: m-0
dependencies:
  - TASK-7
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md SS3 (canonical
    saga contract + "M1 profile subset"
  - lines 46-134
  - esp. 119-132)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md SS7
    (Governance / M0
  - lines 311-321)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md SS8 (phase
    roadmap
  - M0 exit row line 331; M2-M5 rows 333-336)
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md SS4.5 (failure
    taxonomy / errorRef matching
  - lines 200-205)
  - >-
    docs/bpmn/09-easy-bpmn-profile.md:154 (stale 'one Durable Object per
    instance')
  - 'docs/bpmn/09-easy-bpmn-profile.md:47-89 (supported element set)'
  - ':91-104 (rejected table)'
  - ':113-141 (validation rules)'
  - ':106-111 (tolerate-and-ignore)'
  - >-
    docs/bpmn/08-engines-and-extensions.md:113 (duplicate stale DO-per-instance
    phrase)
  - .specify/memory/constitution.md (Principle I
  - MVP scope
  - new SAGA/Compensation Integrity principle
  - v2.0.0 -- amended in sibling M0 task)
  - docs/bpmn/03-gateways.md
  - docs/bpmn/01-events.md
  - docs/bpmn/07-execution-semantics.md
  - docs/bpmn/02-activities.md (per-phase target semantics)
  - CLAUDE.md (Known doc drift section)
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/08-engines-and-extensions.md
  - docs/bpmn/03-gateways.md
  - docs/bpmn/01-events.md
  - docs/bpmn/07-execution-semantics.md
  - docs/bpmn/02-activities.md
  - .specify/memory/constitution.md
modified_files:
  - docs/bpmn/09-easy-bpmn-profile.md
  - docs/bpmn/08-engines-and-extensions.md
  - CLAUDE.md
  - tests/docs/profile-consistency.test.ts
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: docs/bpmn/09-easy-bpmn-profile.md stops describing only the linear MVP (Start->ServiceTask->ReceiveTask->End) and documents the canonical-saga M1 profile + the M2-M5 roadmap, fixes a stale architecture line, and stays in lockstep with the constitution being amended to v2.0.0 in a sibling M0 task.

WHY: easy-bpmn is becoming an orchestration-based SAGA orchestrator (design SS1); M0 is governance/docs only, no runtime behavior (SS8 M0 row). This doc is the operational reading of Principle I -- if it drifts from the amended constitution and the M1 validator, the "no custom notation" contract and the accept/reject lists contradict each other.

M1 accept-set to add to the existing 4 node types (design SS3 "M1 profile subset", lines 119-128): bpmn:transaction (saga scope: startEvent + children + a none end=commit + a cancelEventDefinition end); compensation boundaryEvent (neither interrupting nor non-interrupting; zero outgoing sequenceFlow; exactly one outgoing association to an in-scope isForCompensation activity); error boundaryEvent on a serviceTask -> cancel end (errorRef resolves to a declared bpmn:error); cancel boundaryEvent on the transaction; serviceTask isForCompensation=true; cancel end (only inside a transaction); association; bpmn:error. Still rejected with element id + reason (SS3:130): gateways/>1 outgoing flow, conditionExpression/default, timer/signal/escalation/conditional events, callActivity/non-transaction subProcess/adHoc/multiInstance, instantiate=true, pools/lanes. Tolerate-and-ignore (foreign-ns extensions, DI, documentation) stays.

Fix the stale 09:154 "one Durable Object per instance" -- the real architecture is Workflow-per-instance + a single DO correlation broker (workspaceId+messageName+correlationKey); the same stale phrase exists at 08-engines-and-extensions.md:113 and in CLAUDE.md's drift note. Add per-phase target-semantics citations (SS7:321): M2->03-gateways.md, M3->01-events.md, M4->07-execution-semantics.md, M5->02-activities.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The "Supported element set" table in docs/bpmn/09-easy-bpmn-profile.md (currently lines 47-89) lists exactly the M1 accept-set: the existing 4 node types PLUS bpmn:transaction, compensation/error/cancel boundaryEvent, serviceTask isForCompensation=true, cancelEventDefinition end event, bpmn:association, and bpmn:error -- each with its constraints from design doc SS3 (lines 119-128).
- [ ] #2 Compensation boundaryEvent constraints are documented precisely: it is neither interrupting nor non-interrupting (the cancelActivity axis does not apply), MUST have zero outgoing sequenceFlow, and MUST have exactly one outgoing <association> to an isForCompensation activity in the same transaction scope (design SS3:123).
- [ ] #3 Error boundaryEvent constraints are documented: interrupting, attached to a serviceTask, routes to a cancelEventDefinition end event, and its errorRef MUST resolve to a declared <bpmn:error> (design SS3:124, SS4.5:205).
- [ ] #4 The cancelEventDefinition end event is documented as allowed ONLY inside a <transaction>, and the cancel boundaryEvent ONLY on the transaction; the doc states M1 stays single-token (an interrupting error boundary redirects the one token, it is not a split) per design SS3:132.
- [ ] #5 The out-of-scope / rejected table (currently lines 91-104) is rewritten to REMOVE the now-accepted constructs (transaction, association, boundaryEvent, compensation, cancel) and to KEEP the M1 deferrals rejected with element id + reason: gateways and any >1 outgoing flow, conditionExpression/default, timer/signal/escalation/conditional events, callActivity/non-transaction subProcess/adHoc/multiInstance, instantiate=true, pools/lanes/collaboration/choreography (design SS3:130).
- [ ] #6 The tolerate-and-ignore clause for foreign-namespace <extensionElements> (camunda:/zeebe:/...), Diagram Interchange, and documentation is preserved (currently lines 106-111, 135-137).
- [ ] #7 The stale runtime-mapping line at 09:154 ("one Durable Object per instance") is replaced with the authoritative architecture: one Cloudflare Workflow per instance + a single Durable Object correlation broker keyed by workspaceId+messageName+correlationKey.
- [ ] #8 Negative/edge check: a repository grep for "Durable Object per instance" (and "DO per instance") across docs/ returns zero matches -- confirming the duplicate at docs/bpmn/08-engines-and-extensions.md:113 is also corrected.
- [ ] #9 The "Known doc drift" note in CLAUDE.md (which warns that 09 still says "one Durable Object per instance") is updated/removed because that stale line is now fixed.
- [ ] #10 Per-phase target-semantics citations are added to the profile's roadmap section: M2 -> docs/bpmn/03-gateways.md, M3 -> docs/bpmn/01-events.md, M4 -> docs/bpmn/07-execution-semantics.md, M5 -> docs/bpmn/02-activities.md (design SS7:321).
- [ ] #11 The operative "no custom notation / XSD-valid / round-trips through a standard modeler" test (currently lines 11-32, 24-28) is preserved and explicitly extended to cover the saga constructs, stating the only additive binding is still easy-bpmn:taskDefinition in standard <extensionElements> (design SS3 "Why this is canonical", line 117); the doc cross-references the amended constitution v2.0.0, its new "SAGA / Compensation Integrity" principle, and the new feature dir specs/002-saga-orchestrator (design SS7).
- [ ] #12 Constitution gate (docs-consistency test, the required automated check for this docs-only change): an automated guard (CI grep step or a tests/docs spec) fails if any "Durable Object per instance" phrasing remains under docs/ AND asserts the profile's accept-set section names every M1 construct from design SS3:119-128; the doc embeds/links the SS3 order-saga example as the single canonical example that the sibling M1 validator accept/round-trip test consumes, so the doc and the constitution-critical validator test cannot drift (the validator runtime behavior test -- SS3 example publishes, unsupported rejected with id+reason, DI/foreign-ns tolerated, semantic bpmn-js round-trip -- is owned by the sibling validator task and is referenced here as a dependency).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read design doc SS3 (M1 profile subset, lines 119-132), SS7 (Governance, 311-321), SS8 (M0 exit row, 331); confirm the amended constitution v2.0.0 wording from the sibling M0 task before writing (keep lockstep).
2. In docs/bpmn/09 "Supported element set" (47-89), add rows for transaction, boundaryEvent (compensate/error/cancel), serviceTask isForCompensation, cancel end event, association, bpmn:error with the exact constraints from SS3:119-128; keep the existing 4 rows.
3. Update the "supported happy path" header (34-45): keep the linear path and add a saga section reproducing the SS3 order-saga example (lines 52-112); mark it the canonical accept fixture shared with the validator test.
4. Rewrite the rejected table (91-104): drop transaction/association/boundaryEvent/compensation/cancel; keep gateways, conditional/default flow, timer/signal/escalation/conditional events, callActivity/non-transaction subProcess/adHoc/multiInstance, instantiate=true, pools/lanes/choreography (SS3:130).
5. Update validation rules (113-141): revise rule 3 (whitelist), rule 4 (none-events-only), rule 5 (plain flows) for the saga subset; add rules for compensation-boundary wiring (zero outgoing flow + exactly one in-scope association), error-boundary->cancel-end, cancel-end-only-in-transaction, errorRef resolution; preserve rule 10 (tolerate-and-ignore).
6. Fix the stale runtime-mapping line at 09:154: replace "one Durable Object per instance" with Workflow-per-instance + single DO correlation broker (workspaceId+messageName+correlationKey); add high-level rows for transaction-enter and reverse-order compensation, pointing to design SS4 for detail (doc stays profile-level).
7. Fix the identical stale phrase at docs/bpmn/08-engines-and-extensions.md:113.
8. Update the "Known doc drift" section in CLAUDE.md (the warning is now resolved).
9. Add/extend the roadmap/open-questions section (currently 196-202) with the per-phase citations M2->03-gateways, M3->01-events, M4->07-execution-semantics, M5->02-activities (SS7:321).
10. Extend the "no custom notation" operative test (11-32) to the saga constructs; cross-reference constitution v2.0.0 + new SAGA principle + specs/002-saga-orchestrator.
11. Add the automated guard (CI grep step or tests/docs/profile-consistency.test.ts) for criteria 8 and 12; run it.
12. Verify: grep docs/ for stale phrasing (zero hits), check all relative links resolve.
<!-- SECTION:PLAN:END -->
