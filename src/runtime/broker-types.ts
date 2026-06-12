// RPC contract for the Correlation Broker Durable Object. Shared by the Worker
// (caller) and the DO (implementation). All shapes are structured-clone safe.

import type { MessageEventPayload } from "../contracts/workflow-events";

export interface RegisterSubscriptionRequest {
  workspaceId: string;
  instanceId: string;
  workflowInstanceId: string;
  elementId: string;
  subscriptionId: string;
  messageName: string;
  correlationKey: string;
  workflowEventType: string;
  expiresAt: string;
  now: string;
}

export type RegisterSubscriptionResult =
  | { status: "waiting"; subscriptionId: string }
  | {
      status: "correlated";
      subscriptionId: string;
      externalMessageId: string;
      event: MessageEventPayload;
    }
  | { status: "rejected"; reason: string; existingInstanceId?: string };

export interface BrokerPublishRequest {
  workspaceId: string;
  messageName: string;
  correlationKey: string;
  messageId: string;
  externalMessageId: string;
  payload: Record<string, unknown>;
  now: string;
}

export type BrokerPublishResult =
  | {
      outcome: "correlated";
      externalMessageId: string;
      instanceId: string;
      workflowInstanceId: string;
      elementId: string;
      subscriptionId: string;
      // The STORED Workflow wake type of the matched subscription (M3-L4, TASK-46,
      // design §4.5): the delivery path sends `sendEvent` on THIS type rather than
      // re-deriving it from the message name. For a receiveTask / standalone catch
      // it equals workflowEventTypeFor(messageName) (byte-identical, no change); for
      // an eventBasedGateway branch it is the per-visit gateway type so ONE
      // waitForEvent is woken by whichever branch resolves.
      workflowEventType: string;
      event: MessageEventPayload;
    }
  | { outcome: "buffered"; externalMessageId: string; expiresAt: string }
  | {
      outcome: "duplicate";
      externalMessageId: string;
      duplicateOf: string;
      originalOutcome: string;
      instanceId?: string;
    }
  | {
      // A different messageId arrived for a broker key whose instance already
      // advanced past the Receive Task. It cannot correlate; recorded as `late`.
      outcome: "late";
      externalMessageId: string;
      previousInstanceId: string;
    };

export interface ExpiredMessage {
  externalMessageId: string;
  messageId: string;
}

export interface ExpireResult {
  expired: ExpiredMessage[];
}

export interface BrokerInspection {
  activeSubscription:
    | {
        subscriptionId: string;
        instanceId: string;
        elementId: string;
        messageName: string;
        correlationKey: string;
        expiresAt: string;
      }
    | null;
  bufferedCount: number;
  buffered: {
    externalMessageId: string;
    messageId: string;
    expiresAt: string;
  }[];
}

/** Stable broker key for a correlation atom: workspace + message + correlation key. */
export function brokerKeyOf(
  workspaceId: string,
  messageName: string,
  correlationKey: string,
): string {
  return `${workspaceId}::${messageName}::${correlationKey}`;
}
