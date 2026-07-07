import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, drainSampleWorkers, get, mintWorkerToken, post, publishAndStart, publishDraft } from "../helpers";
import { childInstanceIdFor } from "../../src/runtime/call-activity";
import { CHECK_LEAF_BPMN, SIMPLE_CHILD_BPMN } from "./call-activity-fixtures";
import { MI_CALL_BPMN, MI_CALL_CHECK_BPMN } from "./multi-instance-fixtures";

// M5-L3 (Task 12) — the operator/console surface over an MI fan-out. The
// lineage block gains `iterationIndex` (the 4th child-identity dimension the
// 0008/0009 rows already persist), so a console operator can tell WHICH
// iteration a child chip is — three children of one callActivity visit are
// otherwise indistinguishable. The operator VERBS are unchanged L2 machinery
// re-proven over iteration children: direct child cancel/retry 409s naming the
// parent, and the root /retry cascade heals EVERY incident iteration child.

const uid = () => crypto.randomUUID().slice(0, 8);

async function instRow(instanceId: string) {
  return env.DB.prepare(`SELECT status, variables FROM process_instances WHERE instance_id = ?`)
    .bind(instanceId)
    .first<{ status: string; variables: string }>();
}

interface LineageChildBody {
  elementId: string;
  occurrence: number;
  iterationIndex: number;
  childInstanceId: string;
  status: string;
}

describe("M5-L3 MI operator surface — lineage iterationIndex + cascading verbs (direct mode)", () => {
  it("[MI-LINEAGE-01] the lineage block lists every MI iteration child with its iterationIndex", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);

    const { instance } = await publishAndStart(MI_CALL_BPMN, {
      correlationKey: `mi-lineage-${uid()}`,
      variables: { items: ["a", "b", "c"] },
    });
    const parentId = instance.body.instanceId as string;

    const parent = await get(`/instances/${parentId}`);
    expect(parent.status).toBe(200);
    const lineage = parent.body.lineage as { parent: unknown; children: LineageChildBody[] };
    expect(lineage.parent).toBeNull();
    expect(lineage.children).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(lineage.children[i]).toMatchObject({
        elementId: "mi1",
        occurrence: 0,
        iterationIndex: i,
        childInstanceId: await childInstanceIdFor(parentId, "mi1", 0, i),
        status: "waiting",
      });
    }

    // A child's own inspection carries the unchanged L2 parent breadcrumb.
    const child = await get(`/instances/${lineage.children[0]!.childInstanceId}`);
    expect(child.status).toBe(200);
    expect(child.body.lineage.parent).toMatchObject({ instanceId: parentId, elementId: "mi1" });
  });

  it("[MI-OP-409-01] direct /cancel and /retry on an MI iteration child both 409, naming the parent", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);

    const { instance } = await publishAndStart(MI_CALL_BPMN, {
      correlationKey: `mi-409-${uid()}`,
      variables: { items: ["a", "b"] },
    });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "mi1", 0, 1);
    expect((await instRow(childId))?.status).toBe("waiting");

    const cancelRes = await post(`/instances/${childId}/cancel`, {});
    expect(cancelRes.status).toBe(409);
    expect(cancelRes.body.error).toContain(parentId);

    const retryRes = await post(`/instances/${childId}/retry`, {});
    expect(retryRes.status).toBe(409);
    expect(retryRes.body.error).toContain(parentId);

    // The 409s are read-only — the iteration child stays parked mid-flight.
    expect((await instRow(childId))?.status).toBe("waiting");
  });

  it("[MI-OP-RETRY-01] one root /retry cascades into EVERY incident iteration child and heals the fan-out", async () => {
    const leafDraft = await createDraft(CHECK_LEAF_BPMN);
    await publishDraft(leafDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(MI_CALL_CHECK_BPMN, {
      correlationKey: `mi-op-retry-${uid()}`,
      variables: { items: ["a", "b"], forceFail: true },
    });
    const parentId = instance.body.instanceId as string;
    const child0 = await childInstanceIdFor(parentId, "mi1", 0, 0);
    const child1 = await childInstanceIdFor(parentId, "mi1", 0, 1);

    // Both iteration children exhaust their own external-check retries into
    // child-LOCAL incidents; the MI parent just stays parked (an `incident`
    // child status is never consumable by its parent — L2 spec §4).
    await drainSampleWorkers({ taskTypes: ["external-check"], token, maxRounds: 10 });
    expect((await instRow(child0))?.status).toBe("incident");
    expect((await instRow(child1))?.status).toBe("incident");
    expect((await instRow(parentId))?.status).toBe("waiting");

    // The root /retry is the operator's ONLY lever (direct child verbs 409):
    // the cascade heals BOTH iteration children, the patch lands on each row.
    const retry = await post(`/instances/${parentId}/retry`, { variables: { forceFail: false } });
    expect(retry.status).toBe(200);
    expect((await instRow(child0))?.status).not.toBe("incident");
    expect((await instRow(child1))?.status).not.toBe("incident");

    // The healed jobs re-run clean → children complete → the MI aggregates and
    // the whole fan-out completes.
    await drainSampleWorkers({ taskTypes: ["external-check"], token, maxRounds: 10 });
    expect((await instRow(child0))?.status).toBe("completed");
    expect((await instRow(child1))?.status).toBe("completed");
    const parent = await instRow(parentId);
    expect(parent?.status).toBe("completed");
    const results = (JSON.parse(parent!.variables) as { results: unknown[] }).results;
    expect(results).toHaveLength(2);
  });
});
