import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, drainSampleWorkers, get, mintWorkerToken, post, publishAndStart, publishDraft } from "../helpers";
import {
  CHECK_LEAF_BPMN,
  CHECK_MID_BPMN,
  CHECK_PARALLEL_PARENT_BPMN,
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

async function varsOf(instanceId: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(`SELECT variables FROM process_instances WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ variables: string }>();
  return JSON.parse(row?.variables ?? "{}") as Record<string, unknown>;
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

  // The saga-wide variable-patch contract (deliberate semantics, not an
  // accident of implementation): operator-supplied retry variables are
  // shallow-merged into the ROOT and into EVERY child instance the cascade
  // retries (incident|compensationFailed) — direct child verbs are 409'd in
  // v1, so the root verb is the operator's only lever for a variable-caused
  // child failure (spec §6). Also pins the response invariant: a successful
  // cascade returns 200 even though the root itself has nothing retryable.
  it("[3] saga-wide patch: one root /retry heals BOTH incident siblings, the patch lands on EACH child's own row", async () => {
    const leafDraft = await createDraft(CHECK_LEAF_BPMN);
    await publishDraft(leafDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CHECK_PARALLEL_PARENT_BPMN, { correlationKey: "ca-op-siblings", variables: { forceFail: true } });
    const rootId = instance.body.instanceId as string;
    const childA = await childInstanceIdFor(rootId, "callA", 0);
    const childB = await childInstanceIdFor(rootId, "callB", 0);

    // Both sibling children exhaust their external-check independently — TWO
    // concurrent incidents under one waiting root.
    await drainSampleWorkers({ taskTypes: ["external-check"], token, maxRounds: 10 });
    expect((await instRow(childA))?.status).toBe("incident");
    expect((await instRow(childB))?.status).toBe("incident");
    expect((await instRow(rootId))?.status).toBe("waiting");

    // Cascade healed + root has nothing retryable of its own → 200, not 409
    // (the review invariant: a successful cascade never surfaces as an error).
    const retry = await post(`/instances/${rootId}/retry`, { variables: { forceFail: false } });
    expect(retry.status).toBe(200);

    // The DELIBERATE saga-wide semantics: the patch was merged into BOTH
    // retried children's own rows (each child's re-armed job reads its own
    // frozen input_variables from that row), and both were actually retried.
    expect((await varsOf(childA)).forceFail).toBe(false);
    expect((await varsOf(childB)).forceFail).toBe(false);
    for (const cid of [childA, childB]) {
      const h = await historyOfType(cid, "operatorRetry");
      expect(h).toHaveLength(1);
      expect(h[0]!.diagnostics).toMatchObject({ target: "forward" });
    }
    const rootHistory = await historyOfType(rootId, "operatorRetry");
    expect(rootHistory).toHaveLength(1);
    expect(rootHistory[0]!.diagnostics).toMatchObject({ target: "childSubtree" });

    // Both heal; the AND-join releases; the whole saga completes.
    await drainSampleWorkers({ taskTypes: ["external-check"], token, maxRounds: 10 });
    expect((await instRow(childA))?.status).toBe("completed");
    expect((await instRow(childB))?.status).toBe("completed");
    expect((await instRow(rootId))?.status).toBe("completed");
  });
});
