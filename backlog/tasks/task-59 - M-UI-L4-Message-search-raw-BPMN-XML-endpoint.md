---
id: TASK-59
title: 'M-UI-L4: Message search + raw BPMN XML endpoint'
status: Done
assignee: []
created_date: '2026-06-14 10:08'
updated_date: '2026-06-14 10:54'
labels: []
milestone: m-6
dependencies: []
priority: medium
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GET /messages?workspaceId=&messageName=&correlationKey=&outcome= (list/search over external_messages; the only home for un-correlated late/rejected messages with matched_instance_id=NULL). GET /definitions/versions/{id}/bpmn returns {bpmnXml, bpmnXmlHash} (XML already stored in D1; resolves G1 so the SPA can render the diagram). Source: §9,§10,§12.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /messages list/search by name/correlation/outcome incl. un-correlated messages
- [x] #2 GET /definitions/versions/{id}/bpmn returns the raw stored XML + hash
- [x] #3 contract + integration tests
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
GET /messages?workspaceId=&messageName=&correlationKey=&outcome=&cursor= (searchMessages over external_messages; surfaces un-correlated late/rejected messages with matched_instance_id NULL). GET /definitions/versions/{id}/bpmn → {definitionVersionId, bpmnXml, bpmnXmlHash} (getVersionXml; the XML already lives in D1 — resolves G1 so the SPA can render the diagram). Both gated by the session cookie. Integration tests assert un-correlated message search + raw XML retrieval + the 401 gate.
<!-- SECTION:FINAL_SUMMARY:END -->
