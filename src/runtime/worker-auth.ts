// Worker authentication for the /jobs/* pull data plane (SAGA design §2 #6, §6).
//
// Every /jobs/* call carries `Authorization: Bearer <token>`. The server derives
// workspaceId from the credential and NEVER trusts a body-supplied workspaceId
// for job access — preventing cross-tenant job/payload exfiltration (risk R6).

import type { Env } from "../env";
import { sha256Hex } from "../util";
import { getActiveCredentialByTokenHash } from "../persistence/worker-credentials";
import { UnauthorizedError } from "./errors";

export const WORKER_TOKEN_PREFIX = "wct_";

/** Generate a >=256-bit random worker token (raw value, shown once at mint). */
export function generateWorkerToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url without padding.
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${WORKER_TOKEN_PREFIX}${b64}`;
}

export interface WorkerIdentity {
  workspaceId: string;
  credentialId: string;
}

function extractBearer(request: Request): string {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) throw new UnauthorizedError("Missing Authorization header. Send 'Authorization: Bearer <worker token>'.");
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m || !m[1]) throw new UnauthorizedError("Malformed Authorization header. Expected 'Bearer <worker token>'.");
  return m[1].trim();
}

/**
 * Resolve a request's bearer token to a workspace. Throws UnauthorizedError on a
 * missing/malformed header, an unknown token, or a revoked credential — never
 * confirming whether a given token *value* existed.
 */
export async function authenticateWorker(request: Request, env: Env): Promise<WorkerIdentity> {
  const token = extractBearer(request);
  const hash = await sha256Hex(token);
  const cred = await getActiveCredentialByTokenHash(env.DB, hash);
  if (!cred) throw new UnauthorizedError("Invalid or revoked worker credential.");
  return { workspaceId: cred.workspace_id, credentialId: cred.credential_id };
}
