// Per-workspace worker credentials for the /jobs/* pull data plane. Only the
// SHA-256 hash of a token is stored; the raw token is returned once at mint and
// is never retrievable again. The auth middleware (src/runtime/worker-auth.ts)
// resolves a bearer token's hash to its workspace.

import { dbFirst, dbRun } from "./db";

export interface WorkerCredentialRow {
  credential_id: string;
  workspace_id: string;
  token_hash: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export async function insertWorkerCredential(
  db: D1Database,
  input: {
    credentialId: string;
    workspaceId: string;
    tokenHash: string;
    label?: string | null;
    now: string;
  },
): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO worker_credentials (credential_id, workspace_id, token_hash, label, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [input.credentialId, input.workspaceId, input.tokenHash, input.label ?? null, input.now],
  );
}

/** Resolve an active (non-revoked) credential by its token hash. */
export async function getActiveCredentialByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<WorkerCredentialRow | null> {
  return dbFirst<WorkerCredentialRow>(
    db,
    `SELECT * FROM worker_credentials WHERE token_hash = ? AND revoked_at IS NULL`,
    [tokenHash],
  );
}

export async function getCredential(
  db: D1Database,
  credentialId: string,
): Promise<WorkerCredentialRow | null> {
  return dbFirst<WorkerCredentialRow>(
    db,
    `SELECT * FROM worker_credentials WHERE credential_id = ?`,
    [credentialId],
  );
}

/** Idempotent revoke — sets revoked_at only on the first call. */
export async function revokeCredential(
  db: D1Database,
  credentialId: string,
  now: string,
): Promise<void> {
  await dbRun(
    db,
    `UPDATE worker_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL`,
    [now, credentialId],
  );
}
