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
  writeOverlay,
} from "../persistence/tokens";
import { loadInst, type RunStep } from "./engine-shared";
import { createIncident } from "./incidents";
import { resolveScope } from "./frontier";
import { ExpressionEvaluationError, evaluateCondition, normalizeFeelValue } from "./expressions";
import { driveForwardServiceTask } from "./forward-task";
import { timerBoundaryFor, timerHasFired } from "./boundary-timer";
// Static cycle engine ⇄ multi-instance is deliberate and safe (the same shape as
// the existing engine → call-activity → executor → engine cycle): only function
// bindings are accessed, and only at call time — never during module init.
import { MAX_MI_CARDINALITY, maxMiCardinality, stepBudgetSoft } from "./engine";

export type MiOutcome = { kind: "next"; next: string } | { kind: "waiting" } | { kind: "incident" };

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

type IterationOutcome = { kind: "completed" } | { kind: "waiting" } | { kind: "incident" };

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
    const st = await iterationState(env, instanceId, elementId, occ, i);
    if (st === "completed") {
      completed++;
      continue;
    }
    // Not started or in flight → drive one state forward via the per-kind driver.
    const r = await driveIteration(env, instanceId, graph, elementId, occ, node, i, runStep, items, resolveBase, activeTokenId);
    if (r.kind === "incident") return r;
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
 * Pure D1 read of one iteration's state — the iteration's job row for a
 * serviceTask body (Task 7: subProcess iteration token + marker; Task 10: the
 * child_instances row; Task 9 adds the `errored` member for a business error).
 * `output_applied=1` on a completed job ⇔ the iteration finished and its
 * outcome was persisted; anything else still needs driving.
 */
async function iterationState(
  env: Env,
  instanceId: string,
  elementId: string,
  occ: number,
  i: number,
): Promise<"completed" | "pending"> {
  const job = await getForwardJob(env.DB, instanceId, elementId, occ, i);
  if (job?.status === "completed" && job.output_applied === 1) return "completed";
  return "pending";
}

/**
 * Drive ONE iteration one state forward. A serviceTask body delegates to the
 * forward-task triad with the `mi` thread (iteration-tagged step names/keys,
 * the pinned per-iteration input override, NO advancement from its apply path);
 * the triad's own fast-forwards do the rest. subProcess/callActivity bodies
 * open with Tasks 7/10 — until then they settle a loud operator-visible
 * incident instead of a silent wedge (the validator accepts them since Task 2).
 */
async function driveIteration(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  i: number,
  runStep: RunStep,
  items: unknown[] | null,
  resolveBase: () => Promise<JsonObject>,
  activeTokenId?: string,
): Promise<IterationOutcome> {
  if (node.type !== "serviceTask") {
    return await runStep(miIterTag(`mi-body-unsupported:${elementId}#${occ}`, i), () =>
      createIncident(
        env,
        instanceId,
        elementId,
        0,
        `Multi-instance over a '${node.type}' body is not yet driven (M5-L3 opens it in Tasks 7/10).`,
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
  const liveNow = await countInFlightIterationJobs(env, instanceId, elementId, occ);

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
      // Task 8: cancel-remaining statements ride this batch.
    ]);
  });
  return "met";
}

/** In-flight (created|locked) iteration jobs of this visit — `nrOfActiveInstances`. */
async function countInFlightIterationJobs(env: Env, instanceId: string, elementId: string, occ: number): Promise<number> {
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

  const outputs: (JsonObject | null)[] = [];
  let completedCount = 0;
  for (let i = 0; i < N; i++) {
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
    // Iteration-token teardown: flip any still-live `mi#` iteration token of
    // THIS visit to consumed atomically with the apply. A serviceTask body
    // (Task 6) creates no iteration tokens, so this is a 0-row no-op until the
    // Task 7 subProcess sub-walk starts minting them (miTokenId).
    stmt(
      env.DB,
      `UPDATE execution_tokens SET status = 'consumed', updated_at = ?
        WHERE instance_id = ? AND status IN ('active', 'waiting', 'arrivedAtJoin')
          AND token_id LIKE ?`,
      [now, instanceId, `${instanceId}:${elementId}#${occ}:mi#%`],
    ),
  );
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
