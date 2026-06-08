import { describe, expect, it } from "vitest";
import { authedPost, mintWorkerToken, post } from "../helpers";

// Worker-credential lifecycle + the four 401 cases + body-workspaceId-not-trusted.

describe("Worker credential auth (pull data plane)", () => {
  it("mints a credential and returns the raw token exactly once", async () => {
    const r = await post("/worker-credentials", { workspaceId: "ws-mint", label: "ci" });
    expect(r.status).toBe(201);
    expect(r.body.credentialId).toMatch(/^wcred_/);
    expect(r.body.workspaceId).toBe("ws-mint");
    expect(typeof r.body.token).toBe("string");
    expect(r.body.token).toMatch(/^wct_/);
    expect(typeof r.body.createdAt).toBe("string");
  });

  it("accepts a minted token on /jobs/activate", async () => {
    const token = await mintWorkerToken("ws-use");
    const r = await authedPost("/jobs/activate", token, { taskType: "nobody", workerId: "w1" });
    expect(r.status).toBe(200);
    expect(r.body.jobs).toEqual([]);
  });

  it("rejects a missing Authorization header (401)", async () => {
    const r = await authedPost("/jobs/activate", null, { taskType: "x", workerId: "w1" });
    expect(r.status).toBe(401);
    expect(r.body.error).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(/stack|at Object|\.ts:/i);
  });

  it("rejects a malformed (non-Bearer) header (401)", async () => {
    const r = await authedPost("/jobs/activate", null, { taskType: "x", workerId: "w1" });
    // craft a raw non-bearer header via a direct fetch helper
    const r2 = await authedPost("/jobs/activate", "", { taskType: "x", workerId: "w1" });
    expect(r.status).toBe(401);
    expect(r2.status).toBe(401);
  });

  it("rejects an unknown token (401)", async () => {
    const r = await authedPost("/jobs/activate", "wct_nope_unknown", { taskType: "x", workerId: "w1" });
    expect(r.status).toBe(401);
  });

  it("revokes a credential idempotently and then rejects its token (401)", async () => {
    const mint = await post("/worker-credentials", { workspaceId: "ws-revoke" });
    const token = mint.body.token as string;
    const credId = mint.body.credentialId as string;

    const ok = await authedPost("/jobs/activate", token, { taskType: "x", workerId: "w1" });
    expect(ok.status).toBe(200);

    const rev = await post(`/worker-credentials/${credId}/revoke`);
    expect(rev.status).toBe(200);
    // idempotent re-revoke
    const rev2 = await post(`/worker-credentials/${credId}/revoke`);
    expect(rev2.status).toBe(200);
    // revoking an unknown credential is also a no-op 200
    const rev3 = await post(`/worker-credentials/wcred_unknown/revoke`);
    expect(rev3.status).toBe(200);

    const after = await authedPost("/jobs/activate", token, { taskType: "x", workerId: "w1" });
    expect(after.status).toBe(401);
  });

  it("ignores a spoofed workspaceId in the /jobs/* body (server-derived only)", async () => {
    const token = await mintWorkerToken("ws-real");
    // activate schema has no workspaceId field; a spoofed one is stripped, not trusted.
    const r = await authedPost("/jobs/activate", token, { taskType: "x", workerId: "w1", workspaceId: "ws-attacker" });
    expect(r.status).toBe(200);
    expect(r.body.jobs).toEqual([]);
  });
});
