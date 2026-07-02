// Public API contracts (contracts/openapi.yaml): zod request schemas + response
// types. zod is the validation boundary for untrusted input.

import { z } from "zod";
// M-UI (§9): the "Waiting on" block on instance inspection. Type-only import,
// erases at compile time (ui.ts imports HistoryEvent from here — both type-only,
// so no runtime cycle).
import type { SubscriptionView } from "./ui";
// Single source of the incident-kind taxonomy (M3-L1, TASK-39). Type-only, so it
// erases at compile time — no runtime cycle despite instances.ts importing Incident
// from here. The check:docs guard keeps IncidentKind ↔ the openapi enum in sync;
// linking the interface here puts the API surface under that same single source.
import type { IncidentKind } from "../persistence/instances";

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
    | "exclusiveGateway"
    // M3 time & failure taxonomy — a timer/message delay on the token path and
    // the eventBasedGateway timer/message race over branch catches (M3-L4):
    | "intermediateCatchEvent"
    | "eventBasedGateway"
    // M4 concurrency — block-structured AND/OR split/join gateways (M4-L1).
    | "parallelGateway"
    | "inclusiveGateway"
    // M5 composition:
    | "subProcess";
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
  /**
   * Incident taxonomy + remediation linkage. SAGA (M1) base + M2 (loopLimit |
   * noPath) + M3-L1 (TASK-39) split: jobActivationTimeout (DLQ) | waitTimeout
   * (service/receive wait caps) | conditionFailure (hard FEEL error) + M4-L6
   * concurrency caps: concurrencyLimit (fan-out exceeded MAX_CONCURRENT_TOKENS) |
   * stepBudget (per-drive step counter crossed STEP_BUDGET_SOFT, below the
   * platform step ceiling). `timeout` is LEGACY — retained for compatibility,
   * never written by current code.
   */
  kind?: IncidentKind;
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

/**
 * One model timer in the instance-inspection `timers` block (M3-L3 design §6) —
 * read straight from D1 (the `timers` table), so Workflow internals stay hidden.
 * The schema lands here now (TASK-43) as the contract/validation boundary; the
 * inspection endpoint that POPULATES the block is TASK-44 (M3-L3 runtime).
 */
export const timerInspectionSchema = z.object({
  timerId: z.string(),
  elementId: z.string(),
  occurrence: z.number().int(),
  /** boundary | intermediateCatch | eventGateway — the arming construct. */
  kind: z.enum(["boundary", "intermediateCatch", "eventGateway"]),
  /** Bookkeeping/read-model status (the authoritative outcome is the decider row). */
  status: z.enum(["armed", "fired", "cancelled"]),
  /** boundary: host activity element id; null otherwise. */
  attachedToRef: z.string().nullable(),
  /** eventGateway: owning gateway element id; null otherwise. */
  gatewayId: z.string().nullable(),
  fireAt: z.string(),
  firedAt: z.string().nullable(),
});
export type TimerInspection = z.infer<typeof timerInspectionSchema>;

/**
 * One token row in the instance-inspection `tokens` block (M4-L6.3) — read
 * straight from D1 (execution_tokens), so the live token frontier is directly
 * observable without touching Workflow internals.
 * `variablesOverlay` is verbatim: an inline JSON object for small overlays, or
 * `{"__r2":"<key>"}` for an offloaded large overlay (not rehydrated here).
 */
export const tokenInspectionSchema = z.object({
  tokenId: z.string(),
  positionElementId: z.string(),
  /** Live or terminal status from the execution_tokens read-model. */
  status: z.enum(["active", "waiting", "arrivedAtJoin", "consumed", "merged", "discarded"]),
  /** The parallel/inclusive split gateway element id that owns this token's region; null for the root token. */
  regionId: z.string().nullable(),
  /** How many times the owning split gateway has activated (0-based occurrence). */
  regionActivation: z.number().int(),
  /** Sequence-flow id that left the split gateway for this branch; null for the root token. */
  branchFlowId: z.string().nullable(),
  /** Parent token id (`${instanceId}:#root` for branch tokens, null for root). */
  parentTokenId: z.string().nullable(),
  /** Verbatim overlay column: inline object or {"__r2":"<key>"} reference. Not rehydrated. */
  variablesOverlay: z.record(z.unknown()).optional(),
});
export type TokenInspection = z.infer<typeof tokenInspectionSchema>;

export interface ProcessInstanceInspection extends ProcessInstance {
  historySummary: HistoryEvent[];
  diagnostics: Record<string, unknown>;
  /** The latest incident (LIMIT 1) — kept for backward compatibility. */
  incident?: Incident | null;
  /**
   * All not-yet-resolved incidents, newest-first (M3-L1, TASK-39). Lets an
   * operator see every live incident, not just the latest one.
   */
  openIncidents?: Incident[];
  /** Saga view — present when the instance has a transaction ledger. */
  saga?: SagaInspection | null;
  /**
   * Model timers (M3-L3, TASK-44): armed/fired/cancelled with fire_at/fired_at,
   * read straight from D1 (the `timers` table). Present when the instance has any
   * timer; Workflow internals stay hidden.
   */
  timers?: TimerInspection[];
  /**
   * Live token frontier (M4-L6.3): present when the instance has materialised
   * execution_tokens rows; `currentElementId` is null while >1 token is live.
   * Single-token (M1/M2/M3) instances with no token rows omit this field.
   */
  tokens?: TokenInspection[];
  /**
   * Active message subscriptions (M-UI §9): what a `waiting` instance is waiting
   * for (message name, correlation key, expiry, buffered-message count). Present
   * when the instance has ≥1 active subscription; the most common stuck case.
   */
  subscriptions?: SubscriptionView[];
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
