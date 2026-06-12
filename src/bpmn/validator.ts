// The easy-bpmn profile gate. Parses BPMN XML, accepts-and-validates the
// canonical-saga construct set (SAGA design §3), rejects unsupported
// standard-namespace flow nodes/structures with element-level reasons, tolerates
// ignorable extension content (foreign extensions / DI / documentation / text
// annotations), and extracts an immutable execution graph snapshot — always for
// accepted documents, and best-effort for rejected ones (see ValidationResult).
//
// M2 (conditional sagas, TASK-33) opens the accept matrix for data-driven XOR
// branching (M2 design §3): exclusiveGateway is accepted-and-validated (split
// rules: every non-default outgoing flow carries a publish-time-FEEL-parsed
// condition; the gateway-owned `default` carries none and must reference one of
// the gateway's own outgoing flows), and cycles on the token path are legal.
// Conditions anywhere else, defaults on non-gateways, implicit multi-out
// splits, boundary events on gateways, and the other gateway types
// (parallel/inclusive/eventBased/complex) stay rejected with element id +
// reason.

import type { ModdleElement } from "bpmn-moddle";
import { parseBpmnXml } from "./parser";
import { TASK_DEFINITION_TYPE } from "./moddle-extension";
import { parseCondition } from "../runtime/expressions";
import { isValidIso8601DateTime, parseIso8601DurationMs } from "../runtime/iso8601";
import {
  ASSOCIATION_TYPE,
  CANCEL_EVENT_DEFINITION,
  COMPENSATE_EVENT_DEFINITION,
  DEFAULT_SERVICE_TASK_ATTEMPTS,
  DEFERRED_GATEWAY_REASONS,
  ERROR_EVENT_DEFINITION,
  ERROR_TYPE,
  MESSAGE_EVENT_DEFINITION,
  SEQUENCE_FLOW_TYPE,
  SUPPORTED_NODE_TYPES,
  TIMER_EVENT_DEFINITION,
  localTypeName,
} from "./profile";
import type {
  AssociationLink,
  BoundaryKind,
  EndKind,
  ErrorDeclaration,
  ExecutionGraph,
  Flow,
  GraphElement,
  GraphNode,
  NodeType,
  TimerTriggerSpec,
  TransactionScope,
  ValidationIssueData,
  ValidationResult,
} from "./graph";

function refId(ref: unknown): string | undefined {
  if (ref == null) return undefined;
  if (typeof ref === "string") return ref;
  if (typeof ref === "object" && ref !== null && "id" in ref) {
    const id = (ref as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Reads the easy-bpmn:taskDefinition (type + retries) from a Service Task. */
function readTaskDefinition(
  node: ModdleElement,
): { type?: string; attempts: number } {
  const ext = node.extensionElements as ModdleElement | undefined;
  const values = asArray<ModdleElement>(ext?.values);
  const def = values.find((v) => v.$type === TASK_DEFINITION_TYPE);
  if (!def) return { attempts: DEFAULT_SERVICE_TASK_ATTEMPTS };
  const type = typeof def.type === "string" ? def.type.trim() : undefined;
  const parsed = parseInt(String(def.retries ?? ""), 10);
  const attempts =
    Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_SERVICE_TASK_ATTEMPTS;
  return { type: type && type.length > 0 ? type : undefined, attempts };
}

/**
 * Validate a model timer's `<timerEventDefinition>` (boundary or intermediate
 * catch — M3-L3/L4 design §3/§4.4): it MUST carry exactly ONE of
 * `timeDate`|`timeDuration`, each a STATIC ISO-8601 literal that parses. Zero/two
 * time children, a `timeCycle`, a FEEL expression, or a non-parsing literal are
 * each rejected with a reason (the caller adds element id + construct name, so the
 * reason text stays construct-neutral).
 */
function readTimerTrigger(
  def: ModdleElement,
): { ok: true; trigger: TimerTriggerSpec } | { ok: false; reason: string } {
  const bodyOf = (x: unknown): string | undefined => {
    const e = x as ModdleElement | undefined | null;
    return e != null && typeof e.body === "string" && e.body.trim() !== "" ? e.body.trim() : undefined;
  };
  if (def.timeCycle != null) {
    return { ok: false, reason: "uses a timeCycle (repetition needs extra tokens — M4+); use a single static timeDate or timeDuration." };
  }
  const date = bodyOf(def.timeDate);
  const duration = bodyOf(def.timeDuration);
  const present = (date !== undefined ? 1 : 0) + (duration !== undefined ? 1 : 0);
  if (present === 0) {
    return { ok: false, reason: "has no timeDate or timeDuration; a timer needs exactly one static ISO-8601 timeDate or timeDuration." };
  }
  if (present === 2) {
    return { ok: false, reason: "declares both a timeDate and a timeDuration; exactly one is required." };
  }
  if (duration !== undefined) {
    if (parseIso8601DurationMs(duration) == null) {
      return { ok: false, reason: `has a timeDuration '${duration}' that is not a static ISO-8601 duration literal (FEEL expressions are not supported).` };
    }
    return { ok: true, trigger: { kind: "timeDuration", value: duration } };
  }
  if (!isValidIso8601DateTime(date!)) {
    return { ok: false, reason: `has a timeDate '${date}' that is not a static ISO-8601 date/datetime literal (FEEL expressions are not supported).` };
  }
  return { ok: true, trigger: { kind: "timeDate", value: date! } };
}

// ---------------------------------------------------------------------------
// Internal classification model
// ---------------------------------------------------------------------------

interface NodeInfo {
  id: string;
  type: NodeType;
  name?: string;
  taskType?: string;
  attempts?: number;
  messageName?: string;
  /** Enclosing scope id: the processId at top level, or a transaction id. */
  scopeId: string;
  isForCompensation?: boolean;
  endKind?: EndKind;
  boundaryKind?: BoundaryKind;
  attachedToRef?: string;
  errorRef?: string;
  errorCode?: string;
  /** timer boundaryEvent only — the validated static ISO-8601 trigger (M3-L3). */
  timerTrigger?: TimerTriggerSpec;
  /** exclusiveGateway only — the sequence-flow id named by the `default` attribute. */
  defaultFlowId?: string;
}

interface FlowInfo {
  id: string;
  source?: string;
  target?: string;
  scopeId: string;
  /**
   * Raw FEEL body of the flow's <conditionExpression> (tFormalExpression text,
   * trimmed; empty/whitespace-only bodies normalize to undefined — see the
   * capture site).
   */
  conditionExpression?: string;
  /**
   * True when the flow carries a <conditionExpression> ELEMENT at all, even an
   * empty one. The conditions-only-on-gateway-flows rule rejects on element
   * presence (M1 strictness); the gateway split rules work on the normalized
   * body above (empty == condition-less).
   */
  hasConditionElement: boolean;
  /** The condition's `language` attribute, when set (must be unset or FEEL). */
  conditionLanguage?: string;
}

interface AssocInfo {
  id: string;
  source?: string;
  target?: string;
  scopeId: string;
}

interface ScopeInfo {
  id: string;
  kind: "process" | "transaction";
}

const SUPPORTED_HINT =
  "Supported flow nodes: start event, service task, receive task, end event, " +
  "exclusive gateway, transaction (saga scope), and compensation/error/cancel boundary events.";

export async function parseAndValidate(xml: string): Promise<ValidationResult> {
  const parsed = await parseBpmnXml(xml);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: [{ severity: "error", elementName: "definitions", reason: parsed.error }],
    };
  }

  const issues: ValidationIssueData[] = [];
  const err = (
    reason: string,
    elementId?: string | null,
    elementName?: string,
  ) =>
    issues.push({
      severity: "error",
      reason,
      elementId: elementId ?? null,
      elementName: elementName ?? "element",
    });

  // A `default` attribute naming a flow that does not EXIST never reaches the
  // moddle tree — bpmn-moddle drops the reference and records an "unresolved
  // reference" warning instead. Surface those as publish errors here; a default
  // that resolves but names a flow not leaving its own gateway is caught by the
  // gateway rules below.
  //
  // CAUTION: the warning shape (`property: "bpmn:default"`, `message:
  // "unresolved reference <id>"`) is moddle-INTERNAL and version-coupled, not
  // a public contract — it is pinned by the "rejects a default referencing a
  // MISSING flow" unit test, which must break loudly on a bpmn-moddle upgrade
  // that reshapes it. We require BOTH the property name and a loose
  // unresolved-reference message match so an unrelated future warning that
  // happens to carry `property: "bpmn:default"` does not false-positive.
  //
  // NOTE: this loop runs over warnings for the WHOLE definitions tree, before
  // the executable process is selected below — a dangling default in a
  // non-selected process also rejects. That is deliberately conservative: a
  // broken reference anywhere in the file is modeler error, not noise.
  for (const w of parsed.warnings as Array<{
    message?: string;
    property?: string;
    value?: unknown;
    element?: { id?: string; $type?: string };
  }>) {
    if (w?.property === "bpmn:default" && typeof w.message === "string" && /unresolved reference/i.test(w.message)) {
      const elId = w.element?.id ?? null;
      err(
        `Element '${elId ?? "(no id)"}' declares default flow '${String(w.value)}', which does not exist in the model.`,
        elId,
        w.element?.$type ? localTypeName(w.element.$type) : "element",
      );
    }
  }

  // An `errorRef` on an <errorEventDefinition> that names a non-existent <error>
  // is DROPPED by bpmn-moddle (exactly like an unresolved `default`), leaving the
  // parsed boundary indistinguishable from a genuine catch-all (no errorRef).
  // Recover those dangling refs from the parser warnings — keyed by the OWNING
  // boundary event id (the warning's element is the errorEventDefinition; its
  // $parent is the boundary) — so the error-boundary rules can reject them with
  // an element id instead of silently accepting a hidden catch-all (M3-L2).
  //
  // CAUTION: like the `bpmn:default` block above, the warning shape
  // (`property: "bpmn:errorRef"`, the `$parent` boundary id) is moddle-INTERNAL
  // and version-coupled, not a public contract — it is pinned by the "rejects an
  // error boundary whose errorRef does not resolve" unit test, which must break
  // loudly on a bpmn-moddle upgrade that reshapes it.
  const danglingErrorRef = new Map<string, string>();
  for (const w of parsed.warnings as Array<{
    message?: string;
    property?: string;
    value?: unknown;
    element?: { $parent?: { id?: string; $type?: string } };
  }>) {
    if (w?.property === "bpmn:errorRef" && typeof w.message === "string" && /unresolved reference/i.test(w.message)) {
      const owner = w.element?.$parent;
      if (owner?.$type === "bpmn:BoundaryEvent" && typeof owner.id === "string") {
        danglingErrorRef.set(owner.id, String(w.value));
      }
    }
  }

  const definitions = parsed.definitions;
  const rootElements = asArray<ModdleElement>(definitions.rootElements);

  // Collaborations (pools/lanes/participants/choreography) are out of profile.
  for (const root of rootElements) {
    if (root.$type === "bpmn:Collaboration" || root.$type === "bpmn:Choreography") {
      err(
        "Collaborations, pools, and participants are not supported. easy-bpmn runs a single executable process.",
        (root.id as string) ?? null,
        localTypeName(root.$type),
      );
    }
  }

  // Root <message> elements, keyed id → name.
  const messageNamesById = new Map<string, string>();
  for (const root of rootElements) {
    if (root.$type === "bpmn:Message") {
      messageNamesById.set(root.id as string, (root.name as string) ?? "");
    }
  }

  // Root <error> elements, keyed id → { name, errorCode }.
  const errorsById = new Map<string, ErrorDeclaration>();
  for (const root of rootElements) {
    if (root.$type === ERROR_TYPE) {
      const id = root.id as string;
      errorsById.set(id, {
        id,
        name: (root.name as string) ?? null,
        errorCode: (root.errorCode as string) ?? null,
      });
    }
  }

  // Select the single executable process.
  const processes = rootElements.filter((r) => r.$type === "bpmn:Process");
  const executable = processes.filter((p) => p.isExecutable === true);
  let proc: ModdleElement | undefined;
  if (executable.length === 1) {
    proc = executable[0];
  } else if (executable.length > 1) {
    err("Multiple executable processes found. easy-bpmn supports exactly one executable process.");
  } else if (processes.length === 1) {
    proc = processes[0];
  } else if (processes.length === 0) {
    err("No <process> element found.");
  } else {
    err("No single executable <process isExecutable=\"true\"> could be identified.");
  }

  if (!proc) {
    return { ok: false, issues: dedupeIssues(issues) };
  }

  const processId = (proc.id as string) ?? "process";

  // Lanes inside the process are out of profile.
  if (asArray<ModdleElement>(proc.laneSets).length > 0) {
    err("Lanes are not supported.", processId, "laneSet");
  }

  // -------------------------------------------------------------------------
  // Recursive classification (scope-aware)
  // -------------------------------------------------------------------------
  const nodes: NodeInfo[] = [];
  const flows: FlowInfo[] = [];
  const associations: AssocInfo[] = [];
  const scopes: ScopeInfo[] = [];
  const messageElements: { id: string; name: string }[] = [];
  for (const [id, name] of messageNamesById) messageElements.push({ id, name });

  const classifyEventDefinition = (el: ModdleElement): {
    defs: ModdleElement[];
    only: string | undefined;
  } => {
    const defs = asArray<ModdleElement>(el.eventDefinitions);
    return { defs, only: defs.length === 1 ? defs[0]!.$type : undefined };
  };

  const classifyContainer = (
    container: ModdleElement,
    scopeId: string,
    scopeKind: "process" | "transaction",
  ): void => {
    scopes.push({ id: scopeId, kind: scopeKind });

    // Associations live in `artifacts`, not `flowElements`. Other artifacts
    // (text annotations, groups) are ignorable like DI — tolerated, not parsed.
    for (const art of asArray<ModdleElement>(container.artifacts)) {
      if (art.$type === ASSOCIATION_TYPE) {
        associations.push({
          id: (art.id as string) ?? "",
          source: refId(art.sourceRef),
          target: refId(art.targetRef),
          scopeId,
        });
      }
    }

    for (const el of asArray<ModdleElement>(container.flowElements)) {
      const id = (el.id as string) ?? null;
      const $type = el.$type;

      if ($type === SEQUENCE_FLOW_TYPE) {
        // M2 graph IR: capture the FEEL condition body (tFormalExpression
        // text, TRIMMED — pretty-printed XML carries leading newlines/indent)
        // so the builder can emit live conditional edges.
        //
        // NOTE: an empty/whitespace-only <conditionExpression> body is
        // normalized to undefined here — for the gateway split rules it is
        // indistinguishable from "no condition at all" and lands in the
        // non-default-condition-less reject bucket (the message covers both
        // shapes). `hasConditionElement` keeps the raw element presence for
        // the conditions-only-on-gateway-flows rule.
        const cond = el.conditionExpression as ModdleElement | undefined | null;
        const condBody =
          cond != null && typeof cond.body === "string" && cond.body.trim() !== ""
            ? cond.body.trim()
            : undefined;
        flows.push({
          id: id ?? "",
          source: refId(el.sourceRef),
          target: refId(el.targetRef),
          scopeId,
          conditionExpression: condBody,
          hasConditionElement: cond != null,
          conditionLanguage:
            cond != null && typeof cond.language === "string" && cond.language.trim() !== ""
              ? cond.language.trim()
              : undefined,
        });
        continue;
      }

      // Gateway types outside the M2 profile reject with a roadmap pointer
      // (parallel/inclusive → concurrency M4, eventBased → timers/events M3,
      // complex → not on the roadmap) instead of the generic unsupported hint.
      const deferredGateway = DEFERRED_GATEWAY_REASONS[$type];
      if (deferredGateway) {
        err(
          `Element '${id ?? "(no id)"}' (${localTypeName($type)}) is not supported in this profile. ${deferredGateway}`,
          id,
          localTypeName($type),
        );
        continue;
      }

      // Transaction scope — a node on the parent token path; recurse into it.
      if ($type === "bpmn:Transaction") {
        if (el.loopCharacteristics != null) {
          err(
            `Transaction '${id ?? "(no id)"}' has loop or multi-instance characteristics, which are not supported.`,
            id,
            "transaction",
          );
        }
        nodes.push({ id: id ?? "", type: "transaction", name: (el.name as string) ?? undefined, scopeId });
        classifyContainer(el, id ?? "", "transaction");
        continue;
      }

      if ($type === "bpmn:BoundaryEvent") {
        const { defs, only } = classifyEventDefinition(el);
        const attachedToRef = refId(el.attachedToRef);
        let boundaryKind: BoundaryKind | undefined;
        if (only === COMPENSATE_EVENT_DEFINITION) boundaryKind = "compensate";
        else if (only === ERROR_EVENT_DEFINITION) boundaryKind = "error";
        else if (only === CANCEL_EVENT_DEFINITION) boundaryKind = "cancel";
        else if (only === TIMER_EVENT_DEFINITION) boundaryKind = "timer";

        if (!boundaryKind) {
          const what = defs.length === 0
            ? "no event definition"
            : defs.length > 1
              ? "multiple event definitions"
              : `a ${localTypeName(defs[0]!.$type)}`;
          err(
            `Boundary event '${id ?? ""}' has ${what}. Only timer, compensation, error, and cancel boundary events are supported ` +
              "(signal/escalation/conditional/message boundary events are deferred).",
            id,
            "boundaryEvent",
          );
          continue;
        }
        const errorRef = boundaryKind === "error" ? refId((defs[0] as ModdleElement).errorRef) : undefined;

        // M3-L3: an interrupting boundary timer carries a single STATIC ISO-8601
        // trigger. cancelActivity="false" (non-interrupting) and a malformed /
        // FEEL / timeCycle trigger are each rejected with element id + reason.
        let timerTrigger: TimerTriggerSpec | undefined;
        if (boundaryKind === "timer") {
          if (el.cancelActivity === false) {
            err(
              `Boundary timer '${id ?? ""}' has cancelActivity="false". A non-interrupting boundary needs a second token — deferred to concurrency (M4); only interrupting boundary timers are supported.`,
              id,
              "boundaryEvent",
            );
          }
          const result = readTimerTrigger(defs[0] as ModdleElement);
          if (!result.ok) {
            err(`Boundary timer '${id ?? ""}' ${result.reason}`, id, "boundaryEvent");
          } else {
            timerTrigger = result.trigger;
          }
        }

        nodes.push({
          id: id ?? "",
          type: "boundaryEvent",
          name: (el.name as string) ?? undefined,
          scopeId,
          boundaryKind,
          attachedToRef,
          errorRef,
          timerTrigger,
        });
        continue;
      }

      // M3-L4 (TASK-45): a TIMER intermediateCatchEvent is a delay step on the
      // token path (design §4.4) — opened here. A MESSAGE intermediateCatchEvent
      // and the eventBasedGateway stay rejected with reason `M3 — not yet
      // implemented` until TASK-46. Event-definition-aware, like the boundary
      // branch above, so only the timer variant becomes a token node.
      if ($type === "bpmn:IntermediateCatchEvent") {
        const { defs, only } = classifyEventDefinition(el);
        if (only === TIMER_EVENT_DEFINITION) {
          const result = readTimerTrigger(defs[0] as ModdleElement);
          if (!result.ok) {
            err(`Intermediate catch event '${id ?? ""}' ${result.reason}`, id, "intermediateCatchEvent");
          }
          nodes.push({
            id: id ?? "",
            type: "intermediateCatchEvent",
            name: (el.name as string) ?? undefined,
            scopeId,
            timerTrigger: result.ok ? result.trigger : undefined,
          });
          continue;
        }
        if (only === MESSAGE_EVENT_DEFINITION) {
          err(
            `Intermediate catch event '${id ?? ""}' carries a messageEventDefinition. Message intermediate catch events are accepted in constitution v2.2.0 but their runtime is not yet implemented (M3 — not yet implemented); use a timer intermediate catch, or a receiveTask.`,
            id,
            "intermediateCatchEvent",
          );
          continue;
        }
        const what = defs.length === 0
          ? "no event definition"
          : defs.length > 1
            ? "multiple event definitions"
            : `a ${localTypeName(defs[0]!.$type)}`;
        err(
          `Intermediate catch event '${id ?? ""}' has ${what}. Only a timer intermediate catch (a single timerEventDefinition) is supported; the message intermediate catch is accepted in v2.2.0 but not yet implemented (M3 — not yet implemented).`,
          id,
          "intermediateCatchEvent",
        );
        continue;
      }

      const nodeType = SUPPORTED_NODE_TYPES[$type];
      if (!nodeType) {
        err(
          `Element '${id ?? "(no id)"}' (${localTypeName($type)}) is not supported in this profile. ${SUPPORTED_HINT}`,
          id,
          localTypeName($type),
        );
        continue;
      }

      // A `default` flow is gateway-owned branch selection (M2 design §2
      // decision 3): valid ONLY on an exclusiveGateway. On any other node it
      // stays rejected (an activity default is implicit-split semantics).
      if (el.default != null && nodeType !== "exclusiveGateway") {
        err(
          `Element '${id ?? "(no id)"}' (${localTypeName($type)}) declares a default sequence flow. ` +
            "A default flow is only supported on an exclusiveGateway.",
          id,
          localTypeName($type),
        );
      }

      // Multi-instance / loop characteristics on an activity are out of profile.
      if (el.loopCharacteristics != null) {
        err(
          `Element '${id ?? "(no id)"}' has loop or multi-instance characteristics, which are not supported.`,
          id,
          localTypeName($type),
        );
      }

      const info: NodeInfo = {
        id: id ?? "",
        type: nodeType,
        name: (el.name as string) ?? undefined,
        scopeId,
      };

      if (nodeType === "exclusiveGateway") {
        info.defaultFlowId = refId(el.default);
      }

      if (nodeType === "startEvent") {
        if (asArray<ModdleElement>(el.eventDefinitions).length > 0) {
          const def = asArray<ModdleElement>(el.eventDefinitions)[0];
          err(
            `Start event '${id ?? ""}' has a ${def ? localTypeName(def.$type) : "event definition"}. ` +
              "Only none start events are supported; start instances via the API instead.",
            id,
            "startEvent",
          );
        }
      }

      if (nodeType === "endEvent") {
        const { defs, only } = classifyEventDefinition(el);
        if (defs.length === 0) {
          info.endKind = "none";
        } else if (only === CANCEL_EVENT_DEFINITION) {
          info.endKind = "cancel"; // validated against scope below
        } else {
          err(
            `End event '${id ?? ""}' has a ${defs.length === 1 ? localTypeName(defs[0]!.$type) : "event definition"}. ` +
              "Only a none end event or a cancel end event (inside a transaction) is supported.",
            id,
            "endEvent",
          );
          info.endKind = "none";
        }
      }

      if (nodeType === "serviceTask") {
        const def = readTaskDefinition(el);
        if (!def.type) {
          err(
            `Service task '${id ?? ""}' has no easy-bpmn:taskDefinition type. Declare a worker type in ` +
              "<extensionElements>; routing by id/name is not supported.",
            id,
            "serviceTask",
          );
        }
        info.taskType = def.type;
        info.attempts = def.attempts;
        info.isForCompensation = el.isForCompensation === true;
      }

      if (nodeType === "receiveTask") {
        if (el.isForCompensation === true) {
          err(
            `Receive task '${id ?? ""}' is marked isForCompensation; only service tasks may be compensation handlers.`,
            id,
            "receiveTask",
          );
        }
        if (el.instantiate === true) {
          err(
            `Receive task '${id ?? ""}' has instantiate="true". Instances start via the API only; remove instantiate.`,
            id,
            "receiveTask",
          );
        }
        const msgId = refId(el.messageRef);
        const msgName = msgId ? messageNamesById.get(msgId) : undefined;
        if (!msgId || msgName === undefined) {
          err(`Receive task '${id ?? ""}' must reference a declared <message> via messageRef.`, id, "receiveTask");
        } else if (msgName.trim() === "") {
          err(
            `Receive task '${id ?? ""}' references a <message> with no name; a non-empty message name is required for correlation.`,
            id,
            "receiveTask",
          );
        } else {
          info.messageName = msgName;
        }
      }

      nodes.push(info);
    }
  };

  classifyContainer(proc, processId, "process");

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // -------------------------------------------------------------------------
  // Per-scope adjacency + structural checks
  // -------------------------------------------------------------------------
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const pushTo = (m: Map<string, string[]>, k: string, v: string) => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };

  const isBoundary = (n: NodeInfo) => n.type === "boundaryEvent";
  const isHandler = (n: NodeInfo) => n.type === "serviceTask" && n.isForCompensation === true;
  // Token-path nodes participate in linearity/reachability; boundary events and
  // compensation handlers are reached via attachment/association, not the token.
  const isTokenNode = (n: NodeInfo) => !isBoundary(n) && !isHandler(n);

  for (const f of flows) {
    const src = f.source ? nodeById.get(f.source) : undefined;
    const tgt = f.target ? nodeById.get(f.target) : undefined;
    if (!src) {
      err(`Sequence flow '${f.id}' has an unresolved or unsupported sourceRef.`, f.id, "sequenceFlow");
      continue;
    }
    // Conditions live ONLY on outgoing flows of an exclusiveGateway (M2 design
    // §2 decision 3). A conditional flow leaving anything else is an implicit
    // inclusive-split (M4) and stays rejected — on ELEMENT presence, even when
    // the condition body is empty.
    if (f.hasConditionElement && src.type !== "exclusiveGateway") {
      err(
        `Sequence flow '${f.id}' carries a conditionExpression but does not leave an exclusiveGateway. ` +
          "Conditions are only supported on outgoing flows of an exclusive gateway.",
        f.id,
        "sequenceFlow",
      );
    }
    if (!tgt) {
      err(`Sequence flow '${f.id}' has an unresolved or unsupported targetRef.`, f.id, "sequenceFlow");
      continue;
    }
    if (src.scopeId !== f.scopeId || tgt.scopeId !== f.scopeId) {
      err(
        `Sequence flow '${f.id}' crosses a transaction boundary; flows must connect nodes in the same scope.`,
        f.id,
        "sequenceFlow",
      );
      continue;
    }
    // Token-path endpoint rules (M2 final review): boundary events and
    // compensation handlers are never sequence-flow TARGETS (and a handler is
    // never a SOURCE) — the linearity checks below deliberately skip non-token
    // nodes, so without these degree rules a model could route the token into
    // a node the engine never dispatches, wedging the instance. The engine
    // keeps a defensive incident for graphs that bypass this gate. A flow
    // LEAVING a boundary event stays legal — error/cancel boundaries route
    // their escalation path that way (degree-checked per kind below); the
    // compensate boundary's zero-outgoing rule also lives below.
    if (tgt.type === "startEvent") {
      // A start event begins a scope; routing a token INTO it (e.g. an error
      // boundary's free-routing target — M3-L2) is rejected generally so timer
      // boundary targets (L3) inherit the same constraint.
      err(
        `Sequence flow '${f.id}' targets start event '${tgt.id}'. A start event begins a scope and takes no incoming sequence flow.`,
        f.id,
        "sequenceFlow",
      );
    }
    if (isBoundary(tgt)) {
      err(
        `Sequence flow '${f.id}' targets boundary event '${tgt.id}'. Boundary events attach to activities ` +
          "and are activated by the runtime, never by an incoming sequence flow.",
        f.id,
        "sequenceFlow",
      );
    }
    if (isHandler(tgt)) {
      err(
        `Sequence flow '${f.id}' targets compensation handler '${tgt.id}'. Compensation handlers (isForCompensation) ` +
          "are invoked by the compensation mechanism via their <association>, never by sequence flow.",
        f.id,
        "sequenceFlow",
      );
    }
    if (isHandler(src)) {
      err(
        `Sequence flow '${f.id}' leaves compensation handler '${src.id}'. Compensation handlers (isForCompensation) ` +
          "must have no outgoing sequence flows; control returns to the compensation mechanism when the handler completes.",
        f.id,
        "sequenceFlow",
      );
    }
    // Errors above still record adjacency so the per-kind boundary degree
    // checks below see a coherent picture (reachability is gated on no errors).
    pushTo(outgoing, f.source!, f.target!);
    pushTo(incoming, f.target!, f.source!);
  }

  const scopeIds = Array.from(new Set(scopes.map((s) => s.id)));
  const scopeKindOf = new Map(scopes.map((s) => [s.id, s.kind]));

  for (const sid of scopeIds) {
    const kind = scopeKindOf.get(sid)!;
    const scopeNodes = nodes.filter((n) => n.scopeId === sid);
    const starts = scopeNodes.filter((n) => n.type === "startEvent");
    const ends = scopeNodes.filter((n) => n.type === "endEvent");
    const noneEnds = ends.filter((e) => e.endKind === "none");
    const where = kind === "transaction" ? `transaction '${sid}'` : "the process";

    if (starts.length !== 1) {
      err(`Exactly one none start event is required in ${where}; found ${starts.length}.`, sid, "startEvent");
    }
    if (noneEnds.length < 1) {
      err(`At least one none end event (commit) is required in ${where}; found ${noneEnds.length}.`, sid, "endEvent");
    }

    // Cancel ends are allowed only inside a transaction.
    for (const e of ends) {
      if (e.endKind === "cancel" && kind !== "transaction") {
        err(
          `Cancel end event '${e.id}' is outside any transaction. A cancel end event is allowed only inside a <transaction>.`,
          e.id,
          "endEvent",
        );
      }
    }

    // Linearity for token-path nodes (no splits; ends have no outgoing).
    for (const n of scopeNodes) {
      if (!isTokenNode(n)) continue;
      const out = outgoing.get(n.id) ?? [];
      const inc = incoming.get(n.id) ?? [];
      if (n.type === "endEvent") {
        if (out.length > 0) err(`End event '${n.id}' must not have outgoing sequence flows.`, n.id, "endEvent");
      } else {
        // Only an exclusiveGateway may split the token (M2); cycles are legal,
        // so this is a degree check, not an acyclicity check.
        if (out.length > 1 && n.type !== "exclusiveGateway") {
          err(
            `Element '${n.id}' has ${out.length} outgoing sequence flows. ` +
              "Implicit splits are not supported — route branching through an exclusiveGateway.",
            n.id,
            n.type,
          );
        }
        if (out.length === 0) err(`Element '${n.id}' has no outgoing sequence flow.`, n.id, n.type);
      }
      if (n.type !== "startEvent" && inc.length === 0) {
        err(`Element '${n.id}' is not reachable: it has no incoming sequence flow.`, n.id, n.type);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Exclusive-gateway split/default/condition rules (M2 design §3, TASK-33).
  //
  // A 1-out gateway is a pass-through/merge and needs no conditions. On a
  // split (>1 out — including the outgoing side of a mixed N-in/N-out
  // gateway): every non-default outgoing flow MUST carry a (non-empty) FEEL
  // condition, the gateway's `default` flow MUST NOT, and the `default` MUST
  // reference one of the gateway's OWN outgoing flows. Every condition leaving
  // a gateway is FEEL-parsed at publish (runtime has no second parse chance).
  // -------------------------------------------------------------------------
  const flowsBySource = new Map<string, FlowInfo[]>();
  for (const f of flows) {
    if (!f.source) continue;
    const arr = flowsBySource.get(f.source);
    if (arr) arr.push(f);
    else flowsBySource.set(f.source, [f]);
  }
  for (const n of nodes) {
    if (n.type !== "exclusiveGateway") continue;
    const gwFlows = flowsBySource.get(n.id) ?? [];

    let defaultFlow: FlowInfo | undefined;
    if (n.defaultFlowId) {
      defaultFlow = gwFlows.find((f) => f.id === n.defaultFlowId);
      if (!defaultFlow) {
        // The ref RESOLVED (unresolved ones never reach the tree and are
        // reported from parser warnings above) but names a flow leaving a
        // different node — default ownership is per gateway.
        err(
          `Exclusive gateway '${n.id}' declares default flow '${n.defaultFlowId}', ` +
            "which is not one of its own outgoing sequence flows.",
          n.id,
          "exclusiveGateway",
        );
      } else if (defaultFlow.hasConditionElement) {
        // Element PRESENCE, not the normalized (trimmed→null) body: an empty
        // <conditionExpression/> on the default flow must reject exactly like
        // a non-empty one — the message says "must not carry", and a flow not
        // leaving a gateway already rejects on the same presence bit.
        err(
          `Sequence flow '${defaultFlow.id}' is the default flow of exclusive gateway '${n.id}' and must not ` +
            "carry a conditionExpression — the default is taken only when no condition matches.",
          defaultFlow.id,
          "sequenceFlow",
        );
      }
    }

    for (const f of gwFlows) {
      if (f === defaultFlow) continue;
      // Split rule: a non-default flow of a >1-out gateway needs a condition.
      // An empty/whitespace-only <conditionExpression> normalized to null at
      // the capture site lands here too — the message covers both shapes.
      if (gwFlows.length > 1 && f.conditionExpression == null) {
        err(
          `Sequence flow '${f.id}' leaving exclusive gateway '${n.id}' has no (or an empty) conditionExpression ` +
            "and is not the gateway's default flow. Every non-default flow of a split must carry a FEEL condition.",
          f.id,
          "sequenceFlow",
        );
      }
      // Conditions are FEEL (M2 design §3: language unset or a FEEL
      // identifier). A declared non-FEEL language gets a clear reject instead
      // of a confusing FEEL syntax error from mis-parsing it.
      if (f.conditionLanguage != null && !/feel/i.test(f.conditionLanguage)) {
        err(
          `Sequence flow '${f.id}' declares condition language '${f.conditionLanguage}'. ` +
            "Conditions must be FEEL — leave the language attribute unset or set a FEEL identifier.",
          f.id,
          "sequenceFlow",
        );
      } else if (f.conditionExpression != null) {
        const parsed = parseCondition(f.conditionExpression);
        if (!parsed.ok) {
          err(
            `Sequence flow '${f.id}' leaving exclusive gateway '${n.id}': ${parsed.reason}`,
            f.id,
            "sequenceFlow",
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Boundary-event + compensation-handler structural checks
  // -------------------------------------------------------------------------
  const compensationOf = new Map<string, { handlerId: string; boundaryId: string }>(); // forward activity → wiring
  for (const n of nodes) {
    if (n.type !== "boundaryEvent") continue;
    const attached = n.attachedToRef ? nodeById.get(n.attachedToRef) : undefined;
    const outs = outgoing.get(n.id) ?? [];
    const assoc = associations.filter((a) => a.source === n.id);

    if (!attached) {
      err(`Boundary event '${n.id}' has an unresolved attachedToRef.`, n.id, "boundaryEvent");
      continue;
    }
    // Gateways are not activities — attaching a boundary event to one is
    // invalid BPMN regardless of the event kind (skip kind checks: they would
    // only cascade noise onto the same broken attachment).
    if (attached.type === "exclusiveGateway") {
      err(
        `Boundary event '${n.id}' is attached to exclusive gateway '${attached.id}'. ` +
          "Boundary events cannot be attached to gateways (invalid BPMN); attach them to an activity.",
        n.id,
        "boundaryEvent",
      );
      continue;
    }
    // A boundary event on a compensation handler (isForCompensation) would leak a
    // token out of the compensation lane: the handler is off the token path,
    // reached only via its <association>, so its boundary's outgoing flow has no
    // valid token semantics. Reject generally (M3-L2, TASK-42) so L3 timer
    // boundaries inherit it. NOTE: a handler IS a serviceTask, so the per-kind
    // "must be attached to a service task" checks would PASS it — this rule is
    // what catches it. `continue` so only this reason fires for the attachment.
    if (isHandler(attached)) {
      err(
        `Boundary event '${n.id}' is attached to compensation handler '${attached.id}' (isForCompensation). ` +
          "Boundary events cannot attach to a compensation handler — it is off the token path, reached only via its compensation <association>.",
        n.id,
        "boundaryEvent",
      );
      continue;
    }
    if (attached.scopeId !== n.scopeId) {
      err(`Boundary event '${n.id}' is attached to an element in a different scope.`, n.id, "boundaryEvent");
    }

    if (n.boundaryKind === "compensate") {
      if (attached.type !== "serviceTask") {
        err(
          `Compensation boundary event '${n.id}' must be attached to a service task (the compensatable step).`,
          n.id,
          "boundaryEvent",
        );
      }
      if (outs.length > 0) {
        err(
          `Compensation boundary event '${n.id}' must have zero outgoing sequence flows; it wires to a handler via <association>.`,
          n.id,
          "boundaryEvent",
        );
      }
      if (assoc.length !== 1) {
        err(
          `Compensation boundary event '${n.id}' must have exactly one outgoing <association> to an isForCompensation handler; found ${assoc.length}.`,
          n.id,
          "boundaryEvent",
        );
      } else {
        const target = assoc[0]!.target ? nodeById.get(assoc[0]!.target!) : undefined;
        if (!target) {
          err(`Compensation association '${assoc[0]!.id}' has an unresolved target.`, n.id, "boundaryEvent");
        } else if (!(target.type === "serviceTask" && target.isForCompensation)) {
          err(
            `Compensation association from '${n.id}' must target an isForCompensation service task; '${target.id}' is not one.`,
            n.id,
            "boundaryEvent",
          );
        } else if (target.scopeId !== n.scopeId) {
          err(
            `Compensation association from '${n.id}' targets handler '${target.id}' in a different transaction scope.`,
            n.id,
            "boundaryEvent",
          );
        } else if (attached.type === "serviceTask") {
          compensationOf.set(attached.id, { handlerId: target.id, boundaryId: n.id });
        }
      }
    } else if (n.boundaryKind === "error") {
      if (attached.type !== "serviceTask") {
        err(`Error boundary event '${n.id}' must be attached to a service task.`, n.id, "boundaryEvent");
      }
      // errorRef handling (M3-L2, TASK-42):
      //  - PRESENT-but-unresolved (moddle dropped it; recovered via the dangling
      //    map) → reject. It is NOT a catch-all — a typo must not silently widen
      //    to "match any code".
      //  - PRESENT-and-resolved → its <bpmn:error> @errorCode must be NON-EMPTY.
      //    An empty/absent code would silently act as a catch-all (the engine
      //    matches errorCode==null to any code), so it is rejected.
      //  - ABSENT → this IS the catch-all: leave n.errorCode undefined so the
      //    graph carries errorCode:null, the unambiguous "match any code" marker.
      const danglingRef = danglingErrorRef.get(n.id);
      if (danglingRef !== undefined) {
        err(
          `Error boundary event '${n.id}' has an errorRef '${danglingRef}' that does not resolve to a declared <bpmn:error>.`,
          n.id,
          "boundaryEvent",
        );
      } else if (n.errorRef != null) {
        if (!errorsById.has(n.errorRef)) {
          err(
            `Error boundary event '${n.id}' has an errorRef that does not resolve to a declared <bpmn:error>.`,
            n.id,
            "boundaryEvent",
          );
        } else {
          const code = errorsById.get(n.errorRef)!.errorCode;
          if (code == null || code.trim() === "") {
            err(
              `Error boundary event '${n.id}' references error '${n.errorRef}', which has no (or an empty) @errorCode. ` +
                "A coded error boundary needs a non-empty @errorCode; omit the errorRef to make this a catch-all boundary.",
              n.id,
              "boundaryEvent",
            );
          } else {
            n.errorCode = code;
          }
        }
      }
      // Lifted target rule (M3-L2): exactly ONE outgoing flow, to any token-path
      // node in the SAME scope (no longer "a cancel end event"). The forbidden
      // targets are already rejected by the per-flow endpoint rules above — a
      // flow into a boundaryEvent, a compensation handler, a startEvent, or
      // across a transaction boundary — so only the single-outgoing degree is
      // checked here. The recorded branch then walks forward like any token: it
      // triggers compensation only if it reaches a cancel end, else it continues.
      if (outs.length !== 1) {
        err(
          `Error boundary event '${n.id}' must have exactly one outgoing sequence flow (routing to a token-path node in the same scope); found ${outs.length}.`,
          n.id,
          "boundaryEvent",
        );
      }
    } else if (n.boundaryKind === "cancel") {
      if (attached.type !== "transaction") {
        err(
          `Cancel boundary event '${n.id}' must be attached to a <transaction>; '${attached.id}' is a ${attached.type}.`,
          n.id,
          "boundaryEvent",
        );
      }
      if (outs.length !== 1) {
        err(
          `Cancel boundary event '${n.id}' must have exactly one outgoing sequence flow (the saga-failed path); found ${outs.length}.`,
          n.id,
          "boundaryEvent",
        );
      }
    } else if (n.boundaryKind === "timer") {
      // M3-L3 (TASK-44): an interrupting boundary timer attaches to a serviceTask
      // or receiveTask (inside or outside a transaction) — NEVER to a transaction
      // itself (it would terminate the scope WITHOUT compensation, the
      // silent-rollback-loss trap, deferred to M5). Attachment to a gateway /
      // compensation handler is already rejected above (those `continue`). Exactly
      // one outgoing flow, to any token-path node in the same scope — the forbidden
      // targets are rejected by the per-flow endpoint rules (reused from M3-L2), so
      // only the single-outgoing degree is checked here.
      if (attached.type === "transaction") {
        err(
          `Boundary timer '${n.id}' is attached to transaction '${attached.id}'. A timer on a transaction would terminate the scope without compensation (deferred to M5) — attach it to a task INSIDE the transaction routing to a cancel end instead.`,
          n.id,
          "boundaryEvent",
        );
      } else if (attached.type !== "serviceTask" && attached.type !== "receiveTask") {
        err(
          `Boundary timer '${n.id}' must be attached to a service task or a receive task; '${attached.id}' is a ${attached.type}.`,
          n.id,
          "boundaryEvent",
        );
      }
      if (outs.length !== 1) {
        err(
          `Boundary timer '${n.id}' must have exactly one outgoing sequence flow (routing to a token-path node in the same scope); found ${outs.length}.`,
          n.id,
          "boundaryEvent",
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-activity error-boundary aggregation (M3-L2, TASK-42): on one activity
  // the coded boundaries must carry DISTINCT @errorCodes and there may be at
  // most ONE catch-all (errorEventDefinition with no errorRef). Grouped by
  // attachedToRef so the reject names the offending (second) boundary by id.
  // -------------------------------------------------------------------------
  const errBoundariesByActivity = new Map<string, NodeInfo[]>();
  for (const n of nodes) {
    if (n.type === "boundaryEvent" && n.boundaryKind === "error" && n.attachedToRef) {
      const arr = errBoundariesByActivity.get(n.attachedToRef);
      if (arr) arr.push(n);
      else errBoundariesByActivity.set(n.attachedToRef, [n]);
    }
  }
  for (const [activityId, boundaries] of errBoundariesByActivity) {
    const seenCodes = new Set<string>();
    let catchAllCount = 0;
    for (const b of boundaries) {
      // A dangling errorRef already errored above and is neither a catch-all nor
      // a coded boundary — exclude it so it neither counts as a second catch-all
      // nor masks a real one.
      if (danglingErrorRef.has(b.id)) continue;
      if (b.errorRef == null) {
        // Catch-all (no errorRef): at most one per activity.
        if (++catchAllCount > 1) {
          err(
            `Activity '${activityId}' has more than one catch-all error boundary (an errorEventDefinition with no errorRef). ` +
              "At most one catch-all error boundary is allowed per activity.",
            b.id,
            "boundaryEvent",
          );
        }
      } else if (b.errorCode != null) {
        // A coded boundary that resolved to a non-empty @errorCode (unresolved /
        // empty-code boundaries already errored above and carry no errorCode).
        if (seenCodes.has(b.errorCode)) {
          err(
            `Activity '${activityId}' has more than one error boundary catching @errorCode '${b.errorCode}'. ` +
              "An activity's coded error boundaries must have distinct @errorCode values.",
            b.id,
            "boundaryEvent",
          );
        }
        seenCodes.add(b.errorCode);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-activity timer-boundary multiplicity (M3-L3, TASK-44): AT MOST ONE timer
  // boundary per activity. Two static durations/dates make one statically dead;
  // a date+duration pair makes the winner arrival-time-dependent — both restricted
  // in M3 for determinism (honest wording, not "dead branch"). Grouped by
  // attachedToRef so the reject names the offending (second) boundary by id.
  // -------------------------------------------------------------------------
  const timerBoundariesByActivity = new Map<string, NodeInfo[]>();
  for (const n of nodes) {
    if (n.type === "boundaryEvent" && n.boundaryKind === "timer" && n.attachedToRef) {
      const arr = timerBoundariesByActivity.get(n.attachedToRef);
      if (arr) arr.push(n);
      else timerBoundariesByActivity.set(n.attachedToRef, [n]);
    }
  }
  for (const [activityId, boundaries] of timerBoundariesByActivity) {
    for (const b of boundaries.slice(1)) {
      err(
        `Activity '${activityId}' has more than one boundary timer. At most one timer boundary is allowed per activity ` +
          "(multiple static timers make one statically dead or arrival-time-dependent — restricted in M3 for determinism).",
        b.id,
        "boundaryEvent",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Intermediate timer catch degree (M3-L4, TASK-45, design §4.4): exactly ONE
  // incoming and ONE outgoing sequence flow. A timer catch is a single-token
  // delay, never a join. The per-scope linearity rules above already reject 0
  // incoming (unreachable), 0 outgoing (no successor), and >1 outgoing (implicit
  // split) with element id + reason; only the >1-incoming JOIN is added here.
  // -------------------------------------------------------------------------
  for (const n of nodes) {
    if (n.type !== "intermediateCatchEvent") continue;
    const inc = incoming.get(n.id) ?? [];
    if (inc.length > 1) {
      err(
        `Intermediate catch event '${n.id}' has ${inc.length} incoming sequence flows; exactly one is required ` +
          "(a timer catch is a single-token delay on the token path, not a join).",
        n.id,
        "intermediateCatchEvent",
      );
    }
  }

  // Compensation handlers must live inside a transaction.
  for (const n of nodes) {
    if (isHandler(n) && scopeKindOf.get(n.scopeId) !== "transaction") {
      err(
        `Service task '${n.id}' is isForCompensation but is not inside a <transaction>. Compensation handlers belong to a transaction scope.`,
        n.id,
        "serviceTask",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reachability per scope (BFS over flows + attachment + association edges).
  // Gated on no prior errors so we don't cascade noise onto a broken graph.
  // -------------------------------------------------------------------------
  if (!issues.some((i) => i.severity === "error")) {
    for (const sid of scopeIds) {
      const scopeNodes = nodes.filter((n) => n.scopeId === sid);
      const start = scopeNodes.find((n) => n.type === "startEvent");
      if (!start) continue;
      const visited = new Set<string>();
      const queue = [start.id];
      while (queue.length) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        // sequence-flow successors
        for (const t of outgoing.get(cur) ?? []) if (!visited.has(t)) queue.push(t);
        // attached boundary events of `cur`
        for (const b of scopeNodes) {
          if (b.type === "boundaryEvent" && b.attachedToRef === cur && !visited.has(b.id)) queue.push(b.id);
        }
        // compensation handler reached via association from a compensate boundary
        const curNode = nodeById.get(cur);
        if (curNode?.type === "boundaryEvent" && curNode.boundaryKind === "compensate") {
          for (const a of associations) {
            if (a.source === cur && a.target && !visited.has(a.target)) queue.push(a.target);
          }
        }
      }
      for (const n of scopeNodes) {
        if (!visited.has(n.id)) {
          err(`Element '${n.id}' is not reachable in ${sid === processId ? "the process" : `transaction '${sid}'`}.`, n.id, n.type);
        }
      }
    }
  }

  const hasErrors = issues.some((i) => i.severity === "error");

  // -------------------------------------------------------------------------
  // Build the immutable execution-graph snapshot.
  //
  // Built BEST-EFFORT even when validation failed, anchored on a process-level
  // start event, so the IR stays observable (tests, diagnostics) on documents
  // the gate rejects. `ok` — never `graph` presence — is the publish gate.
  // -------------------------------------------------------------------------
  const buildGraph = (processStart: NodeInfo): ExecutionGraph => {
    const processEnds = nodes.filter((n) => n.type === "endEvent" && n.scopeId === processId);

    // Flows marked default by their gateway's `default` attribute (M2).
    // Ownership is PER GATEWAY: a flow is default only when its SOURCE is the
    // gateway that declares it (Flow doc: "isDefault is true exactly for the
    // flow referenced by its gateway's default attribute") — a gateway's
    // `default` must never mark a same-id flow leaving a different node. A
    // `default` on a non-gateway activity does NOT mark its flow — conditions
    // and defaults live only on exclusiveGateway outgoing flows (design §2
    // decision 3); the activity case is rejected above.
    const defaultFlowByGateway = new Map<string, string>();
    for (const n of nodes) {
      if (n.type === "exclusiveGateway" && n.defaultFlowId) defaultFlowByGateway.set(n.id, n.defaultFlowId);
    }
    const isDefaultFlow = (f: FlowInfo): boolean =>
      f.source != null && defaultFlowByGateway.get(f.source) === f.id;

    // Multi-edge IR (design §4.1): each node's full outgoing Flow[] in DOCUMENT
    // order — `flows` was collected by iterating `flowElements` in XML order,
    // and that order is the condition evaluation order (see the Flow doc).
    // `next` stays derived (outgoing[0]?.targetId) for non-gateway nodes;
    // gateway nodes carry next: null — branch selection (TASK-34) owns the
    // successor choice, the IR makes no `.next` promise for gateways.
    const outgoingFlows = new Map<string, Flow[]>();
    for (const f of flows) {
      if (!f.source || !f.target) continue;
      const arr = outgoingFlows.get(f.source) ?? [];
      arr.push({
        flowId: f.id,
        targetId: f.target,
        conditionExpression: f.conditionExpression ?? null,
        isDefault: isDefaultFlow(f),
      });
      outgoingFlows.set(f.source, arr);
    }

    const graphNodes: Record<string, GraphNode> = {};
    for (const n of nodes) {
      const nodeOutgoing = outgoingFlows.get(n.id) ?? [];
      const node: GraphNode = {
        type: n.type,
        name: n.name ?? null,
        taskType: n.taskType ?? null,
        retries: n.attempts ?? null,
        messageName: n.messageName ?? null,
        outgoing: nodeOutgoing,
        next: n.type === "exclusiveGateway" ? null : nodeOutgoing[0]?.targetId ?? null,
        scopeId: n.scopeId === processId ? null : n.scopeId,
      };
      if (n.type === "serviceTask") node.isForCompensation = n.isForCompensation === true;
      if (n.type === "intermediateCatchEvent") node.timerTrigger = n.timerTrigger ?? null; // M3-L4: the static ISO-8601 delay
      if (n.type === "endEvent") node.endKind = n.endKind ?? "none";
      if (n.type === "boundaryEvent") {
        node.boundaryKind = n.boundaryKind ?? null;
        node.attachedToRef = n.attachedToRef ?? null;
        if (n.boundaryKind === "error") {
          node.errorRef = n.errorRef ?? null;
          node.errorCode = n.errorCode ?? null;
        }
        if (n.boundaryKind === "compensate") {
          const assoc = associations.find((a) => a.source === n.id);
          node.compensationHandlerId = assoc?.target ?? null;
        }
        if (n.boundaryKind === "timer") {
          node.timerTrigger = n.timerTrigger ?? null;
        }
      }
      graphNodes[n.id] = node;
    }

    // Transaction scopes.
    const transactionNodes = nodes.filter((n) => n.type === "transaction");
    const transactions: Record<string, TransactionScope> = {};
    for (const tx of transactionNodes) {
      const members = nodes.filter((n) => n.scopeId === tx.id);
      const innerStart = members.find((n) => n.type === "startEvent");
      const innerEnds = members.filter((n) => n.type === "endEvent");
      const compensations: Record<string, { handlerId: string; boundaryId: string }> = {};
      for (const [fwd, wiring] of compensationOf) {
        if (nodeById.get(fwd)?.scopeId === tx.id) compensations[fwd] = wiring;
      }
      transactions[tx.id] = {
        transactionId: tx.id,
        startId: innerStart?.id ?? "",
        childIds: members.map((m) => m.id),
        endIds: innerEnds.map((e) => e.id),
        compensations,
      };
    }

    // Elements list (drives bpmn_elements rows + the version API response).
    const elements: GraphElement[] = [];
    for (const n of nodes) {
      elements.push({
        elementId: n.id,
        type: n.type === "transaction" ? "transaction" : n.type === "boundaryEvent" ? "boundaryEvent" : n.type,
        name: n.name ?? null,
        taskType: n.taskType ?? null,
        retries: n.attempts ?? null,
        messageName: n.messageName ?? null,
      });
    }
    // Persist sequence-flow + association wiring (design §3.2) including the
    // conditional topology (M2 design §4: condition_expression / is_default).
    // On an ok graph every flow/association has resolved, in-scope endpoints;
    // a best-effort graph may carry nulls for unresolved refs.
    for (const f of flows) {
      elements.push({
        elementId: f.id,
        type: "sequenceFlow",
        sourceRef: f.source ?? null,
        targetRef: f.target ?? null,
        conditionExpression: f.conditionExpression ?? null,
        isDefault: isDefaultFlow(f),
      });
    }
    for (const m of messageElements) elements.push({ elementId: m.id, type: "message", name: m.name, messageName: m.name });
    for (const a of associations) {
      elements.push({ elementId: a.id, type: "association", sourceRef: a.source ?? null, targetRef: a.target ?? null });
    }
    for (const e of errorsById.values()) elements.push({ elementId: e.id, type: "error", name: e.name ?? null });

    const associationLinks: AssociationLink[] = associations.map((a) => ({
      id: a.id,
      sourceRef: a.source ?? "",
      targetRef: a.target ?? "",
    }));
    const errorDecls: ErrorDeclaration[] = Array.from(errorsById.values());

    return {
      processId,
      startElementId: processStart.id,
      endElementIds: processEnds.map((e) => e.id),
      elements,
      nodes: graphNodes,
      ...(transactionNodes.length > 0 ? { transactions } : {}),
      ...(associationLinks.length > 0 ? { associations: associationLinks } : {}),
      ...(errorDecls.length > 0 ? { errors: errorDecls } : {}),
    };
  };

  const processStart = nodes.find((n) => n.type === "startEvent" && n.scopeId === processId);
  const graph = processStart ? buildGraph(processStart) : undefined;

  if (hasErrors) {
    return { ok: false, issues: dedupeIssues(issues), ...(graph ? { graph } : {}) };
  }
  return { ok: true, issues: [], graph };
}

function dedupeIssues(issues: ValidationIssueData[]): ValidationIssueData[] {
  const seen = new Set<string>();
  const out: ValidationIssueData[] = [];
  for (const i of issues) {
    const key = `${i.severity}|${i.elementId ?? ""}|${i.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(i);
    }
  }
  return out;
}
