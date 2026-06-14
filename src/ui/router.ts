// M-UI sub-router (design §7). Wired in at the top of the core router in
// src/index.ts: returns a Response for a console route, or null to fall through
// to the existing API routes (preserving the published root contract exactly).

import type { Env } from "../env";
import {
  handleAttention,
  handleInstanceJobs,
  handleLogin,
  handleLogout,
  handleMe,
  handleMessageSearch,
  handleProjects,
  handleSagaDetail,
  handleSagas,
  handleVersionBpmn,
} from "./handlers";
import { handleInstanceStream } from "./stream";

export async function handleUiRoute(
  request: Request,
  env: Env,
  seg: string[],
  method: string,
  url: URL,
): Promise<Response | null> {
  // Auth namespace -----------------------------------------------------------
  if (seg[0] === "ui") {
    if (seg.length === 2 && seg[1] === "login" && method === "POST") return handleLogin(env, request);
    if (seg.length === 2 && seg[1] === "logout" && method === "POST") return handleLogout();
    if (seg.length === 2 && seg[1] === "me" && method === "GET") return handleMe(env, request);
  }

  // Project rollups + cross-saga attention -----------------------------------
  if (seg[0] === "projects" && seg.length === 1 && method === "GET") return handleProjects(env, request);
  if (seg[0] === "attention" && seg.length === 1 && method === "GET") return handleAttention(env, request, url);

  // Sagas (draft lineage) ----------------------------------------------------
  if (seg[0] === "sagas") {
    if (seg.length === 1 && method === "GET") return handleSagas(env, request, url);
    if (seg.length === 2 && method === "GET") return handleSagaDetail(env, request, seg[1]!);
  }

  // Instance diagnostics (jobs + SSE live-tail) ------------------------------
  if (seg[0] === "instances" && seg[1] && seg.length === 3 && method === "GET") {
    if (seg[2] === "jobs") return handleInstanceJobs(env, request, seg[1]);
    if (seg[2] === "stream") return handleInstanceStream(env, seg[1], request);
  }

  // Message list/search (GET /messages — POST /messages stays the publish verb)
  if (seg[0] === "messages" && seg.length === 1 && method === "GET") return handleMessageSearch(env, request, url);

  // Raw BPMN XML for the diagram (GET /definitions/versions/{id}/bpmn) --------
  if (
    seg[0] === "definitions" &&
    seg[1] === "versions" &&
    seg.length === 4 &&
    seg[3] === "bpmn" &&
    method === "GET"
  ) {
    return handleVersionBpmn(env, request, seg[2]!);
  }

  return null; // not a console route — fall through to the core API router
}
