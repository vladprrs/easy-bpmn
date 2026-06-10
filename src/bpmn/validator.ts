// The easy-bpmn profile gate. Parses BPMN XML, accepts-and-validates the
// canonical-saga construct set (SAGA design §3), rejects unsupported
// standard-namespace flow nodes/structures with element-level reasons, tolerates
// ignorable extension content (foreign extensions / DI / documentation / text
// annotations), and extracts an immutable execution graph snapshot — always for
// accepted documents, and best-effort for rejected ones (see ValidationResult).
//
// M2 (conditional sagas) makes the multi-edge IR conditional: exclusiveGateway
// becomes a node kind and Flow.conditionExpression/isDefault go live, while the
// publish gate still rejects those constructs until TASK-33 widens the accept
// matrix.

import type { ModdleElement } from "bpmn-moddle";
import { parseBpmnXml } from "./parser";
import { TASK_DEFINITION_TYPE } from "./moddle-extension";
import {
  ASSOCIATION_TYPE,
  CANCEL_EVENT_DEFINITION,
  COMPENSATE_EVENT_DEFINITION,
  DEFAULT_SERVICE_TASK_ATTEMPTS,
  ERROR_EVENT_DEFINITION,
  ERROR_TYPE,
  EXCLUSIVE_GATEWAY_TYPE,
  SEQUENCE_FLOW_TYPE,
  SUPPORTED_NODE_TYPES,
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
  /** exclusiveGateway only — the sequence-flow id named by the `default` attribute. */
  defaultFlowId?: string;
}

interface FlowInfo {
  id: string;
  source?: string;
  target?: string;
  scopeId: string;
  /** Raw FEEL body of the flow's <conditionExpression> (tFormalExpression text). */
  conditionExpression?: string;
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
  "transaction (saga scope), and compensation/error/cancel boundary events.";

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
        // M2 graph IR: capture the raw FEEL condition body (tFormalExpression
        // text) so the builder can emit live conditional edges. The publish
        // gate below still REJECTS conditional flows until TASK-33 widens the
        // accept matrix.
        const cond = el.conditionExpression as ModdleElement | undefined | null;
        const condBody =
          cond != null && typeof cond.body === "string" && cond.body.trim() !== ""
            ? (cond.body as string)
            : undefined;
        if (cond != null) {
          err(
            "Conditional sequence flows are not supported (deferred to conditional sagas). Use plain sequence flows only.",
            id,
            "sequenceFlow",
          );
        }
        flows.push({
          id: id ?? "",
          source: refId(el.sourceRef),
          target: refId(el.targetRef),
          scopeId,
          conditionExpression: condBody,
        });
        continue;
      }

      // exclusiveGateway (M2 graph IR): classify it as a real node so the
      // builder emits the gateway + its conditional edges (split AND join),
      // but KEEP the M1 publish-time rejection until TASK-33 flips the accept
      // matrix — the reject message is unchanged.
      if ($type === EXCLUSIVE_GATEWAY_TYPE) {
        err(
          `Element '${id ?? "(no id)"}' (${localTypeName($type)}) is not supported in this profile. ${SUPPORTED_HINT}`,
          id,
          localTypeName($type),
        );
        nodes.push({
          id: id ?? "",
          type: "exclusiveGateway",
          name: (el.name as string) ?? undefined,
          scopeId,
          defaultFlowId: refId(el.default),
        });
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

        if (!boundaryKind) {
          const what = defs.length === 0
            ? "no event definition"
            : defs.length > 1
              ? "multiple event definitions"
              : `a ${localTypeName(defs[0]!.$type)}`;
          err(
            `Boundary event '${id ?? ""}' has ${what}. Only compensation, error, and cancel boundary events are supported ` +
              "(timer/signal/escalation/conditional/message boundary events are deferred).",
            id,
            "boundaryEvent",
          );
          continue;
        }
        const errorRef = boundaryKind === "error" ? refId((defs[0] as ModdleElement).errorRef) : undefined;
        nodes.push({
          id: id ?? "",
          type: "boundaryEvent",
          name: (el.name as string) ?? undefined,
          scopeId,
          boundaryKind,
          attachedToRef,
          errorRef,
        });
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

      // `default` flow (gateway/activity default) is not supported (deferred to M2).
      if (el.default != null) {
        err("Default sequence flows are not supported (deferred to conditional sagas).", id, localTypeName($type));
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

  for (const f of flows) {
    const src = f.source ? nodeById.get(f.source) : undefined;
    const tgt = f.target ? nodeById.get(f.target) : undefined;
    if (!src) {
      err(`Sequence flow '${f.id}' has an unresolved or unsupported sourceRef.`, f.id, "sequenceFlow");
      continue;
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
    pushTo(outgoing, f.source!, f.target!);
    pushTo(incoming, f.target!, f.source!);
  }

  const isBoundary = (n: NodeInfo) => n.type === "boundaryEvent";
  const isHandler = (n: NodeInfo) => n.type === "serviceTask" && n.isForCompensation === true;
  // Token-path nodes participate in linearity/reachability; boundary events and
  // compensation handlers are reached via attachment/association, not the token.
  const isTokenNode = (n: NodeInfo) => !isBoundary(n) && !isHandler(n);

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
        if (out.length > 1) {
          err(
            `Element '${n.id}' has ${out.length} outgoing sequence flows. Implicit splits are not supported (gateways/parallelism are deferred).`,
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
      if (!n.errorRef || !errorsById.has(n.errorRef)) {
        err(
          `Error boundary event '${n.id}' has an errorRef that does not resolve to a declared <bpmn:error>.`,
          n.id,
          "boundaryEvent",
        );
      } else {
        n.errorCode = errorsById.get(n.errorRef)!.errorCode ?? undefined;
      }
      if (outs.length !== 1) {
        err(
          `Error boundary event '${n.id}' must have exactly one outgoing sequence flow (routing to a cancel end event); found ${outs.length}.`,
          n.id,
          "boundaryEvent",
        );
      } else {
        const tgt = nodeById.get(outs[0]!);
        if (!tgt || tgt.type !== "endEvent" || tgt.endKind !== "cancel") {
          err(
            `Error boundary event '${n.id}' must route to a cancel end event (so the transaction cancels and compensates).`,
            n.id,
            "boundaryEvent",
          );
        }
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
  // start event: M2 lands graph-IR constructs (exclusiveGateway nodes, live
  // conditional edges) before TASK-33 widens the publish accept matrix, so the
  // builder must stay observable on documents the gate still rejects. `ok` —
  // never `graph` presence — is the publish gate.
  // -------------------------------------------------------------------------
  const buildGraph = (processStart: NodeInfo): ExecutionGraph => {
    const processEnds = nodes.filter((n) => n.type === "endEvent" && n.scopeId === processId);

    // Flows marked default by their gateway's `default` attribute (M2). A
    // `default` on a non-gateway activity does NOT mark its flow — conditions
    // and defaults live only on exclusiveGateway outgoing flows (design §2
    // decision 3); the activity case is rejected above.
    const defaultFlowIds = new Set<string>();
    for (const n of nodes) {
      if (n.type === "exclusiveGateway" && n.defaultFlowId) defaultFlowIds.add(n.defaultFlowId);
    }

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
        isDefault: defaultFlowIds.has(f.id),
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
        isDefault: defaultFlowIds.has(f.id),
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
