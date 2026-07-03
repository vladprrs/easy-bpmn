import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, drainSampleWorkers, get, mintWorkerToken, post, publishAndStart, publishDraft } from "../helpers";
import {
  CHECK_LEAF_BPMN,
  CHECK_MID_BPMN,
  CHECK_ROOT_BPMN,
  SIMPLE_CHILD_BPMN,
  SIMPLE_PARENT_BPMN,
} from "./call-activity-fixtures";
import { childInstanceIdFor } from "../../src/runtime/call-activity";

// M5-L2 Task 10 — operator verbs on callActivity sagas: a direct /cancel or
// /retry on a CHILD instance 409s naming the parent (all control flows through
// the saga root — spec §6); a /retry on the ROOT cascades depth-first into the
// child subtree, healing the DEEPEST incident/compensationFailed instance
// first (skipping an ancestor that has nothing of its own to retry).

async function instRow(instanceId: string) {
  return env.DB.prepare(
    `SELECT status, error_code, current_element_id FROM process_instances WHERE instance_id = ?`,
  )
    .bind(instanceId)
    .first<{ status: string; error_code: string | null; current_element_id: string | null }>();
}

async function historyOfType(instanceId: string, type: string): Promise<Array<{ elementId: string | null; diagnostics: Record<string, unknown> }>> {
  const res = await get(`/instances/${instanceId}/history`);
  return (res.body.events as Array<{ type: string; elementId: string | null; diagnostics: Record<string, unknown> }>).filter((e) => e.type === type);
}

describe("callActivity operator verbs (M5-L2 Task 10)", () => {
  it("[1] direct /cancel and /retry on a callActivity CHILD both 409, naming the parent", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);

    const { instance } = await publishAndStart(SIMPLE_PARENT_BPMN, { correlationKey: "ca-op-409", variables: { seed: 1 } });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);
    // The child instance exists (parked mid-flight on its own echo task).
    expect((await instRow(childId))?.status).toBe("waiting");

    const cancelRes = await post(`/instances/${childId}/cancel`, {});
    expect(cancelRes.status).toBe(409);
    expect(cancelRes.body.error).toContain(parentId);

    const retryRes = await post(`/instances/${childId}/retry`, {});
    expect(retryRes.status).toBe(409);
    expect(retryRes.body.error).toContain(parentId);

    // The 409s are read-only — the child's own lifecycle is untouched.
    expect((await instRow(childId))?.status).toBe("waiting");
  });

  it("[2] cascading /retry heals the DEEPEST (grandchild) forward incident first, skipping the mid ancestor", async () => {
    const leafDraft = await createDraft(CHECK_LEAF_BPMN);
    await publishDraft(leafDraft.body.draftId);
    const midDraft = await createDraft(CHECK_MID_BPMN);
    await publishDraft(midDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CHECK_ROOT_BPMN, { correlationKey: "ca-op-cascade", variables: { forceFail: true } });
    const rootId = instance.body.instanceId as string;
    const midId = await childInstanceIdFor(rootId, "call1", 0);
    const leafId = await childInstanceIdFor(midId, "call2", 0);

    // Drive the leaf's external-check until retries=1 exhausts -> a child-local
    // incident. Neither the mid nor the root themselves ever incident — an
    // `incident` child status is not consumable by its own parent (spec §4);
    // they just stay parked `waiting` on their own callActivity.
    await drainSampleWorkers({ taskTypes: ["external-check"], token, maxRounds: 10 });
    expect((await instRow(leafId))?.status).toBe("incident");
    expect((await instRow(midId))?.status).toBe("waiting");
    expect((await instRow(rootId))?.status).toBe("waiting");

    const retry = await post(`/instances/${rootId}/retry`, { variables: { forceFail: false } });
    expect(retry.status).toBe(200);

    // Depth-first: the cascade reached PAST the mid (which has no incident of
    // its own — listChildrenOfInstance(mid) is where the recursion actually
    // found+healed the leaf) straight to the leaf. The leaf's own incident is
    // resolved and its job re-armed immediately, with no drain needed yet.
    expect((await instRow(leafId))?.status).not.toBe("incident");
    const leafIncidentHistory = await historyOfType(leafId, "operatorRetry");
    expect(leafIncidentHistory).toHaveLength(1);
    expect(leafIncidentHistory[0]!.diagnostics).toMatchObject({ target: "forward" });
    // The mid was never itself retried (it had nothing of its own to retry).
    expect(await historyOfType(midId, "operatorRetry")).toHaveLength(0);

    const rootRetryHistory = await historyOfType(rootId, "operatorRetry");
    expect(rootRetryHistory).toHaveLength(1);
    expect(rootRetryHistory[0]!.diagnostics).toMatchObject({ target: "childSubtree" });

    // The operator-supplied variable patch (forceFail:false) propagated all the
    // way down into the LEAF's own row — the fix the failing job actually needs.
    await drainSampleWorkers({ taskTypes: ["external-check"], token, maxRounds: 10 });
    expect((await instRow(leafId))?.status).toBe("completed");
    expect((await instRow(midId))?.status).toBe("completed");
    expect((await instRow(rootId))?.status).toBe("completed");

    // At-least-once: a duplicate /retry once the whole subtree already healed
    // (nothing in incident/compensationFailed, root itself terminal) is a safe
    // no-op — no crash, no re-mutation, no double history entry.
    const dup = await post(`/instances/${rootId}/retry`, {});
    expect(dup.status).toBe(409);
    expect(await historyOfType(rootId, "operatorRetry")).toHaveLength(1);
  });
});
