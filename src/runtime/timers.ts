// fireTimer — the JobScheduler alarm's timer dispatch target (M3-L3 design §4.3).
//
// Re-reads the canonical timer row + any `timer_outcomes` decision and NO-OPS
// whenever firing would be wrong (missing / already-settled / not-yet-due /
// terminal instance / the host wait already resolved). When all guards pass it
// commits the WINNING-FIRE batch — the PLAIN `timer_outcomes 'fired'` claim (the
// race decider), the bookkeeping flip, the job-abandon / subscription-supersede,
// the `timerFired` history, and the transition down the boundary path — ALL in one
// dbBatch, so a competing exit batch that claimed the decider first aborts this one
// WHOLESALE and the fire becomes a no-op (the gateway_decisions race contract).
//
// Like the JobScheduler DLQ (terminateUnleasableJob), the DO holds no
// authoritative state — D1 is canonical — so a late/duplicate/stray alarm against
// an already-decided (or progressed) timer is a safe idempotent no-op.

import type { Env } from "../env";
import type { ExecutionGraph } from "../bpmn/graph";
import { isTerminalInstanceStatus, isoIsBefore, nowIso } from "../util";
import { workflowJobEventTypeFor } from "../bpmn/profile";
import { dbBatch } from "../persistence/db";
import { getVersionGraph } from "../persistence/definitions";
import { historyStmt } from "../persistence/history";
import {
  applyTransitionStmt,
  getForwardJob,
  getInstanceRow,
  getSubscriptionForVisit,
  subscriptionSupersededStmt,
  type InstanceRow,
} from "../persistence/instances";
import { abandonJobOnTimerFireStmt } from "../persistence/jobs";
import {
  flipTimerFiredStmt,
  getTimer,
  getTimerOutcome,
  insertTimerOutcomeStmt,
  type TimerView,
} from "../persistence/timers";
import { getExecutor } from "./executor";
import { isUniqueConstraintViolation, supersedeBrokerSubscription } from "./boundary-timer";

/**
 * Settle a fired model timer (design §4.3). Re-reads D1 and NO-OPS unless every
 * fire precondition holds: the row exists and is still `armed`, no
 * `timer_outcomes` decision was recorded yet, `fire_at <= now`, and the instance
 * is non-terminal. Any of those failing is an idempotent no-op (a stray/late
 * alarm, a timer cancelled by an abnormal exit, an early/spurious alarm, or a
 * settled instance) — mirroring terminateUnleasableJob's re-check discipline.
 */
export async function fireTimer(env: Env, timerId: string): Promise<void> {
  const timer = await getTimer(env.DB, timerId);
  if (!timer) return; // missing → stray/late alarm for a never-armed or purged timer

  // Already settled: the bookkeeping status is non-`armed`, OR (the authoritative
  // check) a decider row exists. Either way the race is over — no-op. The decider
  // is read explicitly because it, not the status flip, is the source of truth
  // (the flip is bookkeeping; design §4.1/§4.3.3).
  if (timer.status !== "armed") return;
  if (await getTimerOutcome(env.DB, timerId)) return;

  // Not yet due (early/spurious alarm): fire_at strictly in the future.
  if (isoIsBefore(nowIso(), timer.fireAt)) return;

  // A settled instance never fires a timer (a fired timer is a modeled path, not
  // an incident, so it must not reanimate a terminal/cancelled/compensated run).
  const inst = await getInstanceRow(env.DB, timer.instanceId);
  if (!inst || isTerminalInstanceStatus(inst.status)) return;

  // Only interrupting boundary timers arm in this layer; intermediateCatch /
  // eventGateway timers land in L4 (TASK-45/46) and decide differently.
  if (timer.kind !== "boundary") return;

  await fireBoundaryTimer(env, timer, inst);
}

/**
 * The winning-fire batch for an interrupting boundary timer (design §4.3.3/4.3.5).
 * Resolves the host's live wait (service-task job OR receive-task subscription),
 * GUARDS that it is still the current wait, then commits the decider claim +
 * transition atomically and wakes the instance.
 */
async function fireBoundaryTimer(env: Env, timer: TimerView, inst: InstanceRow): Promise<void> {
  const graph: ExecutionGraph | null = await getVersionGraph(env.DB, inst.definition_version_id);
  if (!graph) return;
  const boundary = graph.nodes[timer.elementId];
  if (!boundary || boundary.type !== "boundaryEvent" || boundary.boundaryKind !== "timer") return;
  const hostId = boundary.attachedToRef;
  const next = boundary.next;
  if (!hostId || !next) return; // validator guarantees a host + one outgoing; defensive
  const host = graph.nodes[hostId];
  const occ = timer.occurrence;
  const instanceId = timer.instanceId;
  const workspaceId = inst.workspace_id;
  const now = nowIso();

  if (host?.type === "serviceTask") {
    const job = await getForwardJob(env.DB, instanceId, hostId, occ);
    // GUARD: the timer's visit must still be the live wait — a completed/failed
    // job means the worker already resolved it (completion won the race → no-op).
    if (!job || (job.status !== "created" && job.status !== "locked")) return;
    const workflowEventType = workflowJobEventTypeFor(job.job_id);
    try {
      await dbBatch(env.DB, [
        insertTimerOutcomeStmt(env.DB, { timerId: timer.timerId, outcome: "fired", now }), // THE CLAIM
        flipTimerFiredStmt(env.DB, { timerId: timer.timerId, firedAt: now, now }),
        abandonJobOnTimerFireStmt(env.DB, job.job_id, now), // created/locked → failed (late complete no-ops)
        historyStmt(env.DB, { workspaceId, instanceId, elementId: timer.elementId, type: "timerFired", diagnostics: { attachedToRef: hostId, jobId: job.job_id, occurrence: occ, boundaryTarget: next } }),
        applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
      ]);
    } catch (err) {
      if (isUniqueConstraintViolation(err)) return; // a competing exit claimed the decider first → no-op
      throw err;
    }
    await getExecutor(env).wakeTimer({ instanceId, workflowEventType, timerId: timer.timerId });
    return;
  }

  if (host?.type === "receiveTask") {
    const sub = await getSubscriptionForVisit(env.DB, instanceId, hostId, occ);
    // GUARD: the timer's visit must still be the live wait — a consumed/superseded
    // subscription means the message (or a prior fire) already resolved it.
    if (!sub || sub.status !== "active") return;
    const workflowEventType = sub.workflow_event_type;
    try {
      await dbBatch(env.DB, [
        insertTimerOutcomeStmt(env.DB, { timerId: timer.timerId, outcome: "fired", now }), // THE CLAIM
        flipTimerFiredStmt(env.DB, { timerId: timer.timerId, firedAt: now, now }),
        subscriptionSupersededStmt(env.DB, sub.subscription_id, now), // active → superseded
        historyStmt(env.DB, { workspaceId, instanceId, elementId: timer.elementId, type: "timerFired", diagnostics: { attachedToRef: hostId, subscriptionId: sub.subscription_id, occurrence: occ, boundaryTarget: next } }),
        applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
      ]);
    } catch (err) {
      if (isUniqueConstraintViolation(err)) return;
      throw err;
    }
    // Best-effort: drop the broker's active subscription so a late publish gets the
    // stable buffered/no-match outcome (preserves at-most-one-active-subscription).
    await supersedeBrokerSubscription(env, sub);
    await getExecutor(env).wakeTimer({ instanceId, workflowEventType, timerId: timer.timerId });
    return;
  }
}
