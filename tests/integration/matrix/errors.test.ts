import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, get, authedPost, leaseOne, mintWorkerToken } from "../../helpers";
import { PARALLEL_BRANCH_NOPATH_BPMN } from "../../fixtures/matrix/fixtures";
import { listTokens } from "../../../src/persistence/tokens";
import { getGatewayDecision } from "../../../src/persistence/gateway-decisions";

// Direct-mode characterization of an error corner under concurrency (Phase-1
// matrix, Task 3.5). M4 (L1-L6) is shipped+green, so this SHOULD pass — it is
// NEW coverage of a dead-ending XOR split INSIDE one AND branch while a sibling
// branch is in-flight.
//
// PARALLEL_BRANCH_NOPATH_BPMN uses CUSTOM service-task types (np-a / np-b) with NO
// registered sample worker, so every task is driven over the pull data plane with
// leaseOne + complete — never drainSampleWorkers.

const complete = (
  t: string,
  j: { jobId: string; lockToken: string },
  out: Record<string, unknown> = {},
) => authedPost(`/jobs/${j.jobId}/complete`, t, { lockToken: j.lockToken, outputVariables: out });

const LIVE = ["active", "waiting", "arrivedAtJoin"];

async function joinCompletionCount(instanceId: string, joinId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM join_completions WHERE instance_id = ? AND join_id = ?`,
  )
    .bind(instanceId, joinId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

const jobRow = (jobId: string) =>
  env.DB.prepare(`SELECT status FROM service_task_jobs WHERE job_id = ?`).bind(jobId).first<{ status: string }>();

describe("matrix: errors under concurrency (direct mode)", () => {
  it("[C-BRANCH-NOPATH-01] an XOR-no-default split dead-ends inside one AND branch (noPath) while the sibling is in-flight; whole instance → incident, sibling frozen", async () => {
    const token = await mintWorkerToken();
    // Xn (in branch A) has two conditional out-flows on routeHigh / routeLow and NO
    // default; with both false the branch-A token matches no path.
    const { instance } = await publishAndStart(PARALLEL_BRANCH_NOPATH_BPMN, {
      correlationKey: `np-${crypto.randomUUID()}`,
      variables: { routeHigh: false, routeLow: false },
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;

    // Sibling branch B (np-b) leased + LEFT in-flight — the in-flight sibling whose
    // token must freeze, not wedge or run away, when branch A dead-ends.
    const bLease = await leaseOne(token, "np-b");
    expect(bLease.isCompensation).toBe(false);

    // Complete branch A's np-a → its token advances svcA → Xn, which matches NO
    // condition and has NO default → terminal noPath Hazard on branch A.
    const aDone = await complete(token, await leaseOne(token, "np-a"), {});
    expect(aDone.status).toBe(200);

    // The WHOLE instance goes incident (no sibling wedge / runaway): the branch-level
    // noPath is an instance-terminal Hazard.
    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(inst.body.incident.kind).toBe("noPath");
    expect(inst.body.incident.elementId).toBe("Xn"); // the dead-ending XOR split in branch A
    expect(inst.body.incident.reason).toMatch(/no default/i);
    expect(inst.body.incident.status).toBe("open");
    // No decision row for the failed visit — the incident IS the record.
    expect(await getGatewayDecision(env.DB, id, "Xn", 0)).toBeNull();

    // Sibling branch B's token is FROZEN at svcB — never advanced past the join.
    const rows = await listTokens(env.DB, id);
    const bTok = rows.find((r) => r.branch_flow_id === "f2");
    expect(bTok).toBeDefined();
    expect(bTok!.position_element_id).toBe("svcB");
    expect(LIVE).toContain(bTok!.status); // still live/frozen, not merged/consumed/discarded
    expect((await jobRow(bLease.jobId))!.status).toBe("locked"); // np-b still in-flight, not advanced
    // The AND join never fired — branch B was never folded through it.
    expect(await joinCompletionCount(id, "join")).toBe(0);

    // Deterministic + terminal within the test: a re-read is byte-stable, the sibling
    // never advances on its own.
    const again = await get(`/instances/${id}`);
    expect(again.body.status).toBe("incident");
    expect(again.body.incident.incidentId).toBe(inst.body.incident.incidentId);
    const incidents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE instance_id = ?`)
      .bind(id)
      .first<{ n: number }>();
    expect(incidents?.n).toBe(1);
  });
});
