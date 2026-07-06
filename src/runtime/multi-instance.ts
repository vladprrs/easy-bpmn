// M5-L3 (Task 6) — the multi-instance driver: one MI activity VISIT fans out N
// iterations of its body and re-joins them into a single advance.
//
// The design mirrors the rewalk/occurrence model exactly:
//   - ONE arrival = ONE walk occurrence; iterations are a SECOND dimension
//     (`iterationIndex`) — never extra occurrences.
//   - `mi_activations` is the gateway_decisions analogue: cardinality/items are
//     evaluated ONCE at activation and pinned forever (a rewalk NEVER
//     re-evaluates, even if variables changed since). The row also hosts the two
//     idempotent CAS deciders — `settled_kind` (once-only settle) and
//     `output_applied` (single-apply aggregation merge).
//   - Workflow-step memoization discipline: every step issuance is gated on a D1
//     predicate read OUTSIDE the step (the activation read outside `mi-activate`,
//     `output_applied` outside `mi-apply`, the park guard outside `mi-park` —
//     the Task 4 step-free-park pattern), so a rewalk over an unchanged visit is
//     step-free.
//   - Step names / idempotency keys gain `@${i}` ONLY when i > 0, so every
//     pre-L3 name stays byte-identical (`miIterTag`).
//
// Task 6 drives serviceTask bodies only (the forward-task triad, threaded with
// the optional `mi` arg); subProcess bodies (iteration tokens + sub-walk) land
// in Task 7, callActivity fan-out in Task 10, completionCondition
// cancel-remaining in Task 8, and iteration error/timer routing in Task 9.

import type { Env } from "../env";
import type { ExecutionGraph, GraphNode, MultiInstanceSpec } from "../bpmn/graph";
import { mergeVariables, nowIso, parseJson, type JsonObject } from "../util";
import { dbBatch, stmt } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import { applyTransitionStmt, getForwardJob } from "../persistence/instances";
import { abandonJobOnTimerFireStmt } from "../persistence/jobs";
import {
  getMiActivation,
  insertMiActivationStmt,
  markMiOutputAppliedStmt,
  settleMiActivationStmt,
  type MiActivationRow,
} from "../persistence/mi-activations";
import {
  branchHistoryTags,
  branchTokenId,
  getToken,
  parseOverlay,
  readOverlay,
  rootTokenId,
  setTokenOverlayStmt,
  setTokenStatusStmt,
  upsertTokenStmt,
  writeOverlay,
} from "../persistence/tokens";
import { loadInst, type RunStep } from "./engine-shared";
import { createIncident } from "./incidents";
import { resolveScope, type LeafOutcome } from "./frontier";
import { scopesOf } from "../bpmn/scope-tree";
import { ExpressionEvaluationError, evaluateCondition, normalizeFeelValue } from "./expressions";
import { driveForwardServiceTask } from "./forward-task";
import { cancelChildCascade } from "./child-cascade";
import { timerBoundaryFor, timerHasFired } from "./boundary-timer";
// Static cycle engine ⇄ multi-instance is deliberate and safe (the same shape as
// the existing engine → call-activity → executor → engine cycle): only function
// bindings are accessed, and only at call time — never during module init.
import { MAX_ELEMENT_OCCURRENCES, MAX_MI_CARDINALITY, maxMiCardinality, stepBudgetSoft } from "./engine";

export type MiOutcome = { kind: "next"; next: string } | { kind: "waiting" } | { kind: "incident" };

/**
 * The engine's per-node leaf dispatch, threaded INTO the MI driver by both walk
 * drivers (Task 7): the subProcess body sub-walk drives its interior leaves —
 * service tasks, exclusive gateways, timer catches — through the exact same
 * `drivers.driveLeaf` the main walk uses, so fast-forward discipline, branch-
 * scoped reads/writes, and step naming are shared, never re-implemented.
 */
export type MiLeafDriver = (cur: string, occ: number, activeTokenId: string) => Promise<LeafOutcome>;

/**
 * Iteration-token id for MI-over-subProcess bodies (Task 7): the MI activity is
 * the "split", the occurrence is the "activation", `mi#${i}` the branch leg —
 * so all M4 token machinery (parse/tags/overlays) applies unchanged.
 */
export const miTokenId = (instanceId: string, elementId: string, occ: number, i: number): string =>
  branchTokenId(instanceId, elementId, occ, `mi#${i}`);

/**
 * Iteration discriminator for step names / idempotency keys: `@${i}` ONLY when
 * i > 0, so iteration 0 (and every pre-L3 caller) keeps byte-identical names.
 */
export const miIterTag = (tag: string, i: number): string => (i > 0 ? `${tag}@${i}` : tag);

/**
 * The BODY-AWARE runtime cardinality cap (design §6):
 * min(MAX_MI_CARDINALITY, floor(STEP_BUDGET_SOFT / (bodyStepCost * 4))) — a
 * heavier per-iteration body earns a lower fan-out so the whole activation
 * (forward + reverse + bookkeeping ≈ 4× the body estimate) fits the step budget.
 */
export function effectiveMiCap(env: Env, bodyStepCost: number): number {
  return Math.min(maxMiCardinality(env), Math.floor(stepBudgetSoft(env) / (bodyStepCost * 4)));
}

/**
 * The per-iteration variable context: base scope + the collection item under
 * `elementVariable` (default "item", only when a collection is pinned) +
 * `loopCounter` = the 0-based iteration index. This IS the iteration job's
 * input snapshot — workers see item + loopCounter in `variables`.
 */
export function iterationContext(base: JsonObject, spec: MultiInstanceSpec, items: unknown[] | null, i: number): JsonObject {
  const ctx: JsonObject = { ...base, loopCounter: i };
  if (items != null) ctx[spec.elementVariable ?? "item"] = items[i] ?? null;
  return ctx;
}

type IterationOutcome =
  | { kind: "completed" }
  | { kind: "waiting" }
  | { kind: "incident" }
  // M5-L3 (Task 7): an error END event in a subProcess MI body. A TYPED marker
  // surfaced up to the main loop — the explicit seam Task 9 wires into the
  // MI-activity error routing (drainScopeSubtree over the miBody + hierarchical
  // bubbling). Until then the loop bubbles it as a loud operator-visible incident,
  // matching Task 6's iteration business-error handling.
  | { kind: "errored"; errorCode: string | null };

/**
 * Drive one multi-instance activity visit (the heart of M5-L3). Control flow:
 *   0. boundary-timer Hazard fast-forward (Task 9 arms + drains);
 *   1. ACTIVATE — the once-only decider (`mi-activate`, gateway_decisions
 *      discipline);
 *   2. DRIVE ITERATIONS in index order (sequential stops at the first live one;
 *      parallel drives all), each iteration re-derived from D1 (`iterationState`
 *      = the iteration's job row);
 *   3. SETTLE + APPLY — the apply-once aggregation merge + advance (`mi-apply`);
 *   4. PARK — step-free re-park (the Task 4 pattern).
 */
export async function driveMultiInstance(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  runStep: RunStep,
  activeTokenId?: string,
  // M5-L3 (Task 7): the engine's per-node leaf dispatch, threaded IN by the walk
  // driver (engine.ts's `drivers.driveLeaf`, the SINGLE dispatch shared by the
  // single-token walk and the region DFS). Only a subProcess body's sub-walk
  // consumes it — it drives the interior leaves (service tasks, exclusive
  // gateways, timer catches) through the exact same driver the main walk uses,
  // so fast-forward discipline / branch-scoped reads / step naming are shared,
  // never re-implemented. serviceTask (Task 6) / callActivity (Task 10) hosts
  // never touch it, so their paths stay byte-identical when it is omitted.
  driveLeaf?: MiLeafDriver,
): Promise<MiOutcome> {
  const spec = node.multiInstance!;
  const tag = `${elementId}#${occ}`;

  // 0. Boundary-timer Hazard fast-forward — mirror call-activity.ts:117-121. A
  //    fired MI-host timer already moved the cursor to the boundary target; Task 9
  //    arms the timer at activation and fills the iteration drain/abandon here.
  const tb = timerBoundaryFor(graph, elementId);
  if (tb && (await timerHasFired(env, instanceId, tb, occ))) {
    return { kind: "next", next: tb.node.next! };
  }

  // M5-L3 (Task 7) v1 NARROWING — MI-subProcess host re-visit. The interior keys
  // of a subProcess MI body (gateway_decisions, interior jobs, iteration tokens)
  // carry NO host-occurrence dimension: the strided interior occurrence is
  // `k*N + i`, independent of the MI activity's own occurrence. So a HOST re-visit
  // (occ > 0 — a token-path cycle back through the MI subProcess) would reuse the
  // SAME interior occurrence namespace and collide with the earlier visit's rows.
  // Reject LOUDLY (the TASK-71 `scopeReentry` precedent) instead of a silent
  // desync. serviceTask / callActivity MI on a cycle stay legal — their
  // per-iteration keys already carry the host occ. Idempotent: the uniquely-named
  // step + the terminal `incident` status (drive() early-returns thereafter) fire
  // it exactly once. Recorded in the m5-L3 Constitution Check Complexity Tracking.
  if (node.type === "subProcess" && occ > 0) {
    await runStep(`mi-subproc-reentry:${tag}`, () =>
      createIncident(
        env,
        instanceId,
        elementId,
        0,
        `Multi-instance subProcess '${elementId}' was re-visited at occurrence ${occ} (a token-path cycle back through it); ` +
          "MI-subProcess host re-visit is not supported (M5-L3 v1) — the body's interior keys carry no host-occurrence " +
          "dimension and would collide across visits. Route the cycle around the MI activity, or model repetition inside the body.",
        { elementId, occurrence: occ, nodeType: node.type },
        "scopeReentry",
      ),
    );
    return { kind: "incident" };
  }

  // 1. ACTIVATE (gateway_decisions discipline): the decider read lives OUTSIDE
  //    any step, so a rewalk over an existing activation issues no step at all.
  let act = await getMiActivation(env.DB, instanceId, elementId, occ);
  if (!act) {
    const outcome = await runStep(`mi-activate:${tag}`, () => activateMi(env, instanceId, elementId, occ, node, activeTokenId));
    if (outcome !== "ok") return { kind: "incident" }; // conditionFailure | miCardinality already recorded
    act = (await getMiActivation(env.DB, instanceId, elementId, occ))!;
  }
  const N = act.cardinality;
  const items = act.items != null ? parseJson<unknown[]>(act.items, []) : null;

  // Base variables for iteration inputs — resolved lazily ONCE per drive (pure
  // read; a branch token sees its overlay chain, the root sees root variables).
  // Job inputs are pinned at job CREATE time, so later drives re-resolving a
  // changed base never rewrite an existing iteration's input.
  let baseVars: JsonObject | null = null;
  const resolveBase = async (): Promise<JsonObject> => {
    if (baseVars) return baseVars;
    const inst = await loadInst(env, instanceId);
    const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
    baseVars = isBranch
      ? await resolveScope(env, instanceId, parseJson<JsonObject>(inst.variables, {}), activeTokenId!)
      : parseJson<JsonObject>(inst.variables, {});
    return baseVars;
  };

  // 2. DRIVE ITERATIONS (index order; sequential stops at the first live one).
  //    `iterationState` is a pure D1 read: the iteration's job row. Task 9 adds
  //    the `errored` member (worker business error) + abortOnIterationError.
  let completed = 0;
  let live = 0;
  for (let i = 0; i < N; i++) {
    if (act.settled_kind && act.settled_kind !== "all") break; // early-settled: never start more
    const st = await iterationState(env, instanceId, elementId, occ, i, node);
    if (st === "completed") {
      completed++;
      continue;
    }
    // M5-L3 (Task 8): a settled-early leftover (an abandoned iteration job / a
    // discarded iteration token) is neither live nor completed — never re-drive
    // it. The settle decider's `break` above short-circuits a rewalk before this
    // point once settled, so this is the belt-and-braces classification that
    // keeps the drive honest even mid-settle-drive.
    if (st === "abandoned") continue;
    // Not started or in flight → drive one state forward via the per-kind driver.
    const r = await driveIteration(env, instanceId, graph, elementId, occ, node, i, N, runStep, items, resolveBase, activeTokenId, driveLeaf);
    if (r.kind === "incident") return r;
    if (r.kind === "errored") {
      // M5-L3 (Task 7 → Task 9 seam): a subProcess-body error end. Until Task 9
      // wires the MI-activity error routing (abort + drain + hierarchical bubble),
      // surface it as a loud operator-visible incident — the same shape Task 6
      // uses for an iteration business error (handleForwardFailure's `mi` branch).
      await runStep(miIterTag(`mi-iter-error:${tag}`, i), () =>
        createIncident(
          env,
          instanceId,
          elementId,
          0,
          `Multi-instance iteration ${i} raised an error end ('${r.errorCode}') in its subProcess body ` +
            "(MI iteration error routing opens with M5-L3 Task 9).",
          { elementId, iterationIndex: i, errorCode: r.errorCode, occurrence: occ },
          "serviceTaskFailure",
        ),
      );
      return { kind: "incident" };
    }
    if (r.kind === "completed") {
      completed++;
      const met = await maybeSettleOnCondition(env, instanceId, elementId, occ, node, act, i, completed, runStep, activeTokenId);
      if (met === "incident") return { kind: "incident" };
      if (met === "met") {
        act = (await getMiActivation(env.DB, instanceId, elementId, occ))!;
        continue;
      }
    } else {
      live++;
      if (spec.isSequential) break;
    }
  }

  // 3. SETTLE + APPLY (apply-once decider): all N settled, or an early-settle
  //    decider present. The `output_applied` predicate is read OUTSIDE the step.
  const settled = act.settled_kind != null || (completed >= N && live === 0);
  if (settled) {
    if (!act.output_applied) {
      await runStep(`mi-apply:${tag}`, () => applyMiCompletion(env, instanceId, elementId, occ, node, activeTokenId));
    }
    return { kind: "next", next: node.next! };
  }

  // 4. PARK — step-free re-park (Task 4 pattern): the predicate is read OUTSIDE
  //    any step, so a rewalk over an unchanged park is entirely step-free.
  const inst = await loadInst(env, instanceId);
  if (!(inst.status === "waiting" && inst.current_element_id === elementId)) {
    await runStep(`mi-park:${tag}`, () => parkMiWaiting(env, instanceId, elementId));
  }
  return { kind: "waiting" };
}

/**
 * The once-only activation decider (idempotent step body — an existing row is a
 * pure "ok"). Evaluates the cardinality source ONCE against the resolved base
 * scope: `loopCardinality` must yield a non-negative integer, `collection` a
 * list (pinned as the `items` snapshot). Failures are `conditionFailure`
 * incidents; a cardinality above the body-aware cap is a `miCardinality`
 * incident — both BEFORE any row/job is written. N = 0 settles `'all'` in the
 * SAME batch, so the driver's step 3 applies immediately on this very drive.
 */
async function activateMi(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  node: GraphNode,
  activeTokenId?: string,
): Promise<"ok" | "incident"> {
  if (await getMiActivation(env.DB, instanceId, elementId, occ)) return "ok"; // idempotent step re-run

  const spec = node.multiInstance!;
  const inst = await loadInst(env, instanceId);
  const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
  const base = isBranch
    ? await resolveScope(env, instanceId, parseJson<JsonObject>(inst.variables, {}), activeTokenId!)
    : parseJson<JsonObject>(inst.variables, {});

  let cardinality: number;
  let items: unknown[] | null = null;
  try {
    if (spec.collection != null) {
      const value = evaluateCondition(spec.collection, base).value;
      if (!Array.isArray(value)) {
        await createIncident(
          env,
          instanceId,
          elementId,
          0,
          `Multi-instance collection '${spec.collection}' did not evaluate to a list (got ${JSON.stringify(normalizeFeelValue(value))}).`,
          { expression: spec.collection, value: normalizeFeelValue(value), occurrence: occ },
          "conditionFailure",
        );
        return "incident";
      }
      items = value;
      cardinality = value.length;
    } else {
      const value = evaluateCondition(spec.loopCardinality!, base).value;
      const n = normalizeFeelValue(value);
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
        await createIncident(
          env,
          instanceId,
          elementId,
          0,
          `Multi-instance loopCardinality '${spec.loopCardinality}' did not evaluate to a non-negative integer (got ${JSON.stringify(n)}).`,
          { expression: spec.loopCardinality, value: n, occurrence: occ },
          "conditionFailure",
        );
        return "incident";
      }
      cardinality = n;
    }
  } catch (err) {
    if (err instanceof ExpressionEvaluationError) {
      await createIncident(
        env,
        instanceId,
        elementId,
        0,
        `Multi-instance cardinality expression failed to evaluate: ${err.message}`,
        { expression: spec.collection ?? spec.loopCardinality, occurrence: occ },
        "conditionFailure",
      );
      return "incident";
    }
    throw err;
  }

  // Runtime body-aware cap (design §6): cardinality is DATA, so unlike the other
  // depth caps this one cannot be a publish-time reject.
  const cap = effectiveMiCap(env, spec.bodyStepCost);
  if (cardinality > cap) {
    await createIncident(
      env,
      instanceId,
      elementId,
      0,
      `Multi-instance cardinality ${cardinality} exceeds the body-aware cap ${cap} (MAX_MI_CARDINALITY = ${MAX_MI_CARDINALITY}).`,
      { cardinality, cap, bodyStepCost: spec.bodyStepCost },
      "miCardinality",
    );
    return "incident";
  }

  const now = nowIso();
  const stmts: D1PreparedStatement[] = [
    insertMiActivationStmt(env.DB, { instanceId, elementId, occurrence: occ, cardinality, isSequential: spec.isSequential, items, now }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "miActivated",
      diagnostics: { cardinality, isSequential: spec.isSequential, hasCollection: items != null, occurrence: occ, ...branchHistoryTags(activeTokenId) },
    }),
  ];
  // N = 0: born settled — 'all' with zero completions, in the SAME batch.
  if (cardinality === 0) {
    stmts.push(settleMiActivationStmt(env.DB, { instanceId, elementId, occurrence: occ, kind: "all", count: 0, now }));
  }
  await dbBatch(env.DB, stmts);
  return "ok";
}

/**
 * Pure D1 read of one iteration's state (Task 10: the child_instances row):
 *   - serviceTask body: the iteration's job row — `output_applied=1` on a
 *     completed job ⇔ the iteration finished and its outcome was persisted.
 *   - subProcess body (Task 7): the iteration's `mi#` token — `consumed` ⇔ the
 *     body sub-walk reached the inner none-end (`mi-iter-done`). Any other status
 *     (or no token yet) still needs driving. Iteration identity lives in the
 *     token id + the strided interior occurrence, NOT a single job row.
 * `output_applied=1` on a completed job ⇔ the iteration finished and its
 * outcome was persisted; anything else still needs driving.
 */
async function iterationState(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  i: number,
  node: GraphNode,
): Promise<"completed" | "pending" | "abandoned"> {
  if (node.type === "subProcess") {
    const tok = await getToken(env.DB, miTokenId(instanceId, elementId, occ, i));
    if (tok?.status === "consumed") return "completed";
    // Task 8: a `discarded` iteration token is a settled-early leftover — the
    // cancel-remaining teardown marked it (NORMAL, non-compensating). Neither
    // live nor completed on rewalk.
    if (tok?.status === "discarded") return "abandoned";
    return "pending";
  }
  const job = await getForwardJob(env.DB, instanceId, elementId, occ, i);
  if (job?.status === "completed" && job.output_applied === 1) return "completed";
  // Task 8: an MI iteration job reaches `failed` ONLY through cancel-remaining's
  // terminal-abandon (iteration business-error routing opens in Task 9) — a
  // settled-early leftover, classified `abandoned` so a rewalk never re-drives it.
  if (job?.status === "failed") return "abandoned";
  return "pending";
}

/**
 * Drive ONE iteration one state forward.
 *   - serviceTask body: delegates to the forward-task triad with the `mi` thread
 *     (iteration-tagged step names/keys, the pinned per-iteration input override,
 *     NO advancement from its apply path); the triad's own fast-forwards do the rest.
 *   - subProcess body (Task 7): the iteration-token + body sub-walk below.
 *   - callActivity body: opens with Task 10 — until then a loud operator-visible
 *     incident instead of a silent wedge (the validator accepts it since Task 2).
 */
async function driveIteration(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  i: number,
  N: number,
  runStep: RunStep,
  items: unknown[] | null,
  resolveBase: () => Promise<JsonObject>,
  activeTokenId?: string,
  driveLeaf?: MiLeafDriver,
): Promise<IterationOutcome> {
  if (node.type === "subProcess") {
    if (!driveLeaf) {
      // The walk driver failed to thread the leaf dispatch — fail LOUD rather than
      // silently wedge (unreachable via engine.ts, which always threads it).
      throw new Error(`Invariant violation: MI subProcess '${elementId}' driven without a driveLeaf (walk-driver threading missing).`);
    }
    return driveSubProcessIteration(env, instanceId, graph, elementId, occ, node, i, N, runStep, items, resolveBase, activeTokenId, driveLeaf);
  }
  if (node.type !== "serviceTask") {
    return await runStep(miIterTag(`mi-body-unsupported:${elementId}#${occ}`, i), () =>
      createIncident(
        env,
        instanceId,
        elementId,
        0,
        `Multi-instance over a '${node.type}' body is not yet driven (M5-L3 opens callActivity in Task 10).`,
        { elementId, nodeType: node.type, iterationIndex: i },
        "serviceTaskFailure",
      ),
    );
  }
  const base = await resolveBase();
  const r = await driveForwardServiceTask(env, instanceId, graph, elementId, occ, node, runStep, null, activeTokenId, {
    iterationIndex: i,
    inputOverride: iterationContext(base, node.multiInstance!, items, i),
  });
  if (r.kind === "next") return { kind: "completed" };
  if (r.kind === "incident") return { kind: "incident" };
  return { kind: "waiting" };
}

/**
 * Drive ONE subProcess MI iteration's body one state forward (M5-L3 Task 7 — the
 * core of MI-over-subProcess). The design (controller decision, superseding the
 * brief's shared-nextOcc approach):
 *
 * STRIDED INTERIOR OCCURRENCES `occ = k*N + i`. Interior keys (gateway_decisions
 * UNIQUE on (instance, element, occurrence); interior jobs/saga_steps at
 * iteration_index 0) carry NO iteration dimension, so a progress-ordered shared
 * counter over concurrent iterations of the SAME body elements would let one
 * iteration adopt another's gateway decision / job. Instead each interior element
 * visit gets `occ = k*N + i` where N = the pinned cardinality, i = this iteration
 * index, and k = a PER-ITERATION per-element visit counter derived by RE-WALKING
 * the body from `scope.startId` on EVERY drive (never resumed from the token's
 * saved position — a mid-cycle resume would restart k at 0 and collide). Because
 * i is fixed and k re-derives deterministically each rewalk, an interior element's
 * occurrence is a PURE function of (i, k) — replay-stable and independent of the
 * progress/completion order of sibling iterations. First lap: k=0 → the interior
 * occurrence is exactly i.
 *
 * The token's `position_element_id` is OBSERVABILITY state (updated as the walk
 * advances) — NEVER the walk's source of truth. Interior variable writes land in
 * the `mi#i` token overlay (branch-scoped), so root vars are untouched until the
 * driver's `mi-apply` aggregates the whole overlay index-ordered.
 */
async function driveSubProcessIteration(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  i: number,
  N: number,
  runStep: RunStep,
  items: unknown[] | null,
  resolveBase: () => Promise<JsonObject>,
  activeTokenId: string | undefined,
  driveLeaf: MiLeafDriver,
): Promise<IterationOutcome> {
  const spec = node.multiInstance!;
  const tag = `${elementId}#${occ}`;
  const tokenId = miTokenId(instanceId, elementId, occ, i);
  const parentTokenId = activeTokenId ?? rootTokenId(instanceId);
  const scope = scopesOf(graph)[elementId];
  const startId = scope?.startId;
  if (!startId) throw new Error(`Invariant violation: MI subProcess '${elementId}' has no miBody scope startId (validator guards this).`);

  // Token status is read OUTSIDE any step (the step-memoization discipline): a
  // consumed iteration token is a pure fast-forward — the body already reached its
  // inner none-end on an earlier drive.
  let tok = await getToken(env.DB, tokenId);
  if (tok?.status === "consumed") return { kind: "completed" };

  // Mint the iteration token (once — the `getToken` guard makes a rewalk step-free):
  // status 'active', position = the inner start, overlay = the pinned iteration
  // context (base scope + item + loopCounter). region_id null; parent = the
  // caller's token (a branch token under an M4 split, else root); branch leg `mi#i`
  // so all M4 token machinery (parse/tags/overlays) + the frontier `mi#` filter
  // apply unchanged. No extra history — the token row is the record.
  if (!tok) {
    const base = await resolveBase();
    const overlay = iterationContext(base, spec, items, i);
    await runStep(`mi-iter:${miIterTag(tag, i)}`, () =>
      upsertTokenStmt(env.DB, {
        tokenId,
        instanceId,
        regionId: null,
        parentTokenId,
        branchFlowId: `mi#${i}`,
        positionElementId: startId,
        status: "active",
        variablesOverlay: overlay,
        now: nowIso(),
      }).run(),
    );
    tok = await getToken(env.DB, tokenId);
  }

  // Re-walk the body from `startId` on a FRESH per-iteration visit counter each
  // drive (`k`), striding interior occurrences to `k*N + i`.
  const bodyVisits = new Map<string, number>();
  const nextInteriorOcc = (id: string): number => {
    const k = bodyVisits.get(id) ?? 0;
    bodyVisits.set(id, k + 1);
    return k * N + i;
  };

  let cur = startId;
  while (true) {
    const bnode = graph.nodes[cur];
    if (!bnode) throw new Error(`Invariant violation: MI body walk of '${elementId}' left the graph at '${cur}' (validator guards body wiring).`);
    const occI = nextInteriorOcc(cur);
    // In-body cycles consume k*N interior occurrences per lap, so a high-N MI body
    // trips the loop cap conservatively earlier — deliberate + bounded (design §6);
    // this is why MAX_ELEMENT_OCCURRENCES is imported here.
    if (occI >= MAX_ELEMENT_OCCURRENCES) {
      await runStep(miIterTag(`mi-body-loop-limit:${elementId}#${cur}#${occ}`, i), () =>
        createIncident(
          env,
          instanceId,
          elementId,
          0,
          `Multi-instance body element '${cur}' exceeded the loop-iteration cap (${MAX_ELEMENT_OCCURRENCES} strided visits) in iteration ${i}.`,
          { elementId, bodyElement: cur, occurrence: occI, iterationIndex: i, cap: MAX_ELEMENT_OCCURRENCES },
          "loopLimit",
        ),
      );
      return { kind: "incident" };
    }

    // Intercept the inner NONE-START: skip straight to its outgoing flow. NO
    // enterStart / instanceStarted bookkeeping per iteration — `scopeKindOf`
    // returns null for a miBody scope, so a naive `driveLeaf` on the inner start
    // would take the PROCESS-level start path and spuriously re-audit
    // instanceStarted; the driver owns entry.
    if (bnode.type === "startEvent" && bnode.scopeId === elementId) {
      cur = bnode.next!;
      continue;
    }

    // Intercept the inner END event (scoped to THIS miBody) BEFORE driveLeaf —
    // `scopeKindOf` returns null for a miBody, so driveLeaf's endEvent handler
    // would take the process-level none-end path and complete the whole instance.
    if (bnode.type === "endEvent" && bnode.scopeId === elementId) {
      if (bnode.endKind === "error") {
        // TASK 9 SEAM: an error end in the body → surface a typed marker so the
        // main loop routes it as an MI-activity error (abort + drain + bubble).
        // Do NOT implement the abort here.
        return { kind: "errored", errorCode: bnode.errorCode ?? null };
      }
      // Inner none-end → the iteration completes. Idempotence guard: re-read the
      // token status OUTSIDE the step; skip when already consumed.
      const live = await getToken(env.DB, tokenId);
      if (live?.status !== "consumed") {
        await runStep(`mi-iter-done:${miIterTag(tag, i)}`, async () => {
          const inst = await loadInst(env, instanceId);
          const now = nowIso();
          await dbBatch(env.DB, [
            setTokenStatusStmt(env.DB, tokenId, "consumed", now),
            historyStmt(env.DB, {
              workspaceId: inst.workspace_id,
              instanceId,
              elementId,
              type: "miIterationCompleted",
              diagnostics: { iterationIndex: i, occurrence: occ, ...branchHistoryTags(parentTokenId) },
            }),
          ]);
        });
      }
      return { kind: "completed" };
    }

    // Interior LEAF — drive through the engine's shared `driveLeaf` on the `mi#i`
    // token, at the STRIDED occurrence. INTERIOR ROWS STAY iteration_index=0
    // (jobs/saga_steps/gateway_decisions): iteration identity lives in the strided
    // occurrence, not the iteration column (the plain leaf path the driver reuses
    // has no iteration dimension). The v1 body whitelist (serviceTask / exclusive
    // gateway / timer catch / none-or-error end) excludes region splits and
    // tx/compensate ends, so driveLeaf never returns completed/consumed/compensate.
    const r = await driveLeaf(cur, occI, tokenId);
    if (r.kind === "next") {
      cur = r.next;
      continue;
    }
    if (r.kind === "parked") {
      // Advance the token's OBSERVABILITY position to the parked leaf — guarded so
      // a write-free rewalk over an unchanged park never churns the token row
      // (updated_at stays put; the cold-re-drive idempotency assertion depends on
      // it). upsert's ON CONFLICT touches only position/status/updated_at — the
      // accumulated interior overlay is preserved.
      if (tok && tok.position_element_id !== cur) {
        await upsertTokenStmt(env.DB, {
          tokenId,
          instanceId,
          regionId: null,
          parentTokenId,
          branchFlowId: `mi#${i}`,
          positionElementId: cur,
          status: "active",
          variablesOverlay: parseOverlay(tok),
          now: nowIso(),
        }).run();
      }
      return { kind: "waiting" };
    }
    if (r.kind === "incident") return { kind: "incident" };
    // completed / consumed / compensate — impossible under the v1 body whitelist.
    throw new Error(`Invariant violation: MI body leaf '${cur}' of '${elementId}' returned '${r.kind}' — the v1 whitelist forbids region/tx/compensate bodies.`);
  }
}

/**
 * completionCondition early settle (declared only; evaluated when an iteration
 * JUST completed within this drive — never re-evaluated for fast-forwarded
 * iterations). True → the once-only `mi-settle` step commits the CAS decider +
 * the `miCompletionConditionMet` audit in one batch (Task 8 rides its
 * cancel-remaining — job abandon / child cancel / token discard — on the same
 * batch; in Task 6 the decider alone stops new iteration starts). A hard FEEL
 * failure → `conditionFailure` incident.
 */
async function maybeSettleOnCondition(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  node: GraphNode,
  act: MiActivationRow,
  i: number,
  completedCount: number,
  runStep: RunStep,
  activeTokenId?: string,
): Promise<"met" | "not-met" | "incident"> {
  const spec = node.multiInstance!;
  if (!spec.completionCondition || act.settled_kind != null) return "not-met";
  const tag = `${elementId}#${occ}`;

  const inst = await loadInst(env, instanceId);
  const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
  const base = isBranch
    ? await resolveScope(env, instanceId, parseJson<JsonObject>(inst.variables, {}), activeTokenId!)
    : parseJson<JsonObject>(inst.variables, {});
  const job = await getForwardJob(env.DB, instanceId, elementId, occ, i);
  const iterationOutput = job?.output_variables ? parseJson<JsonObject>(job.output_variables, {}) : {};
  const liveNow = await countActiveIterations(env, instanceId, elementId, occ, node, act.cardinality);

  let taken: boolean;
  try {
    taken = evaluateCondition(spec.completionCondition, {
      ...base,
      ...iterationOutput,
      nrOfInstances: act.cardinality,
      nrOfCompletedInstances: completedCount,
      nrOfActiveInstances: liveNow,
    }).taken;
  } catch (err) {
    if (err instanceof ExpressionEvaluationError) {
      await runStep(miIterTag(`mi-cond-fail:${tag}`, i), () =>
        createIncident(
          env,
          instanceId,
          elementId,
          0,
          `Multi-instance completionCondition failed to evaluate: ${err.message}`,
          { expression: spec.completionCondition, iterationIndex: i, occurrence: occ },
          "conditionFailure",
        ),
      );
      return "incident";
    }
    throw err;
  }
  if (!taken) return "not-met";

  // Task 8: cancel-remaining — sweep the NOT-finished iterations OUTSIDE the step
  // (the step-memoization discipline: every write is gated on a D1 read taken
  // outside `runStep`), then ride the abandon/discard statements on the SAME
  // batch as the settle decider. This is a NORMAL, non-compensating frontier
  // teardown: in-flight serviceTask iteration jobs are terminal-abandoned (a
  // late worker callback then no-ops), live subProcess iteration tokens are
  // marked `discarded`. NEVER ledgerStragglers, NEVER a compensation job — the
  // finished iterations' `pending` ledger rows are retained untouched (they
  // compensate only if an enclosing transaction later cancels); the discarded
  // iterations ledger nothing. This is the flagship non-compensating invariant.
  const teardown = await sweepCancelRemaining(env, instanceId, elementId, occ, node, act.cardinality);

  await runStep(`mi-settle:${tag}@${i}`, async () => {
    const now = nowIso();
    await dbBatch(env.DB, [
      // The CAS guard (WHERE settled_kind IS NULL) makes the FIRST settle win —
      // a replay / racing evaluation flips 0 rows and is harmless audit noise.
      settleMiActivationStmt(env.DB, { instanceId, elementId, occurrence: occ, kind: "condition", count: completedCount, now }),
      historyStmt(env.DB, {
        workspaceId: inst.workspace_id,
        instanceId,
        elementId,
        type: "miCompletionConditionMet",
        diagnostics: { completedCount, iterationIndex: i, occurrence: occ, ...branchHistoryTags(activeTokenId) },
      }),
      // Cancel-remaining rides the settle batch (atomic with the decider): a
      // replay re-runs the same idempotent UPDATEs (abandon touches only
      // created|locked, discard only live tokens) — 0-row no-ops the second time.
      ...teardown.abandonJobIds.map((jobId) => abandonJobOnTimerFireStmt(env.DB, jobId, now)),
      ...teardown.discardTokenIds.map((tokenId) => setTokenStatusStmt(env.DB, tokenId, "discarded", now)),
    ]);
  });
  // An in-flight MI-callActivity iteration child cannot ride a single dbBatch —
  // `cancelChildCascade` is multi-statement and terminates the child Workflow —
  // so cascade-cancel AFTER the settle commits (retention, NOT compensation; its
  // ledger is left untouched, exactly like a scope-timer Hazard drain). Task 10
  // wires MI-callActivity iteration bodies; until then this list is empty, so
  // the loop is a typed seam rather than dead behaviour.
  for (const childId of teardown.cancelChildIds) {
    await cancelChildCascade(env, childId);
  }
  return "met";
}

/**
 * The NORMAL (non-compensating) cancel-remaining sweep (Task 8): for each
 * NOT-finished iteration of this visit, collect the plain frontier-teardown
 * target — an in-flight serviceTask iteration job to terminal-abandon, a live
 * subProcess iteration token to discard, or (Task 10) an in-flight MI-
 * callActivity child to cascade-cancel. A completed/consumed iteration (incl.
 * the one that JUST triggered the settle) never matches the live-status filters,
 * so no index needs skipping. Pure D1 reads — issued OUTSIDE the settle step;
 * the collected statements/ids commit inside it.
 */
async function sweepCancelRemaining(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  node: GraphNode,
  N: number,
): Promise<{ abandonJobIds: string[]; discardTokenIds: string[]; cancelChildIds: string[] }> {
  const abandonJobIds: string[] = [];
  const discardTokenIds: string[] = [];
  const cancelChildIds: string[] = [];
  for (let j = 0; j < N; j++) {
    if (node.type === "subProcess") {
      const tok = await getToken(env.DB, miTokenId(instanceId, elementId, occ, j));
      if (tok && isLiveTokenStatus(tok.status)) discardTokenIds.push(tok.token_id);
    } else if (node.type === "callActivity") {
      // TODO(Task 10): getChildInstanceForVisit(instance, el, occ, j) → push a
      // non-terminal child_instance id here; the caller cascade-cancels it after
      // the settle batch. MI-callActivity iteration bodies aren't driven yet, so
      // no child rows exist for this visit and the sweep collects nothing.
    } else {
      const job = await getForwardJob(env.DB, instanceId, elementId, occ, j);
      if (job && (job.status === "created" || job.status === "locked")) abandonJobIds.push(job.job_id);
    }
  }
  return { abandonJobIds, discardTokenIds, cancelChildIds };
}

/** A token that still participates in the frontier (mirrors the mi-apply teardown IN-list). */
function isLiveTokenStatus(status: string): boolean {
  return status === "active" || status === "waiting" || status === "arrivedAtJoin";
}

/**
 * `nrOfActiveInstances` for the completionCondition context — body-aware: the
 * count of iterations still in flight at evaluation time. serviceTask bodies
 * count in-flight (created|locked) iteration jobs; subProcess bodies count live
 * iteration tokens (their in-flight work is INTERIOR, not a job at the MI
 * element). Only consulted when a completionCondition is declared.
 */
async function countActiveIterations(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  node: GraphNode,
  N: number,
): Promise<number> {
  if (node.type === "subProcess") {
    let n = 0;
    for (let j = 0; j < N; j++) {
      const tok = await getToken(env.DB, miTokenId(instanceId, elementId, occ, j));
      if (tok && isLiveTokenStatus(tok.status)) n++;
    }
    return n;
  }
  const row = await stmt(
    env.DB,
    `SELECT COUNT(*) AS n FROM service_task_jobs
      WHERE instance_id = ? AND element_id = ? AND is_compensation = 0 AND occurrence = ?
        AND status IN ('created', 'locked')`,
    [instanceId, elementId, occ],
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The apply-once aggregation merge + advance (idempotent step body — the
 * `output_applied` CAS re-read guards a step retry). Collects iteration outputs
 * INDEX-ORDERED from the job rows (null at indexes an early settle never
 * finished), merges `{[outputVariable]: outputs}` into the caller's scope —
 * branch overlay vs root, the applyChildTerminal split — and advances. The
 * all-iterations path settles the `'all'` decider in the SAME batch (the CAS
 * guard keeps an earlier 'condition' settle authoritative). Without an
 * `outputVariable` the transition still advances.
 */
async function applyMiCompletion(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  node: GraphNode,
  activeTokenId?: string,
): Promise<void> {
  const act = await getMiActivation(env.DB, instanceId, elementId, occ);
  if (!act) throw new Error(`Invariant violation: mi-apply without an mi_activations row (${elementId}#${occ}).`);
  if (act.output_applied) return; // idempotent step re-run

  const spec = node.multiInstance!;
  const inst = await loadInst(env, instanceId);
  const N = act.cardinality;

  // Iteration outputs, INDEX-ORDERED (null at indexes an early settle never
  // finished — "collects only the k finished iterations by index"):
  //   - serviceTask body: the iteration job's output variables.
  //   - subProcess body (Task 7): the consumed `mi#i` token's FINAL overlay — the
  //     WHOLE overlay (the pinned iteration context + every interior write), read
  //     R2-aware. DECISION (design §5): the subProcess-iteration aggregate is the
  //     token's whole final overlay, not a nominated slice — the body has no single
  //     "output job", and the overlay IS the iteration's accumulated scope.
  const outputs: (JsonObject | null)[] = [];
  let completedCount = 0;
  for (let i = 0; i < N; i++) {
    if (node.type === "subProcess") {
      const tok = await getToken(env.DB, miTokenId(instanceId, elementId, occ, i));
      if (tok?.status === "consumed") {
        outputs.push(await readOverlay(env, parseOverlay(tok)));
        completedCount++;
      } else {
        outputs.push(null);
      }
      continue;
    }
    const job = await getForwardJob(env.DB, instanceId, elementId, occ, i);
    if (job?.status === "completed" && job.output_applied === 1) {
      outputs.push(job.output_variables ? parseJson<JsonObject>(job.output_variables, {}) : {});
      completedCount++;
    } else {
      outputs.push(null);
    }
  }

  const now = nowIso();
  const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
  const settledKind = act.settled_kind ?? "all";

  const stmts: D1PreparedStatement[] = [markMiOutputAppliedStmt(env.DB, { instanceId, elementId, occurrence: occ, now })];
  if (act.settled_kind == null) {
    stmts.push(settleMiActivationStmt(env.DB, { instanceId, elementId, occurrence: occ, kind: "all", count: completedCount, now }));
  }

  // Variable write — the applyChildTerminal root-vs-branch split
  // (call-activity.ts:272-282): a branch token's aggregate goes to its OWN
  // overlay (root vars mutate only at the join fold-up); the root/single-token
  // path merges into process_instances.variables and pins the cursor on `next`.
  if (spec.outputVariable != null) {
    if (isBranch) {
      const tokenRow = await getToken(env.DB, activeTokenId!);
      const baseVars = tokenRow ? await readOverlay(env, parseOverlay(tokenRow)) : {};
      const merged = mergeVariables(baseVars, { [spec.outputVariable]: outputs });
      const stored = await writeOverlay(env, instanceId, activeTokenId!, merged);
      stmts.push(
        setTokenOverlayStmt(env.DB, activeTokenId!, stored, now),
        applyTransitionStmt(env.DB, { instanceId, currentElementId: null, status: "running", now }),
      );
    } else {
      const merged = mergeVariables(parseJson<JsonObject>(inst.variables, {}), { [spec.outputVariable]: outputs });
      stmts.push(applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: node.next, status: "running", now }));
    }
  } else {
    stmts.push(
      isBranch
        ? applyTransitionStmt(env.DB, { instanceId, currentElementId: null, status: "running", now })
        : applyTransitionStmt(env.DB, { instanceId, currentElementId: node.next, status: "running", now }),
    );
  }

  stmts.push(
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId,
      type: "miCompleted",
      diagnostics: { cardinality: N, completedCount, settledKind, occurrence: occ, ...branchHistoryTags(activeTokenId) },
    }),
  );
  // Iteration-token teardown: flip any still-live `mi#` iteration token of THIS
  // visit to consumed atomically with the apply. EXACT token-id IN-list (not a
  // `LIKE '…:mi#%'` pattern — a `_` in an element id is a LIKE wildcard, which
  // could false-match a sibling element like `my_task`): the ids are deterministic
  // (`miTokenId(instanceId, elementId, occ, i)` for i in 0..N-1). A serviceTask
  // body (Task 6) mints no iteration tokens, so this is a 0-row no-op there; a
  // subProcess body's tokens are already consumed by `mi-iter-done`, so this only
  // catches a still-live token at an EARLY settle (Task 8). Skipped for N=0 (no
  // iterations, and `IN ()` is a SQL syntax error).
  if (N > 0) {
    const iterTokenIds = Array.from({ length: N }, (_, i) => miTokenId(instanceId, elementId, occ, i));
    stmts.push(
      stmt(
        env.DB,
        `UPDATE execution_tokens SET status = 'consumed', updated_at = ?
          WHERE instance_id = ? AND status IN ('active', 'waiting', 'arrivedAtJoin')
            AND token_id IN (${iterTokenIds.map(() => "?").join(", ")})`,
        [now, instanceId, ...iterTokenIds],
      ),
    );
  }
  await dbBatch(env.DB, stmts);
}

/**
 * MI park (the Task 4 step-free pattern's write side): status `waiting` with the
 * cursor on the MI element. Idempotent — a re-run over an unchanged park is a
 * no-op (the driver's outside-step guard normally elides the step entirely; this
 * inner guard covers a step retry). No dedicated history event: the MI audit
 * timeline is miActivated → miIterationCompleted* → (miCompletionConditionMet) →
 * miCompleted (the brief's contract), and the iteration jobs carry their own
 * created/waiting audit.
 */
async function parkMiWaiting(env: Env, instanceId: string, elementId: string): Promise<void> {
  const inst = await loadInst(env, instanceId);
  if (inst.status === "waiting" && inst.current_element_id === elementId) return;
  await applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now: nowIso() }).run();
}
