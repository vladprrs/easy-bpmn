import { describe, expect, it } from "vitest";
import { DEMO_BPMN, createDraft, get, publishDraft, startInstance } from "../helpers";

describe("Scenario 6: immutable version binding", () => {
  it("keeps a running instance bound to its original version when a new version is published", async () => {
    const draft = await createDraft(DEMO_BPMN);
    const v1 = await publishDraft(draft.body.draftId);
    expect(v1.body.versionNumber).toBe(1);

    const started = await startInstance(v1.body.definitionVersionId, {
      correlationKey: "imm-1",
      variables: { amount: 1 },
    });
    const instanceId = started.body.instanceId;

    // Publishing the same draft again produces a new immutable version.
    const v2 = await publishDraft(draft.body.draftId);
    expect(v2.body.versionNumber).toBe(2);
    expect(v2.body.definitionVersionId).not.toBe(v1.body.definitionVersionId);

    // The running instance is still bound to v1.
    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.definitionVersionId).toBe(v1.body.definitionVersionId);

    // New instances can start from v2.
    const started2 = await startInstance(v2.body.definitionVersionId, {
      correlationKey: "imm-2",
      variables: { amount: 2 },
    });
    expect(started2.status).toBe(201);
    expect(started2.body.definitionVersionId).toBe(v2.body.definitionVersionId);
  });
});
