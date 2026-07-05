// Layer B (workflow-mode) HTTP driver — the shared substrate every *.wf.test.ts
// uses to drive the REAL ProcessWorkflow over the public API against a live
// Worker (BASE_URL). Mirrors the direct-mode drive recipes in tests/helpers.ts,
// but every call is an ordinary fetch() (no SELF binding) so the identical
// sequence runs against `wrangler dev`, a preview, or a deployed *.workers.dev.
//
// Design refs: 2026-06-13-e2e-combination-matrix-design.md §3.1 (BASE_URL driver),
// §4 (bounded-timeout completion / hang-detector). The hang-detector is
// pollToTerminal: terminal within the deadline = PASS, still running/waiting past
// it = FAIL (the L6.6 symptom).

// Read the target base off the node process env without pulling @types/node into
// the pool-workers tsconfig (which would clash with workers-types globals).
// NOTE: prefer WF_BASE_URL — vite/vitest injects `process.env.BASE_URL="/"` (its
// `base` option), so a bare BASE_URL is only honored when it looks like an http(s)
// URL. Override for the real-CF DoD gate: `WF_BASE_URL=https://<name>.workers.dev`.
const procEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
function resolveBase(): string {
  for (const v of [procEnv?.WF_BASE_URL, procEnv?.BASE_URL]) {
    if (v && /^https?:\/\//.test(v)) return v.replace(/\/$/, "");
  }
  return "http://localhost:8787";
}
export const BASE_URL = resolveBase();

export interface Res<T = any> {
  status: number;
  body: T;
}

/** Low-level JSON call. `token` adds an `Authorization: Bearer` header (pull workers). */
export async function j<T = any>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed as T };
}

// --- definition lifecycle -------------------------------------------------

export async function createDraft(bpmnXml: string, name = "wf", workspaceId = "default") {
  return j("POST", "/definitions/drafts", { workspaceId, name, bpmnXml });
}

export async function publishDraft(draftId: string) {
  return j("POST", `/definitions/drafts/${draftId}/publish`);
}

export async function startInstance(
  versionId: string,
  opts: { workspaceId?: string; correlationKey: string; variables?: Record<string, unknown>; businessKey?: string },
) {
  return j("POST", `/definitions/versions/${versionId}/instances`, {
    workspaceId: "default",
    variables: {},
    ...opts,
  });
}

/** Publish + start convenience; throws on a non-2xx so a fixture typo fails loud. */
export async function publishAndStart(
  bpmnXml: string,
  start: { correlationKey: string; variables?: Record<string, unknown>; businessKey?: string },
): Promise<{ versionId: string; instanceId: string }> {
  const draft = await createDraft(bpmnXml);
  if (draft.status !== 201) throw new Error(`createDraft ${draft.status}: ${JSON.stringify(draft.body)}`);
  const pub = await publishDraft(draft.body.draftId);
  if (pub.status !== 201) throw new Error(`publish ${pub.status}: ${JSON.stringify(pub.body)}`);
  const versionId = pub.body.definitionVersionId;
  const inst = await startInstance(versionId, start);
  if (inst.status !== 201) throw new Error(`startInstance ${inst.status}: ${JSON.stringify(inst.body)}`);
  return { versionId, instanceId: inst.body.instanceId };
}

// --- pull worker data plane ----------------------------------------------

export async function mintWorkerToken(workspaceId = "default", label = "wf"): Promise<string> {
  const r = await j("POST", "/worker-credentials", { workspaceId, label });
  if (r.status !== 201) throw new Error(`mint token ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.token as string;
}

export interface WfJob {
  jobId: string;
  instanceId: string;
  elementId: string;
  taskType: string;
  isCompensation?: boolean;
  attempt: number;
  lockToken: string;
  variables: Record<string, unknown>;
  originalInput?: Record<string, unknown>;
  capturedOutput?: Record<string, unknown> | null;
}

export async function activate(token: string, taskType: string, workerId = "wf-worker"): Promise<WfJob[]> {
  const r = await j("POST", "/jobs/activate", { taskType, workerId }, token);
  return (r.body?.jobs ?? []) as WfJob[];
}

/**
 * Poll /jobs/activate for `taskType` until a job is leasable (the engine creates
 * it asynchronously once the workflow advances), then return it. Returns null if
 * none appears within the bound.
 */
export async function leaseWhenReady(
  token: string,
  taskType: string,
  opts: { deadlineMs?: number; intervalMs?: number; workerId?: string } = {},
): Promise<WfJob | null> {
  const deadline = Date.now() + (opts.deadlineMs ?? 20_000);
  const interval = opts.intervalMs ?? 400;
  while (Date.now() < deadline) {
    const jobs = await activate(token, taskType, opts.workerId);
    if (jobs[0]) return jobs[0];
    await sleep(interval);
  }
  return null;
}

export async function completeJob(token: string, job: WfJob, outputVariables: Record<string, unknown> = {}) {
  return j("POST", `/jobs/${job.jobId}/complete`, { lockToken: job.lockToken, outputVariables }, token);
}

export async function failJob(
  token: string,
  job: WfJob,
  opts: { reason?: string; retryable?: boolean; errorCode?: string } = {},
) {
  return j("POST", `/jobs/${job.jobId}/fail`, {
    lockToken: job.lockToken,
    reason: opts.reason ?? "wf-fail",
    ...(opts.errorCode ? { errorCode: opts.errorCode } : {}),
    ...(opts.retryable ? { retryable: true } : {}),
  }, token);
}

/** Lease the next ready job of `taskType` and complete it with `output`. Throws if none appears. */
export async function leaseAndComplete(
  token: string,
  taskType: string,
  output: Record<string, unknown> = {},
  opts: { deadlineMs?: number } = {},
): Promise<WfJob> {
  const job = await leaseWhenReady(token, taskType, opts);
  if (!job) throw new Error(`no leasable '${taskType}' job appeared within bound`);
  const done = await completeJob(token, job, output);
  if (done.status !== 200) throw new Error(`complete ${taskType} ${done.status}: ${JSON.stringify(done.body)}`);
  return job;
}

// --- message correlation -------------------------------------------------

export async function publishMessage(opts: {
  workspaceId?: string;
  messageName: string;
  correlationKey: string;
  messageId: string;
  payload?: Record<string, unknown>;
}) {
  return j("POST", "/messages", { workspaceId: "default", payload: {}, ...opts });
}

// --- inspection + control ------------------------------------------------

export async function getInstance(instanceId: string) {
  return j("GET", `/instances/${instanceId}`);
}

/** GET /instances/{id}/history → the events array (the endpoint wraps it as {events}). */
export async function getHistory(instanceId: string) {
  const r = await j("GET", `/instances/${instanceId}/history`);
  return (r.body?.events ?? []) as Array<Record<string, any>>;
}

/** Convenience: count history events of a given `type` (exactly-once audit assertions). */
export function countHistoryType(events: Array<Record<string, any>>, type: string): number {
  return events.filter((e) => e.type === type).length;
}

export async function cancelInstance(instanceId: string) {
  return j("POST", `/instances/${instanceId}/cancel`);
}

export async function retryInstance(instanceId: string) {
  return j("POST", `/instances/${instanceId}/retry`);
}

// --- terminal detection (the hang-detector) -------------------------------

export const TERMINAL = new Set([
  "completed",
  "compensated",
  "canceled",
  "cancelled",
  "incident",
  "failed",
  "compensationFailed",
  "errored", // M5-L2 child-only terminal (a callActivity child's uncaught error end)
]);

export interface PollResult {
  status: string;
  polls: number;
  elapsedMs: number;
  body: any;
}

/**
 * Poll GET /instances/{id} until a terminal status OR the wall-clock deadline.
 * Terminal-within-bound is a PASS; still running/waiting past the deadline is the
 * L6.6 hang symptom — callers assert TERMINAL.has(result.status).
 */
export async function pollToTerminal(
  instanceId: string,
  opts: { deadlineMs?: number; intervalMs?: number } = {},
): Promise<PollResult> {
  const start = Date.now();
  const deadline = start + (opts.deadlineMs ?? 30_000);
  const interval = opts.intervalMs ?? 400;
  let polls = 0;
  let status = "?";
  let body: any;
  while (Date.now() < deadline) {
    const g = await getInstance(instanceId);
    body = g.body;
    status = g.body?.status ?? "?";
    polls++;
    if (TERMINAL.has(status)) break;
    await sleep(interval);
  }
  return { status, polls, elapsedMs: Date.now() - start, body };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
