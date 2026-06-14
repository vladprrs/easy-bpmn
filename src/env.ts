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
  /** Overflow store for branch variable overlays exceeding OVERLAY_INLINE_MAX_BYTES (M4-L6, design §9.1). */
  OVERLAYS: R2Bucket;
  /** "workflow" (default/prod) or "direct" (deterministic test driver). */
  EXECUTION_MODE: string;

  // --- M-UI / Operator Console (design §8) — all OPTIONAL so the Worker boots
  // without UI secrets in dev/test. When UI_SESSION_SECRET is unset the session
  // guard is a no-op pass-through (console disabled, existing API contract intact).
  /** Operator login name checked by POST /ui/login. */
  UI_USER?: string;
  /** Operator login password checked by POST /ui/login (Worker secret in prod). */
  UI_PASS?: string;
  /** HMAC key for the signed session cookie (Worker secret in prod). */
  UI_SESSION_SECRET?: string;
  /** Default workspace surfaced to the SPA on boot (GET /ui/me). */
  UI_DEFAULT_WORKSPACE?: string;
  /**
   * SSE live-tail connection budget in ms (design §11; default 25 000). Overridable
   * so integration tests bound the stream to a few seconds instead of 25 s.
   */
  UI_STREAM_BUDGET_MS?: string;
  /**
   * Static-assets binding (the built SPA, design §7). Serving is assets-first +
   * run_worker_first; the Worker does not call this directly, but wrangler exposes
   * it, so it is declared for type-completeness.
   */
  ASSETS?: Fetcher;
  /**
   * TEST-ONLY cap overrides (M4-L6, design §9). Integration tests lower a
   * concurrency cap via these so a bomb fixture trips it without 256 real branches
   * / 20000 real steps. Never set in production (wrangler.jsonc declares neither).
   */
  MAX_CONCURRENT_TOKENS_OVERRIDE?: string;
  STEP_BUDGET_SOFT_OVERRIDE?: string;
}
