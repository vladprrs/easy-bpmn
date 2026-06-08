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
  type: "startEvent" | "serviceTask" | "receiveTask" | "endEvent" | "sequenceFlow" | "message";
  name?: string | null;
  taskType?: string | null;
  messageName?: string | null;
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

export interface ProcessInstance {
  instanceId: string;
  workspaceId: string;
  definitionVersionId: string;
  workflowInstanceId: string;
  businessKey?: string | null;
  correlationKey: string;
  status: "starting" | "running" | "waiting" | "completed" | "incident";
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
  createdAt: string;
}

export interface ProcessInstanceInspection extends ProcessInstance {
  historySummary: HistoryEvent[];
  diagnostics: Record<string, unknown>;
  incident?: Incident | null;
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
