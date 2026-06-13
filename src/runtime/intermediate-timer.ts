// Intermediate timer catch — a delay step on the token path (M3-L4, TASK-45,
// design §4.4).
//
// Unlike a boundary timer (which is host-referenced and never walked), a
// `intermediateCatchEvent` + `timerEventDefinition` IS a token-path node: it gets
// its OWN engine dispatch case and its OWN visit occurrence. The catch IS the
// wait — there is no host job/subscription to abandon or supersede.
//
// Lifecycle:
//   * Park batch (persist-before-advance): timer row (INSERT OR IGNORE, kind
//     `intermediateCatch`) + `timerArmed` history (FIRST ARM ONLY) + park; then
//     arm the Scheduler DO keyed `timer:<timerId>` (the boundary path's DO arm).
//   * Fire batch (timers.ts `fireIntermediateCatchTimer` via the DO alarm): ONE
//     batch = `timer_outcomes 'fired'` claim (PLAIN INSERT — the race decider) +
//     bookkeeping flip + `timerFired` history + the transition along the single
//     outgoing flow. A competing /cancel settlement aborts the loser WHOLESALE on
//     the decider PK (the gateway_decisions contract); the loser converts/no-ops.
//   * Operator /cancel settles the armed catch via the SHARED
//     `cancelArmedTimersForInstance` sweep (boundary-timer.ts), which already
//     covers EVERY armed timer of an instance regardless of kind.
//
// This module owns: the engine dispatch (`driveIntermediateCatch`), the shared
// winning-FIRE batch BUILDER (`planIntermediateCatchFire`), and the Workflow-mode
// lost-alarm backstop (`settleOverdueIntermediateCatchOnWake`). Like
// boundary-timer.ts, it NEVER imports the executor, so the backstop reuses the
// identical fire batch without the runtime/timers → executor → engine cycle.

import type { Env } from "../env";
import type { ExecutionGraph, GraphNode } from "../bpmn/graph";
import { isTerminalInstanceStatus, isoIsBefore, nowIso } from "../util";
import { workflowTimerEventTypeFor } from "../bpmn/profile";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import { applyTransitionStmt, getInstanceRow, type InstanceRow } from "../persistence/instances";
import {
  flipTimerFiredStmt,
  getTimer,
  getTimerOutcome,
  insertTimerArmedStmt,
  insertTimerOutcomeStmt,
  timerIdFor,
  type TimerView,
} from "../persistence/timers";
import { computeFireAt } from "./iso8601";
import {
  armTimerDO,
  isUniqueConstraintViolation,
  timerSizedTimeout,
  type TimerWake,
  type WakeSettleOutcome,
} from "./boundary-timer";
import { loadInst, type RunStep, type WaitForEvent } from "./engine-shared";

export type CatchOutcome = { kind: "next"; next: string } | { kind: "waiting" };

/** True iff this catch visit's timer decider is `fired` (the write-free fast-forward predicate). */
async function catchTimerFired(env: Env, instanceId: string, elementId: string, occ: number): Promise<boolean> {
  const outcome = await getTimerOutcome(env.DB, timerIdFor(instanceId, elementId, occ));
  return outcome?.outcome === "fired";
}

/**
 * Drive one intermediate timer catch visit (`timer:el#occ`). Mirrors the
 * receive-task wait, minus the broker:
 *   1. Fired fast-forward (rewalk, write-free): the fire batch already advanced
 *      the token down the single outgoing flow — pure cursor move to `node.next`.
 *   2. First visit → arm + park (persist-before-advance), then arm the DO.
 *      A rewalk landing on a still-`armed` catch re-arms the DO idempotently
 *      (self-heal, design §4.2) and re-parks.
 *   3. Direct mode parks (the DO alarm resumes inline via fireTimer). Workflow
 *      mode waits on the per-visit event type, SIZED to the timer (§4.2), with
 *      the lost-alarm backstop settling overdue on a timeout wake.
 */
export async function driveIntermediateCatch(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
): Promise<CatchOutcome> {
  const tag = `${elementId}#${occ}`;
  const next = node.next!;
  const timerId = timerIdFor(instanceId, elementId, occ);

  // (1) Fired fast-forward — write-free cursor move.
  if (await catchTimerFired(env, instanceId, elementId, occ)) return { kind: "next", next };

  // (2) Arm + park (first visit) or self-heal re-arm (rewalk past an armed catch).
  const existing = await getTimer(env.DB, timerId);
  if (!existing) {
    await runStep(`timer:${tag}`, () => parkIntermediateCatch(env, instanceId, elementId, occ, node));
  } else if (existing.status === "armed") {
    await armTimerDO(env, existing.timerId, existing.fireAt);
  }

  // (3a) Direct mode: park; the instance resumes when the timer alarm fires.
  if (!waitFor) return { kind: "waiting" };

  // (3b) Workflow mode: wait on the per-visit event type, sized to the timer.
  const timeout = await timerSizedTimeout(env, timerId);
  const outcome = await waitFor({
    name: `timer-wait:${tag}`,
    workflowEventType: workflowTimerEventTypeFor(elementId, occ),
    timeout,
  });
  // The timer may have fired (its sendEvent wake, or a concurrent alarm) while we waited.
  if (await catchTimerFired(env, instanceId, elementId, occ)) return { kind: "next", next };
  if (outcome.kind === "timeout") {
    // Lost-alarm backstop (design §4.2, risk R5): a timer-guarded wait NEVER
    // raises waitTimeout. The DO alarm is the PRIMARY firing mechanism; this
    // timer-SIZED timeout doubles as the backstop for a lost/failed alarm —
    // settle an OVERDUE catch INLINE (the IDENTICAL fire batch the alarm path
    // commits), RETURNING the outgoing flow to THIS drive loop (no executor wake
    // → no import cycle). Workflow-mode-only (CI forces direct, where waitFor is
    // null and a wait never times out — verified by reading + the direct-mode
    // backstop seam test).
    const settled = await settleOverdueIntermediateCatchOnWake(env, graph, instanceId, elementId, occ);
    if (settled.kind === "fired") return { kind: "next", next: settled.next };
    if (settled.kind === "reparked") return { kind: "waiting" }; // armed-but-early → re-armed; re-park
    // fallThrough: already decided `cancelled` (a concurrent operator /cancel) or
    // the row vanished — re-read; advance only if it actually fired meanwhile.
    if (await catchTimerFired(env, instanceId, elementId, occ)) return { kind: "next", next };
    return { kind: "waiting" }; // still parked (e.g. a concurrent /cancel terminal) — re-park
  }
  // Woke on the timerFired event but the decider is not visible yet (should not
  // happen — fireTimer commits the decider before waking) — re-park defensively.
  return { kind: "waiting" };
}

/**
 * The park batch (design §4.4): timer row (`INSERT OR IGNORE`, kind
 * `intermediateCatch`, occurrence = the CATCH'S OWN visit occurrence) +
 * `timerArmed` history (first arm only) + park, then arm the DO after commit.
 * Re-reads the timer row first so a Workflow step retry after the batch committed
 * is a write-free re-arm (no duplicate `timerArmed`, no cursor rewrite).
 */
async function parkIntermediateCatch(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  node: GraphNode,
): Promise<void> {
  const timerId = timerIdFor(instanceId, elementId, occ);
  const existing = await getTimer(env.DB, timerId);
  if (existing) {
    // Already armed (step retry after commit) → re-arm the DO and return write-free.
    if (existing.status === "armed") await armTimerDO(env, existing.timerId, existing.fireAt);
    return;
  }
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const fireAt = computeFireAt(node.timerTrigger!, now);
  await dbBatch(env.DB, [
    insertTimerArmedStmt(env.DB, {
      timerId,
      instanceId,
      elementId,
      occurrence: occ,
      kind: "intermediateCatch",
      fireAt,
      now,
    }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "timerArmed",
      diagnostics: { kind: "intermediateCatch", fireAt, occurrence: occ, trigger: node.timerTrigger },
    }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now }),
  ]);
  await armTimerDO(env, timerId, fireAt);
}

/**
 * The WINNING-FIRE plan for an intermediate timer catch (design §4.4) — the
 * SHARED batch builder, reused by the DO-alarm fire path (timers.ts) and the
 * Workflow-mode backstop below. There is NO host job/subscription to abandon —
 * the catch IS the wait — so the batch is just the decider claim + flip +
 * `timerFired` history + the transition down the single outgoing flow.
 *
 * GUARD ("the catch's visit is still the current park", design §4.4): the
 * instance's `current_element_id` must still be this catch. fireTimer's generic
 * guards (non-terminal instance, row armed, no decider, fire_at <= now) run
 * first; this adds the parked-here check so a progressed instance never fires.
 * Returns `kind:"skip"` otherwise.
 */
export type CatchFirePlan =
  | { kind: "fire"; stmts: D1PreparedStatement[]; next: string; wake: TimerWake }
  | { kind: "skip" };

export async function planIntermediateCatchFire(
  env: Env,
  graph: ExecutionGraph,
  timer: TimerView,
  inst: InstanceRow,
): Promise<CatchFirePlan> {
  const node = graph.nodes[timer.elementId];
  if (!node || node.type !== "intermediateCatchEvent") return { kind: "skip" };
  const next = node.next;
  if (!next) return { kind: "skip" }; // validator guarantees exactly one outgoing; defensive
  // Per-token guard (M4, design §5.3): fire iff this catch visit is still the live
  // wait — i.e. no timer_outcomes decider claimed it yet. NEVER read the scalar
  // current_element_id (a concurrent sibling token may have moved it). A catch can
  // only exit via fire ('fired') or operator /cancel ('cancelled'), so a settled
  // decider ⇔ the visit already resolved.
  if (await getTimerOutcome(env.DB, timer.timerId)) return { kind: "skip" };

  const occ = timer.occurrence;
  const instanceId = timer.instanceId;
  const workspaceId = inst.workspace_id;
  const now = nowIso();
  return {
    kind: "fire",
    next,
    wake: { instanceId, workflowEventType: workflowTimerEventTypeFor(timer.elementId, occ), timerId: timer.timerId },
    stmts: [
      insertTimerOutcomeStmt(env.DB, { timerId: timer.timerId, outcome: "fired", now }), // THE CLAIM
      flipTimerFiredStmt(env.DB, { timerId: timer.timerId, firedAt: now, now }),
      historyStmt(env.DB, {
        workspaceId,
        instanceId,
        elementId: timer.elementId,
        type: "timerFired",
        diagnostics: { kind: "intermediateCatch", occurrence: occ, catchTarget: next },
      }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
    ],
  };
}

/**
 * Lost-alarm backstop for an intermediate timer catch (design §4.2, risk R5) —
 * the catch analogue of `settleOverdueBoundaryTimerOnWake`. Invoked from the
 * TIMEOUT-wake branch of `driveIntermediateCatch` (already inside a drive), so an
 * overdue catch is settled INLINE (the IDENTICAL `planIntermediateCatchFire`
 * batch the alarm path commits) and the outgoing flow is RETURNED to the drive
 * loop instead of waking via the executor (no import cycle).
 *
 *   1. decided already → `fired` → outgoing flow; `cancelled` → fall through.
 *   2. armed AND overdue (`fire_at <= now`) → settle the fire INLINE; on a
 *      decider PK conflict (a concurrent REAL alarm claimed it) re-read and
 *      convert (never double-advance).
 *   3. armed but NOT yet due → idempotently re-arm the DO (self-heal) and re-park.
 */
export async function settleOverdueIntermediateCatchOnWake(
  env: Env,
  graph: ExecutionGraph,
  instanceId: string,
  elementId: string,
  occ: number,
): Promise<WakeSettleOutcome> {
  const node = graph.nodes[elementId];
  const next = node?.next ?? null;
  const timerId = timerIdFor(instanceId, elementId, occ);

  // (1) Already decided → convert: fired → outgoing flow; cancelled → fall through.
  const decided = await getTimerOutcome(env.DB, timerId);
  if (decided?.outcome === "fired") return next ? { kind: "fired", next } : { kind: "fallThrough" };
  if (decided?.outcome === "cancelled") return { kind: "fallThrough" };

  const trow = await getTimer(env.DB, timerId);
  if (!trow || trow.status !== "armed") return { kind: "fallThrough" }; // settled/missing → re-read

  // (3) Still armed but NOT yet due (early/spurious wake): re-arm + re-park.
  if (isoIsBefore(nowIso(), trow.fireAt)) {
    await armTimerDO(env, trow.timerId, trow.fireAt);
    return { kind: "reparked" };
  }

  // A settled instance never fires a timer (mirrors fireTimer's guard).
  const inst = await getInstanceRow(env.DB, instanceId);
  if (!inst || isTerminalInstanceStatus(inst.status)) return { kind: "fallThrough" };

  // (2) Armed AND overdue: settle the fire INLINE — the IDENTICAL alarm-path batch.
  const plan = await planIntermediateCatchFire(env, graph, trow, inst);
  if (plan.kind !== "fire") return { kind: "fallThrough" }; // not the current park → re-read
  try {
    await dbBatch(env.DB, plan.stmts);
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      // A concurrent REAL alarm (or /cancel) claimed the decider first → convert.
      const after = await getTimerOutcome(env.DB, timerId);
      if (after?.outcome === "fired") return { kind: "fired", next: plan.next };
      return { kind: "fallThrough" }; // cancelled won the conflict → re-read
    }
    throw err;
  }
  return { kind: "fired", next: plan.next };
}
