// TEMPORARY fixture sanity gate (Phase-1 Task 3.1): proves every VALID matrix
// fixture publishes (validates) + starts (201), and the one REJECT fixture is
// rejected at publish. Carries NO `[<id>]` markers, so the check:matrix
// drift-guard ignores it. Kept as a cheap fixture-regression test.

import { describe, expect, it } from "vitest";
import { createDraft, publishDraft, startInstance } from "../../helpers";
import {
  OR_NEST_AND_BPMN,
  PARALLEL_3ASYM_BPMN,
  PARALLEL_BRANCH_ERR_COMP_BPMN,
  PARALLEL_BRANCH_ITIMER_BPMN,
  PARALLEL_BRANCH_NOPATH_BPMN,
  PARALLEL_BRANCH_TIMER_BPMN,
  PARALLEL_LOOP_BRANCH_BPMN,
  PARALLEL_LOOP_CROSS_BPMN,
  PARALLEL_LOOP_INBRANCH_BPMN,
  PARALLEL_NESTEDTX_BRANCH_BPMN,
  PARALLEL_SAGA_MULTISTEP_BPMN,
} from "./fixtures";

const VALID: Array<[string, string]> = [
  ["PARALLEL_3ASYM_BPMN", PARALLEL_3ASYM_BPMN],
  ["PARALLEL_BRANCH_TIMER_BPMN", PARALLEL_BRANCH_TIMER_BPMN],
  ["OR_NEST_AND_BPMN", OR_NEST_AND_BPMN],
  ["PARALLEL_BRANCH_ITIMER_BPMN", PARALLEL_BRANCH_ITIMER_BPMN],
  ["PARALLEL_SAGA_MULTISTEP_BPMN", PARALLEL_SAGA_MULTISTEP_BPMN],
  ["PARALLEL_NESTEDTX_BRANCH_BPMN", PARALLEL_NESTEDTX_BRANCH_BPMN],
  ["PARALLEL_LOOP_BRANCH_BPMN", PARALLEL_LOOP_BRANCH_BPMN],
  ["PARALLEL_BRANCH_NOPATH_BPMN", PARALLEL_BRANCH_NOPATH_BPMN],
  ["PARALLEL_LOOP_INBRANCH_BPMN", PARALLEL_LOOP_INBRANCH_BPMN],
  ["PARALLEL_BRANCH_ERR_COMP_BPMN", PARALLEL_BRANCH_ERR_COMP_BPMN],
];

describe("matrix fixtures — publish + start smoke gate", () => {
  for (const [name, xml] of VALID) {
    it(`${name} publishes and starts (201)`, async () => {
      const draft = await createDraft(xml);
      expect(draft.status, `${name}: createDraft`).toBe(201);

      const version = await publishDraft(draft.body.draftId);
      // Surface the validator's element-level rejection reason on failure.
      expect(
        version.status,
        `${name}: publish rejected — ${JSON.stringify(version.body?.issues ?? version.body, null, 2)}`,
      ).toBe(201);

      const instance = await startInstance(version.body.definitionVersionId, {
        correlationKey: "smoke",
        variables: {},
      });
      expect(instance.status, `${name}: startInstance — ${JSON.stringify(instance.body)}`).toBe(201);
      expect(instance.body.instanceId).toBeTruthy();
    });
  }

  it("PARALLEL_LOOP_CROSS_BPMN is rejected at publish (region-crossing loop)", async () => {
    const draft = await createDraft(PARALLEL_LOOP_CROSS_BPMN);
    expect(draft.status).toBe(201);
    const publish = await publishDraft(draft.body.draftId);
    expect(publish.status).toBeGreaterThanOrEqual(400);
  });
});
