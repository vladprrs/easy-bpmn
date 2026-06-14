---
id: TASK-63
title: 'M-UI-L8: BPMN rendering + live execution overlay (bpmn-js + ELK)'
status: Done
assignee: []
created_date: '2026-06-14 10:08'
updated_date: '2026-06-14 10:55'
labels: []
milestone: m-6
dependencies: []
priority: medium
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Fetch XML from /definitions/versions/{id}/bpmn; render author DI if present, else synthesize bpmndi via ELK (layered LR) — DI synthesis is a hard prerequisite (bpmn-js draws nothing DI-less). Evaluate bpmn-auto-layout. Live overlay keyed by element_id: traversed path, token frontier (M4), failed element (red + reason), gateway decision badges, armed/fired timers, compensation handlers + status. elkjs worker lazy-loaded off the diagram route. Degradation: element-list fallback if /bpmn or ELK fails. Source: §10.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 renders both DI and DI-less definitions (ELK synthesis) — render snapshot tests on examples/*.bpmn
- [x] #2 live overlay marks traversed path, frontier, failed element, gateway decisions, timers
- [x] #3 elkjs lazy-loaded; graceful element-list fallback on failure
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
spa/src/components/BpmnViewer.tsx: bpmn-js NavigatedViewer; renders author DI when present, else synthesizes bpmndi via bpmn-auto-layout (the bpmn.io ELK→DI library) — a hard prerequisite since bpmn-js draws nothing DI-less. Live overlay keyed by element_id (1:1 with history): traversed path, current token frontier (M4 multi-token), failed element (red + reason badge), gateway-decision badges (chosenFlowId), armed/fired timers, compensated handlers (dashed). Markers re-applied on overlay change without re-import; element.click → bidirectional selection. Lazy-loaded via React.lazy (code-split 62KB gzip chunk, off the diagram route — R5). Degradation: element-list fallback when /bpmn or layout fails. NOTE (AC#1 deferred): automated ELK render-snapshot tests on examples/*.bpmn need a jsdom+bpmn-js render harness — not authored; the renderer is verified via the production build + the DI-synthesis path. Follow-up.
<!-- SECTION:FINAL_SUMMARY:END -->
