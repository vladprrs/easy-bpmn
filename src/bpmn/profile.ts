// BPMN-lite profile constants (the whitelist) and naming helpers.
// Source of truth: docs/bpmn/09-easy-bpmn-profile.md + the constitution.

import type { NodeType } from "./graph";

/** Supported flow-node moddle $types → our normalized node type. */
export const SUPPORTED_NODE_TYPES: Record<string, NodeType> = {
  "bpmn:StartEvent": "startEvent",
  "bpmn:ServiceTask": "serviceTask",
  "bpmn:ReceiveTask": "receiveTask",
  "bpmn:EndEvent": "endEvent",
  // SAGA (M0): the transaction scope and its boundary events.
  "bpmn:Transaction": "transaction",
  "bpmn:BoundaryEvent": "boundaryEvent",
  // M2 conditional sagas (TASK-33): data-driven XOR branching. Split flows
  // carry FEEL conditions + an optional gateway-owned default; the validator
  // enforces the split/default/condition rules (validator.ts).
  "bpmn:ExclusiveGateway": "exclusiveGateway",
  // M3-L4: an intermediateCatchEvent is a token-path catch — a TIMER delay
  // (TASK-45) or a MESSAGE correlation wait (TASK-46, receive-task semantics).
  // The validator handles it in its own event-definition-aware branch (timer +
  // message both open) before this lookup, so this entry is the type mapping,
  // not the accept gate.
  "bpmn:IntermediateCatchEvent": "intermediateCatchEvent",
  // M3-L4 (TASK-46): an eventBasedGateway races timer/message branch catches,
  // deciding deterministically on a gateway_decisions row. The validator opens
  // it in its own branch-target-aware block (≥2 branches, every target a
  // single-incoming intermediate catch, ≤1 timer branch, distinct messages,
  // instantiate/Parallel rejected); this entry is the type mapping.
  "bpmn:EventBasedGateway": "eventBasedGateway",
};

export const SEQUENCE_FLOW_TYPE = "bpmn:SequenceFlow";
export const ASSOCIATION_TYPE = "bpmn:Association";
export const ERROR_TYPE = "bpmn:Error";

/**
 * Gateway types OUTSIDE the profile, each with its roadmap pointer (saga design
 * §8): parallel/inclusive need multiple concurrent tokens (M4 concurrency),
 * complex is not on the roadmap. The validator rejects these with element id +
 * this reason. (eventBasedGateway is IN since M3-L4 — it has its own
 * branch-target-aware accept block in the validator, no longer deferred here.)
 */
export const DEFERRED_GATEWAY_REASONS: Record<string, string> = {
  "bpmn:ParallelGateway":
    "Parallel (AND) gateways need concurrent tokens, which are deferred to concurrency (M4). " +
    "Only exclusiveGateway branching is supported.",
  "bpmn:InclusiveGateway":
    "Inclusive (OR) gateways activate multiple branches at once and are deferred to concurrency (M4). " +
    "Only exclusiveGateway branching is supported.",
  "bpmn:ComplexGateway":
    "Complex gateways are not on the roadmap and are deferred to a later milestone. " +
    "Only exclusiveGateway branching is supported.",
};

/** Event-definition $types we classify (start/end/boundary discriminators). */
export const COMPENSATE_EVENT_DEFINITION = "bpmn:CompensateEventDefinition";
export const ERROR_EVENT_DEFINITION = "bpmn:ErrorEventDefinition";
export const CANCEL_EVENT_DEFINITION = "bpmn:CancelEventDefinition";
/** M3-L3: an interrupting boundary timer carries a single timerEventDefinition. */
export const TIMER_EVENT_DEFINITION = "bpmn:TimerEventDefinition";
/** M3-L4: a message intermediate catch (TASK-46, opened) / EBG message branch (EBG follow-up) carries this. */
export const MESSAGE_EVENT_DEFINITION = "bpmn:MessageEventDefinition";

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
 * symmetrically at registration and delivery for a `receiveTask` / standalone
 * message intermediate catch, so the derived type always matches.
 *
 * EBG EXCEPTION (M3-L4, TASK-46): an `eventBasedGateway` registers ALL its
 * message-branch subscriptions on ONE per-visit wait type
 * (`workflowEventGatewayTypeFor`) so a single `waitForEvent` can be woken by any
 * branch (or the timer branch). For those subscriptions the symmetry is relaxed:
 * the delivery path honors the STORED `message_subscriptions.workflow_event_type`
 * instead of re-deriving it from the message name (the receive-task / standalone
 * path keeps re-deriving and stays byte-identical — its stored value equals the
 * derived one).
 */
export function workflowEventTypeFor(messageName: string): string {
  const safe = messageName.replace(/[^A-Za-z0-9_-]/g, "_");
  return `bpmn_message_${safe}`.slice(0, 100);
}

/**
 * Workflow event type an `eventBasedGateway` visit waits on (M3-L4, TASK-46,
 * design §4.5): a PER-VISIT type derived from `gatewayId#occurrence` through the
 * SAME sanitizer (dot-free, ≤100 chars). EVERY message-branch subscription of
 * the visit stores THIS value in `message_subscriptions.workflow_event_type`, and
 * the eventGateway timer wakes on it too — so a single workflow-mode
 * `waitForEvent` is woken by whichever branch (message correlation or timer fire)
 * resolves first. Each visit (occurrence) of a cyclic EBG gets its own type.
 */
export function workflowEventGatewayTypeFor(gatewayId: string, occurrence: number): string {
  const safe = `${gatewayId}#${occurrence}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return `bpmn_ebg_${safe}`.slice(0, 100);
}

/**
 * Workflow event type a Service-Task-as-wait waits on, one per logical job.
 * Same Cloudflare constraints as message events (dot-free, ≤100 chars); jobIds
 * are already `job_<uuid>` so sanitizing is defensive.
 */
export function workflowJobEventTypeFor(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `bpmn_job_${safe}`.slice(0, 100);
}

/**
 * Workflow event type a timer intermediateCatchEvent waits on (M3-L4, design
 * §4.1/§4.4): a PER-VISIT type derived from `elementId#occurrence` through the
 * SAME sanitizer (dot-free, ≤100 chars). Applied symmetrically at the catch's
 * park-wait and at `fireTimer`'s `sendEvent` wake, so the derived type always
 * matches. Each visit (occurrence) of a cyclic catch gets its own event type.
 */
export function workflowTimerEventTypeFor(elementId: string, occurrence: number): string {
  const safe = `${elementId}#${occurrence}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return `bpmn_timer_${safe}`.slice(0, 100);
}
