---
id: TASK-8
title: >-
  Open Spec Kit feature specs/002-saga-orchestrator
  (spec/plan/research/data-model/contracts)
status: Done
assignee: []
created_date: '2026-06-08 08:17'
updated_date: '2026-06-08 12:25'
labels:
  - saga
  - governance
  - spec-kit
  - documentation
  - bpmn
  - api
milestone: m-0
dependencies:
  - TASK-7
references:
  - >-
    docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md (§2 locked
    decisions; §3 canonical saga contract + M1 profile subset; §4 architecture
    evolution; §4.6 status transition table; §4.7 idempotency; §5 data-model
    deltas; §6 API deltas; §7 governance/M0; §8 roadmap; §9 open questions; §10
    risks; §11 backlog mapping)
  - specs/001-bpmn-lite-orchestrator-mvp/spec.md
  - specs/001-bpmn-lite-orchestrator-mvp/plan.md
  - specs/001-bpmn-lite-orchestrator-mvp/research.md
  - specs/001-bpmn-lite-orchestrator-mvp/data-model.md
  - specs/001-bpmn-lite-orchestrator-mvp/quickstart.md
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/openapi.yaml
  - specs/001-bpmn-lite-orchestrator-mvp/contracts/runtime-contracts.md
  - specs/001-bpmn-lite-orchestrator-mvp/checklists/requirements.md
  - '.specify/memory/constitution.md (versioning policy :138-143; gate :110-129)'
  - .specify/templates/spec-template.md
  - .specify/templates/plan-template.md
  - '.specify/scripts/bash/create-new-feature.sh (:94-114 numbering'
  - ':370-378 template copy)'
  - 'src/bpmn/validator.ts:271-277 (reject >1 outgoing flow)'
  - 'src/bpmn/validator.ts:137-143 (reject conditionExpression)'
  - 'src/runtime/engine.ts:105-178 (scalar-cursor loop)'
  - 'src/runtime/engine.ts:213 (ServiceTaskOutcome)'
  - 'migrations/0001_mvp_schema.sql:122-123 (uq_jobs_instance_element)'
documentation:
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - >-
    docs/bpmn/09-easy-bpmn-profile.md (profile reference; updated by sibling M0
    task — fixes stale 'one Durable Object per instance')
  - docs/bpmn/03-gateways.md (M2 target semantics
  - cited in roadmap §8)
  - docs/bpmn/01-events.md (M3 target semantics)
  - docs/bpmn/07-execution-semantics.md (M4 token lifecycle)
  - docs/bpmn/02-activities.md (M5 composition)
modified_files:
  - specs/002-saga-orchestrator/spec.md
  - specs/002-saga-orchestrator/plan.md
  - specs/002-saga-orchestrator/research.md
  - specs/002-saga-orchestrator/data-model.md
  - specs/002-saga-orchestrator/quickstart.md
  - specs/002-saga-orchestrator/contracts/openapi.yaml
  - specs/002-saga-orchestrator/contracts/runtime-contracts.md
  - specs/002-saga-orchestrator/checklists/requirements.md
priority: high
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Scaffold the Spec Kit feature specs/002-saga-orchestrator so the SAGA scope expansion has an authoritative spec set, mirroring the structure/quality of specs/001-bpmn-lite-orchestrator-mvp (spec.md, plan.md, research.md, data-model.md, quickstart.md, contracts/openapi.yaml, contracts/runtime-contracts.md, checklists/requirements.md). Single source of truth: docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md. specs/001 is retained UNCHANGED as MVP history.

WHY: easy-bpmn (live at bpmn.rntme.com) today runs only Start->ServiceTask->ReceiveTask->End. The design evolves it into a canonical transaction-saga orchestrator for many microservices. Locked decisions (design §2) the spec must encode: (1) canonical BPMN — bpmn:transaction + compensateEventDefinition boundary + isForCompensation handler + association + cancelEventDefinition; the only additive binding is easy-bpmn:taskDefinition type; files stay XSD-valid and round-trippable. (2) pull/external-task workers (activate/complete/fail); orchestrator never knows service addresses. (3) compensation triggered ONLY by transaction Cancel (error boundary->cancel end), NEVER by an uncaught Error (Hazard->terminate). (4) compensator exhaustion -> terminal compensationFailed + operator remediation. (5) compensator receives original input + captured output and must be idempotent. (6) per-workspace worker credential; server derives workspaceId, never trusts a body value. (7) constitution -> 2.0.0 with a new SAGA/Compensation Integrity principle.

This task delivers ONLY the documents (no runtime code). It depends on and references the sibling M0 tasks (constitution v2.0.0 amend; docs/bpmn/09 update). Each plan must pass the Constitution Check before Phase 0 and after Phase 1, and the spec must itself MANDATE the M1 contract/integration tests so the downstream constitution gate is captured.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 specs/002-saga-orchestrator/ exists with the SAME file set as specs/001-bpmn-lite-orchestrator-mvp/: spec.md, plan.md, research.md, data-model.md, quickstart.md, contracts/openapi.yaml, contracts/runtime-contracts.md, checklists/requirements.md.
- [x] #2 specs/001-bpmn-lite-orchestrator-mvp/ is left unchanged (git diff under specs/001/ is empty).
- [x] #3 spec.md Constitution Alignment references the new SAGA/Compensation Integrity principle AND the widened Principle I (canonical-BPMN profile with the 'no custom notation / XSD-valid / round-trippable' clause preserved), and includes FRs for: pull workers (activate/complete/fail), per-workspace worker credential with server-derived workspaceId, transaction-scoped reverse-order compensation, compensationFailed + operator remediation, operator cancel/retry/list, and saga visibility + traceId. The §3 canonical order-saga BPMN example is embedded as the canonicity round-trip target.
- [x] #4 spec.md Edge Cases enumerate constructs still rejected in M1 (gateways / >1 outgoing flow, conditionExpression+default, timer/signal/escalation/conditional events, callActivity/non-transaction subProcess/multiInstance, instantiate="true", pools/lanes/collaboration) — each rejected before publish with element id + reason — AND the tolerated-and-ignored content (foreign-namespace extensionElements, Diagram Interchange, documentation).
- [x] #5 plan.md contains BOTH constitution gates against constitution v2.0.0: an Initial Constitution Check (before Phase 0) and a Post-Design Constitution Check (after Phase 1), each PASS or accompanied by a Complexity Tracking entry naming the deviation plus a rejected simpler alternative.
- [x] #6 CONSTITUTION GATE (required tests captured): spec.md/plan.md explicitly mandate the M1 contract/integration tests as named acceptance gates: (a) happy saga commits; (b) a business error mid-saga compensates completed steps in reverse order and reaches the failure end; (c) compensator exhaustion -> compensationFailed + operator retry resumes from the failed step; (d) duplicate complete AND duplicate fail each advance at most once; (e) a late callback to a terminal/not-running instance is a 200 no-op ack (not a 500, not permastuck); (f) a cross-tenant activate is rejected; (g) a v1 instance mid-saga compensates via v1's graph after v2 publishes (immutable version binding).
- [x] #7 contracts/openapi.yaml is valid OpenAPI 3.1 (parses/lints clean) and documents POST /jobs/activate, POST /jobs/{jobId}/complete, POST /jobs/{jobId}/fail (bearer worker-credential security; never trusts a body workspaceId), POST /instances/{id}/cancel, POST /instances/{id}/retry, GET /instances?workspaceId=&status=&limit=&cursor=, and the extended GET /instances/{id} saga block — all with request AND response schemas — while retaining the MVP paths.
- [x] #8 contracts/runtime-contracts.md specifies the job-result discriminated union ({outcome:'completed',output} | {outcome:'failed',retryable,errorCode?,reason}), the per-job workflow event-type rule (bpmn_job_<jobId>, dot-free, <=100 chars), lock_token-conditional complete/fail with the atomic IN-subquery lease (NOT UPDATE...LIMIT...RETURNING, which fails on D1 code 7500), and the compensation-job contract carrying originalInput + capturedOutput with isCompensation=true.
- [x] #9 data-model.md describes the saga_steps ledger, the service_task_jobs ALTERs + replacement unique index uq_jobs_instance_element_kind (dropping uq_jobs_instance_element from migrations/0001_mvp_schema.sql:122-123), worker_credentials, incidents kind/resolution, idx_instances_workspace_status, the widened process_instances.status enum WITH the explicit one-way transition table (design §4.6), the idempotency 'compensate' scope + forward workerCallback keying (§4.7), and the named roadmap stub tables (gateway_decisions/timers/execution_tokens).
- [x] #10 research.md records design decisions #1-#7 (§2) each as Decision/Rationale/Alternatives, the four deferred open questions (§9: FEEL vs JSONLogic, timeout behavior, CF concurrency strategy, worker SDK shape), and the verified platform constraints (D1 lease SQL form; CF Workflows <=1 MiB per event and <=1 GB cumulative per-instance state; workflow limits.steps headroom).
- [x] #11 checklists/requirements.md mirrors specs/001's quality checklist and all items pass; spec.md contains no [NEEDS CLARIFICATION] markers.
- [x] #12 No stale-doc drift is reintroduced: the new spec set states the architecture as one Cloudflare Workflow per instance + a single DO correlation broker (never 'one Durable Object per instance'), and it cross-references the sibling M0 tasks for constitution v2.0.0 and the docs/bpmn/09-easy-bpmn-profile.md update rather than duplicating their content.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Scaffold: run .specify/scripts/bash/create-new-feature.sh --short-name saga-orchestrator --number 2 (it numbers by scanning specs/* via get_highest_from_specs at create-new-feature.sh:94-114 and copies spec-template to spec.md at :370-378), OR create specs/002-saga-orchestrator/ + contracts/ + checklists/ by hand to match specs/001's exact file set.
2. spec.md: reuse the section skeleton of specs/001-bpmn-lite-orchestrator-mvp/spec.md (Constitution Alignment, User Scenarios, Functional Requirements FR-xxx, Key Entities, Success Criteria, Assumptions). Retarget to the M1 saga slice (design §8: "M1 alone satisfies the SAGA ask"). Add a Constitution Alignment subsection for SAGA/Compensation Integrity; embed the §3 canonical order-saga XML; list the §3 "M1 profile subset" accepted constructs and the still-rejected set as edge cases.
3. plan.md: mirror specs/001/plan.md (Summary, Technical Context, Constitution Check Initial Gate, Project Structure, Complexity Tracking, Phase 0/1 summaries, Post-Design Constitution Check). Both gates target constitution v2.0.0. Project Structure adds src/bpmn/graph.ts, a scope-aware src/runtime/engine.ts (replacing the scalar loop at engine.ts:105-178 and ServiceTaskOutcome at engine.ts:213), pull src/runtime/service-task.ts, migrations/0002_saga.sql, and new test dirs.
4. research.md: mirror specs/001/research.md format; one Decision/Rationale/Alternatives block per design §2 decisions #1-#7; add §9 open questions; record the verified D1 lease SQL (§4.3: UPDATE...LIMIT...RETURNING -> code 7500 -> IN-subquery) and §10 R5 limits.
5. data-model.md: encode §5 — saga_steps; service_task_jobs ALTERs; drop uq_jobs_instance_element (migrations/0001_mvp_schema.sql:122-123) -> uq_jobs_instance_element_kind; worker_credentials; incidents kind/resolution; idx_instances_workspace_status; widened status enum + §4.6 transition table; idempotency 'compensate' scope; roadmap stub tables.
6. contracts/openapi.yaml: extend specs/001 openapi (3.1.0) with §6 endpoints, a bearer worker-credential securityScheme, and the saga block on GET /instances/{id}; confirm it parses. contracts/runtime-contracts.md: job-result discriminator, bpmn_job_<jobId> event rule, lock_token-conditional complete/fail, compensation-job contract.
7. quickstart.md: the §8/§11 M1 scenarios (happy, business-error->compensate, compensator-fail->retry, duplicate callbacks, cross-tenant reject, version-binding-during-compensation).
8. checklists/requirements.md: mirror specs/001; tick once content complete.
9. Verify: git diff shows specs/001 untouched; OpenAPI parses; both constitution gates present; no "DO-per-instance" wording.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Scaffolded `specs/002-saga-orchestrator/` (8 files, same set as specs/001 minus the later-generated tasks.md): spec.md (Constitution Alignment vs widened Principle I + new Principle VI; 6 prioritized user stories; 31 FRs; embedded §3 order-saga XML; edge cases enumerate every M1-rejected construct + tolerated content; 7 named test gates), plan.md (both Initial and Post-Design Constitution Checks vs v2.0.0; real planned layout; the 7 M1 test gates mandated), research.md (7 Decision/Rationale/Alternatives blocks for design §2 #1–#7 + the 4 §9 open questions + verified platform constraints incl. D1 IN-subquery lease and CF Workflows limits), data-model.md (saga_steps ledger, service_task_jobs ALTERs + index swap, worker_credentials, incidents kind/resolution, idx_instances_workspace_status, widened status enum + the §4.6 one-way transition table, idempotency compensate scope, roadmap stub tables), contracts/openapi.yaml (OpenAPI 3.1.0; retains MVP paths; adds /jobs/activate, /jobs/{id}/complete|fail, /instances/{id}/cancel|retry, GET /instances list, saga block; bearer worker-credential security; server-derived workspaceId; bundles clean via redocly), contracts/runtime-contracts.md (job-result union, bpmn_job_<jobId> rule, lock_token-conditional + IN-subquery lease, compensation-job contract, terminal no-op ack, failure taxonomy), quickstart.md (7 M1 scenarios), checklists/requirements.md (all passing). Verified: specs/001 unchanged (git diff empty), no [NEEDS CLARIFICATION]/placeholder tokens, no stale "DO per instance" phrasing, both constitution gates present, 7 test gates named in spec+plan. Delegated to a background agent (general-purpose); orchestrator verified the file set + specs/001 integrity + no stale phrasing.
<!-- SECTION:FINAL_SUMMARY:END -->
