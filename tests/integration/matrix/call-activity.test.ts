import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, drainSampleWorkers, get, leaseAndComplete, mintWorkerToken, post, publishAndStart, publishDraft } from "../../helpers";
import {
  CALL_CHILD_BPMN,
  CALL_CHILD_TX_PARK_BPMN,
  CALL_PARENT_ERR_AND_TIMER_BPMN,
  CALL_PARENT_SCOPEDRAIN_TX_CANCEL_BPMN,
  CALL_PARENT_TX_CANCEL_BPMN,
  SIMPLE_CHILD_BPMN,
  SIMPLE_PARENT_BPMN,
} from "../call-activity-fixtures";
import { childInstanceIdFor } from "../../../src/runtime/call-activity";
import { resumeInline } from "../../../src/runtime/engine";

// M5-L2 Task 12 — the reverse-path matrix (spec §5): the CA-* registry rows
// this task registers directly (CA-IDEMP-REDRIVE-01, CA-COMP-CRASH-01), plus
// two controller additions carried from earlier task reviews:
//   1. (REQUIRED, Task 8's deferral) a combined error+timer boundary fixture
//      on the SAME callActivity, with the direct "no armed timer survives the
//      error route" assertion Task 8's carried disarm fix never got.
//   2/3. (PROBES, Task 9's review concerns #2/#4) two known-deferred
//      compositions — do NOT fix engine code here if they fail; document and
//      it.skip with a KNOWN GAP comment per the task brief.

async function instRow(instanceId: string) {
  return env.DB.prepare(
    `SELECT status, error_code, current_element_id, variables FROM process_instances WHERE instance_id = ?`,
  )
    .bind(instanceId)
    .first<{ status: string; error_code: string | null; current_element_id: string | null; variables: string }>();
}

async function jobsFor(instanceId: string, taskType: string) {
  const res = await env.DB.prepare(`SELECT status, is_compensation FROM service_task_jobs WHERE instance_id = ? AND task_type = ?`)
    .bind(instanceId, taskType)
    .all<{ status: string; is_compensation: number }>();
  return res.results ?? [];
}

async function sagaStepStatus(instanceId: string, elementId: string): Promise<string | undefined> {
  const row = await env.DB.prepare(`SELECT compensation_status FROM saga_steps WHERE instance_id = ? AND element_id = ?`)
    .bind(instanceId, elementId)
    .first<{ compensation_status: string }>();
  return row?.compensation_status;
}

async function historyTypeCounts(instanceId: string): Promise<Record<string, number>> {
  const res = await get(`/instances/${instanceId}/history`);
  const counts: Record<string, number> = {};
  for (const e of res.body.events as Array<{ type: string }>) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

async function childInstanceCount(parentInstanceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM child_instances WHERE parent_instance_id = ?`)
    .bind(parentInstanceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("matrix: callActivity reverse-path (M5-L2 Task 12)", () => {
  // -------------------------------------------------------------------------
  it("[CA-IDEMP-REDRIVE-01] cold inline re-drive of a completed parent is write-free", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);

    const { instance } = await publishAndStart(SIMPLE_PARENT_BPMN, { correlationKey: "ca-idemp-cold", variables: { seed: 3 } });
    const parentId = instance.body.instanceId as string;

    await drainSampleWorkers({ taskTypes: ["echo"] });
    expect((await instRow(parentId))?.status).toBe("completed");

    const childId = await childInstanceIdFor(parentId, "call1", 0);
    expect((await instRow(childId))?.status).toBe("completed");

    // Snapshot: history count + child row + variables, all BEFORE the re-drive.
    const beforeHistory = await historyTypeCounts(parentId);
    const beforeChildCount = await childInstanceCount(parentId);
    const beforeVars = (await instRow(parentId))?.variables;

    // Cold inline re-drive of the now-TERMINAL parent AND the terminal child —
    // both must fast-forward write-free (no re-apply, no re-notify, no new rows).
    await resumeInline(env, parentId);
    await resumeInline(env, childId);

    expect(await historyTypeCounts(parentId)).toEqual(beforeHistory);
    expect(await childInstanceCount(parentId)).toBe(beforeChildCount);
    expect((await instRow(parentId))?.status).toBe("completed");
    expect((await instRow(parentId))?.variables).toBe(beforeVars);
  });

  // -------------------------------------------------------------------------
  it("[CA-COMP-CRASH-01] parent re-drive mid child-compensation re-parks on 'compensating' (no double CAS, no duplicate comp job)", async () => {
    const childDraft = await createDraft(CALL_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CALL_PARENT_TX_CANCEL_BPMN, {
      correlationKey: "ca-crash-comp",
      variables: { failSettle: true },
    });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);

    // Forward to the point where the child is 'compensating' with a pending
    // release-stock comp job — do NOT pump it.
    await drainSampleWorkers({ taskTypes: ["charge-card"], token });
    await drainSampleWorkers({ taskTypes: ["reserve-stock"], token });
    await drainSampleWorkers({ taskTypes: ["branch-settle"], token });
    expect((await instRow(childId))?.status).toBe("compensating");
    expect(await jobsFor(childId, "release-stock")).toHaveLength(1);

    // Simulate crash-resume: direct mode's inline re-drive IS the recovery
    // path. resumeInline the parent TWICE while the child is mid-reverse.
    await resumeInline(env, parentId);
    await resumeInline(env, parentId);

    // No double CAS (still exactly 'compensating'), no duplicate comp job.
    expect((await instRow(childId))?.status).toBe("compensating");
    expect(await jobsFor(childId, "release-stock")).toHaveLength(1);
    expect((await instRow(parentId))?.status).toBe("compensating");

    // Pump it through: the child compensates, then the parent settles.
    await leaseAndComplete(token, "release-stock", {});
    expect((await instRow(childId))?.status).toBe("compensated");
    await leaseAndComplete(token, "refund-card", {});
    expect((await instRow(parentId))?.status).toBe("compensated");
  });

  // -------------------------------------------------------------------------
  // Controller addition #1 (REQUIRED — Task 8's own deferral): a combined
  // error+timer boundary fixture on the SAME callActivity. The direct
  // assertion `applyChildErrored`'s carried timer-disarm fix never got.
  it("error boundary AND timer boundary on the SAME callActivity: routing the error leaves NO armed timer", async () => {
    const childDraft = await createDraft(CALL_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);

    const { instance } = await publishAndStart(CALL_PARENT_ERR_AND_TIMER_BPMN, {
      correlationKey: "ca-err-timer-disarm",
      variables: { failChild: true },
    });
    const parentId = instance.body.instanceId as string;

    await drainSampleWorkers({ taskTypes: ["charge-card", "reserve-stock", "log-only"] });

    const parent = await get(`/instances/${parentId}`);
    expect(parent.body.status).toBe("completed");
    expect(parent.body.currentElementId ?? parent.body.current_element_id).toBe("pet-end2");

    // No armed timer survives the error route — `applyChildErrored`'s
    // `cancelSettle` must disarm call1's OWN guarding timer atomically.
    const armed = await env.DB.prepare(`SELECT COUNT(*) AS n FROM timers WHERE instance_id = ? AND status = 'armed'`)
      .bind(parentId)
      .first<{ n: number }>();
    expect(armed?.n).toBe(0);
    const timerRow = await env.DB.prepare(`SELECT status FROM timers WHERE instance_id = ? AND attached_to_ref = 'call1'`)
      .bind(parentId)
      .first<{ status: string }>();
    expect(timerRow?.status).toBe("cancelled");
  });

  // -------------------------------------------------------------------------
  // PROBE (a) — Task 9 review concern #2: an inner-scope `drainScopeSubtree`
  // cancel (NOT operator /cancel) discards a running child's live token
  // without ever ledgering a call1 saga step (unlike `ledgerStragglers`'s
  // dedicated `retainCallStraggler` branch — `drainScopeSubtree` has no
  // callActivity special-case at all). A LATER cancel of the enclosing
  // (outer) transaction should then drive the child's own committed step to
  // `compensated` via the parent's ledger — but if the row was never
  // written, there's nothing for the reverse pass to find. Per the task
  // brief: do NOT fix src/ here — write the probe, observe, and either keep
  // it enabled (if it passes) or it.skip with a KNOWN GAP comment (if it
  // reproduces the gap).
  // KNOWN GAP (M5-L2 follow-up): reproduced — `drainScopeSubtree` has no
  // callActivity special-case (unlike `ledgerStragglers`'s `retainCallStraggler`),
  // so the scope-drain path discards call1's live token without ever
  // ledgering a saga_steps row; the outer tx's later reverse pass then has
  // nothing to drive the child's reverse from, and the child's committedLocal
  // ctp-reserve row is stranded forever. Fix: give `drainScopeSubtree`'s
  // per-token loop a callActivity branch mirroring `retainCallStraggler`
  // (retain-only, no compensation — matches the function's own doc contract).
  it.skip("PROBE: inner-scope drainScopeSubtree cancels a running child, then the OUTER tx cancels — does the child's committed step reverse?", async () => {
    const childDraft = await createDraft(CALL_CHILD_TX_PARK_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(CALL_PARENT_SCOPEDRAIN_TX_CANCEL_BPMN, {
      correlationKey: "ca-probe-drain-then-cancel",
      variables: {},
    });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);

    // Outer tx's earlier compensable step, then the fork spawns call1's child
    // + the sibling concurrently.
    await drainSampleWorkers({ taskTypes: ["charge-card"], token });

    // Commit the child's OWN tx (a committedLocal ctp-reserve step), then it
    // parks forever (never drained) — it is genuinely still RUNNING.
    await drainSampleWorkers({ taskTypes: ["reserve-stock-park"], token });
    expect((await instRow(childId))?.status).toBe("waiting");
    expect(await sagaStepStatus(childId, "ctp-reserve")).toBe("committedLocal");

    // The sibling raises SIBLING_FAILED -> QSD's error boundary drains the
    // scope, cascade-cancelling the still-running child (Task 8 semantics).
    await drainSampleWorkers({ taskTypes: ["sibling-task"], token });
    expect((await instRow(childId))?.status).toBe("cancelled");

    // The scope-drain routes to qsd-handle -> a cancel end -> the OUTER tx's
    // own cancel boundary -> the reverse pass (qd-charge's comp: refund-card).
    await drainSampleWorkers({ taskTypes: ["log-only"], token });
    await drainSampleWorkers({ taskTypes: ["refund-card"], token, maxRounds: 20 });

    const parent = await instRow(parentId);
    expect(parent?.status).toBe("compensated");
    expect(parent?.current_element_id).toBe("qd-failed");

    // Does the OUTER reverse pass ever reach and compensate the child's own
    // committed step? (Desired: yes. If drainScopeSubtree never ledgered a
    // call1 step in the PARENT, the parent's reverse pass has nothing to
    // drive the child's reverse from, and the child's own ctp-reserve row
    // stays stranded at committedLocal forever.)
    expect(await sagaStepStatus(childId, "ctp-reserve")).toBe("compensated");
  });

  // -------------------------------------------------------------------------
  // PROBE (b) — Task 9 review concern #4: a parent whose ONLY compensable
  // content anywhere in the WHOLE graph is the callActivity visit (no
  // transaction/subProcess scope exists at all) is operator-cancelled AFTER
  // the child completed. `handleCancelInstance`'s `pending === 0` shortcut
  // reads `countCompensableSteps` over `subtreeScopeIds(graph, null)`, which
  // enumerates registered SCOPE containers only — a callActivity's ledger row
  // at root scope (`scope_id = ""`) is invisible to that filter when the
  // graph has zero scopes, so the shortcut fires and the reverse pass never
  // starts. Per the task brief: do NOT fix src/ here.
  // KNOWN GAP (M5-L2 follow-up): reproduced — `handleCancelInstance`'s
  // `pending === 0` shortcut counts via `countCompensableSteps(subtreeScopeIds
  // (graph, null), ...)`, and `subtreeScopeIds` enumerates registered SCOPE
  // containers (tx/subProcess) only; a graph with NO scopes at all yields `[]`,
  // so `selectSubtreeStepsForCompensation`'s `subtreeScopeIds.length === 0`
  // early-return makes the count 0 even though call1's saga_steps row (written
  // unconditionally by `applyChildTerminal`, scope_id="") genuinely has
  // compensation_status='pending'. The operator cancel takes the empty-ledger
  // shortcut and the child is never compensated. Fix: treat root scope ("")
  // as an implicit member of `subtreeScopeIds(graph, null)`, or special-case
  // callActivity rows the same way the empty-ledger check already special-
  // cases live cohort tokens.
  it.skip("PROBE: a parent whose ONLY compensable content is the callActivity visit, cancelled after the child completes — does the child reverse?", async () => {
    const childDraft = await createDraft(SIMPLE_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);
    const token = await mintWorkerToken();

    const { instance } = await publishAndStart(SIMPLE_PARENT_BPMN, { correlationKey: "ca-probe-emptyledger-cancel", variables: {} });
    const parentId = instance.body.instanceId as string;
    const childId = await childInstanceIdFor(parentId, "call1", 0);

    // Complete ONLY the child's sc-echo (a single lease, not a full drain —
    // p-after and sc-echo share the "echo" taskType). The child completes;
    // the parent's call1 applies (ledgering a 'pending' call1 saga step —
    // applyChildTerminal is "ALWAYS compensable", spec §5) and parks on its
    // OWN p-after task (still running/waiting, never driven further here).
    await leaseAndComplete(token, "echo", {});
    expect((await instRow(childId))?.status).toBe("completed");
    expect(await sagaStepStatus(parentId, "call1")).toBe("pending");

    const cancelled = await post(`/instances/${parentId}/cancel`, {});
    expect(cancelled.status).toBe(200);

    // Desired: a genuinely committed callActivity is always compensable, so
    // the cancel should enter 'compensating' and drive the child's reverse.
    // (If the empty-ledger shortcut fired instead, the parent went straight
    // to 'cancelled' and the child was never touched.)
    expect((await instRow(childId))?.status).toBe("compensated");
  });
});
