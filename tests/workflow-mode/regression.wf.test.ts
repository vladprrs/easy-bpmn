// Layer B (workflow-mode) regression suite — single-token suspend/resume + the
// boundary-timer backstop, driven over the public HTTP API against a live
// ProcessWorkflow (`wrangler dev`). The two scenario ids below are statically
// grepped by scripts/check-matrix.mjs (the registry drift-guard), so their
// bracketed markers MUST stay literal in this file.
//
// History `type` strings asserted below were captured from a real run against
// `wrangler dev` (not invented):
//   LINEAR: instanceStarted, elementEntered x4, serviceTaskJobCreated,
//           serviceTaskWaiting, jobActivated, jobCompleted, serviceTaskCompleted,
//           receiveTaskWaiting, messageReceived, messageCorrelated, instanceCompleted
//   TIMER:  instanceStarted, elementEntered x2, serviceTaskJobCreated, timerArmed,
//           serviceTaskWaiting, timerFired, elementEntered, instanceCompleted
import { describe, expect, it } from "vitest";
import { DEMO_BPMN } from "../helpers";
import {
  countHistoryType,
  getHistory,
  leaseAndComplete,
  mintWorkerToken,
  publishAndStart,
  publishMessage,
  pollToTerminal,
} from "./driver";

// A service task whose job is NEVER completed, guarded by an interrupting
// boundary timer (PT3S) that redirects to an END so the timer wins and the
// instance completes via the redirect. Proven to fire under `wrangler dev`.
const TIMER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="D_wreg_timer" targetNamespace="x">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"/>
    <bpmn:serviceTask id="slow"><bpmn:extensionElements><easy-bpmn:taskDefinition type="wreg-slow" retries="1"/></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:boundaryEvent id="tb" attachedToRef="slow"><bpmn:timerEventDefinition><bpmn:timeDuration>PT3S</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    <bpmn:endEvent id="onTimeout"/>
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="slow"/>
    <bpmn:sequenceFlow id="s1" sourceRef="slow" targetRef="E"/>
    <bpmn:sequenceFlow id="tf" sourceRef="tb" targetRef="onTimeout"/>
  </bpmn:process>
</bpmn:definitions>`;

describe("workflow-mode regression", () => {
  it("[W-REG-LINEAR-01] single-token linear suspend/resume completes exactly once", async () => {
    const token = await mintWorkerToken();
    const ck = `wreg-linear-${Date.now()}`;
    const { instanceId } = await publishAndStart(DEMO_BPMN, {
      correlationKey: ck,
      variables: { a: 1 },
    });

    // Service Task: lease + complete the one job.
    await leaseAndComplete(token, "external-check", { checked: true });

    // Receive Task: deliver the awaited message (unique messageId per run).
    const msg = await publishMessage({
      messageName: "ApprovalReceived",
      correlationKey: ck,
      messageId: `${ck}-m1`,
      payload: { approved: true },
    });
    expect(msg.status, `publishMessage -> ${msg.status}: ${JSON.stringify(msg.body)}`).toBe(202);

    const result = await pollToTerminal(instanceId, { deadlineMs: 30_000 });
    expect(
      result.status,
      `stuck at ${result.status} after ${result.elapsedMs}ms (polls=${result.polls})`,
    ).toBe("completed");

    // Each meaningful single-token transition lands exactly once: a duplicate
    // would be the at-least-once -> double-advance regression.
    const events = await getHistory(instanceId);
    expect(countHistoryType(events, "instanceStarted")).toBe(1);
    expect(countHistoryType(events, "serviceTaskJobCreated")).toBe(1);
    expect(countHistoryType(events, "jobCompleted")).toBe(1);
    expect(countHistoryType(events, "serviceTaskCompleted")).toBe(1);
    expect(countHistoryType(events, "receiveTaskWaiting")).toBe(1);
    expect(countHistoryType(events, "messageReceived")).toBe(1);
    expect(countHistoryType(events, "messageCorrelated")).toBe(1);
    expect(countHistoryType(events, "instanceCompleted")).toBe(1);
  });

  it("[W-REG-TIMER-01] single-token boundary-timer backstop fires on a real Workflow", async () => {
    const ck = `wreg-timer-${Date.now()}`;
    const { instanceId } = await publishAndStart(TIMER_BPMN, { correlationKey: ck });

    // No job completion: the PT3S interrupting boundary timer must win, via the
    // timer-aware (DO-alarm-first) backstop, within the 20s bound.
    const result = await pollToTerminal(instanceId, { deadlineMs: 20_000 });
    expect(
      result.status,
      `stuck at ${result.status} after ${result.elapsedMs}ms (polls=${result.polls})`,
    ).toBe("completed");

    // The timer fired exactly once (armed -> fired -> redirect -> complete).
    const events = await getHistory(instanceId);
    expect(countHistoryType(events, "timerArmed")).toBe(1);
    expect(countHistoryType(events, "timerFired")).toBe(1);
    expect(countHistoryType(events, "instanceCompleted")).toBe(1);
  });
});
