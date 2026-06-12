import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import timerSagaXml from "../../examples/timer-saga.bpmn?raw";
import eventGatewaySagaXml from "../../examples/event-gateway-saga.bpmn?raw";
import { parseAndValidate } from "../../src/bpmn/validator";
import { roundTripBpmnXml } from "../../src/bpmn/parser";
import {
  createDraft,
  get,
  leaseAndComplete,
  mintWorkerToken,
  publishAndStart,
  publishDraft,
  publishMessage,
} from "../helpers";

// TASK-47 (M3-L5) — the two SHIPPED M3 sample models are publish-validated
// against the live validator from the file on disk, semantically round-tripped
// through bpmn-moddle (the R4 canonicity gate, mirroring the §3 / conditional
// examples in tests/unit/bpmn-validator.test.ts), AND executed end-to-end:
//
//   * examples/timer-saga.bpmn        — boundary timer inside a transaction →
//     cancel end → reverse-order compensation (design exit criterion 2, §7 gate 2)
//   * examples/event-gateway-saga.bpmn — eventBasedGateway message-vs-timer race,
//     both winners (design §4.5, §7 gate 5)
//
// Loading: a Vite `?raw` import — vitest-pool-workers runs the Vite transform in
// Node before injecting test modules into workerd, so the on-disk XML arrives as
// a plain string (workerd has no filesystem). Typing in tests/raw-imports.d.ts.

/** Force the first armed timer matching `kind` overdue, then fire its DO alarm. */
async function fireArmedTimer(instanceId: string, kind: string): Promise<string> {
  const t = await env.DB.prepare(
    `SELECT timer_id FROM timers WHERE instance_id = ? AND kind = ? AND status = 'armed' ORDER BY created_at LIMIT 1`,
  )
    .bind(instanceId, kind)
    .first<{ timer_id: string }>();
  expect(t?.timer_id).toBeTruthy();
  const timerId = t!.timer_id;
  await env.DB.prepare(`UPDATE timers SET fire_at = '2000-01-01T00:00:00Z' WHERE timer_id = ?`).bind(timerId).run();
  const stub = env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`timer:${timerId}`));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  return timerId;
}

async function historyTypes(instanceId: string): Promise<string[]> {
  const h = await get(`/instances/${instanceId}/history`);
  return (h.body.events as any[]).map((e) => e.type);
}

describe("examples/timer-saga.bpmn — the shipped M3 timer-saga sample is live-valid (TASK-47)", () => {
  it("publishes against the live validator and semantically round-trips through bpmn-moddle (R4)", async () => {
    const draft = await createDraft(timerSagaXml, "Timer saga sample");
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("valid");
    expect(draft.body.validationIssues ?? []).toEqual([]);

    const version = await publishDraft(draft.body.draftId);
    expect(version.status).toBe(201);
    expect(version.body.definitionVersionId).toBeTruthy();

    // R4: re-serialize through bpmn-moddle; the standard constructs survive and
    // the re-exported file still validates with zero issues.
    const out = await roundTripBpmnXml(timerSagaXml);
    expect(out).toMatch(/bpmn:transaction/i);
    expect(out).toMatch(/timerEventDefinition/);
    expect(out).toMatch(/timeDuration/);
    expect(out).toMatch(/cancelEventDefinition/);
    expect(out).toMatch(/compensateEventDefinition/);
    expect(out).toMatch(/isForCompensation="true"/);
    const reparsed = await parseAndValidate(out);
    expect(reparsed.ok).toBe(true);
    expect(reparsed.issues).toHaveLength(0);
  });

  it("executes the canonical timeout → reverse-order compensation path", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(timerSagaXml, {
      correlationKey: `timer-saga-${crypto.randomUUID()}`,
      variables: { orderId: "ord-9" },
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId as string;

    // Two compensatable forward steps commit, then the token parks on the
    // timer-guarded long-running step.
    await leaseAndComplete(token, "reserve-stock", { reservationId: "r-1" });
    await leaseAndComplete(token, "charge-card", { chargeId: "ch-1" });
    const parked = await get(`/instances/${id}`);
    expect(parked.body.currentElementId).toBe("awaitShipment");

    // The shipment never confirms: the boundary timer fires → Tx_cancel →
    // reverse-order compensation.
    await fireArmedTimer(id, "boundary");
    const comp = await get(`/instances/${id}`);
    expect(comp.body.status).toBe("compensating");

    // Compensators run highest-first: refund-card (undo charge) BEFORE
    // release-stock (undo reserve).
    await leaseAndComplete(token, "refund-card", {});
    await leaseAndComplete(token, "release-stock", {});
    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");

    const types = await historyTypes(id);
    expect(types).toContain("timerFired");
    expect(types).not.toContain("incidentCreated");
    const hist = await get(`/instances/${id}/history`);
    expect(
      hist.body.events.filter((e: any) => e.type === "compensationStarted").map((e: any) => e.elementId),
    ).toEqual(["chargeCard", "reserveStock"]);
  });
});

describe("examples/event-gateway-saga.bpmn — the shipped M3 EBG sample is live-valid (TASK-47)", () => {
  it("publishes against the live validator and semantically round-trips through bpmn-moddle (R4)", async () => {
    const draft = await createDraft(eventGatewaySagaXml, "Event gateway saga sample");
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("valid");
    expect(draft.body.validationIssues ?? []).toEqual([]);

    const version = await publishDraft(draft.body.draftId);
    expect(version.status).toBe(201);
    expect(version.body.definitionVersionId).toBeTruthy();

    const out = await roundTripBpmnXml(eventGatewaySagaXml);
    expect(out).toMatch(/eventBasedGateway/);
    expect(out).toMatch(/messageEventDefinition/);
    expect(out).toMatch(/timerEventDefinition/);
    expect(out).toMatch(/intermediateCatchEvent/);
    const reparsed = await parseAndValidate(out);
    expect(reparsed.ok).toBe(true);
    expect(reparsed.issues).toHaveLength(0);
  });

  it("executes the race: the approval message wins → fulfil branch", async () => {
    const token = await mintWorkerToken();
    const correlationKey = `ebg-saga-msg-${crypto.randomUUID()}`;
    const { instance } = await publishAndStart(eventGatewaySagaXml, { correlationKey, variables: {} });
    const id = instance.body.instanceId as string;

    // Lead-in service task, then the token parks on the eventBasedGateway with an
    // active message subscription + an armed timer branch.
    await leaseAndComplete(token, "submit-request", {});
    const parked = await get(`/instances/${id}`);
    expect(parked.body.currentElementId).toBe("AwaitDecision");

    const pub = await publishMessage({
      messageName: "ApprovalGranted",
      correlationKey,
      messageId: `appr-${crypto.randomUUID()}`,
      payload: { approver: "ada" },
    });
    expect(pub.body.outcome).toBe("correlated");

    const advanced = await get(`/instances/${id}`);
    expect(advanced.body.currentElementId).toBe("fulfilRequest");
    expect(advanced.body.variables.approver).toBe("ada");
    const types = await historyTypes(id);
    expect(types).toContain("ebgDecision");
    expect(types).not.toContain("timerFired");

    await leaseAndComplete(token, "fulfil-request", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });

  it("executes the race: the deadline timer wins → escalate branch; a late publish does not advance", async () => {
    const token = await mintWorkerToken();
    const correlationKey = `ebg-saga-timer-${crypto.randomUUID()}`;
    const { instance } = await publishAndStart(eventGatewaySagaXml, { correlationKey, variables: {} });
    const id = instance.body.instanceId as string;

    await leaseAndComplete(token, "submit-request", {});
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("AwaitDecision");

    await fireArmedTimer(id, "eventGateway");
    const advanced = await get(`/instances/${id}`);
    expect(advanced.body.currentElementId).toBe("escalateRequest");
    const types = await historyTypes(id);
    expect(types).toContain("timerFired");
    expect(types).toContain("ebgDecision");
    expect(types).not.toContain("incidentCreated");

    // The message subscription was superseded: a late publish gets the stable
    // buffered/no-match outcome and the instance stays on the timer branch.
    const late = await publishMessage({
      messageName: "ApprovalGranted",
      correlationKey,
      messageId: `appr-late-${crypto.randomUUID()}`,
      payload: {},
    });
    expect(late.body.outcome).not.toBe("correlated");
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("escalateRequest");

    await leaseAndComplete(token, "escalate-request", {});
    expect((await get(`/instances/${id}`)).body.status).toBe("completed");
  });
});
