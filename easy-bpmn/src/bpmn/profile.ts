// BPMN-lite profile constants (the whitelist) and naming helpers.
// Source of truth: docs/bpmn/09-easy-bpmn-profile.md + the constitution.

import type { NodeType } from "./graph";

/** Supported flow-node moddle $types → our normalized node type. */
export const SUPPORTED_NODE_TYPES: Record<string, NodeType> = {
  "bpmn:StartEvent": "startEvent",
  "bpmn:ServiceTask": "serviceTask",
  "bpmn:ReceiveTask": "receiveTask",
  "bpmn:EndEvent": "endEvent",
};

export const SEQUENCE_FLOW_TYPE = "bpmn:SequenceFlow";

/** Human-friendly element type name, e.g. "bpmn:UserTask" → "userTask". */
export function localTypeName($type: string): string {
  const idx = $type.indexOf(":");
  const local = idx >= 0 ? $type.slice(idx + 1) : $type;
  if ($type.startsWith("bpmn:")) {
    return local.charAt(0).toLowerCase() + local.slice(1);
  }
  return $type;
}

/** Default Service Task attempt budget when easy-bpmn:taskDefinition omits `retries`. */
export const DEFAULT_SERVICE_TASK_ATTEMPTS = 1;

/**
 * Workflow event type a Receive Task waits on, derived from the message name.
 *
 * Cloudflare Workflows constrain `waitForEvent`/`sendEvent` event types to
 * `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, max 100 chars (no dots). We sanitize the
 * message name and use an underscore-delimited prefix. The function is applied
 * symmetrically at registration and delivery, so the derived type always matches.
 */
export function workflowEventTypeFor(messageName: string): string {
  const safe = messageName.replace(/[^A-Za-z0-9_-]/g, "_");
  return `bpmn_message_${safe}`.slice(0, 100);
}
