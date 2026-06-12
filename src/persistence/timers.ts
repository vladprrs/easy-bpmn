// timers / timer_outcomes — the canonical record for one armed model timer
// (M3-L3 design 2026-06-11 §4.1). The `timers` row is bookkeeping/read-model;
// the authoritative race OUTCOME for boundary / intermediateCatch timers lives
// in `timer_outcomes` (eventGateway timers decide on `gateway_decisions`, §4.5).
// Statement builders + reads only — the arm/fire/decider runtime lives in
// src/runtime/timers.ts and the engine transition logic (TASK-44).

import { dbAll, dbFirst, stmt } from "./db";

/** The construct that armed this timer (= the deterministic `kind` column). */
export type TimerKind = "boundary" | "intermediateCatch" | "eventGateway";

/** Bookkeeping/read-model status (the authoritative outcome is the decider row). */
export type TimerStatus = "armed" | "fired" | "cancelled";

/** The decider outcome (one row per boundary/intermediateCatch timer). */
export type TimerOutcomeValue = "fired" | "cancelled";

export interface TimerRow {
  timer_id: string;
  instance_id: string;
  element_id: string;
  occurrence: number;
  kind: string;
  attached_to_ref: string | null;
  gateway_id: string | null;
  fire_at: string;
  status: string;
  fired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TimerView {
  timerId: string;
  instanceId: string;
  elementId: string;
  occurrence: number;
  kind: TimerKind;
  attachedToRef: string | null;
  gatewayId: string | null;
  fireAt: string;
  status: TimerStatus;
  firedAt: string | null;
}

export function mapTimer(row: TimerRow): TimerView {
  return {
    timerId: row.timer_id,
    instanceId: row.instance_id,
    elementId: row.element_id,
    occurrence: row.occurrence,
    kind: row.kind as TimerKind,
    attachedToRef: row.attached_to_ref,
    gatewayId: row.gateway_id,
    fireAt: row.fire_at,
    status: row.status as TimerStatus,
    firedAt: row.fired_at,
  };
}

export interface TimerOutcomeRow {
  timer_id: string;
  // The column is written ONLY by insertTimerOutcomeStmt with a TimerOutcomeValue,
  // so the narrowed type is sound at the read boundary (unlike TimerRow.kind/status,
  // this read returns the raw row, so callers get the narrowing directly).
  outcome: TimerOutcomeValue;
  decided_at: string;
}

/**
 * The deterministic timer_id (design §4.1): `instanceId:elementId#occurrence`.
 * `occurrence` is the ARMING visit's occurrence (host activity for a boundary
 * timer, the catch's own visit for an intermediate catch, the gateway's visit
 * for an EBG timer branch) — never derived from live D1 row counts (M2 rule).
 */
export function timerIdFor(instanceId: string, elementId: string, occurrence: number): string {
  return `${instanceId}:${elementId}#${occurrence}`;
}

/**
 * Arm a model timer — `INSERT OR IGNORE` (design §4.1 "Arming is INSERT OR
 * IGNORE"). Arming is idempotent: a rewalk that revisits an `armed` visit is a
 * write-free re-park (the unique (instance_id, element_id, occurrence) index and
 * the deterministic PK both reject the duplicate, so `fire_at` is fixed at FIRST
 * arm and never recomputed). Composed into the SAME dbBatch as the wait it
 * guards (the job `svc-create` batch / subscription-registration batch / catch
 * park batch) — persist-before-advance. Unlike `timer_outcomes`, the arm is NOT
 * a race decider, so `OR IGNORE` is correct here.
 */
export function insertTimerArmedStmt(
  db: D1Database,
  input: {
    timerId: string;
    instanceId: string;
    elementId: string;
    occurrence: number;
    kind: TimerKind;
    /** boundary: host activity element id; null otherwise. */
    attachedToRef?: string | null;
    /** eventGateway: owning gateway element id; null otherwise. */
    gatewayId?: string | null;
    /** Computed ONCE at arm time in code (timeDate as-is; now + timeDuration). */
    fireAt: string;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT OR IGNORE INTO timers
       (timer_id, instance_id, element_id, occurrence, kind, attached_to_ref, gateway_id,
        fire_at, status, fired_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'armed', NULL, ?, ?)`,
    [
      input.timerId,
      input.instanceId,
      input.elementId,
      input.occurrence,
      input.kind,
      input.attachedToRef ?? null,
      input.gatewayId ?? null,
      input.fireAt,
      input.now,
      input.now,
    ],
  );
}

/**
 * Claim the timer race — a PLAIN INSERT (NEVER `OR IGNORE`) of the deciding
 * `timer_outcomes` row. This is the boundary/intermediateCatch race decider and
 * MUST be composed into the SAME dbBatch as the loser-visible transition (the
 * `fired` claim rides the fire batch; the `cancelled` claim rides every
 * abnormal-exit batch — completion, error route, exhaustion, operator /cancel,
 * design §4.3.2).
 *
 * Normative reference — the `gateway_decisions` contract
 * (src/persistence/gateway-decisions.ts:70-84): with a PLAIN INSERT a losing
 * concurrent batch's unique-constraint violation on the timer_id PK aborts its
 * ENTIRE batch atomically — transition and history included — and the caller
 * must re-read the outcome and convert (never re-fire / re-advance). With
 * `OR IGNORE` the losing batch's transition would still commit while its
 * decision row is discarded, recording one outcome while the instance advanced
 * down the other — the exact double-advance bug `OR IGNORE` reintroduces.
 *
 * eventGateway timers decide on `gateway_decisions`, not here, so they get NO
 * `timer_outcomes` row (§4.5).
 */
export function insertTimerOutcomeStmt(
  db: D1Database,
  input: { timerId: string; outcome: TimerOutcomeValue; now: string },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO timer_outcomes (timer_id, outcome, decided_at) VALUES (?, ?, ?)`,
    [input.timerId, input.outcome, input.now],
  );
}

/**
 * Bookkeeping flip armed → fired, paired with the `timer_outcomes 'fired'` claim
 * in the SAME fire batch (design §4.3.3). Status-guarded on `armed` so a replay
 * of an already-settled row is a 0-row no-op (the decider INSERT is the true
 * gate; this guard is belt-and-braces, mirroring transitionStatusGuardedStmt).
 */
export function flipTimerFiredStmt(
  db: D1Database,
  input: { timerId: string; firedAt: string; now: string },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE timers SET status = 'fired', fired_at = ?, updated_at = ?
       WHERE timer_id = ? AND status = 'armed'`,
    [input.firedAt, input.now, input.timerId],
  );
}

/**
 * Bookkeeping flip armed → cancelled, paired with the `timer_outcomes
 * 'cancelled'` claim in every abnormal-exit batch (design §4.3.2). Status-guarded
 * on `armed` as in flipTimerFiredStmt. `fired_at` stays NULL (a cancelled timer
 * never fired).
 */
export function flipTimerCancelledStmt(
  db: D1Database,
  input: { timerId: string; now: string },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE timers SET status = 'cancelled', updated_at = ?
       WHERE timer_id = ? AND status = 'armed'`,
    [input.now, input.timerId],
  );
}

/** The timer row, or null. `fireTimer` re-reads this at fire time (D1 canonical). */
export async function getTimer(db: D1Database, timerId: string): Promise<TimerView | null> {
  const row = await dbFirst<TimerRow>(db, `SELECT * FROM timers WHERE timer_id = ?`, [timerId]);
  return row ? mapTimer(row) : null;
}

/**
 * The decided outcome for a boundary/intermediateCatch timer, or null if the
 * race is still open. `fireTimer` reads this FIRST: an existing row means the
 * timer was already settled (fired or cancelled) → no-op (design §4.3.3).
 */
export async function getTimerOutcome(db: D1Database, timerId: string): Promise<TimerOutcomeRow | null> {
  return dbFirst<TimerOutcomeRow>(db, `SELECT * FROM timer_outcomes WHERE timer_id = ?`, [timerId]);
}

/** All timers for an instance, oldest-first (the inspection `timers` block, TASK-44). */
export async function listTimersForInstance(db: D1Database, instanceId: string): Promise<TimerView[]> {
  const rows = await dbAll<TimerRow>(
    db,
    `SELECT * FROM timers WHERE instance_id = ? ORDER BY created_at, timer_id`,
    [instanceId],
  );
  return rows.map(mapTimer);
}
