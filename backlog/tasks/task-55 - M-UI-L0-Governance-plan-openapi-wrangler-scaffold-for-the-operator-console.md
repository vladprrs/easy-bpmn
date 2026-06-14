---
id: TASK-55
title: >-
  M-UI-L0: Governance + plan + openapi/wrangler scaffold for the operator
  console
status: Done
assignee: []
created_date: '2026-06-14 10:08'
updated_date: '2026-06-14 10:54'
labels: []
milestone: m-6
dependencies: []
priority: high
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Unblock the M-UI milestone: amend the constitution (remove the "advanced Operate-style UI" exclusion, bump to v2.4.0 with a Sync Impact Report), write the implementation plan, and scaffold config. New env vars (UI_USER/UI_PASS/UI_SESSION_SECRET/UI_DEFAULT_WORKSPACE), the wrangler `assets` block + run_worker_first over the API prefixes, and the openapi.yaml/runtime-contracts.md amendments land here. Source: docs/superpowers/specs/2026-06-14-operator-console-ui-design.md §7,§8,§17.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 constitution.md amended to v2.4.0 with a Sync Impact Report; the Operate-style-UI exclusion removed
- [x] #2 docs/superpowers/plans/2026-06-14-operator-console-ui.md written
- [x] #3 wrangler.jsonc gains an assets binding + run_worker_first over API prefixes; Env gains UI_* vars
- [x] #4 openapi.yaml + runtime-contracts.md amended in lockstep; npm run check:docs green
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Constitution amended to **v2.4.0** (Sync Impact Report; "advanced Operate-style UI" removed from the MVP exclusion list; Principles I–VI unchanged — the console is the UI surface of Principle V). Plan written at docs/superpowers/plans/2026-06-14-operator-console-ui.md. wrangler.jsonc gained the `assets` block (binding ASSETS, directory ./spa/dist, single-page-application, run_worker_first over every API prefix) + UI_DEFAULT_WORKSPACE; Env gained UI_USER/UI_PASS/UI_SESSION_SECRET/UI_DEFAULT_WORKSPACE/UI_STREAM_BUDGET_MS. openapi.yaml (info 0.3.0) + runtime-contracts.md amended in lockstep (operatorSession cookie scheme, 11 new paths, additive params/schemas). `npm run check:docs` GREEN; `npx wrangler deploy --dry-run` validates (reads 11 files from spa/dist, env.ASSETS bound).
<!-- SECTION:FINAL_SUMMARY:END -->
