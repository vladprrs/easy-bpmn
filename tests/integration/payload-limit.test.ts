import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DEMO_BPMN,
  createDraft,
  drainSampleWorkers,
  get,
  publishAndStart,
  publishDraft,
  publishMessage,
  startInstance,
} from "../helpers";
import { createInstance } from "../../src/persistence/instances";
import { runInstance } from "../../src/runtime/engine";

// Cloudflare Workflows enforce a hard ~1 MiB event payload limit. The MVP rejects
// oversized message + start payloads explicitly BEFORE they would ride a Workflow
// event / worker request (runtime-contracts.md Payload Contract, design risk map).
const OVERSIZED = "x".repeat(1_100_000); // > 1 MiB once JSON-encoded

describe("Scenario: payload limit rejection", () => {
  it("rejects an oversized message payload with 400 before delivery", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: "big-1",
      variables: { amount: 1 },
    });
    const instanceId = instance.body.instanceId;
    expect(instance.body.status).toBe("waiting");
    // Reach the Receive Task so the oversized message targets a live subscription.
    await drainSampleWorkers({ taskTypes: ["external-check"] });

    const r = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: "big-1",
      messageId: "big-msg-1",
      payload: { blob: OVERSIZED },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/exceed|limit/i);

    // The instance was not advanced by the rejected message.
    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("waiting");
  });

  it("rejects oversized initial start variables with 400", async () => {
    const draft = await createDraft(DEMO_BPMN);
    const version = await publishDraft(draft.body.draftId);
    const r = await startInstance(version.body.definitionVersionId, {
      correlationKey: "big-2",
      variables: { blob: OVERSIZED },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/exceed|limit/i);
  });

  // Defense-in-depth: even if oversized variables reach the engine (bypassing the
  // API guard), the Service Task input check creates a view-only incident rather
  // than failing opaquely inside the runtime.
  it("creates an incident when Service Task input variables exceed the limit", async () => {
    const draft = await createDraft(DEMO_BPMN);
    const version = await publishDraft(draft.body.draftId);
    const versionId = version.body.definitionVersionId;
    const instanceId = "pi_engine_limit_1";
    const now = "2026-06-08T00:00:00.000Z";
    await createInstance(env.DB, {
      instanceId,
      workspaceId: "default",
      definitionVersionId: versionId,
      workflowInstanceId: instanceId,
      correlationKey: "big-engine-1",
      startElementId: "Start_1",
      variables: { blob: OVERSIZED },
      now,
    });
    const inline = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
    const result = await runInstance(env, instanceId, { runStep: inline, waitFor: null });
    expect(result.status).toBe("incident");

    const inst = await get(`/instances/${instanceId}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.elementId).toBe("Task_check");
    expect(inst.body.incident.reason).toMatch(/payload limit/i);
  });
});
