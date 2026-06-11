import { describe, expect, it } from "vitest";
import {
  activateJobsRequestSchema,
  activateJobsResponseSchema,
  completeJobRequestSchema,
  failJobRequestSchema,
  leasedJobSchema,
} from "../../src/contracts/api";

// TASK-29 pin (M2 design §9): the worker-facing /jobs/* request/response schemas
// are UNCHANGED by the conditional-saga migration. The occurrence discriminator
// and output_applied marker are persistence-internal — a deployed M1 pull worker
// keeps working against an M2 orchestrator with zero changes. If a later task
// needs to widen these schemas, this pin must be amended DELIBERATELY (it is the
// compatibility contract, not a snapshot of convenience).

const M1_SHAPES: Record<string, { schema: { shape: Record<string, unknown> }; keys: string[] }> = {
  "POST /jobs/activate request": {
    schema: activateJobsRequestSchema,
    keys: ["taskType", "workerId", "maxJobs", "leaseMs", "waitMs"],
  },
  "leased job (activate response item)": {
    schema: leasedJobSchema,
    keys: [
      "jobId",
      "instanceId",
      "elementId",
      "taskType",
      "isCompensation",
      "attempt",
      "lockToken",
      "traceId",
      "variables",
      "originalInput",
      "capturedOutput",
    ],
  },
  "POST /jobs/{id}/complete request": {
    schema: completeJobRequestSchema,
    keys: ["lockToken", "outputVariables"],
  },
  "POST /jobs/{id}/fail request": {
    schema: failJobRequestSchema,
    keys: ["lockToken", "reason", "errorCode", "retryable"],
  },
};

describe("worker-facing /jobs/* schemas are pinned to the M1 shape", () => {
  for (const [name, { schema, keys }] of Object.entries(M1_SHAPES)) {
    it(`${name} carries exactly the M1 fields`, () => {
      expect(Object.keys(schema.shape).sort()).toEqual([...keys].sort());
    });
  }

  it("the leased job never surfaces the occurrence/output_applied internals", () => {
    const keys = Object.keys(leasedJobSchema.shape);
    expect(keys).not.toContain("occurrence");
    expect(keys).not.toContain("outputApplied");
  });

  it("an M1 worker payload round-trips through every schema", () => {
    expect(
      activateJobsRequestSchema.safeParse({ taskType: "reserve-stock", workerId: "w1", maxJobs: 5, leaseMs: 30000, waitMs: 0 }).success,
    ).toBe(true);
    expect(
      activateJobsResponseSchema.safeParse({
        jobs: [
          {
            jobId: "job_1",
            instanceId: "pi_1",
            elementId: "reserveStock",
            taskType: "reserve-stock",
            isCompensation: false,
            attempt: 1,
            lockToken: "lt_1",
            traceId: "tr_1",
            variables: { sku: "A" },
          },
        ],
      }).success,
    ).toBe(true);
    expect(completeJobRequestSchema.safeParse({ lockToken: "lt_1", outputVariables: { ok: true } }).success).toBe(true);
    expect(failJobRequestSchema.safeParse({ lockToken: "lt_1", reason: "boom", retryable: true }).success).toBe(true);
  });
});
