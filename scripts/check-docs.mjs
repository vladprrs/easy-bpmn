#!/usr/bin/env node
// Docs-consistency guard (M0, TASK-10).
//
// Runs in Node (NOT the @cloudflare/vitest-pool-workers runtime, which has no
// filesystem) so it can read docs/ off disk. Wired into CI and `npm run check:docs`.
//
// It enforces two things about the normative BPMN reference under docs/bpmn/:
//   1. No stale "Durable Object per instance" / "DO per instance" architecture
//      claim survives (the real mapping is one Workflow per instance + a single
//      DO correlation broker).
//   2. The canonical-saga profile (09-easy-bpmn-profile.md) names every M1 saga
//      construct AND embeds the canonical order-saga example that the validator's
//      accept/round-trip test consumes — so the doc and that constitution-critical
//      test cannot drift.
//
// Scope note: the stale-phrase check targets docs/bpmn/ (the normative reference).
// The design artifacts under docs/superpowers/specs/ intentionally *quote* the old
// phrase as the instruction to remove it / as historical drift, so they are out of
// scope for this guard.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const bpmnDir = join(repoRoot, "docs", "bpmn");
const profile = join(bpmnDir, "09-easy-bpmn-profile.md");

const failures = [];

// 1) No stale "Durable Object per instance" phrasing under docs/bpmn/.
const stale = /\bDurable Object per instance\b|\bDO per instance\b/i;
for (const file of readdirSync(bpmnDir).filter((f) => f.endsWith(".md"))) {
  const path = join(bpmnDir, file);
  const text = readFileSync(path, "utf8");
  text.split("\n").forEach((line, i) => {
    if (stale.test(line)) {
      failures.push(`${file}:${i + 1} contains stale architecture phrasing: "${line.trim()}"`);
    }
  });
}

// 2) The profile doc names every M1 saga construct.
const profileText = readFileSync(profile, "utf8");
const requiredConstructs = [
  "bpmn:transaction",
  "compensateEventDefinition",
  "errorEventDefinition",
  "cancelEventDefinition",
  'isForCompensation="true"',
  "bpmn:association",
  "bpmn:error",
];
for (const needle of requiredConstructs) {
  if (!profileText.includes(needle)) {
    failures.push(`09-easy-bpmn-profile.md is missing required saga construct: ${needle}`);
  }
}

// 3) The profile embeds the canonical order-saga example consumed by the validator test.
for (const marker of [`id="OrderSaga"`, `id="reserveStock"`, `easy-bpmn:taskDefinition`, `errorRef="Err_shipping"`]) {
  if (!profileText.includes(marker)) {
    failures.push(`09-easy-bpmn-profile.md is missing the canonical order-saga example marker: ${marker}`);
  }
}

// 4) The profile states the correct Cloudflare mapping.
if (!/Cloudflare Workflow per process instance/i.test(profileText)) {
  failures.push(`09-easy-bpmn-profile.md must state the "one Cloudflare Workflow per process instance" mapping.`);
}

if (failures.length > 0) {
  console.error("Docs-consistency check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("Docs-consistency check passed: docs/bpmn/ free of stale DO-per-instance phrasing; canonical-saga profile complete.");
