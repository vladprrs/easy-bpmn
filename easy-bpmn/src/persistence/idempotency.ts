// Idempotency records — stable stored results for at-least-once inputs.

import { dbFirst, dbRun } from "./db";
import { parseJson, toJson } from "../util";

export type IdempotencyScope =
  | "startInstance"
  | "workerCallback"
  | "messagePublish"
  | "workflowEvent";

export async function getIdempotentResult<T>(
  db: D1Database,
  scope: IdempotencyScope,
  key: string,
): Promise<T | null> {
  const row = await dbFirst<{ result: string }>(
    db,
    `SELECT result FROM idempotency_records WHERE scope = ? AND idempotency_key = ?`,
    [scope, key],
  );
  return row ? parseJson<T>(row.result, null as unknown as T) : null;
}

/** Stores the result only if absent (the original result wins). */
export async function putIdempotentResult(
  db: D1Database,
  scope: IdempotencyScope,
  key: string,
  result: unknown,
  now: string,
): Promise<void> {
  await dbRun(
    db,
    `INSERT OR IGNORE INTO idempotency_records (scope, idempotency_key, result, created_at)
     VALUES (?, ?, ?, ?)`,
    [scope, key, toJson(result), now],
  );
}
