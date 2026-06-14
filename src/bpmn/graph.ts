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
  | "error"
  // M2 conditional sagas:
  | "exclusiveGateway"
  // M3 time & failure taxonomy:
  | "intermediateCatchEvent"
  | "eventBasedGateway"
  // M4 concurrency — a split fans out concurrent tokens; `next` is null, the
  // engine reads `outgoing[]` (split) or the recorded join facts (join).
  | "parallelGateway"
  | "inclusiveGateway";

/** A node in the executable graph (excludes sequence flows, messages, associations, errors). */
export type NodeType =
  | "startEvent"
  | "serviceTask"
  | "receiveTask"
  | "endEvent"
  // SAGA additions:
  | "transaction"
  | "boundaryEvent"
  // M2 conditional sagas:
  | "exclusiveGateway"
  // M3 time & failure taxonomy — a timer delay on the token path (M3-L4):
  | "intermediateCatchEvent"
  // M3-L4 (TASK-46): a deterministic timer/message race over its branch catches.
  // Like a gateway, `next` is null — the chosen branch (recorded in
  // gateway_decisions) owns the successor; the engine reads `outgoing[]`.
  | "eventBasedGateway"
  // M4 concurrency — a split fans out concurrent tokens; `next` is null, the
  // engine reads `outgoing[]` (split) or the recorded join facts (join).
  | "parallelGateway"
  | "inclusiveGateway";

/** Discriminator for end events: a plain (commit) end vs a transaction Cancel end. */
export type EndKind = "none" | "cancel";

/** Discriminator for a boundary event, by its single event definition. */
export type BoundaryKind = "error" | "cancel" | "compensate" | "timer";

/** A static ISO-8601 timer trigger (M3-L3): `timeDate` instant or `timeDuration` delay. */
export interface TimerTriggerSpec {
  kind: "timeDate" | "timeDuration";
  value: string;
}

/**
 * One outgoing sequence-flow edge of a node (design §4.1 multi-edge IR).
 *
 * ORDER GUARANTEE (M2 design §2 decision 5): a node's `outgoing[]` preserves
 * the DOCUMENT ORDER of its `<sequenceFlow>` elements — bpmn-moddle keeps a
 * container's `flowElements` in XML order and the builder appends one Flow per
 * sequence flow in that iteration order (never the `<bpmn:outgoing>` ref order
 * inside the node). Document order IS the condition evaluation order: gateway
 * branch selection evaluates non-default conditions first-true-wins in exactly
 * this persisted order, so replay is deterministic.
 *
 * `conditionExpression` is the raw FEEL body of the flow's
 * `<conditionExpression xsi:type="bpmn:tFormalExpression">` (live as of M2 for
 * flows leaving an `exclusiveGateway`; `null` on unconditional flows).
 * `isDefault` is `true` exactly for the flow referenced by its gateway's
 * `default` attribute.
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
   * sequenceFlow only (M2 conditional topology) — the raw FEEL condition body
   * on a flow leaving an exclusiveGateway, and the gateway's `default` marker
   * (true exactly for the flow named by the gateway's `default` attribute).
   * Persisted as bpmn_elements.condition_expression / is_default.
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
   * Derived convenience for NON-gateway nodes only: the first outgoing edge's
   * target (`outgoing[0]?.targetId`, null at end / off path); the single-token
   * engine reads it. The IR makes NO `.next` promise for `exclusiveGateway`
   * nodes — it is always `null` there, because branch selection (evaluating
   * `outgoing[]` conditions in document order, TASK-34) owns the successor
   * choice and nothing may linearly advance through a gateway.
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
  /** timer boundaryEvent (M3-L3) or timer intermediateCatchEvent (M3-L4) only — the static ISO-8601 trigger; fire_at is computed at arm time. */
  timerTrigger?: TimerTriggerSpec | null;
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
 * One block-structured concurrent region (M4 design §4.1/§7), keyed by its split
 * id. Persisted in the graph IR (parsed_profile) at publish, so the engine never
 * recomputes split↔join matching or branch order from the live graph: `type`
 * picks the AND/OR join semantics, `branchFlowIds` is the split's outgoing flow
 * ids in DOCUMENT ORDER (the deterministic merge + OR-wait order), and
 * `enclosingScopeId` is the process id or transaction id the region lives in.
 */
export interface RegionInfo {
  splitId: string;
  joinId: string;
  type: "and" | "or";
  branchFlowIds: string[];
  enclosingScopeId: string;
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
  /** Concurrent regions keyed by split id (M4); absent on non-concurrent graphs. */
  regions?: Record<string, RegionInfo>;
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
  /**
   * The execution-graph snapshot. On `ok: true` it is always present. On
   * `ok: false` it is attached BEST-EFFORT (whenever a process-level start
   * event anchors it) so the IR stays observable on rejected documents. `ok` —
   * never `graph` presence — is the publish gate.
   */
  graph?: ExecutionGraph;
}
