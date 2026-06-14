// M-UI operator-console handlers (design §8, §9, §12). Read/aggregation + auth,
// each guarded by the session cookie (no-op when auth is unconfigured) and reading
// D1 only. The existing root API contract is untouched; these live behind the new
// UI-namespace prefixes wired in src/ui/router.ts.

import type { Env } from "../env";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../runtime/errors";
import { getInstanceRow } from "../persistence/instances";
import {
  STALE_COMPENSATING_MS,
  getSagaDetail,
  getVersionXml,
  listAttention,
  listInstanceJobs,
  listProjects,
  listSagas,
  searchMessages,
} from "../persistence/ui-queries";
import { loginRequestSchema, type MeResponse } from "../contracts/ui";
import {
  authConfigured,
  buildSetCookie,
  clearSetCookie,
  credentialsMatch,
  hasValidSession,
  requireSession,
  signToken,
} from "./session";
import { json, noContent, parseBody } from "./http";

/** Resolve the target workspace: ?projectId / ?workspaceId, else UI_DEFAULT_WORKSPACE. */
function resolveWorkspace(env: Env, url: URL): string {
  const ws = url.searchParams.get("projectId") ?? url.searchParams.get("workspaceId") ?? env.UI_DEFAULT_WORKSPACE;
  if (!ws) {
    throw new BadRequestError("projectId (workspace) is required; set UI_DEFAULT_WORKSPACE or pass ?projectId=.");
  }
  return ws;
}

function staleCutoffIso(): string {
  return new Date(Date.now() - STALE_COMPENSATING_MS).toISOString();
}

// ---- Auth (§8) -------------------------------------------------------------

export async function handleLogin(env: Env, request: Request): Promise<Response> {
  if (!authConfigured(env)) {
    // Open console — there is nothing to authenticate against.
    throw new BadRequestError("Console auth is not configured (set UI_USER, UI_PASS, UI_SESSION_SECRET).");
  }
  const body = await parseBody(loginRequestSchema, request);
  if (!credentialsMatch(env, body.username, body.password)) {
    throw new UnauthorizedError("Invalid operator credentials.");
  }
  const token = await signToken(env.UI_SESSION_SECRET!);
  return json({ ok: true }, 200, { "set-cookie": buildSetCookie(token) });
}

export async function handleLogout(): Promise<Response> {
  return noContent({ "set-cookie": clearSetCookie() });
}

export async function handleMe(env: Env, request: Request): Promise<Response> {
  const authenticated = await hasValidSession(env, request);
  const body: MeResponse = {
    authenticated,
    workspaceId: env.UI_DEFAULT_WORKSPACE ?? null,
    authConfigured: authConfigured(env),
  };
  return json(body, 200);
}

// ---- Projects / attention / sagas (§6, §12) -------------------------------

export async function handleProjects(env: Env, request: Request): Promise<Response> {
  await requireSession(env, request);
  const projects = await listProjects(env.DB, staleCutoffIso());
  return json({ projects }, 200);
}

export async function handleAttention(env: Env, request: Request, url: URL): Promise<Response> {
  await requireSession(env, request);
  const workspaceId = resolveWorkspace(env, url);
  const items = await listAttention(env.DB, workspaceId, staleCutoffIso());
  return json({ items }, 200);
}

export async function handleSagas(env: Env, request: Request, url: URL): Promise<Response> {
  await requireSession(env, request);
  const workspaceId = resolveWorkspace(env, url);
  const sagas = await listSagas(env.DB, workspaceId);
  return json({ sagas }, 200);
}

export async function handleSagaDetail(env: Env, request: Request, sagaId: string): Promise<Response> {
  await requireSession(env, request);
  const detail = await getSagaDetail(env.DB, sagaId);
  if (!detail) throw new NotFoundError(`Saga ${sagaId} not found.`);
  return json(detail, 200);
}

// ---- Instance diagnostics (§9, §12) ---------------------------------------

export async function handleInstanceJobs(env: Env, request: Request, instanceId: string): Promise<Response> {
  await requireSession(env, request);
  const instance = await getInstanceRow(env.DB, instanceId);
  if (!instance) throw new NotFoundError(`Process instance ${instanceId} not found.`);
  const jobs = await listInstanceJobs(env.DB, instanceId);
  return json({ jobs }, 200);
}

// ---- Messages search (§9, §12) --------------------------------------------

export async function handleMessageSearch(env: Env, request: Request, url: URL): Promise<Response> {
  await requireSession(env, request);
  const workspaceId = resolveWorkspace(env, url);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50), 200);
  const cursorRaw = url.searchParams.get("cursor");
  const result = await searchMessages(env.DB, {
    workspaceId,
    messageName: url.searchParams.get("messageName") ?? undefined,
    correlationKey: url.searchParams.get("correlationKey") ?? undefined,
    outcome: url.searchParams.get("outcome") ?? undefined,
    cursor: cursorRaw ? parseInt(cursorRaw, 10) : undefined,
    limit,
  });
  return json({ messages: result.items, nextCursor: result.nextCursor }, 200);
}

// ---- Raw BPMN XML (§10, §12 — resolves G1) --------------------------------

export async function handleVersionBpmn(env: Env, request: Request, versionId: string): Promise<Response> {
  await requireSession(env, request);
  const xml = await getVersionXml(env.DB, versionId);
  if (!xml) throw new NotFoundError(`Definition version ${versionId} not found.`);
  return json({ definitionVersionId: versionId, ...xml }, 200);
}
