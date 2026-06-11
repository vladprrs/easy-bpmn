import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  LOOP_XOR_BPMN,
  SAGA_LOOP_BPMN,
  authedPost,
  get,
  leaseAndComplete,
  leaseOne,
  mintWorkerToken,
  post,
  publishAndStart,
  rewindBackoff,
} from "../helpers";
import { ensureWorkspace } from "../../src/persistence/db";
import { createVersion } from "../../src/persistence/definitions";
import { createInstance } from "../../src/persistence/instances";
import { MAX_ELEMENT_OCCURRENCES, resumeInline } from "../../src/runtime/engine";
import type { ExecutionGraph } from "../../src/bpmn/graph";

// TASK-35 — loop guard behavioral contract (design M2 §5, §2 decision 2,
// R-M2-5), DIRECT mode. The guard MECHANISM landed in TASK-32 (walk-local
// visit counter checked at the top of the walk loop, upstream of node
// dispatch); these tests pin its CONTRACT:
//
//   1. cap trip → terminal incident kind=loopLimit carrying element id +
//      occurrence count, M1 incident lifecycle (open, operator verbs live);
//   2. inside a transaction the cap is a HAZARD — no auto-compensation;
//      operator /cancel runs the reverse pass over the completed iterations;
//   3. technical retries (re-lease, fail retryable=true) of ONE iteration do
//      not consume the cap — only completed-visit re-entries count.
//
// Test economics: tripping the cap NEVER goes through 1000 worker round-trips.
// Pure gateway visits loop without jobs (TASK-34: the guard wraps gateway
// visits; decision rows stay bounded at the cap), so a tight gateway-only
// cycle burns the REAL MAX_ELEMENT_OCCURRENCES in seconds — one decision-row
// dbBatch per visit. No test-only cap override exists; production and tests
// share the one constant.

async function decisionCount(instanceId: string, elementId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM gateway_decisions WHERE instance_id = ? AND element_id = ?`,
  )
    .bind(instanceId, elementId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("loop guard — MAX_ELEMENT_OCCURRENCES trips a terminal loopLimit incident (AC1)", () => {
  // ENGINE-HARNESS-ONLY graph (injected via createVersion, bypassing the
  // publish gate): a single PASS-THROUGH gateway whose only flow targets
  // itself — the tightest possible cycle (no jobs, no conditions; one
  // decision-row dbBatch per visit). The walk burns the real cap inline.
  it(
    "a pure-gateway self-loop trips the cap: incident kind=loopLimit with element id + occurrence count, decision rows bounded at the cap",
    { timeout: 90_000 },
    async () => {
      const now = new Date().toISOString();
      await ensureWorkspace(env.DB, "default", now);
      const graph: ExecutionGraph = {
        processId: "P_cap",
        startElementId: "Start",
        endElementIds: [],
        elements: [],
        nodes: {
          Start: {
            type: "startEvent",
            next: "GW",
            outgoing: [{ flowId: "f0", targetId: "GW", conditionExpression: null, isDefault: false }],
          },
          GW: {
            type: "exclusiveGateway",
            next: null,
            outgoing: [{ flowId: "f_self", targetId: "GW", conditionExpression: null, isDefault: false }],
          },
        },
      };
      const versionId = `pdv_cap_${crypto.randomUUID()}`;
      await createVersion(env.DB, {
        definitionVersionId: versionId,
        draftId: `draft_cap_${crypto.randomUUID()}`,
        workspaceId: "default",
        versionNumber: 1,
        bpmnXml: "<!-- engine-harness-only loop-cap graph; injected, never published -->",
        bpmnXmlHash: `hash_${crypto.randomUUID()}`,
        graph,
        now,
      });
      const id = `pi_cap_${crypto.randomUUID()}`;
      await createInstance(env.DB, {
        instanceId: id,
        workspaceId: "default",
        definitionVersionId: versionId,
        workflowInstanceId: id,
        correlationKey: `cap-${crypto.randomUUID()}`,
        startElementId: "Start",
        variables: {},
        now,
      });

      const result = await resumeInline(env, id);
      expect(result.status).toBe("incident");

      // Terminal incident per the M1 lifecycle: status=incident with an OPEN
      // incident object on the inspection surface.
      const inst = await get(`/instances/${id}`);
      expect(inst.body.status).toBe("incident");
      expect(inst.body.incident.kind).toBe("loopLimit");
      expect(inst.body.incident.status).toBe("open");
      // Diagnostics: the element id (incident.elementId + named in the
      // reason) and the occurrence count (payloadContext).
      expect(inst.body.incident.elementId).toBe("GW");
      expect(inst.body.incident.reason).toContain("GW");
      expect(inst.body.incident.reason).toContain(String(MAX_ELEMENT_OCCURRENCES));
      expect(inst.body.incident.payloadContext.elementId).toBe("GW");
      expect(inst.body.incident.payloadContext.occurrence).toBe(MAX_ELEMENT_OCCURRENCES);
      expect(inst.body.incident.payloadContext.cap).toBe(MAX_ELEMENT_OCCURRENCES);

      // Storage stays bounded: visits 0..cap-1 each wrote ONE decision row;
      // the tripping visit wrote the incident, not a decision.
      expect(await decisionCount(id, "GW")).toBe(MAX_ELEMENT_OCCURRENCES);

      // 'incident' is terminal for the walk: a re-drive is a no-op (no second
      // incident row, no extra decisions).
      expect((await resumeInline(env, id)).status).toBe("completed");
      const incidents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE instance_id = ?`)
        .bind(id)
        .first<{ n: number }>();
      expect(incidents?.n).toBe(1);
      expect(await decisionCount(id, "GW")).toBe(MAX_ELEMENT_OCCURRENCES);

      // Lifecycle consistency: the operator verbs stay available from
      // 'incident' — with an empty ledger, /cancel settles 'cancelled'.
      const cancel = await post(`/instances/${id}/cancel`, {});
      expect(cancel.status).toBe(200);
      expect(cancel.body.status).toBe("cancelled");
    },
  );
});

describe("loop guard inside a transaction — Hazard semantics (AC2, SAGA_LOOP_BPMN)", () => {
  it(
    "loopLimit inside a transaction does NOT auto-compensate; operator /cancel compensates the completed iterations in reverse",
    { timeout: 90_000 },
    async () => {
      // The owed saga-loop fixture publishes through the REAL validator
      // (transaction + compensation pair + XOR cycle + self-loop + cancel/error
      // wiring all accepted since TASK-33).
      const { instance } = await publishAndStart(SAGA_LOOP_BPMN, {
        correlationKey: `loop-hazard-${crypto.randomUUID()}`,
        variables: {},
      });
      expect(instance.status).toBe(201);
      const id = instance.body.instanceId;
      const token = await mintWorkerToken();

      // Iteration 0: reserveItem completes compensatable (ledger row, occurrence 0)
      // and loops back via `more = true`.
      await leaseAndComplete(token, "reserve-item", { itemId: "i-0", more: true });
      expect((await get(`/instances/${id}`)).body.currentElementId).toBe("reserveItem");

      // Iteration 1: completes (ledger row, occurrence 1) and arms the f_spin
      // SELF-LOOP — GW_more then revisits itself with zero jobs until the
      // walk-local counter trips the real cap inside this drive.
      await leaseAndComplete(token, "reserve-item", { itemId: "i-1", more: false, spin: true });

      const hazard = await get(`/instances/${id}`);
      expect(hazard.body.status).toBe("incident");
      expect(hazard.body.incident.kind).toBe("loopLimit");
      expect(hazard.body.incident.elementId).toBe("GW_more");
      expect(hazard.body.incident.status).toBe("open");
      expect(hazard.body.incident.payloadContext.occurrence).toBe(MAX_ELEMENT_OCCURRENCES);

      // HAZARD: both completed iterations are STRANDED 'pending' — no
      // auto-compensation ever runs off a loopLimit (design §5: only a cancel
      // end / operator cancel compensates).
      const pendingSteps = hazard.body.saga.steps.filter((s: any) => s.elementId === "reserveItem");
      expect(pendingSteps).toHaveLength(2);
      expect(pendingSteps.map((s: any) => s.compensationStatus)).toEqual(["pending", "pending"]);
      const compJobs = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM service_task_jobs WHERE instance_id = ? AND is_compensation = 1`,
      )
        .bind(id)
        .first<{ n: number }>();
      expect(compJobs?.n).toBe(0);

      // Decision rows bounded at the cap: occurrence 0 chose f_more, 1..cap-1
      // chose the self-loop; the tripping visit recorded only the incident.
      expect(await decisionCount(id, "GW_more")).toBe(MAX_ELEMENT_OCCURRENCES);

      // Operator /cancel from the Hazard → reverse pass over the ledger,
      // HIGHEST occurrence first (each iteration is its own ledger row).
      const cancel = await post(`/instances/${id}/cancel`, {});
      expect(cancel.status).toBe(200);
      expect(cancel.body.status).toBe("compensating");

      const firstComp = await leaseOne(token, "release-item");
      const firstRow = await env.DB.prepare(`SELECT occurrence FROM service_task_jobs WHERE job_id = ?`)
        .bind(firstComp.jobId)
        .first<{ occurrence: number }>();
      expect(firstComp.elementId).toBe("reserveItem");
      expect(firstRow?.occurrence).toBe(1); // reverse order: iteration 1 before iteration 0
      expect(
        (await authedPost(`/jobs/${firstComp.jobId}/complete`, token, { lockToken: firstComp.lockToken, outputVariables: { released: "i-1" } })).status,
      ).toBe(200);

      const secondComp = await leaseOne(token, "release-item");
      const secondRow = await env.DB.prepare(`SELECT occurrence FROM service_task_jobs WHERE job_id = ?`)
        .bind(secondComp.jobId)
        .first<{ occurrence: number }>();
      expect(secondRow?.occurrence).toBe(0);
      expect(
        (await authedPost(`/jobs/${secondComp.jobId}/complete`, token, { lockToken: secondComp.lockToken, outputVariables: { released: "i-0" } })).status,
      ).toBe(200);

      const done = await get(`/instances/${id}`);
      expect(done.body.status).toBe("compensated");
      expect(done.body.saga.steps.filter((s: any) => s.elementId === "reserveItem").map((s: any) => s.compensationStatus)).toEqual([
        "compensated",
        "compensated",
      ]);
      // Carry resolved in TASK-36: /cancel sets resolution='compensating', and the
      // reverse-pass settle (engine settleSagaCompensated) advances it to
      // 'compensated' in the same dbBatch as the terminal transition — the
      // natural completion of the cancel-path incident lifecycle.
      const incident = await env.DB.prepare(`SELECT kind, resolution FROM incidents WHERE instance_id = ?`)
        .bind(id)
        .first<{ kind: string; resolution: string }>();
      expect(incident?.kind).toBe("loopLimit");
      expect(incident?.resolution).toBe("compensated");
    },
  );
});

describe("technical retries do not consume the cap (AC3, LOOP_XOR_BPMN)", () => {
  it("a retryable-failing iteration stays at ITS occurrence: attempt_count grows, no extra visits, the loop completes with no loopLimit", async () => {
    const { instance } = await publishAndStart(LOOP_XOR_BPMN, {
      correlationKey: `loop-retry-${crypto.randomUUID()}`,
      variables: {},
    });
    expect(instance.status).toBe(201);
    const id = instance.body.instanceId;
    const token = await mintWorkerToken();

    // T_charge runs once, before the cycle; the first gateway visit routes
    // into the loop body (declined, attempts left).
    await leaseAndComplete(token, "charge-card", { chargeResult: "declined", attemptsLeft: 2 });
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("T_switch");

    // Iteration 0 of T_switch takes a TECHNICAL retry: attempt 1 fails
    // retryable → backoff park → re-lease → attempt 2 completes. Same job
    // row, same occurrence — the walk-local visit counter never moves.
    const attempt1 = await leaseOne(token, "switch-payment-method");
    expect(attempt1.attempt).toBe(1);
    const failed = await authedPost(`/jobs/${attempt1.jobId}/fail`, token, {
      lockToken: attempt1.lockToken,
      reason: "transient PSP outage",
      retryable: true,
    });
    expect(failed.status).toBe(200);
    await rewindBackoff(id, "switch-payment-method");
    const attempt2 = await leaseOne(token, "switch-payment-method");
    expect(attempt2.jobId).toBe(attempt1.jobId); // the SAME iteration, re-leased
    expect(attempt2.attempt).toBe(2);
    expect(
      (await authedPost(`/jobs/${attempt2.jobId}/complete`, token, { lockToken: attempt2.lockToken, outputVariables: { attemptsLeft: 1 } })).status,
    ).toBe(200);

    // Iteration 1 completes cleanly and exits the loop via the default flow.
    expect((await get(`/instances/${id}`)).body.currentElementId).toBe("T_switch");
    await leaseAndComplete(token, "switch-payment-method", { chargeResult: "ok" });

    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");

    // The retried iteration is ONE occurrence with attempt_count > 1 — the
    // retries consumed the job's attempt budget, never the visit cap.
    const jobs = await env.DB.prepare(
      `SELECT element_id, occurrence, attempt_count FROM service_task_jobs WHERE instance_id = ? ORDER BY element_id, occurrence`,
    )
      .bind(id)
      .all<{ element_id: string; occurrence: number; attempt_count: number }>();
    expect((jobs.results ?? []).map((j) => [j.element_id, j.occurrence, j.attempt_count])).toEqual([
      ["T_charge", 0, 1],
      ["T_switch", 0, 2],
      ["T_switch", 1, 1],
    ]);

    // Gateway visits: exactly one decision per COMPLETED re-entry (occ 0..2);
    // the technical retry added none.
    expect(await decisionCount(id, "GW_retry")).toBe(3);

    // And no incident of any kind — in particular no loopLimit.
    const incidents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE instance_id = ?`)
      .bind(id)
      .first<{ n: number }>();
    expect(incidents?.n).toBe(0);
  });
});
