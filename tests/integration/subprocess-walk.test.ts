import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SUBPROC_LINEAR_BPMN, leaseAndComplete, mintWorkerToken, publishAndStart } from "../helpers";

// M5-L1 (TASK-5 of the M5-L1 plan) — the engine walks a plain embedded
// subProcess as a bookkeeping scope: enter (scopeEntered) advances the cursor
// onto the subProcess's own inner start, exit (scopeExited) fires on the
// subProcess's inner none end and continues on the OUTER flow. Unlike a
// transaction commit, exiting a subProcess mutates NO saga ledger (spec §2).
describe("M5-L1 subProcess walk", () => {
  it("walks Start -> subProcess(start->task->end) -> End; scope markers in history", async () => {
    const { instance } = await publishAndStart(SUBPROC_LINEAR_BPMN, { correlationKey: "subproc-1", variables: {} });
    const instanceId = instance.body.instanceId;
    const token = await mintWorkerToken();
    await leaseAndComplete(token, "doWork", { done: true });

    const inst = await env.DB.prepare(`SELECT status FROM process_instances WHERE instance_id = ?`)
      .bind(instanceId)
      .first<{ status: string }>();
    expect(inst!.status).toBe("completed");

    const hist = (
      await env.DB.prepare(`SELECT type, element_id FROM history_events WHERE instance_id = ? ORDER BY rowid`)
        .bind(instanceId)
        .all<{ type: string; element_id: string }>()
    ).results!;
    expect(hist.some((h) => h.type === "scopeEntered" && h.element_id === "sub")).toBe(true);
    expect(hist.some((h) => h.type === "scopeExited" && h.element_id === "sub")).toBe(true);

    // scopeExited lands after the inner task completed.
    const exitIdx = hist.findIndex((h) => h.type === "scopeExited");
    const taskIdx = hist.findIndex((h) => h.type === "serviceTaskCompleted");
    expect(exitIdx).toBeGreaterThan(taskIdx);
  });
});
