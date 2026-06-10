// The easy-bpmn execution engine — the single source of orchestration truth.
//
// M1 evolves it from a linear scalar-cursor interpreter into a SCOPE-AWARE one:
//   - Service Tasks are durable PULL waits (a leasable job + step.waitForEvent on
//     `bpmn_job_<jobId>`); a remote worker leases, runs, then complete/fail.
//   - A `transaction` is a saga scope; completed compensatable steps are appended
//     to the saga ledger atomically with advance.
//   - A business error (worker fail with an errorCode matching an error boundary)
//     routes the single token to a cancel end event, which CANCELS the
//     transaction → reverse-order compensation of the ledger → the cancel
//     boundary's failure path. An uncaught/technical exhaustion is a Hazard →
//     terminal incident (never auto-compensation).
//
// Both drivers share this code: the Workflow suspends/resumes in place across
// `waitFor`; the deterministic DirectExecutor parks (waitFor=null) and resumes by
// re-running — the instance status + the ledger are re-derived from D1 each time,
// so direct-mode resume and crash recovery are the same path. D1 is canonical.

import type { Env } from "../env";
import type { MessageEventPayload } from "../contracts/workflow-events";
import type { ExecutionGraph, GraphNode } from "../bpmn/graph";
import { workflowEventTypeFor, workflowJobEventTypeFor } from "../bpmn/profile";
import { brokerKeyOf, type RegisterSubscriptionResult } from "./broker-types";
import { MAX_EVENT_PAYLOAD_BYTES, payloadByteSize } from "./payload";
import {
  ONE_HOUR_MS,
  isoIsBefore,
  isoPlusMs,
  isTerminalInstanceStatus,
  mergeVariables,
  newId,
  nowIso,
  parseJson,
  traceIdFor,
  type JsonObject,
} from "../util";
import { ACTIVATION_TTL_MS, POISON_THRESHOLD } from "./retry-policy";
import { failUnleasableJobConditional, getJobRowById, reopenJobKeepAttemptStmt } from "../persistence/jobs";
import { getVersionGraph } from "../persistence/definitions";
import { dbBatch } from "../persistence/db";
import { countHistoryEventsOfType, historyStmt } from "../persistence/history";
import {
  applyTransition,
  applyTransitionStmt,
  createJobStmt,
  getActiveSubscription,
  getCompensationJobByElement,
  getForwardJobByElement,
  getInstanceRow,
  incidentStmt,
  type InstanceRow,
  type IncidentKind,
  type JobRow,
  createSubscription,
  subscriptionConsumedStmt,
  transitionStatusGuardedStmt,
  variableSnapshotStmt,
} from "../persistence/instances";
import {
  attachCompensationJobStmt,
  insertSagaStepStmt,
  markScopeStepsCommittedStmt,
  selectScopeStepsForCompensation,
  updateCompensationStatusStmt,
  type SagaStepView,
} from "../persistence/saga";
import { messageCorrelatedStmt } from "../persistence/messages";

export type RunStep = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
export type WaitOutcome = { kind: "event"; payload: unknown } | { kind: "timeout" };
export type WaitForEvent = (sub: {
  name: string;
  workflowEventType: string;
  timeout: string;
}) => Promise<WaitOutcome>;

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

const SVC_WAIT_TIMEOUT = "1 hour";

async function loadInst(env: Env, instanceId: string): Promise<InstanceRow> {
  const row = await getInstanceRow(env.DB, instanceId);
  if (!row) throw new Error(`Process instance ${instanceId} not found`);
  return row;
}

export async function loadGraphForInstance(env: Env, instanceId: string): Promise<ExecutionGraph> {
  const inst = await loadInst(env, instanceId);
  const graph = await getVersionGraph(env.DB, inst.definition_version_id);
  if (!graph) throw new Error(`Definition version ${inst.definition_version_id} has no parsed profile`);
  return graph;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

function isTransactionScope(graph: ExecutionGraph, scopeId: string | null | undefined): scopeId is string {
  return !!scopeId && graph.nodes[scopeId]?.type === "transaction";
}

/** The cancel end target an error boundary on `elementId` routes to, matching errorCode. */
function errorBoundaryTarget(graph: ExecutionGraph, elementId: string, errorCode: string | null): string | null {
  for (const [, node] of Object.entries(graph.nodes)) {
    if (
      node.type === "boundaryEvent" &&
      node.boundaryKind === "error" &&
      node.attachedToRef === elementId &&
      (errorCode == null || node.errorCode === errorCode)
    ) {
      return node.next ?? null;
    }
  }
  return null;
}

/** The failure-path target of the cancel boundary attached to transaction `scopeId`. */
function cancelBoundaryTarget(graph: ExecutionGraph, scopeId: string): string | null {
  for (const [, node] of Object.entries(graph.nodes)) {
    if (node.type === "boundaryEvent" && node.boundaryKind === "cancel" && node.attachedToRef === scopeId) {
      return node.next ?? null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runInstance(env: Env, instanceId: string, opts: RunOptions): Promise<DriveResult> {
  const graph = await opts.runStep("init", () => loadGraphForInstance(env, instanceId));
  const inst = await loadInst(env, instanceId);

  // Resume into the reverse compensation pass (direct-mode resume / crash recovery):
  // the cursor is re-derived from the ledger + the current (cancel-end) element.
  if (inst.status === "compensating") {
    const scopeId = graph.nodes[inst.current_element_id ?? ""]?.scopeId ?? null;
    if (!scopeId) return { status: "completed" };
    return settleAfterCompensation(env, instanceId, graph, scopeId, opts.runStep, opts.waitFor);
  }
  if (isTerminalInstanceStatus(inst.status)) return { status: "completed" };

  const startCur = opts.startAt ?? graph.startElementId;
  return loop(env, instanceId, graph, startCur, opts.runStep, opts.waitFor, opts.incomingEvent);
}

// ---------------------------------------------------------------------------
// Main scope-aware loop (single-token in M1)
// ---------------------------------------------------------------------------

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
      cur = await runStep(`start:${cur}`, () => enterStart(env, instanceId, graph, cur, node));
      continue;
    }

    if (node.type === "transaction") {
      const innerStart = graph.transactions?.[cur]?.startId;
      if (!innerStart) return { status: "completed" }; // malformed (validator guards this)
      cur = await runStep(`tx:${cur}`, () => enterTransaction(env, instanceId, cur, innerStart));
      continue;
    }

    if (node.type === "serviceTask" && !node.isForCompensation) {
      const r = await driveForwardServiceTask(env, instanceId, graph, cur, node, runStep, waitFor);
      if (r.kind === "waiting") return { status: "waiting" };
      if (r.kind === "incident") return { status: "incident" };
      cur = r.next;
      continue;
    }

    if (node.type === "receiveTask") {
      const r = await driveReceiveTask(env, instanceId, cur, node, runStep, waitFor, pending);
      pending = undefined;
      if (r.kind === "waiting") return { status: "waiting" };
      if (r.kind === "incident") return { status: "incident" };
      cur = r.next;
      continue;
    }

    if (node.type === "exclusiveGateway") {
      // TASK-34 replaces this guard with real XOR branch dispatch. Until then
      // a token reaching a published gateway (TASK-33 opened the publish gate)
      // must NOT fall through and zombify in 'running' with no D1 write —
      // settle the M1 terminal-incident path (incident row + incidentCreated
      // history + status transition in one batch) so the operator sees it.
      await runStep(`gw-guard:${cur}`, () =>
        createIncident(
          env,
          instanceId,
          cur,
          0,
          "exclusiveGateway dispatch is not yet supported by the engine (lands in TASK-34).",
          {},
          "serviceTaskFailure",
        ),
      );
      return { status: "incident" };
    }

    if (node.type === "endEvent") {
      if (node.endKind === "cancel" && isTransactionScope(graph, node.scopeId)) {
        await runStep(`cancel:${cur}`, () => beginCompensating(env, instanceId, node.scopeId!, cur));
        return settleAfterCompensation(env, instanceId, graph, node.scopeId!, runStep, waitFor);
      }
      if (isTransactionScope(graph, node.scopeId)) {
        // Inner none end → COMMIT the transaction → continue on its outer flow.
        cur = await runStep(`commit:${cur}`, () => commitTransaction(env, instanceId, graph, node.scopeId!, cur));
        continue;
      }
      await runStep(`end:${cur}`, () => completeInstance(env, instanceId, cur));
      return { status: "completed" };
    }

    // boundary events / compensation handlers are never on the token path.
    return { status: "completed" };
  }
}

// ---------------------------------------------------------------------------
// Forward Service Task as a durable pull wait
// ---------------------------------------------------------------------------

type ForwardOutcome = { kind: "next"; next: string } | { kind: "waiting" } | { kind: "incident" };

async function driveForwardServiceTask(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  node: GraphNode,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
): Promise<ForwardOutcome> {
  let job = await getForwardJobByElement(env.DB, instanceId, elementId);

  if (job?.status === "completed") {
    return runStep(`svc-apply:${elementId}`, () => applyForwardCompletion(env, instanceId, graph, elementId, node, job!));
  }
  if (job?.status === "failed") {
    return runStep(`svc-fail:${elementId}`, () => handleForwardFailure(env, instanceId, graph, elementId, node, job!));
  }

  if (!job) {
    job = await runStep(`svc-create:${elementId}`, () => createForwardJob(env, instanceId, elementId, node));
    if (!job) return { kind: "incident" }; // oversized input → incident already recorded
  }

  // Park (direct mode) — the instance resumes by re-running once the worker's
  // complete/fail mutates the job in D1.
  if (!waitFor) {
    await runStep(`svc-park:${elementId}`, () => parkWaiting(env, instanceId, elementId, "serviceTask"));
    return { kind: "waiting" };
  }

  // Suspend (workflow mode) — re-lease drives retries within this single wait.
  const outcome = await waitFor({
    name: `wait-job:${elementId}`,
    workflowEventType: workflowJobEventTypeFor(job.job_id),
    timeout: SVC_WAIT_TIMEOUT,
  });
  // D1 is canonical: re-read the job whether we woke on the event OR on a timeout.
  // A lost wake-up event (swallowed sendEvent, isolate eviction) for an already
  // terminal job must be applied here, not masked as a spurious timeout incident.
  const fresh = (await getForwardJobByElement(env.DB, instanceId, elementId)) ?? job;
  if (fresh.status === "completed") {
    return runStep(`svc-apply:${elementId}`, () => applyForwardCompletion(env, instanceId, graph, elementId, node, fresh));
  }
  if (fresh.status === "failed") {
    return runStep(`svc-fail:${elementId}`, () => handleForwardFailure(env, instanceId, graph, elementId, node, fresh));
  }
  if (outcome.kind === "timeout") {
    // A genuine timeout: nobody completed the job (still created/locked).
    return runStep(`svc-timeout:${elementId}`, () =>
      createIncident(env, instanceId, elementId, node.retries ?? 1, "Service Task timed out waiting for a worker.", { jobId: fresh.job_id }, "timeout"),
    );
  }
  // Defensive: event arrived but job is not terminal — treat as a technical incident.
  return runStep(`svc-stuck:${elementId}`, () =>
    createIncident(env, instanceId, elementId, fresh.attempt_count, "Service Task resumed with a non-terminal job.", { jobId: fresh.job_id }, "serviceTaskFailure"),
  );
}

async function createForwardJob(env: Env, instanceId: string, elementId: string, node: GraphNode): Promise<JobRow | null> {
  const inst = await loadInst(env, instanceId);
  const variables = parseJson<JsonObject>(inst.variables, {});
  if (payloadByteSize(variables) > MAX_EVENT_PAYLOAD_BYTES) {
    await createIncident(env, instanceId, elementId, 0, "Service Task input variables exceed the Workflow event payload limit.", { size: payloadByteSize(variables) }, "serviceTaskFailure");
    return null;
  }
  const jobId = newId("job");
  const taskType = node.taskType ?? "";
  const now = nowIso();
  // Un-leasable-job DLQ (§4.2): a forward job nobody leases within ACTIVATION_TTL_MS
  // is parked in a DLQ via a per-job JobScheduler alarm armed below.
  const activationExpiresAt = isoPlusMs(now, ACTIVATION_TTL_MS);
  await dbBatch(env.DB, [
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "elementEntered",
      diagnostics: { elementType: "serviceTask", taskType },
    }),
    createJobStmt(env.DB, {
      jobId,
      instanceId,
      elementId,
      taskType,
      retryLimit: Math.max(1, node.retries ?? 1),
      idempotencyKey: `${instanceId}:${elementId}`,
      inputVariables: variables,
      workspaceId: inst.workspace_id,
      isCompensation: false,
      activationExpiresAt,
      now,
    }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "serviceTaskJobCreated",
      diagnostics: { jobId, taskType, retryLimit: Math.max(1, node.retries ?? 1), activationExpiresAt },
    }),
  ]);
  await armJobScheduler(env, jobId, activationExpiresAt);
  return getForwardJobByElement(env.DB, instanceId, elementId);
}

/**
 * Arm the per-job DLQ alarm (§4.2). Best-effort + non-fatal: the DLQ is a safety
 * net, never on the job-creation critical path, so a DO hiccup must not fail
 * job creation (it just leaves that job without a timeout, as M0 did for all jobs).
 */
async function armJobScheduler(env: Env, jobId: string, activationExpiresAt: string): Promise<void> {
  try {
    const stub = env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(jobId));
    await stub.arm(jobId, activationExpiresAt);
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", message: "JobScheduler arm failed", jobId, error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * DLQ termination (§4.2), invoked by the JobScheduler alarm at activation_expires_at.
 * D1 is canonical — the DO holds no authoritative state — so this re-reads the job
 * and only acts if it is STILL an un-leased, expired forward job on a non-terminal
 * instance. Otherwise (progressed / already settled / late-or-duplicate alarm) it
 * is an idempotent no-op. The terminal incident kind='timeout' is written directly
 * (never falling through to the process-workflow.ts catch-all), so the DLQ outcome
 * is assertable in direct mode without a live Workflow.
 */
export async function terminateUnleasableJob(env: Env, jobId: string): Promise<void> {
  const job = await getJobRowById(env.DB, jobId);
  if (!job || job.is_compensation === 1) return;
  if (!(job.status === "created" && job.attempt_count === 0)) return; // leased/completed/failed → no-op
  const now = nowIso();
  if (!job.activation_expires_at || isoIsBefore(now, job.activation_expires_at)) return; // not yet expired (early/spurious alarm)

  const inst = await getInstanceRow(env.DB, job.instance_id);
  if (!inst || isTerminalInstanceStatus(inst.status) || inst.status === "compensating") return;

  // Atomic claim: only ONE of {this DLQ pass, a concurrent /jobs/activate, a worker
  // completing} can flip created→failed. If the job was leased/advanced in the
  // window since our re-read, this matches 0 rows and we no-op — never clobbering
  // an in-flight or already-advanced job (the TOCTOU). This is the race gate; its
  // result must be checked, so it is the one write outside the settle batch.
  const claimed = await failUnleasableJobConditional(env.DB, jobId, now);
  if (claimed === 0) return;

  // Settle the instance ATOMICALLY: the guarded transition + incident + history go
  // in ONE dbBatch, so an 'incident' status can never exist without its incident
  // row (chosen over a non-atomic transition-then-incident, which could strand a
  // terminal 'incident' with no incident row on a partial failure). The transition
  // is GUARDED (only running/waiting → incident) so a concurrent cancel that already
  // moved the instance is never regressed (one-way status table). Tradeoff: a 0-row
  // guarded UPDATE is not a batch error, so in that rare lost-cancel race the
  // incident + history rows still commit — the incident OBJECT stays hidden
  // (inspection fetches it only when status='incident') but the jobActivationExpired
  // / incidentCreated HISTORY events remain visible. Accepted as minor audit noise
  // (no state/remediation impact) over the worse corrupt-terminal alternative.
  const incidentId = newId("inc");
  const reason = "Service Task job expired before any worker leased it (un-leasable taskType).";
  const payloadContext: JsonObject = { reason, jobId, taskType: job.task_type, activationExpiresAt: job.activation_expires_at, dlq: "un-leasable" };
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId: inst.instance_id, elementId: job.element_id, type: "jobActivationExpired", diagnostics: { jobId, taskType: job.task_type, activationExpiresAt: job.activation_expires_at } }),
    incidentStmt(env.DB, { incidentId, instanceId: inst.instance_id, elementId: job.element_id, reason, retryCount: 0, kind: "timeout", resolution: "open", payloadContext, now }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId: inst.instance_id, elementId: job.element_id, type: "incidentCreated", diagnostics: { incidentId, reason, kind: "timeout", retryCount: 0 }, payloadSnapshot: payloadContext }),
    transitionStatusGuardedStmt(env.DB, inst.instance_id, ["running", "waiting"], "incident", now),
  ]);
}

async function applyForwardCompletion(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  node: GraphNode,
  job: JobRow,
): Promise<ForwardOutcome> {
  const inst = await loadInst(env, instanceId);
  const next = node.next!;
  const input = parseJson<JsonObject>(job.input_variables, {});
  const output = parseJson<JsonObject>(job.output_variables, {});
  const merged = mergeVariables(parseJson<JsonObject>(inst.variables, {}), output);
  const now = nowIso();

  // Poison detection (§4.3): the per-call output already passed the payload limit
  // at /jobs/complete, but the MERGE into instance variables may still breach it —
  // an un-applicable completion. Re-open the job up to POISON_THRESHOLD strikes,
  // then terminate with a DISTINCT kind='poison'. The strike counter is the number
  // of un-applicable COMPLETIONS (counted from the serviceTaskOutputRejected
  // history), NOT the lease attempt_count — a technical retry must not consume the
  // poison budget. Poison NEVER compensates (only a business error → cancel does).
  if (payloadByteSize(merged) > MAX_EVENT_PAYLOAD_BYTES) {
    const priorRejections = await countHistoryEventsOfType(env.DB, instanceId, elementId, "serviceTaskOutputRejected");
    const strike = priorRejections + 1;
    if (strike >= POISON_THRESHOLD) {
      await historyStmt(env.DB, {
        workspaceId: inst.workspace_id,
        instanceId,
        elementId,
        type: "poisonJob",
        diagnostics: { jobId: job.job_id, strikes: strike, mergedSize: payloadByteSize(merged) },
      }).run();
      return createIncident(
        env,
        instanceId,
        elementId,
        strike,
        `Service Task completed with un-applicable output ${strike} times (merged variables exceed the event payload limit).`,
        { jobId: job.job_id, mergedSize: payloadByteSize(merged) },
        "poison",
      );
    }
    // Below threshold → re-open for another attempt and stay parked.
    await dbBatch(env.DB, [
      reopenJobKeepAttemptStmt(env.DB, job.job_id, now),
      historyStmt(env.DB, {
        workspaceId: inst.workspace_id,
        instanceId,
        elementId,
        type: "serviceTaskOutputRejected",
        diagnostics: { jobId: job.job_id, strike, mergedSize: payloadByteSize(merged), reason: "merged variables exceed the event payload limit" },
      }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now }),
    ]);
    return { kind: "waiting" };
  }

  const statements: D1PreparedStatement[] = [
    variableSnapshotStmt(env.DB, { instanceId, source: "serviceTask", sourceId: job.job_id, variables: output, now }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "serviceTaskCompleted",
      diagnostics: { jobId: job.job_id, attempts: job.attempt_count, traceId: traceIdFor(instanceId) },
    }),
    applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: next, status: "running", now }),
  ];

  // Ledger write atomic with advance — only for completed compensatable steps in a transaction.
  if (isTransactionScope(graph, node.scopeId)) {
    const wiring = graph.transactions?.[node.scopeId!]?.compensations?.[elementId];
    const handlerNode = wiring ? graph.nodes[wiring.handlerId] : undefined;
    statements.push(
      insertSagaStepStmt(env.DB, {
        stepId: newId("step"),
        instanceId,
        scopeId: node.scopeId!,
        elementId,
        forwardJobId: job.job_id,
        capturedInput: input,
        capturedOutput: output,
        compensationElementId: wiring?.handlerId ?? null,
        compensationTaskType: handlerNode?.taskType ?? null,
        compensationStatus: wiring ? "pending" : "notRequired",
        traceId: traceIdFor(instanceId),
        now,
      }),
    );
  }

  await dbBatch(env.DB, statements);
  return { kind: "next", next };
}

async function handleForwardFailure(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  node: GraphNode,
  job: JobRow,
): Promise<ForwardOutcome> {
  const inst = await loadInst(env, instanceId);
  if (job.error_code) {
    // Business error → route to the matching error boundary's cancel end.
    const target = errorBoundaryTarget(graph, elementId, job.error_code);
    if (target) {
      await dbBatch(env.DB, [
        historyStmt(env.DB, {
          workspaceId: inst.workspace_id,
          instanceId,
          elementId,
          type: "businessErrorCaught",
          diagnostics: { jobId: job.job_id, errorCode: job.error_code, boundaryTarget: target },
        }),
        applyTransitionStmt(env.DB, { instanceId, currentElementId: target, status: "running", now: nowIso() }),
      ]);
      return { kind: "next", next: target };
    }
    // Uncaught business error → Hazard.
    return createIncident(env, instanceId, elementId, job.attempt_count, `Uncaught business error '${job.error_code}' (no matching error boundary).`, { jobId: job.job_id, errorCode: job.error_code }, "serviceTaskFailure");
  }
  // Technical exhaustion → Hazard (terminal incident, never auto-compensation).
  return createIncident(env, instanceId, elementId, job.attempt_count, "Service Task failed (technical retries exhausted).", { jobId: job.job_id }, "serviceTaskFailure");
}

// ---------------------------------------------------------------------------
// Transaction enter / commit
// ---------------------------------------------------------------------------

async function enterStart(env: Env, instanceId: string, graph: ExecutionGraph, elementId: string, node: GraphNode): Promise<string> {
  const inst = await loadInst(env, instanceId);
  const next = node.next!;
  const now = nowIso();
  if (isTransactionScope(graph, node.scopeId)) {
    // Inner transaction start — just advance (the transaction node already audited entry).
    await dbBatch(env.DB, [
      historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "elementEntered", diagnostics: { elementType: "startEvent", scope: node.scopeId } }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
    ]);
    return next;
  }
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "instanceStarted", diagnostics: { definitionVersionId: inst.definition_version_id, correlationKey: inst.correlation_key, traceId: traceIdFor(instanceId) } }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "elementEntered", diagnostics: { elementType: "startEvent" } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
  ]);
  return next;
}

async function enterTransaction(env: Env, instanceId: string, txId: string, innerStart: string): Promise<string> {
  const inst = await loadInst(env, instanceId);
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: txId, type: "transactionEntered", diagnostics: { transaction: txId, traceId: traceIdFor(instanceId) } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: innerStart, status: "running", now: nowIso() }),
  ]);
  return innerStart;
}

async function commitTransaction(env: Env, instanceId: string, graph: ExecutionGraph, txId: string, endElementId: string): Promise<string> {
  const inst = await loadInst(env, instanceId);
  const txNode = graph.nodes[txId];
  const outer = txNode?.next ?? null;
  const now = nowIso();
  await dbBatch(env.DB, [
    // Terminalize this scope's ledger so a later cancel can't re-compensate it.
    markScopeStepsCommittedStmt(env.DB, { instanceId, scopeId: txId, now }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: endElementId, type: "elementEntered", diagnostics: { elementType: "endEvent", endKind: "none", scope: txId } }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: txId, type: "transactionCommitted", diagnostics: { transaction: txId } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: outer ?? endElementId, status: "running", now }),
  ]);
  return outer ?? endElementId;
}

// ---------------------------------------------------------------------------
// Reverse-order compensation
// ---------------------------------------------------------------------------

async function beginCompensating(env: Env, instanceId: string, scopeId: string, cancelEndId: string): Promise<void> {
  const inst = await loadInst(env, instanceId);
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: scopeId, type: "transactionCancelled", diagnostics: { transaction: scopeId, via: cancelEndId, traceId: traceIdFor(instanceId) } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: cancelEndId, status: "compensating", now: nowIso() }),
  ]);
}

/** Run (or resume) the reverse pass for `scopeId`, then settle the saga-failed terminal. */
async function settleAfterCompensation(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  scopeId: string,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
): Promise<DriveResult> {
  const result = await runCompensation(env, instanceId, graph, scopeId, runStep, waitFor);
  if (result === "waiting") return { status: "waiting" };
  if (result === "failed") return { status: "incident" }; // compensationFailed terminal (operator-resumable)
  await runStep(`settle:${scopeId}`, () => settleSagaCompensated(env, instanceId, scopeId, cancelBoundaryTarget(graph, scopeId)));
  return { status: "completed" };
}

type CompResult = "compensated" | "waiting" | "failed";

async function runCompensation(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  scopeId: string,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
): Promise<CompResult> {
  // Re-derive the cursor from the ledger each pass (crash-safe, resumable).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const steps = await selectScopeStepsForCompensation(env.DB, instanceId, scopeId);
    if (steps.length === 0) return "compensated";
    const step = steps[0]!; // highest seq still needing compensation

    let comp = await getCompensationJobByElement(env.DB, instanceId, step.elementId);
    if (!comp) {
      comp = await runStep(`comp-create:${step.elementId}`, () => createCompensationJob(env, instanceId, graph, step));
    }
    if (comp.status === "completed") {
      await runStep(`comp-done:${step.elementId}`, () => markStepCompensated(env, instanceId, step));
      continue;
    }
    if (comp.status === "failed") {
      await runStep(`comp-fail:${step.elementId}`, () => markStepCompensationFailed(env, instanceId, step));
      return "failed";
    }
    if (!waitFor) return "waiting"; // direct mode parks at 'compensating'; resume re-runs this pass

    const outcome = await waitFor({ name: `wait-comp:${step.elementId}`, workflowEventType: workflowJobEventTypeFor(comp.job_id), timeout: SVC_WAIT_TIMEOUT });
    if (outcome.kind === "timeout") {
      await runStep(`comp-timeout:${step.elementId}`, () => markStepCompensationFailed(env, instanceId, step));
      return "failed";
    }
    // loop re-reads the (now terminal) comp job
  }
}

async function createCompensationJob(env: Env, instanceId: string, graph: ExecutionGraph, step: SagaStepView): Promise<JobRow> {
  const inst = await loadInst(env, instanceId);
  const handlerNode = step.compensationElementId ? graph.nodes[step.compensationElementId] : undefined;
  const jobId = newId("job");
  const taskType = step.compensationTaskType ?? handlerNode?.taskType ?? "";
  await dbBatch(env.DB, [
    createJobStmt(env.DB, {
      jobId,
      instanceId,
      elementId: step.elementId, // forward element id (uq is per kind)
      taskType,
      retryLimit: Math.max(1, handlerNode?.retries ?? 1),
      idempotencyKey: `${instanceId}:${step.elementId}:compensate`,
      inputVariables: parseJson<JsonObject>(inst.variables, {}),
      workspaceId: inst.workspace_id,
      isCompensation: true,
      compensatesElementId: step.elementId,
      now: nowIso(),
    }),
    attachCompensationJobStmt(env.DB, { stepId: step.stepId, compensationJobId: jobId, now: nowIso() }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: step.elementId, type: "compensationStarted", diagnostics: { jobId, handler: step.compensationElementId, taskType, traceId: traceIdFor(instanceId) } }),
  ]);
  return (await getCompensationJobByElement(env.DB, instanceId, step.elementId))!;
}

async function markStepCompensated(env: Env, instanceId: string, step: SagaStepView): Promise<void> {
  const inst = await loadInst(env, instanceId);
  await dbBatch(env.DB, [
    updateCompensationStatusStmt(env.DB, { stepId: step.stepId, status: "compensated", now: nowIso() }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: step.elementId, type: "compensationCompleted", diagnostics: { handler: step.compensationElementId } }),
  ]);
}

async function markStepCompensationFailed(env: Env, instanceId: string, step: SagaStepView): Promise<void> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  await dbBatch(env.DB, [
    updateCompensationStatusStmt(env.DB, { stepId: step.stepId, status: "failed", now }),
    incidentStmt(env.DB, {
      incidentId: newId("inc"),
      instanceId,
      elementId: step.elementId,
      reason: `Compensation handler exhausted retries for step '${step.elementId}'.`,
      retryCount: 0,
      kind: "compensationFailure",
      resolution: "open",
      payloadContext: { handler: step.compensationElementId, compensationJobId: step.compensationJobId },
      now,
    }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: step.elementId, type: "compensationFailed", diagnostics: { handler: step.compensationElementId } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: step.elementId, status: "compensationFailed", now }),
  ]);
}

/** Settle the saga-failed terminal WITHOUT completeInstance (keep 'compensated'). */
async function settleSagaCompensated(env: Env, instanceId: string, scopeId: string, failureTarget: string | null): Promise<void> {
  const inst = await loadInst(env, instanceId);
  if (inst.status !== "compensating") return; // already settled / not in pass
  const now = nowIso();
  const finalEl = failureTarget ?? scopeId;
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: scopeId, type: "compensationCompleted", diagnostics: { transaction: scopeId, outcome: "compensated" } }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: finalEl, type: "sagaFailed", diagnostics: { settledVia: finalEl } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: finalEl, status: "compensated", completedAt: now, now }),
  ]);
}

// ---------------------------------------------------------------------------
// Receive Task (durable message wait) — unchanged semantics, new waitFor shape
// ---------------------------------------------------------------------------

type ReceiveOutcome = { kind: "next"; next: string } | { kind: "waiting" } | { kind: "incident" };

async function driveReceiveTask(
  env: Env,
  instanceId: string,
  elementId: string,
  node: GraphNode,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
  pending?: MessageEventPayload,
): Promise<ReceiveOutcome> {
  const next = node.next!;
  const messageName = node.messageName ?? "";

  if (pending) {
    const r = await runStep(`msg:${elementId}`, () => applyMessage(env, instanceId, elementId, next, pending));
    return { kind: "next", next: r.next };
  }

  const reg = await runStep(`recv:${elementId}`, () => registerReceive(env, instanceId, elementId, messageName));
  if (reg.kind === "incident") return { kind: "incident" };
  if (reg.kind === "correlated") {
    const r = await runStep(`msg:${elementId}`, () => applyMessage(env, instanceId, elementId, next, reg.event));
    return { kind: "next", next: r.next };
  }
  if (!waitFor) return { kind: "waiting" };
  const outcome = await waitFor({ name: `wait:${elementId}`, workflowEventType: reg.workflowEventType, timeout: SVC_WAIT_TIMEOUT });
  if (outcome.kind === "timeout") {
    await runStep(`recv-timeout:${elementId}`, () => createIncident(env, instanceId, elementId, 0, "Receive Task wait timed out.", { messageName }, "timeout"));
    return { kind: "incident" };
  }
  const event = parseMessageEvent(outcome.payload);
  const r = await runStep(`msg:${elementId}`, () => applyMessage(env, instanceId, elementId, next, event));
  return { kind: "next", next: r.next };
}

function parseMessageEvent(payload: unknown): MessageEventPayload {
  // The broker delivers a fully-formed MessageEventPayload; trust the runtime shape.
  return payload as MessageEventPayload;
}

type RegisterOutcome =
  | { kind: "waiting"; workflowEventType: string; subscriptionId: string }
  | { kind: "correlated"; event: MessageEventPayload }
  | { kind: "incident" };

async function registerReceive(env: Env, instanceId: string, elementId: string, messageName: string): Promise<RegisterOutcome> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  await historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "elementEntered", diagnostics: { elementType: "receiveTask", messageName } }).run();

  const existing = await getActiveSubscription(env.DB, instanceId, elementId);
  const subscriptionId = existing?.subscription_id ?? newId("sub");
  const workflowEventType = workflowEventTypeFor(messageName);
  const brokerKey = brokerKeyOf(inst.workspace_id, messageName, inst.correlation_key);
  const expiresAt = isoPlusMs(now, ONE_HOUR_MS);

  const brokerId = env.CORRELATION_BROKER.idFromName(brokerKey);
  const broker = env.CORRELATION_BROKER.get(brokerId);
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
    await createIncident(env, instanceId, elementId, 0, `Receive Task could not register: ${result.reason}`, { existingInstanceId: result.existingInstanceId ?? null }, "serviceTaskFailure");
    await historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "invariantViolation", diagnostics: { reason: result.reason, messageName, correlationKey: inst.correlation_key } }).run();
    return { kind: "incident" };
  }
  if (result.status === "correlated") return { kind: "correlated", event: result.event };

  if (!existing) {
    await createSubscription(env.DB, { subscriptionId, workspaceId: inst.workspace_id, instanceId, elementId, messageName, correlationKey: inst.correlation_key, brokerKey, workflowEventType, status: "active", expiresAt, now });
  }
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "receiveTaskWaiting", diagnostics: { subscriptionId, messageName, correlationKey: inst.correlation_key, expiresAt } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now }),
  ]);
  return { kind: "waiting", workflowEventType, subscriptionId };
}

async function applyMessage(env: Env, instanceId: string, elementId: string, next: string, event: MessageEventPayload): Promise<{ next: string }> {
  const inst = await loadInst(env, instanceId);
  const active = await getActiveSubscription(env.DB, instanceId, elementId);
  const now = nowIso();
  const merged = mergeVariables(parseJson<JsonObject>(inst.variables, {}), event.payload ?? {});

  let subscriptionId = active?.subscription_id;
  if (!subscriptionId) {
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

  await dbBatch(env.DB, [
    applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: next, status: "running", now }),
    ...(active ? [subscriptionConsumedStmt(env.DB, subscriptionId, event.externalMessageId, now)] : []),
    messageCorrelatedStmt(env.DB, { externalMessageId: event.externalMessageId, instanceId, subscriptionId, now }),
    variableSnapshotStmt(env.DB, { instanceId, source: "message", sourceId: event.externalMessageId, variables: event.payload ?? {}, now }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, externalMessageId: event.externalMessageId, type: "messageCorrelated", diagnostics: { subscriptionId, messageName: event.messageName, messageId: event.messageId }, payloadSnapshot: event.payload ?? {} }),
  ]);
  return { next };
}

// ---------------------------------------------------------------------------
// Completion + incidents
// ---------------------------------------------------------------------------

async function completeInstance(env: Env, instanceId: string, elementId: string): Promise<void> {
  const inst = await loadInst(env, instanceId);
  if (isTerminalInstanceStatus(inst.status)) return;
  const now = nowIso();
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "elementEntered", diagnostics: { elementType: "endEvent" } }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "instanceCompleted", diagnostics: {} }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "completed", completedAt: now, now }),
  ]);
}

async function parkWaiting(env: Env, instanceId: string, elementId: string, kind: "serviceTask" | "receiveTask"): Promise<void> {
  const inst = await loadInst(env, instanceId);
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "serviceTaskWaiting", diagnostics: { kind } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now: nowIso() }),
  ]);
}

async function createIncident(
  env: Env,
  instanceId: string,
  elementId: string,
  retryCount: number,
  reason: string,
  diagnostics: JsonObject,
  kind: IncidentKind,
): Promise<{ kind: "incident" }> {
  const inst = await loadInst(env, instanceId);
  // One-way status table (§4.6): never regress a terminal or compensating
  // instance back to 'incident' (e.g. a 1-hour-late forward-wait timeout
  // resuming after an operator /cancel already moved the saga on).
  if (isTerminalInstanceStatus(inst.status) || inst.status === "compensating") {
    return { kind: "incident" };
  }
  const now = nowIso();
  const incidentId = newId("inc");
  const payloadContext: JsonObject = { reason, ...diagnostics };
  await dbBatch(env.DB, [
    incidentStmt(env.DB, { incidentId, instanceId, elementId, reason, retryCount, kind, resolution: "open", payloadContext, now }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "incidentCreated", diagnostics: { incidentId, reason, retryCount, kind }, payloadSnapshot: payloadContext }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "incident", now }),
  ]);
  return { kind: "incident" };
}

/** Workflow-driver fallback: a terminal/uncaught failure becomes a view-only incident. */
export async function recordTerminalIncident(env: Env, instanceId: string, reason: string): Promise<void> {
  const inst = await getInstanceRow(env.DB, instanceId);
  if (!inst || isTerminalInstanceStatus(inst.status)) return;
  await createIncident(env, instanceId, inst.current_element_id ?? "unknown", 0, reason, {}, "serviceTaskFailure");
}

/**
 * Drive the engine inline (HTTP-side), e.g. for operator cancel/retry: it creates
 * the next pull job and parks, or settles a terminal saga. Mode-agnostic — the
 * resulting jobs are leased + completed through the pull plane like any other.
 */
export async function resumeInline(env: Env, instanceId: string, startAt?: string): Promise<DriveResult> {
  const inline = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
  return runInstance(env, instanceId, { runStep: inline, waitFor: null, startAt });
}

export { workflowEventTypeFor };
