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
// statements, the shared winning-FIRE batch BUILDER (`planBoundaryTimerFire`),
// arming/cancelling the Scheduler DO, and the operator-cancel sweep. The builder is
// shared by the DO-alarm path (timers.ts `fireBoundaryTimer`, which commits then
// WAKES via the executor) and the Workflow-mode lost-alarm backstop wake path
// (`settleOverdueBoundaryTimerOnWake`, called from inside a drive, which RETURNS the
// next step — no executor). Keeping the builder HERE (this module never imports the
// executor) is what lets the wake path reuse the identical batch without the
// runtime/timers → executor → engine → forward-task import cycle.

import type { Env } from "../env";
import type { ExecutionGraph, GraphNode, TimerTriggerSpec } from "../bpmn/graph";
import { ONE_HOUR_MS, isTerminalInstanceStatus, isoIsBefore, nowIso } from "../util";
import { workflowJobEventTypeFor } from "../bpmn/profile";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import {
  applyTransitionStmt,
  getForwardJob,
  getInstanceRow,
  getSubscriptionForVisit,
  subscriptionSupersededStmt,
  type InstanceRow,
  type SubscriptionRow,
} from "../persistence/instances";
import { abandonJobOnTimerFireStmt } from "../persistence/jobs";
import { brokerKeyOf } from "./broker-types";
import { computeFireAt } from "./iso8601";
import {
  flipTimerCancelledStmt,
  flipTimerFiredStmt,
  getTimer,
  getTimerOutcome,
  insertTimerArmedStmt,
  insertTimerOutcomeStmt,
  listTimersForInstance,
  timerIdFor,
  type TimerView,
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
 *
 * An `eventGateway` timer decides on `gateway_decisions`, NOT `timer_outcomes`
 * (design §4.5), so the sweep settles it with the bookkeeping flip + history ONLY —
 * writing a `timer_outcomes` row would falsify the "EBG timer has no decider row"
 * invariant. A stray post-cancel alarm still no-ops: fireTimer guards on
 * status!='armed' (this flip) and the terminal instance, and planEventGatewayTimerFire
 * guards on the cursor having moved off the gateway.
 */
export async function cancelArmedTimersForInstance(env: Env, instanceId: string): Promise<void> {
  const inst = await getInstanceRow(env.DB, instanceId);
  if (!inst) return;
  const timers = await listTimersForInstance(env.DB, instanceId);
  for (const t of timers) {
    if (t.status !== "armed") continue;
    const now = nowIso();
    if (t.kind === "eventGateway") {
      await dbBatch(env.DB, [
        flipTimerCancelledStmt(env.DB, { timerId: t.timerId, now }),
        historyStmt(env.DB, {
          workspaceId: inst.workspace_id,
          instanceId,
          elementId: t.elementId,
          type: "timerCancelled",
          diagnostics: { kind: "eventGateway", gateway: t.gatewayId, occurrence: t.occurrence, reason: "operator cancel" },
        }),
      ]);
      continue;
    }
    if (await getTimerOutcome(env.DB, t.timerId)) continue;
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
 * Workflow-mode waitForEvent timeout SIZED to one timer (design §4.2):
 * `max(SVC_WAIT_TIMEOUT, fire_at − now + slack)` so a long timer costs O(1) steps
 * and the sized timeout doubles as the lost-alarm backstop. The shared piece,
 * keyed by raw `timerId`, reused by the boundary wait (`timerGuardedTimeout`) and
 * the intermediate-catch wait (intermediate-timer.ts). Workflow-mode-only.
 */
export async function timerSizedTimeout(env: Env, timerId: string): Promise<string> {
  const trow = await getTimer(env.DB, timerId);
  const fireAtMs = trow ? new Date(trow.fireAt).getTime() : Date.now();
  const untilMs = Math.max(ONE_HOUR_MS, fireAtMs - Date.now() + 5000);
  return `${Math.ceil(untilMs / 1000)} seconds`;
}

/** Boundary-wait variant of {@link timerSizedTimeout} (host activity + occurrence). */
export async function timerGuardedTimeout(env: Env, instanceId: string, tb: TimerBoundary, occ: number): Promise<string> {
  return timerSizedTimeout(env, timerIdFor(instanceId, tb.boundaryId, occ));
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

/** The Workflow-mode wake target for a fired boundary timer (the wait's `sendEvent` type). */
export interface TimerWake {
  instanceId: string;
  workflowEventType: string;
  timerId: string;
}

/**
 * The WINNING-FIRE plan for an interrupting boundary timer (design §4.3.3/4.3.5) —
 * the SHARED batch builder. Resolves the host's live wait (service-task job OR
 * receive-task subscription), GUARDS that it is still the current wait, and composes
 * the IDENTICAL fire batch both fire paths commit: the PLAIN `timer_outcomes 'fired'`
 * claim (the race decider) + the bookkeeping flip + the job-abandon / subscription-
 * supersede + the `timerFired` history + the transition down the boundary path. It
 * does NOT commit or wake — the caller does, and ONLY the wake differs:
 *   - timers.ts `fireBoundaryTimer` (DO-alarm path): commit → executor `wakeTimer`;
 *   - `settleOverdueBoundaryTimerOnWake` (Workflow-mode backstop): commit → RETURN
 *     the next step to the drive loop (no executor — avoids the import cycle).
 * Returns `kind:"skip"` when the host wait already resolved (completion won the race
 * → the timer must NOT fire), mirroring `fireBoundaryTimer`'s old guards.
 */
export type BoundaryFirePlan =
  | { kind: "fire"; stmts: D1PreparedStatement[]; next: string; wake: TimerWake; brokerSub?: SubscriptionRow }
  | { kind: "skip" };

export async function planBoundaryTimerFire(
  env: Env,
  graph: ExecutionGraph,
  timer: TimerView,
  inst: InstanceRow,
): Promise<BoundaryFirePlan> {
  const boundary = graph.nodes[timer.elementId];
  if (!boundary || boundary.type !== "boundaryEvent" || boundary.boundaryKind !== "timer") return { kind: "skip" };
  const hostId = boundary.attachedToRef;
  const next = boundary.next;
  if (!hostId || !next) return { kind: "skip" }; // validator guarantees a host + one outgoing; defensive
  const host = graph.nodes[hostId];
  const occ = timer.occurrence;
  const instanceId = timer.instanceId;
  const workspaceId = inst.workspace_id;
  const now = nowIso();

  if (host?.type === "serviceTask") {
    const job = await getForwardJob(env.DB, instanceId, hostId, occ);
    // GUARD: the timer's visit must still be the live wait — a completed/failed
    // job means the worker already resolved it (completion won the race → skip).
    if (!job || (job.status !== "created" && job.status !== "locked")) return { kind: "skip" };
    return {
      kind: "fire",
      next,
      wake: { instanceId, workflowEventType: workflowJobEventTypeFor(job.job_id), timerId: timer.timerId },
      stmts: [
        insertTimerOutcomeStmt(env.DB, { timerId: timer.timerId, outcome: "fired", now }), // THE CLAIM
        flipTimerFiredStmt(env.DB, { timerId: timer.timerId, firedAt: now, now }),
        abandonJobOnTimerFireStmt(env.DB, job.job_id, now), // created/locked → failed (late complete no-ops)
        historyStmt(env.DB, { workspaceId, instanceId, elementId: timer.elementId, type: "timerFired", diagnostics: { attachedToRef: hostId, jobId: job.job_id, occurrence: occ, boundaryTarget: next } }),
        applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
      ],
    };
  }

  if (host?.type === "receiveTask") {
    const sub = await getSubscriptionForVisit(env.DB, instanceId, hostId, occ);
    // GUARD: the timer's visit must still be the live wait — a consumed/superseded
    // subscription means the message (or a prior fire) already resolved it.
    if (!sub || sub.status !== "active") return { kind: "skip" };
    return {
      kind: "fire",
      next,
      wake: { instanceId, workflowEventType: sub.workflow_event_type, timerId: timer.timerId },
      brokerSub: sub,
      stmts: [
        insertTimerOutcomeStmt(env.DB, { timerId: timer.timerId, outcome: "fired", now }), // THE CLAIM
        flipTimerFiredStmt(env.DB, { timerId: timer.timerId, firedAt: now, now }),
        subscriptionSupersededStmt(env.DB, sub.subscription_id, now), // active → superseded
        historyStmt(env.DB, { workspaceId, instanceId, elementId: timer.elementId, type: "timerFired", diagnostics: { attachedToRef: hostId, subscriptionId: sub.subscription_id, occurrence: occ, boundaryTarget: next } }),
        applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
      ],
    };
  }

  return { kind: "skip" };
}

/**
 * Outcome of the Workflow-mode lost-alarm backstop settle:
 *   - `fired`        the overdue timer was settled inline (or a concurrent real
 *                    alarm already fired/won) → take the boundary path;
 *   - `reparked`     still armed but NOT yet due (a genuine early/spurious wake) →
 *                    the DO was re-armed (self-heal); the caller re-parks;
 *   - `fallThrough`  the timer was already decided `cancelled` (a concurrent normal
 *                    resolution), the row is gone, or the host wait already resolved
 *                    → the caller re-reads and runs its normal completed/failed/
 *                    applied (service) or consumed (receive) handling.
 */
export type WakeSettleOutcome =
  | { kind: "fired"; next: string }
  | { kind: "reparked" }
  | { kind: "fallThrough" };

/**
 * Lost-alarm backstop (design §4.2 "the timeout … doubles as the lost-alarm
 * backstop: on any wake the engine re-reads D1 and settles overdue timers
 * (fire_at <= now) exactly as the alarm path would"; risk R5). Invoked from the
 * TIMEOUT-wake branch of a timer-guarded wait (forward-task.ts / engine.ts), i.e.
 * we are ALREADY inside a drive — so when the timer is overdue we settle the fire
 * INLINE (the IDENTICAL `planBoundaryTimerFire` batch the alarm path commits) and
 * RETURN the boundary path to the drive loop instead of calling the executor wake.
 * That is what avoids the runtime/timers → executor → engine → forward-task import
 * cycle the implementer hit (this module never imports the executor).
 *
 * Workflow-mode-only: CI forces EXECUTION_MODE=direct, where `waitFor` is null and a
 * wait never times out, so this path never runs under the suite. It is verified by
 * reading, mirroring the M1/M2 manually-verified Workflow-mode lists (design §7).
 *
 * Decision logic (design §4.2):
 *   1. decided already → `fired` → boundary path; `cancelled` → fall through.
 *   2. armed AND overdue (`fire_at <= now`) → settle the fire INLINE; on a decider
 *      PK conflict (a concurrent REAL alarm claimed it) convert to the recorded
 *      outcome via `convertOnFire` (no double-advance).
 *   3. armed but NOT yet due (`fire_at > now`) → idempotently re-arm the DO
 *      (self-heal) and re-park.
 */
export async function settleOverdueBoundaryTimerOnWake(
  env: Env,
  graph: ExecutionGraph,
  instanceId: string,
  hostElementId: string,
  occ: number,
): Promise<WakeSettleOutcome> {
  const tb = timerBoundaryFor(graph, hostElementId);
  if (!tb) return { kind: "fallThrough" }; // no timer boundary → caller handles normally
  const timerId = timerIdFor(instanceId, tb.boundaryId, occ);

  // (1) Already decided → convert: fired → boundary path; cancelled → fall through.
  const decided = await getTimerOutcome(env.DB, timerId);
  if (decided?.outcome === "fired") return tb.node.next ? { kind: "fired", next: tb.node.next } : { kind: "fallThrough" };
  if (decided?.outcome === "cancelled") return { kind: "fallThrough" };

  const trow = await getTimer(env.DB, timerId);
  if (!trow || trow.status !== "armed") return { kind: "fallThrough" }; // settled/missing → re-read

  // (3) Still armed but NOT yet due (a genuine early/spurious wake): re-arm + re-park.
  if (isoIsBefore(nowIso(), trow.fireAt)) {
    await armTimerDO(env, trow.timerId, trow.fireAt);
    return { kind: "reparked" };
  }

  // A settled instance never fires a timer (mirrors fireTimer's guard) — should not
  // happen mid-drive, but a concurrent /cancel could have terminated it.
  const inst = await getInstanceRow(env.DB, instanceId);
  if (!inst || isTerminalInstanceStatus(inst.status)) return { kind: "fallThrough" };

  // (2) Armed AND overdue: settle the fire INLINE — the IDENTICAL batch the alarm
  // path commits — then RETURN the boundary path (no executor wake → no cycle).
  const plan = await planBoundaryTimerFire(env, graph, trow, inst);
  if (plan.kind !== "fire") return { kind: "fallThrough" }; // host wait already resolved → re-read
  try {
    await dbBatch(env.DB, plan.stmts);
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      // A concurrent REAL alarm claimed the decider first → convert to the recorded
      // outcome (never double-advance), reusing the existing conflict helper.
      const converted = await convertOnFire(env, graph, instanceId, hostElementId, occ);
      if (converted) return { kind: "fired", next: converted };
      return { kind: "fallThrough" }; // cancelled won the conflict → re-read
    }
    throw err;
  }
  // Receive-task fire: drop the broker's active subscription so a late publish gets
  // the stable buffered/no-match outcome (at-most-one-active-subscription invariant).
  if (plan.brokerSub) await supersedeBrokerSubscription(env, plan.brokerSub);
  return { kind: "fired", next: plan.next };
}
