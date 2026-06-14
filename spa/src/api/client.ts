// Typed API client. Same-origin (the Worker serves both the SPA and the API), so
// the session cookie rides automatically. 401 ⇒ AuthError (app redirects to
// login); 409 ⇒ ConflictError (caller shows a "state changed, refresh" toast).

import type {
  AttentionItem,
  BpmnXmlResponse,
  DefinitionVersion,
  HistoryEvent,
  InstanceJobView,
  InstanceList,
  MeResponse,
  MessageSearchItem,
  ProcessInstanceInspection,
  ProjectRollup,
  SagaDetail,
  SagaHeatmap,
  SagaSummary,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isAuth(): boolean {
    return this.status === 401;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    let message = `${method} ${path} → ${res.status}`;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      message = String((parsed as { error: unknown }).error);
    }
    throw new ApiError(res.status, message, parsed);
  }
  return parsed as T;
}

const qs = (params: Record<string, string | number | undefined | null>): string => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
};

export interface HistoryPage {
  events: HistoryEvent[];
  nextCursor: number | null;
}

export const api = {
  // Auth
  me: () => req<MeResponse>("GET", "/ui/me"),
  login: (username: string, password: string) => req<{ ok: boolean }>("POST", "/ui/login", { username, password }),
  logout: () => req<void>("POST", "/ui/logout"),

  // Projects / sagas / attention
  projects: () => req<{ projects: ProjectRollup[] }>("GET", "/projects"),
  attention: (projectId?: string) => req<{ items: AttentionItem[] }>("GET", `/attention${qs({ projectId })}`),
  sagas: (projectId?: string) => req<{ sagas: SagaSummary[] }>("GET", `/sagas${qs({ projectId })}`),
  sagaDetail: (sagaId: string) => req<SagaDetail>("GET", `/sagas/${encodeURIComponent(sagaId)}`),
  sagaHeatmap: (sagaId: string) => req<SagaHeatmap>("GET", `/sagas/${encodeURIComponent(sagaId)}/heatmap`),

  // Instances
  instances: (q: { workspaceId: string; status?: string; search?: string; sagaId?: string; cursor?: number; limit?: number }) =>
    req<InstanceList>("GET", `/instances${qs(q)}`),
  instance: (id: string) => req<ProcessInstanceInspection>("GET", `/instances/${encodeURIComponent(id)}`),
  instanceHistory: (id: string, since?: number) =>
    req<HistoryPage>("GET", `/instances/${encodeURIComponent(id)}/history${qs({ since })}`),
  instanceJobs: (id: string) => req<{ jobs: InstanceJobView[] }>("GET", `/instances/${encodeURIComponent(id)}/jobs`),
  cancel: (id: string, reason?: string) =>
    req<ProcessInstanceInspection>("POST", `/instances/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {}),
  retry: (id: string, variables?: Record<string, unknown>) =>
    req<ProcessInstanceInspection>("POST", `/instances/${encodeURIComponent(id)}/retry`, variables ? { variables } : {}),

  // Messages
  messages: (q: { workspaceId: string; messageName?: string; correlationKey?: string; outcome?: string; cursor?: number }) =>
    req<{ messages: MessageSearchItem[]; nextCursor: number | null }>("GET", `/messages${qs(q)}`),

  // Definitions / BPMN
  version: (id: string) => req<DefinitionVersion>("GET", `/definitions/versions/${encodeURIComponent(id)}`),
  versionBpmn: (id: string) => req<BpmnXmlResponse>("GET", `/definitions/versions/${encodeURIComponent(id)}/bpmn`),
};
