// Execution driver seam. Production uses Cloudflare Workflows; tests use a
// deterministic in-process driver. Both run the SAME engine (src/runtime/engine.ts).

import type { Env } from "../env";
import type { MessageEventPayload, ProcessWorkflowParams } from "../contracts/workflow-events";
import { runInstance } from "./engine";
import { workflowEventTypeFor } from "../bpmn/profile";

export interface DeliverArgs {
  workflowInstanceId: string;
  instanceId: string;
  elementId: string;
  event: MessageEventPayload;
}

export interface Executor {
  /** Begin executing a freshly created process instance. */
  start(params: ProcessWorkflowParams): Promise<void>;
  /** Deliver a correlated message to a waiting instance. */
  deliver(args: DeliverArgs): Promise<void>;
}

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
}

export function getExecutor(env: Env): Executor {
  return env.EXECUTION_MODE === "direct" ? new DirectExecutor(env) : new WorkflowExecutor(env);
}
