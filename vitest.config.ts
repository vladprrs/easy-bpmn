import { configDefaults, defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  // Read the D1 migration SQL at config time so the setup file can apply it into
  // each test's D1 database via `applyD1Migrations`.
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Inject the parsed migrations + force the deterministic in-process
          // execution driver for tests (overrides the wrangler "workflow" var).
          bindings: {
            TEST_MIGRATIONS: migrations,
            EXECUTION_MODE: "direct",
            // M-UI (§8): configure console auth in tests so the session-gated
            // endpoints exercise the real 401/cookie path. Unset in dev ⇒ open
            // console; set here ⇒ the new UI endpoints require a valid cookie.
            UI_USER: "operator",
            UI_PASS: "test-pass",
            UI_SESSION_SECRET: "test-session-secret-please-change",
            UI_DEFAULT_WORKSPACE: "default",
            // Bound the SSE live-tail to ~3s in tests (prod default is 25s) so the
            // stream smoke test never holds the pool open for a full window.
            UI_STREAM_BUDGET_MS: "3000",
          },
          // M4-L6: a local R2 for the branch-overlay offload (design §9.1). Declared
          // here so unit/integration tests get env.OVERLAYS even though the worker
          // also declares it in wrangler.jsonc.
          r2Buckets: ["OVERLAYS"],
        },
      }),
    ],
    test: {
      setupFiles: ["./tests/apply-migrations.ts"],
      // Layer B (workflow-mode) suites are node-runner HTTP tests against a live
      // `wrangler dev` (see tests/workflow-mode/run.config.ts + `npm run test:wf`).
      // They must NOT run under vitest-pool-workers / the default CI `npm test`.
      exclude: [...configDefaults.exclude, "tests/workflow-mode/**"],
    },
  };
});
