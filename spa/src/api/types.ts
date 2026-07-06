// Wire types mirroring the easy-bpmn JSON API + the M-UI endpoints. Kept in sync
// with src/contracts/api.ts and src/contracts/ui.ts on the Worker side.

export type StatusCounts = Record<string, number>;

export interface MeResponse {
  authenticated: boolean;
  workspaceId?: string | null;
  authConfigured: boolean;
}

export interface ProjectRollup {
  projectId: string;
  name: string;
  sagaCount: number;
  counts: StatusCounts;
  attention: number;
}

export interface AttentionItem {
  instanceId: string;
  sagaId: string | null;
  sagaName: string | null;
  status: string;
  currentElementId: string | null;
  businessKey: string | null;
  correlationKey: string;
  reason: "incident" | "compensationFailed" | "staleCompensating";
  since: string;
}

export interface SagaSummary {
  sagaId: string;
  name: string;
  activeVersionId: string | null;
  versionCount: number;
  hasTransaction: boolean;
  counts: StatusCounts;
  lastActivityAt: string | null;
}

export interface SagaVersionSummary {
  definitionVersionId: string;
  versionNumber: number;
  publishedAt: string;
  instanceCount: number;
}

export interface SagaDetail {
  sagaId: string;
  name: string;
  activeVersionId: string | null;
  hasTransaction: boolean;
  versions: SagaVersionSummary[];
}

// ---- Aggregate "living heatmap" (per-node instance density) ----------------

export interface SagaHeatmapNode {
  elementId: string;
  /** Live instances currently placed at this element. */
  count: number;
  /** Density split by status (a node dominated by incident/compensationFailed runs hot). */
  byStatus: StatusCounts;
}

export interface SagaHeatmap {
  sagaId: string;
  activeVersionId: string | null;
  /** Sum of node counts — live instances placed somewhere in the process now. */
  totalLive: number;
  nodes: SagaHeatmapNode[];
  generatedAt: string;
}

export interface InstanceListItem {
  instanceId: string;
  status: string;
  currentElementId: string | null;
  correlationKey: string;
  businessKey: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface InstanceList {
  instances: InstanceListItem[];
  nextCursor: number | null;
}

export interface HistoryEvent {
  historyEventId: string;
  type: string;
  instanceId?: string | null;
  elementId?: string | null;
  externalMessageId?: string | null;
  businessTime: string;
  technicalTime: string;
  payloadSnapshot?: Record<string, unknown> | null;
  diagnostics: Record<string, unknown>;
}

export interface Incident {
  incidentId: string;
  instanceId: string;
  elementId: string;
  reason: string;
  status: string;
  retryCount: number;
  payloadContext?: Record<string, unknown>;
  kind?: string;
  resolution?: string;
  createdAt: string;
}

export interface SagaStepInspection {
  elementId: string;
  seq: number;
  compensationStatus: string;
  compensationElementId?: string | null;
  compensationTaskType?: string | null;
}

export interface SagaInspection {
  phase: "forward" | "compensating" | "compensated" | "compensationFailed";
  traceId: string;
  steps: SagaStepInspection[];
}

export interface TimerInspection {
  timerId: string;
  elementId: string;
  occurrence: number;
  kind: "boundary" | "intermediateCatch" | "eventGateway";
  status: "armed" | "fired" | "cancelled";
  attachedToRef: string | null;
  gatewayId: string | null;
  fireAt: string;
  firedAt: string | null;
}

export interface TokenInspection {
  tokenId: string;
  positionElementId: string;
  status: "active" | "waiting" | "arrivedAtJoin" | "consumed" | "merged" | "discarded";
  regionId: string | null;
  regionActivation: number;
  branchFlowId: string | null;
  parentTokenId: string | null;
  variablesOverlay?: Record<string, unknown>;
}

export interface SubscriptionView {
  subscriptionId: string;
  elementId: string;
  messageName: string;
  correlationKey: string;
  status: string;
  expiresAt?: string | null;
  bufferedCount: number;
}

export interface ProcessInstance {
  instanceId: string;
  workspaceId: string;
  definitionVersionId: string;
  workflowInstanceId: string;
  businessKey?: string | null;
  correlationKey: string;
  status: string;
  currentElementId?: string | null;
  variables: Record<string, unknown>;
  startedAt: string;
  completedAt?: string | null;
}

export interface InstanceLineageChild {
  elementId: string;
  occurrence: number;
  /** M5-L3 — MI iteration that spawned this child; 0 for a plain visit. */
  iterationIndex: number;
  childInstanceId: string;
  status: string;
}

/** M5-L2 (callActivity, Task 11) — parent/child linkage, always present on
 *  the instance-inspection response (never omitted like the blocks below). */
export interface InstanceLineage {
  parent: { instanceId: string; elementId: string | null } | null;
  children: InstanceLineageChild[];
}

export interface ProcessInstanceInspection extends ProcessInstance {
  historySummary: HistoryEvent[];
  diagnostics: Record<string, unknown>;
  incident?: Incident | null;
  openIncidents?: Incident[];
  saga?: SagaInspection | null;
  timers?: TimerInspection[];
  tokens?: TokenInspection[];
  subscriptions?: SubscriptionView[];
  lineage: InstanceLineage;
}

export interface WorkerAttemptView {
  attemptNumber: number;
  status: string;
  request?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

export interface InstanceJobView {
  jobId: string;
  elementId: string;
  taskType: string;
  status: string;
  isCompensation: boolean;
  attemptCount: number;
  activationExpiresAt?: string | null;
  lockExpiresAt?: string | null;
  errorCode?: string | null;
  createdAt: string;
  updatedAt: string;
  attempts: WorkerAttemptView[];
}

export interface MessageSearchItem {
  externalMessageId: string;
  messageName: string;
  correlationKey: string;
  finalOutcome: string;
  matchedInstanceId: string | null;
  reason: string | null;
  receivedAt: string;
}

export interface BpmnElement {
  elementId: string;
  type: string;
  name?: string | null;
  taskType?: string | null;
  messageName?: string | null;
  sourceRef?: string | null;
  targetRef?: string | null;
  conditionExpression?: string | null;
  isDefault?: boolean;
}

export interface DefinitionVersion {
  definitionVersionId: string;
  draftId: string;
  workspaceId: string;
  versionNumber: number;
  status: string;
  bpmnXmlHash: string;
  elements: BpmnElement[];
  publishedAt: string;
}

export interface BpmnXmlResponse {
  definitionVersionId: string;
  bpmnXml: string;
  bpmnXmlHash: string;
}
