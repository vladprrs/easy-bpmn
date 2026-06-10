// Types for the parsed, immutable BPMN-lite execution graph and validation issues.
//
// M0 (SAGA) widens the type unions to the canonical-saga construct set and adds
// MINIMAL snapshot fields (scope membership, boundary kind, compensation wiring)
// so the §3 transaction-saga example publishes and round-trips. The engine-facing
// scope-aware multi-edge IR + persisted topology is M1 work — see the SAGA design
// doc §4.1. `GraphNode.next` keeps its linear meaning so the existing linear
// engine (engine.ts) is unaffected in M0.

export type ElementType =
  | "startEvent"
  | "serviceTask"
  | "receiveTask"
  | "endEvent"
  | "sequenceFlow"
  | "message"
  // SAGA additions:
  | "transaction"
  | "boundaryEvent"
  | "association"
  | "error";

/** A node in the executable graph (excludes sequence flows, messages, associations, errors). */
export type NodeType =
  | "startEvent"
  | "serviceTask"
  | "receiveTask"
  | "endEvent"
  // SAGA additions:
  | "transaction"
  | "boundaryEvent";

/** Discriminator for end events: a plain (commit) end vs a transaction Cancel end. */
export type EndKind = "none" | "cancel";

/** Discriminator for a boundary event, by its single event definition. */
export type BoundaryKind = "error" | "cancel" | "compensate";

/**
 * One outgoing sequence-flow edge of a node (design §4.1 multi-edge IR).
 * M1 is single-token, so a token-path node carries at most one Flow and the
 * derived `GraphNode.next` is `outgoing[0]?.targetId`. `conditionExpression` /
 * `isDefault` are the M2 branch-selection hook — always `null` / `false` in M1
 * (the validator still rejects conditional + default flows), present now so the
 * persisted shape is stable across the M1→M2 boundary.
 */
export interface Flow {
  flowId: string;
  targetId: string;
  conditionExpression?: string | null;
  isDefault?: boolean;
}

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
  /** sequenceFlow / association only — the wiring endpoints (persisted topology). */
  sourceRef?: string | null;
  targetRef?: string | null;
  /**
   * sequenceFlow only (M2 conditional topology) — the FEEL condition on a flow
   * leaving an exclusiveGateway, and the gateway's `default` marker. Always
   * null/false until the M2 validator populates them (it rejects conditional +
   * default flows today); persisted now so the bpmn_elements shape is stable
   * across the M1→M2 boundary.
   */
  conditionExpression?: string | null;
  isDefault?: boolean;
}

export interface GraphNode {
  type: NodeType;
  name?: string | null;
  taskType?: string | null;
  retries?: number | null;
  messageName?: string | null;
  /**
   * All outgoing sequence-flow edges (design §4.1). M1 keeps ≤1 token-path
   * successor; compensation boundaries + isForCompensation handlers carry `[]`
   * (they are reached via attachment/association, never the token path).
   */
  outgoing: Flow[];
  /**
   * Derived convenience: the first outgoing edge's target (null at end / off
   * path). The single-token engine reads `.next`; the M2 migration is to
   * *select* among `outgoing[]` by condition.
   */
  next: string | null;
  // --- SAGA M0 snapshot fields (optional; absent on linear MVP graphs) ---
  /** Enclosing <transaction> element id, or null at process level. */
  scopeId?: string | null;
  /** serviceTask handler reached only via compensation (isForCompensation="true"). */
  isForCompensation?: boolean;
  /** endEvent only — plain commit end vs transaction Cancel end. */
  endKind?: EndKind | null;
  /** boundaryEvent only — which event definition it carries. */
  boundaryKind?: BoundaryKind | null;
  /** boundaryEvent only — the activity (or transaction) it is attached to. */
  attachedToRef?: string | null;
  /** error boundaryEvent only — the referenced <bpmn:error> id. */
  errorRef?: string | null;
  /** error boundaryEvent only — the resolved error code (the wire value workers send). */
  errorCode?: string | null;
  /** compensate boundaryEvent only — the isForCompensation handler it associates to. */
  compensationHandlerId?: string | null;
}

/** A transaction scope: its inner start, members, ends, and compensation wiring. */
export interface TransactionScope {
  transactionId: string;
  /** Inner none start event id. */
  startId: string;
  /** All element ids enclosed by the transaction (nodes only). */
  childIds: string[];
  /** Inner end events (commit + cancel). */
  endIds: string[];
  /**
   * Forward activity id → its compensation wiring. Only forward steps that carry
   * a compensation boundary appear here. The reverse-order compensation pass
   * (M1) consumes this.
   */
  compensations: Record<string, { handlerId: string; boundaryId: string }>;
}

export interface AssociationLink {
  id: string;
  sourceRef: string;
  targetRef: string;
}

export interface ErrorDeclaration {
  id: string;
  name?: string | null;
  errorCode?: string | null;
}

/**
 * Immutable execution graph stored in `definition_versions.parsed_profile`.
 * The linear MVP profile is a deterministic path; `nodes`/`next` encode it. SAGA
 * definitions additionally carry `transactions`, `associations`, and `errors`.
 */
export interface ExecutionGraph {
  processId: string;
  startElementId: string;
  endElementIds: string[];
  /** All extracted elements, including sequence flows, messages, associations, errors. */
  elements: GraphElement[];
  /** Executable node lookup keyed by element id. */
  nodes: Record<string, GraphNode>;
  // --- SAGA M0 additions (optional; absent on linear MVP graphs) ---
  transactions?: Record<string, TransactionScope>;
  associations?: AssociationLink[];
  errors?: ErrorDeclaration[];
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
