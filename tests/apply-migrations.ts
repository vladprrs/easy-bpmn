// Applies the D1 schema into each test's isolated database before tests run.
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(
  env.DB,
  env.TEST_MIGRATIONS as Parameters<typeof applyD1Migrations>[1],
);
