import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get } from "../helpers";
import { ensureWorkspace } from "../../src/persistence/db";
import { createVersion } from "../../src/persistence/definitions";
import { createInstance } from "../../src/persistence/instances";
import { MAX_CONCURRENT_TOKENS, STEP_BUDGET_SOFT, resumeInline } from "../../src/runtime/engine";
import type { ExecutionGraph } from "../../src/bpmn/graph";

// M4-L6 (design §9) — the two concurrency caps, DIRECT mode. Like the loop-limit
// tests, these inject an ENGINE-HARNESS-ONLY region graph (createVersion bypasses
// the publish gate) and drive it with resumeInline so the bomb trips inline,
// without 256 real branches or 20000 real steps. A documented TEST-ONLY env
// override lowers each cap; production and tests share the one constant otherwise.

async function injectInstance(processId: string, graph: ExecutionGraph): Promise<string> {
  const now = new Date().toISOString();
  await ensureWorkspace(env.DB, "default", now);
  const versionId = `pdv_${processId}_${crypto.randomUUID()}`;
  await createVersion(env.DB, {
    definitionVersionId: versionId,
    draftId: `draft_${processId}_${crypto.randomUUID()}`,
    workspaceId: "default",
    versionNumber: 1,
    bpmnXml: `<!-- engine-harness-only ${processId} graph; injected, never published -->`,
    bpmnXmlHash: `hash_${crypto.randomUUID()}`,
    graph,
    now,
  });
  const id = `pi_${processId}_${crypto.randomUUID()}`;
  await createInstance(env.DB, {
    instanceId: id,
    workspaceId: "default",
    definitionVersionId: versionId,
    workflowInstanceId: id,
    correlationKey: `cap-${crypto.randomUUID()}`,
    startElementId: "Start",
    variables: {},
    now,
  });
  return id;
}

describe("concurrency caps (M4-L6, direct mode)", () => {
  it("constants are the design values", () => {
    expect(MAX_CONCURRENT_TOKENS).toBe(256);
    expect(STEP_BUDGET_SOFT).toBe(20000);
  });

  it("a fan-out exceeding MAX_CONCURRENT_TOKENS settles a terminal concurrencyLimit incident", async () => {
    // A single AND split fanning out FOUR branches; the test-only override lowers
    // the cap to 2 so the fan-out (0 live + 4 activated > 2) trips at the split.
    const branches = ["f1", "f2", "f3", "f4"];
    const graph: ExecutionGraph = {
      processId: "P_bomb",
      startElementId: "Start",
      endElementIds: ["End"],
      elements: [],
      nodes: {
        Start: { type: "startEvent", next: "Split", outgoing: [{ flowId: "f0", targetId: "Split" }] },
        Split: {
          type: "parallelGateway",
          next: null,
          outgoing: branches.map((f, i) => ({ flowId: f, targetId: `T${i}` })),
        },
        ...Object.fromEntries(
          branches.map((_, i) => [`T${i}`, { type: "serviceTask", taskType: `svc-${i}`, next: "Join", outgoing: [{ flowId: `fj${i}`, targetId: "Join" }] }]),
        ),
        Join: { type: "parallelGateway", next: null, outgoing: [{ flowId: "fout", targetId: "End" }] },
        End: { type: "endEvent", endKind: "none", next: null, outgoing: [] },
      },
      regions: {
        Split: { splitId: "Split", joinId: "Join", type: "and", branchFlowIds: branches, enclosingScopeId: "P_bomb" },
      },
    };
    const id = await injectInstance("bomb", graph);
    (env as unknown as { MAX_CONCURRENT_TOKENS_OVERRIDE?: string }).MAX_CONCURRENT_TOKENS_OVERRIDE = "2";
    try {
      const result = await resumeInline(env, id);
      expect(result.status).toBe("incident");
    } finally {
      delete (env as unknown as { MAX_CONCURRENT_TOKENS_OVERRIDE?: string }).MAX_CONCURRENT_TOKENS_OVERRIDE;
    }
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("concurrencyLimit");
    expect(inst.body.incident.status).toBe("open");
    expect(inst.body.incident.elementId).toBe("Split");
    expect(inst.body.incident.payloadContext.cap).toBe(2);
  });

  it("crossing STEP_BUDGET_SOFT settles a graceful stepBudget incident (below the platform ceiling)", async () => {
    // An AND split with a pure-gateway self-loop on one branch — within ONE drive
    // pass it burns runStep calls until the (lowered) soft budget trips, before
    // MAX_ELEMENT_OCCURRENCES (1000). The graceful incident, not an opaque errored
    // Workflow, is the contract (design §9).
    const graph: ExecutionGraph = {
      processId: "P_step",
      startElementId: "Start",
      endElementIds: ["End"],
      elements: [],
      nodes: {
        Start: { type: "startEvent", next: "Split", outgoing: [{ flowId: "f0", targetId: "Split" }] },
        Split: {
          type: "parallelGateway",
          next: null,
          outgoing: [
            { flowId: "f1", targetId: "Spin" },
            { flowId: "f2", targetId: "Join" },
          ],
        },
        Spin: { type: "exclusiveGateway", next: null, outgoing: [{ flowId: "f_self", targetId: "Spin" }] },
        Join: { type: "parallelGateway", next: null, outgoing: [{ flowId: "fout", targetId: "End" }] },
        End: { type: "endEvent", endKind: "none", next: null, outgoing: [] },
      },
      regions: {
        Split: { splitId: "Split", joinId: "Join", type: "and", branchFlowIds: ["f1", "f2"], enclosingScopeId: "P_step" },
      },
    };
    const id = await injectInstance("step", graph);
    (env as unknown as { STEP_BUDGET_SOFT_OVERRIDE?: string }).STEP_BUDGET_SOFT_OVERRIDE = "8";
    try {
      const result = await resumeInline(env, id);
      expect(result.status).toBe("incident");
    } finally {
      delete (env as unknown as { STEP_BUDGET_SOFT_OVERRIDE?: string }).STEP_BUDGET_SOFT_OVERRIDE;
    }
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("stepBudget");
    expect(inst.body.incident.status).toBe("open");
    // The trip is well below the platform step ceiling (wrangler limits.steps).
    expect(inst.body.incident.payloadContext.budget).toBe(8);
  });
});
