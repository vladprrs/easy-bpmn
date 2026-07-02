// E2E combination-matrix Phase-1: M5-L1 publish-validation reject scenarios (R-*).
//
// The five embedded-scopes interim/structural rejects added by Task 13. The
// 11 pre-existing M0-M4 R-* rows (R-BOUNDARY-ON-GW-01 etc.) also declare
// tests/matrix/reject.test.ts as their directFile but are NOT authored here —
// that is pre-existing, out-of-scope baseline red (see task-13-report.md).
//
// Each test asserts a real publish reject (HTTP >=400) via the actual
// createDraft/publishDraft HTTP harness, with the offending element id AND a
// reason substring matching the real validator message (src/bpmn/validator.ts)
// present in the response body's `validationIssues`.
//
// The `[<id>]` markers below are what scripts/check-matrix.mjs scans (statically,
// off disk) to prove every phase-1 direct reject scenario is covered:
//   [R-EVENT-SUBPROC-01] [R-MI-SUBPROC-01] [R-SCOPE-DEPTH-01]
//   [R-COMP-NO-TX-ANCESTOR-01] [R-CANCEL-END-SUBPROC-01]

import { describe, it, expect } from "vitest";
import { createDraft, publishDraft, SUBPROC_LINEAR_BPMN } from "../helpers";

interface Issue {
  elementId?: string | null;
  reason: string;
}

async function publishReject(bpmnXml: string): Promise<Issue[]> {
  const draft = await createDraft(bpmnXml);
  expect(draft.status).toBe(201);
  const pub = await publishDraft(draft.body.draftId);
  expect(pub.status).toBeGreaterThanOrEqual(400);
  const issues = (pub.body?.validationIssues ?? []) as Issue[];
  expect(Array.isArray(issues) && issues.length).toBeTruthy();
  return issues;
}

/** Depth-N nested subProcess chain (no easy-bpmn task types needed — structural only). */
function nestedScopes(depth: number): string {
  let inner = `<bpmn:startEvent id="d${depth}_start"/><bpmn:sequenceFlow id="d${depth}_f" sourceRef="d${depth}_start" targetRef="d${depth}_end"/><bpmn:endEvent id="d${depth}_end"/>`;
  for (let d = depth; d >= 1; d--) {
    inner = `<bpmn:startEvent id="d${d - 1}_start"/><bpmn:sequenceFlow id="d${d - 1}_f1" sourceRef="d${d - 1}_start" targetRef="sub${d}"/><bpmn:subProcess id="sub${d}">${inner}</bpmn:subProcess><bpmn:sequenceFlow id="d${d - 1}_f2" sourceRef="sub${d}" targetRef="d${d - 1}_end"/><bpmn:endEvent id="d${d - 1}_end"/>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="http://example.com"><bpmn:process id="proc" isExecutable="true">${inner}</bpmn:process></bpmn:definitions>`;
}

describe("matrix: M5-L1 publish-validation rejects (direct mode)", () => {
  it("[R-EVENT-SUBPROC-01] event subprocess (triggeredByEvent) rejects with an M5-L4 pointer", async () => {
    const bpmn = SUBPROC_LINEAR_BPMN.replace(
      '<bpmn:subProcess id="sub" name="Stage">',
      '<bpmn:subProcess id="sub" name="Stage" triggeredByEvent="true">',
    );
    const issues = await publishReject(bpmn);
    expect(issues.some((i) => i.elementId === "sub" && /M5-L4/.test(i.reason))).toBe(true);
  });

  it("[R-MI-SUBPROC-01] multiInstanceLoopCharacteristics on a subProcess rejects with an M5-L3 pointer", async () => {
    const bpmn = SUBPROC_LINEAR_BPMN.replace(
      '<bpmn:startEvent id="s_start"/>',
      '<bpmn:multiInstanceLoopCharacteristics/><bpmn:startEvent id="s_start"/>',
    );
    const issues = await publishReject(bpmn);
    expect(issues.some((i) => i.elementId === "sub" && /M5-L3/.test(i.reason))).toBe(true);
  });

  it("[R-SCOPE-DEPTH-01] scope nesting depth 9 exceeds MAX_SCOPE_DEPTH and rejects", async () => {
    const issues = await publishReject(nestedScopes(9));
    expect(issues.some((i) => /MAX_SCOPE_DEPTH|depth/.test(i.reason))).toBe(true);
  });

  it("[R-COMP-NO-TX-ANCESTOR-01] a compensation handler inside a subProcess with no transaction ancestor rejects (no trigger)", async () => {
    const bpmn = SUBPROC_LINEAR_BPMN.replace(
      '<bpmn:serviceTask id="s_task" name="Work"><bpmn:extensionElements><easy-bpmn:taskDefinition type="doWork" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>',
      `<bpmn:serviceTask id="s_task" name="Work"><bpmn:extensionElements><easy-bpmn:taskDefinition type="doWork" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:boundaryEvent id="s_task_comp" attachedToRef="s_task"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="undoWork" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="undoWork" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:association id="assocWork" sourceRef="s_task_comp" targetRef="undoWork"/>`,
    );
    const issues = await publishReject(bpmn);
    expect(
      issues.some(
        (i) => i.elementId === "undoWork" && /is isForCompensation but no enclosing scope is a <transaction>/.test(i.reason),
      ),
    ).toBe(true);
  });

  it("[R-CANCEL-END-SUBPROC-01] a cancel end whose immediate scope is a subProcess rejects", async () => {
    const bpmn = SUBPROC_LINEAR_BPMN.replace(
      '<bpmn:endEvent id="s_end"/>',
      '<bpmn:endEvent id="s_end"><bpmn:cancelEventDefinition/></bpmn:endEvent>',
    );
    const issues = await publishReject(bpmn);
    expect(
      issues.some((i) => i.elementId === "s_end" && /only inside a <transaction>/.test(i.reason)),
    ).toBe(true);
  });
});
