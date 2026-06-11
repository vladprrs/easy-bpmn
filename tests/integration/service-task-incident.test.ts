import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_BPMN, drainSampleWorkers, get, publishAndStart } from "../helpers";
import { ensureWorkspace } from "../../src/persistence/db";
import { createVersion } from "../../src/persistence/definitions";
import { createInstance } from "../../src/persistence/instances";
import { resumeInline } from "../../src/runtime/engine";
import type { ExecutionGraph } from "../../src/bpmn/graph";

describe("Scenario 5: Service Task retry (via re-lease) and incident on exhaustion", () => {
  it("re-leases until retries are exhausted, then creates a view-only incident", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "inc-1",
      variables: { amount: 1, forceFail: true },
    });
    const instanceId = instance.body.instanceId;
    // Parked at the pull Service Task awaiting a worker.
    expect(instance.body.status).toBe("waiting");

    // The sample worker always fails (forceFail). Each technical failure re-leases
    // the job (attempt++) until retries="3" is exhausted → the engine incidents.
    await drainSampleWorkers({ taskTypes: ["external-check"] });

    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident).toBeTruthy();
    expect(inst.body.incident.elementId).toBe("Task_check");
    expect(inst.body.incident.retryCount).toBe(3); // retries="3" → 3 attempts
    expect(inst.body.incident.status).toBe("open");
    expect(inst.body.incident.kind).toBe("serviceTaskFailure");

    const history = await get(`/instances/${instanceId}/history`);
    const failed = history.body.events.filter((e: any) => e.type === "jobFailed");
    expect(failed).toHaveLength(3);
    expect(history.body.events.some((e: any) => e.type === "incidentCreated")).toBe(true);
  });
});

describe("defensive incident: the walk lands on a non-token node (M2 final review)", () => {
  // ENGINE-HARNESS-ONLY graph (injected via createVersion, bypassing the
  // publish gate — the validator now rejects sequence flows targeting boundary
  // events / compensation handlers): the start's only flow targets a boundary
  // event. The old loop() fall-through silently returned "completed" with NO
  // terminal write, wedging the instance; the contract is now a loud,
  // deterministic incident covering injected/legacy graphs.
  it("a token routed into a boundary event trips a serviceTaskFailure incident, not a silent wedge", async () => {
    const now = new Date().toISOString();
    await ensureWorkspace(env.DB, "default", now);
    const graph: ExecutionGraph = {
      processId: "P_nontoken",
      startElementId: "Start",
      endElementIds: [],
      elements: [],
      nodes: {
        Start: {
          type: "startEvent",
          next: "B",
          outgoing: [{ flowId: "f0", targetId: "B", conditionExpression: null, isDefault: false }],
        },
        B: {
          type: "boundaryEvent",
          next: null,
          outgoing: [],
          boundaryKind: "cancel",
          attachedToRef: null,
        },
      },
    };
    const versionId = `pdv_nontoken_${crypto.randomUUID()}`;
    await createVersion(env.DB, {
      definitionVersionId: versionId,
      draftId: `draft_nontoken_${crypto.randomUUID()}`,
      workspaceId: "default",
      versionNumber: 1,
      bpmnXml: "<!-- engine-harness-only non-token-path graph; injected, never published -->",
      bpmnXmlHash: `hash_${crypto.randomUUID()}`,
      graph,
      now,
    });
    const id = `pi_nontoken_${crypto.randomUUID()}`;
    await createInstance(env.DB, {
      instanceId: id,
      workspaceId: "default",
      definitionVersionId: versionId,
      workflowInstanceId: id,
      correlationKey: `nontoken-${crypto.randomUUID()}`,
      startElementId: "Start",
      variables: {},
      now,
    });

    const result = await resumeInline(env, id);
    expect(result.status).toBe("incident");

    // A loud terminal write per the M1 incident lifecycle: status=incident
    // with an OPEN incident naming the element + the validator expectation.
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("serviceTaskFailure");
    expect(inst.body.incident.status).toBe("open");
    expect(inst.body.incident.elementId).toBe("B");
    expect(inst.body.incident.reason).toContain("'B'");
    expect(inst.body.incident.reason).toContain("not a token-path node");
    expect(inst.body.incident.reason).toContain("the validator should have rejected this model");
    expect(inst.body.incident.payloadContext.nodeType).toBe("boundaryEvent");

    // Deterministic and one-shot: a re-drive no-ops off the incident status
    // (no second incident row).
    expect((await resumeInline(env, id)).status).toBe("completed");
    const incidents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE instance_id = ?`)
      .bind(id)
      .first<{ n: number }>();
    expect(incidents?.n).toBe(1);
  });
});
