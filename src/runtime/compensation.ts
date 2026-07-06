// Reverse-order compensation pass (M3-L0 extraction, TASK-38).
//
// The saga compensation pass lifted verbatim from engine.ts: cancel-end entry
// (beginCompensating), the resumable reverse walk over the ledger
// (settleAfterCompensation → runCompensation), per-step compensation jobs, and
// the saga-failed terminal settle. Behavior-frozen — step names, history event
// types, ledger transitions, and the compensation wait cap are unchanged.

import type { Env } from "../env";
import type { ExecutionGraph } from "../bpmn/graph";
import { isTerminalInstanceStatus, newId, nowIso, parseJson, traceIdFor, type JsonObject } from "../util";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import {
  advanceIncidentResolutionStmt,
  applyTransitionStmt,
  createJobStmt,
  getCompensationJob,
  getForwardJobByElement,
  getInstanceRow,
  incidentStmt,
  listForwardJobsForInstance,
  type JobRow,
} from "../persistence/instances";
import { getChildInstanceForVisit, listChildrenByElement } from "../persistence/child-instances";
import {
  attachCompensationJobStmt,
  filterLineageQuiesced,
  getSagaStep,
  insertSagaStepStmt,
  selectSubtreeStepsForCompensation,
  updateCompensationStatusStmt,
  type SagaStepView,
} from "../persistence/saga";
import { abandonJobOnTimerFireStmt, listInFlightForwardJobs } from "../persistence/jobs";
import { listLiveTokens, parseTokenId, setTokenStatusStmt, type TokenRow } from "../persistence/tokens";
import { eligibleCommittedLocalScopeIds, scopesOf, subtreeScopeIds } from "../bpmn/scope-tree";
import { armCohortLeaseExpiryTerminators } from "./forward-task";
import { loadInst, type RunStep, type WaitForEvent, type DriveResult, type SettleResult } from "./engine-shared";
import { WAKE_TYPE, wakeBackstop } from "./wake";
import { buildBoundaryCancelSettle, convertOnFire, isUniqueConstraintViolation, settleDrainedScopeTimer } from "./boundary-timer";
import { listTimersForInstance } from "../persistence/timers";
import { releaseSubscriptionsInScopeSubtree } from "./instance-release";
import { cancelChildCascade, cancelChildrenInSubtree } from "./child-cascade";

/**
 * The failure-path target of the cancel boundary attached to transaction `scopeId`.
 * Exported so the engine's cancelled-tx rewalk fast-forward reuses this scan
 * instead of duplicating it (Task 8, engine driveLeaf).
 */
export function cancelBoundaryTarget(graph: ExecutionGraph, scopeId: string): string | null {
  for (const [, node] of Object.entries(graph.nodes)) {
    if (node.type === "boundaryEvent" && node.boundaryKind === "cancel" && node.attachedToRef === scopeId) {
      return node.next ?? null;
    }
  }
  return null;
}

/** Outcome of `beginCompensating` (M5-L1 Task 11): the normal case starts the
 *  reverse pass; `convertedToTimer` means the transaction's OWN boundary timer
 *  raced the cancel end and fired FIRST (Hazard beat Cancel) — the caller must
 *  take the timer's boundary path instead of compensating. */
export type BeginCompensatingOutcome = { kind: "compensating" } | { kind: "convertedToTimer"; next: string };

export async function beginCompensating(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  scopeId: string,
  cancelEndId: string,
  occ: number,
): Promise<BeginCompensatingOutcome> {
  const inst = await loadInst(env, instanceId);
  // Idempotent re-run: once the cancel transition committed the reverse pass
  // owns the instance — never duplicate transactionCancelled or regress status.
  if (inst.status === "compensating" || isTerminalInstanceStatus(inst.status)) return { kind: "compensating" };
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [
    // MARKER: `occurrence` is the CANCELLED TRANSACTION's occurrence (Task 8) — the
    // engine's driveLeaf fast-forward reads (transaction id, its occurrence) to skip
    // re-entering an occurrence that already cancelled+settled on a later rewalk. A
    // re-entering (looped) tx cancels its LATEST entry, so occ != the cancel-end's
    // own occurrence; the caller derives the tx occurrence and passes it here.
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: scopeId, type: "transactionCancelled", diagnostics: { transaction: scopeId, via: cancelEndId, traceId: traceIdFor(instanceId), occurrence: occ } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: cancelEndId, status: "compensating", now }),
  ];
  // M5-L1 (Task 11): disarm the transaction's own boundary timer (if any)
  // ATOMICALLY with the cancel — this IS a scope exit (via the nested cancel end).
  const cancelSettle = buildBoundaryCancelSettle(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: scopeId, occ, now });
  if (cancelSettle) stmts.push(...cancelSettle.stmts);
  try {
    await dbBatch(env.DB, stmts);
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      // The tx's own timer fired first (Hazard beat Cancel) — its fire batch
      // already moved current_element_id to ITS boundary target; do NOT begin
      // compensating (no transactionCancelled/compensating transition landed).
      const converted = await convertOnFire(env, graph, instanceId, scopeId, occ);
      if (converted) return { kind: "convertedToTimer", next: converted };
    }
    throw err;
  }
  // M4-L5 (design §8.2): arm a per-token lease-expiry terminator for every in-flight
  // cohort forward job so the quiescence barrier drains without a future worker poll.
  // No-op for single-token instances (no locked forward job survives to a cancel-end).
  await armCohortLeaseExpiryTerminators(env, instanceId);
  return { kind: "compensating" };
}

/**
 * Run (or resume) the reverse pass for compensation root `rootScopeId` (null = the
 * process root / operator cancel), then settle. A NESTED root (the cancelled tx has
 * a parent scope) settles NON-terminally — the instance continues on the cancel
 * boundary's failure path (`{status:"continue"}`); a top-level / process root settles
 * the saga-failed terminal.
 */
export async function settleAfterCompensation(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  rootScopeId: string | null,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
): Promise<SettleResult> {
  const result = await runCompensation(env, instanceId, graph, rootScopeId, runStep, waitFor);
  if (result === "waiting") return { status: "waiting" };
  if (result === "failed") return { status: "incident" }; // compensationFailed terminal (operator-resumable)
  const target = rootScopeId != null ? cancelBoundaryTarget(graph, rootScopeId) : null;
  // Nested root = the cancelled tx has ANY parent scope (spec §4.3 refined): after
  // its own subtree settles the instance CONTINUES on the cancel boundary's target.
  const isNestedRoot = rootScopeId != null && (scopesOf(graph)[rootScopeId]?.parentId ?? null) != null;
  await runStep(`settle:${rootScopeId ?? "process"}`, () => settleSagaCompensated(env, instanceId, graph, rootScopeId, target, isNestedRoot));
  return isNestedRoot && target ? { status: "continue", next: target } : { status: "completed" };
}

type CompResult = "compensated" | "waiting" | "failed";

async function runCompensation(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  rootScopeId: string | null,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
): Promise<CompResult> {
  // Re-derive the cursor from the ledger each pass (crash-safe, resumable).
  // With loops each iteration is its own ledger row (occurrence-keyed), so the
  // reverse pass compensates every iteration separately with zero algorithm
  // change; compensation jobs + step names inherit the forward occurrence.
  //
  // M5-L1 (spec §3.4 / §4): the cursor is ROOT-RELATIVE. `subtree` is every scope
  // enclosed by the compensation root (inclusive; ALL scopes for the process root);
  // `eligibleCommitted` is the subset whose committedLocal rows are still eligible
  // (a nested tx committed strictly BELOW the root). The barrier + straggler scan
  // are filtered to subtree MEMBERSHIP, not a single scope (§4.2). The straggler
  // scan is ALWAYS on (spec §4.1 un-gates the old isRegion guard) — its no-op fast
  // path is "zero live tokens in the cohort".
  const subtree = subtreeScopeIds(graph, rootScopeId);
  const eligibleCommitted = eligibleCommittedLocalScopeIds(graph, rootScopeId);
  const inSubtree = (elementId: string): boolean => {
    const s = graph.nodes[elementId]?.scopeId ?? null;
    return s == null ? rootScopeId == null : subtree.includes(s);
  };
  // Single-wake the reverse pass (TASK-54): `compWakeSeq` mirrors the forward loop's
  // `wakeSeq` and RESETS to 0 on each runCompensation invocation. Replay-safety does
  // NOT rest on the wake name selecting a step — the wake is a pure TICKLE (its return
  // is discarded, a timeout is swallowed); which step is compensated is decided solely
  // by the ledger (`eligible[0]`, the highest-seq still-pending step). That selection is
  // replay-deterministic: the saga_steps ledger is append-only with monotonic per-scope
  // `seq`, `selectScopeStepsForCompensation` excludes already-`compensated` rows and
  // orders `seq DESC`, so the pending set only shrinks across replays. A reused
  // `comp-wake#k` name returns its cached event immediately (no re-suspend); the consumed
  // namespace is finite (≤ #comp steps), so `compWakeSeq` always reaches a fresh name → a
  // real suspend → the worker completes the job → the re-read advances the cursor. The
  // `comp-wake` prefix is distinct from the forward `wake#k`, so a forward→cancel→
  // compensate drive never collides step names.
  let compWakeSeq = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Straggler scan (design §8.3, spec §4.1/§4.2): before the reverse pass, catch
    // stragglers + drain terminal cohort tokens across the SUBTREE cohort — a token
    // whose forward job COMPLETED (possibly after cancel) is ledgered (INSERT OR
    // IGNORE) + consumed; a FAILED one is discarded. Always on; a single-token
    // instance simply has one (or zero) live token in the cohort.
    await ledgerStragglers(env, instanceId, graph, rootScopeId, subtree);

    // GAP B: the process-root pass (rootScopeId == null) also reverses ROOT-SCOPED
    // steps (scope_id = ''), so a scope-less parent's callActivity child actually
    // reverses instead of being stranded. Agrees with handleCancelInstance's count.
    const steps = await selectSubtreeStepsForCompensation(env.DB, instanceId, subtree, eligibleCommitted, rootScopeId == null);
    // Live cohort tokens, filtered to the compensation subtree (spec §4.2).
    // filterLineageQuiesced is a no-op for the single-token path (token_id NULL
    // steps are never blocked).
    const live = (await listLiveTokens(env.DB, instanceId)).filter((t) => inSubtree(t.position_element_id));

    // Quiescence barrier (design §8.3): settle the terminal ONLY when no scope step
    // still needs compensation AND no cohort token is live. If the ledger is drained
    // but a token is still in flight, park (`waiting`) on the terminators so a late
    // straggler is always ledgered + compensated before the terminal transition.
    if (steps.length === 0) return live.length === 0 ? "compensated" : "waiting";

    // Lineage-quiescence-ordered reverse (design §8.4 / Principle VI): a step is
    // eligible only once its branch lineage has no live descendant — so a causally-
    // downstream straggler is compensated before its predecessor. Cross-branch order
    // is unconstrained (concurrent branches have no happens-before relation).
    const eligible = filterLineageQuiesced(steps, live);
    if (eligible.length === 0) return "waiting"; // every remaining step blocked by a live descendant → park
    const step = eligible[0]!; // highest seq among the eligible (selectScope orders seq DESC)
    // M5-L3 (Task 10): the reverse-pass step names gain `@${iteration}` for i > 0
    // (byte-identical for the pre-L3 iteration-0 path — the same discriminator the
    // compensation-job idempotency key uses). Without it the N per-iteration MI child
    // steps — all sharing (element, occurrence) — would collide their `comp-child:` /
    // `comp-create:` / `comp-done:` step names and memoize away sibling iterations'
    // compensation on a Workflow replay.
    const ctag = `${step.elementId}#${step.occurrence}` + (step.iterationIndex > 0 ? `@${step.iterationIndex}` : "");

    if (step.childInstanceId) {
      // M5-L2 (design §5): a child-instance step — compensate by driving the
      // child's OWN reverse pass over its retained ledger, never a compensation
      // job. Every runStep issuance below is gated on a child-status read taken
      // OUTSIDE the step (memoization safety: a memoized result is always
      // final); the child's reverse terminal tickles the parent (comp-wake).
      const child = await getInstanceRow(env.DB, step.childInstanceId);
      if (!child) {
        // Defensive: no child instance = nothing to undo — close the step.
        await runStep(`comp-done:${ctag}`, () => markStepCompensated(env, instanceId, step));
        continue;
      }
      if (child.status === "compensated") {
        await runStep(`comp-done:${ctag}`, () => markStepCompensated(env, instanceId, step));
        continue;
      }
      if (child.status === "compensationFailed") {
        // The child's failed reverse surfaces as the PARENT's OWN
        // compensationFailure incident on the callActivity element.
        await runStep(`comp-fail:${ctag}`, () => markStepCompensationFailed(env, instanceId, step));
        return "failed";
      }
      if (child.status === "completed" || child.status === "cancelled") {
        // Dynamic import: call-activity.ts imports compensation.ts
        // (drainScopeSubtree), so a static import here would cycle — the
        // forward-task.ts resumeInline precedent.
        const { beginChildCompensation } = await import("./call-activity");
        await runStep(`comp-child:${ctag}`, () => beginChildCompensation(env, instanceId, step));
        // Re-read the child on the next pass — beginChildCompensation always
        // moves the child out of {completed, cancelled} (the no-op shortcut may
        // have settled it `compensated` synchronously), so this cannot spin.
        continue;
      }
      // Child 'compensating' (or a late 'incident' inside its reverse) → park on
      // the single wake; the child's terminal tickles the parent (notify + the
      // DO-alarm self-heal), and the wake timeout self-heals a lost tickle.
      if (!waitFor) return "waiting";
      const childTimeout = await wakeBackstop(env, instanceId);
      try {
        await waitFor({ name: `comp-wake#${compWakeSeq}`, workflowEventType: WAKE_TYPE, timeout: childTimeout });
      } catch {
        /* lost/expired wake → self-heal: fall through to re-read */
      }
      compWakeSeq += 1;
      continue;
    }

    let comp = await getCompensationJob(env.DB, instanceId, step.elementId, step.occurrence, step.iterationIndex);
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
    // Workflow mode (TASK-54): the comp job is created but not yet terminal — issue ONE
    // replay-stable bpmn_wake (sequential `comp-wake#k`) and re-read after the worker's
    // /jobs/complete tickles the Workflow. Mirrors the forward loop's issueWake; without
    // this the reverse pass busy-spins on the created job (it never suspends so the worker
    // can never complete it). A wake TIMEOUT (lost tickle) self-heals: catch → re-read.
    const timeout = await wakeBackstop(env, instanceId);
    try {
      await waitFor({ name: `comp-wake#${compWakeSeq}`, workflowEventType: WAKE_TYPE, timeout });
    } catch {
      /* lost/expired wake → self-heal: fall through to re-read the ledger */
    }
    compWakeSeq += 1;
    // loop re-reads the (now terminal) comp job
  }
}

/**
 * Cohort straggler scan (design §8.1/§8.3) — region instances only. For each LIVE
 * token positioned inside the compensating scope, settle it against its forward
 * job so the quiescence barrier can drain and no executed side-effect leaks:
 *   - forward job COMPLETED → ledger it (INSERT OR IGNORE, carrying the producing
 *     token + the job's occurrence/captured I/O — a no-op when the forward path
 *     already wrote the row) and CONSUME the token. This catches a straggler that
 *     completed AFTER cancel began, and an `arrivedAtJoin` token whose step was
 *     ledgered upstream (the half-satisfied join never fires).
 *   - forward job FAILED → DISCARD the token (a failed forward job executed no
 *     compensatable side-effect; the per-token terminator may have just failed it).
 *   - no forward job at the position (a gateway/event/pure-wait) → DISCARD (owes no
 *     compensation), so the barrier is never wedged by a non-compensatable token.
 *   - forward job still `created`/`locked` (in-flight) → LEAVE the token live; the
 *     per-token terminator (DLQ / lease-expiry, L5.3) drives it terminal and the
 *     next pass re-scans.
 *
 * Single-transaction scope assumption: branch tokens are confined to one region per
 * the SESE validator, so "positioned inside `scopeId`" (the position node's scopeId)
 * is the cohort; a token's region branch is a single-entry/single-exit sub-region.
 */
async function ledgerStragglers(env: Env, instanceId: string, graph: ExecutionGraph, rootScopeId: string | null, subtree: string[]): Promise<void> {
  const live = await listLiveTokens(env.DB, instanceId);
  for (const t of live) {
    const posScope = graph.nodes[t.position_element_id]?.scopeId ?? null;
    if (posScope == null ? rootScopeId != null : !subtree.includes(posScope)) continue; // not in this cohort
    const now = nowIso();
    // M5-L2 (Task 9): a token parked ON a callActivity carries a CHILD INSTANCE,
    // not a forward job — retain it as a child ledger step so the reverse-pass
    // dispatch drives the child's own reverse (design §4 "Cancel path": a child
    // interrupted mid-flight still compensates exactly its committed steps).
    if (graph.nodes[t.position_element_id]?.type === "callActivity") {
      await retainCallStraggler(env, graph, instanceId, t, now);
      continue;
    }
    const job = await resolveForwardJobForToken(env, graph, instanceId, t.position_element_id);
    if (job && job.status === "completed") {
      await dbBatch(env.DB, await retainStragglerStmts(env, graph, instanceId, t, job, now));
    } else if (job && job.status === "failed") {
      await dbBatch(env.DB, [setTokenStatusStmt(env.DB, t.token_id, "discarded", now)]);
    } else if (!job) {
      await dbBatch(env.DB, [setTokenStatusStmt(env.DB, t.token_id, "discarded", now)]);
    }
    // else: job created/locked (in-flight) → leave live for the terminator.
  }
}

/**
 * Retain a live token parked on a callActivity (M5-L2 Task 9): the visit's child
 * was interrupted by the cancel (an operator /cancel already cascade-cancelled it;
 * a tx cancel-end may reach a still-live one — cascade-cancel it here, the same
 * Hazard interrupt, idempotent via cancelChildCascade's own short-circuit), then
 * ledger the child step (INSERT OR IGNORE keyed by element + occurrence, exactly
 * like a forward straggler) and CONSUME the token. The reverse-pass dispatch then
 * compensates it by driving the child's own reverse pass over its retained
 * committedLocal steps. A token whose invoke never bound a child owes nothing —
 * discard (mirrors the no-job branch).
 */
async function retainCallStraggler(env: Env, graph: ExecutionGraph, instanceId: string, t: TokenRow, now: string): Promise<void> {
  const pos = t.position_element_id;
  // M5-L3 (design §5): a live token IS an MI iteration token (`mi#i`) → retain ITS
  // OWN iteration's child row (keyed `(pos, activation, i)`), never `rows[last]`.
  // A non-MI (or M4-branch) token retains the LATEST visit (the byte-identical L2
  // path). In v1 the MI-subProcess body whitelist forbids a nested callActivity, so
  // an `mi#i` token never actually parks on a callActivity — this is the forward-
  // compatible, iteration-aware selection the design mandates.
  const parsed = parseTokenId(t.token_id);
  const miIter = parsed.kind === "branch" ? /^mi#(\d+)$/.exec(parsed.branchFlowId) : null;
  let row;
  if (parsed.kind === "branch" && miIter) {
    row = await getChildInstanceForVisit(env.DB, instanceId, pos, parsed.activation, Number(miIter[1]));
  } else {
    const rows = await listChildrenByElement(env.DB, instanceId, pos);
    row = rows[rows.length - 1]; // the LATEST visit — the one this live token parked on
  }
  if (!row) {
    await dbBatch(env.DB, [setTokenStatusStmt(env.DB, t.token_id, "discarded", now)]);
    return;
  }
  // Never wait on a running child inside the reverse pass — interrupt it (Hazard,
  // Task 8 semantics; ledger retained). No-op when the cancel cascade already ran.
  await cancelChildCascade(env, row.child_instance_id);
  // An ERRORED child owes no parent-driven reverse (it routes like a worker
  // business error — `applyChildErrored` ledgers nothing either), and the reverse
  // dispatch has no entry for it (`beginChildCompensation` CAS-es only
  // {completed, cancelled}): ledger it `notRequired` so the audit row exists but
  // the reverse pass never parks on it. Every other post-cascade status is
  // dispatchable: completed/cancelled → the child's own reverse; compensated /
  // compensationFailed → closed/failed directly.
  const child = await getInstanceRow(env.DB, row.child_instance_id);
  const stmts: D1PreparedStatement[] = [];
  // Iteration-aware dedup (design §5): key by the child row's OWN iteration index
  // (0 for the non-MI path — byte-identical).
  if (!(await getSagaStep(env.DB, instanceId, pos, row.occurrence, row.iteration_index))) {
    stmts.push(
      insertSagaStepStmt(env.DB, {
        stepId: newId("step"),
        instanceId,
        scopeId: graph.nodes[pos]?.scopeId ?? "",
        elementId: pos,
        // forward_job_id is NOT NULL — a child step carries the "" sentinel
        // (mapSagaStep folds it back to null), same as applyChildTerminal.
        forwardJobId: "",
        capturedInput: {},
        capturedOutput: null,
        compensationElementId: null,
        compensationTaskType: null,
        compensationStatus: child?.status === "errored" ? "notRequired" : "pending",
        traceId: traceIdFor(instanceId),
        occurrence: row.occurrence,
        tokenId: t.token_id,
        childInstanceId: row.child_instance_id,
        iterationIndex: row.iteration_index,
        now,
      }),
    );
  }
  stmts.push(setTokenStatusStmt(env.DB, t.token_id, "consumed", now));
  await dbBatch(env.DB, stmts);
}

/**
 * Resolve the forward job "belonging to" a live token positioned at
 * `positionElementId` (M5-L1 Task 12 fix, spec §10.5). A region branch token's
 * `execution_tokens.position_element_id` is a ONE-TIME write at fan-out (the
 * split's immediate flow target — `regions-runtime.ts`'s `fanOutSplit`); it is
 * NEVER advanced as the branch descends through non-split/join hops, because a
 * region graph's frontier read-model is owned by the split/join DFS, not by the
 * per-step engine walk (`runInstanceInner` explicitly skips `syncFrontierReadModel`
 * when `graph.regions` is set). A branch that enters a plain (non-transaction)
 * subProcess before its first task/wait therefore leaves the token's recorded
 * position on the subProcess CONTAINER, which never gets its own
 * `service_task_jobs` row — an exact element_id match then finds nothing, and a
 * naive caller would wrongly treat a still-in-flight branch as "owes no
 * compensation". Fall back to a scope-subtree search when the position names a
 * scope container (a subProcess/transaction): branch tokens are SESE-confined
 * (the M4 region validator), so at most one non-compensation forward job is live
 * anywhere under that container's subtree at a time.
 */
async function resolveForwardJobForToken(env: Env, graph: ExecutionGraph, instanceId: string, positionElementId: string): Promise<JobRow | null> {
  const direct = await getForwardJobByElement(env.DB, instanceId, positionElementId);
  if (direct) return direct;
  if (!scopesOf(graph)[positionElementId]) return null; // not a scope container — genuinely no job here
  const containerSubtree = new Set(subtreeScopeIds(graph, positionElementId));
  const jobs = await listForwardJobsForInstance(env.DB, instanceId);
  return jobs.find((j) => containerSubtree.has(graph.nodes[j.element_id]?.scopeId ?? "")) ?? null;
}

/**
 * The shared ledger-retain block (Task 8): a token whose forward job COMPLETED is
 * ledgered (INSERT OR IGNORE, carrying the producing token + the job's occurrence /
 * captured I/O — a no-op when the forward path already wrote the row) and CONSUMED.
 * Used by BOTH the straggler scan (which then compensates it) and `drainScopeSubtree`
 * (retention only). Kept in one place so the two callers never drift.
 *
 * `pos` is the JOB's own element id (Task 12 fix), not the token's recorded
 * position — the two can diverge (see `resolveForwardJobForToken`) whenever the
 * live token's position landed on a container several hops above the job that
 * actually ran; the ledger row must describe what ran, so it always wins.
 */
async function retainStragglerStmts(
  env: Env,
  graph: ExecutionGraph,
  instanceId: string,
  t: TokenRow,
  job: JobRow,
  now: string,
): Promise<D1PreparedStatement[]> {
  const pos = job.element_id;
  const scope = graph.nodes[pos]?.scopeId ?? "";
  const stmts: D1PreparedStatement[] = [];
  // M5-L3: carry the JOB's own iteration through the ledger key — a straggler on an
  // MI-body forward job retains a per-iteration step (byte-identical for the pre-L3
  // iteration-0 path).
  if (!(await getSagaStep(env.DB, instanceId, pos, job.occurrence, job.iteration_index))) {
    const wiring = graph.compensations?.[pos] ?? graph.transactions?.[scope]?.compensations?.[pos];
    const handlerNode = wiring ? graph.nodes[wiring.handlerId] : undefined;
    stmts.push(
      insertSagaStepStmt(env.DB, {
        stepId: newId("step"),
        instanceId,
        scopeId: scope,
        elementId: pos,
        forwardJobId: job.job_id,
        capturedInput: parseJson<JsonObject>(job.input_variables, {}),
        capturedOutput: job.output_variables ? parseJson<JsonObject>(job.output_variables, {}) : null,
        compensationElementId: wiring?.handlerId ?? null,
        compensationTaskType: handlerNode?.taskType ?? null,
        compensationStatus: wiring ? "pending" : "notRequired",
        traceId: traceIdFor(instanceId),
        occurrence: job.occurrence,
        tokenId: t.token_id,
        iterationIndex: job.iteration_index,
        now,
      }),
    );
  }
  stmts.push(setTokenStatusStmt(env.DB, t.token_id, "consumed", now));
  return stmts;
}

/**
 * Phase-1 interrupt/drain of a scope subtree (spec §4.3.1 / §5.3.1): settle every
 * live token positioned in the subtree — completed forward job → ledger (retained)
 * + consume; created/locked → abandon the job (a late complete then no-ops) +
 * discard; failed / no job → discard. Idempotent (INSERT OR IGNORE + status-guarded
 * flips). Unlike the straggler scan this NEVER creates compensation work — it is
 * retention only, used by Tasks 9/11 for non-cancel scope exits.
 *
 * Also releases (TASK-72, M5-L1 follow-up, PR #4 review finding #3): any ACTIVE
 * message subscription — and its correlation-broker key — held by a receiveTask
 * (or message intermediateCatchEvent) wait positioned in the subtree, so a drained
 * wait never strands a broker key until the 1-hour buffered-message TTL.
 */
export async function drainScopeSubtree(env: Env, graph: ExecutionGraph, instanceId: string, rootScopeId: string | null): Promise<void> {
  const subtree = subtreeScopeIds(graph, rootScopeId);
  const live = await listLiveTokens(env.DB, instanceId);
  for (const t of live) {
    const posScope = graph.nodes[t.position_element_id]?.scopeId ?? null;
    if (posScope == null ? rootScopeId != null : !subtree.includes(posScope)) continue;
    const now = nowIso();
    // M5-L2 (GAP A): a token parked ON a callActivity carries a CHILD INSTANCE,
    // not a forward job — the generic no-job branch below would silently discard
    // it, leaving the (Hazard-cancelled) child invisible to any LATER reverse
    // pass over an enclosing transaction. Retain it exactly like the straggler
    // scan does: cascade-cancel the still-running child, ledger the child step
    // (INSERT OR IGNORE), consume the token. Retention only — no compensation
    // starts here; the row waits for an enclosing reverse pass, same as a
    // completed worker step retained by this drain.
    if (graph.nodes[t.position_element_id]?.type === "callActivity") {
      await retainCallStraggler(env, graph, instanceId, t, now);
      continue;
    }
    const job = await resolveForwardJobForToken(env, graph, instanceId, t.position_element_id);
    if (job && job.status === "completed") {
      await dbBatch(env.DB, await retainStragglerStmts(env, graph, instanceId, t, job, now));
    } else if (job && (job.status === "created" || job.status === "locked")) {
      // abandonJobOnTimerFireStmt: created/locked → failed (a late worker callback no-ops).
      await dbBatch(env.DB, [abandonJobOnTimerFireStmt(env.DB, job.job_id, now), setTokenStatusStmt(env.DB, t.token_id, "discarded", now)]);
    } else {
      await dbBatch(env.DB, [setTokenStatusStmt(env.DB, t.token_id, "discarded", now)]);
    }
  }
  // TASK-72: release any active receiveTask/message-catch subscription (+ broker
  // key) still held anywhere in the drained subtree. A discarded token's own wait
  // never resolves its subscription on the forward path, so without this the
  // broker key would sit registered until the 1-hour TTL even though the instance
  // has moved on. Best-effort per subscription (mirrors the whole-instance release).
  await releaseSubscriptionsInScopeSubtree(env, graph, instanceId, rootScopeId, nowIso());
  // TASK-73: abandon any IN-FLIGHT (created|locked) FORWARD job whose element lives
  // in the drained subtree. The per-token loop above only reaches jobs carried by a
  // LIVE token; the single-token (non-region) walk persists no token rows, so a job
  // left `created`/`locked` inside a scope drained on a FAST-FORWARD path — e.g. an
  // inner task's job re-created by an operator /retry whose overdue deadline had been
  // recorded suppressed (fireTimer's frozen-record branch) — would otherwise stay
  // leasable after the scope exit. Abandoning it (created/locked → failed, lock
  // cleared) makes a late worker callback a no-op. Idempotent (status-guarded;
  // already-failed → 0 rows) and retention-only: `is_compensation=0` excludes the
  // reverse pass, and a completed/ledgered job is never touched. Same subtree
  // predicate as the token loop (`scopeId ∈ subtree`, null = the process root).
  for (const job of await listInFlightForwardJobs(env.DB, instanceId)) {
    const jobScope = graph.nodes[job.element_id]?.scopeId ?? null;
    if (jobScope == null ? rootScopeId != null : !subtree.includes(jobScope)) continue;
    await abandonJobOnTimerFireStmt(env.DB, job.job_id, nowIso()).run();
  }
  // M5-L1 Task 11 review-fix: this drain tears down the WHOLE subtree — every
  // DESCENDANT scope (strictly inside `rootScopeId`) is gone too, so its OWN armed
  // boundary timer must be settled `cancelled`. The exiting root scope's own timer is
  // settled ATOMICALLY at its exit site (commit / exitScope / cancel / error-catch),
  // so it is EXCLUDED here (a redundant settle would only PK-conflict). Idempotent:
  // a re-run (Workflow step retry / self-heal) re-reads the now-settled timers and
  // skips them; see `settleDrainedScopeTimer` for the fired-first race semantics.
  const descendants = new Set(subtree.filter((id) => id !== rootScopeId));
  if (descendants.size > 0) {
    const inst = await loadInst(env, instanceId);
    for (const timer of await listTimersForInstance(env.DB, instanceId)) {
      if (timer.kind !== "boundary" || timer.status !== "armed") continue;
      // DELIBERATE: `descendants` holds SCOPE ids only, so TASK-hosted boundary
      // timers (serviceTask/receiveTask hosts) inside the subtree are NOT settled
      // here — their fire plans already no-op via the job/subscription status
      // guards (the drain above abandoned the job / discarded the token), and a
      // redundant settle would race the alarm on the decider PK for no benefit.
      // Do not "fix" this by widening the filter to task hosts.
      if (!timer.attachedToRef || !descendants.has(timer.attachedToRef)) continue;
      await settleDrainedScopeTimer(env, instanceId, inst.workspace_id, timer);
    }
  }
  // M5-L2 (Task 8): cascade-cancel every non-terminal callActivity CHILD invoked
  // from inside the drained subtree — a scope drain discards the parent's own
  // live token at call1 (no forward job to abandon there, see
  // `resolveForwardJobForToken`), but the CHILD's own Workflow keeps running
  // unless explicitly cancelled. Idempotent (cancelChildCascade's own
  // terminal/compensating short-circuit) — safe to re-run on a step retry.
  await cancelChildrenInSubtree(env, graph, instanceId, rootScopeId);
}

async function createCompensationJob(env: Env, instanceId: string, graph: ExecutionGraph, step: SagaStepView): Promise<JobRow> {
  // Idempotent re-run (Workflow step retry after a committed batch).
  const existing = await getCompensationJob(env.DB, instanceId, step.elementId, step.occurrence, step.iterationIndex);
  if (existing) return existing;

  const inst = await loadInst(env, instanceId);
  const handlerNode = step.compensationElementId ? graph.nodes[step.compensationElementId] : undefined;
  const jobId = newId("job");
  const taskType = step.compensationTaskType ?? handlerNode?.taskType ?? "";
  await dbBatch(env.DB, [
    createJobStmt(env.DB, {
      jobId,
      instanceId,
      elementId: step.elementId, // forward element id (uq is per kind + occurrence + iteration)
      taskType,
      retryLimit: Math.max(1, handlerNode?.retries ?? 1),
      // M5-L3: the compensation-job idempotency key gains an `@${iteration}` suffix
      // ONLY when iteration > 0 — so every pre-L3 (iteration 0) key stays
      // byte-identical (replay safety across the migration), and per-iteration MI
      // compensation jobs get distinct keys.
      idempotencyKey: `${instanceId}:${step.elementId}:1:${step.occurrence}` + (step.iterationIndex > 0 ? `@${step.iterationIndex}` : ""),
      inputVariables: parseJson<JsonObject>(inst.variables, {}),
      workspaceId: inst.workspace_id,
      isCompensation: true,
      compensatesElementId: step.elementId,
      // A compensation job inherits its forward step's occurrence (design M2 §8)
      // and iteration (M5-L3) — the reverse pass keys its lookups by both.
      occurrence: step.occurrence,
      iterationIndex: step.iterationIndex,
      now: nowIso(),
    }),
    attachCompensationJobStmt(env.DB, { stepId: step.stepId, compensationJobId: jobId, now: nowIso() }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: step.elementId, type: "compensationStarted", diagnostics: { jobId, handler: step.compensationElementId, taskType, traceId: traceIdFor(instanceId), occurrence: step.occurrence } }),
  ]);
  return (await getCompensationJob(env.DB, instanceId, step.elementId, step.occurrence, step.iterationIndex))!;
}

async function markStepCompensated(env: Env, instanceId: string, step: SagaStepView): Promise<void> {
  const inst = await loadInst(env, instanceId);
  await dbBatch(env.DB, [
    updateCompensationStatusStmt(env.DB, { stepId: step.stepId, status: "compensated", now: nowIso() }),
    // `occurrence` mirrors compensationStarted (TASK-37 carry): without it an
    // operator could not tell WHICH loop iteration finished compensating.
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: step.elementId, type: "compensationCompleted", diagnostics: { handler: step.compensationElementId, occurrence: step.occurrence } }),
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

/**
 * Settle a completed reverse pass. A NESTED cancel-end (spec §4.3 refined) settles
 * NON-terminally — the instance CONTINUES on the cancel boundary's failure target,
 * status back to running. A top-level / process root settles the saga-failed
 * terminal WITHOUT completeInstance (keep 'compensated'). `rootScopeId` null (the
 * operator/process root) folds its history element ids to the process id.
 */
async function settleSagaCompensated(env: Env, instanceId: string, graph: ExecutionGraph, rootScopeId: string | null, failureTarget: string | null, isNestedRoot: boolean): Promise<void> {
  const inst = await loadInst(env, instanceId);
  if (inst.status !== "compensating") return; // already settled / not in pass
  const now = nowIso();
  const scopeEl = rootScopeId ?? graph.processId;
  if (isNestedRoot && failureTarget) {
    // Nested cancel-end (spec §4.3 as refined): the instance CONTINUES on the cancel
    // boundary's failure path — non-terminal settle, status back to running.
    await dbBatch(env.DB, [
      historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: scopeEl, type: "compensationCompleted", diagnostics: { transaction: rootScopeId, outcome: "compensated", nested: true } }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: failureTarget, status: "running", now }),
    ]);
    return;
  }
  const finalEl = failureTarget ?? scopeEl;
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: scopeEl, type: "compensationCompleted", diagnostics: { transaction: rootScopeId, outcome: "compensated" } }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: finalEl, type: "sagaFailed", diagnostics: { settledVia: finalEl } }),
    // Incident lifecycle (TASK-36 carry): an operator /cancel of a Hazard set
    // the incident resolution to 'compensating'; the settle is its natural
    // completion → advance to 'compensated' atomically with the terminal
    // transition. Guarded on the exact prior value, so the /retry path's
    // sticky 'operatorResolved' and an 'open' incident are never clobbered,
    // and instances with no incident (auto cancel-end / operator cancel of a
    // running saga) no-op.
    advanceIncidentResolutionStmt(env.DB, { instanceId, from: "compensating", to: "compensated" }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: finalEl, status: "compensated", completedAt: now, now }),
  ]);
}
