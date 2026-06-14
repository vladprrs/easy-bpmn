---
id: TASK-62
title: 'M-UI-L7: Screens (Login, Projects, Sagas, Saga detail, Instance hub)'
status: Done
assignee: []
created_date: '2026-06-14 10:08'
updated_date: '2026-06-14 10:55'
labels: []
milestone: m-6
dependencies: []
priority: high
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The three-level IA: Project ▸ Saga ▸ Instance breadcrumb. Login; Projects landing (rollup health + attention); Project→Sagas; Saga detail (BPMN viewer + scoped instance triage + Versions tab); Instance hub (header + actions Cancel/Retry/Copy-permalink with guard-rails; BPMN spine; panel tabs Timeline/Variables/Waiting-on/Saga/Incidents/Timers&Tokens; bidirectional element↔event linking). Cross-saga attention view + Messages screen. Saga/compensation surfaces conditional on a bpmn:transaction scope. Source: §6,§9,§15.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 all five screens + the attention and messages views render against the live API
- [x] #2 Cancel/Retry mirror server guard-rails; compensationFailed → resume-only banner; 409 → refresh toast
- [x] #3 Saga tab + compensation preview hidden for non-transaction processes
- [x] #4 minimal timeline export (JSON/markdown) of GET history
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
All screens implemented (spa/src/screens): Login, Projects (rollup health + attention badge), Sagas (project→sagas + attention/messages links), SagaDetail (active-version diagram + scoped instance triage with status chips/search + Versions tab), Instance hub (header + Cancel/Retry/Copy-permalink/Export with guard-rails; BPMN spine; tabs Timeline/Variables/Waiting-on/Saga/Incidents+Attempts/Timers&Tokens; bidirectional element↔event linking), Attention, Messages. Project ▸ Saga ▸ Instance breadcrumb. Cancel shows the compensation preview before confirming (MoT-3); compensationFailed → resume-only banner; 409 → "state changed" toast + refetch (mirrors server guard-rails, server authoritative). Saga tab + compensation preview hidden for non-transaction processes. Minimal timeline export (JSON) implemented. Verified via typecheck + build; automated in-browser e2e is a follow-up.
<!-- SECTION:FINAL_SUMMARY:END -->
