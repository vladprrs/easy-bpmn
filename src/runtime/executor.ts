// Execution driver seam. Production uses Cloudflare Workflows; tests use a
// deterministic in-process driver. Both run the SAME engine (src/runtime/engine.ts).

import type { Env } from "../env";
import type { JobResultEvent, MessageEventPayload, ProcessWorkflowParams } from "../contracts/workflow-events";
import { recordTerminalIncident, runInstance } from "./engine";
import { WAKE_TYPE } from "./wake";

export interface DeliverArgs {
  workflowInstanceId: string;
  instanceId: string;
  elementId: string;
  /**
   * The matched subscription's STORED Workflow wake type. VESTIGE under single-wake
   * (TASK-54): the engine now waits on the SINGLE constant WAKE_TYPE, so `sendEvent`
   * tickles on WAKE_TYPE regardless of this field's value (every subscription stores
   * WAKE_TYPE). The re-walk after the tickle reconciles the matched receive/branch
   * from D1. Carried only because the underlying column is kept NOT NULL (no migration).
   */
  workflowEventType: string;
  event: MessageEventPayload;
}

export interface DeliverJobArgs {
  workflowInstanceId: string;
  instanceId: string;
  elementId: string;
  // Worker-result delivery only (completed|failed). The `timerFired` member of the
  // wait union (M3-L3) is delivered via wakeTimer, never this path — narrowing it
  // out keeps `event.jobId` non-optional here.
  event: Extract<JobResultEvent, { outcome: "completed" | "failed" }>;
}

export interface Executor {
  /** Begin executing a freshly created process instance. */
  start(params: ProcessWorkflowParams): Promise<void>;
  /** Deliver a correlated message to a waiting instance. */
  deliver(args: DeliverArgs): Promise<void>;
  /** Deliver a pull-worker job result to a Service-Task-as-wait instance. */
  deliverJobResult(args: DeliverJobArgs): Promise<void>;
  /**
   * Wake a timer-guarded wait after `fireTimer` committed the winning batch
   * (M3-L3): direct mode resumes inline; workflow mode `sendEvent`s the
   * `timerFired` discriminator on the wait's event type. The decider already
   * transitioned the token; this only un-parks the driver.
   */
  wakeTimer(args: { instanceId: string; workflowEventType: string; timerId: string }): Promise<void>;
  /** End the per-instance Workflow (best-effort) so operator-driven flows resume inline. */
  terminate(instanceId: string): Promise<void>;
}

const inlineStep = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();

class WorkflowExecutor implements Executor {
  constructor(private env: Env) {}

  async start(params: ProcessWorkflowParams): Promise<void> {
    // The Workflow instance id mirrors the product instance id (stored in D1).
    await this.env.PROCESS_WORKFLOW.create({ id: params.instanceId, params });
  }

  async deliver(args: DeliverArgs): Promise<void> {
    const instance = await this.env.PROCESS_WORKFLOW.get(args.workflowInstanceId);
    // TASK-54: contentless tickle — the engine re-walks and applies the correlated
    // message from D1 (apply-from-D1). One constant type = replay-stable.
    await instance.sendEvent({ type: WAKE_TYPE, payload: { kind: "message" } });
  }

  async deliverJobResult(args: DeliverJobArgs): Promise<void> {
    try {
      const instance = await this.env.PROCESS_WORKFLOW.get(args.workflowInstanceId);
      await instance.sendEvent({ type: WAKE_TYPE, payload: { kind: "jobResult" } });
    } catch {
      // The Workflow has terminated (after an incident, or an operator /cancel
      // that ended it) and cannot resume from this event. Drive the engine inline
      // instead — the lock_token-conditional completion already guarantees
      // single-advance, and a terminated Workflow is not a concurrent driver. This
      // is what carries operator-resumed (cancel/retry) sagas to completion in
      // production (workflow) mode. Never a 500 (the worker would retry forever).
      try {
        await runInstance(this.env, args.instanceId, { runStep: inlineStep, waitFor: null, startAt: args.elementId });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ level: "error", message: "deliverJobResult inline drive failed", instanceId: args.instanceId, error: reason }));
        // Mode parity with the process-workflow catch-all: an engine invariant
        // violation must surface as an operator-visible incident, not just a
        // log. recordTerminalIncident is status-guarded (never regresses a
        // terminal instance); its own failure must not escape this catch either
        // (the at-least-once worker callback would retry forever on a 500).
        try {
          await recordTerminalIncident(this.env, args.instanceId, `Engine drive failed: ${reason}`);
        } catch (incErr) {
          console.error(JSON.stringify({ level: "error", message: "recordTerminalIncident failed", instanceId: args.instanceId, error: incErr instanceof Error ? incErr.message : String(incErr) }));
        }
      }
    }
  }

  async wakeTimer(args: { instanceId: string; workflowEventType: string; timerId: string }): Promise<void> {
    // The fireTimer batch already committed the transition + `timer_outcomes 'fired'`
    // decider; this only un-parks the Workflow. A terminated Workflow (incident /
    // operator cancel) cannot resume the event, so drive inline — the engine
    // re-reads the decider from D1 and routes down the boundary path either way.
    try {
      const instance = await this.env.PROCESS_WORKFLOW.get(args.instanceId);
      await instance.sendEvent({ type: WAKE_TYPE, payload: { kind: "timerFired", timerId: args.timerId } });
    } catch {
      try {
        await runInstance(this.env, args.instanceId, { runStep: inlineStep, waitFor: null });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ level: "error", message: "wakeTimer inline drive failed", instanceId: args.instanceId, error: reason }));
        try {
          await recordTerminalIncident(this.env, args.instanceId, `Engine drive failed: ${reason}`);
        } catch (incErr) {
          console.error(JSON.stringify({ level: "error", message: "recordTerminalIncident failed", instanceId: args.instanceId, error: incErr instanceof Error ? incErr.message : String(incErr) }));
        }
      }
    }
  }

  async terminate(instanceId: string): Promise<void> {
    try {
      const instance = await this.env.PROCESS_WORKFLOW.get(instanceId);
      await (instance as unknown as { terminate: () => Promise<void> }).terminate();
    } catch {
      /* already terminated / not found — best-effort */
    }
  }
}

class DirectExecutor implements Executor {
  constructor(private env: Env) {}

  private inlineStep = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();

  async start(params: ProcessWorkflowParams): Promise<void> {
    await runInstance(this.env, params.instanceId, { runStep: this.inlineStep, waitFor: null });
  }

  async deliver(args: DeliverArgs): Promise<void> {
    await runInstance(this.env, args.instanceId, {
      runStep: this.inlineStep,
      waitFor: null,
      startAt: args.elementId,
      incomingEvent: args.event,
    });
  }

  async deliverJobResult(args: DeliverJobArgs): Promise<void> {
    // The engine re-reads the (now terminal) job + the saga ledger from D1, so a
    // job-result resume is just "re-run from the parked element". If the instance
    // is mid-compensation, runInstance detects status='compensating' and resumes
    // the reverse pass regardless of startAt. The worker's callback has already
    // persisted the outcome; a resume failure must not surface as a 500 (the
    // at-least-once worker would retry forever), so it is logged, not thrown.
    try {
      await runInstance(this.env, args.instanceId, {
        runStep: this.inlineStep,
        waitFor: null,
        startAt: args.elementId,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ level: "error", message: "deliverJobResult resume failed", instanceId: args.instanceId, error: reason }));
      // Mode parity with the process-workflow catch-all: a direct-mode engine
      // invariant violation must surface as an operator-visible incident, not
      // just a log. recordTerminalIncident is status-guarded (never regresses
      // a terminal instance); its own failure must not escape this catch
      // either (the at-least-once worker would retry forever on a 500).
      try {
        await recordTerminalIncident(this.env, args.instanceId, `Engine drive failed: ${reason}`);
      } catch (incErr) {
        console.error(JSON.stringify({ level: "error", message: "recordTerminalIncident failed", instanceId: args.instanceId, error: incErr instanceof Error ? incErr.message : String(incErr) }));
      }
    }
  }

  async wakeTimer(args: { instanceId: string; workflowEventType: string; timerId: string }): Promise<void> {
    // Direct mode: re-run the rewalk; it re-reads the `timer_outcomes 'fired'`
    // decider committed by fireTimer and routes the token down the boundary path.
    try {
      await runInstance(this.env, args.instanceId, { runStep: this.inlineStep, waitFor: null });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ level: "error", message: "wakeTimer resume failed", instanceId: args.instanceId, error: reason }));
      try {
        await recordTerminalIncident(this.env, args.instanceId, `Engine drive failed: ${reason}`);
      } catch (incErr) {
        console.error(JSON.stringify({ level: "error", message: "recordTerminalIncident failed", instanceId: args.instanceId, error: incErr instanceof Error ? incErr.message : String(incErr) }));
      }
    }
  }

  async terminate(_instanceId: string): Promise<void> {
    // No Workflow in direct mode — the engine is always driven inline.
  }
}

export function getExecutor(env: Env): Executor {
  return env.EXECUTION_MODE === "direct" ? new DirectExecutor(env) : new WorkflowExecutor(env);
}
