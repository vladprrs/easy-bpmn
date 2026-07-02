// History events — the operator-visible audit + technical diagnostics timeline.

import { dbAll, stmt } from "./db";
import { newId, nowIso, parseJson, toJson } from "../util";
import type { HistoryEvent } from "../contracts/api";

export interface HistoryInput {
  workspaceId: string;
  instanceId?: string | null;
  externalMessageId?: string | null;
  elementId?: string | null;
  type: string;
  businessTime?: string;
  technicalTime?: string;
  payloadSnapshot?: Record<string, unknown> | null;
  diagnostics?: Record<string, unknown>;
}

interface HistoryRow {
  history_event_id: string;
  instance_id: string | null;
  external_message_id: string | null;
  element_id: string | null;
  type: string;
  business_time: string;
  technical_time: string;
  payload_snapshot: string | null;
  diagnostics: string;
}

function mapHistory(row: HistoryRow): HistoryEvent {
  return {
    historyEventId: row.history_event_id,
    type: row.type,
    instanceId: row.instance_id,
    elementId: row.element_id,
    externalMessageId: row.external_message_id,
    businessTime: row.business_time,
    technicalTime: row.technical_time,
    payloadSnapshot: row.payload_snapshot ? parseJson(row.payload_snapshot, null) : null,
    diagnostics: parseJson(row.diagnostics, {}),
  };
}

/** Build the INSERT statement (for atomic batched transitions). */
export function historyStmt(db: D1Database, input: HistoryInput): D1PreparedStatement {
  const now = nowIso();
  return stmt(
    db,
    `INSERT INTO history_events
       (history_event_id, workspace_id, instance_id, external_message_id, element_id, type, business_time, technical_time, payload_snapshot, diagnostics)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId("hist"),
      input.workspaceId,
      input.instanceId ?? null,
      input.externalMessageId ?? null,
      input.elementId ?? null,
      input.type,
      input.businessTime ?? now,
      input.technicalTime ?? now,
      input.payloadSnapshot ? toJson(input.payloadSnapshot) : null,
      toJson(input.diagnostics ?? {}),
    ],
  );
}

export async function recordHistory(db: D1Database, input: HistoryInput): Promise<void> {
  await historyStmt(db, input).run();
}

/**
 * Existence check for a visit MARKER event at a specific occurrence (TASK-32
 * bookkeeping fast-forward). Existence-of-THIS-occurrence, deliberately NOT a
 * count: duplicate concurrent walks could double-write a marker, and a
 * count-based predicate (`count > occ`) would then falsely fast-forward a
 * later visit — existence-per-occurrence makes duplicates harmless audit noise.
 * MIGRATION COMPAT: pre-rewalk (M1) marker events carry NO `occurrence` field
 * in diagnostics — they are always visit 0, so the missing path folds to 0 via
 * COALESCE (json_extract returns NULL for a missing key; `diagnostics` itself
 * is NOT NULL by schema (0001) and always at least '{}', and json_extract(NULL)
 * would fold to 0 through the same COALESCE anyway).
 */
export async function hasHistoryMarkerForOccurrence(
  db: D1Database,
  instanceId: string,
  elementId: string,
  type: string,
  occurrence: number,
): Promise<boolean> {
  const row = await stmt(
    db,
    `SELECT 1 AS hit FROM history_events
      WHERE instance_id = ? AND element_id = ? AND type = ?
        AND COALESCE(json_extract(diagnostics, '$.occurrence'), 0) = ?
      LIMIT 1`,
    [instanceId, elementId, type, occurrence],
  ).first<{ hit: number }>();
  return row !== null;
}

/**
 * The raw element_id of the most recent `transactionCancelled` history row (M5-L1
 * Task 8) — the durable, replay-safe compensation-root marker. An operator /cancel
 * writes this row WITHOUT an element scope (→ null → the process root); an
 * auto cancel-end wrote element_id = the cancelled transaction id. Persistence stays
 * graph-free: the ENGINE maps the returned element to a root (transaction id vs null).
 */
export async function latestCancelRootElement(db: D1Database, instanceId: string): Promise<string | null> {
  const row = await stmt(
    db,
    `SELECT element_id FROM history_events
      WHERE instance_id = ? AND type = 'transactionCancelled'
      ORDER BY rowid DESC LIMIT 1`,
    [instanceId],
  ).first<{ element_id: string | null }>();
  return row?.element_id ?? null;
}

/** Count history events of a given type for an instance element (e.g. poison strikes). */
export async function countHistoryEventsOfType(
  db: D1Database,
  instanceId: string,
  elementId: string,
  type: string,
): Promise<number> {
  const row = await stmt(
    db,
    `SELECT COUNT(*) AS n FROM history_events WHERE instance_id = ? AND element_id = ? AND type = ?`,
    [instanceId, elementId, type],
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listInstanceHistory(
  db: D1Database,
  instanceId: string,
): Promise<HistoryEvent[]> {
  const rows = await dbAll<HistoryRow>(
    db,
    `SELECT * FROM history_events WHERE instance_id = ? ORDER BY rowid ASC`,
    [instanceId],
  );
  return rows.map(mapHistory);
}

/**
 * Cursor tail of an instance's history by SQLite `rowid` (M-UI §11, §12). Powers
 * BOTH the SSE live-tail (`/instances/{id}/stream`) and its poll fallback
 * (`GET /instances/{id}/history?since=`). `since=null` returns from the start.
 * Each row carries its `cursor` (rowid) so the SSE handler can emit `id:<cursor>`
 * per event and EventSource resumes with `Last-Event-ID` without gaps/dupes.
 */
export async function tailInstanceHistory(
  db: D1Database,
  instanceId: string,
  since: number | null,
  limit = 500,
): Promise<{ rows: { cursor: number; event: HistoryEvent }[]; nextCursor: number | null }> {
  const where = ["instance_id = ?"];
  const params: unknown[] = [instanceId];
  if (since != null) {
    where.push("rowid > ?");
    params.push(since);
  }
  params.push(limit);
  const rows = await dbAll<HistoryRow & { cursor: number }>(
    db,
    `SELECT rowid AS cursor, * FROM history_events WHERE ${where.join(" AND ")} ORDER BY rowid ASC LIMIT ?`,
    params,
  );
  const mapped = rows.map((r) => ({ cursor: r.cursor, event: mapHistory(r) }));
  const nextCursor = mapped.length > 0 ? mapped[mapped.length - 1]!.cursor : since;
  return { rows: mapped, nextCursor };
}

export async function listMessageHistory(
  db: D1Database,
  externalMessageId: string,
): Promise<HistoryEvent[]> {
  const rows = await dbAll<HistoryRow>(
    db,
    `SELECT * FROM history_events WHERE external_message_id = ? ORDER BY rowid ASC`,
    [externalMessageId],
  );
  return rows.map(mapHistory);
}
