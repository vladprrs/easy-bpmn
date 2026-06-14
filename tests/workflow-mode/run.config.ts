// Layer B (workflow-mode) vitest project — NOT part of the default CI `npm test`.
//
// These *.wf.test.ts suites assert ONLY over the public HTTP API against a live
// Worker (BASE_URL, default http://localhost:8787 = `wrangler dev`), driving the
// real ProcessWorkflow (step.do memoization + step.waitForEvent suspend/resume)
// under workerd/miniflare. They run in a plain node environment (fetch only), not
// vitest-pool-workers — so `cloudflare:test` is aliased to a stub (cf-test-stub.ts)
// to let the shared BPMN fixtures import cleanly.
//
// Run with:  npm run test:wf            (BASE_URL defaults to localhost:8787)
//   BASE_URL=https://<name>.workers.dev npm run test:wf   (real-CF DoD gate)
//
// Self-heal / liveness suites need a short backstop — start the dev server with
//   npx wrangler dev --port 8787 --local --var MAX_WAKE_BACKSTOP_OVERRIDE:8000
// before running. See driver.ts for the drive recipes.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./cf-test-stub.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^cloudflare:test$/, replacement: stub }],
  },
  test: {
    include: ["tests/workflow-mode/**/*.wf.test.ts"],
    environment: "node",
    // One live Worker + one shared D1; keep suites serial so accumulating state
    // and the single dev server are not raced across files.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
