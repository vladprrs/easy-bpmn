// M5-L2 callActivity runtime — forward invoke/apply (this task), child-terminal
// parent notify + DO-alarm self-heal (this task), errored settle + drain cascade
// + child compensation (Tasks 7–9). Mirrors forward-task.ts's triad discipline:
// every runStep issuance is gated on a D1 predicate read outside the step
// (memoization safety) — the child Workflow create and the output apply are each
// gated on the child_instances provenance row + the child's own terminal status,
// so a memoized step result is never "not ready yet".

import type { Env } from "../env";
import type { ExecutionGraph, GraphNode } from "../bpmn/graph";
import { MAX_EVENT_PAYLOAD_BYTES, payloadByteSize } from "./payload";
import {
  isTerminalInstanceStatus,
  isoPlusMs,
  mergeVariables,
  newId,
  nowIso,
  parseJson,
  traceIdFor,
  type JsonObject,
} from "../util";
import { dbBatch, stmt } from "../persistence/db";
import { countHistoryEventsOfType, historyStmt, latestScopeEntryOccurrence } from "../persistence/history";
import {
  applyTransitionStmt,
  createChildInstanceStmt,
  getInstanceRow,
  transitionStatusGuarded,
  variableSnapshotStmt,
  type InstanceRow,
} from "../persistence/instances";
import {
  getChildInstanceByChildId,
  getChildInstanceForVisit,
  insertChildInstanceStmt,
  listChildrenByElement,
  markChildOutputAppliedStmt,
} from "../persistence/child-instances";
import { countCompensableSteps, getSagaStepByChildId, insertSagaStepStmt, type SagaStepView } from "../persistence/saga";
import { eligibleCommittedLocalScopeIds, subtreeScopeIds } from "../bpmn/scope-tree";
import { getVersionGraph } from "../persistence/definitions";
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
import { errorCatchTarget, type MiIterationDrive } from "./forward-task";
import { miIterTag } from "./multi-instance";
import { createIncident } from "./incidents";
import { drainScopeSubtree } from "./compensation";
import { cancelChildCascade } from "./child-cascade";
import { resolveScope } from "./frontier";
import { loadInst, type RunStep } from "./engine-shared";
import { getExecutor } from "./executor";
import { branchHistoryTags, getToken, listLiveTokens, parseOverlay, readOverlay, rootTokenId, setTokenOverlayStmt, writeOverlay } from "../persistence/tokens";
import { CHILD_NOTIFY_BACKOFF_MS } from "../durable-objects/job-scheduler";
import { CHILD_WAIT_BACKSTOP_MS } from "./wake";

// Re-exported from wake.ts (a leaf module) to keep the exact-exports contract while
// avoiding an engine↔call-activity import cycle (wake.ts is imported by engine.ts).
export { CHILD_WAIT_BACKSTOP_MS };

/** Child terminals the PARENT reacts to (notify set). `incident` is deliberately
 *  absent — a child incident parks the saga; the cascading /retry resumes it. */
export const PARENT_CONSUMABLE_CHILD_STATUSES = new Set(["completed", "errored", "cancelled", "compensated", "compensationFailed"]);
/** Child terminals the FORWARD apply consumes (spec §3.5/§4). */
const FORWARD_APPLY_STATUSES = new Set(["completed", "errored"]);

/**
 * Deterministic child instance id for a callActivity visit (spec §3.2): a
 * SHA-256 of the parent visit coordinates, so an at-least-once re-run of the
 * invoke step derives the SAME child id (the idempotent-create key). 24 hex
 * chars keeps it comfortably unique while readable.
 */
export async function childInstanceIdFor(parentInstanceId: string, elementId: string, occ: number, iterationIndex = 0): Promise<string> {
  const data = new TextEncoder().encode(`${parentInstanceId}:${elementId}:${occ}:${iterationIndex}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pi-${hex.slice(0, 24)}`;
}

export type CallOutcome =
  | { kind: "next"; next: string }
  | { kind: "waiting" }
  | { kind: "incident" }
  // M5-L3 (Task 10): an iteration child settled `errored` under an `mi` drive —
  // surfaced to the MI driver as an iteration business error (the Task 9 abort
  // path), NEVER routed at the parent here. Only ever returned when `mi` is set.
  | { kind: "errored"; errorCode: string | null };

/**
 * Drive one callActivity visit (spec §3). The triad — create, apply, park — each
 * gated on a D1 predicate read OUTSIDE the runStep so a memoized step result is
 * always final:
 *   - `outputApplied` provenance → write-free fast-forward (appliedCallOutcome).
 *   - no provenance row → create the child (idempotent), then re-read.
 *   - child in a FORWARD-consumable terminal → apply-once (merge + advance).
 *   - otherwise → park; the parent resumes on the child→parent notify tickle
 *     (direct mode ran the child inline inside invokeChild, so it may already be
 *     terminal here — the same drive applies it).
 */
export async function driveCallActivity(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  runStep: RunStep,
  activeTokenId?: string,
  // M5-L3 (Task 10): the multi-instance thread. When set, this visit drives ONE MI
  // iteration — child id / provenance / apply keyed `(elementId, occ, iterationIndex)`
  // (the 4th dimension of childInstanceIdFor), initial vars = the pinned per-iteration
  // `inputOverride` (item + loopCounter), step names gain `@${i}` for i > 0 (miIterTag),
  // and the apply path persists the child-terminal flip + ledger WITHOUT advancing the
  // parent (the MI driver's `mi-apply` owns aggregation + advancement + the park). An
  // `errored` child is SURFACED to the driver (a `{kind:"errored"}` outcome), never
  // routed at the parent. Timer boundaries on an MI host guard the whole ACTIVATION
  // (armed/settled by the MI driver — Task 9), so per-iteration timer interaction is
  // skipped. Every EXISTING (non-MI) call site omits `mi` → byte-identical L2 behavior.
  mi?: MiIterationDrive,
): Promise<CallOutcome> {
  const iter = mi?.iterationIndex ?? 0;
  const tag = miIterTag(`${elementId}#${occ}`, iter);
  // Boundary-timer fast-forward — the decider check is identical to
  // forward-task.ts; unlike a plain task, a fired callActivity timer ALSO owes a
  // Hazard cancel-cascade of the visit's child (Task 8). Deferred to here (not
  // folded into the fire batch itself) for the same atomicity reason
  // engine.ts's scope-timer-exit branch defers `drainScopeSubtree` — the fire
  // batch (planBoundaryTimerFire, boundary-timer.ts) stays single/
  // persist-before-advance, and `cancelChildCascade`'s own terminal short-circuit
  // makes this step idempotent across every later rewalk that lands here. Under MI
  // the timer guards the whole activation and the MI driver owns its fast-forward
  // (`mi-timer-exit`) — skipped per iteration.
  const tb = timerBoundaryFor(graph, elementId);
  if (!mi && tb && (await timerHasFired(env, instanceId, tb, occ))) {
    await runStep(`call-timer-exit:${tag}`, () => cancelVisitChildren(env, instanceId, elementId, occ));
    return { kind: "next", next: tb.node.next! };
  }

  let row = await getChildInstanceForVisit(env.DB, instanceId, elementId, occ, iter);
  // Applied → pure write-free cursor move re-derived from the child terminal state.
  if (row?.status === "outputApplied") return appliedCallOutcome(env, instanceId, graph, elementId, node, row, mi);

  if (!row) {
    const created = await runStep(`call-create:${tag}`, () => invokeChild(env, instanceId, graph, elementId, occ, node, activeTokenId, mi));
    if (!created) return { kind: "incident" }; // oversized input — incident already recorded
    row = await getChildInstanceForVisit(env.DB, instanceId, elementId, occ, iter);
  }
  const child = row ? await getInstanceRow(env.DB, row.child_instance_id) : null;
  if (!child) return { kind: "incident" }; // invariant: provenance row without child row

  // Crash self-heal: the provenance row committed but the Workflow create was lost
  // (crash between the batch and create) — re-issue the idempotent start. Only
  // observable in workflow mode ('starting' + no drive ever ran); direct mode ran
  // the child inline inside invokeChild, so it is never 'starting' here.
  if (child.status === "starting") {
    await getExecutor(env).start({
      workspaceId: child.workspace_id,
      instanceId: child.instance_id,
      definitionVersionId: child.definition_version_id,
      correlationKey: child.correlation_key,
      initialVariables: parseJson<JsonObject>(child.variables, {}),
    });
  }

  const fresh = await getInstanceRow(env.DB, row!.child_instance_id);
  if (fresh && FORWARD_APPLY_STATUSES.has(fresh.status)) {
    // Gated apply (memoization safety): the step is issued ONLY when the child is
    // in a forward-consumable terminal, so its memoized result is always final.
    const applied = await runStep(`call-apply:${tag}`, () => applyChildTerminal(env, instanceId, graph, elementId, occ, node, activeTokenId, mi));
    return applied;
  }
  // M5-L3 (Task 10): under MI the driver owns the ONE park for the whole visit
  // (`mi-park`, after every live iteration is driven) — a per-iteration park here
  // would park the parent on the callActivity element (racing the sibling
  // iterations) instead of the MI element. Mirror forward-task's `if (mi) return`.
  if (mi) return { kind: "waiting" };
  // M5-L3 step-free park (design §6): mirror the forward-task svc-park guard — a
  // rewalk over an UNCHANGED parked callActivity is step-free. The predicate is
  // parkCallWaiting's OWN idempotence condition (:505-512), read OUTSIDE the step, so
  // the memoized-no-op re-park is elided entirely (a step-COUNT change only — the
  // parent's `waiting`-on-call1 frontier is byte-identical). A first park ('running'/
  // 'starting') or a park on a different element still issues its step.
  const inst = await loadInst(env, instanceId);
  if (inst.status === "waiting" && inst.current_element_id === elementId) return { kind: "waiting" };
  await runStep(`call-park:${tag}`, () => parkCallWaiting(env, instanceId, elementId, occ));
  return { kind: "waiting" };
}

/**
 * Cascade-cancel EVERY iteration child bound by a callActivity VISIT (Task 8 for
 * the non-MI single-child timer Hazard; Task 10 for the MI fan-out). Iterating
 * `listChildrenByElement` filtered to this occurrence covers both: a non-MI visit
 * has exactly one child (iteration 0) — byte-identical to the old single-row read
 * — while an MI visit has N children `(elementId, occ, i)`, every live one of which
 * a Hazard interrupt (fired boundary timer / MI abort teardown) must cancel. A
 * missing/empty set means the invoke step never ran (nothing to cancel) — defensive.
 * `cancelChildCascade` is itself idempotent (terminal/compensating short-circuit),
 * so a re-run of this step (Workflow retry, or a later rewalk re-hitting the same
 * fired visit) is a cheap no-op. RETENTION, not compensation: each child's saga
 * ledger is left untouched for a later enclosing reverse pass.
 */
export async function cancelVisitChildren(env: Env, instanceId: string, elementId: string, occ: number): Promise<void> {
  for (const c of await listChildrenByElement(env.DB, instanceId, elementId)) {
    if (c.occurrence !== occ) continue;
    await cancelChildCascade(env, c.child_instance_id);
  }
}

/**
 * Idempotent-create step (spec §3.2). Persist-before-advance: the provenance row
 * + the child instance + the invoked audit commit in ONE batch, THEN the
 * idempotent Workflow start. Returns false only on the oversized-input incident.
 */
async function invokeChild(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  activeTokenId?: string,
  mi?: MiIterationDrive,
): Promise<boolean> {
  const iter = mi?.iterationIndex ?? 0;
  const existing = await getChildInstanceForVisit(env.DB, instanceId, elementId, occ, iter);
  if (existing) return true; // idempotent step re-run — the child is already bound

  const inst = await loadInst(env, instanceId);
  // Branch-scoped input (design §5.7): a branch token's child sees its resolved
  // overlay chain; a null/root token reads root variables verbatim. An MI iteration
  // child's initial vars are the PINNED per-iteration override (base + item +
  // loopCounter, resolved once by the MI driver) — never a re-resolve of the live scope.
  const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
  const variables = mi
    ? mi.inputOverride
    : isBranch
      ? await resolveScope(env, instanceId, parseJson<JsonObject>(inst.variables, {}), activeTokenId!)
      : parseJson<JsonObject>(inst.variables, {});
  if (payloadByteSize(variables) > MAX_EVENT_PAYLOAD_BYTES) {
    await createIncident(env, instanceId, elementId, 0, "Call activity input variables exceed the Workflow event payload limit.", { size: payloadByteSize(variables) }, "serviceTaskFailure");
    return false;
  }

  const childId = await childInstanceIdFor(instanceId, elementId, occ, iter);
  const childGraph = await getVersionGraph(env.DB, node.calledDefinitionVersionId!);
  if (!childGraph) throw new Error(`Invariant violation: pinned child version ${node.calledDefinitionVersionId} has no parsed profile.`);
  const now = nowIso();
  // A boundary timer on the callActivity (if any) arms in the SAME batch —
  // persist-before-advance; the DO is armed after the batch commits. Under MI the
  // host's timer guards the whole ACTIVATION (armed once by activateMi, Task 9) —
  // never per iteration.
  const arm = mi ? null : buildBoundaryArm(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: elementId, occ, now });
  await dbBatch(env.DB, [
    insertChildInstanceStmt(env.DB, { parentInstanceId: instanceId, parentElementId: elementId, occurrence: occ, iterationIndex: iter, childInstanceId: childId, now }),
    createChildInstanceStmt(env.DB, {
      instanceId: childId,
      workspaceId: inst.workspace_id,
      definitionVersionId: node.calledDefinitionVersionId!,
      correlationKey: `child:${childId}`,
      startElementId: childGraph.startElementId,
      variables,
      parentInstanceId: instanceId,
      parentElementId: elementId,
      parentOccurrence: occ,
      now,
    }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "callActivityInvoked",
      diagnostics: { childInstanceId: childId, calledDefinitionVersionId: node.calledDefinitionVersionId, occurrence: occ, ...(mi ? { iterationIndex: iter } : {}), ...branchHistoryTags(activeTokenId) },
    }),
    ...(arm ? arm.stmts : []),
  ]);
  if (arm) await armTimerDO(env, arm.timerId, arm.fireAt);
  // Idempotent start AFTER the provenance batch (persist-before-advance). Direct
  // mode runs the child fully inline here (suppressParentNotify); workflow mode
  // returns immediately after create.
  await getExecutor(env).start({
    workspaceId: inst.workspace_id,
    instanceId: childId,
    definitionVersionId: node.calledDefinitionVersionId!,
    correlationKey: `child:${childId}`,
    initialVariables: variables,
  });
  return true;
}

/**
 * Apply-once decider (spec §3.5). For `completed`: merge the child output +
 * advance in one batch (branch overlay vs root, exactly like applyMessage), and
 * append the child's ledger step. For `errored`: defer to Task 7's routing.
 */
async function applyChildTerminal(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  activeTokenId?: string,
  mi?: MiIterationDrive,
): Promise<CallOutcome> {
  const iter = mi?.iterationIndex ?? 0;
  const row = await getChildInstanceForVisit(env.DB, instanceId, elementId, occ, iter);
  if (!row) throw new Error(`Invariant violation: call-apply without a child_instances row (${miIterTag(`${elementId}#${occ}`, iter)}).`);
  if (row.status === "outputApplied") return appliedCallOutcome(env, instanceId, graph, elementId, node, row, mi); // idempotent re-run
  const child = (await getInstanceRow(env.DB, row.child_instance_id))!;
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const applyFlip = markChildOutputAppliedStmt(env.DB, { parentInstanceId: instanceId, parentElementId: elementId, occurrence: occ, iterationIndex: iter, now });

  if (child.status === "completed") {
    const childVars = parseJson<JsonObject>(child.variables, {});
    // M5-L3 (Task 10): the MI ITERATION apply — persist the child-terminal flip +
    // the per-iteration ledger row + the `miIterationCompleted` audit in ONE batch,
    // but NO variable merge and NO advance: the child output stays on the child row
    // until the MI driver's `mi-apply` aggregates ALL iterations index-ordered and
    // owns the single advance (exactly the serviceTask MI iteration apply). The
    // ledger row carries the miBody scope (`elementId`) + the iteration index so the
    // per-iteration reverse pass can drive each child's own reverse.
    if (mi) {
      await dbBatch(env.DB, [
        applyFlip,
        insertSagaStepStmt(env.DB, {
          stepId: newId("step"),
          instanceId,
          scopeId: elementId, // the miBody scope
          elementId,
          forwardJobId: "",
          capturedInput: {},
          capturedOutput: childVars,
          compensationElementId: null,
          compensationTaskType: null,
          compensationStatus: "pending",
          traceId: traceIdFor(instanceId),
          occurrence: occ,
          tokenId: activeTokenId ?? null,
          childInstanceId: row.child_instance_id,
          iterationIndex: iter,
          now,
        }),
        historyStmt(env.DB, {
          workspaceId: inst.workspace_id,
          instanceId,
          elementId,
          type: "miIterationCompleted",
          diagnostics: { childInstanceId: row.child_instance_id, iterationIndex: iter, occurrence: occ, ...branchHistoryTags(activeTokenId) },
        }),
      ]);
      return { kind: "next", next: node.next! };
    }
    const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
    const branchTokenRow = isBranch ? await getToken(env.DB, activeTokenId!) : null;
    const baseVars = isBranch ? (branchTokenRow ? await readOverlay(env, parseOverlay(branchTokenRow)) : {}) : parseJson<JsonObject>(inst.variables, {});
    const merged = mergeVariables(baseVars, childVars);
    const storedOverlay = isBranch ? await writeOverlay(env, instanceId, activeTokenId!, merged) : merged;
    const stepId = newId("step");
    await dbBatch(env.DB, [
      applyFlip,
      ...(isBranch
        ? [setTokenOverlayStmt(env.DB, activeTokenId!, storedOverlay, now), applyTransitionStmt(env.DB, { instanceId, currentElementId: null, status: "running", now })]
        : [applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: node.next, status: "running", now })]),
      variableSnapshotStmt(env.DB, { instanceId, source: "callActivity", sourceId: row.child_instance_id, variables: childVars, now }),
      // Child ledger step (spec §5): ALWAYS compensable — the implicit compensator
      // is the child's own reverse pass; an empty committed child ledger no-ops.
      // forward_job_id is NOT NULL, so a child step carries the "" sentinel
      // (mapSagaStep folds it back to null).
      insertSagaStepStmt(env.DB, {
        stepId,
        instanceId,
        scopeId: node.scopeId ?? "",
        elementId,
        forwardJobId: "",
        capturedInput: {},
        capturedOutput: childVars,
        compensationElementId: null,
        compensationTaskType: null,
        compensationStatus: "pending",
        traceId: traceIdFor(instanceId),
        occurrence: occ,
        tokenId: activeTokenId ?? null,
        childInstanceId: row.child_instance_id,
        now,
      }),
      historyStmt(env.DB, {
        workspaceId: inst.workspace_id,
        instanceId,
        elementId,
        type: "callActivityCompleted",
        diagnostics: { childInstanceId: row.child_instance_id, occurrence: occ, ...branchHistoryTags(activeTokenId) },
      }),
    ]);
    return { kind: "next", next: node.next! };
  }
  // child.status === "errored" — Task 7 routing (error boundary / bubble / uncaughtError),
  // OR, under MI, SURFACE to the driver as an iteration business error (Task 10).
  return applyChildErrored(env, instanceId, graph, elementId, occ, node, row, child, activeTokenId, mi);
}

/**
 * Child-side settle (spec §4, Task 7): a callActivity CHILD's uncaught error end
 * is a TERMINAL WITH A CODE for the parent to route — never a child-local
 * `uncaughtError` incident (that branch is reserved for a ROOT instance's uncaught
 * error end, unchanged since M5-L1). One-way status guard: never regress an
 * already-terminal child (mirrors createIncident's own terminal guard, and makes
 * a duplicate re-run of the `err-end` step a no-op).
 */
export async function settleChildErrored(env: Env, instanceId: string, elementId: string, errorCode: string | null, occ: number): Promise<void> {
  const inst = await loadInst(env, instanceId);
  if (isTerminalInstanceStatus(inst.status)) return; // idempotent / never regress
  const now = nowIso();
  await dbBatch(env.DB, [
    stmt(
      env.DB,
      `UPDATE process_instances SET status='errored', error_code=?, current_element_id=?, completed_at=?, updated_at=?
         WHERE instance_id=? AND status NOT IN ('completed','incident','compensated','compensationFailed','cancelled','errored')`,
      [errorCode, elementId, now, now, instanceId],
    ),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "childErrored", diagnostics: { errorCode, occurrence: occ } }),
  ]);
}

/**
 * Parent-side routing for a child that settled `errored` (spec §4, Task 7):
 * mirrors forward-task.ts's `handleForwardFailure` business-error apply — match
 * an error boundary via the SAME hierarchical attachment-chain walk
 * (`errorCatchTarget`) the worker-task path uses, else raise an uncaught
 * `uncaughtError` incident.
 *
 * Ordering (deliberately mirrors handleForwardFailure's REAL order, not the
 * task brief's inline sketch): the flip + `callActivityErrored` audit + advance
 * commit FIRST — that batch alone is what `appliedCallOutcome`'s fast-forward
 * predicate (child terminal + immutable graph) keys off. A scope-caught target
 * then drains the catching scope's live subtree (idempotent retain-only) and
 * writes `scopeExited` AFTER, as a separate write — so a crash in that window
 * is healed by `appliedCallOutcome`'s existence-guarded re-drain (below),
 * exactly like appliedForwardOutcome's own backstop. Draining BEFORE the batch
 * (as the brief's sketch shows) would make that self-heal unreachable dead
 * code, since the flip and the scopeExited marker would always co-commit.
 *
 * Task 8 carry (review finding from Task 7): the callActivity's OWN guarding
 * boundary timer — and, when the catch climbed to an enclosing scope, THAT
 * scope's own boundary timer — must be disarmed atomically with the error
 * route, exactly like `handleForwardFailure`'s `buildBoundaryCancelSettle`
 * composition (forward-task.ts). Without this a fixture pairing an error
 * boundary AND a timer boundary on the same callActivity (or its catching
 * scope) would leak an armed `timer_outcomes`-less timer row past the error
 * route. On a decider conflict (the timer fired first) the whole batch aborts
 * and we convert to the boundary path instead — never double-advance.
 */
async function applyChildErrored(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  _node: GraphNode,
  row: { child_instance_id: string },
  child: InstanceRow,
  activeTokenId?: string,
  mi?: MiIterationDrive,
): Promise<CallOutcome> {
  // M5-L3 (Task 10): under MI an `errored` iteration child is NOT routed at the
  // parent here — it is SURFACED to the MI driver as an iteration business error
  // (the driver's `abortOnIterationError` settles the visit `abort`, drains the
  // miBody, and resolves the error boundary / bubble / uncaughtError AT the MI
  // element). No flip, no ledger, no route: the child stays `errored` (owes no
  // parent-driven reverse), the child_instances row stays `invoked`, and the
  // driver re-observes the errored child on every rewalk until it aborts.
  if (mi) return { kind: "errored", errorCode: child.error_code ?? null };
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const applyFlip = markChildOutputAppliedStmt(env.DB, { parentInstanceId: instanceId, parentElementId: elementId, occurrence: occ, iterationIndex: 0, now });
  const target = errorCatchTarget(graph, elementId, child.error_code);
  if (target) {
    // Task 8 carry: disarm call1's OWN guarding timer, and (when the catch
    // climbed to a scope) that scope's OWN guarding timer, atomically with the
    // error route — mirrors handleForwardFailure's cancelSettle/scopeCancelSettle.
    const scopeOcc = target.hostIsScope ? await latestScopeEntryOccurrence(env.DB, instanceId, target.hostId) : 0;
    const cancelSettle = buildBoundaryCancelSettle(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: elementId, occ, now });
    const scopeCancelSettle = target.hostIsScope
      ? buildBoundaryCancelSettle(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: target.hostId, occ: scopeOcc, now })
      : null;
    const stmts: D1PreparedStatement[] = [
      applyFlip,
      historyStmt(env.DB, {
        workspaceId: inst.workspace_id,
        instanceId,
        elementId,
        type: "callActivityErrored",
        diagnostics: { childInstanceId: row.child_instance_id, errorCode: child.error_code, caughtBy: target.boundaryId, occurrence: occ, ...branchHistoryTags(activeTokenId) },
      }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: target.next, status: "running", now }),
    ];
    if (cancelSettle) stmts.push(...cancelSettle.stmts);
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
    if (target.hostIsScope) {
      // Idempotent retain-only (Task 8) — safe to re-run on a step retry; the
      // scopeExited write below is the completion marker appliedCallOutcome
      // checks for its own self-heal.
      await drainScopeSubtree(env, graph, instanceId, target.hostId);
      await historyStmt(env.DB, {
        workspaceId: inst.workspace_id,
        instanceId,
        elementId: target.hostId,
        type: "scopeExited",
        diagnostics: { scope: target.hostId, via: target.boundaryId, abnormal: true },
      }).run();
    }
    return { kind: "next", next: target.next };
  }
  // Uncaught: settle call1's OWN guarding timer 'cancelled' in its own batch
  // before raising the incident (mirrors handleForwardFailure's uncaught path);
  // if the timer fired first, convert to the boundary path instead of an incident.
  const settledUncaught = await settleBoundaryTimerCancel(env, graph, instanceId, inst.workspace_id, elementId, occ);
  if (typeof settledUncaught === "object") return { kind: "next", next: settledUncaught.converted };
  await dbBatch(env.DB, [
    applyFlip,
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "callActivityErrored",
      diagnostics: { childInstanceId: row.child_instance_id, errorCode: child.error_code, occurrence: occ },
    }),
  ]);
  await createIncident(
    env,
    instanceId,
    elementId,
    0,
    `Call activity child errored ('${child.error_code}') with no matching error boundary up the scope chain.`,
    { childInstanceId: row.child_instance_id, errorCode: child.error_code },
    "uncaughtError",
  );
  return { kind: "incident" };
}

/**
 * Write-free re-derivation for an already-applied call visit (mirror
 * appliedForwardOutcome): re-read the child terminal and derive the successor
 * from the immutable graph. `completed` → node.next; `errored` → the deterministic
 * error-catch target, or an incident if uncaught.
 *
 * Self-heal (mirrors appliedForwardOutcome's own scope-caught backstop): the
 * `applyChildErrored` batch and `drainScopeSubtree` are NOT one atomic unit — a
 * crash between the batch commit (which already flipped `outputApplied`) and the
 * drain would otherwise be skipped forever, since every later rewalk fast-forwards
 * through here. Guarded by the `scopeExited` marker's existence so the re-drain
 * only ever runs once.
 */
async function appliedCallOutcome(env: Env, instanceId: string, graph: ExecutionGraph, elementId: string, node: GraphNode, row: { child_instance_id: string }, mi?: MiIterationDrive): Promise<CallOutcome> {
  // M5-L3 (Task 10): an already-applied MI iteration is a completed iteration —
  // its output_applied flip is ONLY set on the `completed` path (an errored child
  // is surfaced, never flipped), so there is nothing to route/self-heal here; the
  // MI driver's `iterationState` fast-forwards it (this path is defensive — the
  // driver never re-drives an applied iteration).
  if (mi) return { kind: "next", next: node.next! };
  const child = await getInstanceRow(env.DB, row.child_instance_id);
  if (child?.status === "errored") {
    const target = errorCatchTarget(graph, elementId, child.error_code ?? null);
    if (target) {
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
    return { kind: "incident" };
  }
  return { kind: "next", next: node.next! };
}

/**
 * Park the parent on the callActivity wait (spec §3.3). Idempotent re-park: a
 * rewalk that lands on an already-parked call visit is write-free.
 */
async function parkCallWaiting(env: Env, instanceId: string, elementId: string, occ: number): Promise<void> {
  const inst = await loadInst(env, instanceId);
  if (inst.status === "waiting" && inst.current_element_id === elementId) return; // idempotent re-park
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "callActivityWaiting", diagnostics: { occurrence: occ } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now: nowIso() }),
  ]);
}

/**
 * Enter a child's OWN reverse compensation pass (M5-L2 Task 9, design §5) — the
 * compensator of a committed callActivity saga step. A distinct, narrow entry
 * point that bypasses the terminal guards: CAS `{completed, cancelled} →
 * compensating` (`completed` = the committed callActivity; `cancelled` = the
 * drain-interrupted child of §4 whose committed steps still need compensation),
 * write the element-less cancel marker (the child's compensation resume derives
 * the PROCESS-ROOT reverse pass — the marker's element id is the PARENT-graph
 * call site, absent from the child graph, so the engine maps it to root null),
 * take the empty-ledger no-op shortcut straight to `compensated` (no park), else
 * drive the (terminated) child inline. Idempotent: a re-entry finds the child in
 * `compensating`/a terminal and returns without touching anything; a lost CAS
 * race leaves the winner owning the reverse.
 */
export async function beginChildCompensation(env: Env, parentInstanceId: string, step: SagaStepView): Promise<void> {
  const childId = step.childInstanceId!;
  const child = await getInstanceRow(env.DB, childId);
  if (!child || !["completed", "cancelled"].includes(child.status)) return; // idempotent: someone already entered (or nothing to undo)
  const now = nowIso();
  const changed = await transitionStatusGuarded(env.DB, childId, ["completed", "cancelled"], "compensating", now);
  if (changed === 0) return; // lost the CAS — the winner owns the reverse
  await historyStmt(env.DB, {
    workspaceId: child.workspace_id,
    instanceId: childId,
    // The parent-graph call site — NOT a child-graph element, so the child's
    // compensation resume (engine latestCancelRootElement mapping) derives the
    // process-root (null) reverse pass; kept for operator diagnostics.
    elementId: child.parent_element_id ?? "",
    type: "transactionCancelled",
    diagnostics: { by: "parentCompensation", parentInstanceId },
  }).run();
  const childGraph = await getVersionGraph(env.DB, child.definition_version_id);
  if (!childGraph) throw new Error(`Invariant violation: child version ${child.definition_version_id} has no parsed profile.`);
  const pending = await countCompensableSteps(env.DB, childId, subtreeScopeIds(childGraph, null), eligibleCommittedLocalScopeIds(childGraph, null), true);
  // Live-token guard on the shortcut (mirrors handleCancelInstance's cohort
  // guard): a cancelled REGION child may carry a live token whose completed
  // forward job is not yet ledgered — the child's own straggler scan must run,
  // so only an empty ledger AND a quiesced cohort settles synchronously.
  const liveTokens = pending === 0 ? await listLiveTokens(env.DB, childId) : [];
  if (pending === 0 && liveTokens.length === 0) {
    // No-op compensator (design §5.1): nothing committed → settle immediately,
    // WITHOUT parking the parent (its dispatch re-reads `compensated` on the
    // very next pass).
    await transitionStatusGuarded(env.DB, childId, ["compensating"], "compensated", now);
    await historyStmt(env.DB, {
      workspaceId: child.workspace_id,
      instanceId: childId,
      elementId: childGraph.processId,
      type: "compensationCompleted",
      diagnostics: { outcome: "compensated", emptyLedger: true },
    }).run();
    return;
  }
  // Drive the (terminated) child's reverse pass inline — the operator-resume-
  // after-termination path carries its comp jobs (executor deliverJobResult
  // falls back to an inline drive for a dead Workflow). suppressParentNotify:
  // this call sits INSIDE the parent's own drive; the parent loop re-reads the
  // child status right after (dispatch `continue`). Dynamic import: engine.ts
  // statically imports this module — the forward-task.ts resumeInline precedent.
  const { runInstance } = await import("./engine");
  const inlineStep = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
  await runInstance(env, childId, { runStep: inlineStep, waitFor: null, suppressParentNotify: true });
}

/**
 * Notify a parent that its child settled a parent-consumable terminal (spec §3.4):
 * arm the child-notify DO self-heal FIRST (so a dropped tickle — the child
 * terminated before the parent armed its wait — recovers within the notify
 * backoff, not the 1h wake backstop), then tickle the parent via the
 * deliverJobResult seam (a contentless WAKE_TYPE sendEvent with the terminated-
 * Workflow inline-drive fallback, in both executors).
 */
export async function notifyParentOfChildTerminal(env: Env, child: InstanceRow): Promise<void> {
  if (!child.parent_instance_id || !PARENT_CONSUMABLE_CHILD_STATUSES.has(child.status)) return;
  const parent = await getInstanceRow(env.DB, child.parent_instance_id);
  if (!parent || isTerminalInstanceStatus(parent.status)) return;
  await armChildNotifyAlarm(env, child.instance_id, 0);
  await getExecutor(env).deliverJobResult({ instanceId: parent.instance_id, workflowInstanceId: parent.workflow_instance_id, elementId: child.parent_element_id! });
}

/** Best-effort + non-fatal arm of the child-notify DO alarm (keyed
 *  `child-notify:<childInstanceId>`), like the DLQ/timer arms. */
async function armChildNotifyAlarm(env: Env, childInstanceId: string, attempt: number): Promise<void> {
  try {
    const stub = env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`child-notify:${childInstanceId}`));
    await stub.armChildNotify(childInstanceId, isoPlusMs(nowIso(), CHILD_NOTIFY_BACKOFF_MS[Math.min(attempt, CHILD_NOTIFY_BACKOFF_MS.length - 1)]!), attempt);
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", message: "armChildNotify failed", childInstanceId, error: err instanceof Error ? err.message : String(err) }));
  }
}

/** DO-alarm self-heal (spec §3.4): re-read canonical state; if the parent has not
 *  yet consumed this child's terminal (forward apply OR reverse-pass settle),
 *  re-tickle and re-arm (bounded). */
export async function retryChildNotify(env: Env, childInstanceId: string, attempt: number): Promise<void> {
  const child = await getInstanceRow(env.DB, childInstanceId);
  if (!child?.parent_instance_id || !PARENT_CONSUMABLE_CHILD_STATUSES.has(child.status)) return;
  const parent = await getInstanceRow(env.DB, child.parent_instance_id);
  if (!parent || isTerminalInstanceStatus(parent.status)) return;
  const row = await getChildInstanceByChildId(env.DB, childInstanceId);
  const forwardConsumed = row?.status === "outputApplied";
  // Reverse-pass consumption (Task 9): the parent's child step settled.
  const step = await getSagaStepByChildId(env.DB, parent.instance_id, childInstanceId);
  const reverseConsumed = step != null && (step.compensationStatus === "compensated" || step.compensationStatus === "failed");
  if (forwardConsumed && (child.status === "completed" || child.status === "errored") && !["compensated", "compensationFailed"].includes(child.status)) return;
  if (reverseConsumed) return;
  if (attempt >= CHILD_NOTIFY_BACKOFF_MS.length) {
    console.error(JSON.stringify({ level: "error", message: "child-notify retries exhausted", childInstanceId, parentInstanceId: parent.instance_id }));
    return; // the 1h wake backstop remains the last resort
  }
  await armChildNotifyAlarm(env, childInstanceId, attempt + 1);
  await getExecutor(env).deliverJobResult({ instanceId: parent.instance_id, workflowInstanceId: parent.workflow_instance_id, elementId: child.parent_element_id! });
}
