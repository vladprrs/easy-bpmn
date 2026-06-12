import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Persistence gate for migration 0006_timers.sql + src/persistence/timers.ts
// (M3-L3 design §4.1/§4.3). Exercises the REAL statement builders against a real
// D1: the schema shape, arm INSERT OR IGNORE idempotency, and — the correctness
// keystone — the timer_outcomes PLAIN-INSERT race decider, whose contract
// (gateway-decisions.ts:70-84) is that a conflicting batch aborts WHOLESALE and
// the loser converts to the recorded outcome on re-read.

import { dbBatch } from "../../src/persistence/db";
import {
  flipTimerCancelledStmt,
  flipTimerFiredStmt,
  getTimer,
  getTimerOutcome,
  insertTimerArmedStmt,
  insertTimerOutcomeStmt,
  listTimersForInstance,
  timerIdFor,
} from "../../src/persistence/timers";

const NOW = "2026-06-12T00:00:00.000Z";
const LATER = "2026-06-12T00:05:00.000Z";
const FIRE_AT = "2026-06-12T01:00:00.000Z";

async function columns(table: string): Promise<string[]> {
  const res = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return (res.results ?? []).map((r) => r.name);
}

async function indexColumns(index: string): Promise<string[]> {
  const res = await env.DB.prepare(`PRAGMA index_info(${index})`).all<{ name: string }>();
  return (res.results ?? []).map((r) => r.name);
}

async function uniqueIndexNames(table: string): Promise<string[]> {
  const res = await env.DB.prepare(`PRAGMA index_list(${table})`).all<{ name: string; unique: number }>();
  return (res.results ?? []).filter((r) => r.unique === 1).map((r) => r.name);
}

// Derive element_id + occurrence FROM the timer_id (instanceId:elementId#occurrence)
// so each distinct timer_id maps to a distinct (instance_id, element_id,
// occurrence) — otherwise uq_timers_visit collides and the OR IGNORE silently
// drops the row, masking the very semantics under test.
function armBoundary(timerId: string, instanceId: string, fireAt = FIRE_AT, now = NOW) {
  const rest = timerId.slice(instanceId.length + 1); // "elementId#occurrence"
  const hash = rest.lastIndexOf("#");
  return insertTimerArmedStmt(env.DB, {
    timerId,
    instanceId,
    elementId: rest.slice(0, hash),
    occurrence: Number(rest.slice(hash + 1)),
    kind: "boundary",
    attachedToRef: "Task_check",
    fireAt,
    now,
  });
}

describe("migration 0006_timers schema", () => {
  it("creates the timers table with the design §4.1 columns", async () => {
    const cols = await columns("timers");
    for (const c of [
      "timer_id",
      "instance_id",
      "element_id",
      "occurrence",
      "kind",
      "attached_to_ref",
      "gateway_id",
      "fire_at",
      "status",
      "fired_at",
      "created_at",
      "updated_at",
    ]) {
      expect(cols).toContain(c);
    }
  });

  it("enforces uq_timers_visit (UNIQUE) over (instance_id, element_id, occurrence)", async () => {
    expect(await uniqueIndexNames("timers")).toContain("uq_timers_visit");
    expect(await indexColumns("uq_timers_visit")).toEqual([
      "instance_id",
      "element_id",
      "occurrence",
    ]);
  });

  it("creates the timer_outcomes decider table with a timer_id PK", async () => {
    const cols = await columns("timer_outcomes");
    expect(cols).toEqual(["timer_id", "outcome", "decided_at"]);
    // PK enforced: a second plain INSERT of the same timer_id throws.
    await env.DB.prepare(`INSERT INTO timer_outcomes (timer_id, outcome, decided_at) VALUES (?, 'fired', ?)`)
      .bind("pk-probe", NOW).run();
    await expect(
      env.DB.prepare(`INSERT INTO timer_outcomes (timer_id, outcome, decided_at) VALUES (?, 'cancelled', ?)`)
        .bind("pk-probe", NOW).run(),
    ).rejects.toThrow();
  });
});

describe("timers persistence builders", () => {
  it("computes the deterministic timer_id instanceId:elementId#occurrence", () => {
    expect(timerIdFor("pi_1", "Timer_x", 2)).toBe("pi_1:Timer_x#2");
  });

  it("arms a timer with INSERT OR IGNORE — idempotent re-park keeps the first fire_at", async () => {
    const id = timerIdFor("pi_arm", "Timer_boundary", 0);
    await armBoundary(id, "pi_arm", FIRE_AT, NOW).run();

    const first = await getTimer(env.DB, id);
    expect(first?.status).toBe("armed");
    expect(first?.fireAt).toBe(FIRE_AT);
    expect(first?.kind).toBe("boundary");
    expect(first?.attachedToRef).toBe("Task_check");
    expect(first?.firedAt).toBeNull();

    // Re-arm (rewalk re-park) with a DIFFERENT fire_at + later timestamp: ignored,
    // never overwrites the snapshot (the unique-PK re-park is write-free).
    await armBoundary(id, "pi_arm", "2099-01-01T00:00:00.000Z", LATER).run();
    const second = await getTimer(env.DB, id);
    expect(second?.fireAt).toBe(FIRE_AT); // unchanged
    expect((await listTimersForInstance(env.DB, "pi_arm")).length).toBe(1); // still ONE row
  });

  it("flips armed → fired (sets fired_at) and armed → cancelled (fired_at stays null), guarded on armed", async () => {
    const fired = timerIdFor("pi_flip", "Timer_fired", 0);
    const cancelled = timerIdFor("pi_flip", "Timer_cancelled", 0);
    await armBoundary(fired, "pi_flip").run();
    await armBoundary(cancelled, "pi_flip").run();

    await flipTimerFiredStmt(env.DB, { timerId: fired, firedAt: LATER, now: LATER }).run();
    await flipTimerCancelledStmt(env.DB, { timerId: cancelled, now: LATER }).run();

    expect((await getTimer(env.DB, fired))?.status).toBe("fired");
    expect((await getTimer(env.DB, fired))?.firedAt).toBe(LATER);
    expect((await getTimer(env.DB, cancelled))?.status).toBe("cancelled");
    expect((await getTimer(env.DB, cancelled))?.firedAt).toBeNull();

    // The flip is status-guarded: re-flipping a settled row is a 0-row no-op.
    await flipTimerCancelledStmt(env.DB, { timerId: fired, now: "2099-01-01T00:00:00.000Z" }).run();
    expect((await getTimer(env.DB, fired))?.status).toBe("fired"); // unchanged
  });

  it("timer_outcomes is a PLAIN INSERT: a conflicting batch aborts WHOLESALE and the loser converts on re-read", async () => {
    const instanceId = "pi_race";
    const contested = timerIdFor(instanceId, "Timer_contested", 0);
    await armBoundary(contested, instanceId).run();

    // WINNER batch: claim 'fired' + flip — exactly as TASK-44's fire batch will.
    await dbBatch(env.DB, [
      insertTimerOutcomeStmt(env.DB, { timerId: contested, outcome: "fired", now: NOW }),
      flipTimerFiredStmt(env.DB, { timerId: contested, firedAt: NOW, now: NOW }),
    ]);
    expect((await getTimerOutcome(env.DB, contested))?.outcome).toBe("fired");

    // LOSER batch (the competing 'cancelled' exit): the SAME timer_id PK collides,
    // so the WHOLE batch must abort — including its unrelated visible side effect
    // (a brand-new timer row). This is the gateway-decisions.ts:70-84 contract that
    // makes "fired with no transition" (or a transition with a discarded decider)
    // impossible.
    const collateral = timerIdFor(instanceId, "Timer_collateral", 0);
    await expect(
      dbBatch(env.DB, [
        armBoundary(collateral, instanceId), // visible side effect — must roll back too
        insertTimerOutcomeStmt(env.DB, { timerId: contested, outcome: "cancelled", now: LATER }),
        flipTimerCancelledStmt(env.DB, { timerId: contested, now: LATER }),
      ]),
    ).rejects.toThrow();

    // Wholesale abort: the collateral insert never committed.
    expect(await getTimer(env.DB, collateral)).toBeNull();
    // Loser converts on re-read: the recorded outcome is still the WINNER's 'fired'
    // and the bookkeeping flip the winner committed stands.
    expect((await getTimerOutcome(env.DB, contested))?.outcome).toBe("fired");
    expect((await getTimer(env.DB, contested))?.status).toBe("fired");
  });

  it("lists an instance's timers oldest-first", async () => {
    const a = timerIdFor("pi_list", "Timer_a", 0);
    const b = timerIdFor("pi_list", "Timer_b", 0);
    await armBoundary(a, "pi_list", FIRE_AT, NOW).run();
    await armBoundary(b, "pi_list", FIRE_AT, LATER).run();
    const ids = (await listTimersForInstance(env.DB, "pi_list")).map((t) => t.timerId);
    expect(ids).toEqual([a, b]);
  });
});
