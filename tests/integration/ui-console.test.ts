// M-UI operator-console endpoint tests (design §8, §9, §11, §12). Auth gating,
// project/saga aggregation, instance diagnostics, message search, raw BPMN, the
// history poll delta, and an SSE live-tail smoke. All read D1 only.

import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_BPMN,
  SAGA_BPMN,
  drainSampleWorkers,
  get,
  publishAndStart,
} from "../helpers";

const BASE = "https://easy-bpmn.test";

interface RawResponse<T = any> {
  status: number;
  body: T;
  setCookie: string | null;
  contentType: string | null;
  res: Response;
}

async function raw<T = any>(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<RawResponse<T>> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers["cookie"] = opts.cookie;
  const res = await SELF.fetch(BASE + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return {
    status: res.status,
    body: parsed as T,
    setCookie: res.headers.get("set-cookie"),
    contentType: res.headers.get("content-type"),
    res,
  };
}

async function login(): Promise<string> {
  const r = await raw("POST", "/ui/login", { body: { username: "operator", password: "test-pass" } });
  expect(r.status).toBe(200);
  expect(r.setCookie).toBeTruthy();
  return r.setCookie!.split(";")[0]!; // "ebpmn_session=<token>"
}

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});

describe("M-UI auth (§8)", () => {
  it("rejects bad credentials with 401", async () => {
    const r = await raw("POST", "/ui/login", { body: { username: "operator", password: "wrong" } });
    expect(r.status).toBe(401);
  });

  it("accepts good credentials and sets a Lax HttpOnly cookie", async () => {
    const r = await raw("POST", "/ui/login", { body: { username: "operator", password: "test-pass" } });
    expect(r.status).toBe(200);
    expect(r.setCookie).toMatch(/ebpmn_session=/);
    expect(r.setCookie).toMatch(/HttpOnly/i);
    expect(r.setCookie).toMatch(/SameSite=Lax/i);
  });

  it("GET /ui/me reflects session state + default workspace", async () => {
    const anon = await raw("GET", "/ui/me");
    expect(anon.status).toBe(200);
    expect(anon.body.authenticated).toBe(false);
    expect(anon.body.authConfigured).toBe(true);
    expect(anon.body.workspaceId).toBe("default");

    const authed = await raw("GET", "/ui/me", { cookie });
    expect(authed.body.authenticated).toBe(true);
  });

  it("logout clears the cookie", async () => {
    const r = await raw("POST", "/ui/logout");
    expect(r.status).toBe(204);
    expect(r.setCookie).toMatch(/ebpmn_session=;/);
  });

  it("gates a UI endpoint behind the cookie (401 without, 200 with)", async () => {
    const anon = await raw("GET", "/projects");
    expect(anon.status).toBe(401);
    const authed = await raw("GET", "/projects", { cookie });
    expect(authed.status).toBe(200);
  });
});

describe("M-UI projects / sagas / attention (§6, §12)", () => {
  it("rolls up projects with status counts + a saga count", async () => {
    await publishAndStart(SAGA_BPMN, { correlationKey: "ui-proj-1", variables: { qty: 1, amount: 10 } });
    const r = await raw("GET", "/projects", { cookie });
    expect(r.status).toBe(200);
    const project = r.body.projects.find((p: any) => p.projectId === "default");
    expect(project).toBeTruthy();
    expect(project.sagaCount).toBeGreaterThan(0);
    expect(typeof project.attention).toBe("number");
  });

  it("lists sagas (draft lineage) with hasTransaction + counts", async () => {
    const { draftId } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "ui-saga-1",
      variables: { qty: 1, amount: 10 },
    });
    const r = await raw("GET", "/sagas?projectId=default", { cookie });
    expect(r.status).toBe(200);
    const saga = r.body.sagas.find((s: any) => s.sagaId === draftId);
    expect(saga).toBeTruthy();
    expect(saga.hasTransaction).toBe(true);
    expect(saga.activeVersionId).toBeTruthy();
    expect(saga.versionCount).toBeGreaterThanOrEqual(1);

    const detail = await raw("GET", `/sagas/${draftId}`, { cookie });
    expect(detail.status).toBe(200);
    expect(detail.body.sagaId).toBe(draftId);
    expect(detail.body.versions.length).toBeGreaterThanOrEqual(1);
  });

  it("non-transaction process reports hasTransaction=false", async () => {
    const { draftId } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "ui-saga-linear",
      variables: {},
    });
    const r = await raw("GET", "/sagas?projectId=default", { cookie });
    const saga = r.body.sagas.find((s: any) => s.sagaId === draftId);
    expect(saga.hasTransaction).toBe(false);
  });

  it("attention surfaces incident + stale-compensating, not fresh compensating", async () => {
    const incident = await publishAndStart(SAGA_BPMN, { correlationKey: "att-inc", variables: { qty: 1, amount: 10 } });
    const stale = await publishAndStart(SAGA_BPMN, { correlationKey: "att-stale", variables: { qty: 1, amount: 10 } });
    const fresh = await publishAndStart(SAGA_BPMN, { correlationKey: "att-fresh", variables: { qty: 1, amount: 10 } });
    const incidentId = incident.instance.body.instanceId;
    const staleId = stale.instance.body.instanceId;
    const freshId = fresh.instance.body.instanceId;

    await env.DB.prepare(`UPDATE process_instances SET status='incident' WHERE instance_id=?`).bind(incidentId).run();
    await env.DB.prepare(
      `UPDATE process_instances SET status='compensating', updated_at='2000-01-01T00:00:00.000Z' WHERE instance_id=?`,
    ).bind(staleId).run();
    await env.DB.prepare(
      `UPDATE process_instances SET status='compensating', updated_at=? WHERE instance_id=?`,
    ).bind(new Date().toISOString(), freshId).run();

    const r = await raw("GET", "/attention?projectId=default", { cookie });
    expect(r.status).toBe(200);
    const ids = new Set(r.body.items.map((i: any) => i.instanceId));
    expect(ids.has(incidentId)).toBe(true);
    expect(ids.has(staleId)).toBe(true);
    expect(ids.has(freshId)).toBe(false);
    const inc = r.body.items.find((i: any) => i.instanceId === incidentId);
    expect(inc.reason).toBe("incident");
    expect(inc.sagaId).toBeTruthy();
  });

  it("GET /sagas/{sagaId}/heatmap aggregates live instances per element (gated, 404 on miss)", async () => {
    const { draftId } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "ui-heatmap-1",
      variables: { qty: 1, amount: 10 },
    });

    const r = await raw("GET", `/sagas/${draftId}/heatmap`, { cookie });
    expect(r.status).toBe(200);
    expect(r.body.sagaId).toBe(draftId);
    expect(Array.isArray(r.body.nodes)).toBe(true);
    expect(typeof r.body.totalLive).toBe("number");
    expect(typeof r.body.generatedAt).toBe("string");

    // Gated: no cookie ⇒ 401.
    const anon = await raw("GET", `/sagas/${draftId}/heatmap`);
    expect(anon.status).toBe(401);

    // Unknown saga ⇒ 404.
    const missing = await raw("GET", "/sagas/does-not-exist/heatmap", { cookie });
    expect(missing.status).toBe(404);
  });
});

describe("M-UI instance diagnostics (§9, §12)", () => {
  it("GET /instances/{id}/jobs returns jobs with worker attempts", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "ui-jobs",
      variables: { qty: 2, amount: 100 },
    });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: ["reserve-stock", "charge-card", "confirm-shipping"] });

    const r = await raw("GET", `/instances/${id}/jobs`, { cookie });
    expect(r.status).toBe(200);
    expect(r.body.jobs.length).toBeGreaterThan(0);
    const withAttempts = r.body.jobs.find((j: any) => j.attempts.length > 0);
    expect(withAttempts).toBeTruthy();
    expect(withAttempts.attempts[0]).toHaveProperty("attemptNumber");
    expect(withAttempts).toHaveProperty("elementId");
  });

  it("GET /instances/{id} exposes the waiting-on subscriptions block", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: "ui-wait", variables: {} });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: ["external-check"] });

    const r = await get(`/instances/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("waiting");
    expect(Array.isArray(r.body.subscriptions)).toBe(true);
    expect(r.body.subscriptions[0].messageName).toBe("ApprovalReceived");
  });

  it("GET /instances/{id}/history?since= returns a no-overlap delta", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, { correlationKey: "ui-hist", variables: { qty: 1, amount: 10 } });
    const id = instance.body.instanceId;

    const full = await get(`/instances/${id}/history`);
    expect(full.status).toBe(200);
    expect(full.body.events.length).toBeGreaterThan(0);
    expect(typeof full.body.nextCursor).toBe("number");

    const delta = await get(`/instances/${id}/history?since=${full.body.nextCursor}`);
    // Nothing new since the last cursor → empty delta, cursor unchanged.
    expect(delta.body.events).toHaveLength(0);
    expect(delta.body.nextCursor).toBe(full.body.nextCursor);

    // A since=0 delta returns the same events as the full read (no gaps/dupes).
    const fromZero = await get(`/instances/${id}/history?since=0`);
    expect(fromZero.body.events.map((e: any) => e.historyEventId)).toEqual(
      full.body.events.map((e: any) => e.historyEventId),
    );
  });

  it("GET /instances supports sagaId, search and multi-status filters", async () => {
    const { instance, draftId } = await publishAndStart(SAGA_BPMN, {
      correlationKey: "ui-filter",
      variables: { qty: 1, amount: 10 },
      businessKey: "order-9001",
    });
    const id = instance.body.instanceId;

    const bySaga = await get(`/instances?workspaceId=default&sagaId=${draftId}`);
    expect(bySaga.status).toBe(200);
    expect(bySaga.body.instances.some((i: any) => i.instanceId === id)).toBe(true);

    const bySearch = await get(`/instances?workspaceId=default&search=order-900`);
    expect(bySearch.body.instances.some((i: any) => i.instanceId === id)).toBe(true);

    const byMultiStatus = await get(`/instances?workspaceId=default&status=waiting,incident`);
    expect(byMultiStatus.body.instances.some((i: any) => i.instanceId === id)).toBe(true);
  });
});

describe("M-UI messages + BPMN (§9, §10, §12)", () => {
  it("GET /messages searches external_messages incl. un-correlated", async () => {
    // No subscription for this name/key ⇒ the message is buffered (un-correlated).
    await get("/"); // touch
    const pub = await raw("POST", "/messages", {
      body: {
        workspaceId: "default",
        messageName: "OrphanSignal",
        correlationKey: "nobody-here",
        messageId: "orphan-1",
        payload: { hi: true },
      },
    });
    expect([200, 201, 202]).toContain(pub.status);

    const r = await raw("GET", "/messages?workspaceId=default&messageName=OrphanSignal", { cookie });
    expect(r.status).toBe(200);
    const msg = r.body.messages.find((m: any) => m.correlationKey === "nobody-here");
    expect(msg).toBeTruthy();
    expect(msg.matchedInstanceId).toBeNull();
  });

  it("GET /definitions/versions/{id}/bpmn returns the raw stored XML + hash", async () => {
    const { versionId } = await publishAndStart(DEMO_BPMN, { correlationKey: "ui-bpmn", variables: {} });
    const anon = await raw("GET", `/definitions/versions/${versionId}/bpmn`);
    expect(anon.status).toBe(401); // gated

    const r = await raw("GET", `/definitions/versions/${versionId}/bpmn`, { cookie });
    expect(r.status).toBe(200);
    expect(r.body.bpmnXml).toContain("<bpmn:process");
    expect(r.body.bpmnXmlHash).toBeTruthy();
  });
});

describe("M-UI SSE live-tail (§11)", () => {
  it("streams existing history as id/data SSE events then closes", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, { correlationKey: "ui-sse", variables: { qty: 1, amount: 10 } });
    const id = instance.body.instanceId;

    const res = await SELF.fetch(`${BASE}/instances/${id}/stream`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Read a bounded number of chunks; the initial batch carries existing events.
    for (let i = 0; i < 8 && !buf.includes("data:"); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(buf).toContain(": connected");
    expect(buf).toMatch(/id: \d+\ndata: /);
    expect(buf).toContain("instanceStarted");
  });

  it("requires a session cookie", async () => {
    const { instance } = await publishAndStart(SAGA_BPMN, { correlationKey: "ui-sse-401", variables: { qty: 1, amount: 10 } });
    const res = await SELF.fetch(`${BASE}/instances/${instance.body.instanceId}/stream`);
    expect(res.status).toBe(401);
  });
});
