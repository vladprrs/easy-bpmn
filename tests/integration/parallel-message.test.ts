import { describe, it, expect } from "vitest";
import { get, mintWorkerToken, publishAndStart, publishMessage, PARALLEL_MESSAGE_DISTINCT_BPMN } from "../helpers";

// M4-L3 (review follow-up): a message catch INSIDE a parallel branch must apply its
// payload to the branch token's OWN overlay (design §5.7 names applyMessage as a
// scope-aware site), and a delivered message must be routed to the branch whose
// messageName matches it — never consumed positionally by the first receive the
// re-walk encounters. Both are exercised by delivering the SECOND branch's message
// first, with a shared key whose document-order (later branch) winner is asserted.
describe("parallelGateway AND with message catches in branches (M4-L3, direct mode)", () => {
  it("routes each message to its own branch and merges payloads in document order", async () => {
    await mintWorkerToken();
    const { instance } = await publishAndStart(PARALLEL_MESSAGE_DISTINCT_BPMN, { correlationKey: "pm1", variables: {} });
    const id = instance.body.instanceId;

    // Deliver f2's message ("Paid") FIRST. The re-walk reaches R1 ("Ready") before
    // R2 ("Paid"); R1 must NOT consume this message (name mismatch) — it belongs to
    // R2's branch. f2 is later in document order, so its `shared` wins the merge.
    const pubB = await publishMessage({ messageName: "Paid", correlationKey: "pm1", messageId: "pm1-b", payload: { shared: "B", fromB: 1 } });
    expect(pubB.body.outcome).toBe("correlated");
    const mid = await get(`/instances/${id}`);
    expect(["running", "waiting"]).toContain(mid.body.status); // R1 (Ready) still pending
    // The leak guard: f1's "Ready" branch must not have seen f2's payload yet.
    expect(mid.body.variables.shared).toBeUndefined();

    // Now deliver f1's message ("Ready"); the join fires and merges both overlays.
    const pubA = await publishMessage({ messageName: "Ready", correlationKey: "pm1", messageId: "pm1-a", payload: { shared: "A", fromA: 1 } });
    expect(pubA.body.outcome).toBe("correlated");

    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
    // Document-order merge (f1 then f2): f2 "Paid" wins the shared key.
    expect(done.body.variables).toMatchObject({ shared: "B", fromA: 1, fromB: 1 });
  });
});
