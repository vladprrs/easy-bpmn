import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import sampleXml from "../../examples/conditional-fulfillment-saga.bpmn?raw";
import { createDraft, get, leaseAndComplete, mintWorkerToken, publishDraft, startInstance } from "../helpers";

// TASK-37 — the SHIPPED sample model is publish-validated against the live
// validator, from the file on disk (never a drifting inline copy). The sample
// (examples/conditional-fulfillment-saga.bpmn) is the canonical M2
// conditional-saga example referenced by docs/bpmn/09-easy-bpmn-profile.md.
//
// Loading: a Vite `?raw` import — vitest-pool-workers runs the Vite transform
// pipeline in Node before injecting test modules into workerd, so the on-disk
// XML arrives as a plain string (workerd itself has no filesystem). Module
// typing lives in tests/raw-imports.d.ts.

describe("examples/conditional-fulfillment-saga.bpmn — the shipped sample is live-valid", () => {
  it("publishes against the live validator and executes its loop + branch happy path", async () => {
    // 1) Publish: the sample passes the full publish-time gate (XOR split with
    //    FEEL condition + default, XOR join, token-path cycle, compensation
    //    wiring, error-boundary→cancel, transaction structure).
    const draft = await createDraft(sampleXml, "Conditional fulfillment saga sample");
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("valid");
    expect(draft.body.validationIssues ?? []).toEqual([]);

    const version = await publishDraft(draft.body.draftId);
    expect(version.status).toBe(201);
    const versionId = version.body.definitionVersionId as string;
    expect(versionId).toBeTruthy();

    // 2) Beyond parse-valid: the published model EXECUTES. Drive the happy
    //    path — two reserve-item iterations (the loop), then the card branch
    //    (the split), through the join to confirm-order (commit).
    const start = await startInstance(versionId, {
      correlationKey: `sample-saga-${crypto.randomUUID()}`,
      variables: { orderId: "ord-1" },
    });
    expect(start.status).toBe(201);
    const id = start.body.instanceId as string;

    const token = await mintWorkerToken();
    await leaseAndComplete(token, "reserve-item", { itemId: "i-0", moreItems: true });
    await leaseAndComplete(token, "reserve-item", { itemId: "i-1", moreItems: false, paymentMethod: "card" });
    await leaseAndComplete(token, "charge-card", { chargeId: "ch-1" });
    await leaseAndComplete(token, "confirm-order", { confirmed: true });

    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
    expect(done.body.currentElementId).toBe("OrderPlaced");

    // 3) The decisions the walk recorded: loop taken once then exited via the
    //    default, and the data-driven card branch — one row per gateway visit.
    const decisions = await env.DB.prepare(
      `SELECT element_id, occurrence, chosen_flow_id, is_default
         FROM gateway_decisions WHERE instance_id = ? ORDER BY element_id, occurrence`,
    )
      .bind(id)
      .all<{ element_id: string; occurrence: number; chosen_flow_id: string; is_default: number }>();
    expect(decisions.results).toEqual([
      { element_id: "GW_method", occurrence: 0, chosen_flow_id: "Flow_pay_card", is_default: 0 },
      { element_id: "GW_more", occurrence: 0, chosen_flow_id: "Flow_more_items", is_default: 0 },
      { element_id: "GW_more", occurrence: 1, chosen_flow_id: "Flow_checkout", is_default: 1 },
      { element_id: "GW_paid", occurrence: 0, chosen_flow_id: "Flow_to_confirm", is_default: 0 },
    ]);

    // 4) The loop left one ledger row per iteration (the compensation basis);
    //    handler-less steps (ConfirmOrder) settle notRequired.
    const ledger = await env.DB.prepare(
      `SELECT element_id, occurrence FROM saga_steps WHERE instance_id = ? ORDER BY seq`,
    )
      .bind(id)
      .all<{ element_id: string; occurrence: number }>();
    expect(ledger.results).toEqual([
      { element_id: "ReserveItem", occurrence: 0 },
      { element_id: "ReserveItem", occurrence: 1 },
      { element_id: "ChargeCard", occurrence: 0 },
      { element_id: "ConfirmOrder", occurrence: 0 },
    ]);
  });
});
