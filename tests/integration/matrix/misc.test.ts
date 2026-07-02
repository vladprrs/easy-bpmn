import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createDraft, get, publishDraft, publishMessage } from "../../helpers";
import { createInstance, getInstance, getSubscriptionForVisit } from "../../../src/persistence/instances";
import { getExternalMessageRow, getCorrelatedMessageForSubscription } from "../../../src/persistence/messages";
import { getVersionGraph } from "../../../src/persistence/definitions";
import { runInstance, resumeInline, type RunStep } from "../../../src/runtime/engine";

// Single receive-task model (Start → ReceiveTask "Ready" → End).
const RECEIVE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D_strand" targetNamespace="x">
  <bpmn:message id="m_ready" name="Ready"/>
  <bpmn:process id="P_strand" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>s0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="R"/>
    <bpmn:receiveTask id="R" name="Wait" messageRef="m_ready"><bpmn:incoming>s0</bpmn:incoming><bpmn:outgoing>s1</bpmn:outgoing></bpmn:receiveTask>
    <bpmn:sequenceFlow id="s1" sourceRef="R" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>s1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

// [W-BUFFERED-STRAND-01] — white-box (direct/CI-reachable) acceptance of the
// apply-from-D1 provenance fix (design §7).
//
// The hole: a broker-buffered message claimed at branch/receive REGISTRATION used
// to record its `external_messages.matched_subscription_id` link only in the
// SEPARATE `msg:<tag>` applyMessage step. A Workflow that TERMINATED between the
// claim (recv step: broker buffer consumed + deleted) and the apply (msg step) left
// the row final_outcome='buffered' / matched_subscription_id=NULL with the broker
// buffer already gone — so a terminated-Workflow inline re-drive (no step cache)
// re-registered a fresh active subscription that getCorrelatedMessageForSubscription
// could NEVER satisfy → a PERMANENT strand until the wait cap.
//
// This test reproduces that exact window: buffer the message, then drive with a
// RunStep that COMMITS the recv step (the claim) but THROWS at the `msg:` step
// (the terminate). The fix records the provenance ATOMICALLY in the recv step, so:
//   (a) after the simulated terminate the row is correlated + linked (NOT a strand);
//   (b) the inline re-drive recovers the payload via apply-from-D1 and completes.
describe("matrix misc (workflow-strand acceptance)", () => {
  it("[W-BUFFERED-STRAND-01] a buffer-claimed message records apply-from-D1 provenance, so a terminate-after-claim re-drive recovers (no strand)", async () => {
    const draft = await createDraft(RECEIVE_BPMN, "strand");
    expect(draft.status).toBe(201);
    const pub = await publishDraft(draft.body.draftId);
    expect(pub.status).toBe(201);
    const versionId = pub.body.definitionVersionId as string;
    const graph = await getVersionGraph(env.DB, versionId);
    expect(graph).toBeTruthy();

    const ck = `strand-${Date.now()}`;
    const instanceId = `pi_${ck}`;
    const now = new Date().toISOString();
    // Create the instance row WITHOUT auto-driving (so the buffer is present before
    // the receive registers — the only way to reach the buffer-CLAIM path).
    await createInstance(env.DB, {
      instanceId,
      workspaceId: "default",
      definitionVersionId: versionId,
      workflowInstanceId: instanceId,
      correlationKey: ck,
      startElementId: graph!.startElementId,
      variables: {},
      now,
    });

    // Publish the message BEFORE any subscription exists → the broker buffers it.
    const buffered = await publishMessage({
      messageName: "Ready",
      correlationKey: ck,
      messageId: `${ck}-m1`,
      payload: { greeted: true },
    });
    expect(buffered.body.outcome, JSON.stringify(buffered.body)).toBe("buffered");
    const emId = buffered.body.externalMessageId as string;

    // Drive: the recv step claims the buffer (and, with the fix, records provenance);
    // the msg step THROWS — modeling a Workflow terminated right after the claim.
    const terminateAtApply: RunStep = (name, fn) => {
      if (name.startsWith("msg:")) throw new Error("simulated Workflow terminate after buffer-claim, before apply");
      return fn();
    };
    await expect(
      runInstance(env, instanceId, { runStep: terminateAtApply, waitFor: null }),
    ).rejects.toThrow();

    // (a) Provenance recorded AT THE CLAIM (the fix): the buffered row is now
    // correlated + linked to a persisted ACTIVE subscription. Pre-fix this row would
    // still be final_outcome='buffered' / matched_subscription_id=NULL (the strand).
    const sub = await getSubscriptionForVisit(env.DB, instanceId, "R", 0);
    expect(sub?.status).toBe("active");
    const row = await getExternalMessageRow(env.DB, emId);
    expect(row?.final_outcome).toBe("correlated");
    expect(row?.matched_subscription_id).toBe(sub!.subscription_id);

    // getCorrelatedMessageForSubscription (the apply-from-D1 source) can now recover it.
    const recovered = await getCorrelatedMessageForSubscription(env.DB, sub!.subscription_id);
    expect(recovered?.payload).toEqual({ greeted: true });

    // (b) The terminated-Workflow inline re-drive (no step cache) recovers via
    // apply-from-D1 and completes with the payload applied — no waitTimeout strand.
    await resumeInline(env, instanceId);
    const final = await getInstance(env.DB, instanceId);
    expect(final?.status).toBe("completed");
    const status = await get(`/instances/${instanceId}`);
    expect(status.body.variables).toMatchObject({ greeted: true });
  });
});
