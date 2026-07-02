import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NESTED_TX_BPMN, leaseAndComplete, mintWorkerToken, publishAndStart } from "../helpers";

describe("M5-L1 ledger-write gate (spec §3.3)", () => {
  it("a completed task inside tx > subProcess is ledgered with scope_id = the subProcess", async () => {
    const { instance } = await publishAndStart(NESTED_TX_BPMN, { correlationKey: "nested-gate-1", variables: {} });
    const instanceId = instance.body.instanceId;
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "stepA", { a: 1 });
    const row = await env.DB.prepare(
      `SELECT scope_id, compensation_status, compensation_element_id FROM saga_steps WHERE instance_id = ? AND element_id = 'A'`,
    ).bind(instanceId).first<{ scope_id: string; compensation_status: string; compensation_element_id: string }>();
    expect(row).toEqual({ scope_id: "S", compensation_status: "pending", compensation_element_id: "undoA" });
  });
});
