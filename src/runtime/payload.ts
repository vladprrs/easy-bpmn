// Payload-size guard. Cloudflare Workflows enforce a hard ~1 MiB event payload
// limit; the MVP rejects oversized message / worker payloads explicitly BEFORE
// they would be delivered through a Workflow event (runtime-contracts.md).

import { BadRequestError } from "./errors";

export const MAX_EVENT_PAYLOAD_BYTES = 1_000_000;

export function payloadByteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? {})).length;
}

/**
 * Throws a product-facing 400 if `value` would exceed the Workflow event limit.
 * `context` names the involved message or BPMN element for operator clarity.
 */
export function assertPayloadWithinLimit(value: unknown, context: string): void {
  const size = payloadByteSize(value);
  if (size > MAX_EVENT_PAYLOAD_BYTES) {
    throw new BadRequestError(
      `Payload for ${context} is ${size} bytes, exceeding the ${MAX_EVENT_PAYLOAD_BYTES}-byte Workflow event limit.`,
      { context, size, limit: MAX_EVENT_PAYLOAD_BYTES },
    );
  }
}
