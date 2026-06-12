// zod schemas + types for Workflow params and the Receive Task message event.
// This is the validation boundary for runtime event payloads.

import { z } from "zod";

export const messageEventPayloadSchema = z.object({
  externalMessageId: z.string(),
  messageName: z.string(),
  correlationKey: z.string(),
  messageId: z.string(),
  payload: z.record(z.unknown()),
});

export type MessageEventPayload = z.infer<typeof messageEventPayloadSchema>;

/**
 * The discriminated job-result a pull worker's complete/fail delivers to the
 * Service-Task-as-wait engine (event type `bpmn_job_<jobId>`, see
 * workflowJobEventTypeFor). `completed` advances; `failed` carries the
 * technical-vs-business distinction (retryable vs an errorCode matching a model
 * bpmn:error/@errorCode → raises that BPMN error → compensation). A non-retryable
 * failure may additionally carry a `kind` classifying a runtime-synthesized
 * failure edge (`timeout` = un-leasable DLQ §4.2; `poison` = un-applicable output
 * §4.3) — these terminate with the matching incident kind and NEVER compensate.
 */
export const jobResultEventSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("completed"),
    jobId: z.string(),
    output: z.record(z.unknown()),
  }),
  z.object({
    outcome: z.literal("failed"),
    jobId: z.string(),
    retryable: z.boolean(),
    errorCode: z.string().nullish(),
    kind: z.enum(["timeout", "poison"]).nullish(),
    reason: z.string(),
  }),
  // A modeled boundary/intermediate-catch timer fired (M3-L3): the wake the
  // Scheduler DO's fireTimer sendEvents on the guarded wait's event type. The
  // engine re-reads the canonical timer_outcomes decider from D1 and routes the
  // token down the timer path — `timerId` is diagnostics-only, like `retryable`.
  z.object({
    outcome: z.literal("timerFired"),
    timerId: z.string(),
    jobId: z.string().nullish(),
  }),
]);

export type JobResultEvent = z.infer<typeof jobResultEventSchema>;

/** Params passed to a per-instance Workflow on `create`. */
export interface ProcessWorkflowParams {
  workspaceId: string;
  instanceId: string;
  definitionVersionId: string;
  correlationKey: string;
  initialVariables: Record<string, unknown>;
}
