#!/usr/bin/env node
// E2E combination-matrix drift-guard (sibling of scripts/check-docs.mjs).
//
// Runs in Node (not the workers runtime) so it can read test files off disk.
// Fails CI when the registry and the tests drift apart:
//   1. Every registered scenario, for each mode it declares AT OR BELOW the
//      active phase, has a `[<id>]` marker in its declared test file.
//   2. Every must-cover construct tag appears in >=1 registry row.
//   3. >=11 reject (R-*) scenarios are registered.
// Workflow-mode gaps ABOVE the active phase are WARNINGS (Phases 2-3 flip them
// to failures by raising MATRIX_PHASE).
//
// MATRIX_PHASE (env, default 3) = the highest phase whose coverage is enforced.
// Phases 1-3 are all SHIPPED (Layer A direct + Layer B workflow-mode markers all
// present), so the gate is raised to 3: a new construct must land with markers in
// every declared mode/file or CI fails. (The Layer B *.wf.test.ts suites run via
// `npm run test:wf` against a live Worker, NOT the default CI `npm test`; this
// guard is a static marker check, so enforcing phase 3 in CI is safe.)

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const ACTIVE_PHASE = Number(process.env.MATRIX_PHASE ?? "3");
const registryText = readFileSync(join(repoRoot, "tests/matrix/registry.ts"), "utf8");

// Parse the one-object-per-line registry rows.
const rows = [];
for (const line of registryText.split("\n")) {
  const idM = line.match(/^\s*\{\s*id:\s*"([^"]+)"/);
  if (!idM) continue;
  rows.push({
    id: idM[1],
    modes: (line.match(/modes:\s*\[([^\]]*)\]/)?.[1] ?? "")
      .split(",").map((s) => s.replace(/["\s]/g, "")).filter(Boolean),
    phase: Number(line.match(/phase:\s*(\d)/)?.[1] ?? "1"),
    directFile: line.match(/directFile:\s*"([^"]*)"/)?.[1] ?? "",
    workflowFile: line.match(/workflowFile:\s*"([^"]*)"/)?.[1] ?? "",
  });
}

const failures = [];
const warnings = [];

const fileHasMarker = (file, id) =>
  file && existsSync(join(repoRoot, file)) &&
  readFileSync(join(repoRoot, file), "utf8").includes(`[${id}]`);

function checkMode(r, mode, file) {
  if (!r.modes.includes(mode)) return;
  // Workflow-mode (Layer B) coverage always lands at least one phase after the
  // direct-mode (Layer A) half of the same scenario: a `phase:1` C-* scenario
  // proves its semantics in direct mode at Phase 1, but its suspend/resume
  // re-run is Phase 2/3 work. So a missing workflow marker is never a Phase-1
  // failure — it is a deferred-phase warning until MATRIX_PHASE is raised.
  const effectivePhase = mode === "workflow" ? Math.max(r.phase, 2) : r.phase;
  const bucket = effectivePhase <= ACTIVE_PHASE ? failures : warnings;
  if (!file) { bucket.push(`${r.id}: declares '${mode}' but has no ${mode}File`); return; }
  if (!fileHasMarker(file, r.id)) {
    bucket.push(`${r.id}: no "[${r.id}]" marker found in ${file} (${mode} mode, phase ${r.phase})`);
  }
}

for (const r of rows) {
  checkMode(r, "direct", r.directFile);
  checkMode(r, "workflow", r.workflowFile);
}

// 2) Construct coverage: each tag must appear somewhere in the registry text.
const MUST_COVER = [
  "exclusiveGateway", "parallelGateway", "inclusiveGateway", "eventBasedGateway",
  "boundaryTimer", "intermediateTimer", "messageCatch", "serviceTask", "receiveTask",
  "transaction", "Compensation", "straggler", "quiescence", "noPath", "loopLimit",
  "jobActivationTimeout", "concurrencyLimit", "stepBudget", "poison",
  "Idempotency", "Operator",
];
for (const tag of MUST_COVER) {
  if (!new RegExp(tag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i").test(registryText)) {
    failures.push(`construct tag "${tag}" is referenced by no scenario in tests/matrix/registry.ts`);
  }
}

// 3) Reject-rule coverage.
const rejectCount = rows.filter((r) => r.id.startsWith("R-")).length;
if (rejectCount < 11) failures.push(`only ${rejectCount} reject (R-*) scenarios registered; expected >= 11`);

if (rows.length !== 86) warnings.push(`registry has ${rows.length} scenarios (expected 86)`);

for (const w of warnings) console.warn("  (warn) " + w);
if (failures.length > 0) {
  console.error(`Matrix drift-check FAILED (MATRIX_PHASE=${ACTIVE_PHASE}):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(
  `Matrix drift-check passed: ${rows.length} scenarios, ${rejectCount} rejects, ` +
  `all phase<=${ACTIVE_PHASE} markers present (${warnings.length} deferred-phase warnings).`,
);
