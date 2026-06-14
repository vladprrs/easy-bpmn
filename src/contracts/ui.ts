// M-UI operator-console contracts (design §12). zod request schemas + response
// types for the read/aggregation/auth endpoints. All responses read D1 only.

import { z } from "zod";
import type { HistoryEvent } from "./api";

// ---- Auth (§8) -------------------------------------------------------------

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface MeResponse {
  authenticated: boolean;
  /** Default workspace for SPA boot (env UI_DEFAULT_WORKSPACE). */
  workspaceId?: string | null;
  /** False ⇒ the console runs open (no credentials configured). */
  authConfigured: boolean;
}

// ---- Status rollups (shared) ----------------------------------------------

/** Instance counts grouped by status (only non-zero buckets are guaranteed). */
export type StatusCounts = Partial<Record<string, number>>;

// ---- Projects (§12) --------------------------------------------------------

export interface ProjectRollup {
  projectId: string; // = workspace_id
  name: string;
  sagaCount: number;
  counts: StatusCounts;
  /** Instances needing attention (incident + compensationFailed + stale compensating). */
  attention: number;
}

// ---- Cross-saga attention (§6, §12) ---------------------------------------

export interface AttentionItem {
  instanceId: string;
  sagaId: string | null; // draft_id via the version join
  sagaName: string | null;
  status: string;
  currentElementId: string | null;
  businessKey: string | null;
  correlationKey: string;
  /** Why it is on the list: an incident, compensationFailed, or stale compensating. */
  reason: "incident" | "compensationFailed" | "staleCompensating";
  since: string; // updated_at
}

// ---- Sagas (§6, §12) -------------------------------------------------------

export interface SagaSummary {
  sagaId: string; // = draft_id
  name: string; // active version's process id (immutable), else draft name
  activeVersionId: string | null;
  versionCount: number;
  /** Whether the active version carries a bpmn:transaction scope (Saga tab gate). */
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

// ---- Instance jobs + worker attempts (§9, §12) ----------------------------

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

export interface InstanceJobsResponse {
  jobs: InstanceJobView[];
}

// ---- Waiting-on subscriptions (§9, §12) — extends GET /instances/{id} ------

export interface SubscriptionView {
  subscriptionId: string;
  elementId: string;
  messageName: string;
  correlationKey: string;
  status: string;
  expiresAt?: string | null;
  /** Early messages buffered against this broker key (pre-correlation count). */
  bufferedCount: number;
}

// ---- Message search (§9, §12) ---------------------------------------------

export interface MessageSearchItem {
  externalMessageId: string;
  messageName: string;
  correlationKey: string;
  finalOutcome: string;
  matchedInstanceId: string | null;
  reason: string | null;
  receivedAt: string;
}

export interface MessageSearchResponse {
  messages: MessageSearchItem[];
  nextCursor: number | null;
}

// ---- Raw BPMN XML (§10, §12 — resolves G1) --------------------------------

export interface BpmnXmlResponse {
  definitionVersionId: string;
  bpmnXml: string;
  bpmnXmlHash: string;
}

// ---- History delta (§11 poll fallback) ------------------------------------

export interface HistorySinceResponse {
  events: HistoryEvent[];
  nextCursor: number | null;
}
