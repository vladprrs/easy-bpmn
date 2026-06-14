// HTTP API Worker — the product boundary. Owns request validation, BPMN
// draft/version endpoints, instance start, message publish, and D1-backed
// inspection. It must NOT leak Cloudflare Workflow internals as the contract
// (e.g. external publishers never supply a workflowInstanceId).

import type { Env } from "./env";
import { z } from "zod";

import {
  activateJobsRequestSchema,
  activateJobsResponseSchema,
  completeJobRequestSchema,
  createDraftRequestSchema,
  failJobRequestSchema,
  mintWorkerCredentialRequestSchema,
  publishMessageRequestSchema,
  startInstanceRequestSchema,
  type JobCallbackAck,
  type LeasedJob,
  type MintWorkerCredentialResponse,
  type ProcessInstanceInspection,
  type PublishMessageResponse,
  type ValidationIssue,
} from "./contracts/api";
import { parseAndValidate } from "./bpmn/validator";
import { AppError, BadRequestError, ConflictError, NotFoundError, PublishRejectedError } from "./runtime/errors";
import { assertPayloadWithinLimit } from "./runtime/payload";
import { getExecutor } from "./runtime/executor";
import { authenticateWorker, generateWorkerToken } from "./runtime/worker-auth";
import { brokerKeyOf, type BrokerPublishResult } from "./runtime/broker-types";
import {
  isTerminalInstanceStatus,
  isoPlusMs,
  newId,
  nowIso,
  parseJson,
  sha256Hex,
  traceIdFor,
  type JsonObject,
} from "./util";
import { ensureWorkspace } from "./persistence/db";
import {
  insertWorkerCredential,
  revokeCredential,
} from "./persistence/worker-credentials";
import {
  completeJobConditional,
  failExpiredLeaseConditional,
  failJobConditional,
  getJobInWorkspace,
  leaseJobs,
  parkExpiredLease,
  parkJobForBackoffConditional,
  selectExpiredInFlightLeases,
  type ExpiredLeaseRow,
} from "./persistence/jobs";
import { computeBackoffMs } from "./runtime/retry-policy";
import { getSagaStep } from "./persistence/saga";
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
  createAttempt,
  createInstance,
  finishLatestStartedAttempt,
  getIncidentForInstance,
  getInstance,
  getInstanceRow,
  getOpenIncidentsForInstance,
  listActiveSubscriptionsForInstance,
  mergeInstanceVariables,
  resolveAllOpenIncidents,
  resolveIncident,
  subscriptionSupersededStmt,
  transitionStatusGuarded,
} from "./persistence/instances";
import { getExternalMessage, insertExternalMessage } from "./persistence/messages";
import { listInstanceHistory, recordHistory, tailInstanceHistory } from "./persistence/history";
import { handleUiRoute } from "./ui/router";
import { listInstanceSubscriptions, listInstancesFiltered } from "./persistence/ui-queries";
import { getIdempotentResult, putIdempotentResult } from "./persistence/idempotency";
import { loadGraphForInstance, resumeInline } from "./runtime/engine";
import { cancelArmedTimersForInstance, supersedeBrokerSubscription } from "./runtime/boundary-timer";
import { armCohortLeaseExpiryTerminators } from "./runtime/forward-task";
import { listTimersForInstance } from "./persistence/timers";
import { abandonActiveForwardJobs, resetJobForRetry } from "./persistence/jobs";
import { LIVE_TOKEN_STATUSES, listLiveTokens, listTokens, parseOverlay } from "./persistence/tokens";
import {
  countPendingSteps,
  getFailedStep,
  getSagaStepsForInstance,
  updateCompensationStatusStmt,
} from "./persistence/saga";
import {
  cancelInstanceRequestSchema,
  retryInstanceRequestSchema,
  type InstanceListResponse,
  type SagaInspection,
  type TokenInspection,
} from "./contracts/api";

export { ProcessWorkflow } from "./workflows/process-workflow";
export { CorrelationBroker } from "./durable-objects/correlation-broker";
export { JobScheduler } from "./durable-objects/job-scheduler";

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
  const incident =
    instance.status === "incident" || instance.status === "compensationFailed"
      ? await getIncidentForInstance(env.DB, instanceId)
      : null;
  // M3-L1 (TASK-39): expose ALL open incidents, not just the latest — an
  // instance can carry several live incidents (e.g. a Hazard mid-compensation
  // plus a later compensationFailure).
  const openIncidents = await getOpenIncidentsForInstance(env.DB, instanceId);

  // Saga view — present once the instance has a transaction ledger.
  const steps = await getSagaStepsForInstance(env.DB, instanceId);
  let saga: SagaInspection | null = null;
  if (steps.length > 0) {
    const phase =
      instance.status === "compensating" || instance.status === "compensated" || instance.status === "compensationFailed"
        ? instance.status
        : "forward";
    saga = {
      phase,
      traceId: traceIdFor(instanceId),
      steps: steps.map((s) => ({
        elementId: s.elementId,
        seq: s.seq,
        compensationStatus: s.compensationStatus,
        compensationElementId: s.compensationElementId,
        compensationTaskType: s.compensationTaskType,
      })),
    };
  }

  // M3-L3 (TASK-44): the model-timer block, read from D1 (Workflow internals hidden).
  const timerRows = await listTimersForInstance(env.DB, instanceId);
  const timers = timerRows.map((t) => ({
    timerId: t.timerId,
    elementId: t.elementId,
    occurrence: t.occurrence,
    kind: t.kind,
    status: t.status,
    attachedToRef: t.attachedToRef,
    gatewayId: t.gatewayId,
    fireAt: t.fireAt,
    firedAt: t.firedAt,
  }));

  // M4-L6.3 (TASK-53): live token frontier — read from D1 (execution_tokens).
  // variablesOverlay is returned verbatim (inline or {"__r2":"<key>"} reference)
  // so callers may rehydrate from R2 if needed; this endpoint does not fetch R2.
  const tokenRows = await listTokens(env.DB, instanceId);
  const tokens: TokenInspection[] = tokenRows.map((row) => ({
    tokenId: row.token_id,
    positionElementId: row.position_element_id,
    status: row.status as TokenInspection["status"],
    regionId: row.region_id,
    regionActivation: row.region_activation,
    branchFlowId: row.branch_flow_id,
    parentTokenId: row.parent_token_id,
    variablesOverlay: parseOverlay(row),
  }));
  // If >1 live tokens the instance is in a concurrent state: currentElementId
  // loses meaning (multiple positions) and MUST be null per the L6.3 contract.
  const liveTokenCount = tokens.filter((t) => LIVE_TOKEN_STATUSES.includes(t.status)).length;

  // M-UI (§9): the "Waiting on" block — active message subscriptions so a
  // `waiting` instance shows WHAT it is waiting for (the most common stuck case).
  const subscriptions = await listInstanceSubscriptions(env.DB, instanceId);

  const inspection: ProcessInstanceInspection = {
    ...instance,
    ...(liveTokenCount > 1 ? { currentElementId: null } : {}),
    historySummary: history,
    diagnostics: {
      workflowInstanceId: instance.workflowInstanceId,
      executionMode: env.EXECUTION_MODE,
      historyCount: history.length,
      traceId: traceIdFor(instanceId),
    },
    incident,
    openIncidents,
    saga,
    ...(timers.length > 0 ? { timers } : {}),
    ...(tokens.length > 0 ? { tokens } : {}),
    ...(subscriptions.length > 0 ? { subscriptions } : {}),
  };
  return json(inspection, 200);
}

async function handleGetInstanceHistory(env: Env, instanceId: string, url: URL): Promise<Response> {
  const instance = await getInstanceRow(env.DB, instanceId);
  if (!instance) throw new NotFoundError(`Process instance ${instanceId} not found.`);
  // M-UI (§11/§12): cursor delta when `?since=` is supplied (the SSE poll
  // fallback). `since` absent ⇒ full history (back-compat) + a nextCursor so the
  // SPA can switch to the live tail without a gap. `events` stays the same shape.
  const sinceRaw = url.searchParams.get("since");
  const sinceParsed = sinceRaw != null && sinceRaw !== "" ? parseInt(sinceRaw, 10) : null;
  const since = sinceParsed != null && Number.isNaN(sinceParsed) ? null : sinceParsed;
  const { rows, nextCursor } = await tailInstanceHistory(env.DB, instanceId, since);
  return json({ events: rows.map((r) => r.event), nextCursor }, 200);
}

async function handleListInstances(env: Env, url: URL): Promise<Response> {
  const workspaceId = url.searchParams.get("workspaceId");
  if (!workspaceId) throw new BadRequestError("workspaceId query parameter is required.");
  // M-UI (§12): `status` accepts a comma list (multi-status triage); new `search`
  // (LIKE business/correlation key) and `sagaId` (join definition_versions.draft_id).
  const statusRaw = url.searchParams.get("status");
  const statuses = statusRaw
    ? statusRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const sagaId = url.searchParams.get("sagaId") ?? undefined;
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50), 200);
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? parseInt(cursorRaw, 10) : undefined;
  const { items, nextCursor } = await listInstancesFiltered(env.DB, {
    workspaceId,
    statuses,
    search,
    sagaId,
    limit,
    cursor,
  });
  const response: InstanceListResponse = { instances: items, nextCursor };
  return json(response, 200);
}

// ---------------------------------------------------------------------------
// Operator remediation verbs (cancel / retry) — status-guarded
// ---------------------------------------------------------------------------

// Cancellable from running/waiting (active) OR from an in-transaction Hazard
// 'incident' (design §4.2/§4.5: operators may /cancel a Hazard to force the
// reverse compensation of already-completed steps).
const CANCELLABLE_FROM = ["running", "waiting", "incident"] as const;

/**
 * Frontier-wide broker release (M4-L5, design §8.1): supersede every ACTIVE message
 * subscription of an instance on cancel — a best-effort broker supersede per key (so a
 * late publish gets the stable buffered/no-match outcome) + the `active → superseded`
 * D1 flip. Prevents a leaked broker key when a region cohort token parked at a message
 * catch is abandoned without eagerly failing its forward work.
 */
async function releaseActiveSubscriptionsForInstance(env: Env, instanceId: string, now: string): Promise<void> {
  for (const sub of await listActiveSubscriptionsForInstance(env.DB, instanceId)) {
    // Per-subscription best-effort: one release failure (broker hiccup or D1 error)
    // must NOT abort the cancel before the status transition + resumeInline, which
    // would strand the instance. A leaked broker key is recoverable via its TTL;
    // a stuck cancel is not.
    try {
      await supersedeBrokerSubscription(env, sub);
      await subscriptionSupersededStmt(env.DB, sub.subscription_id, now).run();
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", message: "releaseActiveSubscription failed", subscriptionId: sub.subscription_id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}

async function handleCancelInstance(env: Env, instanceId: string, request: Request): Promise<Response> {
  await parseBody(cancelInstanceRequestSchema, request).catch(() => ({}));
  const inst = await getInstance(env.DB, instanceId);
  if (!inst) throw new NotFoundError(`Process instance ${instanceId} not found.`);
  if (!(CANCELLABLE_FROM as readonly string[]).includes(inst.status)) {
    throw new ConflictError(`Instance ${instanceId} cannot be cancelled from status '${inst.status}'.`);
  }
  const now = nowIso();
  // M4-L5 (design §8.1): a region (parallel/inclusive) instance may have several
  // live cohort tokens at cancel. It must NOT eagerly fail their forward jobs —
  // `abandonActiveForwardJobs` flips `locked → failed`, so a late `complete` gets a
  // 0-row no-op and LEAKS the executed side-effect (no ledger row → never
  // compensated). Instead leave the cohort jobs in place with per-token terminators
  // armed (so a genuinely abandoned job still goes terminal) and let a late complete
  // land as a straggler. Still release every active broker subscription so no broker
  // key leaks. The single-token (non-region) path keeps the M1–M3 eager abandon.
  // Load the graph to classify region vs single-token. Do NOT swallow a load
  // failure: silently defaulting to non-region would take the EAGER-abandon path on
  // a region instance and leak a late complete (design §8.1). A started instance
  // always has a parsed published graph; if it genuinely cannot load, the downstream
  // resumeInline would fail anyway, so surface it rather than degrade to unsafe.
  const graph = await loadGraphForInstance(env, instanceId);
  const isRegion = !!graph.regions && Object.keys(graph.regions).length > 0;
  if (isRegion) {
    await releaseActiveSubscriptionsForInstance(env, instanceId, now);
  } else {
    // Abandon in-flight forward work so a late worker callback no-ops, and end the
    // suspended Workflow (if any) so subsequent job callbacks drive compensation
    // inline rather than sendEvent-ing a Workflow that is waiting on the wrong job.
    await abandonActiveForwardJobs(env.DB, instanceId, now);
  }
  // M3-L3 (TASK-44, design §4.3.2 exit d): settle every armed boundary timer so a
  // stray alarm afterwards is a decided no-op — no mid-compensation firing (gate 10).
  await cancelArmedTimersForInstance(env, instanceId);
  await getExecutor(env).terminate(instanceId);

  const pending = await countPendingSteps(env.DB, instanceId);
  // M4-L5: a region instance with live cohort tokens must NOT take the empty-ledger
  // terminal shortcut — a late straggler still owes a ledger row + compensation, so
  // it enters `compensating` and the quiescence barrier holds until the cohort drains.
  const liveCohort = isRegion ? (await listLiveTokens(env.DB, instanceId)).length : 0;
  if (pending === 0 && liveCohort === 0) {
    const changed = await transitionStatusGuarded(env.DB, instanceId, [...CANCELLABLE_FROM], "cancelled", now);
    if (changed > 0) {
      // M3-L1 (TASK-39): a terminal empty-ledger cancel closes ALL open incidents
      // (here "all" is correct) so none is left dangling 'open' on a terminal
      // instance — the previously-known terminal-'open' wart.
      await resolveAllOpenIncidents(env.DB, instanceId, "operatorResolved", now);
      await recordHistory(env.DB, { workspaceId: inst.workspaceId, instanceId, type: "instanceCancelled", diagnostics: { by: "operator", emptyLedger: true } });
    }
    return json(await getInstance(env.DB, instanceId), 200);
  }

  // Status-conditional → only the first cancel initiates one reverse pass.
  const changed = await transitionStatusGuarded(env.DB, instanceId, [...CANCELLABLE_FROM], "compensating", now);
  if (changed > 0) {
    // M4-L5 (design §8.2): arm a per-token lease-expiry terminator for every in-flight
    // cohort forward job so the quiescence barrier drains without a future worker poll.
    if (isRegion) await armCohortLeaseExpiryTerminators(env, instanceId);
    if (inst.status === "incident") {
      // Target ONLY the current Hazard incident (M3-L1, TASK-39) so a sibling
      // incident is never collaterally moved into the compensation lifecycle. An
      // 'incident' status implies a Hazard row exists; if it is somehow absent we
      // skip rather than silently flip ALL incidents.
      const hazard = await getIncidentForInstance(env.DB, instanceId);
      if (hazard?.incidentId) {
        await resolveIncident(env.DB, instanceId, hazard.incidentId, "compensating", now);
      }
    }
    await recordHistory(env.DB, { workspaceId: inst.workspaceId, instanceId, type: "transactionCancelled", diagnostics: { by: "operator", fromHazard: inst.status === "incident" } });
    await resumeInline(env, instanceId);
  }
  return handleGetInstance(env, instanceId);
}

async function handleRetryInstance(env: Env, instanceId: string, request: Request): Promise<Response> {
  const body = await parseBody(retryInstanceRequestSchema, request).catch(() => ({}) as { variables?: JsonObject });
  const inst = await getInstance(env.DB, instanceId);
  if (!inst) throw new NotFoundError(`Process instance ${instanceId} not found.`);
  const now = nowIso();
  if (body.variables) await mergeInstanceVariables(env.DB, instanceId, body.variables as JsonObject, now);
  const fresh = await getInstanceRow(env.DB, instanceId);
  const variablesJson = fresh?.variables ?? "{}";

  if (inst.status === "compensationFailed") {
    const failed = await getFailedStep(env.DB, instanceId);
    if (!failed) throw new ConflictError(`Instance ${instanceId} has no failed compensation step to retry.`);
    const incident = await getIncidentForInstance(env.DB, instanceId);
    await resetJobForRetry(env.DB, { instanceId, elementId: failed.elementId, isCompensation: true, inputVariables: variablesJson, now });
    await updateCompensationStatusStmt(env.DB, { stepId: failed.stepId, status: "pending", now }).run();
    // Resolve ONLY this compensationFailure incident (M3-L1, TASK-39) so a sibling
    // Hazard 'compensating' is not collaterally flipped to operatorResolved. If no
    // incident row is present we skip rather than fall through to flipping ALL.
    if (incident?.incidentId) {
      await resolveIncident(env.DB, instanceId, incident.incidentId, "operatorResolved", now);
    }
    const changed = await transitionStatusGuarded(env.DB, instanceId, ["compensationFailed"], "compensating", now);
    if (changed === 0) throw new ConflictError(`Instance ${instanceId} is no longer retryable.`);
    await recordHistory(env.DB, { workspaceId: inst.workspaceId, instanceId, elementId: failed.elementId, type: "operatorRetry", diagnostics: { target: "compensation" } });
    await resumeInline(env, instanceId);
    return handleGetInstance(env, instanceId);
  }

  if (inst.status === "incident") {
    const incident = await getIncidentForInstance(env.DB, instanceId);
    const elementId = incident?.elementId;
    if (!elementId) throw new ConflictError(`Instance ${instanceId} has no incident element to retry.`);
    // For a non-task incident element (e.g. an exclusiveGateway noPath) there is
    // no job row, so this matches 0 rows BY DESIGN — the retry then just
    // re-walks, and the failed visit (which recorded no decision row) is
    // re-evaluated fresh against the patched variables.
    await resetJobForRetry(env.DB, { instanceId, elementId, isCompensation: false, inputVariables: variablesJson, now });
    // Resolve ONLY the targeted incident (M3-L1, TASK-39). The elementId guard
    // above already proves an incident row is present; the explicit id guard keeps
    // the absence path from ever falling through to flipping ALL.
    if (incident?.incidentId) {
      await resolveIncident(env.DB, instanceId, incident.incidentId, "operatorResolved", now);
    }
    const changed = await transitionStatusGuarded(env.DB, instanceId, ["incident"], "running", now);
    if (changed === 0) throw new ConflictError(`Instance ${instanceId} is no longer retryable.`);
    await recordHistory(env.DB, { workspaceId: inst.workspaceId, instanceId, elementId, type: "operatorRetry", diagnostics: { target: "forward" } });
    await resumeInline(env, instanceId, elementId);
    return handleGetInstance(env, instanceId);
  }

  throw new ConflictError(`Instance ${instanceId} has nothing to retry from status '${inst.status}'.`);
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
    workflowEventType: result.workflowEventType,
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
// Worker credentials (pull data plane auth)
// ---------------------------------------------------------------------------

async function handleMintWorkerCredential(env: Env, request: Request): Promise<Response> {
  const body = await parseBody(mintWorkerCredentialRequestSchema, request);
  const now = nowIso();
  await ensureWorkspace(env.DB, body.workspaceId, now);
  const token = generateWorkerToken();
  const tokenHash = await sha256Hex(token);
  const credentialId = newId("wcred");
  await insertWorkerCredential(env.DB, {
    credentialId,
    workspaceId: body.workspaceId,
    tokenHash,
    label: body.label ?? null,
    now,
  });
  const response: MintWorkerCredentialResponse = {
    credentialId,
    workspaceId: body.workspaceId,
    token, // shown exactly once — never retrievable again
    label: body.label ?? null,
    createdAt: now,
  };
  return json(response, 201);
}

async function handleRevokeWorkerCredential(env: Env, credentialId: string): Promise<Response> {
  // Idempotent: revoking an unknown / already-revoked credential is a no-op 200.
  await revokeCredential(env.DB, credentialId, nowIso());
  return json({ credentialId, revoked: true }, 200);
}

// ---------------------------------------------------------------------------
// Pull worker jobs (workspaceId derived from the credential, never the body)
// ---------------------------------------------------------------------------

const DEFAULT_LEASE_MS = 30_000;
const MAX_LEASE_MS = 5 * 60_000;
const MAX_JOBS_PER_ACTIVATE = 50;
const MAX_WAIT_MS = 25_000;

async function handleActivateJobs(env: Env, request: Request): Promise<Response> {
  const { workspaceId } = await authenticateWorker(request, env);
  const body = await parseBody(activateJobsRequestSchema, request);

  const maxJobs = Math.min(Math.max(1, body.maxJobs ?? 1), MAX_JOBS_PER_ACTIVATE);
  const leaseMs = Math.min(body.leaseMs ?? DEFAULT_LEASE_MS, MAX_LEASE_MS);
  const waitMs = Math.min(body.waitMs ?? 0, MAX_WAIT_MS);
  const deadline = Date.now() + waitMs;

  let leased = await leaseOnce(env, workspaceId, body.taskType, body.workerId, leaseMs, maxJobs);
  // Bounded long-poll: re-claim until something appears or waitMs elapses.
  while (leased.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    leased = await leaseOnce(env, workspaceId, body.taskType, body.workerId, leaseMs, maxJobs);
  }

  const response = activateJobsResponseSchema.parse({ jobs: leased });
  return json(response, 200);
}

async function leaseOnce(
  env: Env,
  workspaceId: string,
  taskType: string,
  workerId: string,
  leaseMs: number,
  limit: number,
): Promise<LeasedJob[]> {
  const now = nowIso();
  // Reclaim pre-pass (design §4.1 reclaim leg): an EXPIRED in-flight lease (a
  // crashed/slow worker's lapsed lock) is parked behind backoff before it can be
  // re-leased, so a reclaim is spaced like a retryable fail rather than re-handed
  // instantly. Reclaim re-leases bump attempt_count, so once the retry budget is
  // exhausted (TASK-40) the lapsed lease is routed to the SAME exhaustion path as
  // an explicit /jobs/fail — otherwise a job exhausted purely through lease expiry
  // would retry forever.
  for (const j of await selectExpiredInFlightLeases(env.DB, workspaceId, taskType, now)) {
    if (j.attempt_count >= j.retry_limit) {
      await exhaustExpiredLease(env, workspaceId, j, now);
    } else {
      await parkExpiredLease(env.DB, j.job_id, isoPlusMs(now, computeBackoffMs(j.attempt_count)), now);
    }
  }

  const leaseUntil = isoPlusMs(now, leaseMs);
  const lockToken = newId("lock");
  const rows = await leaseJobs(env.DB, {
    workspaceId,
    taskType,
    workerId,
    lockToken,
    leaseUntil,
    now,
    limit,
  });
  const jobs: LeasedJob[] = [];
  for (const r of rows) {
    const traceId = traceIdFor(r.instance_id);
    const job: LeasedJob = {
      jobId: r.job_id,
      instanceId: r.instance_id,
      elementId: r.element_id,
      taskType: r.task_type,
      isCompensation: r.is_compensation === 1,
      attempt: r.attempt_count,
      lockToken: r.lock_token,
      traceId,
      variables: parseJson<JsonObject>(r.input_variables, {}),
    };
    if (r.is_compensation === 1) {
      // A compensation job is seeded with the compensated forward step's captured
      // input + output from the ledger (design §4.4 / §4.3).
      const step = await getSagaStep(env.DB, r.instance_id, r.compensates_element_id ?? r.element_id, r.occurrence);
      if (step) {
        job.originalInput = step.capturedInput;
        job.capturedOutput = step.capturedOutput;
      }
    }
    jobs.push(job);
    await recordHistory(env.DB, {
      workspaceId,
      instanceId: r.instance_id,
      elementId: r.element_id,
      type: "jobActivated",
      diagnostics: { jobId: r.job_id, workerId, attempt: r.attempt_count, traceId, isCompensation: r.is_compensation === 1 },
    });
    // M-UI §9: record the per-attempt request the worker received (the Attempts
    // drill-down). Finished on the worker's complete/fail callback.
    await createAttempt(env.DB, {
      jobId: r.job_id,
      instanceId: r.instance_id,
      attemptNumber: r.attempt_count,
      requestPayload: {
        variables: job.variables,
        ...(job.originalInput !== undefined ? { originalInput: job.originalInput } : {}),
        ...(job.capturedOutput !== undefined ? { capturedOutput: job.capturedOutput } : {}),
      },
      now,
    });
  }
  return jobs;
}

/**
 * Shared terminal-failure tail (TASK-40 review): every producer that settles a job
 * to `failed` writes the SAME `jobFailed` audit row and delivers the SAME
 * `{outcome:'failed'}` engine event, so the operator-visible history shape
 * (`/instances/{id}/history`) and the wire shape stay identical across routes —
 * worker `/jobs/fail` exhaustion + business error, the reclaim/lease-expiry route,
 * and (M3-L3) timer-driven exhaustion. The engine refetches the job row and routes
 * on its `error_code`, so the event's `retryable` is diagnostics-only; it is kept on
 * the wire (and mirrored in the audit row) for observability. The audit `retryable`
 * convention here is "the failure was of retryable (technical) class AND was not
 * declared non-retryable": a naturally budget-exhausted technical failure is still
 * `retryable: true`; only an explicit worker `retryable:false` or a business error
 * (errorCode set) logs `false`.
 */
async function deliverJobFailed(
  env: Env,
  args: {
    workspaceId: string;
    instanceId: string;
    elementId: string;
    jobId: string;
    errorCode: string | null;
    retryable: boolean;
    reason: string;
    isCompensation: boolean;
  },
): Promise<void> {
  await recordHistory(env.DB, {
    workspaceId: args.workspaceId,
    instanceId: args.instanceId,
    elementId: args.elementId,
    type: "jobFailed",
    diagnostics: {
      jobId: args.jobId,
      errorCode: args.errorCode,
      retryable: args.retryable,
      reason: args.reason,
      isCompensation: args.isCompensation,
    },
  });
  await getExecutor(env).deliverJobResult({
    workflowInstanceId: args.instanceId,
    instanceId: args.instanceId,
    elementId: args.elementId,
    event: { outcome: "failed", jobId: args.jobId, retryable: args.retryable, errorCode: args.errorCode, reason: args.reason },
  });
}

/**
 * Reclaim exhaustion (TASK-40): a lapsed in-flight lease whose retry budget is
 * spent terminates via the SAME exhaustion path as an explicit `/jobs/fail` with
 * the budget exhausted. The transition is guarded on the lapsed-lease predicate
 * (no worker token exists — the lease lapsed), so a concurrent complete/re-lease
 * wins the 0-row race and we DELIVER NOTHING in that case. On a 1-row win we write
 * the audit `jobFailed` row and deliver `{outcome:'failed', errorCode:null}` so the
 * engine runs its exhaustion path: a FORWARD job → serviceTaskFailure Hazard
 * (`handleForwardFailure` re-reads the row and routes on error_code=null); a
 * COMPENSATION job → compensationFailure (the engine resumes the reverse pass and
 * reads the now-`failed` comp job), exactly as a worker `fail` of either would.
 * The event's `retryable`/`errorCode` are informational — the engine refetches the
 * job row and never branches on them for correctness.
 */
async function exhaustExpiredLease(
  env: Env,
  workspaceId: string,
  j: ExpiredLeaseRow,
  now: string,
): Promise<void> {
  const changed = await failExpiredLeaseConditional(env.DB, j.job_id, now);
  if (changed === 0) return; // a concurrent complete/re-lease won — do not deliver
  // A reclaim/lease-expiry exhaustion is a TECHNICAL-class failure whose budget is
  // merely spent — no worker declared it non-retryable — so the audit convention
  // logs it `retryable: true`, matching handleFailJob's naturally-exhausted case.
  await deliverJobFailed(env, {
    workspaceId,
    instanceId: j.instance_id,
    elementId: j.element_id,
    jobId: j.job_id,
    errorCode: null,
    retryable: true,
    reason: "Reclaim retries exhausted (lease expiry).",
    isCompensation: j.is_compensation === 1,
  });
}

async function handleCompleteJob(env: Env, jobId: string, request: Request): Promise<Response> {
  const { workspaceId } = await authenticateWorker(request, env);
  const body = await parseBody(completeJobRequestSchema, request);
  const output = (body.outputVariables ?? {}) as JsonObject;
  // Payload limit BEFORE any delivery (never call sendEvent with an oversized event).
  assertPayloadWithinLimit(output, `job '${jobId}' output`);

  const idemKey = `${jobId}:${body.lockToken}`;
  const prior = await getIdempotentResult<JobCallbackAck>(env.DB, "workerCallback", idemKey);
  if (prior) return json(prior, 200);

  const job = await getJobInWorkspace(env.DB, jobId, workspaceId);
  if (!job) throw new NotFoundError(`Job ${jobId} not found.`);

  const now = nowIso();
  // Terminal job / instance → 200 no-op ack (never permastuck an at-least-once worker).
  if (job.status === "completed" || job.status === "failed" || isTerminalInstanceStatus(job.instance_status)) {
    const ack: JobCallbackAck = { jobId, outcome: "noop", disposition: "ignored" };
    await putIdempotentResult(env.DB, "workerCallback", idemKey, ack, now);
    return json(ack, 200);
  }

  const changes = await completeJobConditional(env.DB, { jobId, lockToken: body.lockToken, output, now });
  if (changes === 0) {
    // A concurrent duplicate (same jobId+lockToken) may have committed first —
    // return its stable prior outcome rather than a spurious 409. A genuinely
    // stale token has no record under this key and still 409s.
    const raced = await getIdempotentResult<JobCallbackAck>(env.DB, "workerCallback", idemKey);
    if (raced) return json(raced, 200);
    throw new ConflictError(`Job ${jobId} could not be completed: the lock token is stale or the job is not currently leased.`);
  }

  const ack: JobCallbackAck = { jobId, outcome: "completed", disposition: "applied" };
  await putIdempotentResult(env.DB, "workerCallback", idemKey, ack, now);
  await finishLatestStartedAttempt(env.DB, jobId, { status: "succeeded", responsePayload: output, now });
  await recordHistory(env.DB, {
    workspaceId,
    instanceId: job.instance_id,
    elementId: job.element_id,
    type: "jobCompleted",
    diagnostics: { jobId },
    payloadSnapshot: output,
  });

  await getExecutor(env).deliverJobResult({
    workflowInstanceId: job.instance_id,
    instanceId: job.instance_id,
    elementId: job.element_id,
    event: { outcome: "completed", jobId, output },
  });
  return json(ack, 200);
}

async function handleFailJob(env: Env, jobId: string, request: Request): Promise<Response> {
  const { workspaceId } = await authenticateWorker(request, env);
  const body = await parseBody(failJobRequestSchema, request);

  const idemKey = `${jobId}:${body.lockToken}`;
  const prior = await getIdempotentResult<JobCallbackAck>(env.DB, "workerCallback", idemKey);
  if (prior) return json(prior, 200);

  const job = await getJobInWorkspace(env.DB, jobId, workspaceId);
  if (!job) throw new NotFoundError(`Job ${jobId} not found.`);

  const now = nowIso();
  if (job.status === "completed" || job.status === "failed" || isTerminalInstanceStatus(job.instance_status)) {
    const ack: JobCallbackAck = { jobId, outcome: "noop", disposition: "ignored" };
    await putIdempotentResult(env.DB, "workerCallback", idemKey, ack, now);
    return json(ack, 200);
  }

  // Business error (errorCode set) → terminal-for-the-step, the engine raises the
  // BPMN error → compensation. Technical → re-leasable unless retries exhausted,
  // and then only AFTER an exponential backoff park (design §4.1): the job stays
  // 'locked' with no lock_token and lock_expires_at = now + backoff, so the
  // activate gate re-leases it only once the delay has elapsed.
  // `retryable` is HONORED (TASK-40): omitted/true ⇒ retryable (default); false ⇒
  // the worker declares the technical failure permanent, so remaining retries are
  // skipped and the job is exhausted immediately (the standard exhaustion path).
  const isBusiness = !!body.errorCode;
  const retryable = body.retryable !== false;
  const willRetry = !isBusiness && retryable && job.attempt_count < job.retry_limit;
  const targetStatus: "created" | "failed" = isBusiness ? "failed" : willRetry ? "created" : "failed";

  let parkUntil: string | null = null;
  let changes: number;
  if (willRetry) {
    parkUntil = isoPlusMs(now, computeBackoffMs(job.attempt_count));
    changes = await parkJobForBackoffConditional(env.DB, { jobId, lockToken: body.lockToken, parkUntil, now });
  } else {
    changes = await failJobConditional(env.DB, {
      jobId,
      lockToken: body.lockToken,
      targetStatus,
      errorCode: body.errorCode ?? null,
      now,
    });
  }
  if (changes === 0) {
    const raced = await getIdempotentResult<JobCallbackAck>(env.DB, "workerCallback", idemKey);
    if (raced) return json(raced, 200);
    throw new ConflictError(`Job ${jobId} could not be failed: the lock token is stale or the job is not currently leased.`);
  }

  const ack: JobCallbackAck = { jobId, outcome: "failed", disposition: "applied" };
  await putIdempotentResult(env.DB, "workerCallback", idemKey, ack, now);
  await finishLatestStartedAttempt(env.DB, jobId, {
    status: "failed",
    error: body.errorCode ? `${body.errorCode}: ${body.reason}` : body.reason,
    now,
  });

  if (willRetry) {
    // Technical retry: the job stays parked behind backoff and is re-handed by the
    // next activate once the delay elapses — NO event is sent. Audit the park (with
    // the backoff window) rather than the shared terminal-failure tail.
    await recordHistory(env.DB, {
      workspaceId,
      instanceId: job.instance_id,
      elementId: job.element_id,
      type: "jobFailed",
      diagnostics: { jobId, errorCode: body.errorCode ?? null, retryable: !isBusiness && retryable, targetStatus, reason: body.reason, ...(parkUntil ? { backoffUntil: parkUntil } : {}) },
    });
  } else {
    // Terminal for the step — a business error (errorCode set) OR a technical
    // exhaustion. Both flow through the shared tail: write the `jobFailed` audit
    // row + deliver `{outcome:'failed'}` so the engine runs its exhaustion path
    // (forward → serviceTaskFailure Hazard, compensation → compensationFailure).
    await deliverJobFailed(env, {
      workspaceId,
      instanceId: job.instance_id,
      elementId: job.element_id,
      jobId,
      errorCode: body.errorCode ?? null,
      retryable: !isBusiness && retryable,
      reason: body.reason,
      isCompensation: job.is_compensation === 1,
    });
  }
  return json(ack, 200);
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

  // M-UI operator console (design §7): consult the console sub-router first; it
  // returns a Response for a UI route or null to fall through to the core API,
  // so the published root contract is preserved exactly.
  const uiResponse = await handleUiRoute(request, env, seg, method, url);
  if (uiResponse) return uiResponse;

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

  if (seg[0] === "instances") {
    if (seg.length === 1 && method === "GET") return handleListInstances(env, url);
    if (seg[1]) {
      if (seg.length === 2 && method === "GET") return handleGetInstance(env, seg[1]);
      if (seg.length === 3 && seg[2] === "history" && method === "GET") return handleGetInstanceHistory(env, seg[1], url);
      if (seg.length === 3 && seg[2] === "cancel" && method === "POST") return handleCancelInstance(env, seg[1], request);
      if (seg.length === 3 && seg[2] === "retry" && method === "POST") return handleRetryInstance(env, seg[1], request);
    }
  }

  if (seg[0] === "messages") {
    if (seg.length === 1 && method === "POST") return handlePublishMessage(env, request);
    if (seg.length === 2 && method === "GET") return handleGetMessage(env, seg[1]!);
  }

  if (seg[0] === "worker-credentials") {
    if (seg.length === 1 && method === "POST") return handleMintWorkerCredential(env, request);
    if (seg.length === 3 && seg[2] === "revoke" && method === "POST") return handleRevokeWorkerCredential(env, seg[1]!);
  }

  if (seg[0] === "jobs") {
    if (seg.length === 2 && seg[1] === "activate" && method === "POST") return handleActivateJobs(env, request);
    if (seg.length === 3 && seg[2] === "complete" && method === "POST") return handleCompleteJob(env, seg[1]!, request);
    if (seg.length === 3 && seg[2] === "fail" && method === "POST") return handleFailJob(env, seg[1]!, request);
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
