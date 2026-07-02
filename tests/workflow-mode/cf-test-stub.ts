// Stub for the `cloudflare:test` module so the node-runner (Layer B / workflow
// mode) can import the BPMN fixture constants out of tests/helpers.ts and
// tests/fixtures/matrix/fixtures.ts WITHOUT pulling in vitest-pool-workers.
//
// Layer B asserts only over the public HTTP API against a live `wrangler dev`
// (BASE_URL) — it never touches the SELF binding or `env`. These exports exist
// purely so the fixture modules' top-level `import { SELF, env } from
// "cloudflare:test"` resolves; any actual use throws (a Layer-B test that reaches
// for SELF/env is a bug — drive over HTTP instead). run.config.ts aliases
// `cloudflare:test` to this file.

const unavailable = (name: string) =>
  new Proxy(
    {},
    {
      get() {
        throw new Error(
          `cloudflare:test '${name}' is unavailable in workflow-mode (Layer B); drive over the HTTP API via driver.ts instead.`,
        );
      },
    },
  );

export const SELF = unavailable("SELF") as unknown as { fetch: typeof fetch };
export const env = unavailable("env") as unknown as Record<string, unknown>;
