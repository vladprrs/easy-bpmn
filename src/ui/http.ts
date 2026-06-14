// Shared HTTP helpers for the M-UI operator-console endpoints (design §7).
// A UI-local copy of `json` (index.ts keeps its own) keeps the console module
// self-contained and avoids refactoring the core router.

import type { z } from "zod";
import { BadRequestError } from "../runtime/errors";

/** Parse + validate a JSON request body against a zod schema (mirrors index.ts). */
export async function parseBody<T>(schema: z.ZodType<T>, request: Request): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new BadRequestError("Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestError("Request validation failed.", { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** JSON response with the standard content-type. */
export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

/** 204 No Content (logout, etc.) with optional Set-Cookie. */
export function noContent(headers?: Record<string, string>): Response {
  return new Response(null, { status: 204, headers });
}
