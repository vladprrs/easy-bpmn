// One Cloudflare Workflow instance per BPMN process instance (production driver).
//
// The Workflow is a thin durable driver over the shared engine: `step.do`
// memoizes each side-effecting primitive (replay-safe) and `step.waitForEvent`
// implements the Receive Task wait. All persistence + invariants live in the
// engine; D1 — never Workflow state — is the inspection source of record.

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env";
import type { MessageEventPayload, ProcessWorkflowParams } from "../contracts/workflow-events";
import { messageEventPayloadSchema } from "../contracts/workflow-events";
import { recordTerminalIncident, runInstance } from "../runtime/engine";

export class ProcessWorkflow extends WorkflowEntrypoint<Env, ProcessWorkflowParams> {
  override async run(event: WorkflowEvent<ProcessWorkflowParams>, step: WorkflowStep): Promise<void> {
    const { instanceId } = event.payload;

    // step.do / step.waitForEvent constrain types to Rpc.Serializable; our engine
    // results are plain JSON, so we bridge the generics through `any`.
    const stepDo = step.do as unknown as <T>(name: string, fn: () => Promise<T>) => Promise<T>;
    const runStep = <T>(name: string, fn: () => Promise<T>): Promise<T> => stepDo(name, fn);

    const waitForEvent = step.waitForEvent as unknown as (
      name: string,
      opts: { type: string; timeout: string },
    ) => Promise<{ payload: unknown }>;

    const waitFor = async (sub: {
      elementId: string;
      workflowEventType: string;
      subscriptionId: string;
    }): Promise<MessageEventPayload> => {
      const received = await waitForEvent(`wait:${sub.elementId}`, {
        type: sub.workflowEventType,
        timeout: "1 hour",
      });
      return messageEventPayloadSchema.parse(received.payload);
    };

    try {
      await runInstance(this.env, instanceId, { runStep, waitFor });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A timed-out Receive Task wait (or other terminal failure) becomes a
      // view-only incident rather than an opaque errored Workflow.
      await step.do("terminal-incident", async () => {
        await recordTerminalIncident(this.env, instanceId, `Workflow terminated: ${reason}`);
      });
    }
  }
}
