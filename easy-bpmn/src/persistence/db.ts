// D1 statement helpers. D1 rejects `undefined` binds, so we coerce to null.

export function stmt(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): D1PreparedStatement {
  return db.prepare(sql).bind(...params.map((p) => (p === undefined ? null : p)));
}

export async function dbFirst<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  return (await stmt(db, sql, params).first<T>()) ?? null;
}

export async function dbAll<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await stmt(db, sql, params).all<T>();
  return res.results ?? [];
}

export async function dbRun(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await stmt(db, sql, params).run();
}

/** Atomic, all-or-nothing multi-statement transition. */
export async function dbBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  if (statements.length > 0) await db.batch(statements);
}

export async function ensureWorkspace(
  db: D1Database,
  workspaceId: string,
  now: string,
): Promise<void> {
  await dbRun(
    db,
    `INSERT OR IGNORE INTO workspaces (workspace_id, name, created_at) VALUES (?, ?, ?)`,
    [workspaceId, workspaceId, now],
  );
}
