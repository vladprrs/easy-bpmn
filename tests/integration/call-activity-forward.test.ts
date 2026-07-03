import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, drainSampleWorkers, get, leaseAndComplete, mintWorkerToken, publishAndStart, publishDraft } from "../helpers";
import { SIMPLE_CHILD_BPMN, SIMPLE_PARENT_BPMN } from "./call-activity-fixtures";
import { childInstanceIdFor } from "../../src/runtime/call-activity";
import { resumeInline } from "../../src/runtime/engine";

// M5-L2 Task 6 — the forward callActivity lifecycle over the pull data plane:
// child instance created from the parent's callActivity visit, its terminal
// output merged back, the parent continues + completes. Direct mode runs the
// child's own service task through the SAME /jobs pull plane as any instance.

async function childRow(parentId: string) {
  return env.DB.prepare(
    `SELECT child_instance_id, status FROM child_instances
       WHERE parent_instance_id = ? AND parent_element_id = 'call1' AND occurrence = 0 AND iteration_index = 0`,
  )
    .bind(parentId)
    .all<{ child_instance_id: string; status: string }>();
}

async function instRow(instanceId: string) {
  return env.DB.prepare(
    `SELECT status, parent_instance_id, correlation_key, variables FROM process_instances WHERE instance_id = ?`,
  )
    .bind(instanceId)
    .first<{ status: string; parent_instance_id: string | null; correlation_key: string; variables: string }>();
}

async function historyTypeCounts(instanceId: string): Promise<Record<string, number>> {
  const res = await get(`/instances/${instanceId}/history`);
  const counts: Record<string, number> = {};
  for (const e of res.body.events as Array<{ type: string }>) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

describe("callActivity forward lifecycle (M5-L2 Task 6)", () => {
  it("runs a callActivity end-to-end: child instance created, output merged, parent completes", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);

    const { instance } = await publishAndStart(SIMPLE_PARENT_BPMN, { correlationKey: "ca-happy", variables: { seed: 1 } });
    const parentId = instance.body.instanceId as string;
    expect(instance.body.status).toBe("waiting"); // parked on call1, awaiting the child

    await drainSampleWorkers({ taskTypes: ["echo"] });

    const parent = await get(`/instances/${parentId}`);
    expect(parent.body.status).toBe("completed");
    // Pass-through both ways: the seed flows into the child, the child's echo
    // output merges back into the parent.
    expect((parent.body.variables as { echoed: { seed: number } }).echoed.seed).toBe(1);

    const childId = await childInstanceIdFor(parentId, "call1", 0);
    const child = await instRow(childId);
    expect(child?.status).toBe("completed");
    expect(child?.parent_instance_id).toBe(parentId);
    expect(child?.correlation_key).toBe(`child:${childId}`);

    const rows = await childRow(parentId);
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.child_instance_id).toBe(childId);
    expect(rows.results[0]!.status).toBe("outputApplied");

    const counts = await historyTypeCounts(parentId);
    expect(counts.callActivityInvoked).toBe(1);
    expect(counts.callActivityCompleted).toBe(1);
  });

  it("is idempotent: a duplicate inline re-drive neither re-creates nor re-applies", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);

    const { instance } = await publishAndStart(SIMPLE_PARENT_BPMN, { correlationKey: "ca-idem", variables: { seed: 7 } });
    const parentId = instance.body.instanceId as string;
    const token = await mintWorkerToken();

    // Drive the child's echo to completion → parent applies call1 and parks on p-after.
    await leaseAndComplete(token, "echo");

    const afterApply = await instRow(parentId);
    expect(afterApply?.status).toBe("waiting");
    const varsAfterApply = afterApply?.variables;

    // Duplicate inline re-drive of the NON-terminal parent: the call1 visit is
    // now `outputApplied`, so the rewalk fast-forwards write-free (no re-create,
    // no re-apply) instead of re-invoking the child or re-merging its output.
    await resumeInline(env, parentId);
    // And a duplicate re-drive of the (terminal) child — its notify to the parent
    // must not re-apply either.
    const childId = await childInstanceIdFor(parentId, "call1", 0);
    await resumeInline(env, childId);

    // Exactly one child row, one invoke, one completion; variables unchanged.
    const rows = await childRow(parentId);
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.status).toBe("outputApplied");
    const counts = await historyTypeCounts(parentId);
    expect(counts.callActivityInvoked).toBe(1);
    expect(counts.callActivityCompleted).toBe(1);
    expect((await instRow(parentId))?.variables).toBe(varsAfterApply);

    // The saga still finishes normally after the duplicates (p-after echo → end).
    await drainSampleWorkers({ taskTypes: ["echo"], token });
    expect((await instRow(parentId))?.status).toBe("completed");
  });

  it("deterministic child id", async () => {
    const a = await childInstanceIdFor("pi-x", "call1", 0);
    expect(a).toBe(await childInstanceIdFor("pi-x", "call1", 0));
    expect(a).not.toBe(await childInstanceIdFor("pi-x", "call1", 1));
    expect(a).toMatch(/^pi-[0-9a-f]{24}$/);
  });
});
