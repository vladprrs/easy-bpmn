// Per-instance advisory drive lock for direct-mode serialization (M4-L2, design §10).
// A D1 row IS the lock; INSERT OR IGNORE acquires, DELETE releases. A stale lock
// (holder crashed) is stolen after LOCK_TTL_MS so an instance can never wedge.

import { stmt } from "./db";

const LOCK_TTL_MS = 30_000;

export async function acquireDriveLock(db: D1Database, instanceId: string, now: string): Promise<boolean> {
  await stmt(db, `CREATE TABLE IF NOT EXISTS drive_locks (instance_id TEXT PRIMARY KEY, acquired_at TEXT NOT NULL)`, []).run();
  const res = await stmt(db, `INSERT OR IGNORE INTO drive_locks (instance_id, acquired_at) VALUES (?, ?)`, [instanceId, now]).run();
  if ((res.meta?.changes ?? 0) > 0) return true;
  // Steal if stale.
  const cutoff = new Date(new Date(now).getTime() - LOCK_TTL_MS).toISOString();
  const stolen = await stmt(db, `UPDATE drive_locks SET acquired_at = ? WHERE instance_id = ? AND acquired_at < ?`, [now, instanceId, cutoff]).run();
  return (stolen.meta?.changes ?? 0) > 0;
}

export async function releaseDriveLock(db: D1Database, instanceId: string): Promise<void> {
  await stmt(db, `DELETE FROM drive_locks WHERE instance_id = ?`, [instanceId]).run();
}

/** Run `fn` under the drive lock, retrying acquisition briefly; serialises concurrent direct-mode drives. */
export async function withDriveLock<T>(db: D1Database, instanceId: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 50; i++) {
    if (await acquireDriveLock(db, instanceId, new Date().toISOString())) {
      try { return await fn(); } finally { await releaseDriveLock(db, instanceId); }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  // Lock contended past the budget — proceed unlocked rather than dropping the
  // drive (the seq monotonicity is best-effort under extreme contention; the
  // join_completions/saga_steps unique discipline is the real correctness gate).
  return fn();
}
