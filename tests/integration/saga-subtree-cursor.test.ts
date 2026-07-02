import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { countCompensableSteps, insertSagaStepStmt, markScopeStepsCommittedStmt, selectSubtreeStepsForCompensation } from "../../src/persistence/saga";

const INST = "inst_cursor_test";

async function seed(stepId: string, scopeId: string, status: string, elementId: string, occurrence = 0) {
  await insertSagaStepStmt(env.DB, {
    stepId, instanceId: INST, scopeId, elementId, forwardJobId: `j_${stepId}`,
    capturedInput: {}, capturedOutput: null, compensationElementId: "h", compensationTaskType: "undo",
    compensationStatus: "pending", occurrence, now: new Date().toISOString(),
  }).run();
  if (status !== "pending") {
    await env.DB.prepare(`UPDATE saga_steps SET compensation_status = ? WHERE step_id = ?`).bind(status, stepId).run();
  }
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM saga_steps WHERE instance_id = ?`).bind(INST).run();
});

// Scope tree used throughout: O(tx) > S(sub) > T(tx); process root = null-root lists.
const SUBTREE_O = ["O", "S", "T"];
const SUBTREE_T = ["T"];
const ELIGIBLE_FOR_O = ["T"];      // nearestTx(T)=T, O strictly above T
const ELIGIBLE_FOR_T: string[] = []; // self: strictAncestor(T,T)=false
const ALL = ["O", "S", "T"];
const ELIGIBLE_FOR_ROOT = ["O", "S", "T"]; // process root strictly above every tx

describe("root-relative subtree cursor (spec §3.4)", () => {
  it("outer cancel reaches a committed inner tx's rows in global reverse order", async () => {
    await seed("st1", "O", "pending", "a");            // seq 1
    await seed("st2", "T", "committedLocal", "b");     // seq 2
    await seed("st3", "O", "pending", "c");            // seq 3
    const steps = await selectSubtreeStepsForCompensation(env.DB, INST, SUBTREE_O, ELIGIBLE_FOR_O);
    expect(steps.map((s) => s.stepId)).toEqual(["st3", "st2", "st1"]); // global seq DESC across scopes
  });
  it("self re-entry shield: root T never re-selects T-committed rows (any occurrence)", async () => {
    await seed("st1", "T", "committedLocal", "a", 0);
    await seed("st2", "T", "pending", "a", 1);
    const steps = await selectSubtreeStepsForCompensation(env.DB, INST, SUBTREE_T, ELIGIBLE_FOR_T);
    expect(steps.map((s) => s.stepId)).toEqual(["st2"]);
  });
  it("process-root (/cancel) takes every committedLocal but NEVER sealed committed", async () => {
    await seed("st1", "T", "committedLocal", "a");
    await seed("st2", "O", "committed", "b");   // sealed at an outermost commit
    await seed("st3", "S", "pending", "c");
    const steps = await selectSubtreeStepsForCompensation(env.DB, INST, ALL, ELIGIBLE_FOR_ROOT);
    expect(steps.map((s) => s.stepId).sort()).toEqual(["st1", "st3"]);
    expect(await countCompensableSteps(env.DB, INST, ALL, ELIGIBLE_FOR_ROOT)).toBe(2);
  });
  it("notRequired is never selected; failed is", async () => {
    await seed("st1", "O", "notRequired", "a");
    await seed("st2", "O", "failed", "b");
    const steps = await selectSubtreeStepsForCompensation(env.DB, INST, SUBTREE_O, ELIGIBLE_FOR_O);
    expect(steps.map((s) => s.stepId)).toEqual(["st2"]);
  });
  it("markScopeStepsCommittedStmt: nested (seal=false) flips owned pending → committedLocal; seal=true also lifts committedLocal → committed", async () => {
    await seed("st1", "T", "pending", "a");
    await seed("st2", "S", "pending", "b");
    await markScopeStepsCommittedStmt(env.DB, { instanceId: INST, scopeIds: ["T"], seal: false, now: new Date().toISOString() }).run();
    let rows = (await env.DB.prepare(`SELECT step_id, compensation_status s FROM saga_steps WHERE instance_id = ? ORDER BY step_id`).bind(INST).all<{ step_id: string; s: string }>()).results!;
    expect(rows).toEqual([{ step_id: "st1", s: "committedLocal" }, { step_id: "st2", s: "pending" }]);
    await markScopeStepsCommittedStmt(env.DB, { instanceId: INST, scopeIds: ["O", "S", "T"], seal: true, now: new Date().toISOString() }).run();
    rows = (await env.DB.prepare(`SELECT step_id, compensation_status s FROM saga_steps WHERE instance_id = ? ORDER BY step_id`).bind(INST).all<{ step_id: string; s: string }>()).results!;
    expect(rows).toEqual([{ step_id: "st1", s: "committed" }, { step_id: "st2", s: "committed" }]);
  });
  it("seq is per-instance global across scopes", async () => {
    await seed("st1", "O", "pending", "a");
    await seed("st2", "T", "pending", "b");
    const rows = (await env.DB.prepare(`SELECT step_id, seq FROM saga_steps WHERE instance_id = ? ORDER BY seq`).bind(INST).all<{ step_id: string; seq: number }>()).results!;
    expect(rows).toEqual([{ step_id: "st1", seq: 1 }, { step_id: "st2", seq: 2 }]);
  });
});
