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
  // `errorCode` set ⇒ a BUSINESS error (matches a model bpmn:error/@errorCode);
  // absent ⇒ a technical failure (retryable via re-lease).
  | { status: "failed"; reason: string; diagnostics?: JsonObject; errorCode?: string };

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

  // --- Sample order-saga workers (forward + compensation) ---
  "reserve-stock": (req) => ({
    status: "completed",
    outputVariables: { reservationId: `res-${req.instanceId.slice(-6)}`, reservedQty: req.variables.qty ?? 1 },
  }),
  // Compensation handler for reserve-stock — steerable (mirrors refund-card) so
  // the M5-L2 child-compensator-failure scenario can drive it to retry-exhaustion:
  // `releaseFails: true` → a TECHNICAL failure (no errorCode).
  "release-stock": (req) =>
    req.variables.releaseFails === true
      ? { status: "failed", reason: "release rejected by warehouse", diagnostics: { attempt: req.attempt } }
      : { status: "completed", outputVariables: { released: true } },
  // Steerable: chargeFails → a TECHNICAL failure (no errorCode) so it exhausts
  // retries → Hazard incident inside the transaction (no auto-compensation).
  "charge-card": (req) =>
    req.variables.chargeFails === true
      ? { status: "failed", reason: "card processor unavailable", diagnostics: { attempt: req.attempt } }
      : { status: "completed", outputVariables: { chargeId: `chg-${req.instanceId.slice(-6)}`, amount: req.variables.amount ?? 0 } },
  // Compensation handler for charge-card — steerable so the compensator-failure
  // scenario can drive it to retry-exhaustion.
  "refund-card": (req) =>
    req.variables.refundFails === true
      ? { status: "failed", reason: "refund declined by PSP", diagnostics: { attempt: req.attempt } }
      : { status: "completed", outputVariables: { refunded: true } },
  // Forward step whose business failure cancels the transaction → compensation.
  "confirm-shipping": (req) =>
    req.variables.shippingFails === true
      ? { status: "failed", reason: "carrier rejected the shipment", errorCode: "SHIPPING_REJECTED" }
      : { status: "completed", outputVariables: { shipmentId: `shp-${req.instanceId.slice(-6)}` } },

  // --- M4-L5 parallel-saga workers (PARALLEL_SAGA_BPMN). branch-a/branch-b are the
  // two concurrent compensatable branch tasks (comp-a/comp-b are their handlers).
  // branch-b is steerable: `hazardBranchB` → a TECHNICAL failure (no errorCode) that
  // exhausts retries → a whole-instance Hazard with the sibling frozen (L5.5). The
  // post-join `branch-settle` triggers scope cancel: `failSettle` → a BUSINESS error
  // (errorCode matching the model's bpmn:error) routed to the cancel end →
  // reverse-compensate the completed branch steps across the cohort (L5.2).
  "branch-a": (req) => ({ status: "completed", outputVariables: { aDone: true, aId: `a-${req.instanceId.slice(-6)}` } }),
  "branch-b": (req) =>
    req.variables.hazardBranchB === true
      ? { status: "failed", reason: "branch B technical failure", diagnostics: { attempt: req.attempt } }
      : { status: "completed", outputVariables: { bDone: true } },
  "comp-a": () => ({ status: "completed", outputVariables: { compensatedA: true } }),
  "comp-b": () => ({ status: "completed", outputVariables: { compensatedB: true } }),
  "branch-settle": (req) =>
    req.variables.failSettle === true
      ? { status: "failed", reason: "settle rejected the parallel work", errorCode: "SETTLE_REJECTED" }
      : { status: "completed", outputVariables: { settled: true } },

  // --- M4 inclusiveGateway (OR) branch workers — trivial completers used by the
  // INCLUSIVE_BPMN notification fan-out fixture (send the subset whose conditions hold).
  "send-email": () => ({ status: "completed", outputVariables: { emailed: true } }),
  "send-sms": () => ({ status: "completed", outputVariables: { smsed: true } }),
  "log-only": () => ({ status: "completed", outputVariables: { logged: true } }),

  // --- M5-L2 Task 8 cascading drain/cancel workers (CALL_CHILD_TX_PARK_BPMN /
  // CALL_PARENT_SCOPE_DRAIN_BPMN). `reserve-stock-park` completes so the child's
  // transaction commits before it parks; `release-stock-park` is its compensator
  // (must NEVER run in the Hazard test — that is the assertion). `sibling-task`
  // always raises a caught business error so a scope-drain test has a live
  // sibling branch to bubble from while a parallel callActivity branch is
  // still parked on its own child.
  "reserve-stock-park": () => ({ status: "completed", outputVariables: { reservedForPark: true } }),
  "release-stock-park": () => ({ status: "completed", outputVariables: { releasedForPark: true } }),
  "sibling-task": () => ({ status: "failed", reason: "sibling task failed", errorCode: "SIBLING_FAILED" }),
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
