// Layer B (workflow-mode) concurrency suite — the M4-closure gate. Drives the REAL
// ProcessWorkflow (single-wake engine, step.waitForEvent suspend/resume) over the
// public HTTP API against `wrangler dev`. This is the layer L6.6 escaped: the
// multi-wait AND/OR-join HANGS on real Cloudflare Workflows but was green in
// direct-mode CI. Each scenario id below carries a literal `[id]` marker that
// scripts/check-matrix.mjs greps.
//
// AUTOMATION BOUNDARY (honest scoping — design §4.3 real-CF DoD gate): the HTTP-only
// driver drives liveness, swapped-order determinism, idempotency, apply-from-D1
// recovery, and timer firing. Because the rewalk/occurrence engine RE-WALKS FROM
// START on EVERY wake and fast-forwards applied visits write-free, the natural
// per-wake re-walk IS the replay/fast-forward path — so crash/replay determinism is
// covered as "no double-apply across the real re-walks." What the HTTP layer CANNOT
// do is inject a true mid-step crash or SUPPRESS a sendEvent (lost-tickle), nor
// reach the retired waitTimeout kind; those four scenarios are authored as
// `it.skip` with `@needs-real-cf` and the exact mechanism, validated on the deployed
// *.workers.dev DoD gate (WF_BASE_URL) where a backstop override + crash injection
// are available. The MAX_WAKE_BACKSTOP_OVERRIDE env (src/runtime/wake.ts) exists for
// that gate.
import { describe, expect, it } from "vitest";
import { INCLUSIVE_BPMN, PARALLEL_BPMN, PARALLEL_MESSAGE_DISTINCT_BPMN } from "../helpers";
import {
  activate,
  completeJob,
  countHistoryType,
  getHistory,
  getInstance,
  j,
  leaseAndComplete,
  mintWorkerToken,
  publishAndStart,
  publishMessage,
  pollToTerminal,
} from "./driver";

// fork -> (A: svcA -> intermediate timer PT3S | B: msgCatch "TMReady") -> join.
// A heterogeneous frontier: one branch timer-waiting, one message-waiting.
const TIMER_MIXED_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_tmix" targetNamespace="x">
  <bpmn:message id="m_tm" name="TMReady"/>
  <bpmn:process id="P_tmix" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>s0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="fork"/>
    <bpmn:parallelGateway id="fork"><bpmn:incoming>s0</bpmn:incoming><bpmn:outgoing>f1</bpmn:outgoing><bpmn:outgoing>f2</bpmn:outgoing></bpmn:parallelGateway>
    <bpmn:sequenceFlow id="f1" sourceRef="fork" targetRef="A"/>
    <bpmn:sequenceFlow id="f2" sourceRef="fork" targetRef="R"/>
    <bpmn:serviceTask id="A" name="svcA"><bpmn:extensionElements><easy-bpmn:taskDefinition type="tm-a"/></bpmn:extensionElements><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>a_t</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="a_t" sourceRef="A" targetRef="T"/>
    <bpmn:intermediateCatchEvent id="T"><bpmn:timerEventDefinition><bpmn:timeDuration>PT3S</bpmn:timeDuration></bpmn:timerEventDefinition><bpmn:incoming>a_t</bpmn:incoming><bpmn:outgoing>j1</bpmn:outgoing></bpmn:intermediateCatchEvent>
    <bpmn:receiveTask id="R" name="awaitTM" messageRef="m_tm"><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>j2</bpmn:outgoing></bpmn:receiveTask>
    <bpmn:parallelGateway id="join"><bpmn:incoming>j1</bpmn:incoming><bpmn:incoming>j2</bpmn:incoming><bpmn:outgoing>s1</bpmn:outgoing></bpmn:parallelGateway>
    <bpmn:sequenceFlow id="j1" sourceRef="T" targetRef="join"/>
    <bpmn:sequenceFlow id="j2" sourceRef="R" targetRef="join"/>
    <bpmn:sequenceFlow id="s1" sourceRef="join" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>s1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe("workflow-mode concurrency (M4-closure gate)", () => {
  // The headline L6.6 regression: a 2-branch AND-join under the real single-wake
  // engine must COMPLETE (not hang) and must not double-apply across the per-wake
  // re-walks (each external completion re-walks from start; the committed branch
  // fast-forwards write-free). This is the crash/replay fast-forward path exercised
  // for real — completing A then B forces a re-walk that must skip the committed A.
  it("[W-AND-CRASH-01] AND-join completes with no double-apply across the real per-wake re-walks", async () => {
    const token = await mintWorkerToken();
    const { instanceId } = await publishAndStart(PARALLEL_BPMN, { correlationKey: uniq("wand-crash") });
    await leaseAndComplete(token, "reserve-stock"); // branch A commits; the next wake re-walks past it
    await leaseAndComplete(token, "authorize-payment"); // branch B commits -> join fires
    await leaseAndComplete(token, "confirm-order"); // post-join
    const r = await pollToTerminal(instanceId, { deadlineMs: 30_000 });
    expect(r.status, `stuck at ${r.status} after ${r.elapsedMs}ms`).toBe("completed");
    const events = await getHistory(instanceId);
    // Exactly-once across the re-walks: A, B, C each completed once; the join + the
    // instance completion land once (no replay double-produce).
    expect(countHistoryType(events, "serviceTaskCompleted")).toBe(3);
    expect(countHistoryType(events, "instanceCompleted")).toBe(1);
  });

  // Swapped completion order (A-then-B vs B-then-A) must reach a deep-equal final
  // state: same status, same per-token history-tag counts, same merged variables
  // (doc-order merge, NOT arrival-order). Catches a race-winner-dependent merge.
  it("[W-AND-NEARSIM-01] swapped branch-completion order reaches a deterministic final state", async () => {
    async function run(order: "AB" | "BA") {
      const token = await mintWorkerToken();
      const { instanceId } = await publishAndStart(PARALLEL_BPMN, { correlationKey: uniq(`wand-nearsim-${order}`) });
      // Branch A (reserve-stock, flow f1) and B (authorize-payment, flow f2) write a
      // conflicting key; doc-order-later (B/f2) must win regardless of completion order.
      if (order === "AB") {
        await leaseAndComplete(token, "reserve-stock", { k: "A" });
        await leaseAndComplete(token, "authorize-payment", { k: "B" });
      } else {
        await leaseAndComplete(token, "authorize-payment", { k: "B" });
        await leaseAndComplete(token, "reserve-stock", { k: "A" });
      }
      await leaseAndComplete(token, "confirm-order");
      const r = await pollToTerminal(instanceId, { deadlineMs: 30_000 });
      expect(r.status, `${order} stuck at ${r.status}`).toBe("completed");
      const events = await getHistory(instanceId);
      return {
        status: r.status,
        svcCompleted: countHistoryType(events, "serviceTaskCompleted"),
        completed: countHistoryType(events, "instanceCompleted"),
        k: (r.body?.variables ?? {}).k,
      };
    }
    const ab = await run("AB");
    const ba = await run("BA");
    expect(ba).toEqual(ab); // deterministic across swapped order
    expect(ab.k).toBe("B"); // doc-order-later branch wins the conflict (not arrival order)
  });

  // Apply-from-D1: the contentless bpmn_wake carries no payload, so each branch's
  // message must be reconstructed from the external_messages row. Delivering two
  // distinct messages and completing proves the payload was sourced from D1.
  it("[W-APPLYFROMD1-01] distinct per-branch messages apply from D1 and the join completes", async () => {
    const ck = uniq("wapply");
    const { instanceId } = await publishAndStart(PARALLEL_MESSAGE_DISTINCT_BPMN, { correlationKey: ck });
    expect((await publishMessage({ messageName: "Ready", correlationKey: ck, messageId: `${ck}-a`, payload: { from: "A" } })).status).toBe(202);
    expect((await publishMessage({ messageName: "Paid", correlationKey: ck, messageId: `${ck}-b`, payload: { from: "B" } })).status).toBe(202);
    const r = await pollToTerminal(instanceId, { deadlineMs: 30_000 });
    expect(r.status, `stuck at ${r.status}`).toBe("completed");
    const events = await getHistory(instanceId);
    expect(countHistoryType(events, "messageCorrelated")).toBe(2); // each branch applied its own
    expect(countHistoryType(events, "instanceCompleted")).toBe(1);
  });

  // The W-BUFFERED-STRAND fix over the REAL workflow path: an early-buffered branch
  // message claimed at registration must NOT strand — the join completes once the
  // sibling's message arrives (no waitTimeout, no hang).
  it("[W-BUFFERED-STRAND-01] an early-buffered branch message is recovered (no strand) and the join completes", async () => {
    const ck = uniq("wstrand");
    // Buffer "Ready" BEFORE the instance exists (no active subscription -> buffered).
    expect((await publishMessage({ messageName: "Ready", correlationKey: ck, messageId: `${ck}-a`, payload: { from: "A" } })).body.outcome).toBe("buffered");
    const { instanceId } = await publishAndStart(PARALLEL_MESSAGE_DISTINCT_BPMN, { correlationKey: ck });
    // Branch R1 claims the buffered "Ready" at registration; deliver the sibling "Paid".
    expect((await publishMessage({ messageName: "Paid", correlationKey: ck, messageId: `${ck}-b`, payload: { from: "B" } })).status).toBe(202);
    const r = await pollToTerminal(instanceId, { deadlineMs: 30_000 });
    expect(r.status, `buffered-branch stranded? stuck at ${r.status} after ${r.elapsedMs}ms`).toBe("completed");
    expect(countHistoryType(await getHistory(instanceId), "instanceCompleted")).toBe(1);
  });

  // At-least-once TAIL of the wake protocol: a stray/duplicate tickle delivered AFTER
  // the instance is terminal must be a clean no-op (no re-drive, no duplicate history,
  // no Worker error). Drives to completed, then re-POSTs a duplicate message + a
  // late activate, and asserts the GET body is byte-identical.
  it("[W-WAKE-TERMINAL-01] a duplicate message/activate after a terminal instance is a clean no-op", async () => {
    const token = await mintWorkerToken();
    const ck = uniq("wterm");
    const { instanceId } = await publishAndStart(PARALLEL_BPMN, { correlationKey: ck });
    await leaseAndComplete(token, "reserve-stock");
    await leaseAndComplete(token, "authorize-payment");
    await leaseAndComplete(token, "confirm-order");
    const before = await pollToTerminal(instanceId, { deadlineMs: 30_000 });
    expect(before.status).toBe("completed");
    const beforeBody = JSON.stringify((await getInstance(instanceId)).body);
    const beforeHistory = (await getHistory(instanceId)).length;

    // Stray duplicate tickles to the finished instance: a retried publish + a late activate.
    await publishMessage({ messageName: "Confirmed", correlationKey: ck, messageId: `${ck}-stray`, payload: {} });
    await activate(token, "reserve-stock"); // no leasable jobs; emits/attempts a wake to a finished instance
    await new Promise((res) => setTimeout(res, 1500));

    const after = await getInstance(instanceId);
    expect(after.body.status).toBe("completed");
    expect(JSON.stringify(after.body)).toBe(beforeBody); // unchanged
    expect((await getHistory(instanceId)).length).toBe(beforeHistory); // no new history
  });

  // Timer-aware backstop with a MIXED frontier: one branch parks on an intermediate
  // timer (PT3S), the sibling on a message (no model deadline). The timer must fire
  // on time and the message branch must still complete — no hang, no hot re-walk that
  // never terminates. (The internal step-budget/backstop-regrow assertion is the
  // direct-mode white-box; here we assert the heterogeneous frontier converges.)
  it("[W-TIMER-MIXED-BACKSTOP-01] a timer branch + a message branch both reach the join under the timer-aware backstop", async () => {
    const token = await mintWorkerToken();
    const ck = uniq("wtmix");
    const { instanceId } = await publishAndStart(TIMER_MIXED_BPMN, { correlationKey: ck });
    await leaseAndComplete(token, "tm-a"); // branch A advances to its PT3S intermediate timer
    expect((await publishMessage({ messageName: "TMReady", correlationKey: ck, messageId: `${ck}-m`, payload: {} })).status).toBe(202);
    const r = await pollToTerminal(instanceId, { deadlineMs: 30_000 });
    expect(r.status, `mixed-frontier stuck at ${r.status} after ${r.elapsedMs}ms`).toBe("completed");
    const events = await getHistory(instanceId);
    expect(countHistoryType(events, "timerFired")).toBe(1);
    expect(countHistoryType(events, "instanceCompleted")).toBe(1);
  });

  // Gateway-decision reuse across the real per-wake re-walks: an inclusiveGateway
  // records its activated subset once; every subsequent wake re-walk reuses the
  // gateway_decisions row verbatim (conditions never re-evaluated). Activating a
  // subset and completing proves the OR-join waits on exactly the recorded subset.
  it("[W-GWREUSE-01] OR activated-subset is recorded once and reused across re-walks; the join waits on exactly it", async () => {
    const token = await mintWorkerToken();
    const { instanceId } = await publishAndStart(INCLUSIVE_BPMN, {
      correlationKey: uniq("wgwreuse"),
      variables: { wantsEmail: true, wantsSms: true },
    });
    // Subset = {Email, Sms}; the default (Log) must NOT activate. Complete both.
    await leaseAndComplete(token, "send-email");
    await leaseAndComplete(token, "send-sms");
    const r = await pollToTerminal(instanceId, { deadlineMs: 30_000 });
    expect(r.status, `stuck at ${r.status}`).toBe("completed");
    const events = await getHistory(instanceId);
    expect(countHistoryType(events, "serviceTaskCompleted")).toBe(2); // exactly the recorded subset, not 3
    expect(countHistoryType(events, "instanceCompleted")).toBe(1);
  });

  // Join-fold idempotence across the real re-walks: the join folds the branch
  // overlays onto the parent token EXACTLY once (claimJoinCompletion fast-forwards on
  // its existing row without re-merging). Every external completion re-walks the
  // join; the merged var must equal the doc-order winner and never double-fold.
  it("[W-JOIN-FOLD-REPLAY-01] the join folds branch overlays exactly once across re-walks (no double-fold corruption)", async () => {
    const token = await mintWorkerToken();
    const { instanceId } = await publishAndStart(PARALLEL_BPMN, { correlationKey: uniq("wfold") });
    await leaseAndComplete(token, "reserve-stock", { k: "A", a: 1 });
    await leaseAndComplete(token, "authorize-payment", { k: "B", b: 2 });
    await leaseAndComplete(token, "confirm-order"); // post-join re-walk re-enters the fold (must fast-forward)
    const r = await pollToTerminal(instanceId, { deadlineMs: 30_000 });
    expect(r.status, `stuck at ${r.status}`).toBe("completed");
    const vars = r.body?.variables ?? {};
    expect(vars.k).toBe("B"); // doc-order-later branch wins; not double-folded
    expect(vars.a).toBe(1); // non-conflicting keys union once
    expect(vars.b).toBe(2);
    expect(countHistoryType(await getHistory(instanceId), "instanceCompleted")).toBe(1);
  });

  // --- @needs-real-cf: mechanisms the HTTP-only driver cannot inject ----------
  // These require suppressing a sendEvent (lost tickle), injecting a true mid-step
  // crash, or the retired waitTimeout kind. They are validated on the deployed
  // *.workers.dev DoD gate (design §4.3) with the MAX_WAKE_BACKSTOP_OVERRIDE and the
  // probe truth-table; the markers below keep the registry drift-guard satisfied.

  it.skip("[W-AND-TICKLE-GAP-01] @needs-real-cf two near-simultaneous tickles, second dropped in the inter-wait gap, recovered by the backstop", async () => {
    // Requires dropping the SECOND bpmn_wake sendEvent (CF event-buffer race) — not
    // expressible over HTTP, where every completion sends its tickle. Real-CF gate.
  });

  it.skip("[W-SELFHEAL-01] @needs-real-cf lost wake self-heals via the timer-aware bounded backstop (result committed to D1, no tickle)", async () => {
    // Requires committing the awaited result to D1 WITHOUT sendEvent (a direct D1
    // write the HTTP API never performs). Run on the *.workers.dev DoD gate with
    // MAX_WAKE_BACKSTOP_OVERRIDE short so wake#k times out -> re-walk -> apply-from-D1.
  });

  it.skip("[W-AND-BRANCHTIMEOUT-01] @needs-real-cf one branch durable-wait times out while the sibling is live (waitTimeout)", async () => {
    // The waitTimeout kind is retired post-TASK-54 (the recv-timeout producer was
    // removed; a timer-guarded wait never raises it). Reaching the un-guarded
    // service/receive durable-wait cap needs the real-CF wait-cap wall clock.
  });

  it.skip("[W-COMP-CRASH-REPLAY-01] @needs-real-cf crash mid-compensation reverse pass; replay must not re-run applied compensators", async () => {
    // Requires a true mid-reverse-pass crash injection (no HTTP hook). The steady-
    // state barrier + no-double-compensation is covered direct-mode in
    // parallel-compensation.test.ts / C-COMP-QUIESCE-01; the crash/replay variant is
    // the real-CF DoD gate.
  });
});
