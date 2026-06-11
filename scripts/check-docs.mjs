#!/usr/bin/env node
// Docs-consistency guard (M0, TASK-10; extended for M2, TASK-37 review).
//
// Runs in Node (NOT the @cloudflare/vitest-pool-workers runtime, which has no
// filesystem) so it can read docs/ off disk. Wired into CI and `npm run check:docs`.
//
// It enforces:
//   1. No stale architecture/scope phrasing survives under docs/bpmn/ (the
//      normative reference): no "Durable Object per instance" claim (the real
//      mapping is one Workflow per instance + a single DO correlation broker),
//      and no pre-M1/M2 scope claims ("no gateways", "no conditions", "no
//      expression language", "none are in the MVP", …). Lines are matched with
//      Markdown emphasis (* _ `) stripped and the whole file whitespace-collapsed,
//      so bold markers or a line wrap inside a phrase cannot smuggle it past the
//      guard (that bypass was real: "**Durable Object** per instance").
//   2. The canonical-saga profile (09-easy-bpmn-profile.md) names every M1 saga
//      construct AND embeds the canonical order-saga example that the validator's
//      accept/round-trip test consumes — so the doc and that constitution-critical
//      test cannot drift.
//   3. The gateway reference (03-gateways.md) names the M2 constructs/incidents
//      and keeps the deferred-gateway milestone pointers (M3/M4).
//   4. Every literal "MAX_ELEMENT_OCCURRENCES = <n>" under docs/bpmn/ and
//      specs/002-saga-orchestrator/ matches the engine constant in
//      src/runtime/engine.ts (the value is repeated in ~5 docs and would rot
//      silently if M3 retunes it).
//   5. The incident-kind taxonomy is single-sourced (M3-L1, TASK-39): the
//      `IncidentKind` union in src/persistence/instances.ts and the
//      `Incident.kind` enum in contracts/openapi.yaml are the SAME SET — a new
//      kind can't be persisted without being documented, nor vice versa.
//
// Scope note: the negative-phrase checks target docs/bpmn/ ONLY. The design
// artifacts under docs/superpowers/specs/ intentionally *quote* stale phrasing
// as history / as the instruction to remove it, so they stay out of scope.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const bpmnDir = join(repoRoot, "docs", "bpmn");
const sagaSpecDir = join(repoRoot, "specs", "002-saga-orchestrator");
const profile = join(bpmnDir, "09-easy-bpmn-profile.md");
const gateways = join(bpmnDir, "03-gateways.md");
const engineSrc = join(repoRoot, "src", "runtime", "engine.ts");

const failures = [];

/** Strip Markdown emphasis markers so `**bold**` / `_em_` / `` `code` `` can't break a phrase match. */
const stripEmphasis = (s) => s.replace(/[*_`]/g, "");

/**
 * Emphasis-stripping variant for lines carrying code identifiers: keeps `_`
 * (stripping it would mangle `MAX_ELEMENT_OCCURRENCES` itself).
 */
const stripEmphasisKeepUnderscore = (s) => s.replace(/[*`]/g, "");

/**
 * Normalize a file for phrase matching: emphasis stripped, all whitespace
 * (including newlines) collapsed to single spaces — with an offset→line map so
 * failures still report a line number even when a phrase wraps across lines.
 */
function normalizeWithLineMap(text) {
  const lines = text.split("\n");
  let norm = "";
  const lineStarts = [];
  for (const line of lines) {
    lineStarts.push(norm.length);
    norm += stripEmphasis(line).replace(/\s+/g, " ").trim() + " ";
  }
  return { norm, lineStarts };
}

function lineAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Recursively collect .md files under a directory. */
function mdFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mdFiles(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

// 1) No stale architecture/scope phrasing under docs/bpmn/ (emphasis- and wrap-proof).
const stalePatterns = [
  [/\bDurable Object per instance\b|\bDO per instance\b/i, "stale architecture phrasing (real mapping: one Workflow per instance + a single DO correlation broker)"],
  [/Gateways are entirely out of scope/i, "stale pre-M2 scope claim (exclusiveGateway is IN since M2)"],
  [/no branching \(no gateways\)/i, "stale pre-M2 scope claim (XOR branching is IN since M2)"],
  [/plain, no conditions/i, "stale pre-M2 scope claim (FEEL conditions on XOR-gateway flows are IN since M2)"],
  [/no expression language is required yet/i, "stale pre-M2 scope claim (FEEL via feelin is IN since M2)"],
  [/none are in the MVP/i, "stale pre-M1 scope claim (error/compensation/transaction are IN since M1)"],
  // 01-events.md scope section (fixed M3-L2, TASK-41): the pre-M1 events-scope
  // claims were already false for the shipped saga set and now also for the
  // M3-accepted set. Match the OLD sentences precisely so reintroducing them fails.
  [/In scope: None Start Event and None End Event only/i, "stale pre-M1 events-scope claim in 01-events (compensation/error/cancel boundary events are IN since M1; M3 timer/message intermediate catch + boundary timers + eventBasedGateway are accepted in constitution v2.2.0, opened per validator layer)"],
  [/all intermediate events, all boundary events, and terminate/i, "stale pre-M1 events-scope claim in 01-events (boundary events are IN since M1; M3 adds timer/message intermediate catch + boundary timers + eventBasedGateway, accepted in v2.2.0)"],
];
for (const file of readdirSync(bpmnDir).filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(join(bpmnDir, file), "utf8");
  const { norm, lineStarts } = normalizeWithLineMap(text);
  for (const [pattern, reason] of stalePatterns) {
    const match = norm.match(pattern);
    if (match) {
      failures.push(`${file}:${lineAt(lineStarts, match.index)} contains ${reason}: "${match[0]}"`);
    }
  }
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

// 5) The gateway reference names the M2 constructs/incidents and keeps the
//    deferred-gateway milestone pointers (emphasis-stripped, same-line).
const gatewaysText = readFileSync(gateways, "utf8");
for (const needle of ["exclusiveGateway", "noPath", "loopLimit"]) {
  if (!gatewaysText.includes(needle)) {
    failures.push(`03-gateways.md is missing the M2 construct/incident marker: ${needle}`);
  }
}
const gatewayLines = gatewaysText.split("\n").map(stripEmphasis);
for (const [gateway, milestone] of [
  ["parallelGateway", "M4"],
  ["inclusiveGateway", "M4"],
  ["eventBasedGateway", "M3"],
]) {
  const pointer = gatewayLines.some(
    (l) => l.includes(gateway) && new RegExp(`\\b${milestone}\\b`).test(l),
  );
  if (!pointer) {
    failures.push(`03-gateways.md must point ${gateway} at its roadmap milestone (${milestone}) on the same line.`);
  }
}

// 6) Every literal "MAX_ELEMENT_OCCURRENCES = <n>" under docs/bpmn/ and
//    specs/002-saga-orchestrator/ matches the engine constant.
const engineText = readFileSync(engineSrc, "utf8");
const engineMatch = engineText.match(/MAX_ELEMENT_OCCURRENCES = (\d+)/);
if (!engineMatch) {
  failures.push(`src/runtime/engine.ts no longer defines "MAX_ELEMENT_OCCURRENCES = <n>" — update this check.`);
} else {
  const engineValue = engineMatch[1];
  for (const path of [...mdFiles(bpmnDir), ...mdFiles(sagaSpecDir)]) {
    const text = readFileSync(path, "utf8");
    const rel = path.slice(repoRoot.length);
    text.split("\n").forEach((line, i) => {
      for (const m of stripEmphasisKeepUnderscore(line).matchAll(/MAX_ELEMENT_OCCURRENCES = (\d+)/g)) {
        if (m[1] !== engineValue) {
          failures.push(`${rel}:${i + 1} says MAX_ELEMENT_OCCURRENCES = ${m[1]} but src/runtime/engine.ts says ${engineValue}.`);
        }
      }
    });
  }
}

// 7) Incident-kind taxonomy single-source: IncidentKind union == openapi enum set.
const incidentSrc = readFileSync(join(repoRoot, "src", "persistence", "instances.ts"), "utf8");
const openapiSrc = readFileSync(join(sagaSpecDir, "contracts", "openapi.yaml"), "utf8");
const unionMatch = incidentSrc.match(/export type IncidentKind =([\s\S]*?);/);
const kindEnumMatch = openapiSrc.match(/enum:\s*\[([^\]]*serviceTaskFailure[^\]]*)\]/);
if (!unionMatch) {
  failures.push(`src/persistence/instances.ts no longer defines "export type IncidentKind = …;" — update this check.`);
} else if (!kindEnumMatch) {
  failures.push(`openapi.yaml no longer has the Incident.kind enum (containing serviceTaskFailure) — update this check.`);
} else {
  // Only union-member lines count — strip `//` comments first so a future
  // `// see "foo"` inside the union can't be misread as an incident kind.
  const unionKinds = new Set(
    unionMatch[1]
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").match(/^\s*\|?\s*"(\w+)"/))
      .filter((m) => m)
      .map((m) => m[1]),
  );
  const enumKinds = new Set(kindEnumMatch[1].split(",").map((s) => s.trim()).filter(Boolean));
  for (const k of unionKinds) {
    if (!enumKinds.has(k)) failures.push(`openapi.yaml Incident.kind enum is missing IncidentKind member "${k}".`);
  }
  for (const k of enumKinds) {
    if (!unionKinds.has(k)) failures.push(`src/persistence/instances.ts IncidentKind union is missing openapi enum member "${k}".`);
  }
}

if (failures.length > 0) {
  console.error("Docs-consistency check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(
  "Docs-consistency check passed: docs/bpmn/ free of stale architecture/scope phrasing; " +
    "canonical-saga profile and gateway reference complete; MAX_ELEMENT_OCCURRENCES consistent with the engine.",
);
