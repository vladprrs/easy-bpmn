// In-memory token frontier (M4-L2 seed; L3 grows it to the deterministic DFS).
//
// L2: derive the single root token from the instance (one live position). L3
// replaces reconstructFrontier with a depth-first re-walk from startElementId that
// descends each split's outgoing[] in DOCUMENT ORDER, fast-forwarding applied
// visits write-free and forking at splits.

import type { Env } from "../env";
import type { ExecutionGraph, RegionInfo } from "../bpmn/graph";
import { isTerminalInstanceStatus, nowIso, type JsonObject } from "../util";
import { dbBatch } from "../persistence/db";
import { rootTokenId, upsertTokenStmt, setTokenStatusStmt, listLiveTokens, getToken, parseOverlay, readOverlay, branchTokenId, parseTokenId, getJoinCompletion } from "../persistence/tokens";
import { loadInst } from "./engine-shared";
import { claimJoinCompletion, fanOutSplit, joinBarrierSatisfied, recordJoinArrival, requiredFlowsFor, resolveActivatedFlows, splitAlreadyFannedOut } from "./regions-runtime";

export interface Token {
  tokenId: string;
  positionElementId: string;
  occurrence: number;
  regionId: string | null;
  regionActivation: number;
  branchFlowId: string | null;
  parentTokenId: string | null;
}

/** L2: the single live token derived from the instance cursor (or [] when terminal/at end). */
export async function reconstructFrontier(env: Env, graph: ExecutionGraph, instanceId: string): Promise<Token[]> {
  const inst = await loadInst(env, instanceId);
  if (isTerminalInstanceStatus(inst.status)) return [];
  const pos = inst.current_element_id;
  if (!pos || !graph.nodes[pos]) return [];
  return [{ tokenId: rootTokenId(instanceId), positionElementId: pos, occurrence: 0, regionId: null, regionActivation: 0, branchFlowId: null, parentTokenId: null }];
}

/**
 * Resolve a token's effective variable scope (design §5.7): root variables with
 * each ancestor token's overlay layered on, root→token, NEAREST WINS. The root
 * token resolves to `rootVars` verbatim (its overlay is conceptually empty — root
 * vars live in process_instances.variables), preserving the exact M0–M3 read path.
 * A cycle guard bounds a malformed parent chain.
 */
export async function resolveScope(env: Env, instanceId: string, rootVars: JsonObject, tokenId: string): Promise<JsonObject> {
  if (tokenId === rootTokenId(instanceId)) return rootVars;
  // Collect overlays token→root, then apply root→token so the nearest overlay wins.
  const chain: JsonObject[] = [];
  let cur: string | null = tokenId;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const row = await getToken(env.DB, cur);
    if (!row) break;
    // R2-aware read (M4-L6, design §9.1): an ancestor overlay may be offloaded.
    chain.push(await readOverlay(env, parseOverlay(row)));
    cur = row.parent_token_id;
  }
  let scope: JsonObject = { ...rootVars };
  for (let i = chain.length - 1; i >= 0; i--) scope = { ...scope, ...chain[i]! };
  return scope;
}

/** Write the read-model after a drive: upsert the frontier's tokens; mark vanished live tokens consumed. */
export async function syncFrontierReadModel(env: Env, instanceId: string, frontier: Token[]): Promise<void> {
  const now = nowIso();
  const live = await listLiveTokens(env.DB, instanceId);
  const stmts: D1PreparedStatement[] = [];
  const present = new Set<string>();
  for (const t of frontier) {
    present.add(t.tokenId);
    stmts.push(upsertTokenStmt(env.DB, {
      tokenId: t.tokenId, instanceId, regionId: t.regionId, regionActivation: t.regionActivation,
      parentTokenId: t.parentTokenId, branchFlowId: t.branchFlowId, positionElementId: t.positionElementId, status: "active", now,
    }));
  }
  for (const r of live) if (!present.has(r.token_id)) stmts.push(setTokenStatusStmt(env.DB, r.token_id, "consumed", now));
  if (stmts.length) await dbBatch(env.DB, stmts);
}

// ---------------------------------------------------------------------------
// The token-frontier DFS driver (M4-L3, design §5.1/§5.4)
// ---------------------------------------------------------------------------

const isGatewayType = (t: string) => t === "parallelGateway" || t === "inclusiveGateway";

/** One leaf node's outcome, returned by the engine's per-node drivers (driveLeaf). */
export type LeafOutcome =
  | { kind: "next"; next: string }
  | { kind: "parked" } // a live wait (a service-task/receive/timer/EBG park)
  | { kind: "incident" }
  | { kind: "completed" } // a process-level none-end settled the instance
  | { kind: "consumed" } // a region branch's none-end consumed its token (sibling still live)
  | { kind: "compensate"; scopeId: string; elementId: string }; // a cancel-end → reverse pass

export interface LeafDrivers {
  /** Drive ONE live leaf node for `activeTokenId`; the existing engine drive* fns. */
  driveLeaf(cur: string, occ: number, activeTokenId: string): Promise<LeafOutcome>;
  /** Raise the terminal loopLimit incident for an element that exceeded the visit cap. */
  raiseLoopLimit(elementId: string, occ: number): Promise<void>;
  /** Raise the terminal concurrencyLimit incident: a split fan-out would exceed the live-token cap (M4-L6). */
  raiseConcurrencyLimit(splitId: string, occ: number): Promise<void>;
  /** Raise the graceful stepBudget incident: the per-drive step counter crossed the soft budget (M4-L6). */
  raiseStepBudget(elementId: string, occ: number): Promise<void>;
}

/**
 * The concurrency caps applied during a drive (M4-L6, design §9). `maxConcurrentTokens`
 * bounds the live frontier at each split fan-out; `stepBudgetSoft` bounds the
 * per-drive cumulative runStep/waitForEvent count (`budget.steps`, a shared
 * in-memory counter the engine's runStep wrapper increments). Both are counted
 * in-memory during the deterministic rewalk — NEVER a SQL COUNT — so the incident
 * fires deterministically across Workflow replays.
 */
export interface DriveCaps {
  maxConcurrentTokens: number;
  stepBudgetSoft: number;
  budget: { steps: number };
}

export interface FrontierResult {
  parked: boolean;
  advanced: boolean;
  completed: boolean;
  incident: boolean;
  compensate?: { scopeId: string; elementId: string };
}

/** joinId → its region (graph.regions is keyed by splitId). */
function joinIndexOf(graph: ExecutionGraph): Map<string, RegionInfo> {
  const idx = new Map<string, RegionInfo>();
  for (const r of Object.values(graph.regions ?? {})) idx.set(r.joinId, r);
  return idx;
}

/**
 * One drive pass (design §5.1): a deterministic depth-first re-walk from
 * `startElementId` that descends each split's `outgoing[]` in DOCUMENT order. It
 * fans out at a split (SPLIT-OWNS-CONTINUATION: walk every branch — each halts at
 * its join arrival — then settle the join and continue the post-join path on the
 * parent token EXACTLY ONCE per activation), records arrivals + claims completions
 * at joins, and drives/parks leaves via the engine's `driveLeaf`. Returns whether
 * anything parked / advanced / completed / hit an incident.
 *
 * A non-region graph never hits a split/join — it walks one chain from the root
 * token via `driveLeaf`, reducing to the exact M0–M3 behaviour.
 */
export async function driveFrontier(
  env: Env,
  graph: ExecutionGraph,
  instanceId: string,
  drivers: LeafDrivers,
  maxOccurrences: number,
  caps: DriveCaps,
): Promise<FrontierResult> {
  const visits = new Map<string, number>();
  const joinIndex = joinIndexOf(graph);
  let advanced = false;
  let completed = false;
  let incident = false;
  let liveTokens = 0;
  let compensate: { scopeId: string; elementId: string } | undefined;
  const nextOcc = (id: string): number => {
    const o = visits.get(id) ?? 0;
    visits.set(id, o + 1);
    return o;
  };

  // Recursive branch walk. `tokenId` is the token currently flowing through `cur`.
  async function walk(start: string, tokenId: string): Promise<void> {
    let cur = start;
    while (true) {
      if (incident || compensate) return;
      const node = graph.nodes[cur];
      if (!node) return; // off the graph
      const occ = nextOcc(cur);
      // Step-budget cap (M4-L6, design §9): the per-drive runStep/waitForEvent
      // counter (incremented by the engine's runStep wrapper) crossing the soft
      // budget settles a GRACEFUL stepBudget incident below the platform step
      // ceiling. Checked at the top of the walk so a hot in-region loop (a cycle
      // burning runSteps within ONE pass) trips it deterministically, in direct
      // mode too, before it could exhaust the platform budget.
      if (caps.budget.steps > caps.stepBudgetSoft) {
        await drivers.raiseStepBudget(cur, occ);
        incident = true;
        return;
      }
      if (occ >= maxOccurrences) {
        await drivers.raiseLoopLimit(cur, occ);
        incident = true;
        return;
      }

      // ---- SPLIT (this node is a region's split; reached on the parent token) ----
      const region = graph.regions?.[cur];
      if (region && isGatewayType(node.type)) {
        // OR split (design §6): resolve the activated subset + the decision record
        // it must commit; a noPath / conditionFailure bails the branch (no token
        // silently dropped). AND returns all branchFlowIds with no record.
        const { activated, recordStmts, incident: splitIncident } = await resolveActivatedFlows(env, graph, instanceId, region, cur, occ, tokenId);
        if (splitIncident) {
          incident = true;
          return;
        }
        if (!(await splitAlreadyFannedOut(env, instanceId, cur, occ, activated))) {
          // Live-token cap (M4-L6, design §9): a fan-out that would push the live
          // frontier past MAX_CONCURRENT_TOKENS settles a terminal concurrencyLimit
          // BEFORE creating the branch tokens. `liveTokens` is the in-memory count
          // of frontier tokens parked so far this rewalk (NEVER a SQL COUNT — that
          // would fire nondeterministically on replay); adding `activated.length`
          // is the prospective post-fan-out live count. A rewalk that fast-forwards
          // an already-fanned-out split skips this (no new tokens created).
          if (liveTokens + activated.length > caps.maxConcurrentTokens) {
            await drivers.raiseConcurrencyLimit(cur, occ);
            incident = true;
            return;
          }
          // The OR activation record (recordStmts) commits in the SAME batch as the
          // branch tokens (shared fan-out claim); empty for AND / an OR rewalk.
          await fanOutSplit(env, instanceId, graph, region, cur, occ, tokenId, activated, recordStmts);
          advanced = true;
        }
        for (const flowId of activated) {
          // document order — `branchFlowIds` mirrors the split's outgoing[] order
          const childTarget = node.outgoing.find((f) => f.flowId === flowId)!.targetId;
          await walk(childTarget, branchTokenId(instanceId, cur, occ, flowId));
          if (incident || compensate) return;
        }
        // Split owns the continuation: settle the join once every required branch
        // has arrived, then keep walking the post-join path on the parent token.
        const required = await requiredFlowsFor(env, graph, instanceId, region, occ);
        if (await joinBarrierSatisfied(env, instanceId, region.joinId, occ, required)) {
          const joinOutcome = await claimJoinCompletion(env, instanceId, graph, region, region.joinId, occ, required, tokenId);
          if (joinOutcome.kind === "incident") {
            // Join-time payload bound (M4-L6, §9.1): the merged overlay exceeded the
            // event limit → a terminal poison incident was claimed; stop the walk.
            incident = true;
            return;
          }
          advanced = true;
          cur = joinOutcome.outTarget; // continue on the PRODUCED (= parent) token from the join out-flow
          continue;
        }
        return; // join not yet satisfiable this pass → a sibling is parked
      }

      // ---- JOIN (reached by a branch token; record arrival then halt) ----
      const joinRegion = joinIndex.get(cur);
      if (joinRegion && isGatewayType(node.type)) {
        const parsed = parseTokenId(tokenId);
        const activation = parsed.kind === "branch" ? parsed.activation : 0;
        const branchFlowId = parsed.kind === "branch" ? parsed.branchFlowId : "";
        // If this activation already completed, the branch is a write-free
        // fast-forward — do NOT re-record (it would regress a 'merged' token).
        if (parsed.kind === "branch" && !(await getJoinCompletion(env.DB, instanceId, joinRegion.joinId, activation))) {
          await recordJoinArrival(env, instanceId, joinRegion.joinId, activation, branchFlowId, tokenId);
          advanced = true;
        }
        return; // branch halts; the split handler settles + continues the join
      }

      // ---- LEAF ----
      const r = await drivers.driveLeaf(cur, occ, tokenId);
      if (r.kind === "completed") {
        completed = true;
        return;
      }
      if (r.kind === "consumed") return; // region branch end consumed; loop settles completion
      if (r.kind === "incident") {
        incident = true;
        return;
      }
      if (r.kind === "compensate") {
        compensate = { scopeId: r.scopeId, elementId: r.elementId };
        return;
      }
      if (r.kind === "parked") {
        liveTokens++;
        return;
      }
      // advanced one step → continue this branch
      advanced = true;
      cur = r.next;
    }
  }

  await walk(graph.startElementId, rootTokenId(instanceId));
  return { parked: liveTokens > 0, advanced, completed, incident, compensate };
}
