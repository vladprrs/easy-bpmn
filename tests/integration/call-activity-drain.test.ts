import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, drainSampleWorkers, get, leaseAndComplete, mintWorkerToken, post, publishAndStart, publishDraft } from "../helpers";
import {
  CALL_CHILD_TX_PARK_BPMN,
  CALL_LEAF_BPMN,
  CALL_MID_BPMN,
  CALL_PARENT_SCOPE_DRAIN_BPMN,
  CALL_PARENT_TIMER_BPMN,
  CALL_ROOT_3LEVEL_BPMN,
  SIMPLE_CHILD_BPMN,
  SIMPLE_PARENT_BPMN,
} from "./call-activity-fixtures";
import { childInstanceIdFor } from "../../src/runtime/call-activity";
import { cancelChildCascade, cancelChildrenInSubtree } from "../../src/runtime/child-cascade";
import { loadGraphForInstance } from "../../src/runtime/engine";

// M5-L2 Task 8 — cascading drain/cancel: a timer Hazard directly on a
// callActivity, a scope drain (error bubble) that reaches a callActivity's
// still-running child, an operator /cancel that cascades transitively through a
// multi-level call chain, and the never-regress guard on an already-terminal
// child. `cancelChildCascade` NEVER compensates (Hazard-vs-Cancel, spec-mirror
// of the M5-L1 scope-timer split) — it abandons in-flight work and CAS's the
// child `cancelled`, retaining its saga ledger untouched.

async function instRow(instanceId: string) {
  return env.DB.prepare(
    `SELECT status, error_code, current_element_id, parent_instance_id, parent_element_id FROM process_instances WHERE instance_id = ?`,
  )
    .bind(instanceId)
    .first<{ status: string; error_code: string | null; current_element_id: string | null; parent_instance_id: string | null; parent_element_id: string | null }>();
}

async function historyEventsOfType(instanceId: string, type: string): Promise<Array<{ diagnostics: Record<string, unknown> }>> {
  const res = await get(`/instances/${instanceId}/history`);
  return (res.body.events as Array<{ type: string; diagnostics: Record<string, unknown> }>).filter((e) => e.type === type);
}

async function jobsFor(instanceId: string, taskType: string): Promise<Array<{ status: string; is_compensation: number }>> {
  const res = await env.DB.prepare(`SELECT status, is_compensation FROM service_task_jobs WHERE instance_id = ? AND task_type = ?`)
    .bind(instanceId, taskType)
    .all<{ status: string; is_compensation: number }>();
  return res.results ?? [];
}

async function sagaStepsFor(instanceId: string): Promise<Array<{ element_id: string; compensation_status: string }>> {
  const res = await env.DB.prepare(`SELECT element_id, compensation_status FROM saga_steps WHERE instance_id = ?`)
    .bind(instanceId)
    .all<{ element_id: string; compensation_status: string }>();
  return res.results ?? [];
}

async function theTimer(instanceId: string): Promise<{ timer_id: string } | null> {
  return env.DB.prepare(`SELECT * FROM timers WHERE instance_id = ? ORDER BY created_at LIMIT 1`).bind(instanceId).first<{ timer_id: string }>();
}

/** Force the armed timer overdue, then fire its DO alarm — mirrors boundary-timer.test.ts. */
async function fireTimerNow(instanceId: string): Promise<string> {
  const t = await theTimer(instanceId);
  expect(t).toBeTruthy();
  await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(t!.timer_id).run();
  const stub = env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`timer:${t!.timer_id}`));
  const ran = await runDurableObjectAlarm(stub);
  expect(ran).toBe(true);
  return t!.timer_id;
}

describe("callActivity cascading drain/cancel (M5-L2 Task 8)", () => {
  it("[1] [CA-HAZARD-TIMER-01] timer Hazard on the callActivity: fires -> child cancelled, forward job abandoned, NO compensation, ledger retained", async () => {
    const childDraft = await createDraft(CALL_CHILD_TX_PARK_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CALL_PARENT_TIMER_BPMN, { correlationKey: "ca-drain-timer", variables: {} });
    const parentId = instance.body.instanceId as string;

    const childId = await childInstanceIdFor(parentId, "call1", 0);
    // Commit the child's tx, then it parks on `ctp-park` forever (never drained).
    await drainSampleWorkers({ taskTypes: ["reserve-stock-park"], token });
    const beforeChild = await instRow(childId);
    expect(beforeChild?.status).toBe("waiting");
    expect(beforeChild?.current_element_id).toBe("ctp-park");

    const timerId = await fireTimerNow(parentId);
    expect(
      (await env.DB.prepare(`SELECT outcome FROM timer_outcomes WHERE timer_id = ?`).bind(timerId).first<{ outcome: string }>())?.outcome,
    ).toBe("fired");

    // The parent took the boundary path and is now driving the timeout handler.
    const parent = await get(`/instances/${parentId}`);
    expect(parent.body.currentElementId ?? parent.body.current_element_id).toBe("pt-timeout");

    // The child was cascade-cancelled with the parentDrain marker.
    const child = await instRow(childId);
    expect(child?.status).toBe("cancelled");
    const cancelledEvents = await historyEventsOfType(childId, "instanceCancelled");
    expect(cancelledEvents).toHaveLength(1);
    expect(cancelledEvents[0]!.diagnostics).toMatchObject({ by: "parentDrain" });

    // The child's parked forward job (`ctp-park`) was abandoned (created -> failed).
    const parkJobs = await jobsFor(childId, "child-park");
    expect(parkJobs).toHaveLength(1);
    expect(parkJobs[0]!.status).toBe("failed");

    // Hazard semantics: NO compensation ran — no compensation job was ever
    // created for `ctp-reserve`, and its ledger row is RETAINED, not compensated.
    const releaseJobs = await jobsFor(childId, "release-stock-park");
    expect(releaseJobs).toHaveLength(0);
    const steps = await sagaStepsFor(childId);
    const reserveStep = steps.find((s) => s.element_id === "ctp-reserve");
    expect(reserveStep).toBeDefined(); // retained, not deleted
    // The child's tx already committed BEFORE the child parked — the
    // cascade-cancel must not touch it. Task 9 (R1 seal semantics): a CHILD
    // instance's outermost tx commit is only LOCAL (`committedLocal`) — the
    // parent is a real outer scope whose reverse pass may later undo it; only
    // a ROOT instance's outermost commit seals terminal 'committed'.
    expect(reserveStep!.compensation_status).toBe("committedLocal");

    // Idempotent re-drive: a duplicate cascade-cancel of the already-cancelled
    // child (Workflow retry / a later rewalk landing on the same fired visit)
    // is a cheap no-op — no duplicate `instanceCancelled` history, status stable.
    await cancelChildCascade(env, childId);
    expect((await instRow(childId))?.status).toBe("cancelled");
    expect(await historyEventsOfType(childId, "instanceCancelled")).toHaveLength(1);

    // Finish the parent's timeout path so the run terminates cleanly.
    await leaseAndComplete(token, "timeout-handler", {});
    expect((await get(`/instances/${parentId}`)).body.status).toBe("completed");
  });

  it("[2] error-bubble scope drain cancels a still-running sibling call1 child", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CALL_PARENT_SCOPE_DRAIN_BPMN, { correlationKey: "ca-drain-scope", variables: {} });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);

    // call1's branch parked its child at `sc-echo` (never drained); the sibling
    // branch business-errors, uncaught at its own level, bubbling to SD.
    const before = await instRow(childId);
    expect(before?.status).toBe("waiting");

    await drainSampleWorkers({ taskTypes: ["sibling-task"], token }); // sample worker raises SIBLING_FAILED

    // The subProcess's error boundary caught it and drained the scope.
    const scopeExited = await historyEventsOfType(parentId, "scopeExited");
    expect(scopeExited.some((e) => e.diagnostics.scope === "SD")).toBe(true);

    const child = await instRow(childId);
    expect(child?.status).toBe("cancelled");
    const cancelledEvents = await historyEventsOfType(childId, "instanceCancelled");
    expect(cancelledEvents).toHaveLength(1);
    expect(cancelledEvents[0]!.diagnostics).toMatchObject({ by: "parentDrain" });

    // The parent's cursor already routed to the error boundary's target (the
    // scope-caught business-error apply sets `current_element_id` atomically
    // with the route, before the drain runs) — the abnormal exit itself is
    // proven; driving the parent to its own final completion afterwards is
    // orthogonal to this task's cascade contract, so it is not asserted here.
    const parent = await instRow(parentId);
    expect(parent?.current_element_id).toBe("sd-handle");
  });

  it("[3] operator /cancel cascades through a 3-level call chain (parent -> mid -> leaf)", async () => {
    const leafDraft = await createDraft(CALL_LEAF_BPMN);
    await publishDraft(leafDraft.body.draftId);
    const midDraft = await createDraft(CALL_MID_BPMN);
    await publishDraft(midDraft.body.draftId);

    const { instance } = await publishAndStart(CALL_ROOT_3LEVEL_BPMN, { correlationKey: "ca-drain-3level", variables: {} });
    const rootId = instance.body.instanceId as string;
    const midId = await childInstanceIdFor(rootId, "call1", 0);
    const leafId = await childInstanceIdFor(midId, "call2", 0);

    // The whole chain is inline-invoked synchronously (direct mode); the leaf
    // parks on `lf-park` (never drained), so mid parks at call2 and root at call1.
    expect((await instRow(rootId))?.current_element_id).toBe("call1");
    expect((await instRow(midId))?.status).toBe("waiting");
    expect((await instRow(midId))?.current_element_id).toBe("call2");
    expect((await instRow(leafId))?.status).toBe("waiting");
    expect((await instRow(leafId))?.current_element_id).toBe("lf-park");

    const cancelled = await post(`/instances/${rootId}/cancel`, {});
    expect(cancelled.status).toBe(200);
    // No transaction anywhere in the chain -> empty ledger -> cancelled outright.
    expect(cancelled.body.status).toBe("cancelled");

    const mid = await instRow(midId);
    expect(mid?.status).toBe("cancelled");
    expect((await historyEventsOfType(midId, "instanceCancelled"))[0]!.diagnostics).toMatchObject({ by: "parentDrain" });

    const leaf = await instRow(leafId);
    expect(leaf?.status).toBe("cancelled");
    expect((await historyEventsOfType(leafId, "instanceCancelled"))[0]!.diagnostics).toMatchObject({ by: "parentDrain" });

    // The leaf's in-flight forward job was abandoned too.
    const leafJobs = await jobsFor(leafId, "leaf-park");
    expect(leafJobs).toHaveLength(1);
    expect(leafJobs[0]!.status).toBe("failed");

    // Idempotent re-drive at the subtree entry point too (a second drain over
    // the same root — a retried step, or the belt-and-braces re-run a real
    // operator /cancel's cascade hook would see on a step retry): every child
    // is already cancelled/terminal, so this is a cheap no-op — no duplicate
    // `instanceCancelled` rows anywhere in the chain.
    const graph = await loadGraphForInstance(env, rootId);
    await cancelChildrenInSubtree(env, graph, rootId, null);
    expect(await historyEventsOfType(midId, "instanceCancelled")).toHaveLength(1);
    expect(await historyEventsOfType(leafId, "instanceCancelled")).toHaveLength(1);
  });

  it("[4] never regresses an already-completed child", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(SIMPLE_PARENT_BPMN, { correlationKey: "ca-drain-noregress", variables: {} });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);

    // Complete ONLY the child's `sc-echo` job (a single lease+complete, not a full
    // drain — `p-after` and `sc-echo` share the "echo" taskType, and a full drain
    // would also complete the PARENT's own p-after job once call1 applies). The
    // child completes; the parent's call1 applies (notified inline in direct
    // mode) and parks on its OWN `p-after` task (still running/waiting).
    await leaseAndComplete(token, "echo", {});
    const childBefore = await instRow(childId);
    expect(childBefore?.status).toBe("completed");
    const parentBefore = await instRow(parentId);
    expect(["running", "waiting"]).toContain(parentBefore?.status);

    const cancelled = await post(`/instances/${parentId}/cancel`, {});
    expect(cancelled.status).toBe(200);

    // The already-completed child is untouched — never regressed to cancelled.
    const childAfter = await instRow(childId);
    expect(childAfter?.status).toBe("completed");
    expect(await historyEventsOfType(childId, "instanceCancelled")).toHaveLength(0);
  });
});
