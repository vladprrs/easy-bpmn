// Public API contracts (contracts/openapi.yaml): zod request schemas + response
// types. zod is the validation boundary for untrusted input.

import { z } from "zod";

export const createDraftRequestSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  bpmnXml: z.string().min(1),
});
export type CreateDraftRequest = z.infer<typeof createDraftRequestSchema>;

export const startInstanceRequestSchema = z.object({
  workspaceId: z.string().min(1),
  businessKey: z.string().nullish(),
  correlationKey: z.string().min(1),
  variables: z.record(z.unknown()),
  idempotencyKey: z.string().nullish(),
});
export type StartInstanceRequest = z.infer<typeof startInstanceRequestSchema>;

export const publishMessageRequestSchema = z.object({
  workspaceId: z.string().min(1),
  messageName: z.string().min(1),
  correlationKey: z.string().min(1),
  messageId: z.string().min(1),
  payload: z.record(z.unknown()),
});
export type PublishMessageRequest = z.infer<typeof publishMessageRequestSchema>;

// ---- Worker credentials (pull data plane auth) ----

export const mintWorkerCredentialRequestSchema = z.object({
  workspaceId: z.string().min(1),
  label: z.string().nullish(),
});
export type MintWorkerCredentialRequest = z.infer<typeof mintWorkerCredentialRequestSchema>;

/** The mint response is the ONLY time the raw token is returned. */
export interface MintWorkerCredentialResponse {
  credentialId: string;
  workspaceId: string;
  token: string;
  label?: string | null;
  createdAt: string;
}

// ---- Pull worker job endpoints (workspaceId is server-derived, never in the body) ----

export const activateJobsRequestSchema = z.object({
  taskType: z.string().min(1),
  workerId: z.string().min(1),
  maxJobs: z.number().int().positive().optional(),
  leaseMs: z.number().int().positive().optional(),
  waitMs: z.number().int().nonnegative().optional(),
});
export type ActivateJobsRequest = z.infer<typeof activateJobsRequestSchema>;

export const leasedJobSchema = z.object({
  jobId: z.string(),
  instanceId: z.string(),
  elementId: z.string(),
  taskType: z.string(),
  isCompensation: z.boolean(),
  attempt: z.number().int(),
  lockToken: z.string(),
  traceId: z.string(),
  variables: z.record(z.unknown()),
  originalInput: z.record(z.unknown()).optional(),
  capturedOutput: z.record(z.unknown()).nullable().optional(),
});
export type LeasedJob = z.infer<typeof leasedJobSchema>;

export const activateJobsResponseSchema = z.object({ jobs: z.array(leasedJobSchema) });
export type ActivateJobsResponse = z.infer<typeof activateJobsResponseSchema>;

export const completeJobRequestSchema = z.object({
  lockToken: z.string().min(1),
  outputVariables: z.record(z.unknown()).optional(),
});
export type CompleteJobRequest = z.infer<typeof completeJobRequestSchema>;

export const failJobRequestSchema = z.object({
  lockToken: z.string().min(1),
  reason: z.string().min(1),
  errorCode: z.string().nullish(),
  retryable: z.boolean().optional(),
});
export type FailJobRequest = z.infer<typeof failJobRequestSchema>;

export interface JobCallbackAck {
  jobId: string;
  outcome: "completed" | "failed" | "noop";
  /** "applied" (first delivery), "duplicate" (idempotent replay), or "ignored" (terminal). */
  disposition: "applied" | "duplicate" | "ignored";
}

// ---- Response shapes (mirror components/schemas in openapi.yaml) ----

export interface ValidationIssue {
  severity: "error" | "warning";
  elementId?: string | null;
  elementName: string;
  location?: string | null;
  reason: string;
}

export interface Draft {
  draftId: string;
  workspaceId: string;
  name: string;
  status: "draft" | "valid" | "invalid";
  validationIssues: ValidationIssue[];
  latestPublishedVersionId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BpmnElement {
  elementId: string;
  type:
    | "startEvent"
    | "serviceTask"
    | "receiveTask"
    | "endEvent"
    | "sequenceFlow"
    | "message"
    // SAGA constructs:
    | "transaction"
    | "boundaryEvent"
    | "association"
    | "error"
    // M2 conditional sagas:
    | "exclusiveGateway";
  name?: string | null;
  taskType?: string | null;
  messageName?: string | null;
  /** sequenceFlow / association only — persisted wiring endpoints (topology). */
  sourceRef?: string | null;
  targetRef?: string | null;
  /** sequenceFlow only (M2) — FEEL condition on an XOR outgoing flow / `default` marker. */
  conditionExpression?: string | null;
  isDefault?: boolean;
}

export interface DefinitionVersion {
  definitionVersionId: string;
  draftId: string;
  workspaceId: string;
  versionNumber: number;
  status: "published";
  bpmnXmlHash: string;
  elements: BpmnElement[];
  publishedAt: string;
}

export type InstanceStatusValue =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "incident"
  // SAGA (M1) — the widened saga lifecycle.
  | "compensating"
  | "compensated"
  | "compensationFailed"
  | "cancelled";

export interface ProcessInstance {
  instanceId: string;
  workspaceId: string;
  definitionVersionId: string;
  workflowInstanceId: string;
  businessKey?: string | null;
  correlationKey: string;
  status: InstanceStatusValue;
  currentElementId?: string | null;
  variables: Record<string, unknown>;
  startedAt: string;
  completedAt?: string | null;
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
  status: "open";
  retryCount: number;
  payloadContext?: Record<string, unknown>;
  /** SAGA (M1) incident taxonomy + remediation linkage; M2 adds loopLimit | noPath. */
  kind?: "serviceTaskFailure" | "compensationFailure" | "timeout" | "poison" | "loopLimit" | "noPath";
  resolution?: "open" | "compensating" | "compensated" | "operatorResolved";
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

export interface ProcessInstanceInspection extends ProcessInstance {
  historySummary: HistoryEvent[];
  diagnostics: Record<string, unknown>;
  incident?: Incident | null;
  /** Saga view — present when the instance has a transaction ledger. */
  saga?: SagaInspection | null;
}

// ---- Operator remediation verbs ----

export const cancelInstanceRequestSchema = z.object({ reason: z.string().nullish() }).partial();
export type CancelInstanceRequest = z.infer<typeof cancelInstanceRequestSchema>;

export const retryInstanceRequestSchema = z.object({
  /** Optional variable patch merged before resuming (operator fixes the condition). */
  variables: z.record(z.unknown()).optional(),
});
export type RetryInstanceRequest = z.infer<typeof retryInstanceRequestSchema>;

export interface InstanceListResponse {
  instances: {
    instanceId: string;
    status: string;
    currentElementId: string | null;
    correlationKey: string;
    businessKey: string | null;
    startedAt: string;
    updatedAt: string;
  }[];
  nextCursor: number | null;
}

export interface PublishMessageResponse {
  outcome: "correlated" | "buffered" | "duplicate" | "rejected";
  messageName: string;
  correlationKey: string;
  messageId: string;
  externalMessageId: string;
  instanceId?: string | null;
  duplicateOf?: string | null;
  reason?: string | null;
}

export interface ExternalMessageView extends PublishMessageResponse {
  finalOutcome: "correlated" | "buffered" | "duplicate" | "expired" | "late" | "rejected" | "invariantViolation";
  receivedAt: string;
  correlatedAt?: string | null;
  expiresAt?: string | null;
}

export interface PublishRejected {
  error: string;
  validationIssues: ValidationIssue[];
}

export interface ErrorResponse {
  error: string;
  details?: Record<string, unknown>;
}
