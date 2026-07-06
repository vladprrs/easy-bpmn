import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_BPMN, createDraft, publishAndStart, publishDraft } from "../helpers";
import { SIMPLE_CHILD_BPMN, SIMPLE_PARENT_BPMN } from "./call-activity-fixtures";
import { runInstance } from "../../src/runtime/engine";

// M5-L3 Task 4 — step-free park on rewalk (design §6, the highest-leverage
// mitigation). A rewalk over an UNCHANGED park (svc-park / call-park) must issue
// ZERO Workflow steps: the predicate is read OUTSIDE any step (the intermediate-
// timer pattern), so an already-parked service task / callActivity fast-forwards
// write-free instead of re-issuing its park step on every drive. This is a
// step-COUNT change only — the instance status/frontier is byte-identical.
//
// Direct-mode nuance (why this suite can count issuances): the re-drives below run
// OUTSIDE a real Workflow, so the counting runStep observes EVERY step the walk
// issues — exactly the "real steps across separate drives" the mitigation removes.

/** The direct-mode inline-step shape (executor.ts:146) plus step-NAME capture. */
function countingStep(names: string[]) {
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    names.push(name);
    return fn();
  };
}

async function instRow(instanceId: string) {
  return env.DB.prepare(`SELECT status, current_element_id FROM process_instances WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ status: string; current_element_id: string | null }>();
}

describe("step-free park on rewalk (M5-L3 Task 4, design §6)", () => {
  it("a rewalk over an unchanged parked service task issues ZERO svc-park steps", async () => {
    // Parks on the forward service task Task_check (external-check job created,
    // never drained), so every re-drive lands on the same in-flight park.
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: `sfp-svc-${crypto.randomUUID()}`,
      variables: {},
    });
    const id = instance.body.instanceId as string;
    const parked = await instRow(id);
    expect(parked?.status).toBe("waiting");
    expect(parked?.current_element_id).toBe("Task_check");

    // First cold re-drive: baseline (whatever the walk issues over the frontier).
    const names1: string[] = [];
    await runInstance(env, id, { runStep: countingStep(names1), waitFor: null });
    expect((await instRow(id))?.status).toBe("waiting");

    // Second cold re-drive, nothing changed: MUST issue zero svc-park steps.
    const names2: string[] = [];
    await runInstance(env, id, { runStep: countingStep(names2), waitFor: null });
    expect(names2.filter((n) => n.startsWith("svc-park:"))).toEqual([]);

    // ...and the instance is still parked on the same element (state unchanged).
    const after = await instRow(id);
    expect(after?.status).toBe("waiting");
    expect(after?.current_element_id).toBe("Task_check");
  });

  it("a rewalk over an unchanged parked callActivity issues ZERO call-park steps", async () => {
    // The called child must be published first (calledElement version binding).
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);

    // Parent parks on call1; its child parks on its own echo task (never drained),
    // so the parent stays `waiting` on call1 across every re-drive.
    const { instance } = await publishAndStart(SIMPLE_PARENT_BPMN, {
      correlationKey: `sfp-ca-${crypto.randomUUID()}`,
      variables: {},
    });
    const id = instance.body.instanceId as string;
    const parked = await instRow(id);
    expect(parked?.status).toBe("waiting");
    expect(parked?.current_element_id).toBe("call1");

    const names1: string[] = [];
    await runInstance(env, id, { runStep: countingStep(names1), waitFor: null });
    expect((await instRow(id))?.status).toBe("waiting");

    const names2: string[] = [];
    await runInstance(env, id, { runStep: countingStep(names2), waitFor: null });
    expect(names2.filter((n) => n.startsWith("call-park:"))).toEqual([]);

    const after = await instRow(id);
    expect(after?.status).toBe("waiting");
    expect(after?.current_element_id).toBe("call1");
  });
});
