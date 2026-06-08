// Execution driver seam. Production uses Cloudflare Workflows; tests use a
// deterministic in-process driver. Both run the SAME engine (src/runtime/engine.ts).

import type { Env } from "../env";
import type { JobResultEvent, MessageEventPayload, ProcessWorkflowParams } from "../contracts/workflow-events";
import { runInstance } from "./engine";
import { workflowEventTypeFor, workflowJobEventTypeFor } from "../bpmn/profile";

export interface DeliverArgs {
  workflowInstanceId: string;
  instanceId: string;
  elementId: string;
  event: MessageEventPayload;
}

export interface DeliverJobArgs {
  workflowInstanceId: string;
  instanceId: string;
  elementId: string;
  event: JobResultEvent;
}

export interface Executor {
  /** Begin executing a freshly created process instance. */
  start(params: ProcessWorkflowParams): Promise<void>;
  /** Deliver a correlated message to a waiting instance. */
  deliver(args: DeliverArgs): Promise<void>;
  /** Deliver a pull-worker job result to a Service-Task-as-wait instance. */
  deliverJobResult(args: DeliverJobArgs): Promise<void>;
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
    await instance.sendEvent({
      type: workflowEventTypeFor(args.event.messageName),
      payload: args.event,
    });
  }

  async deliverJobResult(args: DeliverJobArgs): Promise<void> {
    try {
      const instance = await this.env.PROCESS_WORKFLOW.get(args.workflowInstanceId);
      await instance.sendEvent({
        type: workflowJobEventTypeFor(args.event.jobId),
        payload: args.event,
      });
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
        console.error(JSON.stringify({ level: "error", message: "deliverJobResult inline drive failed", instanceId: args.instanceId, error: err instanceof Error ? err.message : String(err) }));
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
      console.error(JSON.stringify({ level: "error", message: "deliverJobResult resume failed", instanceId: args.instanceId, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  async terminate(_instanceId: string): Promise<void> {
    // No Workflow in direct mode — the engine is always driven inline.
  }
}

export function getExecutor(env: Env): Executor {
  return env.EXECUTION_MODE === "direct" ? new DirectExecutor(env) : new WorkflowExecutor(env);
}
