// fireTimer — the JobScheduler alarm's timer dispatch target (M3-L3 design §4.3).
//
// LAYERING SEAM (TASK-43 vs TASK-44). In THIS layer fireTimer implements ONLY
// the idempotent GUARD + NO-OP paths: it re-reads the canonical timer row and
// any timer_outcomes decision and returns WITHOUT writing whenever firing would
// be wrong (missing / already-settled / not-yet-due / terminal instance). The
// WINNING-FIRE transition — the plain-INSERT `timer_outcomes 'fired'` claim, the
// status flip, the job-abandon / subscription-supersede, the `timerFired`
// history, the transition out of the wait, and waking the instance — is
// TASK-44's deliverable. It MUST NOT be written here, because the design
// invariant (§4.1/§4.3.3) requires the claim and the transition to land in the
// SAME dbBatch, which needs the engine transition logic TASK-44 adds.
//
// Like the JobScheduler DLQ (terminateUnleasableJob), the DO holds no
// authoritative state — D1 is canonical — so this re-reads at fire time and a
// late/duplicate/stray alarm against an already-decided (or progressed) timer is
// a safe idempotent no-op.

import type { Env } from "../env";
import { isTerminalInstanceStatus, isoIsBefore, nowIso } from "../util";
import { getInstanceRow } from "../persistence/instances";
import { getTimer, getTimerOutcome } from "../persistence/timers";

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

  // ---- FIRE-ELIGIBLE SEAM ----------------------------------------------------
  // All guards passed: this is a genuine, due, undecided timer on a live
  // instance. The winning-fire transition lands in TASK-44 (M3-L3 runtime); see
  // design §4.3. It is intentionally NOT a silent stub: nothing in this layer
  // arms a real timer (no validator opens boundary timers yet), so this branch
  // is unreachable by real models and the unit tests only exercise the no-op
  // guards above. If it is ever reached before TASK-44 ships, fail LOUD rather
  // than silently dropping the fire (mirrors forward-task.ts's defensive throw
  // on an "unreachable by construction" branch).
  throw new Error(
    `fireTimer: timer ${timerId} (element ${timer.elementId}, occurrence ${timer.occurrence}, ` +
      `kind ${timer.kind}) is fire-eligible, but the winning-fire transition is not implemented ` +
      `in M3-L3/TASK-43 — it lands in TASK-44 (see design §4.3). No real model arms a timer in this layer.`,
  );
}
