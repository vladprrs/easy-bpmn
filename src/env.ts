// Worker environment bindings (wrangler.jsonc).

import type { CorrelationBroker } from "./durable-objects/correlation-broker";
import type { ProcessWorkflowParams } from "./contracts/workflow-events";

export interface Env {
  /** Canonical, queryable store and operator source of record. */
  DB: D1Database;
  /** Strongly-consistent correlation atom, one DO per workspace+message+correlation. */
  CORRELATION_BROKER: DurableObjectNamespace<CorrelationBroker>;
  /** One Workflow instance per process instance (production execution driver). */
  PROCESS_WORKFLOW: Workflow<ProcessWorkflowParams>;
  /** "workflow" (default/prod) or "direct" (deterministic test driver). */
  EXECUTION_MODE: string;
}
