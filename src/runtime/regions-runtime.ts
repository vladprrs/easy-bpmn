// Concurrent-region runtime (M4-L3/L4): split fan-out, join arrival/completion
// claim, and the deterministic merge-at-join. All race-claimed via a plain INSERT
// into join_completions composed in the advance batch (the gateway_decisions
// discipline, gateway-decisions.ts:70-84). execution_tokens is a read-model; the
// join facts (join_arrivals / join_completions) are the truth.

import type { Env } from "../env";
import type { ExecutionGraph, RegionInfo } from "../bpmn/graph";
import { mergeVariables, newId, nowIso, parseJson, type JsonObject } from "../util";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import { applyTransitionStmt } from "../persistence/instances";
import { getGatewayDecision, insertGatewayDecisionStmt, type GatewayFlowEvaluation } from "../persistence/gateway-decisions";
import {
  branchTokenId,
  foldTokenOverlayStmt,
  getJoinArrivals,
  getJoinCompletion,
  getToken,
  insertBranchTokenStmt,
  insertJoinArrivalStmt,
  insertJoinCompletionStmt,
  parseOverlay,
  readOverlay,
  rootTokenId,
  setTokenStatusStmt,
  upsertTokenStmt,
  writeOverlay,
} from "../persistence/tokens";
import { loadInst } from "./engine-shared";
import { evaluateCondition, normalizeFeelValue, ExpressionEvaluationError } from "./expressions";
import { createIncident } from "./incidents";
import { resolveScope } from "./frontier";
import { MAX_EVENT_PAYLOAD_BYTES, payloadByteSize } from "./payload";

/**
 * Deterministic merge (design §5.7): start from the parent overlay, then for each
 * required branch in split-out-flow DOCUMENT order (`order` = the region's stored
 * `branchFlowIds`), shallow-assign its top-level keys (later branch wins). The
 * `branches` array may be a SUBSET (an OR join) and may be in any array order —
 * the stored `order` alone fixes precedence. Shallow (top-level union), matching
 * `mergeVariables`.
 */
export function mergeBranchOverlays(
  parentOverlay: JsonObject,
  order: string[],
  branches: { branchFlowId: string; overlay: JsonObject }[],
): JsonObject {
  const byFlow = new Map(branches.map((b) => [b.branchFlowId, b.overlay]));
  let merged: JsonObject = { ...parentOverlay };
  for (const flowId of order) {
    const ov = byFlow.get(flowId);
    if (ov) merged = mergeVariables(merged, ov);
  }
  return merged;
}

/** The branch flows activated at a split + the statements that RECORD that decision. */
export interface ActivationResult {
  /** The activated out-flows in document order (AND = all branchFlowIds; OR = the true/default subset). */
  activated: string[];
  /**
   * The plain INSERT of the `gateway_decisions` activation row (OR split, first
   * visit) — composed into the SAME fan-out batch so the activation record +
   * branch tokens commit atomically (sharing the fan-out's race claim). Empty
   * for AND, and for an OR rewalk that reused a recorded decision.
   */
  recordStmts: D1PreparedStatement[];
  /** True when the split bailed into a terminal incident (noPath / conditionFailure); the branch must not fan out. */
  incident?: boolean;
}

/**
 * The branch flows ACTIVATED at a split (design §6.1).
 *
 * AND (design §5.4): always all the region's out-flows (the static
 * `branchFlowIds`); nothing recorded.
 *
 * OR (L4): if a `gateway_decisions` row already exists for `(instance, split,
 * occurrence)`, its recorded `activatedFlowIds` is reused VERBATIM — conditions
 * are never re-evaluated even if variables changed (the exact `exclusiveGateway`
 * contract). Otherwise each non-default out-flow's FEEL condition is evaluated in
 * DOCUMENT order against the token-resolved scope; the true set is the
 * activation, falling back to the gateway's `default` when the true set is empty.
 * No condition true and no default → terminal `noPath` (an inclusive split never
 * silently drops its token); a hard FEEL failure → terminal `conditionFailure`.
 * The recorded decision is returned as `recordStmts` for atomic commit inside the
 * fan-out batch — never written here (so a losing concurrent fan-out aborts
 * wholesale on the shared claim and re-reads).
 */
export async function resolveActivatedFlows(env: Env, graph: ExecutionGraph, instanceId: string, region: RegionInfo, splitId: string, occ: number, activeTokenId: string): Promise<ActivationResult> {
  if (region.type === "and") return { activated: region.branchFlowIds, recordStmts: [] };

  // Rewalk fast-forward (design §6.1): reuse the recorded subset, never re-evaluate.
  const recorded = await getGatewayDecision(env.DB, instanceId, splitId, occ);
  if (recorded?.activatedFlowIds) return { activated: recorded.activatedFlowIds, recordStmts: [] };

  const node = graph.nodes[splitId]!;
  const inst = await loadInst(env, instanceId);
  // Branch-scoped reads (design §5.7): evaluate against the active token's resolved
  // overlay chain (root token ⇒ root variables verbatim).
  const scope = await resolveScope(env, instanceId, parseJson<JsonObject>(inst.variables, {}), activeTokenId);
  const activated: string[] = [];
  const evaluations: GatewayFlowEvaluation[] = [];
  let defaultFlowId: string | null = null;
  for (const f of node.outgoing) {
    if (f.isDefault) {
      defaultFlowId = f.flowId; // the no-match fallback, never evaluated
      continue;
    }
    const expr = f.conditionExpression;
    if (expr == null) {
      // Unreachable by construction: the publish gate requires a condition on
      // every non-default flow of an inclusive split, and versions are immutable.
      throw new Error(`Invariant violation: non-default flow '${f.flowId}' of inclusiveGateway '${splitId}' carries no condition expression.`);
    }
    let evaluation;
    try {
      evaluation = evaluateCondition(expr, scope);
    } catch (err) {
      if (err instanceof ExpressionEvaluationError) {
        await createIncident(env, instanceId, splitId, 0, `inclusiveGateway '${splitId}' condition on flow '${f.flowId}' failed to evaluate: ${err.message}`, { flowId: f.flowId, expression: expr, occurrence: occ }, "conditionFailure");
        return { activated: [], recordStmts: [], incident: true };
      }
      throw err;
    }
    evaluations.push({
      flowId: f.flowId,
      expression: expr,
      result: evaluation.taken,
      value: normalizeFeelValue(evaluation.value),
      ...(evaluation.warnings.length > 0 ? { warnings: evaluation.warnings } : {}),
    });
    if (evaluation.taken) activated.push(f.flowId); // OR: every true flow activates (no short-circuit)
  }
  if (activated.length === 0 && defaultFlowId) activated.push(defaultFlowId);
  if (activated.length === 0) {
    // noPath — terminal incident (Hazard inside a transaction): an inclusive
    // split with no true branch and no default never silently drops its token.
    await createIncident(env, instanceId, splitId, 0, `inclusiveGateway '${splitId}' activated no branch and has no default flow.`, { occurrence: occ, evaluations: evaluations.map((e) => ({ ...e })) }, "noPath");
    return { activated: [], recordStmts: [], incident: true };
  }

  // Record the RESOLVED evaluation scope for audit (design §5.7 — a gateway
  // evaluated inside a branch records its resolved snapshot), size-capped by the
  // payload limit exactly like the XOR path (engine.ts): an oversized context is
  // omitted (null) rather than erroring. The fast-forward predicate is
  // `activatedFlowIds` + `evaluations`, never the snapshot, so the cap is safe.
  const snapshotFits = payloadByteSize(scope) <= MAX_EVENT_PAYLOAD_BYTES;
  const recordStmts = [
    insertGatewayDecisionStmt(env.DB, {
      decisionId: newId("gwd"),
      instanceId,
      elementId: splitId,
      occurrence: occ,
      // chosen_flow_id holds the document-order-first activated flow as a sentinel (design §6.2).
      chosenFlowId: activated[0]!,
      isDefault: activated.length === 1 && activated[0] === defaultFlowId,
      evaluations,
      variablesSnapshot: snapshotFits ? scope : null,
      activatedFlowIds: activated,
      now: nowIso(),
    }),
  ];
  return { activated, recordStmts };
}

/**
 * The branch flows REQUIRED at the join (design §6.3). AND: all `branchFlowIds`.
 * OR: the recorded activated subset, keyed by origin branch — the
 * `gateway_decisions.activatedFlowIds` filtered to (and ordered by) the region's
 * stored `branchFlowIds` document order. Read directly from the recorded decision
 * so it never re-evaluates conditions (and never re-creates an incident).
 */
export async function requiredFlowsFor(env: Env, _graph: ExecutionGraph, instanceId: string, region: RegionInfo, activation: number): Promise<string[]> {
  if (region.type === "and") return region.branchFlowIds;
  const dec = await getGatewayDecision(env.DB, instanceId, region.splitId, activation);
  const set = new Set(dec?.activatedFlowIds ?? []);
  return region.branchFlowIds.filter((f) => set.has(f));
}

/**
 * Fan out a split (design §5.4): plain-INSERT one branch token per activated flow,
 * composed with the `regionActivated` marker history + a `branchForked` event per
 * branch, in ONE dbBatch. The token_id PK is the race claim — a duplicate
 * concurrent fan-out aborts wholesale on the PK and re-reads. `region_activation`
 * = the split's walk-local occurrence (`activation`). Branch tokens start with an
 * empty overlay (a delta over the parent scope).
 *
 * `extraStmts` (M4-L4) carries the OR split's `gateway_decisions` activation
 * record, composed into THIS batch so the activation record + the branch tokens
 * commit atomically and share the fan-out's plain-INSERT race claim. Empty for AND.
 */
export async function fanOutSplit(env: Env, instanceId: string, graph: ExecutionGraph, region: RegionInfo, splitId: string, activation: number, parentTokenId: string, activatedFlowIds: string[], extraStmts: D1PreparedStatement[] = []): Promise<void> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const splitNode = graph.nodes[splitId]!;
  const stmts: D1PreparedStatement[] = [
    ...extraStmts,
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: splitId, type: "regionActivated", diagnostics: { splitId, type: region.type, activation, activatedFlowIds } }),
  ];
  for (const flowId of activatedFlowIds) {
    const flow = splitNode.outgoing.find((f) => f.flowId === flowId)!;
    const tid = branchTokenId(instanceId, splitId, activation, flowId);
    stmts.push(
      insertBranchTokenStmt(env.DB, { tokenId: tid, instanceId, regionId: splitId, regionActivation: activation, parentTokenId, branchFlowId: flowId, positionElementId: flow.targetId, variablesOverlay: {}, now }),
      historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: splitId, type: "branchForked", diagnostics: { tokenId: tid, branchFlowId: flowId, target: flow.targetId, activation } }),
    );
  }
  await dbBatch(env.DB, stmts);
}

/** True once the split's branch tokens exist (the first activated flow's token), so a re-walk does not re-fan-out (the plain INSERT would abort on the PK). */
export async function splitAlreadyFannedOut(env: Env, instanceId: string, splitId: string, activation: number, activatedFlowIds: string[]): Promise<boolean> {
  if (activatedFlowIds.length === 0) return true;
  const first = await getToken(env.DB, branchTokenId(instanceId, splitId, activation, activatedFlowIds[0]!));
  return first !== null;
}

/** Record one branch's arrival at a join (design §5.4): INSERT OR IGNORE; a duplicate arrival is a no-op. The arriving branch token is flipped to `arrivedAtJoin`. */
export async function recordJoinArrival(env: Env, instanceId: string, joinId: string, activation: number, branchFlowId: string, branchTokenIdStr: string): Promise<void> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  await dbBatch(env.DB, [
    insertJoinArrivalStmt(env.DB, { instanceId, joinId, activation, branchFlowId, now }),
    setTokenStatusStmt(env.DB, branchTokenIdStr, "arrivedAtJoin", now),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: joinId, type: "branchArrivedAtJoin", diagnostics: { joinId, activation, branchFlowId, tokenId: branchTokenIdStr } }),
  ]);
}

/**
 * Are all required branches present for this join activation? AND = all
 * branchFlowIds; OR = the recorded activated subset (passed in).
 *
 * Empty-subset note (design §6.4 / L4.3): `[].every(...) === true`, so an empty
 * required set would satisfy the barrier immediately. This is unreachable by
 * construction. A `default` is OPTIONAL on an inclusive split (the L1 validator
 * only requires a condition on each NON-default out-flow). Zero activation —
 * no true condition and no default (`noPath`), or a hard FEEL error
 * (`conditionFailure`) — raises a TERMINAL incident and bails with `incident:true`
 * in `resolveActivatedFlows` BEFORE the split fans out (frontier.ts), so the join
 * is never reached with an empty required set. Any OR region that actually
 * reaches its join was fanned out with ≥1 recorded activated branch, hence
 * `requiredFlowsFor` never returns [] for it. The `[]`-is-true behaviour is the
 * correct immediate-produce semantics should a future relaxation ever allow zero
 * activation; no dedicated code branch is added.
 */
export async function joinBarrierSatisfied(env: Env, instanceId: string, joinId: string, activation: number, requiredFlowIds: string[]): Promise<boolean> {
  const arrived = new Set(await getJoinArrivals(env.DB, instanceId, joinId, activation));
  return requiredFlowIds.every((f) => arrived.has(f));
}

/** The outcome of a join-completion claim: advance the produced token, or a terminal incident (M4-L6 join-time payload bound). */
export type JoinCompletionOutcome = { kind: "advance"; outTarget: string } | { kind: "incident" };

/**
 * Claim the join (design §5.4): a plain-INSERT of `join_completions` in the SAME
 * batch as the merged-overlay write, the contributing branch tokens → 'merged',
 * and the advance to the join's out-flow. A losing concurrent batch aborts on the
 * PK and re-reads the recorded produced token (fast-forward). Returns the produced
 * token's next element id (the join's single out-flow target, SESE), or a terminal
 * incident when the merged overlay exceeds the event payload limit (M4-L6, §9.1).
 *
 * SESE (design §5.5): the region consumes the parent token at the split and
 * returns ONE token to the enclosing scope at the join — so the produced token
 * RE-USES `parentTokenId`. The merge fold-up (design §5.7/§6):
 *  - ROOT region → the base is `process_instances.variables` and the merge is
 *    written back up to it (the only place root vars mutate); the root token row
 *    is upserted to the post-join position with an empty overlay.
 *  - NESTED region → the base is the enclosing-branch (parent) token's overlay and
 *    the merge is folded onto THAT token's overlay (no root write).
 */
export async function claimJoinCompletion(env: Env, instanceId: string, graph: ExecutionGraph, region: RegionInfo, joinId: string, activation: number, requiredFlowIds: string[], parentTokenId: string): Promise<JoinCompletionOutcome> {
  const joinNode = graph.nodes[joinId]!;
  const outTarget = joinNode.outgoing[0]!.targetId; // a join has exactly one out-flow (SESE)
  const existing = await getJoinCompletion(env.DB, instanceId, joinId, activation);
  if (existing) return { kind: "advance", outTarget }; // already produced → fast-forward

  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const isRoot = parentTokenId === rootTokenId(instanceId);
  const parent = await getToken(env.DB, parentTokenId);
  // Merge base: root region folds onto process_instances.variables; a nested
  // region folds onto its enclosing-branch token overlay (design §5.7/§6). R2-aware
  // read (M4-L6, design §9.1): an offloaded overlay rehydrates transparently.
  const baseOverlay: JsonObject = isRoot
    ? parseJson<JsonObject>(inst.variables, {})
    : parent
      ? await readOverlay(env, parseOverlay(parent))
      : {};
  // Gather the required branch tokens' overlays (R2-aware).
  const branchTokens: { branchFlowId: string; overlay: JsonObject; tokenId: string }[] = [];
  for (const flowId of requiredFlowIds) {
    const tid = branchTokenId(instanceId, region.splitId, activation, flowId);
    const row = await getToken(env.DB, tid);
    branchTokens.push({ branchFlowId: flowId, overlay: row ? await readOverlay(env, parseOverlay(row)) : {}, tokenId: tid });
  }
  const mergedOverlay = mergeBranchOverlays(baseOverlay, region.branchFlowIds, branchTokens);

  // Join-time payload bound (M4-L6, design §9.1): the merged overlay either becomes
  // root process_instances.variables (which feeds service-task inputs across the
  // ~1 MiB event channel) or folds onto an enclosing token — so a merge exceeding
  // MAX_EVENT_PAYLOAD_BYTES is a terminal `poison` incident, NEVER a silent
  // truncation. (Branch overlays in the 512 KiB–1 MiB band offload to R2; only an
  // over-1-MiB MERGE is rejected here.)
  const mergedSize = payloadByteSize(mergedOverlay);
  if (mergedSize > MAX_EVENT_PAYLOAD_BYTES) {
    await createIncident(
      env,
      instanceId,
      joinId,
      0,
      `Join '${joinId}' merged branch overlays to ${mergedSize} bytes, exceeding the ${MAX_EVENT_PAYLOAD_BYTES}-byte event payload limit.`,
      { joinId, activation, mergedSize, contributingTokenIds: branchTokens.map((b) => b.tokenId) },
      "poison",
    );
    return { kind: "incident" };
  }

  // R2-aware write (M4-L6): a nested fold onto an enclosing token overlay may
  // offload (≤ 1 MiB after the bound above); root vars go inline.
  const storedFold = isRoot ? mergedOverlay : await writeOverlay(env, instanceId, parentTokenId, mergedOverlay);

  const stmts: D1PreparedStatement[] = [
    insertJoinCompletionStmt(env.DB, { instanceId, joinId, activation, producedTokenId: parentTokenId, now }), // THE CLAIM
    ...branchTokens.map((b) => setTokenStatusStmt(env.DB, b.tokenId, "merged", now)),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: joinId, type: "joinCompleted", diagnostics: { joinId, activation, producedTokenId: parentTokenId, contributingTokenIds: branchTokens.map((b) => b.tokenId), outTarget } }),
  ];
  if (isRoot) {
    // Produced token = root: re-position the root token (overlay stays empty —
    // root vars live in process_instances.variables) and fold the merge up.
    stmts.push(
      upsertTokenStmt(env.DB, { tokenId: parentTokenId, instanceId, regionId: null, regionActivation: 0, parentTokenId: null, branchFlowId: null, positionElementId: outTarget, status: "active", variablesOverlay: {}, now }),
      applyTransitionStmt(env.DB, { instanceId, variables: mergedOverlay, currentElementId: outTarget, status: "running", now }),
    );
  } else {
    // Produced token = the enclosing-branch (parent) token: fold the merge onto
    // ITS overlay; no root variable write (design §6 nested placement).
    stmts.push(
      foldTokenOverlayStmt(env.DB, { tokenId: parentTokenId, positionElementId: outTarget, variablesOverlay: storedFold, now }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: null, status: "running", now }),
    );
  }
  // Plain-INSERT race contract (design §5.4, the gateway_decisions discipline): the
  // join_completions PK is the claim. The per-instance drive lock serialises drives,
  // but under extreme contention it proceeds unlocked (drive-lock.ts) — so a losing
  // concurrent batch's UNIQUE violation aborts this ENTIRE batch (the produced-token
  // write + advance included); re-read the winner and fast-forward, never double-produce.
  try {
    await dbBatch(env.DB, stmts);
  } catch (err) {
    if (isUniqueConstraintViolation(err) && (await getJoinCompletion(env.DB, instanceId, joinId, activation))) {
      return { kind: "advance", outTarget };
    }
    throw err;
  }
  return { kind: "advance", outTarget };
}

/** A D1 UNIQUE-constraint violation (the plain-INSERT race loser); mirrors engine.ts. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE/i.test(err.message);
}

export { getToken, parseOverlay };
