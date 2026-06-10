---
id: TASK-29
title: >-
  Conditional-saga persistence: D1 migration 0004 (occurrence discriminator,
  gateway_decisions, conditional topology columns) + contracts
status: In Progress
assignee:
  - Claude
created_date: '2026-06-09 20:28'
updated_date: '2026-06-10 16:42'
labels:
  - saga
  - persistence
  - migration
  - contracts
  - tests
milestone: M2
dependencies: []
references:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
  - docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md
  - migrations/0002_saga.sql
  - migrations/0003_topology.sql
  - src/persistence
  - contracts/openapi.yaml
documentation:
  - docs/superpowers/specs/2026-06-09-m2-conditional-sagas-design.md
priority: high
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
M2 adds data-driven branching AND cycles (M2 design 2026-06-09 §2 decisions 2/6, §9). Loops mean the same element executes N times per instance — the M1 uniqueness shapes forbid this (saga design 2026-06-08 §5 flagged the job index as "not stable past M1"). This task lands the additive migration `migrations/0004_conditional.sql` plus statement builders and widened contracts so the engine tasks build on a stable schema: `occurrence` columns + recreated unique indexes on `service_task_jobs` → (instance_id, element_id, is_compensation, occurrence) with a new `output_applied` flag (the write-free fast-forward marker, design §5); `saga_steps` → (instance_id, element_id, occurrence); `message_subscriptions` + occurrence; new `gateway_decisions` table (design §6: decision_id PK, instance_id, element_id, occurrence, chosen_flow_id, is_default, evaluations JSON in document order, variables_snapshot size-capped, created_at; UNIQUE (instance_id, element_id, occurrence)); `bpmn_elements` + condition_expression/is_default; `incidents.kind` += loopLimit|noPath. zod contracts + contracts/openapi.yaml updated. The worker-facing /jobs/* request/response schemas are UNCHANGED.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Additive migrations/0004_conditional.sql applies cleanly on top of 0001-0003 (npx wrangler d1 migrations apply, local): service_task_jobs gains occurrence + output_applied and its unique index becomes (instance_id, element_id, is_compensation, occurrence); saga_steps gains occurrence and uq_saga_steps_forward becomes (instance_id, element_id, occurrence); message_subscriptions gains occurrence; bpmn_elements gains condition_expression and is_default.
- [x] #2 New gateway_decisions table matches M2 design §6 (UNIQUE (instance_id, element_id, occurrence); evaluations JSON in document order; variables_snapshot) with insert/select statement builders in src/persistence/.
- [x] #3 incidents.kind accepts loopLimit and noPath; zod contracts and contracts/openapi.yaml updated; a contract test asserts the worker-facing /jobs/* schemas are unchanged (no breaking change for existing workers).
- [x] #4 INSERT OR IGNORE dedup for saga_steps holds per (instance_id, element_id, occurrence): a test proves duplicate completion of the same occurrence is a ledger no-op while a second occurrence inserts a new row.
- [x] #5 Constitution gate: contract/integration tests cover the new statement builders (job lookup by element+occurrence, gateway_decisions insert/select, occurrence-keyed subscriptions); npm run test green; npx wrangler deploy --dry-run passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: subagent-driven (implementer + spec review + quality review) on branch m2-conditional-sagas (off m1-closeout HEAD 1a43529; baseline 120 tests green).

1. Write additive migrations/0004_conditional.sql:
   - service_task_jobs: + occurrence INTEGER NOT NULL DEFAULT 0, + output_applied INTEGER NOT NULL DEFAULT 0; drop/recreate unique index -> (instance_id, element_id, is_compensation, occurrence).
   - saga_steps: + occurrence INTEGER NOT NULL DEFAULT 0; recreate uq_saga_steps_forward -> (instance_id, element_id, occurrence).
   - message_subscriptions: + occurrence INTEGER NOT NULL DEFAULT 0.
   - bpmn_elements: + condition_expression TEXT, + is_default INTEGER NOT NULL DEFAULT 0.
   - new gateway_decisions table per design §6 (decision_id PK, instance_id, element_id, occurrence, chosen_flow_id, is_default, evaluations JSON, variables_snapshot, created_at; UNIQUE (instance_id, element_id, occurrence)).
2. Statement builders in src/persistence/: gateway_decisions insert/select; job lookup by (instance, element, is_compensation, occurrence); occurrence-keyed subscription statements; saga_steps occurrence-aware INSERT OR IGNORE. Wire occurrence/output_applied through row mappers with defaults so existing M1 call sites compile and behave identically (occurrence=0).
3. Contracts: incidents.kind zod enum += loopLimit | noPath; contracts/openapi.yaml updated; contract test pins worker-facing /jobs/* request/response schemas unchanged.
4. Tests: migration applies on 0001-0003 (vitest-pool-workers migrations); per-occurrence saga_steps dedup (dup completion no-op, second occurrence new row); statement-builder coverage (AC #5). npm run test green; npx wrangler deploy --dry-run passes.

Engine behavior changes are explicitly OUT of scope (TASK-32/34/35/36).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Migration migrations/0004_conditional.sql (additive, SQLite/D1 dialect): occurrence INTEGER NOT NULL DEFAULT 0 + output_applied on service_task_jobs with uq_jobs_instance_element_kind recreated as (instance_id, element_id, is_compensation, occurrence) — index NAMES kept from 0002 so the 0002 migration test stays green; occurrence on saga_steps with uq_saga_steps_forward → (instance_id, element_id, occurrence); occurrence on message_subscriptions; condition_expression + is_default on bpmn_elements; gateway_decisions table + uq_gateway_decisions exactly per design §6. Verified via `npx wrangler d1 migrations apply easy_bpmn --local` (0004 applied on an existing 0001-0003 DB) AND the vitest-pool-workers path.

Builders: src/persistence/gateway-decisions.ts (new — insertGatewayDecisionStmt INSERT OR IGNORE, getGatewayDecision, mapper with evaluations JSON in document order); instances.ts getForwardJob(db, instanceId, elementId, occurrence), markJobOutputAppliedStmt, createJobStmt + createSubscription gain optional occurrence (default 0), JobRow/SubscriptionRow widened, IncidentKind += loopLimit|noPath; saga.ts insertSagaStepStmt + row/view/mapper gain occurrence; jobs.ts JobWithWorkspace surfaces occurrence/output_applied; definitions.ts persists + reads condition_expression/is_default (GraphElement/BpmnElement gain optional conditionExpression/isDefault — validator populates them in TASK-30/31, null/false today).

Contracts: api.ts Incident.kind + openapi.yaml incidents enum += loopLimit, noPath; openapi BpmnElement += conditionExpression/isDefault. Worker-facing /jobs/* schemas UNCHANGED — pinned by tests/contract/jobs-schema-pin.test.ts (exact shape-key sets + no occurrence leak + M1 payload round-trip).

Tests: tests/integration/migration-0004-conditional.test.ts (12 tests: schema/index shapes via PRAGMA, per-occurrence job uniqueness + compensation-inherits-occurrence, saga_steps INSERT OR IGNORE dedup per occurrence with second-occurrence new row, gateway_decisions insert/select/dup-ignore, occurrence-keyed + legacy-default subscriptions, loopLimit/noPath incident round-trip) + 4 contract-pin tests. Full suite 136/136 green (120 baseline + 16 new); typecheck, check:docs, wrangler deploy --dry-run all pass. Engine/Workflow untouched (TASK-32/34 consume the builders). NOTE: one pre-existing timing flake observed once in saga-operator.test.ts (Hazard /cancel — instance still 'waiting' when polled); passed in isolation and on two full re-runs; unrelated to this change.
<!-- SECTION:NOTES:END -->
