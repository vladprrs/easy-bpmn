import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, drainSampleWorkers, get, publishAndStart, publishDraft } from "../helpers";
import {
  CALL_CHILD_ALWAYS_FAIL_BPMN,
  CALL_CHILD_BPMN,
  CALL_PARENT_BPMN,
  CALL_PARENT_FOR_INCIDENT_BPMN,
  CALL_PARENT_NO_BOUNDARY_BPMN,
  CALL_PARENT_SCOPE_BOUNDARY_BPMN,
} from "./call-activity-fixtures";
import { childInstanceIdFor } from "../../src/runtime/call-activity";
import { resumeInline } from "../../src/runtime/engine";

// M5-L2 Task 7 — the child `errored` terminal + parent error routing: a child's
// uncaught error end settles the CHILD as `status='errored'` + `error_code`
// (never a child-local `uncaughtError` incident), and the parent routes it via
// the SAME hierarchical error-boundary walk (`errorCatchTarget`) a worker-task
// business error uses — own boundary on the callActivity, bubble to an
// enclosing scope, or an uncaught `uncaughtError` incident at the parent root.
// A child's TECHNICAL incident (retries exhausted, no errorCode) is a
// deliberately different terminal ('incident') that must never notify the
// parent at all.

async function instRow(instanceId: string) {
  return env.DB.prepare(
    `SELECT status, error_code, current_element_id, parent_instance_id FROM process_instances WHERE instance_id = ?`,
  )
    .bind(instanceId)
    .first<{ status: string; error_code: string | null; current_element_id: string | null; parent_instance_id: string | null }>();
}

async function incidentsFor(instanceId: string) {
  return env.DB.prepare(`SELECT kind FROM incidents WHERE instance_id = ?`).bind(instanceId).all<{ kind: string }>();
}

async function historyTypeCounts(instanceId: string): Promise<Record<string, number>> {
  const res = await get(`/instances/${instanceId}/history`);
  const counts: Record<string, number> = {};
  for (const e of res.body.events as Array<{ type: string }>) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

async function historyEventsOfType(instanceId: string, type: string): Promise<Array<{ diagnostics: Record<string, unknown> }>> {
  const res = await get(`/instances/${instanceId}/history`);
  return (res.body.events as Array<{ type: string; diagnostics: Record<string, unknown> }>).filter((e) => e.type === type);
}

describe("callActivity error settle + parent routing (M5-L2 Task 7)", () => {
  it("boundary catch on call1: parent routes via call1-err to the handler and completes", async () => {
    const childDraft = await createDraft(CALL_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);

    const { instance } = await publishAndStart(CALL_PARENT_BPMN, {
      correlationKey: "ca-err-boundary",
      variables: { failChild: true },
    });
    const parentId = instance.body.instanceId as string;

    // Drain every task type on the path: charge-card (parent) → reserve-stock
    // (child, inside its own transaction) → the child errors at c-err → the
    // parent routes to p-handle (log-only) → p-end2.
    await drainSampleWorkers({ taskTypes: ["charge-card", "reserve-stock", "log-only"] });

    const childId = await childInstanceIdFor(parentId, "call1", 0);
    const child = await instRow(childId);
    expect(child?.status).toBe("errored");
    expect(child?.error_code).toBe("CHILD_FAILED");

    // No uncaughtError incident was raised on the CHILD's own root.
    const childIncidents = await incidentsFor(childId);
    expect(childIncidents.results).toHaveLength(0);
    const childHistory = await historyTypeCounts(childId);
    expect(childHistory.incidentCreated).toBeUndefined();

    const parent = await get(`/instances/${parentId}`);
    expect(parent.body.status).toBe("completed");
    expect(parent.body.currentElementId ?? parent.body.current_element_id).toBe("p-end2");

    const errEvents = await historyEventsOfType(parentId, "callActivityErrored");
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0]!.diagnostics).toMatchObject({ childInstanceId: childId, errorCode: "CHILD_FAILED", caughtBy: "call1-err" });

    // Idempotency: a duplicate inline re-drive of the now-terminal child AND the
    // now-terminal parent must fast-forward write-free through appliedCallOutcome
    // (no re-settle, no re-route, no duplicate history).
    await resumeInline(env, childId);
    await resumeInline(env, parentId);
    expect((await instRow(childId))?.status).toBe("errored");
    expect((await get(`/instances/${parentId}`)).body.status).toBe("completed");
    expect(await historyEventsOfType(parentId, "callActivityErrored")).toHaveLength(1);
    expect(await historyEventsOfType(childId, "childErrored")).toHaveLength(1);
  });

  it("bubble to enclosing scope: the scope catches, drains, and audits scopeExited", async () => {
    const childDraft = await createDraft(CALL_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);

    const { instance } = await publishAndStart(CALL_PARENT_SCOPE_BOUNDARY_BPMN, {
      correlationKey: "ca-err-scope",
      variables: { failChild: true },
    });
    const parentId = instance.body.instanceId as string;

    await drainSampleWorkers({ taskTypes: ["charge-card", "reserve-stock", "log-only"] });

    const childId = await childInstanceIdFor(parentId, "call1", 0);
    const child = await instRow(childId);
    expect(child?.status).toBe("errored");
    expect(child?.error_code).toBe("CHILD_FAILED");

    const parent = await get(`/instances/${parentId}`);
    expect(parent.body.status).toBe("completed");
    expect(parent.body.currentElementId ?? parent.body.current_element_id).toBe("ps-end2");

    const scopeExited = await historyEventsOfType(parentId, "scopeExited");
    expect(scopeExited).toHaveLength(1);
    expect(scopeExited[0]!.diagnostics).toMatchObject({ scope: "ps-tx", via: "ps-tx-err", abnormal: true });

    const errEvents = await historyEventsOfType(parentId, "callActivityErrored");
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0]!.diagnostics).toMatchObject({ childInstanceId: childId, errorCode: "CHILD_FAILED", caughtBy: "ps-tx-err" });
  });

  it("uncaught at parent root: an uncaughtError incident names call1; the child stays errored", async () => {
    const childDraft = await createDraft(CALL_CHILD_BPMN);
    await publishDraft(childDraft.body.draftId);

    const { instance } = await publishAndStart(CALL_PARENT_NO_BOUNDARY_BPMN, {
      correlationKey: "ca-err-uncaught",
      variables: { failChild: true },
    });
    const parentId = instance.body.instanceId as string;

    await drainSampleWorkers({ taskTypes: ["reserve-stock"] });

    const childId = await childInstanceIdFor(parentId, "call1", 0);
    const child = await instRow(childId);
    expect(child?.status).toBe("errored");
    expect(child?.error_code).toBe("CHILD_FAILED");

    const parent = await get(`/instances/${parentId}`);
    expect(parent.body.status).toBe("incident");

    const incidents = await incidentsFor(parentId);
    expect(incidents.results).toHaveLength(1);
    expect(incidents.results[0]!.kind).toBe("uncaughtError");

    const incidentEvents = await historyEventsOfType(parentId, "incidentCreated");
    expect(incidentEvents).toHaveLength(1);
    expect(incidentEvents[0]!.diagnostics).toMatchObject({ kind: "uncaughtError" });

    const errEvents = await historyEventsOfType(parentId, "callActivityErrored");
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0]!.diagnostics).not.toHaveProperty("caughtBy");
  });

  it("a child technical incident (retries exhausted) does NOT notify the parent", async () => {
    const childDraft = await createDraft(CALL_CHILD_ALWAYS_FAIL_BPMN);
    await publishDraft(childDraft.body.draftId);

    const { instance } = await publishAndStart(CALL_PARENT_FOR_INCIDENT_BPMN, {
      correlationKey: "ca-err-incident",
      variables: {},
    });
    const parentId = instance.body.instanceId as string;

    await drainSampleWorkers({ taskTypes: ["always-fail"] });

    const childId = await childInstanceIdFor(parentId, "call1", 0);
    const child = await instRow(childId);
    expect(child?.status).toBe("incident");

    // The parent never transitioned off call1 — no notify, no parent incident.
    const parent = await instRow(parentId);
    expect(parent?.status).toBe("waiting");
    expect(parent?.current_element_id).toBe("call1");

    const parentIncidents = await incidentsFor(parentId);
    expect(parentIncidents.results).toHaveLength(0);

    const parentHistory = await historyTypeCounts(parentId);
    expect(parentHistory.callActivityErrored).toBeUndefined();
    expect(parentHistory.incidentCreated).toBeUndefined();
  });
});
