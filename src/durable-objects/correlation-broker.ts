// Correlation Broker — one Durable Object per (workspace + messageName +
// correlationKey). It is the single serialization point for: active-subscription
// uniqueness, publish/register races, messageId dedup + stable duplicate response,
// early-message buffering (1h TTL), late-message detection, and expiry. D1 mirrors
// these decisions for queryable history; this DO owns the authoritative
// coordination state and reconciles expiry/lateness back into D1.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type {
  BrokerInspection,
  BrokerPublishRequest,
  BrokerPublishResult,
  ExpiredMessage,
  ExpireResult,
  RegisterSubscriptionRequest,
  RegisterSubscriptionResult,
} from "../runtime/broker-types";
import { ONE_HOUR_MS, isoPlusMs, nowIso } from "../util";
import { markMessageExpired } from "../persistence/messages";
import { recordHistory } from "../persistence/history";

interface StoredSubscription {
  subscriptionId: string;
  instanceId: string;
  workflowInstanceId: string;
  elementId: string;
  messageName: string;
  correlationKey: string;
  workflowEventType: string;
  expiresAt: string;
}

interface StoredBuffered {
  externalMessageId: string;
  workspaceId: string;
  messageName: string;
  correlationKey: string;
  messageId: string;
  payload: Record<string, unknown>;
  receivedAt: string;
  expiresAt: string;
}

interface StoredDedup {
  externalMessageId: string;
  outcome: string;
  instanceId?: string;
}

// Marker recorded once a broker key's subscription has been consumed (the
// instance advanced past its Receive Task). It is cleared when a fresh
// subscription registers, so messages arriving while the marker is present are
// `late` rather than `buffered`.
interface StoredConsumed {
  instanceId: string;
  externalMessageId: string;
  consumedAt: string;
}

const SUB_KEY = "sub";
const CONSUMED_KEY = "consumed";

function isExpired(expiresAt: string, now: string): boolean {
  return new Date(expiresAt).getTime() <= new Date(now).getTime();
}

export class CorrelationBroker extends DurableObject<Env> {
  async registerSubscription(
    req: RegisterSubscriptionRequest,
  ): Promise<RegisterSubscriptionResult> {
    await this.expireDue(req.now);

    const existing = await this.ctx.storage.get<StoredSubscription>(SUB_KEY);
    if (existing) {
      // Idempotent re-registration by the same instance/element.
      if (existing.instanceId === req.instanceId && existing.elementId === req.elementId) {
        return { status: "waiting", subscriptionId: existing.subscriptionId };
      }
      return {
        status: "rejected",
        reason:
          "At most one active subscription is allowed per messageName + correlationKey within a workspace.",
        existingInstanceId: existing.instanceId,
      };
    }

    // Consume the earliest non-expired buffered message, if any.
    const buffered = await this.earliestBuffered(req.now);
    if (buffered) {
      await this.ctx.storage.delete(`buffer:${buffered.messageId}`);
      const dedup: StoredDedup = {
        externalMessageId: buffered.externalMessageId,
        outcome: "correlated",
        instanceId: req.instanceId,
      };
      await this.ctx.storage.put(`dedup:${buffered.messageId}`, dedup);
      // The instance advances past the Receive Task: mark the key consumed.
      await this.markConsumed(req.instanceId, buffered.externalMessageId, req.now);
      return {
        status: "correlated",
        subscriptionId: req.subscriptionId,
        externalMessageId: buffered.externalMessageId,
        event: {
          externalMessageId: buffered.externalMessageId,
          messageName: buffered.messageName,
          correlationKey: buffered.correlationKey,
          messageId: buffered.messageId,
          payload: buffered.payload,
        },
      };
    }

    // A fresh subscription re-opens the key: any prior "consumed" marker no
    // longer applies (a new instance is now eligible to correlate).
    await this.ctx.storage.delete(CONSUMED_KEY);
    const sub: StoredSubscription = {
      subscriptionId: req.subscriptionId,
      instanceId: req.instanceId,
      workflowInstanceId: req.workflowInstanceId,
      elementId: req.elementId,
      messageName: req.messageName,
      correlationKey: req.correlationKey,
      workflowEventType: req.workflowEventType,
      expiresAt: req.expiresAt,
    };
    await this.ctx.storage.put(SUB_KEY, sub);
    return { status: "waiting", subscriptionId: req.subscriptionId };
  }

  /**
   * Supersede the active subscription when a receive-task boundary timer fires
   * (M3-L3): drop SUB_KEY iff it still belongs to this (instance, element) visit,
   * so a late publish to this broker key gets the stable buffered/no-match outcome
   * instead of correlating to the timed-out wait — preserving the
   * at-most-one-active-subscription invariant. A no-op if a newer subscription (a
   * different instance/visit) already replaced it.
   */
  async supersedeSubscription(instanceId: string, elementId: string): Promise<void> {
    const existing = await this.ctx.storage.get<StoredSubscription>(SUB_KEY);
    if (existing && existing.instanceId === instanceId && existing.elementId === elementId) {
      await this.ctx.storage.delete(SUB_KEY);
    }
  }

  async publishMessage(req: BrokerPublishRequest): Promise<BrokerPublishResult> {
    await this.expireDue(req.now);

    // Stable duplicate response: same messageId in this broker key.
    const dedup = await this.ctx.storage.get<StoredDedup>(`dedup:${req.messageId}`);
    if (dedup) {
      return {
        outcome: "duplicate",
        externalMessageId: dedup.externalMessageId,
        duplicateOf: dedup.externalMessageId,
        originalOutcome: dedup.outcome,
        instanceId: dedup.instanceId,
      };
    }

    const sub = await this.ctx.storage.get<StoredSubscription>(SUB_KEY);
    if (sub && !isExpired(sub.expiresAt, req.now)) {
      await this.ctx.storage.delete(SUB_KEY);
      const newDedup: StoredDedup = {
        externalMessageId: req.externalMessageId,
        outcome: "correlated",
        instanceId: sub.instanceId,
      };
      await this.ctx.storage.put(`dedup:${req.messageId}`, newDedup);
      // The instance advances past the Receive Task: mark the key consumed.
      await this.markConsumed(sub.instanceId, req.externalMessageId, req.now);
      return {
        outcome: "correlated",
        externalMessageId: req.externalMessageId,
        instanceId: sub.instanceId,
        workflowInstanceId: sub.workflowInstanceId,
        elementId: sub.elementId,
        subscriptionId: sub.subscriptionId,
        // Honor the subscription's STORED wake type on delivery (M3-L4, §4.5).
        workflowEventType: sub.workflowEventType,
        event: {
          externalMessageId: req.externalMessageId,
          messageName: req.messageName,
          correlationKey: req.correlationKey,
          messageId: req.messageId,
          payload: req.payload,
        },
      };
    }

    // No eligible subscription. If the key was already consumed by an instance
    // that advanced past its Receive Task, this is a LATE message — it cannot
    // correlate and is recorded (not buffered).
    const consumed = await this.ctx.storage.get<StoredConsumed>(CONSUMED_KEY);
    if (consumed) {
      await this.ctx.storage.put(`dedup:${req.messageId}`, {
        externalMessageId: req.externalMessageId,
        outcome: "late",
        instanceId: consumed.instanceId,
      } satisfies StoredDedup);
      return {
        outcome: "late",
        externalMessageId: req.externalMessageId,
        previousInstanceId: consumed.instanceId,
      };
    }

    // Early message → buffer for one hour.
    const expiresAt = isoPlusMs(req.now, ONE_HOUR_MS);
    const buffered: StoredBuffered = {
      externalMessageId: req.externalMessageId,
      workspaceId: req.workspaceId,
      messageName: req.messageName,
      correlationKey: req.correlationKey,
      messageId: req.messageId,
      payload: req.payload,
      receivedAt: req.now,
      expiresAt,
    };
    await this.ctx.storage.put(`buffer:${req.messageId}`, buffered);
    await this.ctx.storage.put(`dedup:${req.messageId}`, {
      externalMessageId: req.externalMessageId,
      outcome: "buffered",
    } satisfies StoredDedup);
    await this.scheduleAlarm(expiresAt);
    return { outcome: "buffered", externalMessageId: req.externalMessageId, expiresAt };
  }

  async expireBufferedMessages(now: string): Promise<ExpireResult> {
    return { expired: await this.expireDue(now) };
  }

  async getState(): Promise<BrokerInspection> {
    const sub = await this.ctx.storage.get<StoredSubscription>(SUB_KEY);
    const buffers = await this.ctx.storage.list<StoredBuffered>({ prefix: "buffer:" });
    const buffered = [...buffers.values()].map((b) => ({
      externalMessageId: b.externalMessageId,
      messageId: b.messageId,
      expiresAt: b.expiresAt,
    }));
    return {
      activeSubscription: sub
        ? {
            subscriptionId: sub.subscriptionId,
            instanceId: sub.instanceId,
            elementId: sub.elementId,
            messageName: sub.messageName,
            correlationKey: sub.correlationKey,
            expiresAt: sub.expiresAt,
          }
        : null,
      bufferedCount: buffered.length,
      buffered,
    };
  }

  override async alarm(): Promise<void> {
    await this.expireDue(nowIso());
    // Re-arm for the next still-pending buffered message, if any.
    await this.rearmAlarm();
  }

  private async markConsumed(
    instanceId: string,
    externalMessageId: string,
    now: string,
  ): Promise<void> {
    await this.ctx.storage.put(CONSUMED_KEY, {
      instanceId,
      externalMessageId,
      consumedAt: now,
    } satisfies StoredConsumed);
  }

  private async earliestBuffered(now: string): Promise<StoredBuffered | null> {
    const buffers = await this.ctx.storage.list<StoredBuffered>({ prefix: "buffer:" });
    let best: StoredBuffered | null = null;
    for (const buf of buffers.values()) {
      if (isExpired(buf.expiresAt, now)) continue;
      if (!best || new Date(buf.receivedAt).getTime() < new Date(best.receivedAt).getTime()) {
        best = buf;
      }
    }
    return best;
  }

  /**
   * Delete every due buffered message, mark its dedup outcome `expired`, and
   * reconcile the expiry into D1 (canonical record + history) so inspection
   * reflects that a buffered message lapsed without correlating.
   */
  private async expireDue(now: string): Promise<ExpiredMessage[]> {
    const buffers = await this.ctx.storage.list<StoredBuffered>({ prefix: "buffer:" });
    const expired: ExpiredMessage[] = [];
    for (const [key, buf] of buffers) {
      if (!isExpired(buf.expiresAt, now)) continue;
      await this.ctx.storage.delete(key);
      await this.ctx.storage.put(`dedup:${buf.messageId}`, {
        externalMessageId: buf.externalMessageId,
        outcome: "expired",
      } satisfies StoredDedup);
      // Canonical reconciliation: the operator source of record is D1, not the DO.
      await markMessageExpired(this.env.DB, buf.externalMessageId, now);
      await recordHistory(this.env.DB, {
        workspaceId: buf.workspaceId,
        externalMessageId: buf.externalMessageId,
        type: "messageExpired",
        diagnostics: {
          messageId: buf.messageId,
          reason: "Buffered message expired before a matching Receive Task became eligible.",
        },
        payloadSnapshot: buf.payload,
      });
      expired.push({ externalMessageId: buf.externalMessageId, messageId: buf.messageId });
    }
    return expired;
  }

  private async scheduleAlarm(at: string): Promise<void> {
    const target = new Date(at).getTime();
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  /** Set the alarm to the earliest still-pending buffered message expiry. */
  private async rearmAlarm(): Promise<void> {
    const buffers = await this.ctx.storage.list<StoredBuffered>({ prefix: "buffer:" });
    let earliest: number | null = null;
    for (const buf of buffers.values()) {
      const t = new Date(buf.expiresAt).getTime();
      if (earliest === null || t < earliest) earliest = t;
    }
    if (earliest !== null) await this.ctx.storage.setAlarm(earliest);
  }
}
