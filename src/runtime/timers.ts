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
import { isoIsBefore, isoPlusMs, nowIso } from "../util";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import { getVersionGraph } from "../persistence/definitions";
import { getInstanceRow, type InstanceRow } from "../persistence/instances";
import { flipTimerCancelledStmt, flipTimerFiredStmt, getTimer, getTimerOutcome, insertTimerOutcomeStmt, type TimerView } from "../persistence/timers";
import { getExecutor } from "./executor";
import { isUniqueConstraintViolation, planBoundaryTimerFire, supersedeBrokerSubscription } from "./boundary-timer";

/** TASK-73: the frozen-instance re-arm backoff — how soon a deferred (non-suppressible)
 *  timer fire is re-evaluated, so the deadline applies shortly after an operator resume. */
const FROZEN_REARM_BACKOFF_MS = 60_000;
import { planIntermediateCatchFire } from "./intermediate-timer";
import { planEventGatewayTimerFire } from "./event-gateway";

/**
 * Settle a fired model timer (design §4.3). Re-reads D1 and NO-OPS unless the base
 * fire preconditions hold: the row exists and is still `armed`, no `timer_outcomes`
 * decision was recorded yet, `fire_at <= now`, and the instance is not DONE
 * (completed/cancelled/compensated). Any of those failing is an idempotent no-op (a
 * stray/late alarm, a timer cancelled by an abnormal exit, an early/spurious alarm,
 * or a settled instance) — mirroring terminateUnleasableJob's re-check discipline.
 *
 * TASK-73: when the instance is FROZEN but resumable (incident / compensating /
 * compensationFailed) the fire is neither dropped nor applied — it is RECORDED
 * (suppressed) via `recordSuppressedTimerFire` and applied at the next resume; for
 * hosts without a resume heal it returns a `TimerRearm` instruction and the CALLING
 * JobScheduler alarm re-sets its own alarm in place of the one-shot teardown (the
 * DO's post-dispatch deleteAll would wipe any marker a nested self-RPC re-arm wrote,
 * so the re-arm must ride the alarm handler itself).
 */
export interface TimerRearm {
  /** Re-set the firing DO's alarm to this instant; keep its marker (not one-shot). */
  rearmAt: string;
}

export async function fireTimer(env: Env, timerId: string): Promise<TimerRearm | undefined> {
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

  const inst = await getInstanceRow(env.DB, timer.instanceId);
  if (!inst) return;

  // A DONE run never fires a timer (a fired timer is a modeled path, not an
  // incident, so it must not reanimate a completed/cancelled/compensated instance).
  // NOTE: these three are checked EXPLICITLY, not via isTerminalInstanceStatus —
  // that predicate also lists `incident`/`compensationFailed` ("no forward progress
  // WITHOUT operator action"), and those are handled by the frozen-record branch
  // below (they CAN resume via /retry, so their overdue deadline is recorded, not
  // dropped).
  if (inst.status === "completed" || inst.status === "cancelled" || inst.status === "compensated") return;

  // TASK-73 — record-and-apply-at-resume: an armed timer can come due while the
  // instance has been parked OUT of the active-forward lane (`running` | `waiting`)
  // into a FROZEN state — `incident` (a sibling/inner technical failure), `compensating`
  // (an operator /cancel of a Hazard), or `compensationFailed` — by a path the arming
  // logic never observed. Firing normally here would silently UNFREEZE/interrupt an
  // instance the engine or operator deliberately parked, and could race an in-flight
  // /cancel|/retry. Instead, for hosts whose resume path heals the skipped settle
  // (SCOPE hosts + intermediateCatch), RECORD the fire in the existing decider (a
  // suppressed `timer_outcomes 'fired'` claim + the bookkeeping flip + a suppressed
  // audit) with NO transition / drain / abandon / supersede — at operator /retry →
  // resume → rewalk, `timerHasFired` fast-forwards the walk onto the boundary path
  // (engine.ts driveLeaf scope branch, which drains the interrupted subtree), so the
  // modeled deadline is applied AFTER the freeze is resolved — never violating it.
  // TASK/RECEIVE-host boundary timers (whose fired fast-forward is write-free)
  // re-arm with a backoff instead — see recordSuppressedTimerFire's host dispatch.
  // See docs/superpowers/specs/2026-07-02-m5-l1-embedded-scopes-design.md §"timer fire
  // on a frozen instance" and docs/bpmn/09-easy-bpmn-profile.md (timer-boundary section).
  if (inst.status !== "running" && inst.status !== "waiting") {
    return recordSuppressedTimerFire(env, timer, inst);
  }

  // Dispatch by construct (design §4.3/§4.4/§4.5). Boundary + intermediateCatch
  // decide on `timer_outcomes`; the eventGateway timer decides on
  // `gateway_decisions` (TASK-46) — its generic guard above (status armed, no
  // decider) holds too: an EBG timer has no `timer_outcomes` row, so
  // getTimerOutcome is always null and the decision check lives in its plan builder.
  if (timer.kind === "boundary") await fireBoundaryTimer(env, timer, inst);
  else if (timer.kind === "intermediateCatch") await fireIntermediateCatchTimer(env, timer, inst);
  else if (timer.kind === "eventGateway") await fireEventGatewayTimer(env, timer, inst);
  return undefined;
}

/**
 * TASK-73 — the suppressed-fire record for a timer that came due while the instance
 * is FROZEN (incident / compensating / compensationFailed). Claims the SAME decider
 * a normal boundary/intermediateCatch fire would (`timer_outcomes 'fired'` + the
 * bookkeeping flip) plus a `timerFired {suppressed:true}` audit — and NOTHING else:
 * no transition, no job abandon, no scope drain, no subscription supersede. The
 * recorded decider makes `timerHasFired` fast-forward the walk onto the boundary path
 * at the next resume (operator /retry), where the engine drains the interrupted scope
 * — so the deadline is applied AFTER the freeze clears, never unfreezing it here.
 *
 * REVIEW FIX (final whole-branch review): the suppressed record is RESTRICTED to
 * hosts whose RESUME path heals what the suppressed fire skipped —
 *   - SCOPE hosts (boundary on a transaction/subProcess): the engine's timerHasFired
 *     fast-forward runs drainScopeSubtree (engine.ts driveLeaf scope branch);
 *   - intermediateCatch: the catch IS the wait — the fired fast-forward has nothing
 *     to clean.
 * A TASK/RECEIVE host's fired fast-forward is WRITE-FREE (forward-task.ts's
 * timerHasFired jump / the receive drive's twin) — a suppressed claim there would
 * permanently skip the normal fire batch's host cleanup: the /retry-re-created job
 * would stay leasable forever (a worker could run real side effects for a task whose
 * timeout path was taken) and an active subscription + broker key would leak (the
 * exact TASK-72 leak). Those hosts take the RE-ARM-BACKOFF path instead (no decider
 * claim): a `TimerRearm` instruction is RETURNED and the calling JobScheduler alarm
 * re-sets its own alarm (a nested self-RPC re-arm would be wiped by the alarm's
 * one-shot deleteAll) — the alarm re-fires after resume and the NORMAL fire batch
 * runs with its full host cleanup, pre-TASK-73 semantics restored deterministically,
 * the deadline applying shortly after resume. An unresolvable host (missing
 * graph/node) conservatively re-arms too — never claim a decider whose resume
 * semantics are unknown.
 *
 * Single-decide: the PLAIN `timer_outcomes` INSERT is the race gate (the
 * gateway_decisions contract). A concurrent operator /cancel sweep
 * (cancelArmedTimersForInstance) claiming the decider first aborts THIS batch on the
 * PK — caught and no-oped, so the timer is decided exactly once. (The re-arm path
 * claims nothing, so it cannot race the sweep; a swept timer's later alarm no-ops on
 * fireTimer's status/decider guards.)
 *
 * eventGateway timers decide on `gateway_decisions` (built together with the
 * transition inside planEventGatewayTimerFire, §4.5) — splitting that batch is out of
 * scope (TASK-73), and an EBG timer is not a scope timer (outside this task's ACs).
 * They take the same re-arm-backoff, so the fire is re-evaluated once the freeze
 * clears rather than lost.
 */
async function recordSuppressedTimerFire(env: Env, timer: TimerView, inst: InstanceRow): Promise<TimerRearm | undefined> {
  if (timer.kind === "eventGateway") {
    return { rearmAt: isoPlusMs(nowIso(), FROZEN_REARM_BACKOFF_MS) };
  }
  if (timer.kind === "boundary") {
    const graph = await getVersionGraph(env.DB, inst.definition_version_id);
    const host = timer.attachedToRef ? graph?.nodes[timer.attachedToRef] : undefined;
    if (host?.type !== "transaction" && host?.type !== "subProcess") {
      // Task/receive host (or unresolvable) → re-arm-backoff, no decider claim.
      return { rearmAt: isoPlusMs(nowIso(), FROZEN_REARM_BACKOFF_MS) };
    }
  }
  const now = nowIso();
  try {
    await dbBatch(env.DB, [
      insertTimerOutcomeStmt(env.DB, { timerId: timer.timerId, outcome: "fired", now }), // THE CLAIM (single-decide)
      flipTimerFiredStmt(env.DB, { timerId: timer.timerId, firedAt: now, now }),
      historyStmt(env.DB, {
        workspaceId: inst.workspace_id,
        instanceId: timer.instanceId,
        elementId: timer.elementId,
        type: "timerFired",
        diagnostics: { attachedToRef: timer.attachedToRef, occurrence: timer.occurrence, suppressed: true, instanceStatus: inst.status },
      }),
    ]);
  } catch (err) {
    if (isUniqueConstraintViolation(err)) return; // a concurrent /cancel sweep claimed the decider first → no-op
    throw err;
  }
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
