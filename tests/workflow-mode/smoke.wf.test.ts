// Layer-B foundation smoke: proves the HTTP driver + the cloudflare:test alias
// (importing a shared fixture out of the otherwise-pool-workers helpers) drive a
// REAL ProcessWorkflow to terminal over the public API against `wrangler dev`.
// Not a registry scenario — it guards the substrate the *.wf.test.ts suites need.
import { describe, expect, it } from "vitest";
import { DEMO_BPMN } from "../helpers";
import { leaseAndComplete, mintWorkerToken, publishAndStart, publishMessage, pollToTerminal } from "./driver";

describe("workflow-mode substrate smoke", () => {
  it("drives DEMO_BPMN (svc -> receive) to completed over HTTP against the live Worker", async () => {
    const token = await mintWorkerToken();
    const ck = `smoke-${Date.now()}`;
    const { instanceId } = await publishAndStart(DEMO_BPMN, { correlationKey: ck, variables: { a: 1 } });

    await leaseAndComplete(token, "external-check", { checked: true });
    const msg = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: ck,
      messageId: `${ck}-m1`,
      payload: { approved: true },
    });
    expect(msg.status).toBe(202);

    const result = await pollToTerminal(instanceId, { deadlineMs: 30_000 });
    expect(result.status, `stuck at ${result.status} after ${result.elapsedMs}ms`).toBe("completed");
  });
});
