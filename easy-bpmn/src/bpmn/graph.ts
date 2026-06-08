// Types for the parsed, immutable BPMN-lite execution graph and validation issues.

export type ElementType =
  | "startEvent"
  | "serviceTask"
  | "receiveTask"
  | "endEvent"
  | "sequenceFlow"
  | "message";

/** A node in the executable graph (excludes sequence flows and messages). */
export type NodeType = "startEvent" | "serviceTask" | "receiveTask" | "endEvent";

export interface GraphElement {
  elementId: string;
  type: ElementType;
  name?: string | null;
  /** serviceTask only — stable worker routing key (easy-bpmn:taskDefinition type). */
  taskType?: string | null;
  /** serviceTask only — retry limit from easy-bpmn:taskDefinition retries. */
  retries?: number | null;
  /** receiveTask / message only — resolved name of the referenced <message>. */
  messageName?: string | null;
}

export interface GraphNode {
  type: NodeType;
  name?: string | null;
  taskType?: string | null;
  retries?: number | null;
  messageName?: string | null;
  /** Successor node id following the single outgoing sequence flow (null at end). */
  next: string | null;
}

/**
 * Immutable execution graph stored in `definition_versions.parsed_profile`.
 * The MVP profile is a deterministic linear path; `nodes`/`next` encode it.
 */
export interface ExecutionGraph {
  processId: string;
  startElementId: string;
  endElementIds: string[];
  /** All extracted elements, including sequence flows and messages, for the API. */
  elements: GraphElement[];
  /** Executable node lookup keyed by element id. */
  nodes: Record<string, GraphNode>;
}

export interface ValidationIssueData {
  severity: "error" | "warning";
  elementId?: string | null;
  elementName: string;
  location?: string | null;
  reason: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssueData[];
  graph?: ExecutionGraph;
}
