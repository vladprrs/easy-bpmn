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

/** Params passed to a per-instance Workflow on `create`. */
export interface ProcessWorkflowParams {
  workspaceId: string;
  instanceId: string;
  definitionVersionId: string;
  correlationKey: string;
  initialVariables: Record<string, unknown>;
}
