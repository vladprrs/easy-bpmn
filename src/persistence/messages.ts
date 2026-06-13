// External messages — canonical record of every publish outcome.

import { dbFirst, dbRun, stmt } from "./db";
import { parseJson, toJson, type JsonObject } from "../util";
import type { ExternalMessageView, PublishMessageResponse } from "../contracts/api";
import type { MessageEventPayload } from "../contracts/workflow-events";

interface MessageRow {
  external_message_id: string;
  workspace_id: string;
  message_name: string;
  correlation_key: string;
  message_id: string;
  payload: string;
  payload_hash: string;
  outcome: string;
  final_outcome: string;
  reason: string | null;
  original_response: string | null;
  matched_instance_id: string | null;
  matched_subscription_id: string | null;
  duplicate_of: string | null;
  received_at: string;
  expires_at: string | null;
  correlated_at: string | null;
}

export type PublicOutcome = PublishMessageResponse["outcome"];
export type FinalOutcome = ExternalMessageView["finalOutcome"];

export async function insertExternalMessage(
  db: D1Database,
  input: {
    externalMessageId: string;
    workspaceId: string;
    messageName: string;
    correlationKey: string;
    messageId: string;
    payload: JsonObject;
    payloadHash: string;
    outcome: PublicOutcome;
    finalOutcome: FinalOutcome;
    reason?: string | null;
    originalResponse?: PublishMessageResponse | null;
    matchedInstanceId?: string | null;
    matchedSubscriptionId?: string | null;
    duplicateOf?: string | null;
    receivedAt: string;
    expiresAt?: string | null;
    correlatedAt?: string | null;
  },
): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO external_messages
       (external_message_id, workspace_id, message_name, correlation_key, message_id, payload, payload_hash,
        outcome, final_outcome, reason, original_response, matched_instance_id, matched_subscription_id, duplicate_of,
        received_at, expires_at, correlated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.externalMessageId,
      input.workspaceId,
      input.messageName,
      input.correlationKey,
      input.messageId,
      toJson(input.payload),
      input.payloadHash,
      input.outcome,
      input.finalOutcome,
      input.reason ?? null,
      input.originalResponse ? toJson(input.originalResponse) : null,
      input.matchedInstanceId ?? null,
      input.matchedSubscriptionId ?? null,
      input.duplicateOf ?? null,
      input.receivedAt,
      input.expiresAt ?? null,
      input.correlatedAt ?? null,
    ],
  );
}

/** UPDATE statement marking a (previously buffered) message correlated. */
export function messageCorrelatedStmt(
  db: D1Database,
  input: {
    externalMessageId: string;
    instanceId: string;
    subscriptionId: string;
    now: string;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE external_messages
       SET outcome = 'correlated', final_outcome = 'correlated',
           matched_instance_id = ?, matched_subscription_id = ?, correlated_at = ?
     WHERE external_message_id = ?`,
    [input.instanceId, input.subscriptionId, input.now, input.externalMessageId],
  );
}

export async function markMessageExpired(
  db: D1Database,
  externalMessageId: string,
  now: string,
): Promise<void> {
  await dbRun(
    db,
    `UPDATE external_messages SET final_outcome = 'expired', correlated_at = NULL, expires_at = ? WHERE external_message_id = ?`,
    [now, externalMessageId],
  );
}

export async function getExternalMessageRow(
  db: D1Database,
  externalMessageId: string,
): Promise<MessageRow | null> {
  return dbFirst<MessageRow>(
    db,
    `SELECT * FROM external_messages WHERE external_message_id = ?`,
    [externalMessageId],
  );
}

export async function getExternalMessage(
  db: D1Database,
  externalMessageId: string,
): Promise<ExternalMessageView | null> {
  const row = await getExternalMessageRow(db, externalMessageId);
  if (!row) return null;
  return {
    outcome: row.outcome as PublicOutcome,
    messageName: row.message_name,
    correlationKey: row.correlation_key,
    messageId: row.message_id,
    externalMessageId: row.external_message_id,
    instanceId: row.matched_instance_id,
    duplicateOf: row.duplicate_of,
    reason: row.reason,
    finalOutcome: row.final_outcome as FinalOutcome,
    receivedAt: row.received_at,
    correlatedAt: row.correlated_at,
    expiresAt: row.expires_at,
  };
}

interface CorrelatedMessageRow {
  external_message_id: string;
  message_name: string;
  correlation_key: string;
  message_id: string;
  payload: string;
}

/**
 * The correlated external message linked to an ACTIVE subscription (apply-from-D1,
 * TASK-54): a single-wake re-walk reconstructs the MessageEventPayload from D1 alone
 * (no in-flight event). The link (`matched_subscription_id`) is set at POST time for
 * a live correlation (src/index.ts handlePublishMessage). Returns null when no
 * correlated message is linked (e.g. still waiting, or an early-buffered message
 * applied via the broker registerSubscription path instead).
 */
export async function getCorrelatedMessageForSubscription(db: D1Database, subscriptionId: string): Promise<MessageEventPayload | null> {
  const row = await dbFirst<CorrelatedMessageRow>(
    db,
    `SELECT external_message_id, message_name, correlation_key, message_id, payload
       FROM external_messages
      WHERE matched_subscription_id = ? AND final_outcome = 'correlated'
      LIMIT 1`,
    [subscriptionId],
  );
  if (!row) return null;
  return {
    externalMessageId: row.external_message_id,
    messageName: row.message_name,
    correlationKey: row.correlation_key,
    messageId: row.message_id,
    payload: parseJson<JsonObject>(row.payload, {}),
  };
}
