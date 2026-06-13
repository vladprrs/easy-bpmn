// Worker environment bindings (wrangler.jsonc).

import type { CorrelationBroker } from "./durable-objects/correlation-broker";
import type { JobScheduler } from "./durable-objects/job-scheduler";
import type { ProcessWorkflowParams } from "./contracts/workflow-events";

export interface Env {
  /** Canonical, queryable store and operator source of record. */
  DB: D1Database;
  /** Strongly-consistent correlation atom, one DO per workspace+message+correlation. */
  CORRELATION_BROKER: DurableObjectNamespace<CorrelationBroker>;
  /** Un-leasable-job DLQ timer, one DO per service_task_job (design §4.2). */
  JOB_SCHEDULER: DurableObjectNamespace<JobScheduler>;
  /** One Workflow instance per process instance (production execution driver). */
  PROCESS_WORKFLOW: Workflow<ProcessWorkflowParams>;
  /** "workflow" (default/prod) or "direct" (deterministic test driver). */
  EXECUTION_MODE: string;
  /**
   * TEST-ONLY cap overrides (M4-L6, design §9). Integration tests lower a
   * concurrency cap via these so a bomb fixture trips it without 256 real branches
   * / 20000 real steps. Never set in production (wrangler.jsonc declares neither).
   */
  MAX_CONCURRENT_TOKENS_OVERRIDE?: string;
  STEP_BUDGET_SOFT_OVERRIDE?: string;
}
