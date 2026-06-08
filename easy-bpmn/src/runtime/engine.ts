// The BPMN-lite execution engine — the single source of orchestration truth.
//
// Both execution drivers share this code:
//   - Production: ProcessWorkflow wraps `runStep` in step.do and `waitFor` in
//     step.waitForEvent (durable, replay-safe — every side effect is inside a step).
//   - Tests: the DirectExecutor runs `runStep` inline and resumes on message
//     delivery instead of waiting (deterministic, no Workflow runtime needed).
//
// All primitives are idempotent and persist their effects to D1 (the canonical
// store), honoring persist-before-advance and atomic message application.

import type { Env } from "../env";
import type { MessageEventPayload } from "../contracts/workflow-events";
import type { ExecutionGraph } from "../bpmn/graph";
import { workflowEventTypeFor } from "../bpmn/profile";
import { brokerKeyOf, type RegisterSubscriptionResult } from "./broker-types";
import { invokeSampleWorker } from "./service-task";
import { MAX_EVENT_PAYLOAD_BYTES, payloadByteSize } from "./payload";
import {
  ONE_HOUR_MS,
  isoPlusMs,
  mergeVariables,
  newId,
  nowIso,
  parseJson,
  type JsonObject,
} from "../util";
import { getVersionGraph } from "../persistence/definitions";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import {
  applyTransition,
  applyTransitionStmt,
  createAttempt,
  createJob,
  createSubscription,
  finishAttempt,
  getActiveSubscription,
  getInstanceRow,
  getJobByElement,
  incidentStmt,
  incrementJobAttempt,
  jobCompleteStmt,
  subscriptionConsumedStmt,
  variableSnapshotStmt,
  type InstanceRow,
} from "../persistence/instances";
import { messageCorrelatedStmt } from "../persistence/messages";

export type RunStep = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
export type WaitForEvent = (sub: {
  elementId: string;
  workflowEventType: string;
  subscriptionId: string;
}) => Promise<MessageEventPayload>;

export type DriveStatus = "completed" | "waiting" | "incident";
export interface DriveResult {
  status: DriveStatus;
}

interface RunOptions {
  runStep: RunStep;
  waitFor: WaitForEvent | null;
  startAt?: string;
  incomingEvent?: MessageEventPayload;
}

async function loadInst(env: Env, instanceId: string): Promise<InstanceRow> {
  const row = await getInstanceRow(env.DB, instanceId);
  if (!row) throw new Error(`Process instance ${instanceId} not found`);
  return row;
}

export async function loadGraphForInstance(
  env: Env,
  instanceId: string,
): Promise<ExecutionGraph> {
  const inst = await loadInst(env, instanceId);
  const graph = await getVersionGraph(env.DB, inst.definition_version_id);
  if (!graph) throw new Error(`Definition version ${inst.definition_version_id} has no parsed profile`);
  return graph;
}

/** Drive a process instance. See RunOptions for production vs test wiring. */
export async function runInstance(
  env: Env,
  instanceId: string,
  opts: RunOptions,
): Promise<DriveResult> {
  const graph = await opts.runStep("init", () => loadGraphForInstance(env, instanceId));
  const startCur = opts.startAt ?? graph.startElementId;
  return loop(env, instanceId, graph, startCur, opts.runStep, opts.waitFor, opts.incomingEvent);
}

async function loop(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  startCur: string,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
  incomingEvent?: MessageEventPayload,
): Promise<DriveResult> {
  let cur: string = startCur;
  let pending = incomingEvent;

  while (true) {
    const node = graph.nodes[cur];
    if (!node) return { status: "completed" };

    if (node.type === "startEvent") {
      const next = node.next!;
      cur = await runStep(`start:${cur}`, () => enterStart(env, instanceId, cur, next));
      continue;
    }

    if (node.type === "serviceTask") {
      const elementId = cur;
      const taskType = node.taskType ?? "";
      const retryLimit = node.retries ?? 1;
      const next = node.next!;
      const r = await runStep(`svc:${elementId}`, () =>
        runServiceTask(env, instanceId, elementId, taskType, retryLimit, next),
      );
      if ("incident" in r) return { status: "incident" };
      cur = r.next;
      continue;
    }

    if (node.type === "receiveTask") {
      const elementId = cur;
      const next = node.next!;
      const messageName = node.messageName ?? "";

      if (pending) {
        const event = pending;
        pending = undefined;
        const r = await runStep(`msg:${elementId}`, () =>
          applyMessage(env, instanceId, elementId, next, event),
        );
        cur = r.next;
        continue;
      }

      const reg = await runStep(`recv:${elementId}`, () =>
        registerReceive(env, instanceId, elementId, messageName),
      );
      if (reg.kind === "incident") return { status: "incident" };
      if (reg.kind === "correlated") {
        const event = reg.event;
        const r = await runStep(`msg:${elementId}`, () =>
          applyMessage(env, instanceId, elementId, next, event),
        );
        cur = r.next;
        continue;
      }
      // waiting
      if (!waitFor) return { status: "waiting" };
      const event = await waitFor({
        elementId,
        workflowEventType: reg.workflowEventType,
        subscriptionId: reg.subscriptionId,
      });
      const r = await runStep(`msg:${elementId}`, () =>
        applyMessage(env, instanceId, elementId, next, event),
      );
      cur = r.next;
      continue;
    }

    if (node.type === "endEvent") {
      await runStep(`end:${cur}`, () => completeInstance(env, instanceId, cur));
      return { status: "completed" };
    }

    return { status: "completed" };
  }
}

// ---------------------------------------------------------------------------
// Primitives (each idempotent + persists to D1)
// ---------------------------------------------------------------------------

async function enterStart(
  env: Env,
  instanceId: string,
  elementId: string,
  next: string,
): Promise<string> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  await dbBatch(env.DB, [
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "instanceStarted",
      diagnostics: { definitionVersionId: inst.definition_version_id, correlationKey: inst.correlation_key },
    }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "elementEntered",
      diagnostics: { elementType: "startEvent" },
    }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
  ]);
  return next;
}

type ServiceTaskOutcome = { next: string } | { incident: true };

async function runServiceTask(
  env: Env,
  instanceId: string,
  elementId: string,
  taskType: string,
  retryLimit: number,
  next: string,
): Promise<ServiceTaskOutcome> {
  const inst = await loadInst(env, instanceId);
  const variables = parseJson<JsonObject>(inst.variables, {});

  // Idempotency: a previously completed job means this step already ran.
  const existing = await getJobByElement(env.DB, instanceId, elementId);
  if (existing && existing.status === "completed") {
    const output = parseJson<JsonObject>(existing.output_variables, {});
    const merged = mergeVariables(variables, output);
    await applyTransition(env.DB, { instanceId, variables: merged, currentElementId: next, status: "running", now: nowIso() });
    return { next };
  }

  // Reject oversized worker input before invocation (would not fit a Workflow event).
  if (payloadByteSize(variables) > MAX_EVENT_PAYLOAD_BYTES) {
    return createServiceTaskIncident(env, inst, elementId, 0, "Service Task input variables exceed the Workflow event payload limit.", { size: payloadByteSize(variables) });
  }

  await dbBatch(env.DB, [
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "elementEntered",
      diagnostics: { elementType: "serviceTask", taskType },
    }),
  ]);

  const jobId = existing?.job_id ?? newId("job");
  if (!existing) {
    // Persist durable job state BEFORE worker execution begins.
    await createJob(env.DB, {
      jobId,
      instanceId,
      elementId,
      taskType,
      retryLimit,
      idempotencyKey: `${instanceId}:${elementId}`,
      inputVariables: variables,
      now: nowIso(),
    });
    await runHistory(env, inst.workspace_id, {
      instanceId,
      elementId,
      type: "serviceTaskJobCreated",
      diagnostics: { jobId, taskType, retryLimit },
    });
  }

  let lastReason = "Service Task failed.";
  let lastDiagnostics: JsonObject = {};
  const totalAttempts = Math.max(1, retryLimit);

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const n = await incrementJobAttempt(env.DB, jobId, nowIso());
    const requestPayload: JsonObject = {
      jobId,
      instanceId,
      definitionVersionId: inst.definition_version_id,
      taskType,
      elementId,
      attempt: n,
      variables,
    };
    const attemptId = await createAttempt(env.DB, {
      jobId,
      instanceId,
      attemptNumber: n,
      workflowStepName: `svc:${elementId}`,
      requestPayload,
      now: nowIso(),
    });
    await runHistory(env, inst.workspace_id, {
      instanceId,
      elementId,
      type: "workerAttemptStarted",
      diagnostics: { jobId, attempt: n, taskType },
      payloadSnapshot: requestPayload,
    });

    const result = await invokeSampleWorker({
      jobId,
      instanceId,
      definitionVersionId: inst.definition_version_id,
      taskType,
      elementId,
      attempt: n,
      variables,
    });

    if (result.status === "completed") {
      const output = result.outputVariables ?? {};
      await finishAttempt(env.DB, {
        attemptId,
        status: "succeeded",
        responsePayload: output,
        now: nowIso(),
      });
      const merged = mergeVariables(variables, output);
      const now = nowIso();
      await dbBatch(env.DB, [
        jobCompleteStmt(env.DB, jobId, output, now),
        variableSnapshotStmt(env.DB, { instanceId, source: "serviceTask", sourceId: jobId, variables: output, now }),
        historyStmt(env.DB, {
          workspaceId: inst.workspace_id,
          instanceId,
          elementId,
          type: "workerAttemptSucceeded",
          diagnostics: { jobId, attempt: n },
          payloadSnapshot: output,
        }),
        historyStmt(env.DB, {
          workspaceId: inst.workspace_id,
          instanceId,
          elementId,
          type: "serviceTaskCompleted",
          diagnostics: { jobId, attempts: n },
        }),
        applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: next, status: "running", now }),
      ]);
      return { next };
    }

    // failed
    lastReason = result.reason;
    lastDiagnostics = { ...(result.diagnostics ?? {}), attempt: n };
    await finishAttempt(env.DB, {
      attemptId,
      status: "failed",
      error: result.reason,
      responsePayload: result.diagnostics ?? null,
      now: nowIso(),
    });
    await runHistory(env, inst.workspace_id, {
      instanceId,
      elementId,
      type: "workerAttemptFailed",
      diagnostics: { jobId, attempt: n, reason: result.reason, retriesRemaining: totalAttempts - n },
      payloadSnapshot: { reason: result.reason, ...(result.diagnostics ?? {}) },
    });
  }

  return createServiceTaskIncident(env, inst, elementId, totalAttempts, lastReason, lastDiagnostics, jobId);
}

async function createServiceTaskIncident(
  env: Env,
  inst: InstanceRow,
  elementId: string,
  retryCount: number,
  reason: string,
  diagnostics: JsonObject,
  jobId?: string,
): Promise<{ incident: true }> {
  const now = nowIso();
  const incidentId = newId("inc");
  const payloadContext: JsonObject = { reason, ...diagnostics };
  const statements: D1PreparedStatement[] = [];
  if (jobId) statements.push(failJobStmtSafe(env, jobId, now));
  statements.push(
    incidentStmt(env.DB, {
      incidentId,
      instanceId: inst.instance_id,
      elementId,
      reason,
      retryCount,
      payloadContext,
      now,
    }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId: inst.instance_id,
      elementId,
      type: "incidentCreated",
      diagnostics: { incidentId, reason, retryCount, recovery: "Recovery actions are outside the MVP operator view." },
      payloadSnapshot: payloadContext,
    }),
    applyTransitionStmt(env.DB, { instanceId: inst.instance_id, currentElementId: elementId, status: "incident", now }),
  );
  await dbBatch(env.DB, statements);
  return { incident: true };
}

// failJob as a statement is not exported; do it inline via a direct update inside the batch.
function failJobStmtSafe(env: Env, jobId: string, now: string): D1PreparedStatement {
  return env.DB
    .prepare(`UPDATE service_task_jobs SET status = 'failed', updated_at = ? WHERE job_id = ?`)
    .bind(now, jobId);
}

type RegisterOutcome =
  | { kind: "waiting"; workflowEventType: string; subscriptionId: string }
  | { kind: "correlated"; event: MessageEventPayload }
  | { kind: "incident" };

async function registerReceive(
  env: Env,
  instanceId: string,
  elementId: string,
  messageName: string,
): Promise<RegisterOutcome> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();

  await runHistory(env, inst.workspace_id, {
    instanceId,
    elementId,
    type: "elementEntered",
    diagnostics: { elementType: "receiveTask", messageName },
  });

  // Idempotency: reuse an already-active subscription for this element.
  const existing = await getActiveSubscription(env.DB, instanceId, elementId);
  const subscriptionId = existing?.subscription_id ?? newId("sub");
  const workflowEventType = workflowEventTypeFor(messageName);
  const brokerKey = brokerKeyOf(inst.workspace_id, messageName, inst.correlation_key);
  const expiresAt = isoPlusMs(now, ONE_HOUR_MS);

  const brokerId = env.CORRELATION_BROKER.idFromName(brokerKey);
  const broker = env.CORRELATION_BROKER.get(brokerId);
  // The DO RPC return type is widened by the platform's Serializable transform;
  // cast back to the domain union (the runtime value is a plain object).
  const result = (await broker.registerSubscription({
    workspaceId: inst.workspace_id,
    instanceId,
    workflowInstanceId: inst.workflow_instance_id,
    elementId,
    subscriptionId,
    messageName,
    correlationKey: inst.correlation_key,
    workflowEventType,
    expiresAt,
    now,
  })) as RegisterSubscriptionResult;

  if (result.status === "rejected") {
    await createServiceTaskIncident(
      env,
      inst,
      elementId,
      0,
      `Receive Task could not register: ${result.reason}`,
      { existingInstanceId: result.existingInstanceId ?? null },
    );
    await runHistory(env, inst.workspace_id, {
      instanceId,
      elementId,
      type: "invariantViolation",
      diagnostics: { reason: result.reason, messageName, correlationKey: inst.correlation_key },
    });
    return { kind: "incident" };
  }

  if (result.status === "correlated") {
    // A buffered message was waiting; consume it immediately (no wait).
    return { kind: "correlated", event: result.event };
  }

  // waiting — persist the durable wait state.
  if (!existing) {
    await createSubscription(env.DB, {
      subscriptionId,
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      messageName,
      correlationKey: inst.correlation_key,
      brokerKey,
      workflowEventType,
      status: "active",
      expiresAt,
      now,
    });
  }
  await dbBatch(env.DB, [
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "receiveTaskWaiting",
      diagnostics: { subscriptionId, messageName, correlationKey: inst.correlation_key, expiresAt },
    }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now }),
  ]);
  return { kind: "waiting", workflowEventType, subscriptionId };
}

async function applyMessage(
  env: Env,
  instanceId: string,
  elementId: string,
  next: string,
  event: MessageEventPayload,
): Promise<{ next: string }> {
  const inst = await loadInst(env, instanceId);

  // Idempotency: if the active subscription is already consumed, do not re-apply.
  const active = await getActiveSubscription(env.DB, instanceId, elementId);
  const now = nowIso();
  const variables = parseJson<JsonObject>(inst.variables, {});
  const merged = mergeVariables(variables, event.payload ?? {});

  let subscriptionId = active?.subscription_id;
  if (!subscriptionId) {
    // Buffered-at-registration path: no active row yet — create it consumed.
    subscriptionId = newId("sub");
    await createSubscription(env.DB, {
      subscriptionId,
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      messageName: event.messageName,
      correlationKey: inst.correlation_key,
      brokerKey: brokerKeyOf(inst.workspace_id, event.messageName, inst.correlation_key),
      workflowEventType: workflowEventTypeFor(event.messageName),
      status: "consumed",
      expiresAt: isoPlusMs(now, ONE_HOUR_MS),
      consumedAt: now,
      externalMessageId: event.externalMessageId,
      now,
    });
  }

  // Atomic: apply payload + advance + consume subscription + correlate message + history.
  await dbBatch(env.DB, [
    applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: next, status: "running", now }),
    ...(active ? [subscriptionConsumedStmt(env.DB, subscriptionId, event.externalMessageId, now)] : []),
    messageCorrelatedStmt(env.DB, { externalMessageId: event.externalMessageId, instanceId, subscriptionId, now }),
    variableSnapshotStmt(env.DB, { instanceId, source: "message", sourceId: event.externalMessageId, variables: event.payload ?? {}, now }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      externalMessageId: event.externalMessageId,
      type: "messageCorrelated",
      diagnostics: { subscriptionId, messageName: event.messageName, messageId: event.messageId },
      payloadSnapshot: event.payload ?? {},
    }),
  ]);
  return { next };
}

async function completeInstance(env: Env, instanceId: string, elementId: string): Promise<void> {
  const inst = await loadInst(env, instanceId);
  if (inst.status === "completed") return;
  const now = nowIso();
  await dbBatch(env.DB, [
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "elementEntered",
      diagnostics: { elementType: "endEvent" },
    }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "instanceCompleted",
      diagnostics: {},
    }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "completed", completedAt: now, now }),
  ]);
}

// Small helper to write one history row outside a batch.
async function runHistory(
  env: Env,
  workspaceId: string,
  input: { instanceId?: string | null; elementId?: string | null; externalMessageId?: string | null; type: string; diagnostics?: JsonObject; payloadSnapshot?: JsonObject | null },
): Promise<void> {
  await historyStmt(env.DB, { workspaceId, ...input }).run();
}

/**
 * Records a terminal incident at the instance's current element. Used by the
 * Workflow driver when a Receive Task wait times out or a step fails terminally.
 */
export async function recordTerminalIncident(
  env: Env,
  instanceId: string,
  reason: string,
): Promise<void> {
  const inst = await getInstanceRow(env.DB, instanceId);
  if (!inst || inst.status === "completed" || inst.status === "incident") return;
  await createServiceTaskIncident(env, inst, inst.current_element_id ?? "unknown", 0, reason, {});
}

// Re-export for callers needing the wait event type derivation.
export { workflowEventTypeFor };
