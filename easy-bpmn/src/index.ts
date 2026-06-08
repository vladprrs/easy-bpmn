// HTTP API Worker — the product boundary. Owns request validation, BPMN
// draft/version endpoints, instance start, message publish, and D1-backed
// inspection. It must NOT leak Cloudflare Workflow internals as the contract
// (e.g. external publishers never supply a workflowInstanceId).

import type { Env } from "./env";
import { z } from "zod";

import {
  createDraftRequestSchema,
  publishMessageRequestSchema,
  startInstanceRequestSchema,
  type ProcessInstanceInspection,
  type PublishMessageResponse,
  type ValidationIssue,
} from "./contracts/api";
import { parseAndValidate } from "./bpmn/validator";
import { AppError, BadRequestError, ConflictError, NotFoundError, PublishRejectedError } from "./runtime/errors";
import { assertPayloadWithinLimit } from "./runtime/payload";
import { getExecutor } from "./runtime/executor";
import { brokerKeyOf, type BrokerPublishResult } from "./runtime/broker-types";
import { newId, nowIso, parseJson, sha256Hex, type JsonObject } from "./util";
import { ensureWorkspace } from "./persistence/db";
import {
  createDraft,
  createVersion,
  getDraft,
  getDraftRow,
  getVersionGraph,
  getVersionRow,
  mapVersion,
  nextVersionNumber,
  setDraftLatestVersion,
} from "./persistence/definitions";
import {
  createInstance,
  getIncidentForInstance,
  getInstance,
} from "./persistence/instances";
import { getExternalMessage, insertExternalMessage } from "./persistence/messages";
import { listInstanceHistory, recordHistory } from "./persistence/history";
import { getIdempotentResult, putIdempotentResult } from "./persistence/idempotency";

export { ProcessWorkflow } from "./workflows/process-workflow";
export { CorrelationBroker } from "./durable-objects/correlation-broker";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function parseBody<T>(schema: z.ZodType<T>, request: Request): Promise<T> {
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

// ---------------------------------------------------------------------------
// Definition drafts
// ---------------------------------------------------------------------------

async function handleCreateDraft(env: Env, request: Request): Promise<Response> {
  const body = await parseBody(createDraftRequestSchema, request);
  const now = nowIso();
  await ensureWorkspace(env.DB, body.workspaceId, now);

  const result = await parseAndValidate(body.bpmnXml);
  const issues = result.issues as ValidationIssue[];
  const status = result.ok ? "valid" : "invalid";
  const draftId = newId("draft");
  await createDraft(env.DB, {
    draftId,
    workspaceId: body.workspaceId,
    name: body.name,
    bpmnXml: body.bpmnXml,
    status,
    validationIssues: issues,
    now,
  });
  await recordHistory(env.DB, {
    workspaceId: body.workspaceId,
    type: "definitionDraftCreated",
    diagnostics: { draftId, status, issueCount: issues.length },
  });

  const draft = await getDraft(env.DB, draftId);
  return json(draft, 201);
}

async function handleGetDraft(env: Env, draftId: string): Promise<Response> {
  const draft = await getDraft(env.DB, draftId);
  if (!draft) throw new NotFoundError(`Draft ${draftId} not found.`);
  return json(draft, 200);
}

async function handlePublishDraft(env: Env, draftId: string): Promise<Response> {
  const row = await getDraftRow(env.DB, draftId);
  if (!row) throw new NotFoundError(`Draft ${draftId} not found.`);

  const result = await parseAndValidate(row.bpmn_xml);
  if (!result.ok || !result.graph) {
    throw new PublishRejectedError(
      "Draft contains publish-blocking validation issues.",
      result.issues,
    );
  }

  const now = nowIso();
  const versionNumber = await nextVersionNumber(env.DB, draftId);
  const bpmnXmlHash = await sha256Hex(row.bpmn_xml);
  const definitionVersionId = newId("pdv");
  await createVersion(env.DB, {
    definitionVersionId,
    draftId,
    workspaceId: row.workspace_id,
    versionNumber,
    bpmnXml: row.bpmn_xml,
    bpmnXmlHash,
    graph: result.graph,
    now,
  });
  await setDraftLatestVersion(env.DB, draftId, definitionVersionId, now);
  await recordHistory(env.DB, {
    workspaceId: row.workspace_id,
    type: "definitionPublished",
    diagnostics: { draftId, definitionVersionId, versionNumber, bpmnXmlHash },
  });

  const versionRow = await getVersionRow(env.DB, definitionVersionId);
  return json(await mapVersion(env.DB, versionRow!), 201);
}

async function handleGetVersion(env: Env, versionId: string): Promise<Response> {
  const row = await getVersionRow(env.DB, versionId);
  if (!row) throw new NotFoundError(`Definition version ${versionId} not found.`);
  return json(await mapVersion(env.DB, row), 200);
}

// ---------------------------------------------------------------------------
// Process instances
// ---------------------------------------------------------------------------

async function handleStartInstance(env: Env, versionId: string, request: Request): Promise<Response> {
  const body = await parseBody(startInstanceRequestSchema, request);
  // Initial variables ride into the Workflow / worker request, so reject
  // oversized payloads explicitly here rather than failing inside the runtime.
  assertPayloadWithinLimit(body.variables, `start variables for version '${versionId}'`);

  const versionRow = await getVersionRow(env.DB, versionId);
  if (!versionRow) throw new NotFoundError(`Definition version ${versionId} not found or not published.`);

  if (body.idempotencyKey) {
    const prior = await getIdempotentResult<unknown>(env.DB, "startInstance", body.idempotencyKey);
    if (prior) return json(prior, 201);
  }

  const graph = await getVersionGraph(env.DB, versionId);
  if (!graph) throw new ConflictError("Definition version has no executable profile.");

  const now = nowIso();
  await ensureWorkspace(env.DB, body.workspaceId, now);

  const instanceId = newId("pi");
  const workflowInstanceId = instanceId;
  await createInstance(env.DB, {
    instanceId,
    workspaceId: body.workspaceId,
    definitionVersionId: versionId,
    workflowInstanceId,
    businessKey: body.businessKey ?? null,
    correlationKey: body.correlationKey,
    startElementId: graph.startElementId,
    variables: body.variables as JsonObject,
    now,
  });

  const executor = getExecutor(env);
  await executor.start({
    workspaceId: body.workspaceId,
    instanceId,
    definitionVersionId: versionId,
    correlationKey: body.correlationKey,
    initialVariables: body.variables as JsonObject,
  });

  const instance = await getInstance(env.DB, instanceId);
  if (body.idempotencyKey) {
    await putIdempotentResult(env.DB, "startInstance", body.idempotencyKey, instance, now);
  }
  return json(instance, 201);
}

async function handleGetInstance(env: Env, instanceId: string): Promise<Response> {
  const instance = await getInstance(env.DB, instanceId);
  if (!instance) throw new NotFoundError(`Process instance ${instanceId} not found.`);
  const history = await listInstanceHistory(env.DB, instanceId);
  const incident = instance.status === "incident" ? await getIncidentForInstance(env.DB, instanceId) : null;
  const inspection: ProcessInstanceInspection = {
    ...instance,
    historySummary: history,
    diagnostics: {
      workflowInstanceId: instance.workflowInstanceId,
      executionMode: env.EXECUTION_MODE,
      historyCount: history.length,
    },
    incident,
  };
  return json(inspection, 200);
}

async function handleGetInstanceHistory(env: Env, instanceId: string): Promise<Response> {
  const instance = await getInstance(env.DB, instanceId);
  if (!instance) throw new NotFoundError(`Process instance ${instanceId} not found.`);
  const events = await listInstanceHistory(env.DB, instanceId);
  return json({ events }, 200);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function handlePublishMessage(env: Env, request: Request): Promise<Response> {
  const body = await parseBody(publishMessageRequestSchema, request);
  assertPayloadWithinLimit(body.payload, `message '${body.messageName}'`);

  const now = nowIso();
  await ensureWorkspace(env.DB, body.workspaceId, now);

  const externalMessageId = newId("msg");
  const payloadHash = await sha256Hex(JSON.stringify(body.payload));
  const brokerKey = brokerKeyOf(body.workspaceId, body.messageName, body.correlationKey);
  const brokerId = env.CORRELATION_BROKER.idFromName(brokerKey);
  const broker = env.CORRELATION_BROKER.get(brokerId);

  const result = (await broker.publishMessage({
    workspaceId: body.workspaceId,
    messageName: body.messageName,
    correlationKey: body.correlationKey,
    messageId: body.messageId,
    externalMessageId,
    payload: body.payload as JsonObject,
    now,
  })) as BrokerPublishResult;

  const base = {
    messageName: body.messageName,
    correlationKey: body.correlationKey,
    messageId: body.messageId,
  };

  if (result.outcome === "duplicate") {
    await recordHistory(env.DB, {
      workspaceId: body.workspaceId,
      externalMessageId: result.duplicateOf,
      type: "duplicateIgnored",
      diagnostics: { messageId: body.messageId, duplicateOf: result.duplicateOf, originalOutcome: result.originalOutcome },
      payloadSnapshot: body.payload as JsonObject,
    });
    const response: PublishMessageResponse = {
      ...base,
      outcome: "duplicate",
      externalMessageId: result.externalMessageId,
      instanceId: result.instanceId ?? null,
      duplicateOf: result.duplicateOf,
    };
    return json(response, 202);
  }

  if (result.outcome === "buffered") {
    await insertExternalMessage(env.DB, {
      externalMessageId,
      workspaceId: body.workspaceId,
      messageName: body.messageName,
      correlationKey: body.correlationKey,
      messageId: body.messageId,
      payload: body.payload as JsonObject,
      payloadHash,
      outcome: "buffered",
      finalOutcome: "buffered",
      receivedAt: now,
      expiresAt: result.expiresAt,
    });
    await recordHistory(env.DB, {
      workspaceId: body.workspaceId,
      externalMessageId,
      type: "messageBuffered",
      diagnostics: { expiresAt: result.expiresAt },
      payloadSnapshot: body.payload as JsonObject,
    });
    const response: PublishMessageResponse = { ...base, outcome: "buffered", externalMessageId };
    return json(response, 202);
  }

  if (result.outcome === "late") {
    // A different messageId arrived after the instance advanced past its Receive
    // Task. It cannot correlate; record it (finalOutcome `late`) and reject.
    const reason =
      "No active subscription: the matching process already advanced past its Receive Task (late message).";
    await insertExternalMessage(env.DB, {
      externalMessageId,
      workspaceId: body.workspaceId,
      messageName: body.messageName,
      correlationKey: body.correlationKey,
      messageId: body.messageId,
      payload: body.payload as JsonObject,
      payloadHash,
      outcome: "rejected",
      finalOutcome: "late",
      reason,
      receivedAt: now,
    });
    await recordHistory(env.DB, {
      workspaceId: body.workspaceId,
      externalMessageId,
      type: "messageLate",
      diagnostics: { reason, previousInstanceId: result.previousInstanceId },
      payloadSnapshot: body.payload as JsonObject,
    });
    const response: PublishMessageResponse = { ...base, outcome: "rejected", externalMessageId, reason };
    return json(response, 409);
  }

  // correlated — record canonical message, then deliver to the waiting instance.
  await insertExternalMessage(env.DB, {
    externalMessageId,
    workspaceId: body.workspaceId,
    messageName: body.messageName,
    correlationKey: body.correlationKey,
    messageId: body.messageId,
    payload: body.payload as JsonObject,
    payloadHash,
    outcome: "correlated",
    finalOutcome: "correlated",
    matchedInstanceId: result.instanceId,
    matchedSubscriptionId: result.subscriptionId,
    receivedAt: now,
    correlatedAt: now,
  });
  await recordHistory(env.DB, {
    workspaceId: body.workspaceId,
    instanceId: result.instanceId,
    externalMessageId,
    type: "messageReceived",
    diagnostics: { outcome: "correlated", subscriptionId: result.subscriptionId },
    payloadSnapshot: body.payload as JsonObject,
  });

  const executor = getExecutor(env);
  await executor.deliver({
    workflowInstanceId: result.workflowInstanceId,
    instanceId: result.instanceId,
    elementId: result.elementId,
    event: result.event,
  });

  const response: PublishMessageResponse = {
    ...base,
    outcome: "correlated",
    externalMessageId,
    instanceId: result.instanceId,
  };
  return json(response, 202);
}

async function handleGetMessage(env: Env, externalMessageId: string): Promise<Response> {
  const message = await getExternalMessage(env.DB, externalMessageId);
  if (!message) throw new NotFoundError(`Message ${externalMessageId} not found.`);
  return json(message, 200);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const seg = url.pathname.split("/").filter(Boolean);
  const method = request.method.toUpperCase();

  if (seg.length === 0) {
    return json({ service: "easy-bpmn", status: "ok" }, 200);
  }

  if (seg[0] === "definitions") {
    if (seg[1] === "drafts") {
      if (seg.length === 2 && method === "POST") return handleCreateDraft(env, request);
      if (seg.length === 3 && method === "GET") return handleGetDraft(env, seg[2]!);
      if (seg.length === 4 && seg[3] === "publish" && method === "POST") return handlePublishDraft(env, seg[2]!);
    }
    if (seg[1] === "versions") {
      if (seg.length === 3 && method === "GET") return handleGetVersion(env, seg[2]!);
      if (seg.length === 4 && seg[3] === "instances" && method === "POST") return handleStartInstance(env, seg[2]!, request);
    }
  }

  if (seg[0] === "instances" && seg[1]) {
    if (seg.length === 2 && method === "GET") return handleGetInstance(env, seg[1]);
    if (seg.length === 3 && seg[2] === "history" && method === "GET") return handleGetInstanceHistory(env, seg[1]);
  }

  if (seg[0] === "messages") {
    if (seg.length === 1 && method === "POST") return handlePublishMessage(env, request);
    if (seg.length === 2 && method === "GET") return handleGetMessage(env, seg[1]!);
  }

  throw new NotFoundError(`No route for ${method} ${url.pathname}.`);
}

function errorResponse(err: unknown): Response {
  if (err instanceof PublishRejectedError) {
    return json({ error: err.message, validationIssues: err.validationIssues }, err.status);
  }
  if (err instanceof AppError) {
    return json({ error: err.message, ...(err.details ? { details: err.details } : {}) }, err.status);
  }
  const message = err instanceof Error ? err.message : "Internal error";
  console.error(JSON.stringify({ level: "error", message: "unhandled", error: message }));
  return json({ error: "Internal error", details: { message } }, 500);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      return errorResponse(err);
    }
  },
} satisfies ExportedHandler<Env>;
