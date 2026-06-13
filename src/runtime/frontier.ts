// In-memory token frontier (M4-L2 seed; L3 grows it to the deterministic DFS).
//
// L2: derive the single root token from the instance (one live position). L3
// replaces reconstructFrontier with a depth-first re-walk from startElementId that
// descends each split's outgoing[] in DOCUMENT ORDER, fast-forwarding applied
// visits write-free and forking at splits.

import type { Env } from "../env";
import type { ExecutionGraph, RegionInfo } from "../bpmn/graph";
import type { MessageEventPayload } from "../contracts/workflow-events";
import type { WaitForEvent } from "./engine-shared";
import { isTerminalInstanceStatus, nowIso, type JsonObject } from "../util";
import { dbBatch } from "../persistence/db";
import { rootTokenId, upsertTokenStmt, setTokenStatusStmt, listLiveTokens, getToken, parseOverlay, branchTokenId, parseTokenId, getJoinCompletion } from "../persistence/tokens";
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
    chain.push(parseOverlay(row));
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
  driveLeaf(cur: string, occ: number, activeTokenId: string, collector: WaitCollector): Promise<LeafOutcome>;
  /** Raise the terminal loopLimit incident for an element that exceeded the visit cap. */
  raiseLoopLimit(elementId: string, occ: number): Promise<void>;
}

/** A frontier wait registered during the DFS (workflow-mode multi-wait, §5.2). */
export interface ParkedWait {
  name: string;
  workflowEventType: string;
  timeout: string;
  tokenId: string;
}

/**
 * The in-pass wait map (design §5.2): a `step.waitForEvent` is registered at most
 * once per step name per `run()` invocation; `raceParkedWaits` iterates its values.
 */
export class WaitCollector {
  readonly waits = new Map<string, ParkedWait>();
  add(w: ParkedWait): void {
    if (!this.waits.has(w.name)) this.waits.set(w.name, w);
  }
  get size(): number {
    return this.waits.size;
  }
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
 * anything parked / advanced / completed / hit an incident, plus the collected
 * waits (workflow-mode multi-wait).
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
): Promise<{ result: FrontierResult; collector: WaitCollector }> {
  const visits = new Map<string, number>();
  const collector = new WaitCollector();
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
      if (occ >= maxOccurrences) {
        await drivers.raiseLoopLimit(cur, occ);
        incident = true;
        return;
      }

      // ---- SPLIT (this node is a region's split; reached on the parent token) ----
      const region = graph.regions?.[cur];
      if (region && isGatewayType(node.type)) {
        const activated = await resolveActivatedFlows(env, graph, instanceId, region, cur, occ);
        if (!(await splitAlreadyFannedOut(env, instanceId, cur, occ, activated))) {
          await fanOutSplit(env, instanceId, graph, region, cur, occ, tokenId, activated);
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
          const outTarget = await claimJoinCompletion(env, instanceId, graph, region, region.joinId, occ, required, tokenId);
          advanced = true;
          cur = outTarget; // continue on the PRODUCED (= parent) token from the join out-flow
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
      const r = await drivers.driveLeaf(cur, occ, tokenId, collector);
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
  return { result: { parked: liveTokens > 0, advanced, completed, incident, compensate }, collector };
}

/** A resolved multi-wait outcome: the winning token's delivered event, or a timeout. */
export interface RaceOutcome {
  tokenId?: string;
  event?: MessageEventPayload;
  timedOut: boolean;
}

/**
 * Workflow-mode multi-wait (design §5.2): one `Promise.race` over a
 * `step.waitForEvent` per collected wait, EACH individually try/caught to a
 * timeout so one branch's timeout never rejects the race or strands siblings. The
 * winner is advisory — the engine re-walks and reconciles against canonical D1.
 * NOT exercised in CI (direct mode never collects); recorded for the L6.6 matrix.
 */
export async function raceParkedWaits(collector: WaitCollector, waitFor: WaitForEvent): Promise<RaceOutcome> {
  const entries = [...collector.waits.values()];
  if (entries.length === 0) return { timedOut: true };
  const races = entries.map((w) =>
    (async (): Promise<RaceOutcome> => {
      try {
        const outcome = await waitFor({ name: w.name, workflowEventType: w.workflowEventType, timeout: w.timeout });
        if (outcome.kind === "event") return { tokenId: w.tokenId, event: outcome.payload as MessageEventPayload, timedOut: false };
        return { tokenId: w.tokenId, timedOut: true };
      } catch {
        return { tokenId: w.tokenId, timedOut: true };
      }
    })(),
  );
  return Promise.race(races);
}

/**
 * The delivered event the next re-walk applies — at the token whose subscription
 * matches its `workflowEventType` + correlationKey (design §5.2), never
 * positionally. (L3: the engine applies a `pending` event at the matching receive
 * leaf; full origin-branch keying is exercised by the L6.6 manual matrix.)
 */
export function matchKeyedEvent(outcome: RaceOutcome): MessageEventPayload | undefined {
  return outcome.timedOut ? undefined : outcome.event;
}
