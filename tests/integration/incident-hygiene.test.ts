import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_BPMN, drainSampleWorkers, get, post, publishAndStart } from "../helpers";
import {
  getOpenIncidentsForInstance,
  incidentStmt,
  setIncidentResolution,
} from "../../src/persistence/instances";

// M3-L1 (TASK-39) incident hygiene:
//   1. setIncidentResolution gains an incident_id filter (today flips ALL
//      non-operatorResolved rows).
//   2. inspection exposes the LIST of open incidents (today only the latest).
//   3. operator /cancel with an empty ledger closes ALL open incidents.

async function newInstance(correlationKey: string): Promise<string> {
  const { instance } = await publishAndStart(DEMO_BPMN, { correlationKey, variables: { amount: 1 } });
  return instance.body.instanceId;
}

async function insertIncident(
  instanceId: string,
  opts: { incidentId: string; kind: string; resolution: string; elementId?: string },
): Promise<void> {
  await incidentStmt(env.DB, {
    incidentId: opts.incidentId,
    instanceId,
    elementId: opts.elementId ?? "Task_check",
    reason: `${opts.kind} incident`,
    retryCount: 0,
    kind: opts.kind as any,
    resolution: opts.resolution as any,
    now: new Date().toISOString(),
  }).run();
}

const resolutionOf = (incidentId: string) =>
  env.DB.prepare(`SELECT resolution FROM incidents WHERE incident_id = ?`).bind(incidentId).first<{ resolution: string }>();

describe("incident hygiene (M3-L1, TASK-39)", () => {
  it("setIncidentResolution with an incident_id filter flips ONLY the targeted incident", async () => {
    const id = await newInstance(`hyg-target-${crypto.randomUUID()}`);
    // A Hazard mid-compensation ('compensating') + a later compensationFailure ('open').
    await insertIncident(id, { incidentId: "inc_hazard", kind: "noPath", resolution: "compensating" });
    await insertIncident(id, { incidentId: "inc_later", kind: "compensationFailure", resolution: "open" });

    // Resolve ONLY the later one.
    await setIncidentResolution(env.DB, id, "operatorResolved", new Date().toISOString(), "inc_later");

    expect((await resolutionOf("inc_later"))!.resolution).toBe("operatorResolved");
    // The Hazard must NOT be flipped — it can still reach its natural 'compensated'.
    expect((await resolutionOf("inc_hazard"))!.resolution).toBe("compensating");
  });

  it("getOpenIncidentsForInstance lists every not-yet-resolved incident, newest-first", async () => {
    const id = await newInstance(`hyg-list-${crypto.randomUUID()}`);
    await insertIncident(id, { incidentId: "inc_a", kind: "serviceTaskFailure", resolution: "open" });
    await insertIncident(id, { incidentId: "inc_b", kind: "noPath", resolution: "compensating" });
    await insertIncident(id, { incidentId: "inc_c", kind: "compensationFailure", resolution: "operatorResolved" }); // resolved → excluded
    await insertIncident(id, { incidentId: "inc_d", kind: "waitTimeout", resolution: "compensated" }); // resolved → excluded

    const open = await getOpenIncidentsForInstance(env.DB, id);
    expect(open.map((i) => i.incidentId)).toEqual(["inc_b", "inc_a"]); // newest-first, only the unresolved two

    // Resolving one drops it from the list.
    await setIncidentResolution(env.DB, id, "operatorResolved", new Date().toISOString(), "inc_b");
    expect((await getOpenIncidentsForInstance(env.DB, id)).map((i) => i.incidentId)).toEqual(["inc_a"]);
  });

  it("instance inspection exposes the open-incidents list alongside the latest incident", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: `hyg-inspect-${crypto.randomUUID()}`,
      variables: { amount: 1, forceFail: true },
    });
    const id = instance.body.instanceId;
    await drainSampleWorkers({ taskTypes: ["external-check"] });

    const inst = await get(`/instances/${id}`);
    expect(inst.body.status).toBe("incident");
    expect(Array.isArray(inst.body.openIncidents)).toBe(true);
    expect(inst.body.openIncidents).toHaveLength(1);
    expect(inst.body.openIncidents[0].kind).toBe("serviceTaskFailure");
    expect(inst.body.openIncidents[0].resolution).toBe("open");
    // Backward-compat: the latest-incident field is still present and consistent.
    expect(inst.body.incident.incidentId).toBe(inst.body.openIncidents[0].incidentId);
  });

  it("operator /cancel on an empty-ledger incident instance closes ALL open incidents", async () => {
    const { instance } = await publishAndStart(DEMO_BPMN, {
      correlationKey: `hyg-empty-cancel-${crypto.randomUUID()}`,
      variables: { amount: 1 },
    });
    const id = instance.body.instanceId;

    // Drive the un-leasable-job DLQ → a terminal-ish 'incident' with an OPEN
    // incident and NO saga ledger (DEMO is not a transaction).
    const job = await env.DB.prepare(
      `SELECT job_id FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 0`,
    ).bind(id).first<{ job_id: string }>();
    await env.DB.prepare(`UPDATE service_task_jobs SET activation_expires_at = '2000-01-01T00:00:00Z' WHERE job_id = ?`).bind(job!.job_id).run();
    await runDurableObjectAlarm(env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(job!.job_id)));

    const hazard = await get(`/instances/${id}`);
    expect(hazard.body.status).toBe("incident");
    expect(hazard.body.openIncidents).toHaveLength(1);

    // Empty-ledger cancel: previously the incident stayed 'open' forever on a
    // terminal instance — now it is closed as operatorResolved.
    const cancel = await post(`/instances/${id}/cancel`, {});
    expect(cancel.body.status).toBe("cancelled");
    expect(await getOpenIncidentsForInstance(env.DB, id)).toHaveLength(0);
  });
});
