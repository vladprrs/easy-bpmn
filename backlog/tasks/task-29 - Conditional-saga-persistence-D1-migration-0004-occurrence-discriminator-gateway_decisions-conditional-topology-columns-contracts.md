---
id: TASK-29
title: >-
  Conditional-saga persistence: D1 migration 0004 (occurrence discriminator,
  gateway_decisions, conditional topology columns) + contracts
status: To Do
assignee: []
created_date: '2026-06-09 20:28'
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
- [ ] #1 Additive migrations/0004_conditional.sql applies cleanly on top of 0001-0003 (npx wrangler d1 migrations apply, local): service_task_jobs gains occurrence + output_applied and its unique index becomes (instance_id, element_id, is_compensation, occurrence); saga_steps gains occurrence and uq_saga_steps_forward becomes (instance_id, element_id, occurrence); message_subscriptions gains occurrence; bpmn_elements gains condition_expression and is_default.
- [ ] #2 New gateway_decisions table matches M2 design §6 (UNIQUE (instance_id, element_id, occurrence); evaluations JSON in document order; variables_snapshot) with insert/select statement builders in src/persistence/.
- [ ] #3 incidents.kind accepts loopLimit and noPath; zod contracts and contracts/openapi.yaml updated; a contract test asserts the worker-facing /jobs/* schemas are unchanged (no breaking change for existing workers).
- [ ] #4 INSERT OR IGNORE dedup for saga_steps holds per (instance_id, element_id, occurrence): a test proves duplicate completion of the same occurrence is a ledger no-op while a second occurrence inserts a new row.
- [ ] #5 Constitution gate: contract/integration tests cover the new statement builders (job lookup by element+occurrence, gateway_decisions insert/select, occurrence-keyed subscriptions); npm run test green; npx wrangler deploy --dry-run passes.
<!-- AC:END -->
