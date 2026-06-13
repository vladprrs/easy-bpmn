// eventBasedGateway runtime — a deterministic race over its branch catches that
// decides on `gateway_decisions` (M3-L4, TASK-46, design §4.5).
//
// The EBG is a single wait point that fans out to ≥2 intermediate catch events
// (≤1 timer branch + ≥1 distinct-message branches, validator-enforced). Token
// arrival registers EVERY message branch's subscription + arms the timer branch,
// then parks. Whichever event resolves first wins; the race decider is a PLAIN
// `gateway_decisions` INSERT (the M2 contract, gateway-decisions.ts:70-84)
// composed into the SAME batch as the transition, so the loser's whole batch
// aborts on the unique (instance, gateway, occurrence) violation and converts to
// the recorded branch. Unlike the XOR gateway (check-first, no contender) the EBG
// has TWO genuine concurrent writers — the broker-driven message apply and
// `fireTimer` — so the plain-INSERT discipline is load-bearing here.
//
// Keying (design §4.1): subscriptions + the timer branch are keyed by the
// GATEWAY'S visit occurrence (the catches are not independently walked — the EBG
// owns them); the winning branch advances the token straight to the catch's
// single outgoing flow (the catch element itself is never re-dispatched). All
// branches share ONE per-visit Workflow wake type (`workflowEventGatewayTypeFor`)
// so a single `waitForEvent` is woken by any message delivery OR the timer fire —
// the delivery path honors the STORED `workflow_event_type` for these subs
// (executor.ts), the EBG exception to the receive-task symmetry contract.
//
// This module owns: the engine dispatch (`driveEventBasedGateway`), the park +
// broker-registration batch (`parkEventBasedGateway`), the message-wins apply
// (`applyEbgMessage`), the shared timer-wins batch builder
// (`planEventGatewayTimerFire`, reused by timers.ts `fireTimer` and the
// Workflow-mode backstop), and the lost-alarm backstop. Like the other timer
// modules it NEVER imports the executor — the backstop reuses the identical fire
// batch without the runtime/timers → executor → engine cycle.

import type { Env } from "../env";
import type { ExecutionGraph, GraphNode, TimerTriggerSpec } from "../bpmn/graph";
import type { MessageEventPayload } from "../contracts/workflow-events";
import {
  ONE_HOUR_MS,
  isTerminalInstanceStatus,
  isoIsBefore,
  isoPlusMs,
  mergeVariables,
  newId,
  nowIso,
  parseJson,
  type JsonObject,
} from "../util";
import { workflowEventGatewayTypeFor } from "../bpmn/profile";
import { dbBatch } from "../persistence/db";
import { historyStmt } from "../persistence/history";
import {
  applyTransitionStmt,
  createSubscriptionStmt,
  getInstanceRow,
  getSubscriptionForVisit,
  subscriptionConsumedStmt,
  subscriptionSupersededStmt,
  variableSnapshotStmt,
  type InstanceRow,
  type SubscriptionRow,
} from "../persistence/instances";
import { getCorrelatedMessageForSubscription, messageCorrelatedStmt } from "../persistence/messages";
import { branchHistoryTags, getToken, parseOverlay, readOverlay, rootTokenId, setTokenOverlayStmt, writeOverlay } from "../persistence/tokens";
import { insertGatewayDecisionStmt, getGatewayDecision } from "../persistence/gateway-decisions";
import {
  flipTimerCancelledStmt,
  flipTimerFiredStmt,
  getTimer,
  insertTimerArmedStmt,
  timerIdFor,
  type TimerView,
} from "../persistence/timers";
import { computeFireAt } from "./iso8601";
import { brokerKeyOf, type RegisterSubscriptionResult } from "./broker-types";
import {
  armTimerDO,
  isUniqueConstraintViolation,
  supersedeBrokerSubscription,
  timerSizedTimeout,
  type TimerWake,
  type WakeSettleOutcome,
} from "./boundary-timer";
import { createIncident } from "./incidents";
import { loadInst, SVC_WAIT_TIMEOUT, type RunStep, type WaitForEvent } from "./engine-shared";

// ---------------------------------------------------------------------------
// Branch model
// ---------------------------------------------------------------------------

interface EbgMessageBranch {
  /** The EBG → catch sequence-flow id (the recorded `chosen_flow_id` when it wins). */
  flowId: string;
  /** The message intermediate catch element id. */
  catchId: string;
  messageName: string;
}
interface EbgTimerBranch {
  flowId: string;
  catchId: string;
  trigger: TimerTriggerSpec;
}
export interface EbgBranches {
  message: EbgMessageBranch[];
  timer: EbgTimerBranch | null;
}

/**
 * Classify an EBG's outgoing flows into message + timer branches (validator-
 * guaranteed: every target is a timer or message intermediate catch, ≤1 timer,
 * distinct messages). Document order is preserved — the early-buffered tie-break
 * (§4.5.4) is "first hit in document order wins".
 */
export function ebgBranches(graph: ExecutionGraph, node: GraphNode): EbgBranches {
  const message: EbgMessageBranch[] = [];
  let timer: EbgTimerBranch | null = null;
  for (const flow of node.outgoing) {
    const c = graph.nodes[flow.targetId];
    if (!c || c.type !== "intermediateCatchEvent") continue;
    if (c.timerTrigger) timer = { flowId: flow.flowId, catchId: flow.targetId, trigger: c.timerTrigger };
    else if (c.messageName) message.push({ flowId: flow.flowId, catchId: flow.targetId, messageName: c.messageName });
  }
  return { message, timer };
}

/** The successor the token takes when the EBG's recorded flow wins: the WINNING CATCH'S single outgoing flow. */
function winnerNextOf(graph: ExecutionGraph, node: GraphNode, chosenFlowId: string): string {
  const flow = node.outgoing.find((f) => f.flowId === chosenFlowId);
  if (!flow) {
    throw new Error(`Invariant violation: eventBasedGateway '${node.name ?? ""}' recorded flow '${chosenFlowId}' is not among its outgoing flows.`);
  }
  const next = graph.nodes[flow.targetId]?.next;
  if (!next) {
    throw new Error(`Invariant violation: eventBasedGateway branch catch '${flow.targetId}' has no outgoing flow.`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Engine dispatch
// ---------------------------------------------------------------------------

export type EbgOutcome =
  | { kind: "next"; next: string; consumedPending?: boolean }
  | { kind: "waiting" }
  | { kind: "incident" };

/**
 * Drive one eventBasedGateway visit (`ebg:el#occ`). Mirrors the receive-task /
 * intermediate-catch waits, but resolves on `gateway_decisions`:
 *   1. Decision recorded → write-free cursor move to the winning catch's flow.
 *   2. Direct-mode pending message matching a branch → apply (message wins).
 *   3. First visit → park (register every message branch + arm the timer) ; a
 *      rewalk re-registers idempotently (self-heal) — either may resolve via an
 *      early-buffered message claimed at registration.
 *   4. Direct mode parks; the broker delivery / timer alarm resumes inline.
 *   5. Workflow mode waits on the per-visit gateway event type, sized to the timer.
 */
export async function driveEventBasedGateway(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  elementId: string,
  occ: number,
  node: GraphNode,
  runStep: RunStep,
  waitFor: WaitForEvent | null,
  pending?: MessageEventPayload,
  activeTokenId?: string,
): Promise<EbgOutcome> {
  const tag = `${elementId}#${occ}`;
  const branches = ebgBranches(graph, node);

  // (1) Decision fast-forward — write-free cursor move.
  const decided = await getGatewayDecision(env.DB, instanceId, elementId, occ);
  if (decided) {
    // A pending message addressed to ANY branch of this (now decided) gateway is
    // consumed HERE so it never leaks to a downstream node sharing its name — the
    // winning message was already applied; a losing-branch message (e.g. one that
    // correlated in the gap before the timer-win supersede) is dropped (mirrors
    // driveReceiveTask's consumed fast-forward).
    const consumedPending = !!pending && branches.message.some((b) => b.messageName === pending.messageName);
    return { kind: "next", next: winnerNextOf(graph, node, decided.chosenFlowId), consumedPending };
  }

  // (2) Direct-mode pending message: apply the matching branch (message wins).
  if (pending) {
    const branch = branches.message.find((b) => b.messageName === pending.messageName);
    if (branch) {
      const r = await runStep(`ebg-msg:${tag}`, () => applyEbgMessage(env, instanceId, graph, elementId, node, occ, branch, branches, pending, activeTokenId));
      if (r.kind === "incident") return { kind: "incident" };
      return { kind: "next", next: r.next, consumedPending: true };
    }
    // Not for this gateway → fall through to park, leaving the pending for a later node.
  }

  // Apply-from-D1 (TASK-54): no in-flight `pending` on a single-wake re-walk. If a
  // message branch's subscription was correlated in D1, apply it (message wins).
  // `subscriptionIdFor` is the private builder this file already uses to register the
  // per-branch subscriptions (ebgsub:${instanceId}:${catchId}#${occ}), so the lookup
  // key matches what parkEventBasedGateway stored.
  for (const b of branches.message) {
    const fromD1 = await getCorrelatedMessageForSubscription(env.DB, subscriptionIdFor(instanceId, b.catchId, occ));
    if (fromD1 && fromD1.messageName === b.messageName) {
      const r = await runStep(`ebg-msg:${tag}`, () => applyEbgMessage(env, instanceId, graph, elementId, node, occ, b, branches, fromD1, activeTokenId));
      if (r.kind === "incident") return { kind: "incident" };
      return { kind: "next", next: r.next };
    }
  }

  // (3) Park (first visit) or self-heal re-register (rewalk past an armed park).
  const r = await runStep(`ebg:${tag}`, () => parkEventBasedGateway(env, instanceId, elementId, occ, branches, activeTokenId));
  if (r.kind === "incident") return { kind: "incident" };
  if (r.kind === "correlated") {
    // Early-buffered message claimed at registration → apply in its OWN memoized
    // step (B1): the park step captured the event, so a Workflow-mode crash between
    // the broker consume (committed in `ebg:`) and the decision commit re-applies the
    // CAPTURED event on retry instead of re-hitting the now-empty broker — mirroring
    // driveReceiveTask's recv→msg split. applyEbgMessage is idempotent on re-run.
    const applied = await runStep(`ebg-msg:${tag}`, () => applyEbgMessage(env, instanceId, graph, elementId, node, occ, r.branch, branches, r.event, activeTokenId));
    if (applied.kind === "incident") return { kind: "incident" };
    return { kind: "next", next: applied.next };
  }

  // (4) Direct mode: park; the broker delivery / timer alarm resumes inline.
  if (!waitFor) return { kind: "waiting" };

  // (5) Workflow mode: ONE waitForEvent on the gateway type, sized to the timer
  //     (or the un-guarded cap when there is no timer branch).
  const timeout = branches.timer
    ? await timerSizedTimeout(env, timerIdFor(instanceId, branches.timer.catchId, occ))
    : SVC_WAIT_TIMEOUT;
  const outcome = await waitFor({ name: `ebg-wait:${tag}`, workflowEventType: workflowEventGatewayTypeFor(elementId, occ), timeout });
  // M4-L3 multi-wait: a region branch in workflow mode REGISTERED this wait and did
  // not suspend — return parked (raceParkedWaits awaits it). Direct mode never hits this.
  if (outcome.kind === "parked") return { kind: "waiting" };

  // The timer may have fired (its sendEvent wake, or a concurrent alarm) — its
  // fireTimer batch commits the decision before waking, so re-read it.
  const afterWait = await getGatewayDecision(env.DB, instanceId, elementId, occ);
  if (afterWait) return { kind: "next", next: winnerNextOf(graph, node, afterWait.chosenFlowId) };

  if (outcome.kind === "timeout") {
    // Lost-alarm backstop (design §4.2, risk R5): a timer-guarded EBG wait NEVER
    // raises waitTimeout. Settle an overdue timer branch INLINE (the identical
    // fireTimer batch), returning the timer path to this loop. Workflow-mode-only.
    if (branches.timer) {
      const settled = await settleOverdueEventGatewayTimerOnWake(env, graph, instanceId, elementId, occ);
      if (settled.kind === "fired") return { kind: "next", next: settled.next };
      if (settled.kind === "reparked") return { kind: "waiting" };
      const reread = await getGatewayDecision(env.DB, instanceId, elementId, occ);
      if (reread) return { kind: "next", next: winnerNextOf(graph, node, reread.chosenFlowId) };
      return { kind: "waiting" };
    }
    // An un-guarded EBG wait (no timer branch) hits the safety-net cap.
    await runStep(`ebg-timeout:${tag}`, () =>
      createIncident(env, instanceId, elementId, 0, "Event-based gateway wait timed out (no message branch correlated).", { occurrence: occ }, "waitTimeout"),
    );
    return { kind: "incident" };
  }

  // Woke on a message delivery (the payload is a MessageEventPayload, not the
  // timerFired discriminator) → apply it (message wins). A concurrent fireTimer
  // that already won is handled inside applyEbgMessage (convert on conflict).
  if (isTimerFiredWake(outcome.payload)) return { kind: "waiting" }; // decider not visible yet → re-park defensively
  const event = outcome.payload as MessageEventPayload;
  const branch = branches.message.find((b) => b.messageName === event.messageName);
  if (!branch) return { kind: "waiting" }; // stray event → re-park
  const applied = await runStep(`ebg-msg:${tag}`, () => applyEbgMessage(env, instanceId, graph, elementId, node, occ, branch, branches, event, activeTokenId));
  if (applied.kind === "incident") return { kind: "incident" };
  return { kind: "next", next: applied.next };
}

function isTimerFiredWake(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as { outcome?: unknown }).outcome === "timerFired";
}

// ---------------------------------------------------------------------------
// Park — register every message branch + arm the timer, then park
// ---------------------------------------------------------------------------

type ParkOutcome =
  | { kind: "waiting" }
  // An early-buffered message was claimed at registration — the CAPTURED event is
  // returned (NOT applied here) so the dispatch applies it in its own memoized step.
  | { kind: "correlated"; branch: EbgMessageBranch; event: MessageEventPayload }
  | { kind: "incident" };

/**
 * Park the EBG visit (design §4.5.1). First visit: ONE D1 batch = a subscription
 * row (active) for every message branch + the timer row (+ `timerArmed`) for the
 * timer branch + the waiting history + the park transition (persist-before-
 * advance, atomic so a parked EBG always carries its full branch set). A rewalk
 * that lands on an already-armed park re-registers WRITE-FREE in D1 and just
 * re-drives the broker. Then BEST-EFFORT broker registrations in document order —
 * a DO RPC cannot ride the dbBatch (the M1 registerReceive pattern; the rewalk is
 * the crash-recovery story). The FIRST branch the broker returns `correlated`
 * (an early-buffered message) wins the race at registration (§4.5.4 tie-break).
 */
async function parkEventBasedGateway(
  env: Env,
  instanceId: string,
  gwId: string,
  occ: number,
  branches: EbgBranches,
  activeTokenId?: string,
): Promise<ParkOutcome> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const gwEventType = workflowEventGatewayTypeFor(gwId, occ);
  const expiresAt = isoPlusMs(now, ONE_HOUR_MS);

  // Per-branch subscription identity (deterministic so a Workflow step retry that
  // re-runs the body reuses the SAME subscription id — INSERT OR IGNORE-style
  // idempotency is via the existing-row check below, not a random id each replay).
  const subMeta = branches.message.map((b) => ({
    branch: b,
    subscriptionId: subscriptionIdFor(instanceId, b.catchId, occ),
    brokerKey: brokerKeyOf(inst.workspace_id, b.messageName, inst.correlation_key),
  }));

  // Already parked? (the first message branch's row is the armed predicate — there
  // is always ≥1 message branch). A rewalk re-registers idempotently below.
  const firstCatchId = branches.message[0]?.catchId ?? branches.timer?.catchId ?? gwId;
  const existing = await getSubscriptionForVisit(env.DB, instanceId, firstCatchId, occ);
  const alreadyParked = existing != null;

  if (!alreadyParked) {
    const stmts: D1PreparedStatement[] = [];
    for (const m of subMeta) {
      stmts.push(
        createSubscriptionStmt(env.DB, {
          subscriptionId: m.subscriptionId,
          workspaceId: inst.workspace_id,
          instanceId,
          elementId: m.branch.catchId,
          messageName: m.branch.messageName,
          correlationKey: inst.correlation_key,
          brokerKey: m.brokerKey,
          // EBG exception (design §4.5): every branch subscription stores the EBG
          // visit's wait type, so ONE waitForEvent is woken by any branch.
          workflowEventType: gwEventType,
          status: "active",
          expiresAt,
          occurrence: occ,
          now,
        }),
      );
    }
    let timerId: string | null = null;
    let fireAt: string | null = null;
    if (branches.timer) {
      timerId = timerIdFor(instanceId, branches.timer.catchId, occ);
      fireAt = computeFireAt(branches.timer.trigger, now);
      stmts.push(
        insertTimerArmedStmt(env.DB, {
          timerId,
          instanceId,
          elementId: branches.timer.catchId,
          occurrence: occ,
          kind: "eventGateway",
          gatewayId: gwId,
          fireAt,
          now,
        }),
        historyStmt(env.DB, {
          workspaceId: inst.workspace_id,
          instanceId,
          elementId: branches.timer.catchId,
          type: "timerArmed",
          diagnostics: { kind: "eventGateway", gateway: gwId, fireAt, occurrence: occ, trigger: branches.timer.trigger, ...branchHistoryTags(activeTokenId) },
        }),
      );
    }
    stmts.push(
      historyStmt(env.DB, {
        workspaceId: inst.workspace_id,
        instanceId,
        elementId: gwId,
        type: "eventBasedGatewayWaiting",
        diagnostics: {
          occurrence: occ,
          messageBranches: subMeta.map((m) => ({ catchId: m.branch.catchId, messageName: m.branch.messageName })),
          timerBranch: branches.timer ? { catchId: branches.timer.catchId } : null,
          ...branchHistoryTags(activeTokenId),
        },
      }),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: gwId, status: "waiting", now }),
    );
    try {
      await dbBatch(env.DB, stmts);
    } catch (err) {
      // The branch subscriptions use a DETERMINISTIC id (replay-stable), so a
      // concurrent duplicate park collides on the subscription PK. Treat the
      // conflict as "another drive parked this visit" and fall through to the
      // (idempotent) broker loop + DO arm — never a terminal incident (S1).
      if (!isUniqueConstraintViolation(err)) throw err;
    }
    // Arm the timer DO after commit (best-effort, non-fatal — the rewalk re-arms).
    if (timerId && fireAt) await armTimerDO(env, timerId, fireAt);
  } else if (branches.timer) {
    // Self-heal: a rewalk past an armed timer branch re-arms the DO idempotently.
    const trow = await getTimer(env.DB, timerIdFor(instanceId, branches.timer.catchId, occ));
    if (trow?.status === "armed") await armTimerDO(env, trow.timerId, trow.fireAt);
  }

  // Broker registrations in document order; first early-buffered correlation wins.
  for (const m of subMeta) {
    if (alreadyParked) {
      // A rewalk must not re-open a branch whose subscription already resolved
      // (consumed/superseded) — re-registering would clear the broker's consumed
      // marker and leak a zombie active subscription holding the key (S2).
      const cur = await getSubscriptionForVisit(env.DB, instanceId, m.branch.catchId, occ);
      if (cur && cur.status !== "active") continue;
    }
    const broker = env.CORRELATION_BROKER.get(env.CORRELATION_BROKER.idFromName(m.brokerKey));
    const result = (await broker.registerSubscription({
      workspaceId: inst.workspace_id,
      instanceId,
      workflowInstanceId: inst.workflow_instance_id,
      elementId: m.branch.catchId,
      subscriptionId: m.subscriptionId,
      messageName: m.branch.messageName,
      correlationKey: inst.correlation_key,
      workflowEventType: gwEventType,
      expiresAt,
      now,
    })) as RegisterSubscriptionResult;
    if (result.status === "rejected") {
      await createIncident(
        env,
        instanceId,
        gwId,
        0,
        `Event-based gateway branch '${m.branch.catchId}' could not register a subscription for message '${m.branch.messageName}': ${result.reason}`,
        { existingInstanceId: result.existingInstanceId ?? null, messageName: m.branch.messageName },
        "serviceTaskFailure",
      );
      await historyStmt(env.DB, {
        workspaceId: inst.workspace_id,
        instanceId,
        elementId: gwId,
        type: "invariantViolation",
        diagnostics: { reason: result.reason, messageName: m.branch.messageName, correlationKey: inst.correlation_key },
      }).run();
      return { kind: "incident" };
    }
    if (result.status === "correlated") {
      // Early-buffered message → this branch wins at registration (document order).
      // Return the CAPTURED event; the dispatch applies it in its own memoized step
      // (B1) so the apply survives a crash between this broker consume and the
      // decision commit.
      return { kind: "correlated", branch: m.branch, event: result.event };
    }
  }
  return { kind: "waiting" };
}

// ---------------------------------------------------------------------------
// Message wins
// ---------------------------------------------------------------------------

type ApplyOutcome = { kind: "next"; next: string } | { kind: "incident" };

/**
 * Apply a message-branch win (design §4.5.2): the PLAIN `gateway_decisions`
 * INSERT (the claim) + the payload merge atomic with the transition to the
 * winning catch's flow + consume the winner subscription + supersede the loser
 * subscriptions + flip the timer branch's bookkeeping `cancelled` (the EBG timer
 * has NO `timer_outcomes` row — `gateway_decisions` is its sole decider) +
 * `messageCorrelated` + `ebgDecision`, ALL in one batch. On the decider conflict
 * (a concurrent `fireTimer` won) the whole batch aborts → convert to the recorded
 * (timer) branch; the message is dropped (the documented losing-message outcome).
 */
async function applyEbgMessage(
  env: Env,
  instanceId: string,
  graph: ExecutionGraph,
  gwId: string,
  node: GraphNode,
  occ: number,
  winner: EbgMessageBranch,
  branches: EbgBranches,
  event: MessageEventPayload,
  activeTokenId?: string,
): Promise<ApplyOutcome> {
  // Idempotent re-run guard: a recorded decision means the race already resolved.
  const decided = await getGatewayDecision(env.DB, instanceId, gwId, occ);
  if (decided) return { kind: "next", next: winnerNextOf(graph, node, decided.chosenFlowId) };

  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const next = winnerNextOf(graph, node, winner.flowId);
  // Branch-scoped payload (M4-L6.4, design §5.7): an eventBasedGateway whose MESSAGE
  // branch wins INSIDE a parallel branch merges its payload onto the active branch
  // token's OWN overlay (not root); root vars mutate only at the join fold-up. A
  // null/root token keeps the exact M0–M3 path (merge into process_instances.variables).
  // Mirrors applyMessage / applyForwardCompletion. (Was the M4-L3 review DEFERRED here.)
  const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
  const branchTokenRow = isBranch ? await getToken(env.DB, activeTokenId!) : null;
  // R2-aware read (M4-L6, design §9.1): a branch overlay may be an {"__r2":…} ref.
  const baseVars = isBranch ? (branchTokenRow ? await readOverlay(env, parseOverlay(branchTokenRow)) : {}) : parseJson<JsonObject>(inst.variables, {});
  const merged = mergeVariables(baseVars, event.payload ?? {});
  // R2-aware write (M4-L6): offload a large branch overlay before the D1 commit.
  const storedBranchOverlay = isBranch ? await writeOverlay(env, instanceId, activeTokenId!, merged) : merged;
  const winnerSub = await getSubscriptionForVisit(env.DB, instanceId, winner.catchId, occ);
  const winnerSubId = winnerSub?.subscription_id ?? subscriptionIdFor(instanceId, winner.catchId, occ);

  const stmts: D1PreparedStatement[] = [
    insertGatewayDecisionStmt(env.DB, {
      decisionId: newId("gwd"),
      instanceId,
      elementId: gwId,
      occurrence: occ,
      chosenFlowId: winner.flowId,
      isDefault: false,
      evaluations: [],
      variablesSnapshot: null,
      now,
    }), // THE CLAIM
    // A branch token's payload goes to its OWN overlay (design §5.7); the instance
    // status moves to 'running' WITHOUT touching root vars or pinning a single
    // current_element_id (NULL = multi-token frontier). A root/single-token token
    // keeps the exact M0–M3 write (merged → process_instances.variables).
    ...(isBranch
      ? [setTokenOverlayStmt(env.DB, activeTokenId!, storedBranchOverlay, now), applyTransitionStmt(env.DB, { instanceId, currentElementId: null, status: "running", now })]
      : [applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: next, status: "running", now })]),
    messageCorrelatedStmt(env.DB, { externalMessageId: event.externalMessageId, instanceId, subscriptionId: winnerSubId, now }),
    variableSnapshotStmt(env.DB, { instanceId, source: "message", sourceId: event.externalMessageId, variables: event.payload ?? {}, now }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId: winner.catchId,
      externalMessageId: event.externalMessageId,
      type: "messageCorrelated",
      diagnostics: { subscriptionId: winnerSubId, messageName: event.messageName, messageId: event.messageId, occurrence: occ, viaEventGateway: gwId, ...branchHistoryTags(activeTokenId) },
      payloadSnapshot: event.payload ?? {},
    }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId: gwId,
      type: "ebgDecision",
      diagnostics: { winner: winner.catchId, branch: "message", flowId: winner.flowId, messageName: event.messageName, occurrence: occ, ...branchHistoryTags(activeTokenId) },
    }),
  ];
  if (winnerSub?.status === "active") {
    stmts.push(subscriptionConsumedStmt(env.DB, winnerSub.subscription_id, event.externalMessageId, now));
  }
  // Supersede the loser message branches (D1) so a rewalk never treats them as live.
  const loserSubs: SubscriptionRow[] = [];
  for (const m of branches.message) {
    if (m.catchId === winner.catchId) continue;
    const sub = await getSubscriptionForVisit(env.DB, instanceId, m.catchId, occ);
    if (sub?.status === "active") {
      stmts.push(subscriptionSupersededStmt(env.DB, sub.subscription_id, now));
      loserSubs.push(sub);
    }
  }
  // Flip the timer branch's bookkeeping `cancelled` (NO timer_outcomes row).
  if (branches.timer) {
    stmts.push(
      flipTimerCancelledStmt(env.DB, { timerId: timerIdFor(instanceId, branches.timer.catchId, occ), now }),
      historyStmt(env.DB, {
        workspaceId: inst.workspace_id,
        instanceId,
        elementId: branches.timer.catchId,
        type: "timerCancelled",
        diagnostics: { kind: "eventGateway", gateway: gwId, occurrence: occ, reason: "message branch won" },
      }),
    );
  }
  try {
    await dbBatch(env.DB, stmts);
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      // A concurrent fireTimer claimed the decider first → convert to its branch.
      const won = await getGatewayDecision(env.DB, instanceId, gwId, occ);
      if (won) return { kind: "next", next: winnerNextOf(graph, node, won.chosenFlowId) };
    }
    throw err;
  }
  // Best-effort broker supersede of the losing message branches (at-most-one-active).
  for (const sub of loserSubs) await supersedeBrokerSubscription(env, sub);
  return { kind: "next", next };
}

// ---------------------------------------------------------------------------
// Timer wins — the shared fireTimer batch builder
// ---------------------------------------------------------------------------

export type EbgTimerFirePlan =
  | { kind: "fire"; stmts: D1PreparedStatement[]; next: string; wake: TimerWake; brokerSubs: SubscriptionRow[] }
  | { kind: "skip" };

/**
 * The WINNING-FIRE plan for an EBG timer branch (design §4.5.3) — the SHARED
 * builder reused by the DO-alarm path (timers.ts) and the Workflow-mode backstop.
 * The PLAIN `gateway_decisions` INSERT (the claim) + the bookkeeping flip `fired`
 * + supersede ALL message-branch subscriptions + `timerFired` + `ebgDecision` +
 * the transition to the timer catch's flow, in ONE batch. There is NO
 * `timer_outcomes` row — `gateway_decisions` is the EBG timer's sole decider.
 * `kind:"skip"` when the race already resolved (a message won) or the instance
 * progressed.
 */
export async function planEventGatewayTimerFire(
  env: Env,
  graph: ExecutionGraph,
  timer: TimerView,
  inst: InstanceRow,
): Promise<EbgTimerFirePlan> {
  const gwId = timer.gatewayId;
  if (!gwId) return { kind: "skip" };
  const node = graph.nodes[gwId];
  if (!node || node.type !== "eventBasedGateway") return { kind: "skip" };
  const branches = ebgBranches(graph, node);
  if (!branches.timer || branches.timer.catchId !== timer.elementId) return { kind: "skip" };
  const occ = timer.occurrence;
  const instanceId = timer.instanceId;

  // Per-token guard (M4, design §5.3): the EBG timer has no timer_outcomes row, so
  // the gateway_decisions row is the SOLE per-(element,occurrence) decider — already
  // decided (message won, or a prior fire) → no-op. The scalar current_element_id
  // check is redundant with this and stale-prone under concurrency; dropped.
  if (await getGatewayDecision(env.DB, instanceId, gwId, occ)) return { kind: "skip" };

  const now = nowIso();
  const next = winnerNextOf(graph, node, branches.timer.flowId);
  const stmts: D1PreparedStatement[] = [
    insertGatewayDecisionStmt(env.DB, {
      decisionId: newId("gwd"),
      instanceId,
      elementId: gwId,
      occurrence: occ,
      chosenFlowId: branches.timer.flowId,
      isDefault: false,
      evaluations: [],
      variablesSnapshot: null,
      now,
    }), // THE CLAIM
    flipTimerFiredStmt(env.DB, { timerId: timer.timerId, firedAt: now, now }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId: timer.elementId,
      type: "timerFired",
      diagnostics: { kind: "eventGateway", gateway: gwId, occurrence: occ, catchTarget: next },
    }),
    historyStmt(env.DB, {
      workspaceId: inst.workspace_id,
      instanceId,
      elementId: gwId,
      type: "ebgDecision",
      diagnostics: { winner: timer.elementId, branch: "timer", flowId: branches.timer.flowId, occurrence: occ },
    }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: next, status: "running", now }),
  ];
  const brokerSubs: SubscriptionRow[] = [];
  for (const m of branches.message) {
    const sub = await getSubscriptionForVisit(env.DB, instanceId, m.catchId, occ);
    if (sub?.status === "active") {
      stmts.push(subscriptionSupersededStmt(env.DB, sub.subscription_id, now));
      brokerSubs.push(sub);
    }
  }
  return {
    kind: "fire",
    stmts,
    next,
    wake: { instanceId, workflowEventType: workflowEventGatewayTypeFor(gwId, occ), timerId: timer.timerId },
    brokerSubs,
  };
}

/**
 * Lost-alarm backstop for an EBG timer branch (design §4.2, risk R5) — the EBG
 * analogue of settleOverdueIntermediateCatchOnWake. Invoked from the TIMEOUT-wake
 * branch of `driveEventBasedGateway` (already inside a drive), so an overdue timer
 * branch is settled INLINE (the identical `planEventGatewayTimerFire` batch) and
 * the timer path is RETURNED to the drive loop. Workflow-mode-only.
 */
export async function settleOverdueEventGatewayTimerOnWake(
  env: Env,
  graph: ExecutionGraph,
  instanceId: string,
  gatewayId: string,
  occ: number,
): Promise<WakeSettleOutcome> {
  const node = graph.nodes[gatewayId];
  if (!node || node.type !== "eventBasedGateway") return { kind: "fallThrough" };
  const branches = ebgBranches(graph, node);
  if (!branches.timer) return { kind: "fallThrough" };
  const timerId = timerIdFor(instanceId, branches.timer.catchId, occ);

  // Already decided → convert: the decision row tells us which branch won.
  if (await getGatewayDecision(env.DB, instanceId, gatewayId, occ)) return { kind: "fired", next: winnerNextOf(graph, node, branches.timer.flowId) };

  const trow = await getTimer(env.DB, timerId);
  if (!trow || trow.status !== "armed") return { kind: "fallThrough" };
  if (isoIsBefore(nowIso(), trow.fireAt)) {
    await armTimerDO(env, trow.timerId, trow.fireAt);
    return { kind: "reparked" };
  }
  const inst = await getInstanceRow(env.DB, instanceId);
  if (!inst || isTerminalInstanceStatus(inst.status)) return { kind: "fallThrough" };

  const plan = await planEventGatewayTimerFire(env, graph, trow, inst);
  if (plan.kind !== "fire") return { kind: "fallThrough" };
  try {
    await dbBatch(env.DB, plan.stmts);
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const won = await getGatewayDecision(env.DB, instanceId, gatewayId, occ);
      if (won) return { kind: "fired", next: winnerNextOf(graph, node, won.chosenFlowId) };
      return { kind: "fallThrough" };
    }
    throw err;
  }
  for (const sub of plan.brokerSubs) await supersedeBrokerSubscription(env, sub);
  return { kind: "fired", next: plan.next };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Deterministic per-(instance, catch, occurrence) subscription id (replay-stable). */
function subscriptionIdFor(instanceId: string, catchId: string, occ: number): string {
  return `ebgsub:${instanceId}:${catchId}#${occ}`;
}
