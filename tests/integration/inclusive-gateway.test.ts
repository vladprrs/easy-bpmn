import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, drainSampleWorkers, get, INCLUSIVE_BPMN } from "../helpers";
import { getGatewayDecision } from "../../src/persistence/gateway-decisions";
import { ensureWorkspace } from "../../src/persistence/db";
import { createVersion } from "../../src/persistence/definitions";
import { createInstance } from "../../src/persistence/instances";
import { resumeInline } from "../../src/runtime/engine";
import type { ExecutionGraph } from "../../src/bpmn/graph";

// INCLUSIVE_BPMN minus the split's `default` — all three out-flows now carry a
// FEEL condition, so an instance matching NONE raises the terminal `noPath`
// incident (an inclusive split never silently drops its token, design §6.4).
// String surgery (like SAGA_XOR_NODEFAULT_BPMN) keeps it in lockstep with the
// default-carrying original.
const INCLUSIVE_NODEFAULT_BPMN = INCLUSIVE_BPMN.replace(' default="f_def"', "").replace(
  '<bpmn:sequenceFlow id="f_def" sourceRef="fork" targetRef="Log"/>',
  '<bpmn:sequenceFlow id="f_def" sourceRef="fork" targetRef="Log"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">wantsLog = true</bpmn:conditionExpression></bpmn:sequenceFlow>',
);

// M4-L4 (design §6): an inclusiveGateway (OR) split activates the subset of
// branches whose FEEL conditions are true (recorded verbatim in
// gateway_decisions.activated_flow_ids), the matching OR join waits for exactly
// that recorded subset (origin-branch keyed), zero true conditions take the
// `default`, and the join produces its single output token exactly once. All in
// EXECUTION_MODE=direct (the CI harness).
describe("inclusiveGateway OR (M4-L4, direct mode)", () => {
  it("activates only the true-condition branches; the join waits for exactly them", async () => {
    const { instance } = await publishAndStart(INCLUSIVE_BPMN, {
      correlationKey: "i1",
      variables: { wantsEmail: true, wantsSms: false },
    });
    const id = instance.body.instanceId;
    // Only the email branch is true; default is taken only when NONE is true.
    await drainSampleWorkers({ taskTypes: ["send-email", "send-sms", "log-only"] });
    const dec = await getGatewayDecision(env.DB, id, "fork", 0);
    expect(dec?.activatedFlowIds).toEqual(["f_email"]);
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
  });

  it("activates two branches when two conditions are true; join waits for both", async () => {
    const { instance } = await publishAndStart(INCLUSIVE_BPMN, {
      correlationKey: "i2",
      variables: { wantsEmail: true, wantsSms: true },
    });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: ["send-email", "send-sms", "log-only"] });
    const dec = await getGatewayDecision(env.DB, id, "fork", 0);
    // Recorded in DOCUMENT order (f_email before f_sms); .sort() is order-agnostic.
    expect((dec?.activatedFlowIds ?? []).sort()).toEqual(["f_email", "f_sms"]);
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  it("takes the default when no condition is true", async () => {
    const { instance } = await publishAndStart(INCLUSIVE_BPMN, {
      correlationKey: "i3",
      variables: { wantsEmail: false, wantsSms: false },
    });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: ["send-email", "send-sms", "log-only"] });
    const dec = await getGatewayDecision(env.DB, id, "fork", 0);
    expect(dec?.activatedFlowIds).toEqual(["f_def"]);
    expect(dec?.isDefault).toBe(true);
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  // L4.3 guard (AC #6): the OR join produces exactly one output token and never
  // forks a non-activated branch — a wantsSms=false instance never creates a
  // send-sms job, so no send-sms history event exists. (diagnostics.taskType is
  // recorded by forward-task.ts on every serviceTask visit.)
  it("the OR join produces exactly one token and ignores non-activated branches", async () => {
    const { instance } = await publishAndStart(INCLUSIVE_BPMN, {
      correlationKey: "i4",
      variables: { wantsEmail: true, wantsSms: false },
    });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: ["send-email", "send-sms", "log-only"] });
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    const hist = (await get(`/instances/${id}/history`)).body.events as any[];
    // Non-activated branches (sms + default log) never forked → no job/history for them.
    expect(hist.some((e) => e.diagnostics?.taskType === "send-sms")).toBe(false);
    expect(hist.some((e) => e.diagnostics?.taskType === "log-only")).toBe(false);
    // Exactly one join completion → exactly one joinCompleted history event.
    expect(hist.filter((e) => e.type === "joinCompleted").length).toBe(1);
  });

  // AC #3 (rewalk discipline, design §6.1): the recorded activation subset is
  // reused VERBATIM on every re-drive and conditions are NEVER re-evaluated —
  // even when variables change after the split has decided (the exact
  // exclusiveGateway contract). Mutate wantsSms→true AFTER the split recorded
  // [f_email]; the sms branch must never fork.
  it("reuses the recorded activation verbatim on rewalk — never re-evaluates even if variables changed", async () => {
    const { instance } = await publishAndStart(INCLUSIVE_BPMN, {
      correlationKey: "i6",
      variables: { wantsEmail: true, wantsSms: false },
    });
    const id = instance.body.instanceId;
    // The start drive already fanned out + recorded the activation (now parked on send-email).
    expect((await getGatewayDecision(env.DB, id, "fork", 0))?.activatedFlowIds).toEqual(["f_email"]);
    // Flip wantsSms true: a re-evaluation WOULD now activate f_sms — fast-forward must ignore it.
    await env.DB.prepare("UPDATE process_instances SET variables = ? WHERE instance_id = ?")
      .bind(JSON.stringify({ wantsEmail: true, wantsSms: true }), id)
      .run();
    await drainSampleWorkers({ taskTypes: ["send-email", "send-sms", "log-only"] });
    // Recorded activation unchanged; sms branch never forked; instance still completes.
    expect((await getGatewayDecision(env.DB, id, "fork", 0))?.activatedFlowIds).toEqual(["f_email"]);
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    const hist = (await get(`/instances/${id}/history`)).body.events as any[];
    expect(hist.some((e) => e.diagnostics?.taskType === "send-sms")).toBe(false);
  });

  // AC #4 / #8: no true condition AND no default → terminal noPath (the token is
  // not silently dropped). Reached via a published no-default OR model.
  it("raises terminal noPath when no condition is true and there is no default", async () => {
    const { instance } = await publishAndStart(INCLUSIVE_NODEFAULT_BPMN, {
      correlationKey: "i5",
      variables: { wantsEmail: false, wantsSms: false }, // wantsLog absent ⇒ all false
    });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: ["send-email", "send-sms", "log-only"] });
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("noPath");
    expect(inst.body.incident.elementId).toBe("fork");
    // No branch was activated → no decision row, no branch jobs.
    expect(await getGatewayDecision(env.DB, id, "fork", 0)).toBeNull();
    const hist = (await get(`/instances/${id}/history`)).body.events as any[];
    expect(hist.some((e) => e.diagnostics?.taskType === "send-email")).toBe(false);
  });
});

// A hard FEEL evaluation error at an OR split → conditionFailure (AC #4 / #8).
// Publish parses every condition, so a broken expression is only reachable via an
// injected graph — exactly the deterministic hard-throw case (mirrors the
// exclusiveGateway injected-graph test). The split bails BEFORE fan-out, so a
// later flow that WOULD match is never activated.
describe("inclusiveGateway OR — conditionFailure (injected graph)", () => {
  function injectedOrGraph(processId: string): ExecutionGraph {
    return {
      processId,
      startElementId: "Start",
      endElementIds: ["End"],
      elements: [],
      regions: {
        fork: { splitId: "fork", joinId: "join", type: "or", branchFlowIds: ["f_bad", "f_true"], enclosingScopeId: processId },
      },
      nodes: {
        Start: { type: "startEvent", next: "fork", outgoing: [{ flowId: "s0", targetId: "fork", conditionExpression: null, isDefault: false }] },
        fork: {
          type: "inclusiveGateway",
          next: null,
          outgoing: [
            // Parse is publish-gated, so a broken expression can only be injected.
            { flowId: "f_bad", targetId: "A", conditionExpression: "amount >", isDefault: false },
            // A later flow that WOULD match must never activate after a hard error.
            { flowId: "f_true", targetId: "B", conditionExpression: "true", isDefault: false },
          ],
        },
        A: { type: "serviceTask", taskType: "send-email", next: "join", outgoing: [{ flowId: "j1", targetId: "join", conditionExpression: null, isDefault: false }] },
        B: { type: "serviceTask", taskType: "send-sms", next: "join", outgoing: [{ flowId: "j2", targetId: "join", conditionExpression: null, isDefault: false }] },
        join: { type: "inclusiveGateway", next: null, outgoing: [{ flowId: "s1", targetId: "End", conditionExpression: null, isDefault: false }] },
        End: { type: "endEvent", next: null, outgoing: [], endKind: "none" },
      },
    };
  }

  async function injectOrInstance(graph: ExecutionGraph, variables: Record<string, unknown>): Promise<string> {
    const now = new Date().toISOString();
    await ensureWorkspace(env.DB, "default", now);
    const versionId = `pdv_or_${crypto.randomUUID()}`;
    await createVersion(env.DB, {
      definitionVersionId: versionId,
      draftId: `draft_or_${crypto.randomUUID()}`,
      workspaceId: "default",
      versionNumber: 1,
      bpmnXml: "<!-- engine-harness-only inclusive graph; injected, never published -->",
      bpmnXmlHash: `hash_${crypto.randomUUID()}`,
      graph,
      now,
    });
    const instanceId = `pi_or_${crypto.randomUUID()}`;
    await createInstance(env.DB, {
      instanceId,
      workspaceId: "default",
      definitionVersionId: versionId,
      workflowInstanceId: instanceId,
      correlationKey: `or-${crypto.randomUUID()}`,
      startElementId: "Start",
      variables,
      now,
    });
    return instanceId;
  }

  it("a hard FEEL error at the split → conditionFailure; no branch is activated", async () => {
    const id = await injectOrInstance(injectedOrGraph("P_orerr"), { amount: 1 });
    const result = await resumeInline(env, id);
    expect(result.status).toBe("incident");

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("conditionFailure");
    expect(inst.body.incident.elementId).toBe("fork");
    expect(inst.body.incident.reason).toMatch(/f_bad/);
    expect(inst.body.incident.reason).toMatch(/failed to evaluate/i);
    // The split bailed before fan-out: no activation recorded, no branch token forked.
    expect(await getGatewayDecision(env.DB, id, "fork", 0)).toBeNull();
  });
});
