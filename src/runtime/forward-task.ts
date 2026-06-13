// Forward Service Task as a durable pull wait (M3-L0 extraction, TASK-38).
//
// The forward service-task visit block lifted verbatim from engine.ts: job
// creation + DLQ arming, the durable wait/park, applied fast-forward, business-
// error routing, technical exhaustion, and the un-leasable-job DLQ termination.
// Behavior-frozen — step names, history event types, persisted shapes, and the
// poison/DLQ math are all unchanged.

import type { Env } from "../env";
import type { ExecutionGraph, GraphNode } from "../bpmn/graph";
import { workflowJobEventTypeFor } from "../bpmn/profile";
import { MAX_EVENT_PAYLOAD_BYTES, payloadByteSize } from "./payload";
import {
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
import { failLeasedJobConditional, failUnleasableJobConditional, getJobRowById, listLockedForwardJobs, reopenJobKeepAttemptStmt } from "../persistence/jobs";
import {
  armTimerDO,
  buildBoundaryArm,
  buildBoundaryCancelSettle,
  convertOnFire,
  isUniqueConstraintViolation,
  settleBoundaryTimerCancel,
  settleOverdueBoundaryTimerOnWake,
  timerBoundaryFor,
  timerGuardedTimeout,
  timerHasFired,
} from "./boundary-timer";
import { getTimer, timerIdFor } from "../persistence/timers";
import { dbBatch } from "../persistence/db";
import { countHistoryEventsOfType, historyStmt } from "../persistence/history";
import {
  applyTransitionStmt,
  createJobStmt,
  getForwardJob,
  getInstanceRow,
  incidentStmt,
  type JobRow,
  markFailedJobHandledStmt,
  markJobOutputAppliedStmt,
  transitionStatusGuardedStmt,
  variableSnapshotStmt,
} from "../persistence/instances";
import { insertSagaStepStmt } from "../persistence/saga";
import { loadInst, isTransactionScope, SVC_WAIT_TIMEOUT, type RunStep, type WaitForEvent } from "./engine-shared";
import { createIncident, parkWaiting } from "./incidents";
import { resolveScope } from "./frontier";
import { getToken, parseOverlay, readOverlay, rootTokenId, setTokenOverlayStmt, writeOverlay } from "../persistence/tokens";

/**
 * The token-path node an error boundary on `elementId` routes the failed token
 * to, by `errorCode`. Free error-boundary routing (M3-L2, TASK-42): an activity
 * may carry many DISTINCT-`@errorCode` interrupting boundaries plus at most one
 * catch-all (validator-enforced), each targeting ANY token-path node — no longer
 * cancel-end-only. The matching precedence is:
 *   exact `@errorCode` → catch-all (`errorCode == null`) → null (→ caller Hazard).
 * After validation a null `errorCode` UNAMBIGUOUSLY means catch-all (a coded
 * boundary with an empty/missing `@errorCode` is rejected at publish), so the
 * catch-all matches ANY business code including ones not declared as a
 * `<bpmn:error>`. Deterministic regardless of node-iteration order: an exact
 * match returns immediately; otherwise the (single) catch-all is the fallback.
 */
function errorBoundaryTarget(graph: ExecutionGraph, elementId: string, errorCode: string | null): string | null {
  // The catch-all's target (its `next`, or null if it routes nowhere) doubles as
  // the "no catch-all found" sentinel: both yield null, which the caller treats
  // as an uncaught business error (→ Hazard). No separate presence flag needed.
  let catchAll: string | null = null;
  for (const [, node] of Object.entries(graph.nodes)) {
    if (node.type !== "boundaryEvent" || node.boundaryKind !== "error" || node.attachedToRef !== elementId) continue;
    if (node.errorCode != null && node.errorCode === errorCode) return node.next ?? null; // exact wins
    if (node.errorCode == null) catchAll = node.next ?? null;
  }
  return catchAll;
}

export type ForwardOutcome = { kind: "next"; next: string } | { kind: "waiting" } | { kind: "incident" };

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

export async function driveForwardServiceTask(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
  activeTokenId?: string,
): Promise<ForwardOutcome> {
  const tag = `${elementId}#${occ}`;
  const tb = timerBoundaryFor(graph, elementId);

  // Boundary-timer fast-forward (M3-L3, design §4.1): `timer_outcomes` is the
  // truth for a timer-guarded visit — `fired` → the token already took the
  // boundary path (write-free advance to its target). `cancelled` falls through;
  // the normal applied/completed/failed logic (settled atomically with the cancel
  // claim in those batches) drives it below.
  if (tb && (await timerHasFired(env, instanceId, tb, occ))) {
    return { kind: "next", next: tb.node.next! };
  }

  let job = await getForwardJob(env.DB, instanceId, elementId, occ);

  // Already applied → pure in-memory cursor move, NO writes, NO step.
  const applied = appliedForwardOutcome(graph, elementId, node, job);
  if (applied) return applied;

  if (job?.status === "completed") {
    return runStep(`svc-apply:${tag}`, () => applyForwardCompletion(env, instanceId, graph, elementId, occ, node, job!, activeTokenId));
  }
  if (job?.status === "failed") {
    return runStep(`svc-fail:${tag}`, () => handleForwardFailure(env, instanceId, graph, elementId, occ, node, job!));
  }

  if (!job) {
    job = await runStep(`svc-create:${tag}`, () => createForwardJob(env, instanceId, graph, elementId, occ, node, activeTokenId));
    if (!job) return { kind: "incident" }; // oversized input → incident already recorded
  } else if (tb) {
    // Self-healing re-arm (design §4.2): a rewalk landing on a still-armed timer
    // re-arms the DO idempotently, so a lost alarm is repaired by the next drive.
    const trow = await getTimer(env.DB, timerIdFor(instanceId, tb.boundaryId, occ));
    if (trow?.status === "armed") await armTimerDO(env, trow.timerId, trow.fireAt);
  }

  // Park (direct mode) — the instance resumes by re-running once the worker's
  // complete/fail mutates the job in D1 (or the timer alarm fires).
  if (!waitFor) {
    await runStep(`svc-park:${tag}`, () => parkWaiting(env, instanceId, elementId, occ, "serviceTask"));
    return { kind: "waiting" };
  }

  // Suspend (workflow mode) — re-lease drives retries within this single wait. A
  // timer-guarded wait is SIZED to the timer (so a long timer costs O(1) steps).
  const timeout = tb ? await timerGuardedTimeout(env, instanceId, tb, occ) : SVC_WAIT_TIMEOUT;
  const outcome = await waitFor({
    name: `wait-job:${tag}`,
    workflowEventType: workflowJobEventTypeFor(job.job_id),
    timeout,
  });
  // M4-L3 multi-wait: a region branch in workflow mode REGISTERED this wait in the
  // collector and did not suspend — return parked; raceParkedWaits awaits it. (CI is
  // direct mode: waitFor is null, so we never reach here.)
  if (outcome.kind === "parked") return { kind: "waiting" };
  // The timer may have fired (its sendEvent wake, or a concurrent alarm) while we
  // waited — re-read the decider FIRST so an abandoned job is not misread as a fail.
  if (tb && (await timerHasFired(env, instanceId, tb, occ))) {
    return { kind: "next", next: tb.node.next! };
  }
  // D1 is canonical: re-read the job whether we woke on the event OR on a timeout.
  // A lost wake-up event (swallowed sendEvent, isolate eviction) for an already
  // terminal job must be applied here, not masked as a spurious timeout incident.
  const fresh = (await getForwardJob(env.DB, instanceId, elementId, occ)) ?? job;
  // A concurrent inline drive may have applied the outcome while we waited.
  const appliedMeanwhile = appliedForwardOutcome(graph, elementId, node, fresh);
  if (appliedMeanwhile) return appliedMeanwhile;
  if (fresh.status === "completed") {
    return runStep(`svc-apply:${tag}`, () => applyForwardCompletion(env, instanceId, graph, elementId, occ, node, fresh, activeTokenId));
  }
  if (fresh.status === "failed") {
    return runStep(`svc-fail:${tag}`, () => handleForwardFailure(env, instanceId, graph, elementId, occ, node, fresh));
  }
  if (outcome.kind === "timeout") {
    if (tb) {
      // Lost-alarm backstop (design §4.2, risk R5). A wait guarded by a modeled
      // timer NEVER raises waitTimeout. The DO alarm is the PRIMARY firing
      // mechanism; this timer-SIZED timeout doubles as the backstop for a lost/
      // failed alarm: on this wake re-read D1 and settle an OVERDUE timer INLINE
      // exactly as the alarm path would, RETURNING the boundary path to THIS drive
      // loop. We are already inside a drive, so there is no executor wake here —
      // that is what avoids the runtime/timers → executor → engine import cycle.
      // (Workflow-mode-only; the DO-alarm fire path is the CI-tested mechanism.)
      const settled = await settleOverdueBoundaryTimerOnWake(env, graph, instanceId, elementId, occ);
      if (settled.kind === "fired") return { kind: "next", next: settled.next };
      if (settled.kind === "reparked") return { kind: "waiting" }; // armed-but-early → re-armed; re-park
      // fallThrough: a concurrent normal resolution settled the timer 'cancelled'
      // (its transition rode the same batch) — re-read and run the normal completed/
      // failed/applied handling so a swallowed wake is not stranded.
      const settledJob = (await getForwardJob(env.DB, instanceId, elementId, occ)) ?? fresh;
      const appliedAfterSettle = appliedForwardOutcome(graph, elementId, node, settledJob);
      if (appliedAfterSettle) return appliedAfterSettle;
      if (settledJob.status === "completed") {
        return runStep(`svc-apply:${tag}`, () => applyForwardCompletion(env, instanceId, graph, elementId, occ, node, settledJob, activeTokenId));
      }
      if (settledJob.status === "failed") {
        return runStep(`svc-fail:${tag}`, () => handleForwardFailure(env, instanceId, graph, elementId, occ, node, settledJob));
      }
      return { kind: "waiting" }; // still parked (e.g. a concurrent /cancel terminal) — re-park
    }
    // A genuine UN-GUARDED wait-cap: nobody completed the job (still created/locked).
    // M3-L1 (TASK-39): the un-guarded service-task wait cap is 'waitTimeout', split
    // out of the legacy overloaded 'timeout'. NOTE: `outcome.kind === "timeout"` is
    // the wait-OUTCOME discriminator (a different axis) — only the incident changes.
    return runStep(`svc-timeout:${tag}`, () =>
      createIncident(env, instanceId, elementId, node.retries ?? 1, "Service Task timed out waiting for a worker.", { jobId: fresh.job_id }, "waitTimeout"),
    );
  }
  // Defensive: event arrived but job is not terminal — treat as a technical incident.
  return runStep(`svc-stuck:${tag}`, () =>
    createIncident(env, instanceId, elementId, fresh.attempt_count, "Service Task resumed with a non-terminal job.", { jobId: fresh.job_id }, "serviceTaskFailure"),
  );
}

async function createForwardJob(env: Env, instanceId: string, graph: ExecutionGraph, elementId: string, occ: number, node: GraphNode, activeTokenId?: string): Promise<JobRow | null> {
  // Idempotent re-run (Workflow step retry after a committed batch): this
  // iteration's row already exists → return it, never re-insert (the unique
  // index on (instance, element, kind, occurrence) would reject anyway).
  const existing = await getForwardJob(env.DB, instanceId, elementId, occ);
  if (existing) return existing;

  const inst = await loadInst(env, instanceId);
  // Branch-scoped input (design §5.7): a branch token's job sees its resolved
  // overlay chain (root vars + ancestor overlays, nearest wins); a null/root
  // token reads root variables verbatim (the exact M0–M3 path).
  const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
  const variables = isBranch
    ? await resolveScope(env, instanceId, parseJson<JsonObject>(inst.variables, {}), activeTokenId!)
    : parseJson<JsonObject>(inst.variables, {});
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
  // M3-L3: arm the interrupting boundary timer (if any) in the SAME visit batch —
  // persist-before-advance. fire_at is computed once here; the DO alarm is armed
  // after the batch commits (best-effort, like the DLQ alarm).
  const arm = buildBoundaryArm(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: elementId, occ, now });
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
    ...(arm ? arm.stmts : []),
  ]);
  await armJobScheduler(env, jobId, activationExpiresAt);
  if (arm) await armTimerDO(env, arm.timerId, arm.fireAt);
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
 * Arm a per-job lease-expiry terminator (design §8.2) for EVERY in-flight cohort
 * forward job when a scope enters `compensating` — so the quiescence barrier never
 * depends on a future `/jobs/activate` poll (blocker 8). Re-uses the JobScheduler DLQ
 * alarm: its fire routes to `terminateUnleasableJob`, whose locked-cohort branch
 * claims the expired lease `failed` and re-drives. Best-effort (a DO hiccup just
 * leaves that job to the poll-only reclaim), and a no-op for single-token instances
 * (no locked forward job survives to a cancel).
 */
export async function armCohortLeaseExpiryTerminators(env: Env, instanceId: string): Promise<void> {
  const locked = await listLockedForwardJobs(env.DB, instanceId);
  for (const job of locked) {
    if (job.lock_expires_at) await armJobScheduler(env, job.job_id, job.lock_expires_at);
  }
}

/**
 * DLQ termination (§4.2), invoked by the JobScheduler alarm at activation_expires_at.
 * D1 is canonical — the DO holds no authoritative state — so this re-reads the job
 * and only acts if it is STILL an un-leased, expired forward job on a non-terminal
 * instance. Otherwise (progressed / already settled / late-or-duplicate alarm) it
 * is an idempotent no-op. The terminal incident kind='jobActivationTimeout' is
 * written directly (never falling through to the process-workflow.ts catch-all),
 * so the DLQ outcome is assertable in direct mode without a live Workflow.
 */
export async function terminateUnleasableJob(env: Env, jobId: string): Promise<void> {
  const job = await getJobRowById(env.DB, jobId);
  if (!job || job.is_compensation === 1) return;
  const now = nowIso();

  // M4-L5 (design §8.2): the in-flight cohort lease-expiry terminator. While the
  // instance is COMPENSATING, a still-`locked` cohort forward job whose lease has
  // expired (its worker vanished) MUST be driven terminal so the quiescence barrier
  // never depends on a future /jobs/activate poll. Claim it `failed` (race-safe vs a
  // concurrent straggler complete by the `status='locked'` guard), then re-drive so
  // the straggler scan discards the now-failed token. Only the compensating cohort
  // takes this path — a normal leased job on a running instance no-ops here.
  if (job.status === "locked") {
    const linst = await getInstanceRow(env.DB, job.instance_id);
    if (!linst || linst.status !== "compensating") return;
    if (!job.lock_expires_at || isoIsBefore(now, job.lock_expires_at)) return; // lease not yet expired
    if ((await failLeasedJobConditional(env.DB, jobId, now)) === 0) return; // a complete won the race
    // Dynamic import: forward-task.ts is imported BY engine.ts (terminateUnleasableJob),
    // so a static `import { resumeInline } from "./engine"` would form a cycle.
    const { resumeInline } = await import("./engine");
    await resumeInline(env, linst.instance_id);
    return;
  }

  if (!(job.status === "created" && job.attempt_count === 0)) return; // leased/completed/failed → no-op
  if (!job.activation_expires_at || isoIsBefore(now, job.activation_expires_at)) return; // not yet expired (early/spurious alarm)

  // M4-L5 (design §8.2): the un-leasable DLQ MUST fire even while the instance is
  // COMPENSATING (the old `inst.status === "compensating"` early-return is dropped),
  // so a never-leased cohort forward job goes terminal → its token is discarded by
  // the next compensating drive's straggler scan and the barrier drains. Safe: the
  // atomic created→failed claim never regresses a compensating status, and the
  // guarded transition below (running/waiting → incident) is a 0-row no-op for it.
  const inst = await getInstanceRow(env.DB, job.instance_id);
  if (!inst || isTerminalInstanceStatus(inst.status)) return;

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
  // M3-L1 (TASK-39): the DLQ kind is its OWN taxonomy bucket, split out of the
  // legacy overloaded 'timeout'. A single local const so the incident row and its
  // history event can never drift apart.
  const kind = "jobActivationTimeout" as const;
  const reason = "Service Task job expired before any worker leased it (un-leasable taskType).";
  const payloadContext: JsonObject = { reason, jobId, taskType: job.task_type, activationExpiresAt: job.activation_expires_at, dlq: "un-leasable" };
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId: inst.instance_id, elementId: job.element_id, type: "jobActivationExpired", diagnostics: { jobId, taskType: job.task_type, activationExpiresAt: job.activation_expires_at } }),
    incidentStmt(env.DB, { incidentId, instanceId: inst.instance_id, elementId: job.element_id, reason, retryCount: 0, kind, resolution: "open", payloadContext, now }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId: inst.instance_id, elementId: job.element_id, type: "incidentCreated", diagnostics: { incidentId, reason, kind, retryCount: 0 }, payloadSnapshot: payloadContext }),
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
  activeTokenId?: string,
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
  // Branch-scoped output (design §5.7): a branch token's output merges onto its
  // OWN overlay (not root); root vars mutate only at the join fold-up. A
  // null/root token keeps the M0–M3 path (merge into process_instances.variables).
  const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
  const branchTokenRow = isBranch ? await getToken(env.DB, activeTokenId!) : null;
  // R2-aware read (M4-L6, design §9.1): a branch overlay may be an {"__r2":…} ref.
  const baseVars = isBranch ? (branchTokenRow ? await readOverlay(env, parseOverlay(branchTokenRow)) : {}) : parseJson<JsonObject>(inst.variables, {});
  const merged = mergeVariables(baseVars, output);
  const now = nowIso();

  // Poison detection (§4.3): the per-call output already passed the payload limit
  // at /jobs/complete, but the MERGE into instance variables may still breach it —
  // an un-applicable completion. Re-open the job up to POISON_THRESHOLD strikes,
  // then terminate with a DISTINCT kind='poison'. The strike counter is the number
  // of un-applicable COMPLETIONS (counted from the serviceTaskOutputRejected
  // history), NOT the lease attempt_count — a technical retry must not consume the
  // poison budget. Poison NEVER compensates (only a business error → cancel does).
  //
  // DECISION (TASK-35, with loops legal): strikes are counted per
  // (instance, element) ACROSS occurrences — every iteration of a loop shares
  // ONE poison budget. Deliberate: an element whose completions keep breaching
  // the merge limit is poisoning the instance regardless of which iteration
  // produced the output, and should die fast rather than earn a fresh
  // POISON_THRESHOLD per visit (×1000 under the loop cap). Per-occurrence
  // budgets are TASK-36+ scope if a real model ever needs them.
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
      // Like the DLQ jobActivationTimeout race, this poison terminal does NOT settle
      // the host's boundary timer (no decider claim) — it is left `armed` on a now-
      // terminal instance, harmlessly: triple-guarded (fireTimer's terminal-instance
      // guard + the host job is no longer created/locked + the operator /cancel
      // sweep), so a stray alarm never fires and never compensates.
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

  // R2-aware write (M4-L6, design §9.1): offload a large branch overlay to R2 BEFORE
  // the D1 commit (deterministic key ⇒ a crash-retry is byte-identical). Reached
  // only when merged is within the event-payload limit (the poison gate above);
  // root vars stay inline.
  const storedBranchOverlay = isBranch ? await writeOverlay(env, instanceId, activeTokenId!, merged) : merged;

  const statements: D1PreparedStatement[] = [
    variableSnapshotStmt(env.DB, { instanceId, source: "serviceTask", sourceId: job.job_id, variables: output, now }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "serviceTaskCompleted",
      diagnostics: { jobId: job.job_id, attempts: job.attempt_count, traceId: traceIdFor(instanceId), occurrence: occ },
    }),
    // A branch token's output goes to its OWN overlay (design §5.7); the instance
    // status moves to 'running' WITHOUT touching root vars or pinning a single
    // current_element_id (NULL = multi-token frontier, §5.3). A root/single-token
    // token keeps the exact M0–M3 write (merged → process_instances.variables).
    ...(isBranch
      ? [
          setTokenOverlayStmt(env.DB, activeTokenId!, storedBranchOverlay, now),
          applyTransitionStmt(env.DB, { instanceId, currentElementId: null, status: "running", now }),
        ]
      : [applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: next, status: "running", now })]),
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
        // M4-L5 (design §8.4): carry the producing branch token so the reverse
        // pass compensates this step only once its lineage quiesces. NULL on the
        // root/single-token (M1–M3) path → filterLineageQuiesced is a no-op there.
        tokenId: activeTokenId ?? null,
        now,
      }),
    );
  }

  // M3-L3: settle the guarding timer 'cancelled' ATOMICALLY with the advance (the
  // decider claim rides this batch). If the timer FIRED first, the plain INSERT
  // violates the PK and the WHOLE batch aborts — convert to the boundary path.
  const cancelSettle = buildBoundaryCancelSettle(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: elementId, occ, now });
  if (cancelSettle) statements.push(...cancelSettle.stmts);
  try {
    await dbBatch(env.DB, statements);
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const converted = await convertOnFire(env, graph, instanceId, elementId, occ);
      if (converted) return { kind: "next", next: converted };
    }
    throw err;
  }
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
    // Business error → route to the matching error boundary's target (any
    // token-path node; exact @errorCode → catch-all). The token then walks
    // forward like any other: it triggers compensation only if it REACHES a
    // cancel end, otherwise the saga continues with the ledger intact.
    const target = errorBoundaryTarget(graph, elementId, job.error_code);
    if (target) {
      const now = nowIso();
      const stmts: D1PreparedStatement[] = [
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
      ];
      // M3-L3: settle the guarding timer 'cancelled' atomically with the error
      // route; on a decider conflict the timer FIRED first → convert to its path.
      const cancelSettle = buildBoundaryCancelSettle(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: elementId, occ, now });
      if (cancelSettle) stmts.push(...cancelSettle.stmts);
      try {
        await dbBatch(env.DB, stmts);
      } catch (err) {
        if (isUniqueConstraintViolation(err)) {
          const converted = await convertOnFire(env, graph, instanceId, elementId, occ);
          if (converted) return { kind: "next", next: converted };
        }
        throw err;
      }
      return { kind: "next", next: target };
    }
    // Uncaught business error → Hazard. Settle the guarding timer first (its own
    // batch — the Hazard terminal is a separate createIncident batch); if the timer
    // fired in the window, convert to the boundary path instead of a Hazard.
    const settledUncaught = await settleBoundaryTimerCancel(env, graph, instanceId, inst.workspace_id, elementId, occ);
    if (typeof settledUncaught === "object") return { kind: "next", next: settledUncaught.converted };
    return createIncident(env, instanceId, elementId, job.attempt_count, `Uncaught business error '${job.error_code}' (no matching error boundary).`, { jobId: job.job_id, errorCode: job.error_code }, "serviceTaskFailure");
  }
  // Technical exhaustion → Hazard (terminal incident, never auto-compensation).
  // Settle the guarding timer first (gate 10: no stray alarm mid-incident).
  const settledTech = await settleBoundaryTimerCancel(env, graph, instanceId, inst.workspace_id, elementId, occ);
  if (typeof settledTech === "object") return { kind: "next", next: settledTech.converted };
  return createIncident(env, instanceId, elementId, job.attempt_count, "Service Task failed (technical retries exhausted).", { jobId: job.job_id }, "serviceTaskFailure");
}
