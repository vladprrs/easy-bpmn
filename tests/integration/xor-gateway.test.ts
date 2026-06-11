import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  LOOP_XOR_BPMN,
  SAGA_XOR_NODEFAULT_BPMN,
  XOR_BPMN,
  authedPost,
  get,
  mintWorkerToken,
  post,
  publishAndStart,
} from "../helpers";
import { ensureWorkspace } from "../../src/persistence/db";
import { createVersion } from "../../src/persistence/definitions";
import { createInstance } from "../../src/persistence/instances";
import { getGatewayDecision } from "../../src/persistence/gateway-decisions";
import { decideGateway, resumeInline } from "../../src/runtime/engine";
import type { ExecutionGraph } from "../../src/bpmn/graph";

// TASK-34 — exclusiveGateway dispatch (design M2 §6), DIRECT mode. Replaces
// the pre-TASK-34 xor-engine-guard.test.ts (the engine guard is gone — a
// gateway now DISPATCHES instead of settling a not-yet-supported incident).
//
// One persisted step per gateway visit (`gw:el#occ`): evaluate non-default
// outgoing conditions in DOCUMENT ORDER, first boolean true wins, else the
// default flow, else terminal noPath (a Hazard inside a transaction). The
// decision row + transition + gatewayDecisionEvaluated history event commit
// in ONE dbBatch; an existing row for (instance, gateway, occurrence) is the
// rewalk fast-forward predicate — reused, never re-evaluated.

/** Lease the single open job of `taskType` over the pull plane and complete it. */
async function leaseAndComplete(token: string, taskType: string, output: Record<string, unknown> = {}) {
  const r = await authedPost("/jobs/activate", token, { taskType, workerId: "xor-worker" });
  expect(r.status).toBe(200);
  expect(r.body.jobs).toHaveLength(1);
  const job = r.body.jobs[0] as { jobId: string; lockToken: string; elementId: string };
  const done = await authedPost(`/jobs/${job.jobId}/complete`, token, {
    lockToken: job.lockToken,
    outputVariables: output,
  });
  expect(done.status).toBe(200);
  return job;
}

async function gatewayHistoryEvents(instanceId: string) {
  const history = await get(`/instances/${instanceId}/history`);
  return history.body.events.filter((e: any) => e.type === "gatewayDecisionEvaluated");
}

async function jobElements(instanceId: string): Promise<Array<[string, number]>> {
  const rows = await env.DB.prepare(
    `SELECT element_id, occurrence FROM service_task_jobs WHERE instance_id = ? ORDER BY element_id, occurrence`,
  )
    .bind(instanceId)
    .all<{ element_id: string; occurrence: number }>();
  return (rows.results ?? []).map((r) => [r.element_id, r.occurrence]);
}

describe("exclusiveGateway dispatch — data-driven branching (XOR_BPMN)", () => {
  it("routes by data: evaluations recorded in document order, the join is a pass-through decision, history is the operator surface", async () => {
    const { instance } = await publishAndStart(XOR_BPMN, {
      correlationKey: `xor-silver-${crypto.randomUUID()}`,
      variables: { amount: 50 },
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // amount=50: f_gold (amount > 100) false → f_silver (amount > 10) true.
    const mid = await get(`/instances/${id}`);
    expect(mid.body.status).toBe("waiting");
    expect(mid.body.currentElementId).toBe("T_silver");

    // Decision row: chosen flow + per-flow evaluations in DOCUMENT order
    // (f_gold before f_silver — flowElements order, NOT the <outgoing> ref
    // order inside the gateway), short-circuited at the first true; the
    // default (f_def) is never evaluated and therefore not recorded.
    const split = await getGatewayDecision(env.DB, id, "GW_split", 0);
    expect(split).toBeTruthy();
    expect(split!.chosenFlowId).toBe("f_silver");
    expect(split!.isDefault).toBe(false);
    expect(split!.evaluations.map((e) => [e.flowId, e.result])).toEqual([
      ["f_gold", false],
      ["f_silver", true],
    ]);
    expect(split!.evaluations[0]!.expression).toBe("amount > 100");
    expect(split!.evaluations[0]!.value).toBe(false); // raw FEEL value, JSON-safe
    expect(split!.variablesSnapshot).toEqual({ amount: 50 });

    // Exactly one job, on the chosen branch only.
    expect(await jobElements(id)).toEqual([["T_silver", 0]]);
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "silver-handler", { tier: "silver" });

    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
    expect(done.body.variables).toMatchObject({ amount: 50, tier: "silver" });

    // The join (N-in/1-out) is a PASS-THROUGH: a uniform decision row with
    // the single flow chosen, NO evaluations, NO snapshot.
    const join = await getGatewayDecision(env.DB, id, "GW_join", 0);
    expect(join).toBeTruthy();
    expect(join!.chosenFlowId).toBe("f_end");
    expect(join!.isDefault).toBe(false);
    expect(join!.evaluations).toEqual([]);
    expect(join!.variablesSnapshot).toBeNull();

    // Operator visibility: one gatewayDecisionEvaluated history event per
    // visit, carrying {chosenFlowId, occurrence, evaluations} in diagnostics
    // (committed in the SAME dbBatch as the decision row + transition).
    const gwEvents = await gatewayHistoryEvents(id);
    expect(gwEvents).toHaveLength(2);
    const splitEvent = gwEvents.find((e: any) => e.elementId === "GW_split");
    expect(splitEvent.diagnostics.chosenFlowId).toBe("f_silver");
    expect(splitEvent.diagnostics.occurrence).toBe(0);
    expect(splitEvent.diagnostics.isDefault).toBe(false);
    expect(splitEvent.diagnostics.evaluations.map((e: any) => e.flowId)).toEqual(["f_gold", "f_silver"]);
    const joinEvent = gwEvents.find((e: any) => e.elementId === "GW_join");
    expect(joinEvent.diagnostics.passThrough).toBe(true);
  });

  it("takes the default flow when no condition is true and records is_default", async () => {
    const { instance } = await publishAndStart(XOR_BPMN, {
      correlationKey: `xor-basic-${crypto.randomUUID()}`,
      variables: { amount: 5 },
    });
    const id = instance.body.instanceId;

    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("T_basic");
    const split = await getGatewayDecision(env.DB, id, "GW_split", 0);
    expect(split!.chosenFlowId).toBe("f_def");
    expect(split!.isDefault).toBe(true);
    // ALL non-default conditions were evaluated (none true); the default
    // itself carries no expression and is never evaluated.
    expect(split!.evaluations.map((e) => [e.flowId, e.result])).toEqual([
      ["f_gold", false],
      ["f_silver", false],
    ]);

    const token = await mintWorkerToken();
    await leaseAndComplete(token, "basic-handler", { tier: "basic" });
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  it("multiple true conditions → the FIRST in document order wins, deterministically (short-circuit pinned)", async () => {
    // amount=500 satisfies BOTH f_gold (>100) and f_silver (>10).
    const { instance } = await publishAndStart(XOR_BPMN, {
      correlationKey: `xor-gold-${crypto.randomUUID()}`,
      variables: { amount: 500 },
    });
    const id = instance.body.instanceId;

    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("T_gold");
    const split = await getGatewayDecision(env.DB, id, "GW_split", 0);
    expect(split!.chosenFlowId).toBe("f_gold");
    expect(split!.isDefault).toBe(false);
    // Evaluation short-circuits at the first true: f_silver was NEVER
    // evaluated, so it is absent from the record by design.
    expect(split!.evaluations.map((e) => [e.flowId, e.result])).toEqual([["f_gold", true]]);
    // The losing-but-also-true branch never got a job.
    expect(await jobElements(id)).toEqual([["T_gold", 0]]);
  });
});

describe("exclusiveGateway no-match — terminal noPath, Hazard inside a transaction (SAGA_XOR_NODEFAULT_BPMN)", () => {
  it("no condition true + no default → noPath incident; NO auto-compensation; operator /cancel compensates", async () => {
    // Guard against stale string surgery in the fixture derivation.
    expect(SAGA_XOR_NODEFAULT_BPMN).not.toContain('default="f_wire"');
    expect(SAGA_XOR_NODEFAULT_BPMN).toContain('method = "wire"');

    const { instance } = await publishAndStart(SAGA_XOR_NODEFAULT_BPMN, {
      correlationKey: `xor-nopath-${crypto.randomUUID()}`,
      variables: { method: "bank" }, // matches neither "card" nor "wire"
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // reserveFunds completes (compensatable → ledger row 'pending'), then the
    // gateway finds no path.
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "reserve-funds", { reservationId: "rf-1" });

    const hazard = await get(`/instances/${id}`);
    expect(hazard.body.status).toBe("incident");
    expect(hazard.body.incident.kind).toBe("noPath");
    expect(hazard.body.incident.elementId).toBe("GW_method");
    expect(hazard.body.incident.reason).toMatch(/no default/i);
    expect(hazard.body.incident.status).toBe("open");
    // Hazard semantics: the completed compensatable step is STRANDED — no
    // auto-compensation ever runs off a noPath.
    expect(hazard.body.saga.steps.find((s: any) => s.elementId === "reserveFunds").compensationStatus).toBe("pending");
    // No decision row for the failed visit — the incident is the record.
    expect(await getGatewayDecision(env.DB, id, "GW_method", 0)).toBeNull();

    // Operator /cancel stays available from 'incident' and forces the reverse pass.
    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("compensating");

    await leaseAndComplete(token, "release-funds", { released: true });
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");
    expect(done.body.saga.steps.find((s: any) => s.elementId === "reserveFunds").compensationStatus).toBe("compensated");
  });
});

describe("decision replay — direct-mode rewalk reuses the persisted decision", () => {
  it("mutating variables between resumes never re-routes a recorded decision", async () => {
    const { instance } = await publishAndStart(XOR_BPMN, {
      correlationKey: `xor-replay-${crypto.randomUUID()}`,
      variables: { amount: 50 },
    });
    const id = instance.body.instanceId;
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("T_silver");

    // Mutate the variables so a RE-evaluation would now choose f_gold.
    await env.DB.prepare(`UPDATE process_instances SET variables = ? WHERE instance_id = ?`)
      .bind(JSON.stringify({ amount: 500 }), id)
      .run();

    await resumeInline(env, id);
    await resumeInline(env, id);

    // The original branch is kept: the rewalk fast-forwards on the decision
    // ROW (existence predicate), it never re-evaluates.
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("T_silver");
    const split = await getGatewayDecision(env.DB, id, "GW_split", 0);
    expect(split!.chosenFlowId).toBe("f_silver");
    expect(split!.variablesSnapshot).toEqual({ amount: 50 }); // original context, untouched
    // Fast-forward is write-free: still exactly ONE decision event, no gold job.
    expect(await gatewayHistoryEvents(id)).toHaveLength(1);
    expect(await jobElements(id)).toEqual([["T_silver", 0]]);

    // The kept branch still carries the instance to completion via the join.
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "silver-handler", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});

describe("loop through a gateway — LOOP_XOR_BPMN publishes AND executes end-to-end", () => {
  it("N iterations decided per occurrence, exit via the default flow", async () => {
    const { instance } = await publishAndStart(LOOP_XOR_BPMN, {
      correlationKey: `xor-loop-${crypto.randomUUID()}`,
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;
    const token = await mintWorkerToken();

    // T_charge runs ONCE, before the cycle.
    await leaseAndComplete(token, "charge-card", { chargeResult: "declined", attemptsLeft: 2 });
    // GW_retry#0: 'chargeResult = "declined" and attemptsLeft > 0' → true → T_switch#0.
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("T_switch");
    await leaseAndComplete(token, "switch-payment-method", { attemptsLeft: 1 });
    // GW_retry#1: still declined, attemptsLeft 1 → true → T_switch#1.
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("T_switch");
    await leaseAndComplete(token, "switch-payment-method", { chargeResult: "ok" });
    // GW_retry#2: condition false → default f_done → End.
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");

    // One decision per VISIT — each loop pass fast-forwards exactly its own
    // occurrence and decides the next one fresh.
    const d0 = await getGatewayDecision(env.DB, id, "GW_retry", 0);
    const d1 = await getGatewayDecision(env.DB, id, "GW_retry", 1);
    const d2 = await getGatewayDecision(env.DB, id, "GW_retry", 2);
    expect([d0!.chosenFlowId, d0!.isDefault]).toEqual(["f_retry", false]);
    expect([d1!.chosenFlowId, d1!.isDefault]).toEqual(["f_retry", false]);
    expect([d2!.chosenFlowId, d2!.isDefault]).toEqual(["f_done", true]);
    expect(d2!.evaluations.map((e) => [e.flowId, e.result])).toEqual([["f_retry", false]]);
    expect(await getGatewayDecision(env.DB, id, "GW_retry", 3)).toBeNull();

    // The loop body ran as occurrence-keyed jobs; the pre-cycle task exactly once.
    expect(await jobElements(id)).toEqual([
      ["T_charge", 0],
      ["T_switch", 0],
      ["T_switch", 1],
    ]);
    expect(await gatewayHistoryEvents(id)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Engine-harness-only graphs (injected via createVersion, bypassing the
// publish gate) for behaviors a publishable model cannot reach: a hard FEEL
// evaluation error (publish-time parse rejects broken FEEL), an oversized
// evaluation context (the start API rejects oversized variables), a
// conditioned single-flow pass-through, and the duplicate-walk INSERT race.
// ---------------------------------------------------------------------------

function injectedXorGraph(opts: {
  processId: string;
  conditions: Array<{ flowId: string; targetId: string; conditionExpression: string | null; isDefault?: boolean }>;
}): ExecutionGraph {
  return {
    processId: opts.processId,
    startElementId: "Start",
    endElementIds: ["End"],
    elements: [],
    nodes: {
      Start: {
        type: "startEvent",
        next: "GW",
        outgoing: [{ flowId: "f0", targetId: "GW", conditionExpression: null, isDefault: false }],
      },
      GW: {
        type: "exclusiveGateway",
        next: null, // IR contract: the engine must never read .next on a gateway
        outgoing: opts.conditions.map((c) => ({
          flowId: c.flowId,
          targetId: c.targetId,
          conditionExpression: c.conditionExpression,
          isDefault: c.isDefault ?? false,
        })),
      },
      End: { type: "endEvent", next: null, outgoing: [], endKind: "none" },
    },
  };
}

async function injectInstance(graph: ExecutionGraph, variables: Record<string, unknown>): Promise<string> {
  const now = new Date().toISOString();
  await ensureWorkspace(env.DB, "default", now);
  const versionId = `pdv_gw_${crypto.randomUUID()}`;
  await createVersion(env.DB, {
    definitionVersionId: versionId,
    draftId: `draft_gw_${crypto.randomUUID()}`,
    workspaceId: "default",
    versionNumber: 1,
    bpmnXml: "<!-- engine-harness-only gateway graph; injected, never published -->",
    bpmnXmlHash: `hash_${crypto.randomUUID()}`,
    graph,
    now,
  });
  const instanceId = `pi_gw_${crypto.randomUUID()}`;
  await createInstance(env.DB, {
    instanceId,
    workspaceId: "default",
    definitionVersionId: versionId,
    workflowInstanceId: instanceId,
    correlationKey: `gw-${crypto.randomUUID()}`,
    startElementId: "Start",
    variables,
    now,
  });
  return instanceId;
}

describe("exclusiveGateway edge semantics (injected graphs)", () => {
  it("a hard FEEL evaluation error → deterministic operator-visible incident; later flows are never taken", async () => {
    const id = await injectInstance(
      injectedXorGraph({
        processId: "P_gwerr",
        conditions: [
          // Parses are publish-gated, so a broken expression can only be
          // reached via injection — exactly the deterministic hard-throw case.
          { flowId: "f_bad", targetId: "End", conditionExpression: "amount >" },
          // A later flow that WOULD match must never be taken after a hard
          // error on an earlier one (determinism).
          { flowId: "f_true", targetId: "End", conditionExpression: "true" },
        ],
      }),
      { amount: 1 },
    );
    const result = await resumeInline(env, id);
    expect(result.status).toBe("incident");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.elementId).toBe("GW");
    // Distinguished from noPath: the reason names the flow + the FEEL failure.
    expect(inst.body.incident.kind).not.toBe("noPath");
    expect(inst.body.incident.reason).toMatch(/f_bad/);
    expect(inst.body.incident.reason).toMatch(/failed to evaluate/i);
    // No decision was recorded and no branch was taken.
    expect(await getGatewayDecision(env.DB, id, "GW", 0)).toBeNull();
    expect(inst.body.status).not.toBe("completed");
  });

  it("variables_snapshot is size-capped: an oversized context is omitted (null + diagnostics flag), never an error", async () => {
    const id = await injectInstance(
      injectedXorGraph({
        processId: "P_gwbig",
        conditions: [
          { flowId: "f_yes", targetId: "End", conditionExpression: "true" },
          { flowId: "f_no", targetId: "End", conditionExpression: null, isDefault: true },
        ],
      }),
      { blob: "x".repeat(1_100_000) }, // > the 1 MB payload limit
    );
    const result = await resumeInline(env, id);
    expect(result.status).toBe("completed");

    const d = await getGatewayDecision(env.DB, id, "GW", 0);
    expect(d!.chosenFlowId).toBe("f_yes");
    expect(d!.variablesSnapshot).toBeNull(); // capped, not an error
    const [event] = await gatewayHistoryEvents(id);
    expect(event.diagnostics.variablesSnapshotOmitted).toBe(true);
  });

  it("a single-flow gateway is a pass-through even when its flow carries a condition (never evaluated)", async () => {
    const id = await injectInstance(
      injectedXorGraph({
        processId: "P_gwpass",
        // The validator tolerates a condition on a 1-out gateway's flow; the
        // design pins pass-through — even a false condition must NOT block.
        conditions: [{ flowId: "f_only", targetId: "End", conditionExpression: "false" }],
      }),
      { anything: true },
    );
    const result = await resumeInline(env, id);
    expect(result.status).toBe("completed");

    const d = await getGatewayDecision(env.DB, id, "GW", 0);
    expect(d!.chosenFlowId).toBe("f_only");
    expect(d!.evaluations).toEqual([]); // the condition was never evaluated
    expect(d!.variablesSnapshot).toBeNull();
  });

  it("non-primitive FEEL results (Range) are normalized JSON-safe before persisting", async () => {
    const id = await injectInstance(
      injectedXorGraph({
        processId: "P_gwrange",
        conditions: [
          // "[1..10]" evaluates to a FEEL Range object — never boolean true,
          // so the flow is not taken, but the raw value must persist as a
          // deterministic JSON-safe tag (publish-time lint rejects this
          // unary-test shape, so it is only reachable via injection).
          { flowId: "f_range", targetId: "End", conditionExpression: "[1..10]" },
          { flowId: "f_true", targetId: "End", conditionExpression: "true" },
        ],
      }),
      {},
    );
    const result = await resumeInline(env, id);
    expect(result.status).toBe("completed");

    const d = await getGatewayDecision(env.DB, id, "GW", 0);
    expect(d!.chosenFlowId).toBe("f_true");
    expect(d!.evaluations.map((e) => [e.flowId, e.result])).toEqual([
      ["f_range", false],
      ["f_true", true],
    ]);
    // The Range survived persistence as a string tag, not a JSON explosion.
    expect(d!.evaluations[0]!.value).toMatch(/^\[feel:/);
    expect(d!.evaluations[1]!.value).toBe(true);
  });

  it("cycle through a PASS-THROUGH (1-out) gateway: each visit fast-forwards exactly its own occurrence-keyed decision row", async () => {
    // Start → GWpass (1-out join) → TaskA → GWexit (loop back / default exit).
    // The KEY pass-through constraint: a later iteration's rewalk must
    // fast-forward GWpass#k-1 on ITS row and still decide GWpass#k fresh.
    const taskType = `gw-cycle-${crypto.randomUUID()}`;
    const graph: ExecutionGraph = {
      processId: "P_gwcycle",
      startElementId: "Start",
      endElementIds: ["End"],
      elements: [],
      nodes: {
        Start: {
          type: "startEvent",
          next: "GWpass",
          outgoing: [{ flowId: "f0", targetId: "GWpass", conditionExpression: null, isDefault: false }],
        },
        GWpass: {
          type: "exclusiveGateway",
          next: null,
          outgoing: [{ flowId: "f_pass", targetId: "TaskA", conditionExpression: null, isDefault: false }],
        },
        TaskA: {
          type: "serviceTask",
          taskType,
          retries: 1,
          next: "GWexit",
          outgoing: [{ flowId: "f1", targetId: "GWexit", conditionExpression: null, isDefault: false }],
        },
        GWexit: {
          type: "exclusiveGateway",
          next: null,
          outgoing: [
            { flowId: "f_again", targetId: "GWpass", conditionExpression: "count < 2", isDefault: false },
            { flowId: "f_exit", targetId: "End", conditionExpression: null, isDefault: true },
          ],
        },
        End: { type: "endEvent", next: null, outgoing: [], endKind: "none" },
      },
    };
    const id = await injectInstance(graph, { count: 0 });
    expect((await resumeInline(env, id)).status).toBe("waiting"); // parked at TaskA#0

    const token = await mintWorkerToken();
    await leaseAndComplete(token, taskType, { count: 1 }); // GWexit#0 → f_again → GWpass#1 → TaskA#1
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("TaskA");
    await leaseAndComplete(token, taskType, { count: 2 }); // GWexit#1 → default exit
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");

    // One pass-through decision row PER VISIT, each chosen on its own occurrence.
    const p0 = await getGatewayDecision(env.DB, id, "GWpass", 0);
    const p1 = await getGatewayDecision(env.DB, id, "GWpass", 1);
    expect(p0!.chosenFlowId).toBe("f_pass");
    expect(p1!.chosenFlowId).toBe("f_pass");
    expect(p0!.decisionId).not.toBe(p1!.decisionId);
    expect(p0!.evaluations).toEqual([]);
    expect(p1!.evaluations).toEqual([]);
    expect(await getGatewayDecision(env.DB, id, "GWpass", 2)).toBeNull();

    const x0 = await getGatewayDecision(env.DB, id, "GWexit", 0);
    const x1 = await getGatewayDecision(env.DB, id, "GWexit", 1);
    expect([x0!.chosenFlowId, x0!.isDefault]).toEqual(["f_again", false]);
    expect([x1!.chosenFlowId, x1!.isDefault]).toEqual(["f_exit", true]);

    // The loop body ran as occurrence-keyed jobs (the rewalks through the
    // pass-through were write-free fast-forwards, never re-decisions).
    expect(await jobElements(id)).toEqual([
      ["TaskA", 0],
      ["TaskA", 1],
    ]);
    expect(await gatewayHistoryEvents(id)).toHaveLength(4); // GWpass×2 + GWexit×2
  });

  it("duplicate concurrent walks: the losing plain INSERT aborts its whole batch; the loser follows the recorded branch", async () => {
    const graph = injectedXorGraph({
      processId: "P_gwrace",
      conditions: [
        { flowId: "f_high", targetId: "End", conditionExpression: "amount > 100" },
        { flowId: "f_low", targetId: "End", conditionExpression: null, isDefault: true },
      ],
    });
    const id = await injectInstance(graph, { amount: 500 });

    // Both walks read "no decision yet" before either batch commits (each
    // dispatches its check-first SELECT synchronously under Promise.all), so
    // exactly one plain INSERT wins and the other hits the unique index —
    // the documented race the catch path must absorb by RE-READING, never
    // re-evaluating, and never erroring out.
    const node = graph.nodes["GW"]!;
    const [a, b] = await Promise.all([
      decideGateway(env, id, "GW", 0, node),
      decideGateway(env, id, "GW", 0, node),
    ]);
    expect(a).toEqual({ kind: "next", next: "End" });
    expect(b).toEqual(a);

    // The losing batch (decision + history + transition) aborted ATOMICALLY:
    // exactly one decision row and one history event survive.
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM gateway_decisions WHERE instance_id = ? AND element_id = 'GW' AND occurrence = 0`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect(await gatewayHistoryEvents(id)).toHaveLength(1);
    const d = await getGatewayDecision(env.DB, id, "GW", 0);
    expect(d!.chosenFlowId).toBe("f_high");
  });
});
