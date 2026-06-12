import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  authedPost,
  get,
  leaseAndComplete,
  leaseOne,
  mintWorkerToken,
  post,
  publishAndStart,
} from "../helpers";

// Free error-boundary routing end-to-end (M3-L2, TASK-42; design §7 gates 7-8).
// These drive the pull data plane MANUALLY (lease + fail/complete) so a worker
// `fail` can carry an arbitrary errorCode — the matching precedence is
// exact @errorCode → catch-all → (no match) Hazard.

const svc = (id: string, type: string) =>
  `<bpmn:serviceTask id="${id}"><bpmn:extensionElements><easy-bpmn:taskDefinition type="${type}"/></bpmn:extensionElements></bpmn:serviceTask>`;

/** Transaction whose `router` step carries two coded error boundaries (CODE_A →
 *  svcA, CODE_B → svcB) plus an optional catch-all (→ svcC). Each alternate path
 *  commits the transaction. */
function routerSaga(opts: { catchAll: boolean }): string {
  const catchAllBoundary = opts.catchAll
    ? `<bpmn:boundaryEvent id="router_c" attachedToRef="router"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>`
    : "";
  const catchAllTarget = opts.catchAll ? svc("svcC", "svc-c") : "";
  const catchAllFlows = opts.catchAll
    ? `<bpmn:sequenceFlow id="rc" sourceRef="router_c" targetRef="svcC"/>
       <bpmn:sequenceFlow id="ec" sourceRef="svcC" targetRef="Tx_ok"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_router" targetNamespace="x">
  <bpmn:error id="Err_A" name="A" errorCode="CODE_A"/>
  <bpmn:error id="Err_B" name="B" errorCode="CODE_B"/>
  <bpmn:process id="RouterSaga" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx" name="Route">
      <bpmn:startEvent id="Tx_start"/>
      ${svc("router", "router")}
      ${svc("svcA", "svc-a")}
      ${svc("svcB", "svc-b")}
      ${catchAllTarget}
      <bpmn:boundaryEvent id="router_a" attachedToRef="router"><bpmn:errorEventDefinition errorRef="Err_A"/></bpmn:boundaryEvent>
      <bpmn:boundaryEvent id="router_b" attachedToRef="router"><bpmn:errorEventDefinition errorRef="Err_B"/></bpmn:boundaryEvent>
      ${catchAllBoundary}
      <bpmn:endEvent id="Tx_ok"/>
      <bpmn:sequenceFlow id="t1" sourceRef="Tx_start" targetRef="router"/>
      <bpmn:sequenceFlow id="ts" sourceRef="router" targetRef="Tx_ok"/>
      <bpmn:sequenceFlow id="ra" sourceRef="router_a" targetRef="svcA"/>
      <bpmn:sequenceFlow id="rb" sourceRef="router_b" targetRef="svcB"/>
      <bpmn:sequenceFlow id="ea" sourceRef="svcA" targetRef="Tx_ok"/>
      <bpmn:sequenceFlow id="eb" sourceRef="svcB" targetRef="Tx_ok"/>
      ${catchAllFlows}
    </bpmn:transaction>
    <bpmn:endEvent id="SagaDone"/>
    <bpmn:sequenceFlow id="g1" sourceRef="Start" targetRef="Tx"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="SagaDone"/>
  </bpmn:process>
</bpmn:definitions>`;
}

async function enteredElements(instanceId: string): Promise<string[]> {
  const history = await get(`/instances/${instanceId}/history`);
  return history.body.events.filter((e: any) => e.type === "elementEntered").map((e: any) => e.elementId);
}

describe("free error-boundary routing — matching precedence (AC#1, §7 gate 7)", () => {
  it.each([
    { code: "CODE_A", taskType: "svc-a", path: "svcA", others: ["svcB", "svcC"] },
    { code: "CODE_B", taskType: "svc-b", path: "svcB", others: ["svcA", "svcC"] },
    // An UNDECLARED code (no bpmn:error) hits the catch-all — proving the
    // catch-all catches ANY business code, including undeclared ones.
    { code: "TOTALLY_UNDECLARED", taskType: "svc-c", path: "svcC", others: ["svcA", "svcB"] },
  ])("routes $code to its boundary's alternate path ($path)", async ({ code, taskType, path, others }) => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(routerSaga({ catchAll: true }), {
      correlationKey: `route-${code}`,
      variables: {},
    });
    const id = instance.body.instanceId;

    // Fail `router` with the chosen code → engine routes the token to the path.
    const routerJob = await leaseOne(token, "router");
    await authedPost(`/jobs/${routerJob.jobId}/fail`, token, { lockToken: routerJob.lockToken, reason: "boom", errorCode: code });

    // Complete the routed alternate step → the transaction commits.
    await leaseAndComplete(token, taskType, {});

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("completed");
    expect(inst.body.currentElementId).toBe("SagaDone");

    const entered = await enteredElements(id);
    expect(entered).toContain(path);
    for (const other of others) expect(entered).not.toContain(other);
  });

  it("raises a Hazard when an unmatched code has no catch-all (§7 gate 7)", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(routerSaga({ catchAll: false }), {
      correlationKey: "route-hazard",
      variables: {},
    });
    const id = instance.body.instanceId;

    const routerJob = await leaseOne(token, "router");
    await authedPost(`/jobs/${routerJob.jobId}/fail`, token, { lockToken: routerJob.lockToken, reason: "boom", errorCode: "NO_BOUNDARY_FOR_THIS" });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("serviceTaskFailure");
    expect(inst.body.incident.reason).toMatch(/NO_BOUNDARY_FOR_THIS/);
  });
});

// AC#2: an error handled by an ALTERNATE forward path inside a transaction leaves
// the saga ledger untouched — S1 (pre-error) and S3 (post-error) both stay
// compensatable, and an operator /cancel compensates BOTH in reverse order.
const ALT_PATH_SAGA = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_alt" targetNamespace="x">
  <bpmn:error id="Err_S2" name="S2 failed" errorCode="CODE_S2"/>
  <bpmn:process id="AltSaga" isExecutable="true">
    <bpmn:startEvent id="Start"/>
    <bpmn:transaction id="Tx" name="Alt">
      <bpmn:startEvent id="Tx_start"/>
      ${svc("S1", "s1")}
      <bpmn:boundaryEvent id="S1_comp" attachedToRef="S1"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="undoS1" name="Undo S1" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="undo-s1"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:association id="a1" associationDirection="One" sourceRef="S1_comp" targetRef="undoS1"/>
      ${svc("S2", "s2")}
      <bpmn:boundaryEvent id="S2_err" attachedToRef="S2"><bpmn:errorEventDefinition errorRef="Err_S2"/></bpmn:boundaryEvent>
      ${svc("S3", "s3")}
      <bpmn:boundaryEvent id="S3_comp" attachedToRef="S3"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
      <bpmn:serviceTask id="undoS3" name="Undo S3" isForCompensation="true"><bpmn:extensionElements><easy-bpmn:taskDefinition type="undo-s3"/></bpmn:extensionElements></bpmn:serviceTask>
      <bpmn:association id="a3" associationDirection="One" sourceRef="S3_comp" targetRef="undoS3"/>
      ${svc("S4", "s4")}
      <bpmn:endEvent id="Tx_ok"/>
      <bpmn:sequenceFlow id="t1" sourceRef="Tx_start" targetRef="S1"/>
      <bpmn:sequenceFlow id="t2" sourceRef="S1" targetRef="S2"/>
      <bpmn:sequenceFlow id="t3" sourceRef="S2" targetRef="S4"/>
      <bpmn:sequenceFlow id="se" sourceRef="S2_err" targetRef="S3"/>
      <bpmn:sequenceFlow id="t4" sourceRef="S3" targetRef="S4"/>
      <bpmn:sequenceFlow id="t5" sourceRef="S4" targetRef="Tx_ok"/>
    </bpmn:transaction>
    <bpmn:endEvent id="SagaDone"/>
    <bpmn:sequenceFlow id="g1" sourceRef="Start" targetRef="Tx"/>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="SagaDone"/>
  </bpmn:process>
</bpmn:definitions>`;

async function ledger(instanceId: string) {
  const res = await env.DB.prepare(
    `SELECT element_id, seq, compensation_status FROM saga_steps WHERE instance_id = ? ORDER BY seq`,
  ).bind(instanceId).all<{ element_id: string; seq: number; compensation_status: string }>();
  return res.results ?? [];
}

describe("free error-boundary routing — alternate path leaves the ledger intact (AC#2, §7 gate 8)", () => {
  it("compensates S1 (pre-error) AND S3 (post-error) in reverse on operator /cancel", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(ALT_PATH_SAGA, { correlationKey: "alt-path", variables: {} });
    const id = instance.body.instanceId;

    // S1 completes (compensatable, ledger 'pending').
    await leaseAndComplete(token, "s1", {});
    // S2 fails with CODE_S2 → routed to the ALTERNATE forward path S3 (not a cancel end).
    const s2 = await leaseOne(token, "s2");
    await authedPost(`/jobs/${s2.jobId}/fail`, token, { lockToken: s2.lockToken, reason: "boom", errorCode: "CODE_S2" });
    // S3 completes (compensatable, ledger 'pending'); the instance parks at S4.
    await leaseAndComplete(token, "s3", {});

    const parked = await get(`/instances/${id}`);
    expect(parked.body.status).toBe("waiting");
    expect(parked.body.currentElementId).toBe("S4");

    // Ledger holds BOTH completed forward steps, untouched by the error routing.
    const before = await ledger(id);
    expect(before.map((r) => r.element_id)).toEqual(["S1", "S3"]);
    expect(before.every((r) => r.compensation_status === "pending")).toBe(true);

    // Operator cancels → reverse-order compensation of S3 then S1.
    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("compensating");

    await leaseAndComplete(token, "undo-s3", {});
    await leaseAndComplete(token, "undo-s1", {});

    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("compensated");

    const history = await get(`/instances/${id}/history`);
    const compStarts = history.body.events
      .filter((e: any) => e.type === "compensationStarted")
      .map((e: any) => e.elementId);
    expect(compStarts).toEqual(["S3", "S1"]); // reverse completion order

    const after = await ledger(id);
    expect(after.find((r) => r.element_id === "S1")?.compensation_status).toBe("compensated");
    expect(after.find((r) => r.element_id === "S3")?.compensation_status).toBe("compensated");
  });
});
