// The BPMN-lite profile gate. Parses BPMN XML, rejects unsupported
// standard-namespace flow nodes/structures with element-level reasons, tolerates
// ignorable extension content (foreign extensions / DI / documentation), and
// extracts the immutable linear execution graph for accepted documents.

import type { ModdleElement } from "bpmn-moddle";
import { parseBpmnXml } from "./parser";
import { TASK_DEFINITION_TYPE } from "./moddle-extension";
import {
  DEFAULT_SERVICE_TASK_ATTEMPTS,
  SEQUENCE_FLOW_TYPE,
  SUPPORTED_NODE_TYPES,
  localTypeName,
} from "./profile";
import type {
  ExecutionGraph,
  GraphElement,
  GraphNode,
  NodeType,
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
  ) => issues.push({ severity: "error", reason, elementId: elementId ?? null, elementName: elementName ?? "element" });

  const definitions = parsed.definitions;
  const rootElements = asArray<ModdleElement>(definitions.rootElements);

  // Collaborations (pools/lanes/participants/choreography) are out of profile.
  for (const root of rootElements) {
    if (root.$type === "bpmn:Collaboration" || root.$type === "bpmn:Choreography") {
      err(
        "Collaborations, pools, and participants are not supported. The MVP runs a single executable process.",
        (root.id as string) ?? null,
        localTypeName(root.$type),
      );
    }
  }

  // Messages declared at the root, keyed by id → name.
  const messageNamesById = new Map<string, string>();
  for (const root of rootElements) {
    if (root.$type === "bpmn:Message") {
      messageNamesById.set(root.id as string, (root.name as string) ?? "");
    }
  }

  // Select the single executable process.
  const processes = rootElements.filter((r) => r.$type === "bpmn:Process");
  const executable = processes.filter((p) => p.isExecutable === true);
  let proc: ModdleElement | undefined;
  if (executable.length === 1) {
    proc = executable[0];
  } else if (executable.length > 1) {
    err("Multiple executable processes found. The MVP supports exactly one executable process.");
  } else if (processes.length === 1) {
    proc = processes[0]; // lenient: a sole process without isExecutable is treated as the one
  } else if (processes.length === 0) {
    err("No <process> element found.");
  } else {
    err("No single executable <process isExecutable=\"true\"> could be identified.");
  }

  if (!proc) {
    return { ok: false, issues: dedupeIssues(issues) };
  }

  // Lanes inside the process are out of profile.
  if (asArray<ModdleElement>(proc.laneSets).length > 0) {
    err("Lanes are not supported in the MVP.", (proc.id as string) ?? null, "laneSet");
  }

  const flowElements = asArray<ModdleElement>(proc.flowElements);

  // Classify flow elements.
  interface NodeInfo {
    id: string;
    type: NodeType;
    name?: string;
    taskType?: string;
    attempts?: number;
    messageName?: string;
  }
  const nodes: NodeInfo[] = [];
  const flows: { id: string; source?: string; target?: string }[] = [];
  const messageElements: { id: string; name: string }[] = [];
  for (const [id, name] of messageNamesById) messageElements.push({ id, name });

  for (const el of flowElements) {
    const id = (el.id as string) ?? null;
    const $type = el.$type;

    if ($type === SEQUENCE_FLOW_TYPE) {
      if (el.conditionExpression != null) {
        err(
          "Conditional sequence flows are not supported. Use plain sequence flows only.",
          id,
          "sequenceFlow",
        );
      }
      flows.push({ id: id ?? "", source: refId(el.sourceRef), target: refId(el.targetRef) });
      continue;
    }

    const nodeType = SUPPORTED_NODE_TYPES[$type];
    if (!nodeType) {
      err(
        `Element '${id ?? "(no id)"}' (${localTypeName($type)}) is not supported in this profile. ` +
          "Supported nodes: start event, service task, receive task, end event.",
        id,
        localTypeName($type),
      );
      continue;
    }

    // `default` (default sequence flow on an activity/gateway) is not supported.
    if (el.default != null) {
      err("Default sequence flows are not supported.", id, localTypeName($type));
    }

    // Multi-instance / loop characteristics on an activity are out of profile.
    if (el.loopCharacteristics != null) {
      err(
        `Element '${id ?? "(no id)"}' has loop or multi-instance characteristics, which are not supported in the MVP.`,
        id,
        localTypeName($type),
      );
    }

    const info: NodeInfo = { id: id ?? "", type: nodeType, name: (el.name as string) ?? undefined };

    if (nodeType === "startEvent" || nodeType === "endEvent") {
      if (asArray<ModdleElement>(el.eventDefinitions).length > 0) {
        const def = asArray<ModdleElement>(el.eventDefinitions)[0];
        err(
          `${nodeType === "startEvent" ? "Start" : "End"} event '${id ?? ""}' has a ` +
            `${def ? localTypeName(def.$type) : "event definition"}. Only none ${
              nodeType === "startEvent" ? "start" : "end"
            } events are supported; start instances via the API instead.`,
          id,
          nodeType,
        );
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
    }

    if (nodeType === "receiveTask") {
      if (el.instantiate === true) {
        err(
          `Receive task '${id ?? ""}' has instantiate="true". The MVP starts instances via the API only; remove instantiate.`,
          id,
          "receiveTask",
        );
      }
      const msgId = refId(el.messageRef);
      const msgName = msgId ? messageNamesById.get(msgId) : undefined;
      if (!msgId || msgName === undefined) {
        err(
          `Receive task '${id ?? ""}' must reference a declared <message> via messageRef.`,
          id,
          "receiveTask",
        );
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

  // Structural checks.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const starts = nodes.filter((n) => n.type === "startEvent");
  const ends = nodes.filter((n) => n.type === "endEvent");
  if (starts.length !== 1) {
    err(`Exactly one none start event is required; found ${starts.length}.`);
  }
  if (ends.length < 1) {
    err("At least one none end event is required; found 0.");
  }

  // Outgoing adjacency from authoritative sourceRef/targetRef.
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const pushTo = (m: Map<string, string[]>, k: string, v: string) => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  for (const f of flows) {
    if (!f.source || !nodeById.has(f.source)) {
      err(`Sequence flow '${f.id}' has an unresolved or unsupported sourceRef.`, f.id, "sequenceFlow");
    }
    if (!f.target || !nodeById.has(f.target)) {
      err(`Sequence flow '${f.id}' has an unresolved or unsupported targetRef.`, f.id, "sequenceFlow");
    }
    if (f.source && f.target && nodeById.has(f.source) && nodeById.has(f.target)) {
      pushTo(outgoing, f.source, f.target);
      pushTo(incoming, f.target, f.source);
    }
  }

  // Linearity: each node at most one outgoing (no implicit split); end has none.
  for (const n of nodes) {
    const out = outgoing.get(n.id) ?? [];
    if (n.type === "endEvent" && out.length > 0) {
      err(`End event '${n.id}' must not have outgoing sequence flows.`, n.id, "endEvent");
    }
    if (n.type !== "endEvent" && out.length > 1) {
      err(
        `Element '${n.id}' has ${out.length} outgoing sequence flows. Implicit splits are not supported (no gateways in the MVP).`,
        n.id,
        n.type,
      );
    }
    if (n.type !== "startEvent" && (incoming.get(n.id) ?? []).length === 0) {
      err(`Element '${n.id}' is not reachable: it has no incoming sequence flow.`, n.id, n.type);
    }
    if (n.type !== "endEvent" && out.length === 0) {
      err(`Element '${n.id}' has no outgoing sequence flow.`, n.id, n.type);
    }
  }

  // Reachability from the start (only meaningful if structure is otherwise sound).
  if (issues.length === 0 && starts[0]) {
    const start = starts[0];
    const seen = new Set<string>();
    let cursor: string | undefined = start.id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = (outgoing.get(cursor) ?? [])[0];
    }
    for (const n of nodes) {
      if (!seen.has(n.id)) {
        err(`Element '${n.id}' is not reachable from the start event.`, n.id, n.type);
      }
    }
  }

  if (issues.some((i) => i.severity === "error")) {
    return { ok: false, issues: dedupeIssues(issues) };
  }

  // Build the immutable execution graph.
  const startNode = starts[0]!;
  const graphNodes: Record<string, GraphNode> = {};
  for (const n of nodes) {
    graphNodes[n.id] = {
      type: n.type,
      name: n.name ?? null,
      taskType: n.taskType ?? null,
      retries: n.attempts ?? null,
      messageName: n.messageName ?? null,
      next: (outgoing.get(n.id) ?? [])[0] ?? null,
    };
  }

  const elements: GraphElement[] = [];
  for (const n of nodes) {
    elements.push({
      elementId: n.id,
      type: n.type,
      name: n.name ?? null,
      taskType: n.taskType ?? null,
      retries: n.attempts ?? null,
      messageName: n.messageName ?? null,
    });
  }
  for (const f of flows) {
    elements.push({ elementId: f.id, type: "sequenceFlow" });
  }
  for (const m of messageElements) {
    elements.push({ elementId: m.id, type: "message", name: m.name, messageName: m.name });
  }

  const graph: ExecutionGraph = {
    processId: (proc.id as string) ?? "process",
    startElementId: startNode.id,
    endElementIds: ends.map((e) => e.id),
    elements,
    nodes: graphNodes,
  };

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
