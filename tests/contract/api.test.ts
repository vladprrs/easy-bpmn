import { describe, expect, it } from "vitest";
import {
  CALL_ACTIVITY_BPMN,
  createDraft,
  deferredGatewayBpmn,
  drainSampleWorkers,
  get,
  DEMO_BPMN,
  post,
  publishDraft,
  SAGA_BPMN,
  SAGA_XOR_BPMN,
  startInstance,
  XOR_BPMN,
} from "../helpers";

describe("Public API contract (openapi.yaml)", () => {
  it("creates a valid draft (201) with empty validation issues", async () => {
    const r = await createDraft(DEMO_BPMN, "demo");
    expect(r.status).toBe(201);
    expect(r.body.draftId).toMatch(/^draft_/);
    expect(r.body.status).toBe("valid");
    expect(r.body.validationIssues).toEqual([]);
    expect(typeof r.body.createdAt).toBe("string");
  });

  // TASK-33: exclusiveGateway models now publish, so the unsupported-draft 409
  // case pins a STILL-rejected gateway type (parallelGateway, deferred to M4)
  // instead of the old exclusiveGateway fixture.
  it("records validation issues for an unsupported draft and blocks publish with 409", async () => {
    const draft = await createDraft(deferredGatewayBpmn("parallelGateway"), "bad");
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("invalid");
    expect(draft.body.validationIssues.length).toBeGreaterThan(0);
    expect(draft.body.validationIssues.some((i: any) => i.elementId === "G" && /M4/.test(i.reason))).toBe(true);

    const pub = await publishDraft(draft.body.draftId);
    expect(pub.status).toBe(409);
    expect(pub.body.error).toBeTruthy();
    expect(Array.isArray(pub.body.validationIssues)).toBe(true);
    expect(pub.body.validationIssues.length).toBeGreaterThan(0);
  });

  // TASK-33 (M2): conditional models publish over the real HTTP path. This
  // file covers the publish path only; instance-start + gateway-dispatch
  // coverage lives in tests/integration/xor-gateway.test.ts (TASK-34).
  it("publishes an XOR split/join model (FEEL conditions + default) into an immutable version (201)", async () => {
    const draft = await createDraft(XOR_BPMN, "xor");
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("valid");
    expect(draft.body.validationIssues).toEqual([]);

    const pub = await publishDraft(draft.body.draftId);
    expect(pub.status).toBe(201);
    expect(pub.body.status).toBe("published");
    const gw = pub.body.elements.find((e: any) => e.elementId === "GW_split");
    expect(gw.type).toBe("exclusiveGateway");
    const flow = pub.body.elements.find((e: any) => e.elementId === "f_gold");
    expect(flow).toMatchObject({ conditionExpression: "amount > 100", isDefault: false });
    const def = pub.body.elements.find((e: any) => e.elementId === "f_def");
    expect(def).toMatchObject({ conditionExpression: null, isDefault: true });
  });

  it("publishes a conditional saga (XOR inside a transaction) into an immutable version (201)", async () => {
    const draft = await createDraft(SAGA_XOR_BPMN, "xor-saga");
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("valid");

    const pub = await publishDraft(draft.body.draftId);
    expect(pub.status).toBe(201);
    const types = pub.body.elements.map((e: any) => e.type);
    expect(types).toContain("transaction");
    expect(types).toContain("exclusiveGateway");
    const card = pub.body.elements.find((e: any) => e.elementId === "f_card");
    expect(card).toMatchObject({ conditionExpression: 'method = "card"', isDefault: false });
  });

  it("publishes the canonical transaction-saga (§3) into an immutable version (201)", async () => {
    const draft = await createDraft(SAGA_BPMN, "order-saga");
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("valid");
    expect(draft.body.validationIssues).toEqual([]);

    const pub = await publishDraft(draft.body.draftId);
    expect(pub.status).toBe(201);
    expect(pub.body.definitionVersionId).toMatch(/^pdv_/);
    expect(pub.body.status).toBe("published");
    // saga elements survive into the published version's element list
    const types = pub.body.elements.map((e: any) => e.type);
    expect(types).toContain("transaction");
    expect(types).toContain("boundaryEvent");
    const reserve = pub.body.elements.find((e: any) => e.elementId === "reserveStock");
    expect(reserve.taskType).toBe("reserve-stock");
  });

  it("blocks publishing a deferred-construct draft (409) with element id + reason recorded", async () => {
    const draft = await createDraft(CALL_ACTIVITY_BPMN, "deferred");
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("invalid");
    const issue = draft.body.validationIssues.find((i: any) => i.elementId === "CA");
    expect(issue).toBeTruthy();
    expect(issue.reason).toMatch(/callActivity/);

    const pub = await publishDraft(draft.body.draftId);
    expect(pub.status).toBe(409);
    expect(Array.isArray(pub.body.validationIssues)).toBe(true);
    expect(pub.body.validationIssues.some((i: any) => i.elementId === "CA")).toBe(true);
  });

  it("404s an unknown draft", async () => {
    const r = await get("/definitions/drafts/draft_missing");
    expect(r.status).toBe(404);
    expect(r.body.error).toBeTruthy();
  });

  it("publishes a valid draft into an immutable version (201)", async () => {
    const draft = await createDraft(DEMO_BPMN);
    const pub = await publishDraft(draft.body.draftId);
    expect(pub.status).toBe(201);
    expect(pub.body.definitionVersionId).toMatch(/^pdv_/);
    expect(pub.body.versionNumber).toBe(1);
    expect(pub.body.status).toBe("published");
    expect(typeof pub.body.bpmnXmlHash).toBe("string");
    const svc = pub.body.elements.find((e: any) => e.type === "serviceTask");
    expect(svc.taskType).toBe("external-check");
    // version inspection round-trips
    const got = await get(`/definitions/versions/${pub.body.definitionVersionId}`);
    expect(got.status).toBe(200);
    expect(got.body.definitionVersionId).toBe(pub.body.definitionVersionId);
  });

  it("starts an instance (201) with the full ProcessInstance shape", async () => {
    const draft = await createDraft(DEMO_BPMN);
    const version = await publishDraft(draft.body.draftId);
    const r = await startInstance(version.body.definitionVersionId, {
      correlationKey: "c-1",
      variables: { amount: 42 },
      businessKey: "b-1",
    });
    expect(r.status).toBe(201);
    expect(r.body.instanceId).toMatch(/^pi_/);
    expect(r.body.definitionVersionId).toBe(version.body.definitionVersionId);
    expect(typeof r.body.workflowInstanceId).toBe("string");
    expect(r.body.correlationKey).toBe("c-1");
    expect(["starting", "running", "waiting", "completed", "incident"]).toContain(r.body.status);

    const inspect = await get(`/instances/${r.body.instanceId}`);
    expect(inspect.status).toBe(200);
    expect(Array.isArray(inspect.body.historySummary)).toBe(true);
    expect(typeof inspect.body.diagnostics).toBe("object");

    const history = await get(`/instances/${r.body.instanceId}/history`);
    expect(history.status).toBe(200);
    expect(Array.isArray(history.body.events)).toBe(true);
    expect(history.body.events.length).toBeGreaterThan(0);
  });

  // M3-L1 (TASK-39): the documented Incident.kind enum (openapi.yaml). Legacy
  // 'timeout' is retained but never written by current code; the un-leasable-job
  // DLQ writes 'jobActivationTimeout', wait caps write 'waitTimeout', and a hard
  // FEEL error writes 'conditionFailure'.
  const DOCUMENTED_INCIDENT_KINDS = [
    "serviceTaskFailure",
    "compensationFailure",
    "timeout",
    "poison",
    "loopLimit",
    "noPath",
    "jobActivationTimeout",
    "waitTimeout",
    "conditionFailure",
  ];

  it("instance inspection emits a documented incident kind and an openIncidents list", async () => {
    const draft = await createDraft(DEMO_BPMN);
    const version = await publishDraft(draft.body.draftId);
    const r = await startInstance(version.body.definitionVersionId, {
      correlationKey: "inc-contract",
      variables: { amount: 1, forceFail: true },
    });
    await drainSampleWorkers({ taskTypes: ["external-check"] });

    const inspect = await get(`/instances/${r.body.instanceId}`);
    expect(inspect.status).toBe(200);
    expect(inspect.body.status).toBe("incident");
    // The latest-incident field stays for backward compatibility …
    expect(DOCUMENTED_INCIDENT_KINDS).toContain(inspect.body.incident.kind);
    // … and the new openIncidents list is an array of the same documented shape.
    expect(Array.isArray(inspect.body.openIncidents)).toBe(true);
    expect(inspect.body.openIncidents.length).toBeGreaterThan(0);
    for (const i of inspect.body.openIncidents) {
      expect(DOCUMENTED_INCIDENT_KINDS).toContain(i.kind);
      expect(i.resolution).toBe("open");
    }
  });

  it("404s starting from an unknown version", async () => {
    const r = await startInstance("pdv_missing", { correlationKey: "c", variables: {} });
    expect(r.status).toBe(404);
  });

  it("400s an invalid request body", async () => {
    const r = await post("/definitions/drafts", { workspaceId: "default" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBeTruthy();
  });

  it("publishes a message (202) and inspects it (200)", async () => {
    const draft = await createDraft(DEMO_BPMN);
    const version = await publishDraft(draft.body.draftId);
    await startInstance(version.body.definitionVersionId, {
      correlationKey: "approval-9",
      variables: { amount: 1 },
    });
    // Drive the pull Service Task so the Receive Task subscription is active.
    await drainSampleWorkers({ taskTypes: ["external-check"] });
    const msg = await post("/messages", {
      workspaceId: "default",
      messageName: "ApprovalReceived",
      correlationKey: "approval-9",
      messageId: "msg-9",
      payload: { approved: true },
    });
    expect(msg.status).toBe(202);
    expect(msg.body.outcome).toBe("correlated");
    expect(msg.body.externalMessageId).toMatch(/^msg_/);
    expect(msg.body.instanceId).toMatch(/^pi_/);

    const got = await get(`/messages/${msg.body.externalMessageId}`);
    expect(got.status).toBe(200);
    expect(got.body.finalOutcome).toBe("correlated");
    expect(typeof got.body.receivedAt).toBe("string");
  });
});
