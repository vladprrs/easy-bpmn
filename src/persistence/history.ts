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
