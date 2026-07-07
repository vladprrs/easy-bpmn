// E2E combination-matrix Phase-1: publish-validation reject scenarios (R-*).
//
// Two waves in one file: the 11 M0-M4 rejects (parametrized over
// tests/matrix/registry.ts rows; four fixtures REUSED — PARALLEL_MISMATCH_BPMN /
// PARALLEL_SAME_MESSAGE_BPMN / INSTANTIATE_RECEIVE_BPMN from helpers,
// PARALLEL_LOOP_CROSS_BPMN from the matrix fixtures; the other seven authored in
// tests/fixtures/matrix/fixtures.ts) plus the five M5-L1 embedded-scopes
// interim/structural rejects added by M5-L1 Task 13.
//
// Each test asserts a real publish reject (HTTP >=400) via the actual
// createDraft/publishDraft HTTP harness, with the offending element id AND a
// reason substring matching the real validator message (src/bpmn/validator.ts —
// the validator's wording is the source of truth) present in the response body.
//
// The `[<id>]` markers below are what scripts/check-matrix.mjs scans (statically,
// off disk) to prove every phase-1 direct reject scenario is covered. The M0-M4
// it() titles build them at runtime via a template literal, so the scanner needs
// the literal bracketed ids spelled out here too:
//   [R-BOUNDARY-ON-GW-01] [R-MERGE-UNCONTROLLED-01] [R-JOIN-MISMATCH-01]
//   [R-JOIN-NOFORK-01] [R-MERGE-NONLAMINAR-01] [R-LOOP-CROSS-01] [R-SAMEMSG-01]
//   [R-INSTANTIATE-01] [R-NONINT-TIMER-01] [R-COND-OFF-XOR-01] [R-BRANCH-ESCAPE-01]
//   [R-EVENT-SUBPROC-01] [R-MI-SUBPROC-01] [R-SCOPE-DEPTH-01]
//   [R-COMP-NO-TX-ANCESTOR-01] [R-CANCEL-END-SUBPROC-01]

import { describe, it, expect } from "vitest";
import {
  createDraft,
  publishDraft,
  PARALLEL_MISMATCH_BPMN,
  PARALLEL_SAME_MESSAGE_BPMN,
  INSTANTIATE_RECEIVE_BPMN,
  SUBPROC_LINEAR_BPMN,
} from "../helpers";
import {
  R_BOUNDARY_ON_GW_BPMN,
  R_MERGE_UNCONTROLLED_BPMN,
  R_JOIN_NOFORK_BPMN,
  R_MERGE_NONLAMINAR_BPMN,
  R_NONINT_TIMER_BPMN,
  R_COND_OFF_XOR_BPMN,
  R_BRANCH_ESCAPE_BPMN,
  PARALLEL_LOOP_CROSS_BPMN,
} from "../fixtures/matrix/fixtures";

// [scenarioId, fixture, reason-substring regex] — the regex is tuned to the REAL
// validator message that the offending rule emits (see each fixture's header).
const REJECTS: Array<[string, string, RegExp]> = [
  ["R-BOUNDARY-ON-GW-01", R_BOUNDARY_ON_GW_BPMN, /boundary|gateway/i],
  ["R-MERGE-UNCONTROLLED-01", R_MERGE_UNCONTROLLED_BPMN, /merge|incoming/i],
  ["R-JOIN-MISMATCH-01", PARALLEL_MISMATCH_BPMN, /join|type|match/i],
  ["R-JOIN-NOFORK-01", R_JOIN_NOFORK_BPMN, /join|split|match/i],
  ["R-MERGE-NONLAMINAR-01", R_MERGE_NONLAMINAR_BPMN, /laminar|overlap|region|nest/i],
  ["R-LOOP-CROSS-01", PARALLEL_LOOP_CROSS_BPMN, /region|escape|loop|entry|incoming/i],
  ["R-SAMEMSG-01", PARALLEL_SAME_MESSAGE_BPMN, /message/i],
  ["R-INSTANTIATE-01", INSTANTIATE_RECEIVE_BPMN, /instantiate/i],
  ["R-NONINT-TIMER-01", R_NONINT_TIMER_BPMN, /interrupt|cancelActivity|non-interrupting/i],
  ["R-COND-OFF-XOR-01", R_COND_OFF_XOR_BPMN, /condition|gateway|exclusive/i],
  ["R-BRANCH-ESCAPE-01", R_BRANCH_ESCAPE_BPMN, /escape|region|branch|confine/i],
];

describe("matrix: publish-validation rejects (direct mode)", () => {
  for (const [id, bpmn, reason] of REJECTS) {
    it(`[${id}] rejects at publish with the offending element id`, async () => {
      const draft = await createDraft(bpmn);
      expect(draft.status).toBe(201);
      const pub = await publishDraft(draft.body.draftId);
      expect(pub.status, `${id} should reject`).toBeGreaterThanOrEqual(400);
      const text = JSON.stringify(pub.body);
      expect(text, `${id} reason`).toMatch(reason);
      // The rejection must name a real model element (the offending element id),
      // not just emit a generic reason. Assert at least one element id declared in
      // the fixture is echoed back in the response.
      const fixtureIds = [...bpmn.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] ?? "");
      const namesAnElement = fixtureIds.some((fid) => fid !== "" && text.includes(fid));
      expect(namesAnElement, `${id}: response should name an offending element id`).toBe(true);
    });
  }
});

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

  // FLIPPED by M5-L3 (Task 13): an MI subProcess itself now PUBLISHES (the
  // runtime opened), so this scenario pivots to the layer's own structural
  // reject — the v1 body whitelist: no message waits inside an MI body.
  it("[R-MI-SUBPROC-01] a multi-instance subProcess whose body contains a receiveTask rejects (v1 body whitelist)", async () => {
    const bpmn = SUBPROC_LINEAR_BPMN.replace(
      '<bpmn:process id="proc_subproc" isExecutable="true">',
      '<bpmn:message id="m_sub" name="SubBodyMsg"/>\n  <bpmn:process id="proc_subproc" isExecutable="true">',
    )
      .replace(
        '<bpmn:subProcess id="sub" name="Stage">',
        '<bpmn:subProcess id="sub" name="Stage"><bpmn:multiInstanceLoopCharacteristics isSequential="false"><bpmn:loopCardinality>2</bpmn:loopCardinality></bpmn:multiInstanceLoopCharacteristics>',
      )
      .replace(
        '<bpmn:serviceTask id="s_task" name="Work"><bpmn:extensionElements><easy-bpmn:taskDefinition type="doWork" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>',
        '<bpmn:receiveTask id="s_task" name="Wait" messageRef="m_sub"/>',
      );
    const issues = await publishReject(bpmn);
    // The whitelist anchors the issue on the MI scope itself and names the
    // offending interior element in the reason text.
    expect(issues.some((i) => i.elementId === "sub" && /s_task/.test(i.reason) && /multi-instance body/i.test(i.reason))).toBe(true);
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
