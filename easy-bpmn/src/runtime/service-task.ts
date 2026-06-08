// Product-provided sample Service Task workers. Custom worker registration is
// out of MVP scope, but these run through the SAME job/attempt/retry/idempotency/
// history model future workers will use. Workers are dispatched by `taskType`
// (the easy-bpmn:taskDefinition type), never by element id/name.

import type { JsonObject } from "../util";

export interface WorkerRequest {
  jobId: string;
  instanceId: string;
  definitionVersionId: string;
  taskType: string;
  elementId: string;
  attempt: number;
  variables: JsonObject;
}

export type WorkerResult =
  | { status: "completed"; outputVariables: JsonObject }
  | { status: "failed"; reason: string; diagnostics?: JsonObject };

type SampleWorker = (req: WorkerRequest) => Promise<WorkerResult> | WorkerResult;

/**
 * Sample workers keyed by taskType. Behavior is steerable through variables so
 * the demo, retry, and incident scenarios are deterministic:
 *   - `forceFail: true`            → always fails (drives retry → incident).
 *   - `failUntilAttempt: N`        → fails while attempt < N, then succeeds.
 */
const SAMPLE_WORKERS: Record<string, SampleWorker> = {
  "external-check": (req) => {
    const v = req.variables;
    if (v.forceFail === true) {
      return { status: "failed", reason: "sample worker forced failure", diagnostics: { attempt: req.attempt } };
    }
    if (typeof v.failUntilAttempt === "number" && req.attempt < v.failUntilAttempt) {
      return {
        status: "failed",
        reason: `sample worker failing until attempt ${v.failUntilAttempt}`,
        diagnostics: { attempt: req.attempt },
      };
    }
    return {
      status: "completed",
      outputVariables: { checkStatus: "approved", checkedAmount: v.amount ?? null },
    };
  },
  "always-fail": (req) => ({
    status: "failed",
    reason: "always-fail sample worker",
    diagnostics: { attempt: req.attempt },
  }),
  echo: (req) => ({ status: "completed", outputVariables: { echoed: req.variables } }),
};

export function hasSampleWorker(taskType: string): boolean {
  return Object.prototype.hasOwnProperty.call(SAMPLE_WORKERS, taskType);
}

export async function invokeSampleWorker(req: WorkerRequest): Promise<WorkerResult> {
  const worker = SAMPLE_WORKERS[req.taskType];
  if (!worker) {
    return {
      status: "failed",
      reason: `No sample worker is registered for taskType '${req.taskType}'.`,
      diagnostics: { taskType: req.taskType },
    };
  }
  return worker(req);
}
