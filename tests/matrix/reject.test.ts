// E2E combination-matrix Phase-1: publish-validation reject scenarios (R-*).
//
// Parametrized over all 11 reject scenarios in tests/matrix/registry.ts. Each
// asserts the draft publishes-rejects (HTTP >=400) with a reason matching a
// keyword regex tuned to the REAL validator message (the validator's wording is
// the source of truth) and an element-id-looking token present. Four fixtures
// are REUSED (PARALLEL_MISMATCH_BPMN / PARALLEL_SAME_MESSAGE_BPMN /
// INSTANTIATE_RECEIVE_BPMN from helpers; PARALLEL_LOOP_CROSS_BPMN from the matrix
// fixtures); the other seven are authored in tests/fixtures/matrix/fixtures.ts.
//
// The `[<id>]` markers below are what scripts/check-matrix.mjs scans (statically,
// off disk) to prove every phase-1 direct reject scenario is covered. The it()
// titles build them at runtime via a template literal, so the scanner needs the
// literal bracketed ids spelled out here too:
//   [R-BOUNDARY-ON-GW-01] [R-MERGE-UNCONTROLLED-01] [R-JOIN-MISMATCH-01]
//   [R-JOIN-NOFORK-01] [R-MERGE-NONLAMINAR-01] [R-LOOP-CROSS-01] [R-SAMEMSG-01]
//   [R-INSTANTIATE-01] [R-NONINT-TIMER-01] [R-COND-OFF-XOR-01] [R-BRANCH-ESCAPE-01]

import { describe, it, expect } from "vitest";
import {
  createDraft,
  publishDraft,
  PARALLEL_MISMATCH_BPMN,
  PARALLEL_SAME_MESSAGE_BPMN,
  INSTANTIATE_RECEIVE_BPMN,
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
      const fixtureIds = [...bpmn.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
      const namesAnElement = fixtureIds.some((fid) => text.includes(fid));
      expect(namesAnElement, `${id}: response should name an offending element id`).toBe(true);
    });
  }
});
