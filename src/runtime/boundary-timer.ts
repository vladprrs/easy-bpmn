// Interrupting boundary-timer runtime helpers (M3-L3, TASK-44, design §4.3).
//
// A boundary timer guards ONE host-activity visit (a serviceTask or receiveTask).
// Its race decider is the `timer_outcomes` row, claimed by a PLAIN INSERT in the
// SAME dbBatch as the loser-visible transition (the gateway_decisions contract):
//   * the host's NORMAL resolution (completion / business-error route / message
//     apply) composes the `cancelled` claim into its transition batch;
//   * `fireTimer` composes the `fired` claim into its fire batch (timers.ts);
//   * the abnormal exits (retry exhaustion → Hazard, operator /cancel) settle the
//     `cancelled` claim in their own batch.
// A conflicting batch ABORTS WHOLESALE on the PK violation; the loser re-reads and
// converts to the recorded outcome (never double-advances).
//
// This module owns: finding the timer boundary, composing the arm + cancel-settle
// statements, arming/cancelling the Scheduler DO, and the operator-cancel sweep.
// The winning-FIRE batch lives in timers.ts (it needs the host job/subscription).

import type { Env } from "../env";
import type { ExecutionGraph, GraphNode, TimerTriggerSpec } from "../bpmn/graph";
import { ONE_HOUR_MS, nowIso } from "../util";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import { getInstanceRow, type SubscriptionRow } from "../persistence/instances";
import { brokerKeyOf } from "./broker-types";
import { computeFireAt } from "./iso8601";
import {
  flipTimerCancelledStmt,
  getTimer,
  getTimerOutcome,
  insertTimerArmedStmt,
  insertTimerOutcomeStmt,
  listTimersForInstance,
  timerIdFor,
} from "../persistence/timers";

export interface TimerBoundary {
  boundaryId: string;
  /** The boundary-event node (carries `.next` = the timer path, `.timerTrigger`). */
  node: GraphNode;
  trigger: TimerTriggerSpec;
}

/** A unique-constraint violation (the decider race aborted the loser's batch). */
export function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE/i.test(err.message);
}

/**
 * The (at most one) interrupting timer boundary attached to `hostElementId`, or
 * null. The validator enforces at-most-one + a parseable trigger, so the first
 * match with a trigger is THE timer boundary.
 */
export function timerBoundaryFor(graph: ExecutionGraph, hostElementId: string): TimerBoundary | null {
  for (const [boundaryId, node] of Object.entries(graph.nodes)) {
    if (
      node.type === "boundaryEvent" &&
      node.boundaryKind === "timer" &&
      node.attachedToRef === hostElementId &&
      node.timerTrigger
    ) {
      return { boundaryId, node, trigger: node.timerTrigger };
    }
  }
  return null;
}

interface VisitCtx {
  instanceId: string;
  workspaceId: string;
  hostElementId: string;
  occ: number;
  now: string;
}

/**
 * Arm statements to splice into the host's FIRST-arm visit batch (job `svc-create`
 * / subscription registration): an `INSERT OR IGNORE` timer row + a `timerArmed`
 * history. Returns the timerId + computed `fire_at` so the caller arms the DO
 * after the batch commits. null when the host carries no timer boundary.
 */
export function buildBoundaryArm(
  graph: ExecutionGraph,
  env: Env,
  ctx: VisitCtx,
): { stmts: D1PreparedStatement[]; timerId: string; fireAt: string; boundary: TimerBoundary } | null {
  const tb = timerBoundaryFor(graph, ctx.hostElementId);
  if (!tb) return null;
  const timerId = timerIdFor(ctx.instanceId, tb.boundaryId, ctx.occ);
  const fireAt = computeFireAt(tb.trigger, ctx.now);
  return {
    boundary: tb,
    timerId,
    fireAt,
    stmts: [
      insertTimerArmedStmt(env.DB, {
        timerId,
        instanceId: ctx.instanceId,
        elementId: tb.boundaryId,
        occurrence: ctx.occ,
        kind: "boundary",
        attachedToRef: ctx.hostElementId,
        fireAt,
        now: ctx.now,
      }),
      historyStmt(env.DB, {
        workspaceId: ctx.workspaceId,
        instanceId: ctx.instanceId,
        elementId: tb.boundaryId,
        type: "timerArmed",
        diagnostics: { attachedToRef: ctx.hostElementId, fireAt, occurrence: ctx.occ, trigger: tb.trigger },
      }),
    ],
  };
}

/** Idempotent best-effort DO arm (keyed `timer:<timerId>`), non-fatal like the DLQ arm. */
export async function armTimerDO(env: Env, timerId: string, fireAt: string): Promise<void> {
  try {
    const stub = env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`timer:${timerId}`));
    await stub.armTimer(timerId, fireAt);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "warn", message: "armTimer (boundary) failed", timerId, error: err instanceof Error ? err.message : String(err) }),
    );
  }
}

/**
 * Cancel-settle statements to compose ATOMICALLY into a host's normal-resolution
 * batch (completion / business-error route / message apply): the PLAIN
 * `timer_outcomes 'cancelled'` claim (the decider) + the bookkeeping flip + a
 * `timerCancelled` history. The caller must wrap its dbBatch and, on a
 * unique-constraint abort (the timer FIRED first), re-read and convert to the
 * boundary path via `convertOnFire`. null when the host carries no timer boundary.
 */
export function buildBoundaryCancelSettle(
  graph: ExecutionGraph,
  env: Env,
  ctx: VisitCtx,
): { stmts: D1PreparedStatement[]; boundary: TimerBoundary; timerId: string } | null {
  const tb = timerBoundaryFor(graph, ctx.hostElementId);
  if (!tb) return null;
  const timerId = timerIdFor(ctx.instanceId, tb.boundaryId, ctx.occ);
  return {
    boundary: tb,
    timerId,
    stmts: [
      insertTimerOutcomeStmt(env.DB, { timerId, outcome: "cancelled", now: ctx.now }),
      flipTimerCancelledStmt(env.DB, { timerId, now: ctx.now }),
      historyStmt(env.DB, {
        workspaceId: ctx.workspaceId,
        instanceId: ctx.instanceId,
        elementId: tb.boundaryId,
        type: "timerCancelled",
        diagnostics: { attachedToRef: ctx.hostElementId, occurrence: ctx.occ, reason: "host resolved" },
      }),
    ],
  };
}

/**
 * After a host's normal-resolution batch aborted on the decider PK (the timer
 * fired first), re-read the outcome and return the boundary path to CONVERT to,
 * or null if the conflict was something else / the timer did not actually fire.
 */
export async function convertOnFire(
  env: Env,
  graph: ExecutionGraph,
  instanceId: string,
  hostElementId: string,
  occ: number,
): Promise<string | null> {
  const tb = timerBoundaryFor(graph, hostElementId);
  if (!tb) return null;
  const outcome = await getTimerOutcome(env.DB, timerIdFor(instanceId, tb.boundaryId, occ));
  return outcome?.outcome === "fired" ? tb.node.next ?? null : null;
}

/**
 * Settle a host's timer boundary 'cancelled' in its OWN batch (the retry-exhaustion
 * → Hazard path, which terminates via a separate createIncident batch). Returns:
 *   - "noTimer"            no timer boundary on this host → proceed normally;
 *   - "settled"            cancelled (or already cancelled) → proceed with the exit;
 *   - { converted: next }  the timer FIRED first → take the boundary path instead.
 */
export async function settleBoundaryTimerCancel(
  env: Env,
  graph: ExecutionGraph,
  instanceId: string,
  workspaceId: string,
  hostElementId: string,
  occ: number,
): Promise<"noTimer" | "settled" | { converted: string }> {
  const tb = timerBoundaryFor(graph, hostElementId);
  if (!tb) return "noTimer";
  const timerId = timerIdFor(instanceId, tb.boundaryId, occ);
  const prior = await getTimerOutcome(env.DB, timerId);
  if (prior?.outcome === "fired") return tb.node.next ? { converted: tb.node.next } : "settled";
  if (prior?.outcome === "cancelled") return "settled";
  const now = nowIso();
  try {
    await dbBatch(env.DB, [
      insertTimerOutcomeStmt(env.DB, { timerId, outcome: "cancelled", now }),
      flipTimerCancelledStmt(env.DB, { timerId, now }),
      historyStmt(env.DB, {
        workspaceId,
        instanceId,
        elementId: tb.boundaryId,
        type: "timerCancelled",
        diagnostics: { attachedToRef: hostElementId, occurrence: occ, reason: "host failed" },
      }),
    ]);
    return "settled";
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const fired = await getTimerOutcome(env.DB, timerId);
      if (fired?.outcome === "fired" && tb.node.next) return { converted: tb.node.next };
      return "settled";
    }
    throw err;
  }
}

/**
 * Operator /cancel sweep (design §4.3.2 exit d): settle EVERY still-armed timer of
 * the instance 'cancelled', each in its own batch, so a stray alarm afterwards is a
 * decided no-op — no mid-compensation firing (gate 10). Best-effort: a timer that
 * fired in the cancel window loses the decider INSERT and is left as-is.
 */
export async function cancelArmedTimersForInstance(env: Env, instanceId: string): Promise<void> {
  const inst = await getInstanceRow(env.DB, instanceId);
  if (!inst) return;
  const timers = await listTimersForInstance(env.DB, instanceId);
  for (const t of timers) {
    if (t.status !== "armed") continue;
    if (await getTimerOutcome(env.DB, t.timerId)) continue;
    const now = nowIso();
    try {
      await dbBatch(env.DB, [
        insertTimerOutcomeStmt(env.DB, { timerId: t.timerId, outcome: "cancelled", now }),
        flipTimerCancelledStmt(env.DB, { timerId: t.timerId, now }),
        historyStmt(env.DB, {
          workspaceId: inst.workspace_id,
          instanceId,
          elementId: t.elementId,
          type: "timerCancelled",
          diagnostics: { attachedToRef: t.attachedToRef, occurrence: t.occurrence, reason: "operator cancel" },
        }),
      ]);
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
      // The timer fired in the cancel window — leave its 'fired' outcome.
    }
  }
}

/** True iff the guarding boundary timer's decider is `fired` (the true/timeout-path resolver). */
export async function timerHasFired(env: Env, instanceId: string, tb: TimerBoundary, occ: number): Promise<boolean> {
  const outcome = await getTimerOutcome(env.DB, timerIdFor(instanceId, tb.boundaryId, occ));
  return outcome?.outcome === "fired";
}

/**
 * Workflow-mode waitForEvent timeout for a timer-guarded wait (design §4.2):
 * `max(SVC_WAIT_TIMEOUT, fire_at − now + slack)` so a long timer costs O(1) steps
 * and the sized timeout doubles as the lost-alarm backstop. Workflow-mode-only.
 */
export async function timerGuardedTimeout(env: Env, instanceId: string, tb: TimerBoundary, occ: number): Promise<string> {
  const trow = await getTimer(env.DB, timerIdFor(instanceId, tb.boundaryId, occ));
  const fireAtMs = trow ? new Date(trow.fireAt).getTime() : Date.now();
  const untilMs = Math.max(ONE_HOUR_MS, fireAtMs - Date.now() + 5000);
  return `${Math.ceil(untilMs / 1000)} seconds`;
}

/** Best-effort broker supersede for a receive-task boundary fire (mirrors registerReceive's broker call). */
export async function supersedeBrokerSubscription(env: Env, sub: SubscriptionRow): Promise<void> {
  try {
    const brokerKey = sub.broker_key || brokerKeyOf(sub.workspace_id, sub.message_name, sub.correlation_key);
    const broker = env.CORRELATION_BROKER.get(env.CORRELATION_BROKER.idFromName(brokerKey));
    await broker.supersedeSubscription(sub.instance_id, sub.element_id);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "warn", message: "supersedeSubscription failed", subscriptionId: sub.subscription_id, error: err instanceof Error ? err.message : String(err) }),
    );
  }
}
