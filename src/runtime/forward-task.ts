// Forward Service Task as a durable pull wait (M3-L0 extraction, TASK-38).
//
// The forward service-task visit block lifted verbatim from engine.ts: job
// creation + DLQ arming, the durable wait/park, applied fast-forward, business-
// error routing, technical exhaustion, and the un-leasable-job DLQ termination.
// Behavior-frozen — step names, history event types, persisted shapes, and the
// poison/DLQ math are all unchanged.

import type { Env } from "../env";
import type { ExecutionGraph, GraphNode } from "../bpmn/graph";
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
  timerBoundaryFor,
  timerHasFired,
} from "./boundary-timer";
import { getTimer, timerIdFor } from "../persistence/timers";
import { dbBatch } from "../persistence/db";
import { countHistoryEventsOfType, historyStmt, latestScopeEntryOccurrence } from "../persistence/history";
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
import { loadInst, type RunStep, type WaitForEvent } from "./engine-shared";
import { nearestEnclosingTx, scopesOf } from "../bpmn/scope-tree";
import { createIncident, parkWaiting } from "./incidents";
import { resolveScope } from "./frontier";
import { branchHistoryTags, getToken, parseOverlay, readOverlay, rootTokenId, setTokenOverlayStmt, writeOverlay } from "../persistence/tokens";
import { drainScopeSubtree } from "./compensation";

/**
 * The error boundary hosted directly ON `hostId` that matches `errorCode`, if
 * any. Free error-boundary routing (M3-L2, TASK-42): an activity (or, since
 * M5-L1 Task 9, a scope) may carry many DISTINCT-`@errorCode` interrupting
 * boundaries plus at most one catch-all (validator-enforced), each targeting
 * ANY token-path node — no longer cancel-end-only. The matching precedence is:
 *   exact `@errorCode` → catch-all (`errorCode == null`) → null (→ caller climbs).
 * After validation a null `errorCode` UNAMBIGUOUSLY means catch-all (a coded
 * boundary with an empty/missing `@errorCode` is rejected at publish), so the
 * catch-all matches ANY business code including ones not declared as a
 * `<bpmn:error>`. Deterministic regardless of node-iteration order: an exact
 * match returns immediately; otherwise the (single) catch-all is the fallback.
 */
function matchErrorBoundaryOn(
  graph: ExecutionGraph,
  hostId: string,
  errorCode: string | null,
): { boundaryId: string; next: string } | null {
  let catchAll: { boundaryId: string; next: string } | null = null;
  for (const [bid, node] of Object.entries(graph.nodes)) {
    if (node.type !== "boundaryEvent" || node.boundaryKind !== "error" || node.attachedToRef !== hostId) continue;
    if (node.errorCode != null && node.errorCode === errorCode && node.next) return { boundaryId: bid, next: node.next };
    if (node.errorCode == null && node.next) catchAll = { boundaryId: bid, next: node.next };
  }
  return catchAll;
}

export interface ErrorCatchTarget {
  boundaryId: string;
  hostId: string;
  hostIsScope: boolean;
  next: string;
}

/**
 * Hierarchical error catch (M5-L1 spec §5.1): the attachment-chain walk — the
 * throwing element's own boundaries first, then each enclosing scope bottom-up;
 * per level exact `@errorCode` beats catch-all; the first level with a match
 * wins. Null → the caller Hazards (uncaught business error, no matching
 * boundary anywhere on the chain). Level-0 (own boundary on `elementId`) is
 * byte-identical to the pre-M5 `errorBoundaryTarget` behavior.
 */
export function errorCatchTarget(graph: ExecutionGraph, elementId: string, errorCode: string | null): ErrorCatchTarget | null {
  const own = matchErrorBoundaryOn(graph, elementId, errorCode);
  if (own) return { ...own, hostId: elementId, hostIsScope: false };
  const scopes = scopesOf(graph);
  for (let s = graph.nodes[elementId]?.scopeId ?? null; s != null; s = scopes[s]?.parentId ?? null) {
    const m = matchErrorBoundaryOn(graph, s, errorCode);
    if (m) return { ...m, hostId: s, hostIsScope: true };
  }
  return null;
}

export type ForwardOutcome = { kind: "next"; next: string } | { kind: "waiting" } | { kind: "incident" };

/**
 * Fast-forward predicate for a forward Service Task visit (design M2 §5): once
 * a job's terminal outcome has been APPLIED to the instance (output_applied=1,
 * set in the same dbBatch as the advance), the rewalk derives the successor
 * purely from graph + persisted job state — a completed job advances on
 * `node.next`; a business failure re-derives the SAME deterministic catch
 * target from the persisted error_code. Returns null when the visit still
 * needs driving (the frontier). Write-free EXCEPT the one self-healing case
 * inside: a scope-caught business failure whose post-batch drain/audit was
 * crashed away is re-drained here (idempotent, existence-guarded — see the
 * inline block).
 */
async function appliedForwardOutcome(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  node: GraphNode,
  job: JobRow | null,
): Promise<ForwardOutcome | null> {
  if (!job || job.output_applied !== 1) return null;
  if (job.status === "completed") return { kind: "next", next: node.next! };
  if (job.status === "failed" && job.error_code) {
    // Re-derivation (M5-L1 spec §5.1): deterministic because the graph is
    // immutable — the same attachment-chain walk always yields the same target.
    const target = errorCatchTarget(graph, elementId, job.error_code);
    if (target) {
      // Self-healing backstop for the scope-caught case: the applying path runs
      // the subtree drain + `scopeExited` audit AFTER its dbBatch commits (which
      // already flipped output_applied=1) — a crash in that window would
      // otherwise skip them FOREVER, since every later drive fast-forwards
      // through here, and unlike the beginCompensating precedent no future
      // worker poll would revisit (stranding live subtree tokens and wedging the
      // frontier barrier). The `scopeExited` row is the completion marker: both
      // writers order drain-then-audit, so row-exists ⇒ the drain finished. On
      // the steady state this costs ONE history read per rewalk of this visit.
      // Narrowest existence predicate available here: (instance, scope,
      // 'scopeExited') — this path has no reliable scope-exit occurrence (the
      // JOB's occurrence is the task's, not the scope's), so a LOOPED scope
      // that already exited abnormally once is not re-healed for a later
      // crashed exit; its first-exit drain semantics still hold.
      if (target.hostIsScope) {
        const audited = await countHistoryEventsOfType(env.DB, instanceId, target.hostId, "scopeExited");
        if (audited === 0) {
          await drainScopeSubtree(env, graph, instanceId, target.hostId); // idempotent retain-only
          const inst = await loadInst(env, instanceId);
          await historyStmt(env.DB, {
            workspaceId: inst.workspace_id,
            instanceId,
            elementId: target.hostId,
            type: "scopeExited",
            diagnostics: { scope: target.hostId, via: target.boundaryId, abnormal: true },
          }).run();
        }
      }
      return { kind: "next", next: target.next };
    }
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

  // Already applied → pure cursor move (no step; write-free except the guarded
  // self-healing re-drain of a crashed scope exit — see appliedForwardOutcome).
  const applied = await appliedForwardOutcome(env, instanceId, graph, elementId, node, job);
  if (applied) return applied;

  if (job?.status === "completed") {
    return runStep(`svc-apply:${tag}`, () => applyForwardCompletion(env, instanceId, graph, elementId, occ, node, job!, activeTokenId));
  }
  if (job?.status === "failed") {
    return runStep(`svc-fail:${tag}`, () => handleForwardFailure(env, instanceId, graph, elementId, occ, node, job!, activeTokenId));
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

  // Park: the instance resumes on the next drive (a /jobs/complete tickle in workflow
  // mode, or an inline re-drive in direct mode) once the job mutates in D1.
  await runStep(`svc-park:${tag}`, () => parkWaiting(env, instanceId, elementId, occ, "serviceTask"));
  return { kind: "waiting" };
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
      diagnostics: { elementType: "serviceTask", taskType, occurrence: occ, ...branchHistoryTags(activeTokenId) },
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
      diagnostics: { jobId, taskType, retryLimit: Math.max(1, node.retries ?? 1), activationExpiresAt, occurrence: occ, ...branchHistoryTags(activeTokenId) },
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
  const appliedAlready = await appliedForwardOutcome(env, instanceId, graph, elementId, node, live);
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
        diagnostics: { jobId: job.job_id, strikes: strike, mergedSize: payloadByteSize(merged), ...branchHistoryTags(activeTokenId) },
      }).run();
      // Like the DLQ jobActivationTimeout race, this poison terminal does NOT settle
      // the host's boundary timer (no decider claim) — it is left `armed` on a now-
      // frozen (`incident`) instance, harmlessly: since TASK-73 a due alarm on a
      // frozen instance with a TASK host RE-ARMS with a backoff (no decider claim,
      // no transition — recordSuppressedTimerFire's host dispatch) instead of
      // firing; a DONE (completed/cancelled/compensated) instance still drops the
      // alarm outright, and the host job being no longer created/locked plus the
      // operator /cancel sweep guard the remaining windows. After an operator
      // /retry the re-armed alarm fires the NORMAL batch with full host cleanup.
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
        diagnostics: { jobId: job.job_id, strike, mergedSize: payloadByteSize(merged), reason: "merged variables exceed the event payload limit", ...branchHistoryTags(activeTokenId) },
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
      diagnostics: { jobId: job.job_id, attempts: job.attempt_count, traceId: traceIdFor(instanceId), occurrence: occ, ...branchHistoryTags(activeTokenId) },
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

  // Ledger write atomic with advance — for completed compensatable steps with a
  // TRANSACTION ANCESTOR (M5-L1 spec §3.3: the gate is ancestry, not the immediate
  // scope). scope_id stays the IMMEDIATE scope id — the subtree cursor depends on it.
  if (nearestEnclosingTx(graph, node.scopeId ?? null) != null) {
    const wiring = graph.compensations?.[elementId] ?? graph.transactions?.[node.scopeId!]?.compensations?.[elementId];
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
  activeTokenId?: string,
): Promise<ForwardOutcome> {
  // Route-once guard (idempotent step body): a re-run after the business-error
  // batch committed fast-forwards to the recorded boundary target instead of
  // duplicating businessErrorCaught + rewriting the cursor (and self-heals a
  // crashed-away scope drain/audit — see appliedForwardOutcome).
  const live = await getForwardJob(env.DB, instanceId, elementId, occ);
  const appliedAlready = await appliedForwardOutcome(env, instanceId, graph, elementId, node, live);
  if (appliedAlready) return appliedAlready;

  const inst = await loadInst(env, instanceId);
  if (job.error_code) {
    // Business error → route to the matching error boundary's target via the
    // hierarchical attachment-chain walk (M5-L1 spec §5.1): the throwing
    // element's own boundaries first, then each enclosing scope bottom-up (any
    // token-path node; exact @errorCode → catch-all per level). The token then
    // walks forward like any other: it triggers compensation only if it REACHES
    // a cancel end, otherwise the saga continues with the ledger intact.
    const target = errorCatchTarget(graph, elementId, job.error_code);
    if (target) {
      const now = nowIso();
      // M5-L1 (Task 11): the catching scope's OWN occurrence — needed only when the
      // catch climbed to a scope (hostIsScope) to key that scope's boundary-timer
      // disarm. `elementId`'s own occurrence (`occ`) is NOT the scope's occurrence.
      const scopeOcc = target.hostIsScope ? await latestScopeEntryOccurrence(env.DB, instanceId, target.hostId) : 0;
      const stmts: D1PreparedStatement[] = [
        historyStmt(env.DB, {
          workspaceId: inst.workspace_id,
          instanceId,
          elementId,
          type: "businessErrorCaught",
          diagnostics: {
            jobId: job.job_id,
            errorCode: job.error_code,
            boundaryTarget: target.next,
            occurrence: occ,
            ...branchHistoryTags(activeTokenId),
          },
        }),
        applyTransitionStmt(env.DB, { instanceId, currentElementId: target.next, status: "running", now }),
        // Atomic with the route: the rewalk fast-forwards this visit by
        // re-deriving the same deterministic target from the persisted error_code.
        markFailedJobHandledStmt(env.DB, job.job_id, now),
      ];
      // M3-L3: settle the guarding timer 'cancelled' atomically with the error
      // route; on a decider conflict the timer FIRED first → convert to its path.
      const cancelSettle = buildBoundaryCancelSettle(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: elementId, occ, now });
      if (cancelSettle) stmts.push(...cancelSettle.stmts);
      // M5-L1 (Task 11): the catching SCOPE may ALSO carry its own boundary timer —
      // disarm it atomically with this abnormal exit too (Hazard-vs-Cancel, spec §5.3).
      const scopeCancelSettle = target.hostIsScope
        ? buildBoundaryCancelSettle(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: target.hostId, occ: scopeOcc, now })
        : null;
      if (scopeCancelSettle) stmts.push(...scopeCancelSettle.stmts);
      try {
        await dbBatch(env.DB, stmts);
      } catch (err) {
        if (isUniqueConstraintViolation(err)) {
          const converted = await convertOnFire(env, graph, instanceId, elementId, occ);
          if (converted) return { kind: "next", next: converted };
          if (target.hostIsScope) {
            const scopeConverted = await convertOnFire(env, graph, instanceId, target.hostId, scopeOcc);
            if (scopeConverted) return { kind: "next", next: scopeConverted };
          }
        }
        throw err;
      }
      // M5-L1 Task 9: the catch host IS a scope (climbed past `elementId`'s own
      // boundaries) → the abnormal exit drains every live token in that scope's
      // subtree (idempotent retain-only, Task 8) and is audited. Not folded into
      // the batch above — `drainScopeSubtree` issues its own dbBatch(es) per live
      // token, and is safe to re-run on a step retry (retain-only, INSERT OR
      // IGNORE + status-guarded flips). Post-batch drain+audit: a crash landing
      // between the batch commit and here is healed by appliedForwardOutcome's
      // idempotent, existence-guarded re-drain on the next drive (the batch set
      // output_applied=1, so every later drive re-derives through that path).
      if (target.hostIsScope) {
        await drainScopeSubtree(env, graph, instanceId, target.hostId);
        await historyStmt(env.DB, {
          workspaceId: inst.workspace_id,
          instanceId,
          elementId: target.hostId,
          type: "scopeExited",
          diagnostics: { scope: target.hostId, via: target.boundaryId, abnormal: true, occurrence: scopeOcc },
        }).run();
      }
      return { kind: "next", next: target.next };
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
