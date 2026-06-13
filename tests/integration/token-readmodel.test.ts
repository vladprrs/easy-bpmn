import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, leaseAndComplete, mintWorkerToken, DEMO_BPMN } from "../helpers";
import { listTokens } from "../../src/persistence/tokens";

describe("root token read-model (M4-L2, no behaviour change)", () => {
  it("a single-token instance carries exactly one root token at its live position", async () => {
    const token = await mintWorkerToken();
    const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey: "c1", variables: {} });
    const id = instance.body.instanceId;
    await leaseAndComplete(token, "external-check", { ok: true });
    const rows = await listTokens(env.DB, id);
    expect(rows.filter((r) => r.status !== "consumed" && r.status !== "merged")).toHaveLength(1);
    expect(rows[0]!.token_id).toBe(`${id}:#root`);
  });
});
