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
import { dbBatch } from "../persistence/db";
import { getVersionGraph } from "../persistence/definitions";
import { getInstanceRow, type InstanceRow } from "../persistence/instances";
import { flipTimerCancelledStmt, getTimer, getTimerOutcome, type TimerView } from "../persistence/timers";
import { getExecutor } from "./executor";
import { isUniqueConstraintViolation, planBoundaryTimerFire, supersedeBrokerSubscription } from "./boundary-timer";
import { planIntermediateCatchFire } from "./intermediate-timer";
import { planEventGatewayTimerFire } from "./event-gateway";

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

  // Dispatch by construct (design §4.3/§4.4/§4.5). Boundary + intermediateCatch
  // decide on `timer_outcomes`; the eventGateway timer decides on
  // `gateway_decisions` (TASK-46) — its generic guard above (status armed, no
  // decider) holds too: an EBG timer has no `timer_outcomes` row, so
  // getTimerOutcome is always null and the decision check lives in its plan builder.
  if (timer.kind === "boundary") return fireBoundaryTimer(env, timer, inst);
  if (timer.kind === "intermediateCatch") return fireIntermediateCatchTimer(env, timer, inst);
  if (timer.kind === "eventGateway") return fireEventGatewayTimer(env, timer, inst);
}

/**
 * The DO-alarm fire path for an EBG timer branch (design §4.5.3). Composes the
 * winning batch via the SHARED builder `planEventGatewayTimerFire` (event-gateway.ts)
 * — the PLAIN `gateway_decisions` INSERT (the claim) + the bookkeeping flip + the
 * supersede of ALL message-branch subscriptions + `timerFired`/`ebgDecision` + the
 * transition to the timer catch's flow — commits it, supersedes the losing message
 * brokers, and wakes the instance. On the decider conflict (a message branch won
 * the race) the batch aborts WHOLESALE → flip this timer's bookkeeping `cancelled`
 * and no-op (the losing-fireTimer path, design §4.5.3).
 */
async function fireEventGatewayTimer(env: Env, timer: TimerView, inst: InstanceRow): Promise<void> {
  const graph: ExecutionGraph | null = await getVersionGraph(env.DB, inst.definition_version_id);
  if (!graph) return;
  const plan = await planEventGatewayTimerFire(env, graph, timer, inst);
  if (plan.kind !== "fire") {
    // Message won / instance progressed → flip the bookkeeping `cancelled` so the
    // row does not linger `armed` (status-guarded; the decision is the truth).
    await flipTimerCancelledStmt(env.DB, { timerId: timer.timerId, now: nowIso() }).run();
    return;
  }
  try {
    await dbBatch(env.DB, plan.stmts);
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      await flipTimerCancelledStmt(env.DB, { timerId: timer.timerId, now: nowIso() }).run();
      return; // a message claimed the decider first → no-op
    }
    throw err;
  }
  for (const sub of plan.brokerSubs) await supersedeBrokerSubscription(env, sub);
  await getExecutor(env).wakeTimer(plan.wake);
}

/**
 * The DO-alarm fire path for an interrupting boundary timer (design §4.3.3/4.3.5).
 * Composes the winning-fire batch via the SHARED builder `planBoundaryTimerFire`
 * (boundary-timer.ts) — which resolves the host's live wait, GUARDS that it is still
 * the current wait, and assembles the decider claim + transition — then commits it
 * and WAKES the instance via the executor. The Workflow-mode lost-alarm backstop
 * (`settleOverdueBoundaryTimerOnWake`) commits the IDENTICAL batch but returns the
 * next step instead of waking; keeping the builder in boundary-timer.ts (which never
 * imports the executor) is what lets both share it without an import cycle.
 */
async function fireBoundaryTimer(env: Env, timer: TimerView, inst: InstanceRow): Promise<void> {
  const graph: ExecutionGraph | null = await getVersionGraph(env.DB, inst.definition_version_id);
  if (!graph) return;
  const plan = await planBoundaryTimerFire(env, graph, timer, inst);
  if (plan.kind !== "fire") return; // host wait already resolved (completion won the race) → no-op
  try {
    await dbBatch(env.DB, plan.stmts);
  } catch (err) {
    if (isUniqueConstraintViolation(err)) return; // a competing exit claimed the decider first → no-op
    throw err;
  }
  // Receive-task fire: best-effort drop the broker's active subscription so a late
  // publish gets the stable buffered/no-match outcome (at-most-one-active-subscription).
  if (plan.brokerSub) await supersedeBrokerSubscription(env, plan.brokerSub);
  await getExecutor(env).wakeTimer(plan.wake);
}

/**
 * The DO-alarm fire path for an intermediate timer catch (design §4.4). Composes
 * the winning-fire batch via the SHARED builder `planIntermediateCatchFire`
 * (intermediate-timer.ts) — the PLAIN `timer_outcomes 'fired'` decider claim +
 * the flip + `timerFired` history + the transition down the single outgoing flow,
 * all in ONE dbBatch — then commits it and WAKES the instance via the executor.
 * There is NO host job/subscription to abandon (the catch IS the wait). A
 * competing operator-/cancel settlement that claimed the decider first aborts
 * this batch WHOLESALE on the PK violation → idempotent no-op.
 */
async function fireIntermediateCatchTimer(env: Env, timer: TimerView, inst: InstanceRow): Promise<void> {
  const graph: ExecutionGraph | null = await getVersionGraph(env.DB, inst.definition_version_id);
  if (!graph) return;
  const plan = await planIntermediateCatchFire(env, graph, timer, inst);
  if (plan.kind !== "fire") return; // not the current park / already resolved → no-op
  try {
    await dbBatch(env.DB, plan.stmts);
  } catch (err) {
    if (isUniqueConstraintViolation(err)) return; // a competing /cancel claimed the decider first → no-op
    throw err;
  }
  await getExecutor(env).wakeTimer(plan.wake);
}
