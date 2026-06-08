import type { Env as WorkerEnv } from "../src/env";

// Type the test pool's `env` (Cloudflare.Env) with our bindings + the injected
// parsed migrations binding.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: unknown[];
    }
  }
}

export {};
