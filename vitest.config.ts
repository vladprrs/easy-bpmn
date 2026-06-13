import { defineConfig } from "vitest/config";
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
    },
  };
});
