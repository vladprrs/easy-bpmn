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
  // M4 concurrency (TASK-48): block-structured AND/OR splits. The validator opens
  // them in its own classification + region-validation passes (SESE-gated); these
  // entries are the type mapping, not the accept gate.
  "bpmn:ParallelGateway": "parallelGateway",
  "bpmn:InclusiveGateway": "inclusiveGateway",
};

export const SEQUENCE_FLOW_TYPE = "bpmn:SequenceFlow";
export const ASSOCIATION_TYPE = "bpmn:Association";
export const ERROR_TYPE = "bpmn:Error";

/**
 * Gateway types OUTSIDE the profile, each with its roadmap pointer (saga design
 * §8): complex is not on the roadmap. The validator rejects these with element id
 * + this reason. (parallelGateway / inclusiveGateway are IN since M4-L1 (TASK-48)
 * — block-structured (SESE) AND/OR splits, opened in the validator's own
 * classification + region-validation passes; eventBasedGateway is IN since M3-L4
 * — both have their own accept blocks in the validator, no longer deferred here.)
 */
export const DEFERRED_GATEWAY_REASONS: Record<string, string> = {
  "bpmn:ComplexGateway":
    "Complex gateways are not on the roadmap and are deferred to a later milestone. " +
    "Supported gateways: exclusiveGateway (M2), eventBasedGateway (M3), and the " +
    "block-structured (SESE) parallelGateway / inclusiveGateway (M4).",
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

// Per-type Workflow event-type derivation (workflowEventTypeFor /
// workflowEventGatewayTypeFor / workflowJobEventTypeFor / workflowTimerEventTypeFor)
// was REMOVED in TASK-54: the engine collapsed onto a SINGLE replay-stable wake on
// the constant `WAKE_TYPE` ("bpmn_wake", src/runtime/wake.ts). Every sendEvent /
// waitForEvent now uses that one type, so no per-message / per-job / per-timer /
// per-gateway type is needed. The `message_subscriptions.workflow_event_type` column
// is kept (written WAKE_TYPE) as a vestige — no migration, no behaviour change.
