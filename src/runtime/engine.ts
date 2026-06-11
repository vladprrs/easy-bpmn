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
// M2 (TASK-32) makes the walk CYCLE-CAPABLE — "the walk is the replay":
//   - Every drive RE-WALKS the graph from the start element. A walk-local,
//     IN-MEMORY visit counter assigns each visit of an element an OCCURRENCE
//     (0-based). Occurrence is NEVER derived from live D1 row counts — during a
//     Workflow replay those reads see post-crash state and would desynchronize
//     step names from the original execution.
//   - Every step name and persistence key carries the occurrence
//     (`svc-create:el#2`, `wait-job:el#2`, `msg:el#1`, …); jobs / saga-ledger
//     rows / message subscriptions are keyed per (element, occurrence).
//   - Already-applied visits FAST-FORWARD WRITE-FREE from canonical D1 state:
//     a completed job with output_applied=1 (or a failed one whose business
//     error was routed), a consumed subscription, or a bookkeeping node whose
//     per-visit history event landed are pure in-memory cursor moves. The
//     applied marker is set in the SAME dbBatch as the advance, so the
//     crash window between a worker completion and its apply resumes exactly
//     once (re-applying would re-merge an old iteration's output over newer
//     variables, rewrite the cursor backwards, and duplicate history).
//
// Both drivers share this code: the Workflow suspends/resumes in place across
// `waitFor` (step.do memoization fast-forwards replays by step NAME); the
// deterministic DirectExecutor parks (waitFor=null) and resumes by re-running
// the same rewalk — the instance status + the ledger are re-derived from D1
// each time, so direct-mode resume and crash recovery are the same path.
// D1 is canonical.

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
  applyTransitionStmt,
  createJobStmt,
  getCompensationJob,
  getForwardJob,
  getInstanceRow,
  getSubscriptionForVisit,
  incidentStmt,
  type InstanceRow,
  type IncidentKind,
  type JobRow,
  createSubscription,
  markFailedJobHandledStmt,
  markJobOutputAppliedStmt,
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
  /**
   * @deprecated TASK-32: the engine ALWAYS re-walks from the start element
   * ("the walk is the replay") and fast-forwards write-free through applied
   * steps, so a resume hint is advisory at best and ignored. Kept so existing
   * callers (executor resume paths) keep compiling without behavior change.
   */
  startAt?: string;
  incomingEvent?: MessageEventPayload;
}

const SVC_WAIT_TIMEOUT = "1 hour";

/**
 * Loop-iteration cap (design M2 §5): a walk that would visit the same element
 * id more than this many times settles a terminal `loopLimit` incident instead
 * of spinning (and bounds the Workflow step budget).
 */
export const MAX_ELEMENT_OCCURRENCES = 1000;

/**
 * Walk-local visit counter (design M2 §5). Returns the 0-based occurrence of
 * this visit and bumps the in-memory counter. Deliberately NOT derived from D1.
 */
function nextOccurrence(visits: Map<string, number>, elementId: string): number {
  const occ = visits.get(elementId) ?? 0;
  visits.set(elementId, occ + 1);
  return occ;
}

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

  // "The walk is the replay" (TASK-32): ALWAYS re-walk from the start element,
  // in both modes — opts.startAt is ignored. Applied steps fast-forward
  // write-free from canonical D1 state; the walk lands on the live frontier.
  return loop(env, instanceId, graph, opts.runStep, opts.waitFor, opts.incomingEvent);
}

// ---------------------------------------------------------------------------
// Main scope-aware loop (single-token in M1; occurrence-aware rewalk in M2)
// ---------------------------------------------------------------------------

async function loop(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
  incomingEvent?: MessageEventPayload,
): Promise<DriveResult> {
  const visits = new Map<string, number>();
  let cur: string = graph.startElementId;
  let pending = incomingEvent;

  while (true) {
    const node = graph.nodes[cur];
    if (!node) return { status: "completed" };

    // Walk-local occurrence: in-memory, identical in both modes and across
    // replays (the path is deterministic — graph topology + recorded outcomes).
    const occ = nextOccurrence(visits, cur);
    const tag = `${cur}#${occ}`;

    if (occ >= MAX_ELEMENT_OCCURRENCES) {
      await runStep(`loop-limit:${tag}`, () =>
        createIncident(
          env,
          instanceId,
          cur,
          0,
          `Element '${cur}' exceeded the loop-iteration cap (${MAX_ELEMENT_OCCURRENCES} visits).`,
          { occurrence: occ },
          "loopLimit",
        ),
      );
      return { status: "incident" };
    }

    if (node.type === "startEvent") {
      cur = await runStep(`start:${tag}`, () => enterStart(env, instanceId, graph, cur, occ, node));
      continue;
    }

    if (node.type === "transaction") {
      const innerStart = graph.transactions?.[cur]?.startId;
      if (!innerStart) return { status: "completed" }; // malformed (validator guards this)
      cur = await runStep(`tx:${tag}`, () => enterTransaction(env, instanceId, cur, occ, innerStart));
      continue;
    }

    if (node.type === "serviceTask" && !node.isForCompensation) {
      const r = await driveForwardServiceTask(env, instanceId, graph, cur, occ, node, runStep, waitFor);
      if (r.kind === "waiting") return { status: "waiting" };
      if (r.kind === "incident") return { status: "incident" };
      cur = r.next;
      continue;
    }

    if (node.type === "receiveTask") {
      const r = await driveReceiveTask(env, instanceId, cur, occ, node, runStep, waitFor, pending);
      if (r.kind === "waiting") return { status: "waiting" };
      if (r.kind === "incident") return { status: "incident" };
      // The delivered event is consumed at the LIVE visit only — a consumed
      // (fast-forwarded) earlier iteration must NOT clear it, or the live
      // frontier would never see it; conversely once applied it must never
      // leak into a later visit of the same (or another) receive task.
      if (r.consumedPending) pending = undefined;
      cur = r.next;
      continue;
    }

    if (node.type === "exclusiveGateway") {
      // TASK-34 replaces this guard with real XOR branch dispatch. Until then
      // a token reaching a published gateway (TASK-33 opened the publish gate)
      // must NOT fall through and zombify in 'running' with no D1 write —
      // settle the M1 terminal-incident path (incident row + incidentCreated
      // history + status transition in one batch) so the operator sees it.
      await runStep(`gw-guard:${tag}`, () =>
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
        await runStep(`cancel:${tag}`, () => beginCompensating(env, instanceId, node.scopeId!, cur));
        return settleAfterCompensation(env, instanceId, graph, node.scopeId!, runStep, waitFor);
      }
      if (isTransactionScope(graph, node.scopeId)) {
        // Inner none end → COMMIT the transaction → continue on its outer flow.
        cur = await runStep(`commit:${tag}`, () => commitTransaction(env, instanceId, graph, node.scopeId!, cur, occ));
        continue;
      }
      await runStep(`end:${tag}`, () => completeInstance(env, instanceId, cur));
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

/**
 * Write-free fast-forward predicate for a forward Service Task visit
 * (design M2 §5): once a job's terminal outcome has been APPLIED to the
 * instance (output_applied=1, set in the same dbBatch as the advance), the
 * rewalk derives the successor purely from graph + persisted job state —
 * a completed job advances on `node.next`; a business failure re-derives the
 * SAME deterministic boundary target from the persisted error_code. Returns
 * null when the visit still needs driving (the frontier).
 */
function appliedForwardOutcome(
  graph: ExecutionGraph,
  elementId: string,
  node: GraphNode,
  job: JobRow | null,
): ForwardOutcome | null {
  if (!job || job.output_applied !== 1) return null;
  if (job.status === "completed") return { kind: "next", next: node.next! };
  if (job.status === "failed" && job.error_code) {
    const target = errorBoundaryTarget(graph, elementId, job.error_code);
    if (target) return { kind: "next", next: target };
  }
  // Defensive — unreachable by construction: output_applied=1 is only ever set
  // on a completed apply or a business-routed failure (whose boundary target is
  // re-derivable from the immutable graph). Returning a zero-write outcome here
  // would zombify the instance silently; throw instead so workflow mode lands
  // in the process-workflow catch-all (recordTerminalIncident) and direct mode
  // surfaces the broken invariant to the caller.
  throw new Error(
    `Invariant violation: job ${job.job_id} (element ${elementId}, occurrence ${job.occurrence}) is marked ` +
      `output_applied but is '${job.status}' with error_code ${job.error_code ? `'${job.error_code}' (no matching error boundary in the graph)` : "NULL"} — no successor can be derived.`,
  );
}

async function driveForwardServiceTask(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
): Promise<ForwardOutcome> {
  const tag = `${elementId}#${occ}`;
  let job = await getForwardJob(env.DB, instanceId, elementId, occ);

  // Already applied → pure in-memory cursor move, NO writes, NO step.
  const applied = appliedForwardOutcome(graph, elementId, node, job);
  if (applied) return applied;

  if (job?.status === "completed") {
    return runStep(`svc-apply:${tag}`, () => applyForwardCompletion(env, instanceId, graph, elementId, occ, node, job!));
  }
  if (job?.status === "failed") {
    return runStep(`svc-fail:${tag}`, () => handleForwardFailure(env, instanceId, graph, elementId, occ, node, job!));
  }

  if (!job) {
    job = await runStep(`svc-create:${tag}`, () => createForwardJob(env, instanceId, elementId, occ, node));
    if (!job) return { kind: "incident" }; // oversized input → incident already recorded
  }

  // Park (direct mode) — the instance resumes by re-running once the worker's
  // complete/fail mutates the job in D1.
  if (!waitFor) {
    await runStep(`svc-park:${tag}`, () => parkWaiting(env, instanceId, elementId, "serviceTask"));
    return { kind: "waiting" };
  }

  // Suspend (workflow mode) — re-lease drives retries within this single wait.
  const outcome = await waitFor({
    name: `wait-job:${tag}`,
    workflowEventType: workflowJobEventTypeFor(job.job_id),
    timeout: SVC_WAIT_TIMEOUT,
  });
  // D1 is canonical: re-read the job whether we woke on the event OR on a timeout.
  // A lost wake-up event (swallowed sendEvent, isolate eviction) for an already
  // terminal job must be applied here, not masked as a spurious timeout incident.
  const fresh = (await getForwardJob(env.DB, instanceId, elementId, occ)) ?? job;
  // A concurrent inline drive may have applied the outcome while we waited.
  const appliedMeanwhile = appliedForwardOutcome(graph, elementId, node, fresh);
  if (appliedMeanwhile) return appliedMeanwhile;
  if (fresh.status === "completed") {
    return runStep(`svc-apply:${tag}`, () => applyForwardCompletion(env, instanceId, graph, elementId, occ, node, fresh));
  }
  if (fresh.status === "failed") {
    return runStep(`svc-fail:${tag}`, () => handleForwardFailure(env, instanceId, graph, elementId, occ, node, fresh));
  }
  if (outcome.kind === "timeout") {
    // A genuine timeout: nobody completed the job (still created/locked).
    return runStep(`svc-timeout:${tag}`, () =>
      createIncident(env, instanceId, elementId, node.retries ?? 1, "Service Task timed out waiting for a worker.", { jobId: fresh.job_id }, "timeout"),
    );
  }
  // Defensive: event arrived but job is not terminal — treat as a technical incident.
  return runStep(`svc-stuck:${tag}`, () =>
    createIncident(env, instanceId, elementId, fresh.attempt_count, "Service Task resumed with a non-terminal job.", { jobId: fresh.job_id }, "serviceTaskFailure"),
  );
}

async function createForwardJob(env: Env, instanceId: string, elementId: string, occ: number, node: GraphNode): Promise<JobRow | null> {
  // Idempotent re-run (Workflow step retry after a committed batch): this
  // iteration's row already exists → return it, never re-insert (the unique
  // index on (instance, element, kind, occurrence) would reject anyway).
  const existing = await getForwardJob(env.DB, instanceId, elementId, occ);
  if (existing) return existing;

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
      diagnostics: { elementType: "serviceTask", taskType, occurrence: occ },
    }),
    createJobStmt(env.DB, {
      jobId,
      instanceId,
      elementId,
      taskType,
      retryLimit: Math.max(1, node.retries ?? 1),
      idempotencyKey: `${instanceId}:${elementId}:0:${occ}`,
      inputVariables: variables,
      workspaceId: inst.workspace_id,
      isCompensation: false,
      activationExpiresAt,
      occurrence: occ,
      now,
    }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "serviceTaskJobCreated",
      diagnostics: { jobId, taskType, retryLimit: Math.max(1, node.retries ?? 1), activationExpiresAt, occurrence: occ },
    }),
  ]);
  await armJobScheduler(env, jobId, activationExpiresAt);
  return getForwardJob(env.DB, instanceId, elementId, occ);
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
  occ: number,
  node: GraphNode,
  job: JobRow,
): Promise<ForwardOutcome> {
  // Apply-once guard (idempotent step body): a Workflow step retry after the
  // batch below committed must not re-merge the output over newer variables.
  const live = await getForwardJob(env.DB, instanceId, elementId, occ);
  const appliedAlready = appliedForwardOutcome(graph, elementId, node, live);
  if (appliedAlready) return appliedAlready;

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
      diagnostics: { jobId: job.job_id, attempts: job.attempt_count, traceId: traceIdFor(instanceId), occurrence: occ },
    }),
    applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: next, status: "running", now }),
    // The applied marker commits ATOMICALLY with the advance (design M2 §5):
    // the rewalk treats this visit as write-free fast-forward from here on.
    markJobOutputAppliedStmt(env.DB, job.job_id, now),
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
        occurrence: occ,
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
  occ: number,
  node: GraphNode,
  job: JobRow,
): Promise<ForwardOutcome> {
  // Route-once guard (idempotent step body): a re-run after the business-error
  // batch committed fast-forwards to the recorded boundary target instead of
  // duplicating businessErrorCaught + rewriting the cursor.
  const live = await getForwardJob(env.DB, instanceId, elementId, occ);
  const appliedAlready = appliedForwardOutcome(graph, elementId, node, live);
  if (appliedAlready) return appliedAlready;

  const inst = await loadInst(env, instanceId);
  if (job.error_code) {
    // Business error → route to the matching error boundary's cancel end.
    const target = errorBoundaryTarget(graph, elementId, job.error_code);
    if (target) {
      const now = nowIso();
      await dbBatch(env.DB, [
        historyStmt(env.DB, {
          workspaceId: inst.workspace_id,
          instanceId,
          elementId,
          type: "businessErrorCaught",
          diagnostics: { jobId: job.job_id, errorCode: job.error_code, boundaryTarget: target, occurrence: occ },
        }),
        applyTransitionStmt(env.DB, { instanceId, currentElementId: target, status: "running", now }),
        // Atomic with the route: the rewalk fast-forwards this visit by
        // re-deriving the same deterministic target from the persisted error_code.
        markFailedJobHandledStmt(env.DB, job.job_id, now),
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

/**
 * Fast-forward predicate for BOOKKEEPING nodes (start / tx enter / commit end):
 * these nodes have no per-visit job or subscription row, but each visit writes
 * exactly ONE history event of `markerType` for `elementId` atomically with its
 * transition. History is append-only, so `count > occ` ⇔ visit `occ` already
 * applied. This is a live D1 read used only as an APPLIED predicate inside an
 * idempotent step body — never to derive the occurrence itself (in Workflow
 * mode normal replays don't even evaluate it: step.do memoization short-circuits
 * the body; only direct-mode rewalks and the crash-after-commit window do).
 */
async function visitApplied(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  markerType: string,
): Promise<boolean> {
  return (await countHistoryEventsOfType(env.DB, instanceId, elementId, markerType)) > occ;
}

async function enterStart(env: Env, instanceId: string, graph: ExecutionGraph, elementId: string, occ: number, node: GraphNode): Promise<string> {
  const next = node.next!;
  if (await visitApplied(env, instanceId, elementId, occ, "elementEntered")) return next; // write-free rewalk
  const inst = await loadInst(env, instanceId);
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

async function enterTransaction(env: Env, instanceId: string, txId: string, occ: number, innerStart: string): Promise<string> {
  if (await visitApplied(env, instanceId, txId, occ, "transactionEntered")) return innerStart; // write-free rewalk
  const inst = await loadInst(env, instanceId);
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: txId, type: "transactionEntered", diagnostics: { transaction: txId, traceId: traceIdFor(instanceId) } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: innerStart, status: "running", now: nowIso() }),
  ]);
  return innerStart;
}

async function commitTransaction(env: Env, instanceId: string, graph: ExecutionGraph, txId: string, endElementId: string, occ: number): Promise<string> {
  const txNode = graph.nodes[txId];
  const outer = txNode?.next ?? null;
  if (await visitApplied(env, instanceId, endElementId, occ, "elementEntered")) return outer ?? endElementId; // write-free rewalk
  const inst = await loadInst(env, instanceId);
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
  // Idempotent re-run: once the cancel transition committed the reverse pass
  // owns the instance — never duplicate transactionCancelled or regress status.
  if (inst.status === "compensating" || isTerminalInstanceStatus(inst.status)) return;
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
  // With loops each iteration is its own ledger row (occurrence-keyed), so the
  // reverse pass compensates every iteration separately with zero algorithm
  // change; compensation jobs + step names inherit the forward occurrence.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const steps = await selectScopeStepsForCompensation(env.DB, instanceId, scopeId);
    if (steps.length === 0) return "compensated";
    const step = steps[0]!; // highest seq still needing compensation
    const ctag = `${step.elementId}#${step.occurrence}`;

    let comp = await getCompensationJob(env.DB, instanceId, step.elementId, step.occurrence);
    if (!comp) {
      comp = await runStep(`comp-create:${ctag}`, () => createCompensationJob(env, instanceId, graph, step));
    }
    if (comp.status === "completed") {
      await runStep(`comp-done:${ctag}`, () => markStepCompensated(env, instanceId, step));
      continue;
    }
    if (comp.status === "failed") {
      await runStep(`comp-fail:${ctag}`, () => markStepCompensationFailed(env, instanceId, step));
      return "failed";
    }
    if (!waitFor) return "waiting"; // direct mode parks at 'compensating'; resume re-runs this pass

    const outcome = await waitFor({ name: `wait-comp:${ctag}`, workflowEventType: workflowJobEventTypeFor(comp.job_id), timeout: SVC_WAIT_TIMEOUT });
    if (outcome.kind === "timeout") {
      await runStep(`comp-timeout:${ctag}`, () => markStepCompensationFailed(env, instanceId, step));
      return "failed";
    }
    // loop re-reads the (now terminal) comp job
  }
}

async function createCompensationJob(env: Env, instanceId: string, graph: ExecutionGraph, step: SagaStepView): Promise<JobRow> {
  // Idempotent re-run (Workflow step retry after a committed batch).
  const existing = await getCompensationJob(env.DB, instanceId, step.elementId, step.occurrence);
  if (existing) return existing;

  const inst = await loadInst(env, instanceId);
  const handlerNode = step.compensationElementId ? graph.nodes[step.compensationElementId] : undefined;
  const jobId = newId("job");
  const taskType = step.compensationTaskType ?? handlerNode?.taskType ?? "";
  await dbBatch(env.DB, [
    createJobStmt(env.DB, {
      jobId,
      instanceId,
      elementId: step.elementId, // forward element id (uq is per kind + occurrence)
      taskType,
      retryLimit: Math.max(1, handlerNode?.retries ?? 1),
      idempotencyKey: `${instanceId}:${step.elementId}:1:${step.occurrence}`,
      inputVariables: parseJson<JsonObject>(inst.variables, {}),
      workspaceId: inst.workspace_id,
      isCompensation: true,
      compensatesElementId: step.elementId,
      // A compensation job inherits its forward step's occurrence (design M2 §8).
      occurrence: step.occurrence,
      now: nowIso(),
    }),
    attachCompensationJobStmt(env.DB, { stepId: step.stepId, compensationJobId: jobId, now: nowIso() }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: step.elementId, type: "compensationStarted", diagnostics: { jobId, handler: step.compensationElementId, taskType, traceId: traceIdFor(instanceId), occurrence: step.occurrence } }),
  ]);
  return (await getCompensationJob(env.DB, instanceId, step.elementId, step.occurrence))!;
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
// Receive Task (durable message wait) — occurrence-keyed subscriptions (M2 §5):
// a Receive Task inside a loop re-subscribes per visit; the broker key
// (workspace + messageName + correlationKey) is unchanged — sequential
// re-subscription on the same key is the already-supported broker pattern.
// The subscription row's `consumed` status (set atomically with the
// transition out of the wait) IS the write-free fast-forward predicate.
// ---------------------------------------------------------------------------

type ReceiveOutcome =
  | { kind: "next"; next: string; consumedPending?: boolean }
  | { kind: "waiting" }
  | { kind: "incident" };

async function driveReceiveTask(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  node: GraphNode,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
  pending?: MessageEventPayload,
): Promise<ReceiveOutcome> {
  const tag = `${elementId}#${occ}`;
  const next = node.next!;
  const messageName = node.messageName ?? "";

  // Already applied → pure in-memory cursor move, NO writes, NO step. If the
  // in-flight delivery is exactly the message this visit consumed (a racing
  // duplicate drive applied it first), drop it so it can never advance a
  // SECOND iteration.
  const sub = await getSubscriptionForVisit(env.DB, instanceId, elementId, occ);
  if (sub?.status === "consumed") {
    return { kind: "next", next, consumedPending: !!pending && sub.external_message_id === pending.externalMessageId };
  }

  if (pending) {
    const r = await runStep(`msg:${tag}`, () => applyMessage(env, instanceId, elementId, occ, next, pending));
    return { kind: "next", next: r.next, consumedPending: true };
  }

  const reg = await runStep(`recv:${tag}`, () => registerReceive(env, instanceId, elementId, occ, messageName));
  if (reg.kind === "incident") return { kind: "incident" };
  if (reg.kind === "applied") return { kind: "next", next };
  if (reg.kind === "correlated") {
    const r = await runStep(`msg:${tag}`, () => applyMessage(env, instanceId, elementId, occ, next, reg.event));
    return { kind: "next", next: r.next };
  }
  if (!waitFor) return { kind: "waiting" };
  const outcome = await waitFor({ name: `wait:${tag}`, workflowEventType: reg.workflowEventType, timeout: SVC_WAIT_TIMEOUT });
  if (outcome.kind === "timeout") {
    // D1 is canonical: an inline drive (e.g. after a Workflow handover) may
    // have applied this visit's message while we waited — advance, don't fail.
    const fresh = await getSubscriptionForVisit(env.DB, instanceId, elementId, occ);
    if (fresh?.status === "consumed") return { kind: "next", next };
    await runStep(`recv-timeout:${tag}`, () => createIncident(env, instanceId, elementId, 0, "Receive Task wait timed out.", { messageName }, "timeout"));
    return { kind: "incident" };
  }
  const event = parseMessageEvent(outcome.payload);
  const r = await runStep(`msg:${tag}`, () => applyMessage(env, instanceId, elementId, occ, next, event));
  return { kind: "next", next: r.next };
}

function parseMessageEvent(payload: unknown): MessageEventPayload {
  // The broker delivers a fully-formed MessageEventPayload; trust the runtime shape.
  return payload as MessageEventPayload;
}

type RegisterOutcome =
  | { kind: "waiting"; workflowEventType: string; subscriptionId: string }
  | { kind: "correlated"; event: MessageEventPayload }
  // This visit's message was applied concurrently — nothing to register.
  | { kind: "applied" }
  | { kind: "incident" };

async function registerReceive(env: Env, instanceId: string, elementId: string, occ: number, messageName: string): Promise<RegisterOutcome> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();

  const existing = await getSubscriptionForVisit(env.DB, instanceId, elementId, occ);
  if (existing?.status === "consumed") return { kind: "applied" }; // idempotent re-run guard
  const active = existing?.status === "active" ? existing : null;

  if (!active) {
    // First registration for this visit — exactly one audit entry per occurrence
    // (a rewalk that lands on an already-active wait re-registers WRITE-FREE).
    await historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "elementEntered", diagnostics: { elementType: "receiveTask", messageName, occurrence: occ } }).run();
  }

  const subscriptionId = active?.subscription_id ?? newId("sub");
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

  if (!active) {
    await createSubscription(env.DB, { subscriptionId, workspaceId: inst.workspace_id, instanceId, elementId, messageName, correlationKey: inst.correlation_key, brokerKey, workflowEventType, status: "active", expiresAt, occurrence: occ, now });
    await dbBatch(env.DB, [
      historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "receiveTaskWaiting", diagnostics: { subscriptionId, messageName, correlationKey: inst.correlation_key, expiresAt, occurrence: occ } }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now }),
    ]);
  }
  return { kind: "waiting", workflowEventType, subscriptionId };
}

async function applyMessage(env: Env, instanceId: string, elementId: string, occ: number, next: string, event: MessageEventPayload): Promise<{ next: string }> {
  const inst = await loadInst(env, instanceId);
  const sub = await getSubscriptionForVisit(env.DB, instanceId, elementId, occ);
  // Apply-once guard (idempotent step body): the payload merge + the transition
  // out of the wait commit atomically below; once `consumed`, a re-run is a no-op.
  if (sub?.status === "consumed") return { next };
  const active = sub?.status === "active" ? sub : null;
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
      occurrence: occ,
      now,
    });
  }

  await dbBatch(env.DB, [
    applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: next, status: "running", now }),
    ...(active ? [subscriptionConsumedStmt(env.DB, subscriptionId, event.externalMessageId, now)] : []),
    messageCorrelatedStmt(env.DB, { externalMessageId: event.externalMessageId, instanceId, subscriptionId, now }),
    variableSnapshotStmt(env.DB, { instanceId, source: "message", sourceId: event.externalMessageId, variables: event.payload ?? {}, now }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, externalMessageId: event.externalMessageId, type: "messageCorrelated", diagnostics: { subscriptionId, messageName: event.messageName, messageId: event.messageId, occurrence: occ }, payloadSnapshot: event.payload ?? {} }),
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
  // Idempotent re-park: a rewalk that lands on an already-parked wait frontier
  // (operator resume, duplicate drive) is WRITE-FREE — never duplicate the
  // serviceTaskWaiting audit event or touch the cursor it would re-set.
  if (inst.status === "waiting" && inst.current_element_id === elementId) return;
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
 * `startAt` is accepted for caller compatibility but IGNORED (TASK-32): the
 * engine always rewalks from the start element and fast-forwards write-free.
 */
export async function resumeInline(env: Env, instanceId: string, startAt?: string): Promise<DriveResult> {
  const inline = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
  return runInstance(env, instanceId, { runStep: inline, waitFor: null, startAt });
}

export { workflowEventTypeFor };
