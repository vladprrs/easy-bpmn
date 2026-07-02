# M5-L2 callActivity (Reusable Sub-Saga) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement M5-L2 per `docs/superpowers/specs/2026-07-02-m5-l2-callactivity-design.md` — `bpmn:callActivity` as a real child instance with its own Cloudflare Workflow: publish-time version binding, the child-idempotency triad, child→parent wake with a DO-alarm self-heal, child error propagation, cascading drain/cancel, compensation of a committed callActivity by driving the child's own reverse pass, cascading operator verbs, and the lineage console delta.

**Architecture:** A `callActivity` leaf in the parent graph invokes a full `process_instances` row + Workflow for the child (deterministic content-addressed id). A `child_instances` provenance row — written in the same persist-before-advance batch that decides to invoke — is the rewalk fast-forward predicate gating both `create()` and the output apply. The child's terminal drive tickles the parent via the existing `deliverJobResult` seam (WAKE_TYPE tickle + terminated-Workflow inline fallback), guarded by a `JobScheduler` child-notify alarm. Compensation dispatches on `saga_steps.child_instance_id`: non-NULL → CAS the child `{completed,cancelled} → compensating` and drive its own reverse pass inline.

**Tech Stack:** Cloudflare Workers (TypeScript), D1, Durable Objects (`JobScheduler`, `CorrelationBroker`), Cloudflare Workflows, bpmn-moddle, Vitest + `@cloudflare/vitest-pool-workers` (direct mode), `wrangler dev` for workflow mode.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-02-m5-l2-callactivity-design.md` ("spec §N" below). Where this plan is more detailed, the plan wins.
- **Prerequisite gate (spec §0):** TASK-71, TASK-72, TASK-73 must be merged to `main` before Task 4 (the first runtime task) starts. Task 1 verifies this and hard-stops if not.
- Governance: constitution v2.5.0 already accepts callActivity; this layer only OPENS the runtime. No constitution version bump — a per-layer Constitution Check doc + the `docs/bpmn/09` interim-marker flip (M5-L1 precedent).
- `MAX_CALL_DEPTH = 4`, defined in `src/runtime/engine.ts`, enforced at **publish** (call-tree resolution), synced by `scripts/check-docs.mjs`.
- New instance status: `errored` (child-only terminal, carries `process_instances.error_code`). It joins `TERMINAL_INSTANCE_STATUSES`; it is NEVER a valid status for a root instance.
- Parent-consumable child terminals: `completed | errored` (forward) and `compensated | compensationFailed` (reverse). `incident` on a child does NOT notify the parent (spec §4).
- Child `correlation_key` = `child:<childInstanceId>` — a technical value that must never reach the broker (guaranteed by the v1 publish reject of message waits in the call tree).
- v1 publish rejects (spec §7): unresolved `calledElement`; same-document non-process `calledElement` (GlobalTask); call-tree depth > `MAX_CALL_DEPTH`; defensive call-cycle; any `receiveTask` / message `intermediateCatchEvent` anywhere in the resolved call tree. Every reject carries element id + reason.
- `camunda:calledElementBinding` / `camunda:calledElementVersion` are tolerated-and-ignored (foreign-namespace attributes already pass the tolerance rules; add an explicit test).
- **Workflow-step memoization discipline:** a `runStep` body's result is memoized by NAME for the Workflow's lifetime. NEVER issue a step whose result encodes "not ready yet" — gate every step issuance on a D1 predicate read OUTSIDE any step (the `svc-apply`/`svc-create` pattern in `forward-task.ts:206-233`).
- Backward compatibility: all existing M1–M5-L1 tests MUST pass without edits (the no-op gate). Graphs without callActivity nodes take zero new code paths.
- All CI tests run direct mode (`EXECUTION_MODE=direct`). Finish every task with `npm run typecheck` (vitest does not typecheck). Full check per task: `npm run test:unit && npm run test:integration && npm run typecheck`.
- Commit style: `feat(m5-l2): …` / `fix(m5-l2): …` / `test(m5-l2): …` / `docs(m5-l2): …`.
- Code and docs are English. No custom `bpmn:`-namespace notation.
- File anchors (`file.ts:NNN`) are from `main` @ `20280d3`; TASK-71..73 will shift some — re-locate by content when drifted.

---

### Task 1: Prerequisite gate, branch setup, governance opening

**Files:**
- Create: `specs/002-saga-orchestrator/m5-L2-constitution-check.md`
- Modify: `docs/bpmn/09-easy-bpmn-profile.md` (interim marker flip only)

**Interfaces:**
- Consumes: constitution v2.5.0 M5 amendment; the M5-L2 design spec.
- Produces: the branch `m5-l2-call-activity` and the recorded per-layer Constitution Check every later task cites.

- [ ] **Step 1: Verify the prerequisite follow-ups are merged**

```bash
cd /home/coder/project && git checkout main && git pull
grep -l "status: Done" backlog/tasks/task-71* backlog/tasks/task-72* backlog/tasks/task-73* | wc -l
```

Expected: `3`. **If not 3, STOP** — report to the user that TASK-71..73 (the M5-L1 follow-up branch, spec §0) must land first. Do not proceed.

- [ ] **Step 2: Cut the work branch**

```bash
git checkout -b m5-l2-call-activity
```

- [ ] **Step 3: Write the per-layer Constitution Check**

Create `specs/002-saga-orchestrator/m5-L2-constitution-check.md` mirroring the structure of `specs/002-saga-orchestrator/m5-L1-constitution-check.md` (read it first). Content: a table walking Principles I–VI against the M5-L2 scope, citing the already-recorded v2.5.0 clauses — Principle II publish-time `calledElement` binding (constitution "callActivity's calledElement MUST resolve at the calling definition's own publish time"), Principle III provenance-gated child create/apply, Principle VI child compensation = the child's own reverse pass + `compensationFailed` surfacing. Record the two interim v1 narrowings as deliberate scope entries (not deviations): the message-wait call-tree reject (spec §7) and the direct-child-operator-verb 409 (spec §6). No Complexity Tracking entries are expected.

- [ ] **Step 4: Flip the `docs/bpmn/09` interim marker for callActivity only**

In `docs/bpmn/09-easy-bpmn-profile.md`, find the M5 interim-reject table/list (search `callActivity`). Move `callActivity` from "interim-rejected (runtime opens M5-L2)" to "accepted-and-validated — **runtime opening in this layer (M5-L2, in progress)**", leaving `multiInstanceLoopCharacteristics`, escalation, signal, and the event subprocess interim-rejected. Do NOT touch io-mapping wording yet (Task 13 does the full canonicity sweep).

- [ ] **Step 5: Commit**

```bash
git add specs/002-saga-orchestrator/m5-L2-constitution-check.md docs/bpmn/09-easy-bpmn-profile.md
git commit -m "docs(m5-l2): constitution check + 09-profile runtime-opening marker for callActivity"
```

---

### Task 2: Graph/contract types + validator acceptance (pure, no DB)

**Files:**
- Modify: `src/bpmn/graph.ts`
- Modify: `src/bpmn/validator.ts` (element dispatch around `validator.ts:511-570`)
- Modify: `src/contracts/api.ts:175-185` (`InstanceStatusValue`)
- Modify: `src/util.ts:19-26` (`TERMINAL_INSTANCE_STATUSES`)
- Test: `tests/unit/validator-call-activity.test.ts`

**Interfaces:**
- Consumes: existing `NodeType`/`ElementType` unions, `classifyContainer` recursion in the validator.
- Produces: `NodeType`/`ElementType` gain `"callActivity"`; `GraphNode` gains `calledElementId?: string | null` and `calledDefinitionVersionId?: string | null`; `InstanceStatusValue` gains `"errored"`; `TERMINAL_INSTANCE_STATUSES` gains `"errored"`. Every later task relies on these exact names.

- [ ] **Step 1: Write the failing validator tests**

Create `tests/unit/validator-call-activity.test.ts`. Mirror the setup of an existing validator unit test (read `tests/unit/` for the parse helper — tests call `parseAndValidate(xml)` from `src/bpmn/validator.ts` or via `src/bpmn/parser.ts`; copy the import used by the subProcess tests). Fixture builder:

```typescript
const CALL_XML = (body: string, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
    id="defs" targetNamespace="http://example.com">
  ${extra}
  <bpmn:process id="proc" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="call1"/>
    ${body}
    <bpmn:sequenceFlow id="f2" sourceRef="call1" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;
```

Tests (each asserts on `result.ok` and, for rejects, an issue whose `elementId === "call1"` and whose `reason` matches):

```typescript
it("accepts a plain callActivity and emits the node", async () => {
  const r = await parseAndValidate(CALL_XML(`<bpmn:callActivity id="call1" calledElement="child-proc"/>`));
  expect(r.ok).toBe(true);
  expect(r.graph!.nodes["call1"]).toMatchObject({ type: "callActivity", calledElementId: "child-proc", next: "end" });
});

it("rejects a callActivity without calledElement", async () => {
  const r = await parseAndValidate(CALL_XML(`<bpmn:callActivity id="call1"/>`));
  expect(r.ok).toBe(false);
  expect(r.issues.some(i => i.elementId === "call1" && /calledElement/.test(i.reason))).toBe(true);
});

it("rejects multiInstance on a callActivity with the M5-L3 roadmap pointer", async () => {
  const r = await parseAndValidate(CALL_XML(
    `<bpmn:callActivity id="call1" calledElement="child-proc"><bpmn:multiInstanceLoopCharacteristics/></bpmn:callActivity>`));
  expect(r.ok).toBe(false);
  expect(r.issues.some(i => i.elementId === "call1" && /M5-L3/.test(i.reason))).toBe(true);
});

it("rejects a same-document non-process calledElement (GlobalTask) explicitly", async () => {
  const r = await parseAndValidate(CALL_XML(
    `<bpmn:callActivity id="call1" calledElement="gt1"/>`,
    `<bpmn:globalTask id="gt1" name="G"/>`));
  expect(r.ok).toBe(false);
  expect(r.issues.some(i => i.elementId === "call1" && /process/.test(i.reason) && /gt1/.test(i.reason))).toBe(true);
});

it("tolerates-and-ignores camunda binding attributes", async () => {
  const r = await parseAndValidate(CALL_XML(
    `<bpmn:callActivity id="call1" calledElement="child-proc" camunda:calledElementBinding="latest" camunda:calledElementVersion="7"/>`));
  expect(r.ok).toBe(true);
});

it("accepts error/timer boundaries attached to a callActivity", async () => {
  // Reuse the boundary XML shape from the existing subProcess boundary validator test
  // (attachedToRef="call1", errorEventDefinition with errorRef + <bpmn:error errorCode>).
  // Assert ok:true and graph.nodes[boundaryId].attachedToRef === "call1".
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/validator-call-activity.test.ts`
Expected: FAIL — the accept test gets `ok:false` ("not supported in this profile"), the reject tests get generic wording.

- [ ] **Step 3: Add the types**

`src/bpmn/graph.ts`: add `| "callActivity"` to BOTH `ElementType` and `NodeType` (after `"subProcess"`), and to `GraphNode`:

```typescript
  /** callActivity only — the raw calledElement process id (M5-L2). */
  calledElementId?: string | null;
  /** callActivity only — resolved at the CALLER's publish to one immutable child version (M5-L2, Principle II). */
  calledDefinitionVersionId?: string | null;
```

`src/contracts/api.ts` `InstanceStatusValue`: append

```typescript
  // M5-L2 — child-only terminal: an uncaught error end event in a callActivity child.
  | "errored";
```

`src/util.ts` `TERMINAL_INSTANCE_STATUSES`: add `"errored",` to the set.

- [ ] **Step 4: Implement the validator branch**

In `src/bpmn/validator.ts`, inside the element dispatch of `classifyContainer` (place the new branch directly after the `bpmn:SubProcess` handling, before the generic unsupported fallback):

```typescript
      // M5-L2: callActivity — a LEAF activity on the token path; the called process
      // becomes a separate child instance at runtime. calledElement is resolved to a
      // concrete definitionVersionId at the CALLER's publish (call-resolution.ts) —
      // here we only validate document-local shape.
      if ($type === "bpmn:CallActivity") {
        if (el.loopCharacteristics != null) {
          err(`Call activity '${id ?? "(no id)"}' has loop or multi-instance characteristics — multiInstance is planned for milestone M5-L3.`, id, "callActivity");
          continue;
        }
        const calledElement = typeof el.calledElement === "string" ? el.calledElement.trim() : "";
        if (!calledElement) {
          err(`Call activity '${id ?? "(no id)"}' has no calledElement — it must name a process published in the same workspace.`, id, "callActivity");
          continue;
        }
        // Same-document non-process target (e.g. bpmn:GlobalTask) — its own explicit
        // reject, not the generic "unresolved" (spec §7).
        const sameDocTarget = sameDocCallableById.get(calledElement);
        if (sameDocTarget && sameDocTarget !== "bpmn:Process") {
          err(`Call activity '${id ?? "(no id)"}' calledElement '${calledElement}' resolves to a ${localTypeName(sameDocTarget)}, not a process — only process targets are supported.`, id, "callActivity");
          continue;
        }
        nodes.push({ id: id ?? "", type: "callActivity", name: (el.name as string) ?? undefined, scopeId, calledElementId: calledElement });
        continue;
      }
```

`sameDocCallableById`: build once where the validator walks `definitions.rootElements` (it already scans root elements for `bpmn:Error` declarations — extend that pass): `Map<string, string>` from each root element's `id` to its `$type` for `bpmn:Process` and `bpmn:GlobalTask` (and any `bpmn:Global*Task` subtype). Ensure the node-materialization site (where `nodes` entries become `graph.nodes` `GraphNode`s — search for where `type: "subProcess"` nodes get `next`/`outgoing` wired) passes `calledElementId` through. Check the boundary-attachment rule (search `attachedToRef` validation): the attachable-host set must include `callActivity` (it likely keys off "activity" node types — add `"callActivity"` wherever `"serviceTask"`/`"subProcess"` are enumerated as legal hosts, for `error`, `timer`, and `compensate` boundary kinds). Also confirm the ledger/compensation wiring rule (compensate boundary legal iff ancestor tx) treats callActivity like any activity.

- [ ] **Step 5: Run tests + full unit suite**

Run: `npx vitest run tests/unit/validator-call-activity.test.ts && npm run test:unit && npm run typecheck`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/bpmn/graph.ts src/bpmn/validator.ts src/contracts/api.ts src/util.ts tests/unit/validator-call-activity.test.ts
git commit -m "feat(m5-l2): validator accepts callActivity (leaf node, document-local rules) + errored status enum"
```

---

### Task 3: Publish-time call-tree resolution (version binding, depth, cycles, message reject)

**Files:**
- Create: `src/bpmn/call-resolution.ts`
- Modify: `src/runtime/engine.ts` (add `MAX_CALL_DEPTH` beside `MAX_SCOPE_DEPTH`, `engine.ts:185`)
- Modify: `src/index.ts` `handlePublishDraft` (`index.ts:174-209`)
- Test: `tests/integration/call-activity-publish.test.ts`

**Interfaces:**
- Consumes: `definition_versions(workspace_id, parsed_profile, published_at)`; `ValidationIssueData` from `src/bpmn/graph.ts`; `PublishRejectedError` from the index error module.
- Produces: `export const MAX_CALL_DEPTH = 4` (engine.ts); `export async function resolveCallActivities(db: D1Database, workspaceId: string, graph: ExecutionGraph): Promise<{ ok: boolean; issues: ValidationIssueData[] }>` — mutates `graph.nodes[*].calledDefinitionVersionId` in place on success. Task 6 reads `calledDefinitionVersionId` at runtime.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/call-activity-publish.test.ts` (copy the app/bootstrap harness from an existing integration test, e.g. `tests/integration/error-end-event.test.ts` — they share a `SELF`/fetch helper for `POST /definitions/drafts` + `/publish`). Scenarios (each publishes a child first where needed, then asserts on the parent's publish response):

1. **Happy binding:** publish child process `child-proc`, then a parent whose `call1` has `calledElement="child-proc"` → 201; fetch the version (`GET /definitions/versions/{id}`) and assert the graph node carries `calledDefinitionVersionId` equal to the child's `definitionVersionId`. Re-publish the child (new version), start nothing — the parent's stored graph still pins the OLD child version (immutability).
2. **Unresolved:** parent with `calledElement="nope"` → 422/400 publish-reject whose issue names `call1` and `nope`.
3. **Message-wait reject, direct child:** child containing a `receiveTask` publishes fine standalone, but the parent's publish is rejected with the child's receive element id in the reason.
4. **Message-wait reject, grandchild:** grandchild has a message `intermediateCatchEvent`; child calls grandchild (publishes fine — the reject is at each caller… NOTE: the child's own publish must ALSO reject, because the child is itself a caller of a message-bearing tree. Assert exactly that: the CHILD's publish rejects; then a parent calling a clean child succeeds).
5. **Depth reject:** chain d1←d2←d3←d4←d5 of trivial one-task processes (each calling the previous). Publishing d5 (depth 5 > `MAX_CALL_DEPTH=4`) rejects naming the cap; publishing d4 (depth 4) succeeds.
6. **Self-reference pins the previous version:** publish `loop-proc` v1 (no callActivity), then `loop-proc` v2 whose callActivity has `calledElement="loop-proc"` → resolves to v1 (assert the pinned id) — no cycle by construction.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/call-activity-publish.test.ts`
Expected: FAIL — publishes succeed without `calledDefinitionVersionId` (or the fixture rejects are missing).

- [ ] **Step 3: Add the cap constant**

`src/runtime/engine.ts`, directly after `MAX_SCOPE_DEPTH` (`engine.ts:185`):

```typescript
/**
 * Call-tree depth cap (M5-L2, spec §7). Depth is fully STATIC: child versions are
 * pinned at the caller's publish, so the call tree is an immutable DAG — enforced
 * by the publish-time call resolution (call-resolution.ts), zero runtime surface.
 * Depth 1 = a process with no callActivity.
 */
export const MAX_CALL_DEPTH = 4;
```

- [ ] **Step 4: Implement `src/bpmn/call-resolution.ts`**

```typescript
// Publish-time callActivity resolution (M5-L2, spec §7). Runs at the CALLER's
// publish, after the pure validator accepted the document: binds every
// callActivity to the latest published version of its target process in the
// same workspace (Principle II), then walks the RESOLVED call tree (stored
// child graphs already carry their own resolved ids — the tree is an immutable
// DAG) enforcing MAX_CALL_DEPTH, a defensive cycle check, and the v1 reject of
// message waits anywhere in the tree.
import type { ExecutionGraph, ValidationIssueData } from "./graph";
import { MAX_CALL_DEPTH } from "../runtime/engine";
import { dbFirst } from "../persistence/db"; // reuse the existing row helper; adjust import to the actual export

interface VersionHit { definition_version_id: string; parsed_profile: string; }

async function latestVersionByProcessId(db: D1Database, workspaceId: string, processId: string): Promise<VersionHit | null> {
  return dbFirst<VersionHit>(db,
    `SELECT definition_version_id, parsed_profile FROM definition_versions
      WHERE workspace_id = ? AND json_extract(parsed_profile, '$.processId') = ?
      ORDER BY published_at DESC, definition_version_id DESC LIMIT 1`,
    [workspaceId, processId]);
}

function callNodes(graph: ExecutionGraph): Array<{ id: string; node: ExecutionGraph["nodes"][string] }> {
  return Object.entries(graph.nodes).filter(([, n]) => n.type === "callActivity").map(([id, node]) => ({ id, node }));
}

function messageWaitIds(graph: ExecutionGraph): string[] {
  return Object.entries(graph.nodes)
    .filter(([, n]) => n.type === "receiveTask" || (n.type === "intermediateCatchEvent" && n.messageName))
    .map(([id]) => id);
}

export async function resolveCallActivities(
  db: D1Database, workspaceId: string, graph: ExecutionGraph,
): Promise<{ ok: boolean; issues: ValidationIssueData[] }> {
  const issues: ValidationIssueData[] = [];
  const calls = callNodes(graph);
  if (calls.length === 0) return { ok: true, issues };

  const err = (elementId: string, reason: string) =>
    issues.push({ severity: "error", elementId, elementName: elementId, reason });

  // 1. Bind each direct call to the latest published child version.
  const childGraphs = new Map<string, ExecutionGraph>(); // versionId → graph
  for (const { id, node } of calls) {
    const hit = await latestVersionByProcessId(db, workspaceId, node.calledElementId!);
    if (!hit) {
      err(id, `Call activity '${id}' calledElement '${node.calledElementId}' does not resolve to any published process in this workspace.`);
      continue;
    }
    node.calledDefinitionVersionId = hit.definition_version_id;
    childGraphs.set(hit.definition_version_id, JSON.parse(hit.parsed_profile) as ExecutionGraph);
  }
  if (issues.length > 0) return { ok: false, issues };

  // 2. Walk the resolved tree: depth, defensive cycles, v1 message-wait reject.
  //    depthOf(g) = 1 + max(depthOf(child)); memoized by versionId.
  const depthMemo = new Map<string, number>();
  const walk = async (g: ExecutionGraph, versionId: string | null, chain: string[], viaCallId: string): Promise<number> => {
    if (versionId && chain.includes(versionId)) {
      err(viaCallId, `Call activity '${viaCallId}' creates a call cycle (${[...chain, versionId].join(" -> ")}).`);
      return 1;
    }
    if (versionId && depthMemo.has(versionId)) return depthMemo.get(versionId)!;
    for (const m of messageWaitIds(g)) {
      err(viaCallId, `Called process contains a message wait ('${m}') — a callActivity child has no correlation-key source; message waits anywhere in the call tree are rejected in this layer (spec §7).`);
    }
    let max = 0;
    for (const { id, node } of callNodes(g)) {
      const childVid = node.calledDefinitionVersionId!;
      let childGraph = childGraphs.get(childVid);
      if (!childGraph) {
        const row = await dbFirst<VersionHit>(db,
          `SELECT definition_version_id, parsed_profile FROM definition_versions WHERE definition_version_id = ?`, [childVid]);
        if (!row) { err(id, `Call activity '${id}' pinned child version '${childVid}' is missing.`); continue; }
        childGraph = JSON.parse(row.parsed_profile) as ExecutionGraph;
        childGraphs.set(childVid, childGraph);
      }
      max = Math.max(max, await walk(childGraph, childVid, versionId ? [...chain, versionId] : chain, id));
    }
    const d = 1 + max;
    if (versionId) depthMemo.set(versionId, d);
    return d;
  };
  let depth = 0;
  for (const { id, node } of calls) {
    const g = childGraphs.get(node.calledDefinitionVersionId!)!;
    depth = Math.max(depth, 1 + (await walk(g, node.calledDefinitionVersionId!, [], id)));
    if (depth > MAX_CALL_DEPTH) {
      err(id, `Call tree depth ${depth} exceeds MAX_CALL_DEPTH = ${MAX_CALL_DEPTH}.`);
      break;
    }
  }
  return { ok: issues.length === 0, issues };
}
```

(Adjust the `dbFirst` import to the actual helper exported by `src/persistence/db.ts` — read it first.)

- [ ] **Step 5: Wire into `handlePublishDraft`**

In `src/index.ts` `handlePublishDraft`, after the `parseAndValidate` gate and before `createVersion`:

```typescript
  const callResolution = await resolveCallActivities(env.DB, row.workspace_id, result.graph);
  if (!callResolution.ok) {
    throw new PublishRejectedError("Draft contains publish-blocking callActivity resolution issues.", callResolution.issues);
  }
```

The mutated `result.graph` (now carrying `calledDefinitionVersionId`) flows into `createVersion` unchanged.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/integration/call-activity-publish.test.ts && npm run test:integration && npm run typecheck`
Expected: PASS; existing suites untouched.

- [ ] **Step 7: Commit**

```bash
git add src/bpmn/call-resolution.ts src/runtime/engine.ts src/index.ts tests/integration/call-activity-publish.test.ts
git commit -m "feat(m5-l2): publish-time call-tree resolution — version binding, MAX_CALL_DEPTH=4, cycle + message-wait rejects"
```

---

### Task 4: Migration 0008 + child-instances persistence module

**Files:**
- Create: `migrations/0008_call_activity.sql`
- Create: `src/persistence/child-instances.ts`
- Modify: `src/persistence/instances.ts` (`InstanceRow`, `mapInstance`, new `createChildInstanceStmt`)
- Modify: `src/persistence/saga.ts` (`SagaStepRow/View`, `mapSagaStep`, `insertSagaStepStmt` gain `child_instance_id`)
- Modify: `src/contracts/api.ts` (`ProcessInstance` gains `parentInstanceId?`, `errorCode?`)
- Test: `tests/integration/migration-0008-call-activity.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 6–11):
  - `ChildInstanceRow { parent_instance_id; parent_element_id; occurrence: number; iteration_index: number; child_instance_id; status: "invoked" | "outputApplied"; created_at; updated_at }`
  - `insertChildInstanceStmt(db, { parentInstanceId, parentElementId, occurrence, iterationIndex, childInstanceId, now }): D1PreparedStatement`
  - `getChildInstanceForVisit(db, parentInstanceId, parentElementId, occurrence, iterationIndex = 0): Promise<ChildInstanceRow | null>`
  - `getChildInstanceByChildId(db, childInstanceId): Promise<ChildInstanceRow | null>`
  - `markChildOutputAppliedStmt(db, { parentInstanceId, parentElementId, occurrence, iterationIndex, now }): D1PreparedStatement` — `UPDATE … SET status='outputApplied' WHERE … AND status='invoked'`
  - `listChildrenOfInstance(db, parentInstanceId): Promise<Array<ChildInstanceRow & { child_status: string; child_error_code: string | null }>>` (JOIN `process_instances`)
  - `createChildInstanceStmt(db, {...createInstance fields, parentInstanceId, parentElementId, parentOccurrence, now}): D1PreparedStatement` (instances.ts — the batchable INSERT variant with the parent columns; status `'starting'`)
  - `InstanceRow` gains `parent_instance_id: string | null; parent_element_id: string | null; parent_occurrence: number | null; error_code: string | null`
  - `insertSagaStepStmt` gains optional `childInstanceId?: string | null`; `SagaStepView` gains `childInstanceId: string | null`

- [ ] **Step 1: Write the migration**

`migrations/0008_call_activity.sql`:

```sql
-- M5-L2 callActivity (spec §2) — the child-idempotency provenance table + parent
-- linkage. child_instances is the rewalk fast-forward predicate gating BOTH the
-- child Workflow create and the output apply (the analogue of gateway_decisions /
-- output_applied=1); the UNIQUE index is the at-least-once single-apply guard.

CREATE TABLE IF NOT EXISTS child_instances (
  parent_instance_id TEXT    NOT NULL,
  parent_element_id  TEXT    NOT NULL,            -- the callActivity node id
  occurrence         INTEGER NOT NULL,
  iteration_index    INTEGER NOT NULL DEFAULT 0,  -- reserved for M5-L3 MI
  child_instance_id  TEXT    NOT NULL,
  status             TEXT    NOT NULL,            -- invoked | outputApplied
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_child_instances_visit
  ON child_instances (parent_instance_id, parent_element_id, occurrence, iteration_index);
CREATE INDEX IF NOT EXISTS idx_child_instances_child ON child_instances (child_instance_id);

-- Parent linkage on the child row (NULL for root instances) + the child-only
-- errored terminal's business error code (spec §4).
ALTER TABLE process_instances ADD COLUMN parent_instance_id TEXT;
ALTER TABLE process_instances ADD COLUMN parent_element_id  TEXT;
ALTER TABLE process_instances ADD COLUMN parent_occurrence  INTEGER;
ALTER TABLE process_instances ADD COLUMN error_code         TEXT;
CREATE INDEX IF NOT EXISTS idx_instances_parent ON process_instances (parent_instance_id);

-- Step-kind dispatch for the reverse pass (spec §5): NULL = worker-task step;
-- non-NULL = compensate by driving this child instance's own reverse pass.
ALTER TABLE saga_steps ADD COLUMN child_instance_id TEXT;
```

- [ ] **Step 2: Write the failing migration test**

`tests/integration/migration-0008-call-activity.test.ts` — mirror `tests/integration/migration-0007-tokens.test.ts` (read it for the raw-D1 harness): insert a `child_instances` row, assert the UNIQUE index rejects a duplicate visit key, assert `markChildOutputAppliedStmt`-shaped UPDATE flips exactly the `invoked` row (second run = 0 changes), assert the new `process_instances` columns default NULL.

Run: `npx vitest run tests/integration/migration-0008-call-activity.test.ts` — Expected: FAIL (table missing).

- [ ] **Step 3: Apply migration + implement the persistence module**

```bash
npx wrangler d1 migrations apply easy_bpmn --local
```

`src/persistence/child-instances.ts` — implement the exact interface above with the module conventions of `src/persistence/gateway-decisions.ts` (read it: `stmt`/`dbFirst`/`dbAll` helpers). `insertChildInstanceStmt` sets `status='invoked'`.

`src/persistence/instances.ts`: extend `InstanceRow` with the four new fields; extend `mapInstance` with `parentInstanceId: row.parent_instance_id ?? null` and `errorCode: row.error_code ?? null`; add:

```typescript
/** Batchable child-instance INSERT (M5-L2): same shape as createInstance but a
 *  statement (it must commit in the SAME batch as the child_instances provenance
 *  row — persist-before-advance), with the parent linkage columns. */
export function createChildInstanceStmt(db: D1Database, input: {
  instanceId: string; workspaceId: string; definitionVersionId: string;
  correlationKey: string; startElementId: string; variables: JsonObject;
  parentInstanceId: string; parentElementId: string; parentOccurrence: number; now: string;
}): D1PreparedStatement {
  return stmt(db,
    `INSERT INTO process_instances
       (instance_id, workspace_id, definition_version_id, workflow_instance_id, workflow_status,
        business_key, correlation_key, status, current_element_id, variables, started_at, updated_at,
        completed_at, last_synced_at, parent_instance_id, parent_element_id, parent_occurrence)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, 'starting', ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    [input.instanceId, input.workspaceId, input.definitionVersionId, input.instanceId,
     input.correlationKey, input.startElementId, toJson(input.variables), input.now, input.now,
     input.parentInstanceId, input.parentElementId, input.parentOccurrence]);
}
```

(`workflow_instance_id` mirrors the instance id, same as the root-start path, `index.ts:241`.)

`src/persistence/saga.ts`: add `child_instance_id: string | null` to `SagaStepRow`, `childInstanceId` to `SagaStepView` + `mapSagaStep`, and an optional `childInstanceId?: string | null` input to `insertSagaStepStmt` (extend the column list + bind array; default NULL). Verify every `SELECT` feeding `mapSagaStep` uses `SELECT *` or add the column.

`src/contracts/api.ts` `ProcessInstance`: add `parentInstanceId?: string | null;` and `errorCode?: string | null;`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/integration/migration-0008-call-activity.test.ts && npm run test:integration && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/0008_call_activity.sql src/persistence/child-instances.ts src/persistence/instances.ts src/persistence/saga.ts src/contracts/api.ts tests/integration/migration-0008-call-activity.test.ts
git commit -m "feat(m5-l2): migration 0008 — child_instances provenance, parent linkage, saga step-kind column"
```

---

### Task 5: Executor idempotent child start, suppress-notify plumbing, JobScheduler child-notify alarm

**Files:**
- Modify: `src/runtime/executor.ts` (`WorkflowExecutor.start`, `DirectExecutor.start`)
- Modify: `src/runtime/engine.ts` (`RunOptions` + `runInstance` signature pass-through only — the hook body is Task 6)
- Modify: `src/durable-objects/job-scheduler.ts`
- Test: `tests/unit/job-scheduler-child-notify.test.ts` (or extend the existing scheduler unit test — check `tests/unit/` first)

**Interfaces:**
- Produces:
  - `WorkflowExecutor.start` treats "already exists / already in use" `create()` errors as success (never auto-id — the id is always the caller's).
  - `RunOptions.suppressParentNotify?: boolean` threaded through `runInstance` → `runInstanceInner`; `DirectExecutor.start` sets it `true` (a child started inline from inside the parent's held drive lock must not re-enter the parent — the parent's own walk re-reads the child immediately after; spec §3).
  - `JobScheduler.armChildNotify(childInstanceId: string, at: string, attempt: number): Promise<void>` — third marker key `CHILD_KEY = "childNotify"`; alarm dispatch calls `retryChildNotify(env, childInstanceId, attempt)` (implemented in Task 6's `call-activity.ts`; for THIS task, wire the dispatch to a dynamic import and a stub is fine only if Task 6 lands in the same branch — implement the import now, function in Task 6).
  - `CHILD_NOTIFY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000]` exported from `job-scheduler.ts` (4 bounded retries per level, all far under the 1h wake backstop — spec §3.4).

- [ ] **Step 1: Idempotent Workflow create**

In `src/runtime/executor.ts` `WorkflowExecutor.start` (`executor.ts:57-61`):

```typescript
  async start(params: ProcessWorkflowParams): Promise<void> {
    // The Workflow instance id mirrors the product instance id (stored in D1).
    // M5-L2: child creates are at-least-once (a rewalk can re-run the invoke step
    // after a crash between the provenance batch and this call) — a duplicate id
    // is SUCCESS, never an error and never a fresh auto-id (spec §3.2).
    try {
      await this.env.PROCESS_WORKFLOW.create({ id: params.instanceId, params });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already (exists|in use)|instance.+exists/i.test(msg)) return;
      throw err;
    }
  }
```

- [ ] **Step 2: Thread `suppressParentNotify`**

`src/runtime/engine.ts` `RunOptions`: add `suppressParentNotify?: boolean;` (no behavior yet — Task 6 reads it). `src/runtime/executor.ts` `DirectExecutor.start`:

```typescript
  async start(params: ProcessWorkflowParams): Promise<void> {
    // suppressParentNotify: a DirectExecutor child start runs INLINE inside the
    // parent's drive (which holds the parent's drive lock) — the post-drive
    // parent-notify hook would re-enter the parent under its own held lock and
    // burn the 1s lock-steal budget. The parent's walk re-reads the child row
    // right after this returns, so the notify is redundant here (M5-L2 spec §3).
    await runInstance(this.env, params.instanceId, { runStep: this.inlineStep, waitFor: null, suppressParentNotify: true });
  }
```

- [ ] **Step 3: JobScheduler third marker**

`src/durable-objects/job-scheduler.ts`:

```typescript
const CHILD_KEY = "childNotify";           // value: childInstanceId
const CHILD_ATTEMPT_KEY = "childNotifyAttempt";

/** Bounded child→parent notify retry schedule (M5-L2 spec §3.4): 4 retries per
 *  level, all far below the 1h MAX_WAKE_BACKSTOP_MS the parent would otherwise
 *  wait after a dropped tickle. */
export const CHILD_NOTIFY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];

  /** Arm (or re-arm) the child→parent notify self-heal for `childInstanceId`. */
  async armChildNotify(childInstanceId: string, at: string, attempt: number): Promise<void> {
    await this.ctx.storage.put(CHILD_KEY, childInstanceId);
    await this.ctx.storage.put(CHILD_ATTEMPT_KEY, attempt);
    await this.ctx.storage.setAlarm(new Date(at).getTime());
  }
```

Extend `alarm()` dispatch (keep the existing order; add the new branch last):

```typescript
    const childId = await this.ctx.storage.get<string>(CHILD_KEY);
    if (jobId) await terminateUnleasableJob(this.env, jobId);
    else if (timerId) await fireTimer(this.env, timerId);
    else if (childId) {
      const attempt = (await this.ctx.storage.get<number>(CHILD_ATTEMPT_KEY)) ?? 0;
      await retryChildNotify(this.env, childId, attempt);
    }
```

Import `retryChildNotify` from `../runtime/call-activity` (created in Task 6 — within this branch the two tasks compile together; if executing tasks strictly separately, add a temporary `export async function retryChildNotify() {}` stub in a new `src/runtime/call-activity.ts` and note it). DO naming convention for callers: `env.JOB_SCHEDULER.idFromName(\`child-notify:${childInstanceId}\`)` — a distinct name namespace from raw job ids and `timer:` ids, so markers can never collide.

- [ ] **Step 4: Test + commit**

Unit-test the dispatch precedence if an existing `job-scheduler` unit test exists (extend it: storage holds `childNotify` → alarm calls the child branch); otherwise cover via Task 6's integration tests and note it here.

Run: `npm run test:unit && npm run typecheck` — Expected: PASS.

```bash
git add src/runtime/executor.ts src/runtime/engine.ts src/durable-objects/job-scheduler.ts tests/unit/
git commit -m "feat(m5-l2): idempotent child Workflow create, suppress-notify plumbing, JobScheduler child-notify marker"
```

---

### Task 6: Forward runtime — `call-activity.ts`, engine dispatch, parent-notify hook, happy path

**Files:**
- Create: `src/runtime/call-activity.ts`
- Modify: `src/runtime/engine.ts` (driveLeaf dispatch; post-drive notify hook in `runInstanceInner`)
- Modify: `src/runtime/wake.ts` (`wakeBackstop` child-wait cap)
- Test: `tests/integration/call-activity-forward.test.ts`

**Interfaces:**
- Consumes: Task 4 persistence, Task 5 executor/scheduler, `parkWaiting`-style parking, `errorCatchTarget` (Task 7 uses it here too), `mergeVariables`, `resolveScope`/overlay helpers from `frontier.ts`/`tokens.ts` (the `applyMessage` pattern, `engine.ts:1328-1396`).
- Produces (exact exports of `src/runtime/call-activity.ts`):
  - `childInstanceIdFor(parentInstanceId, elementId, occ, iterationIndex = 0): Promise<string>`
  - `PARENT_CONSUMABLE_CHILD_STATUSES: Set<string>` = `{"completed","errored","cancelled","compensated","compensationFailed"}` (the notify set; the forward APPLY set is only `completed|errored`)
  - `driveCallActivity(env, instanceId, graph, elementId, occ, node, runStep, activeTokenId?): Promise<{kind:"next";next:string}|{kind:"waiting"}|{kind:"incident"}>`
  - `notifyParentOfChildTerminal(env, child: InstanceRow): Promise<void>`
  - `retryChildNotify(env, childInstanceId: string, attempt: number): Promise<void>`
  - `CHILD_WAIT_BACKSTOP_MS = 5 * 60 * 1000`

- [ ] **Step 1: Write the failing forward tests**

`tests/integration/call-activity-forward.test.ts` (integration harness as in Task 3). Fixtures used across Tasks 6–10 — define them in a shared `tests/integration/call-activity-fixtures.ts`:

```typescript
// Child: start → tx1[ reserve-stock (comp: release-stock) → txEnd ] → gw: failChild ? errorEnd(CHILD_FAILED) : end
export const CALL_CHILD_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0" id="child-defs" targetNamespace="http://example.com">
  <bpmn:error id="errChild" name="ChildFailed" errorCode="CHILD_FAILED"/>
  <bpmn:process id="child-proc" isExecutable="true">
    <bpmn:startEvent id="c-start"/>
    <bpmn:sequenceFlow id="cf1" sourceRef="c-start" targetRef="c-tx"/>
    <bpmn:transaction id="c-tx">
      <bpmn:startEvent id="ct-start"/>
      <bpmn:sequenceFlow id="ctf1" sourceRef="ct-start" targetRef="c-reserve"/>
      <bpmn:serviceTask id="c-reserve" name="Reserve">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="reserve-stock" retries="1"/></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:sequenceFlow id="ctf2" sourceRef="c-reserve" targetRef="ct-end"/>
      <bpmn:endEvent id="ct-end"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="c-comp-b" attachedToRef="c-reserve"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
    <bpmn:serviceTask id="c-release" isForCompensation="true">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="release-stock" retries="1"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:association id="c-assoc" associationDirection="One" sourceRef="c-comp-b" targetRef="c-release"/>
    <bpmn:sequenceFlow id="cf2" sourceRef="c-tx" targetRef="c-gw"/>
    <bpmn:exclusiveGateway id="c-gw" default="cf-ok"/>
    <bpmn:sequenceFlow id="cf-fail" sourceRef="c-gw" targetRef="c-err">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">failChild = true</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:endEvent id="c-err"><bpmn:errorEventDefinition errorRef="errChild"/></bpmn:endEvent>
    <bpmn:sequenceFlow id="cf-ok" sourceRef="c-gw" targetRef="c-end"/>
    <bpmn:endEvent id="c-end"/>
  </bpmn:process>
</bpmn:definitions>`;

// Parent: start → p-tx[ charge-card (comp: refund-card) → call1(child-proc) → gw: failSettle ? cancelEnd : txEnd ] → end
//         + error boundary (CHILD_FAILED) on call1 → p-handle(log-only) → p-end2, cancel boundary on p-tx → p-comp-end
export const CALL_PARENT_BPMN = /* same skeleton: build it following the transaction fixture in
  tests/integration/saga-orchestration.test.ts (read it) with the callActivity spliced in:
  <bpmn:callActivity id="call1" calledElement="child-proc"/>
  <bpmn:boundaryEvent id="call1-err" attachedToRef="call1"><bpmn:errorEventDefinition errorRef="errChild"/></bpmn:boundaryEvent>
  Keep the ids: p-start, p-tx, pt-start, p-charge, call1, p-gw, p-cancel-end, pt-end, p-end,
  p-tx-cancel-b (cancel boundary), p-comp-end, call1-err, p-handle, p-end2, error id errChild2 errorCode CHILD_FAILED. */;
```

Also a trivial no-tx pair for the happy path: `SIMPLE_CHILD_BPMN` (start → `echo` service task → end, process id `simple-child`) and `SIMPLE_PARENT_BPMN` (start → `call1(simple-child)` → `p-after` echo task → end, process id `simple-parent`).

Test helper: `publishAndStart(xml…)` + the pull-worker pump used by existing saga tests (read `tests/integration/saga-orchestration.test.ts` for the `POST /jobs/activate`→`complete` loop helper and reuse it — child jobs surface through the SAME pull plane as any instance's).

Tests:

```typescript
it("runs a callActivity end-to-end: child instance created, output merged, parent completes", async () => {
  // publish simple-child then simple-parent; start parent with {variables:{seed:1}}
  // pump jobs until parent completed.
  // Assert: parent GET /instances/{id} → status completed, variables.echoed.seed === 1 (pass-through both ways);
  // a child instance exists: parentInstanceId === parent id, status completed, correlationKey === `child:${childId}`;
  // parent history has callActivityInvoked + callActivityCompleted; child_instances row status outputApplied.
});

it("is idempotent: a duplicate inline re-drive neither re-creates nor re-applies", async () => {
  // After completion, POST a duplicate /jobs/{lastChildJob}/complete (stable prior outcome),
  // and drive the parent again via another duplicate. Assert exactly ONE child row for
  // (parent, call1, 0, 0), exactly one callActivityCompleted history event, variables unchanged.
});

it("deterministic child id", async () => {
  const a = await childInstanceIdFor("pi-x", "call1", 0);
  expect(a).toBe(await childInstanceIdFor("pi-x", "call1", 0));
  expect(a).not.toBe(await childInstanceIdFor("pi-x", "call1", 1));
  expect(a).toMatch(/^pi-[0-9a-f]{24}$/);
});
```

Run: `npx vitest run tests/integration/call-activity-forward.test.ts` — Expected: FAIL (callActivity node unhandled → falls into the engine's non-token-path incident).

- [ ] **Step 2: Implement `src/runtime/call-activity.ts`**

Module header comment: "M5-L2 callActivity runtime — forward invoke/apply (this task), child-terminal parent notify + DO-alarm self-heal (this task), errored settle + drain cascade + child compensation (Tasks 7–9). Mirrors forward-task.ts's triad discipline: every runStep issuance is gated on a D1 predicate read outside the step (memoization safety)."

```typescript
export const CHILD_WAIT_BACKSTOP_MS = 5 * 60 * 1000;

/** Child terminals the PARENT reacts to (notify set). `incident` is deliberately
 *  absent — a child incident parks the saga; the cascading /retry resumes it. */
export const PARENT_CONSUMABLE_CHILD_STATUSES = new Set(["completed", "errored", "cancelled", "compensated", "compensationFailed"]);
/** Child terminals the FORWARD apply consumes (spec §3.5/§4). */
const FORWARD_APPLY_STATUSES = new Set(["completed", "errored"]);

export async function childInstanceIdFor(parentInstanceId: string, elementId: string, occ: number, iterationIndex = 0): Promise<string> {
  const data = new TextEncoder().encode(`${parentInstanceId}:${elementId}:${occ}:${iterationIndex}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pi-${hex.slice(0, 24)}`;
}

export type CallOutcome = { kind: "next"; next: string } | { kind: "waiting" } | { kind: "incident" };

export async function driveCallActivity(
  env: Env, instanceId: string, graph: ExecutionGraph, elementId: string, occ: number,
  node: GraphNode, runStep: RunStep, activeTokenId?: string,
): Promise<CallOutcome> {
  const tag = `${elementId}#${occ}`;
  // Boundary-timer fast-forward — identical to forward-task.ts:202.
  const tb = timerBoundaryFor(graph, elementId);
  if (tb && (await timerHasFired(env, instanceId, tb, occ))) return { kind: "next", next: tb.node.next! };

  let row = await getChildInstanceForVisit(env.DB, instanceId, elementId, occ);
  // Applied → pure write-free cursor move re-derived from child terminal state.
  if (row?.status === "outputApplied") return appliedCallOutcome(env, graph, elementId, node, row);

  if (!row) {
    const created = await runStep(`call-create:${tag}`, () => invokeChild(env, instanceId, graph, elementId, occ, node, activeTokenId));
    if (!created) return { kind: "incident" }; // oversized input — incident already recorded
    row = await getChildInstanceForVisit(env.DB, instanceId, elementId, occ);
  }
  const child = row ? await getInstanceRow(env.DB, row.child_instance_id) : null;
  if (!child) return { kind: "incident" }; // invariant: provenance row without child row

  // Crash self-heal: provenance row committed but the Workflow create was lost
  // (crash between the batch and create) — re-issue the idempotent start. Only
  // observable in workflow mode ('starting' + no drive ever ran); direct mode ran
  // the child inline inside invokeChild.
  if (child.status === "starting") {
    await getExecutor(env).start({
      workspaceId: child.workspace_id, instanceId: child.instance_id,
      definitionVersionId: child.definition_version_id, correlationKey: child.correlation_key,
      initialVariables: parseJson<JsonObject>(child.variables, {}),
    });
  }

  const fresh = await getInstanceRow(env.DB, row!.child_instance_id);
  if (fresh && FORWARD_APPLY_STATUSES.has(fresh.status)) {
    // Gated apply (memoization safety): the step is issued ONLY when the child is
    // in a forward-consumable terminal, so its memoized result is always final.
    const applied = await runStep(`call-apply:${tag}`, () => applyChildTerminal(env, instanceId, graph, elementId, occ, node, activeTokenId));
    if (applied.kind === "incident") return applied;
    return applied;
  }
  await runStep(`call-park:${tag}`, () => parkCallWaiting(env, instanceId, elementId, occ));
  return { kind: "waiting" };
}
```

`invokeChild` (returns `false` only on the oversized-input incident):

```typescript
async function invokeChild(env, instanceId, graph, elementId, occ, node, activeTokenId): Promise<boolean> {
  const existing = await getChildInstanceForVisit(env.DB, instanceId, elementId, occ);
  if (existing) return true; // idempotent step re-run
  const inst = await loadInst(env, instanceId);
  const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
  const variables = isBranch
    ? await resolveScope(env, instanceId, parseJson<JsonObject>(inst.variables, {}), activeTokenId!)
    : parseJson<JsonObject>(inst.variables, {});
  if (payloadByteSize(variables) > MAX_EVENT_PAYLOAD_BYTES) {
    await createIncident(env, instanceId, elementId, 0, "Call activity input variables exceed the Workflow event payload limit.", { size: payloadByteSize(variables) }, "serviceTaskFailure");
    return false;
  }
  const childId = await childInstanceIdFor(instanceId, elementId, occ);
  const childGraphStart = await getVersionGraph(env.DB, node.calledDefinitionVersionId!);
  if (!childGraphStart) throw new Error(`Invariant violation: pinned child version ${node.calledDefinitionVersionId} has no parsed profile.`);
  const now = nowIso();
  const arm = buildBoundaryArm(graph, env, { instanceId, workspaceId: inst.workspace_id, hostElementId: elementId, occ, now });
  await dbBatch(env.DB, [
    insertChildInstanceStmt(env.DB, { parentInstanceId: instanceId, parentElementId: elementId, occurrence: occ, iterationIndex: 0, childInstanceId: childId, now }),
    createChildInstanceStmt(env.DB, {
      instanceId: childId, workspaceId: inst.workspace_id, definitionVersionId: node.calledDefinitionVersionId!,
      correlationKey: `child:${childId}`, startElementId: childGraphStart.startElementId,
      variables, parentInstanceId: instanceId, parentElementId: elementId, parentOccurrence: occ, now,
    }),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "callActivityInvoked",
      diagnostics: { childInstanceId: childId, calledDefinitionVersionId: node.calledDefinitionVersionId, occurrence: occ, ...branchHistoryTags(activeTokenId) } }),
    ...(arm ? arm.stmts : []),
  ]);
  if (arm) await armTimerDO(env, arm.timerId, arm.fireAt);
  // Idempotent start AFTER the provenance batch (persist-before-advance). Direct
  // mode runs the child fully inline here (suppressParentNotify), workflow mode
  // returns immediately after create.
  await getExecutor(env).start({ workspaceId: inst.workspace_id, instanceId: childId, definitionVersionId: node.calledDefinitionVersionId!, correlationKey: `child:${childId}`, initialVariables: variables });
  return true;
}
```

`applyChildTerminal` — the once-decider (spec §3.5). For `completed`: merge + flip in one batch (branch overlay vs root exactly like `applyMessage`, `engine.ts:1339-1376`); insert the child saga step. For `errored`: defer to Task 7's routing but implement the shared batch skeleton now with the completed path only, returning `{kind:"incident"}` for `errored` with a `TODO(m5-l2 task 7)` **only if you are executing tasks strictly in order — otherwise implement Task 7's branch here directly** (Task 7's test drives it):

```typescript
async function applyChildTerminal(env, instanceId, graph, elementId, occ, node, activeTokenId): Promise<CallOutcome> {
  const row = await getChildInstanceForVisit(env.DB, instanceId, elementId, occ);
  if (!row) throw new Error(`Invariant violation: call-apply without a child_instances row (${elementId}#${occ}).`);
  if (row.status === "outputApplied") return appliedCallOutcome(env, graph, elementId, node, row); // idempotent re-run
  const child = (await getInstanceRow(env.DB, row.child_instance_id))!;
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const applyFlip = markChildOutputAppliedStmt(env.DB, { parentInstanceId: instanceId, parentElementId: elementId, occurrence: occ, iterationIndex: 0, now });

  if (child.status === "completed") {
    const childVars = parseJson<JsonObject>(child.variables, {});
    const isBranch = !!activeTokenId && activeTokenId !== rootTokenId(instanceId);
    const branchTokenRow = isBranch ? await getToken(env.DB, activeTokenId!) : null;
    const baseVars = isBranch ? (branchTokenRow ? await readOverlay(env, parseOverlay(branchTokenRow)) : {}) : parseJson<JsonObject>(inst.variables, {});
    const merged = mergeVariables(baseVars, childVars);
    const storedOverlay = isBranch ? await writeOverlay(env, instanceId, activeTokenId!, merged) : merged;
    const stepId = newId("step");
    await dbBatch(env.DB, [
      applyFlip,
      ...(isBranch
        ? [setTokenOverlayStmt(env.DB, activeTokenId!, storedOverlay, now), applyTransitionStmt(env.DB, { instanceId, currentElementId: null, status: "running", now })]
        : [applyTransitionStmt(env.DB, { instanceId, variables: merged, currentElementId: node.next, status: "running", now })]),
      variableSnapshotStmt(env.DB, { instanceId, source: "callActivity", sourceId: row.child_instance_id, variables: childVars, now }),
      // Child ledger step (spec §5): ALWAYS compensable — the implicit compensator
      // is the child's own reverse pass; an empty committed child ledger no-ops.
      insertSagaStepStmt(env.DB, {
        stepId, instanceId, scopeId: node.scopeId ?? "", elementId,
        forwardJobId: null, capturedInput: {}, capturedOutput: childVars,
        compensationElementId: null, compensationTaskType: null, compensationStatus: "pending",
        traceId: traceIdFor(instanceId), occurrence: occ,
        tokenId: activeTokenId ?? null, childInstanceId: row.child_instance_id, now,
      }),
      historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "callActivityCompleted",
        diagnostics: { childInstanceId: row.child_instance_id, occurrence: occ, ...branchHistoryTags(activeTokenId) } }),
    ]);
    return { kind: "next", next: node.next! };
  }
  // child.status === "errored" — Task 7 routing (error boundary / bubble / uncaughtError).
  return applyChildErrored(env, instanceId, graph, elementId, occ, node, row, child, activeTokenId);
}
```

Check `insertSagaStepStmt`'s handling of `forwardJobId: null` against `migrations/0002_saga.sql` — if `forward_job_id` is `NOT NULL`, relax it in migration 0008 (`ALTER` is impossible for constraints in SQLite; instead bind the sentinel `""` and treat empty-as-null in `mapSagaStep`; prefer the sentinel and document it in the module).

`appliedCallOutcome` (write-free re-derivation, mirror `appliedForwardOutcome`): re-read the child row; `completed` → `{kind:"next", next: node.next!}`; `errored` → recompute `errorCatchTarget(graph, elementId, child.error_code)` → its `.next`, or the recorded incident (return `{kind:"incident"}`).

`parkCallWaiting`:

```typescript
async function parkCallWaiting(env, instanceId, elementId, occ): Promise<void> {
  const inst = await loadInst(env, instanceId);
  if (inst.status === "waiting" && inst.current_element_id === elementId) return; // idempotent re-park
  await dbBatch(env.DB, [
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "callActivityWaiting", diagnostics: { occurrence: occ } }),
    applyTransitionStmt(env.DB, { instanceId, currentElementId: elementId, status: "waiting", now: nowIso() }),
  ]);
}
```

`notifyParentOfChildTerminal` + `retryChildNotify`:

```typescript
export async function notifyParentOfChildTerminal(env: Env, child: InstanceRow): Promise<void> {
  if (!child.parent_instance_id || !PARENT_CONSUMABLE_CHILD_STATUSES.has(child.status)) return;
  const parent = await getInstanceRow(env.DB, child.parent_instance_id);
  if (!parent || isTerminalInstanceStatus(parent.status)) return;
  // Arm the self-heal BEFORE the tickle: a dropped tickle (the W-AND-TICKLE-GAP
  // class — the child terminated before the parent armed its wait) then still
  // recovers within CHILD_NOTIFY_BACKOFF_MS[0], not the 1h wake backstop.
  await armChildNotifyAlarm(env, child.instance_id, 0);
  // deliverJobResult IS the right seam: WAKE_TYPE tickle with the terminated-
  // Workflow inline-drive fallback, in both executors (executor.ts:70-93).
  await getExecutor(env).deliverJobResult({ instanceId: parent.instance_id, workflowInstanceId: parent.workflow_instance_id, elementId: child.parent_element_id! });
}

async function armChildNotifyAlarm(env: Env, childInstanceId: string, attempt: number): Promise<void> {
  try {
    const stub = env.JOB_SCHEDULER.get(env.JOB_SCHEDULER.idFromName(`child-notify:${childInstanceId}`));
    await stub.armChildNotify(childInstanceId, isoPlusMs(nowIso(), CHILD_NOTIFY_BACKOFF_MS[Math.min(attempt, CHILD_NOTIFY_BACKOFF_MS.length - 1)]!), attempt);
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", message: "armChildNotify failed", childInstanceId, error: err instanceof Error ? err.message : String(err) }));
  }
}

/** DO-alarm self-heal (spec §3.4): re-read canonical state; if the parent has not
 *  yet consumed this child's terminal, re-tickle and re-arm (bounded). */
export async function retryChildNotify(env: Env, childInstanceId: string, attempt: number): Promise<void> {
  const child = await getInstanceRow(env.DB, childInstanceId);
  if (!child?.parent_instance_id || !PARENT_CONSUMABLE_CHILD_STATUSES.has(child.status)) return;
  const parent = await getInstanceRow(env.DB, child.parent_instance_id);
  if (!parent || isTerminalInstanceStatus(parent.status)) return;
  const row = await getChildInstanceByChildId(env.DB, childInstanceId);
  const forwardConsumed = row?.status === "outputApplied";
  // Reverse-pass consumption (Task 9): the parent's child step settled.
  const step = await getSagaStepByChildId(env.DB, parent.instance_id, childInstanceId); // add to saga.ts: SELECT by child_instance_id
  const reverseConsumed = step != null && (step.compensationStatus === "compensated" || step.compensationStatus === "failed");
  if (forwardConsumed && (child.status === "completed" || child.status === "errored") && !["compensated","compensationFailed"].includes(child.status)) return;
  if (reverseConsumed) return;
  if (attempt >= CHILD_NOTIFY_BACKOFF_MS.length) {
    console.error(JSON.stringify({ level: "error", message: "child-notify retries exhausted", childInstanceId, parentInstanceId: parent.instance_id }));
    return; // the 1h wake backstop remains the last resort
  }
  await armChildNotifyAlarm(env, childInstanceId, attempt + 1);
  await getExecutor(env).deliverJobResult({ instanceId: parent.instance_id, workflowInstanceId: parent.workflow_instance_id, elementId: child.parent_element_id! });
}
```

(Add `getSagaStepByChildId(db, instanceId, childInstanceId)` to `src/persistence/saga.ts` — `SELECT * FROM saga_steps WHERE instance_id = ? AND child_instance_id = ? LIMIT 1` through `mapSagaStep`.)

- [ ] **Step 3: Engine dispatch + post-drive hook + wake cap**

`src/runtime/engine.ts` driveLeaf — insert after the `serviceTask` branch (`engine.ts:404`):

```typescript
      if (node.type === "callActivity") {
        const r = await driveCallActivity(env, instanceId, graph, cur, occ, node, runStep, activeTokenId);
        if (r.kind === "waiting") return { kind: "parked" };
        if (r.kind === "incident") return { kind: "incident" };
        return { kind: "next", next: r.next };
      }
```

`runInstanceInner` — post-drive parent notify (append before the final `return result;`, covering BOTH the compensation early-returns and the walk result — restructure so every exit path flows through one tail):

```typescript
  // M5-L2: a CHILD instance's drive that settled a parent-consumable terminal
  // notifies the parent (tickle + DO-alarm self-heal). One seam for every driver
  // path — workflow, direct callbacks, inline resume. Suppressed only for the
  // synchronous inline child start under the parent's own held drive lock.
  if (!opts.suppressParentNotify) {
    try {
      const after = await loadInst(env, instanceId);
      if (after.parent_instance_id && PARENT_CONSUMABLE_CHILD_STATUSES.has(after.status)) {
        await notifyParentOfChildTerminal(env, after);
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", message: "parent notify failed", instanceId, error: err instanceof Error ? err.message : String(err) }));
    }
  }
```

Gate the extra `loadInst` read: skip it entirely when the pre-drive `inst.parent_instance_id` was NULL (root instances pay zero — reuse the `inst` loaded at `engine.ts:237`).

`src/runtime/wake.ts` `wakeBackstop` — cap the backstop while a child is in flight (spec §3.4 "make the child-wait path explicitly short"):

```typescript
  // M5-L2: a parent parked on an invoked child self-heals via the child-notify DO
  // alarm; cap the wake backstop at CHILD_WAIT_BACKSTOP_MS as the second net.
  const invokedChild = await dbFirst<{ n: number }>(env.DB,
    `SELECT COUNT(*) AS n FROM child_instances WHERE parent_instance_id = ? AND status = 'invoked'`, [instanceId]);
  if ((invokedChild?.n ?? 0) > 0) ms = Math.min(ms, CHILD_WAIT_BACKSTOP_MS);
```

(Import from `call-activity.ts`; if that creates an import cycle with engine.ts, move `CHILD_WAIT_BACKSTOP_MS` into `wake.ts` and import it from there in call-activity.ts.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/integration/call-activity-forward.test.ts && npm run test:integration && npm run test:unit && npm run typecheck`
Expected: PASS (the errored-path test does not exist yet; existing suites green — the no-op gate).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/call-activity.ts src/runtime/engine.ts src/runtime/wake.ts src/persistence/saga.ts tests/integration/call-activity-forward.test.ts tests/integration/call-activity-fixtures.ts
git commit -m "feat(m5-l2): forward callActivity lifecycle — idempotency triad, apply-once decider, parent notify + self-heal"
```

---

### Task 7: Child error settle (`errored`) + parent routing

**Files:**
- Modify: `src/runtime/engine.ts` (error-end uncaught branch, `engine.ts:531-542`)
- Modify: `src/runtime/call-activity.ts` (`applyChildErrored`, `settleChildErrored`)
- Test: `tests/integration/call-activity-errors.test.ts`

**Interfaces:**
- Consumes: `errorCatchTarget` (`forward-task.ts:100`), `drainScopeSubtree`, `createIncident`.
- Produces: a child instance settles `status='errored'` + `error_code` instead of a root `uncaughtError` incident; the parent routes it exactly like a worker business error thrown by the callActivity node.

- [ ] **Step 1: Write the failing tests**

`tests/integration/call-activity-errors.test.ts` using `CALL_CHILD_BPMN` + `CALL_PARENT_BPMN` (Task 6 fixtures):

1. **Boundary catch:** start parent with `{failChild: true}`, pump. Assert: child ends `status='errored'`, `errorCode='CHILD_FAILED'` (NOT `incident`; no `uncaughtError` incident on the child); parent routes via `call1-err` → `p-handle` runs (log-only job exists) → parent completes on `p-end2`; parent history has `callActivityErrored` with the child id.
2. **Bubble to scope:** variant parent fixture with the error boundary on the enclosing `p-tx` instead of `call1` → the scope catches; assert `scopeExited` audit + boundary path taken.
3. **Uncaught at parent root:** variant parent with NO matching boundary → parent gets an `uncaughtError` incident naming `call1`; parent status `incident`; child remains `errored`.
4. **Child technical incident does NOT notify:** child variant whose task is `always-fail` (retries exhaust) → child `status='incident'`; parent still `waiting` on `call1` (no transition), no parent incident.

Run: expected FAIL (child currently settles `uncaughtError` incident at its own root).

- [ ] **Step 2: Child-side settle**

`src/runtime/engine.ts`, in the error-end **uncaught** branch (currently `createIncident(...uncaughtError)`, `engine.ts:531-542`) — fork on parentage:

```typescript
          const instForErr = await loadInst(env, instanceId);
          if (instForErr.parent_instance_id) {
            // M5-L2 (spec §4): a CHILD's uncaught error end is a TERMINAL WITH A
            // CODE for the parent to route — never a child-local uncaughtError.
            await runStep(`err-end:${tag}`, () => settleChildErrored(env, instanceId, cur, node.errorCode ?? null, occ));
            return { kind: "incident" }; // walk stops; D1 'errored' is the truth (not an incident row)
          }
          await runStep(`err-end:${tag}`, () => createIncident(/* … existing uncaughtError call unchanged … */));
```

`settleChildErrored` in `call-activity.ts`:

```typescript
export async function settleChildErrored(env: Env, instanceId: string, elementId: string, errorCode: string | null, occ: number): Promise<void> {
  const inst = await loadInst(env, instanceId);
  if (isTerminalInstanceStatus(inst.status)) return; // idempotent / never regress
  const now = nowIso();
  await dbBatch(env.DB, [
    stmt(env.DB, `UPDATE process_instances SET status='errored', error_code=?, current_element_id=?, completed_at=?, updated_at=? WHERE instance_id=? AND status NOT IN ('completed','incident','compensated','compensationFailed','cancelled','errored')`,
      [errorCode, elementId, now, now, instanceId]),
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "childErrored", diagnostics: { errorCode, occurrence: occ } }),
  ]);
}
```

The post-drive notify hook (Task 6) fires on `errored` automatically.

- [ ] **Step 3: Parent-side routing**

`applyChildErrored` in `call-activity.ts` (mirror the worker business-error apply in `forward-task.ts` `handleForwardFailure` — read it first):

```typescript
async function applyChildErrored(env, instanceId, graph, elementId, occ, node, row, child, activeTokenId): Promise<CallOutcome> {
  const inst = await loadInst(env, instanceId);
  const now = nowIso();
  const applyFlip = markChildOutputAppliedStmt(env.DB, { parentInstanceId: instanceId, parentElementId: elementId, occurrence: occ, iterationIndex: 0, now });
  const target = errorCatchTarget(graph, elementId, child.error_code);
  if (target) {
    if (target.hostIsScope) await drainScopeSubtree(env, graph, instanceId, target.hostId); // idempotent retain-only
    await dbBatch(env.DB, [
      applyFlip,
      historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "callActivityErrored",
        diagnostics: { childInstanceId: row.child_instance_id, errorCode: child.error_code, caughtBy: target.boundaryId, occurrence: occ, ...branchHistoryTags(activeTokenId) } }),
      ...(target.hostIsScope
        ? [historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId: target.hostId, type: "scopeExited", diagnostics: { scope: target.hostId, via: target.boundaryId, abnormal: true } })]
        : []),
      applyTransitionStmt(env.DB, { instanceId, currentElementId: target.next, status: "running", now }),
    ]);
    return { kind: "next", next: target.next };
  }
  await dbBatch(env.DB, [applyFlip,
    historyStmt(env.DB, { workspaceId: inst.workspace_id, instanceId, elementId, type: "callActivityErrored",
      diagnostics: { childInstanceId: row.child_instance_id, errorCode: child.error_code, occurrence: occ } })]);
  await createIncident(env, instanceId, elementId, 0,
    `Call activity child errored ('${child.error_code}') with no matching error boundary up the scope chain.`,
    { childInstanceId: row.child_instance_id, errorCode: child.error_code }, "uncaughtError");
  return { kind: "incident" };
}
```

NOTE the scope-caught drain ordering caveat from `forward-task.ts:141-167`: the flip and the drain are not one atomic unit here either — the batch flips `outputApplied` and the fast-forward (`appliedCallOutcome`) re-derives the same deterministic target, so mirror the existing self-heal: in `appliedCallOutcome`'s errored branch, when `target.hostIsScope` and no `scopeExited` row exists, re-run the idempotent drain (copy the `countHistoryEventsOfType` guard).

- [ ] **Step 4: Run + commit**

Run: `npx vitest run tests/integration/call-activity-errors.test.ts && npm run test:integration && npm run typecheck` — Expected: PASS.

```bash
git add src/runtime/engine.ts src/runtime/call-activity.ts tests/integration/call-activity-errors.test.ts
git commit -m "feat(m5-l2): child errored terminal + parent error routing (boundary / bubble / uncaughtError)"
```

---

### Task 8: Cascading drain/cancel — timer Hazard on callActivity, subtree drain, operator cancel cascade

**Files:**
- Modify: `src/runtime/call-activity.ts` (`cancelChildCascade`, `cancelChildrenInSubtree`)
- Modify: `src/runtime/compensation.ts` (`drainScopeSubtree` — child cascade hook)
- Modify: `src/runtime/boundary-timer.ts` (callActivity-host fire settle)
- Modify: `src/index.ts` (`handleCancelInstance` cascade; export/move `releaseActiveSubscriptionsForInstance` if TASK-72 has not already relocated it)
- Test: `tests/integration/call-activity-drain.test.ts`

**Interfaces:**
- Consumes: `abandonActiveForwardJobs`, `cancelArmedTimersForInstance`, the subscription-release helper (post-TASK-72 location — search `releaseActiveSubscriptions` first), `transitionStatusGuarded`, `getExecutor(env).terminate`.
- Produces:
  - `cancelChildCascade(env, childInstanceId): Promise<void>` — depth-first recursive cancel of a NON-terminal child: grandchildren first, then abandon jobs / release subscriptions / cancel timers / terminate Workflow / CAS `{starting,running,waiting,incident} → cancelled` + `instanceCancelled {by:"parentDrain"}` history. Never regresses a terminal or `compensating` child. Ledger retained.
  - `cancelChildrenInSubtree(env, graph, instanceId, rootScopeId): Promise<void>` — for every `callActivity` node whose `scopeId` is in `subtreeScopeIds(graph, rootScopeId)` (or any scope for `rootScopeId=null`), cascade-cancel its non-terminal children (query `child_instances` by `(parent_instance_id, parent_element_id)`, join child status).

- [ ] **Step 1: Write the failing tests**

`tests/integration/call-activity-drain.test.ts`:

1. **Timer Hazard on the callActivity:** parent fixture with a short `PT0.5S` timer boundary on `call1` and a child that parks on a never-completed task. Fire the timer (drive the DO alarm path the way `tests/integration/boundary-timer.test.ts` does — read it). Assert: parent takes the boundary path; child is `cancelled` (history `instanceCancelled {by:"parentDrain"}`); the child's forward job is abandoned; NO compensation ran (Hazard semantics); the child's ledger rows are retained.
2. **Error-bubble drain cancels the child:** parent where a SIBLING task inside the same subProcess throws a caught business error while `call1`'s child is running → the scope drain cancels the child.
3. **Operator cancel cascades:** parent (no tx) with a running child → `POST /instances/{parent}/cancel` → child `cancelled`, grandchild too (3-level fixture: parent→mid→leaf, depth 3 ≤ 4); parent `cancelled` (empty ledger) or `compensating` per existing semantics.
4. **Never regress:** cancel a parent whose child already `completed` → child stays `completed` (its ledger intact for the reverse pass — Task 9 asserts the reverse actually runs).

Run: expected FAIL.

- [ ] **Step 2: Implement the cascade helpers** (in `call-activity.ts`)

```typescript
export async function cancelChildCascade(env: Env, childInstanceId: string): Promise<void> {
  const child = await getInstanceRow(env.DB, childInstanceId);
  if (!child || isTerminalInstanceStatus(child.status) || child.status === "compensating") return;
  for (const gc of await listChildrenOfInstance(env.DB, childInstanceId)) {
    await cancelChildCascade(env, gc.child_instance_id); // depth-first, bounded by MAX_CALL_DEPTH
  }
  const now = nowIso();
  await abandonActiveForwardJobs(env.DB, childInstanceId, now);
  await releaseActiveSubscriptionsForInstance(env, childInstanceId, now); // post-TASK-72 helper; defensive even though v1 rejects child message waits
  await cancelArmedTimersForInstance(env, childInstanceId);
  await getExecutor(env).terminate(childInstanceId);
  const changed = await transitionStatusGuarded(env.DB, childInstanceId, ["starting", "running", "waiting", "incident"], "cancelled", now);
  if (changed > 0) {
    await historyStmt(env.DB, { workspaceId: child.workspace_id, instanceId: childInstanceId, elementId: child.parent_element_id ?? "", type: "instanceCancelled", diagnostics: { by: "parentDrain" } }).run();
  }
}

export async function cancelChildrenInSubtree(env: Env, graph: ExecutionGraph, instanceId: string, rootScopeId: string | null): Promise<void> {
  const subtree = rootScopeId == null ? null : new Set(subtreeScopeIds(graph, rootScopeId));
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.type !== "callActivity") continue;
    const s = node.scopeId ?? null;
    if (subtree != null && (s == null || !subtree.has(s))) continue;
    for (const c of await listChildrenByElement(env.DB, instanceId, id)) { // add to child-instances.ts: rows for (parent, element)
      if (!isTerminalInstanceStatus(c.child_status) && c.child_status !== "compensating") await cancelChildCascade(env, c.child_instance_id);
    }
  }
}
```

If `releaseActiveSubscriptionsForInstance` is still private in `index.ts` after TASK-72, move it to a new `src/runtime/instance-release.ts` and import from both sites.

- [ ] **Step 3: Hook the drain sites**

1. `drainScopeSubtree` (`compensation.ts:357`): append at the end: `await cancelChildrenInSubtree(env, graph, instanceId, rootScopeId);` (idempotent — a cancelled child short-circuits).
2. Timer boundary directly ON a callActivity: in `src/runtime/boundary-timer.ts`, find the fire-settle path that abandons a task host's forward job (search `abandonJobOnTimerFireStmt`); where the host node's type is `callActivity`, after the fire batch commits, cancel that visit's child: read `getChildInstanceForVisit(db, instanceId, hostElementId, occ)` → non-terminal → `cancelChildCascade`. Also verify `timer_outcomes`' fired decider makes the parent's rewalk fast-forward down the boundary path (Task 6's `timerHasFired` check at the top of `driveCallActivity` covers it).
3. Operator cancel: in `handleCancelInstance`, after `cancelArmedTimersForInstance` (`index.ts:464`): `await cancelChildrenInSubtree(env, graph, instanceId, null);`

- [ ] **Step 4: Run + commit**

Run: `npx vitest run tests/integration/call-activity-drain.test.ts && npm run test:integration && npm run typecheck` — Expected: PASS.

```bash
git add src/runtime/call-activity.ts src/runtime/compensation.ts src/runtime/boundary-timer.ts src/index.ts src/persistence/child-instances.ts tests/integration/call-activity-drain.test.ts
git commit -m "feat(m5-l2): cascading child cancel — subtree drain, callActivity timer Hazard, operator cancel"
```

---

### Task 9: Child compensation — reverse-pass dispatch, CAS entry, no-op shortcut, compensationFailed

**Files:**
- Modify: `src/runtime/compensation.ts` (`runCompensation` step dispatch, `compensation.ts:202-231`)
- Modify: `src/runtime/call-activity.ts` (`beginChildCompensation`)
- Test: `tests/integration/call-activity-compensation.test.ts`

**Interfaces:**
- Consumes: `SagaStepView.childInstanceId` (Task 4), `transitionStatusGuarded`, `resumeInline`, `countCompensableSteps`, `subtreeScopeIds`/`eligibleCommittedLocalScopeIds` (child-graph-scoped), `markStepCompensated`/`markStepCompensationFailed` (existing, reused verbatim).
- Produces: `beginChildCompensation(env, step: SagaStepView): Promise<void>` — CAS `{completed,cancelled} → compensating` + `transactionCancelled {by:"parentCompensation"}` history (element-less → the child's resume derives the PROCESS-ROOT reverse pass, `engine.ts:244-251`), empty-ledger shortcut straight to `compensated`, then a suppressed inline drive.

- [ ] **Step 1: Write the failing tests**

`tests/integration/call-activity-compensation.test.ts` (fixtures from Task 6 — `CALL_PARENT_BPMN` has `p-charge` (comp `refund-card`) + `call1` inside `p-tx` with a steerable `failSettle` cancel end; `CALL_CHILD_BPMN`'s tx has `c-reserve` (comp `release-stock`)):

1. **Committed callActivity compensates via the child's reverse pass:** run parent with `{failSettle: true}`, pump. The cancel end starts the parent reverse pass. Assert order: `release-stock` (child's compensator) job runs and completes, then `refund-card`; child ends `compensated`; parent settles per the cancel boundary path; the parent's `call1` saga step is `compensated`.
2. **No-op compensator:** child variant with NO transaction (plain `echo`) → committed child has an empty compensable ledger → on parent cancel the child CAS-es to `compensating` and settles `compensated` immediately (no comp job), parent reverse continues without parking on it.
3. **Child compensationFailed surfaces as the parent's own:** run with `{failSettle: true, refundFails: false}` but child compensator forced to fail (child started with `releaseFails`-style steering — add a steerable branch to the `release-stock` sample worker in `src/runtime/service-task.ts`: `releaseFails === true → failed`). Child ends `compensationFailed`; parent gets a `compensationFailure` incident on `call1` and status `compensationFailed`. Then **cascading retry heals it**: `POST /instances/{parent}/retry` (Task 10 wires the cascade — write this assertion now, mark `it.skip` until Task 10, unskip there).
4. **Interrupted (cancelled) child still reverses its committed steps:** child whose tx COMMITS then parks on a second task; parent cancel cascade cancels the child mid-flight (Task 8), then the parent reverse pass drives the cancelled child's reverse → `release-stock` runs; child `compensated`.
5. **Idempotent double entry:** after the reverse settles, force a duplicate parent drive → no second child CAS, no duplicate compensation job (assert job count).

Run: expected FAIL.

- [ ] **Step 2: Implement the dispatch** in `runCompensation`, replacing the unconditional job-based block (`compensation.ts:205-216`) with a step-kind fork:

```typescript
    if (step.childInstanceId) {
      // M5-L2 (spec §5): child-instance step — compensate by driving the child's
      // OWN reverse pass. All step issuances below are gated on child status reads
      // (memoization safety); the child's terminal tickles the parent (comp-wake).
      const child = await getInstanceRow(env.DB, step.childInstanceId);
      if (!child) { await runStep(`comp-done:${ctag}`, () => markStepCompensated(env, instanceId, step)); continue; } // defensive: no child = nothing to undo
      if (child.status === "compensated") {
        await runStep(`comp-done:${ctag}`, () => markStepCompensated(env, instanceId, step));
        continue;
      }
      if (child.status === "compensationFailed") {
        await runStep(`comp-fail:${ctag}`, () => markStepCompensationFailed(env, instanceId, step));
        return "failed";
      }
      if (child.status === "completed" || child.status === "cancelled") {
        await runStep(`comp-child:${ctag}`, () => beginChildCompensation(env, step));
        continue; // re-read the child on the next pass — the shortcut may have settled it synchronously
      }
      // child 'compensating' (or a late 'incident' inside its reverse) → park.
      if (!waitFor) return "waiting";
      const timeout = await wakeBackstop(env, instanceId);
      try { await waitFor({ name: `comp-wake#${compWakeSeq}`, workflowEventType: WAKE_TYPE, timeout }); } catch { /* self-heal: re-read */ }
      compWakeSeq += 1;
      continue;
    }
    // …existing worker-task block unchanged…
```

**Loop-guard caveat:** the `continue` after `beginChildCompensation` re-reads the ledger; the child is now `compensating` (parks) or `compensated` (advances) — it cannot spin, because `beginChildCompensation` always moves the child out of `{completed,cancelled}`.

- [ ] **Step 3: Implement `beginChildCompensation`** (in `call-activity.ts`):

```typescript
export async function beginChildCompensation(env: Env, step: SagaStepView): Promise<void> {
  const childId = step.childInstanceId!;
  const child = await getInstanceRow(env.DB, childId);
  if (!child || !["completed", "cancelled"].includes(child.status)) return; // idempotent: someone already entered
  const now = nowIso();
  const changed = await transitionStatusGuarded(env.DB, childId, ["completed", "cancelled"], "compensating", now);
  if (changed === 0) return; // lost the CAS — the winner owns the reverse
  // Element-less cancel marker → the child's compensation resume derives the
  // PROCESS-ROOT reverse pass (engine.ts:244: non-transaction element → root null).
  await historyStmt(env.DB, { workspaceId: child.workspace_id, instanceId: childId, elementId: child.parent_element_id ?? "", type: "transactionCancelled", diagnostics: { by: "parentCompensation", parentInstanceId: step.instanceId ?? undefined } }).run();
  const childGraph = await loadGraphForInstance(env, childId);
  const pending = await countCompensableSteps(env.DB, childId, subtreeScopeIds(childGraph, null), eligibleCommittedLocalScopeIds(childGraph, null));
  if (pending === 0) {
    // No-op compensator (spec §5.1): nothing committed → settle immediately.
    await transitionStatusGuarded(env.DB, childId, ["compensating"], "compensated", now);
    await historyStmt(env.DB, { workspaceId: child.workspace_id, instanceId: childId, elementId: childGraph.processId, type: "compensationCompleted", diagnostics: { outcome: "compensated", emptyLedger: true } }).run();
    return;
  }
  // Drive the (terminated) child's reverse pass inline — the operator-resume-after-
  // termination path (executor.ts deliverJobResult fallback) carries its comp jobs.
  // suppressParentNotify: this call sits inside the PARENT's own drive; the parent
  // loop re-reads the child status right after (dispatch `continue`).
  await runInstance(env, childId, { runStep: inlineStep, waitFor: null, suppressParentNotify: true });
}
```

(`inlineStep` = the local `<T>(_n, fn) => fn()` helper; `SagaStepView` may not carry `instanceId` — check `saga.ts:48` and drop the diagnostic field if absent.)

Also check the transitionStatusGuarded/terminal-guard interplay: `transitionStatusGuarded` (`instances.ts:151`) is a plain status-list CAS — confirm it does NOT special-case terminal statuses (it must allow `completed → compensating` here; if a terminal guard blocks it, add a dedicated `enterChildCompensationStmt` with the explicit `WHERE status IN ('completed','cancelled')`). The engine's own terminal guard (`runInstanceInner`'s `isTerminalInstanceStatus` early-return at `engine.ts:252`) is bypassed naturally: by the time the child is driven its status is `compensating`, which resumes the reverse pass at `engine.ts:244`.

- [ ] **Step 4: Run + commit**

Run: `npx vitest run tests/integration/call-activity-compensation.test.ts && npm run test:integration && npm run typecheck` — Expected: PASS (except the deliberately `it.skip`-ped cascade-retry case).

```bash
git add src/runtime/compensation.ts src/runtime/call-activity.ts src/runtime/service-task.ts tests/integration/call-activity-compensation.test.ts
git commit -m "feat(m5-l2): committed-callActivity compensation — child reverse pass, CAS entry, no-op shortcut, compensationFailed surfacing"
```

---

### Task 10: Operator verbs — 409 on children, cascading retry

**Files:**
- Modify: `src/index.ts` (`handleCancelInstance` `index.ts:431`, `handleRetryInstance` `index.ts:519`)
- Test: `tests/integration/call-activity-operator.test.ts` (+ unskip Task 9's case 3)

**Interfaces:**
- Produces: direct `cancel`/`retry` on an instance with `parent_instance_id` → `409` naming the parent; `handleRetryInstance` cascades depth-first into child incidents (`retryChildSubtree(env, instanceId, now): Promise<boolean>`).

- [ ] **Step 1: Write the failing tests**

1. `POST /instances/{child}/cancel` and `/retry` → 409; body message contains the parent instance id.
2. **Cascading retry:** parent waiting on a child whose task exhausted retries (child `incident`). `POST /instances/{parent}/retry` → child incident resolved + child re-driven; pump → child completes → parent completes. Assert parent history gains `operatorRetry {target:"childSubtree"}`.
3. Unskip Task 9 case 3 (retry heals a child `compensationFailed` through the parent).

Run: expected FAIL.

- [ ] **Step 2: Implement**

Guard at the top of BOTH handlers (after the NotFound check; use `getInstanceRow` for the raw column):

```typescript
  const raw = await getInstanceRow(env.DB, instanceId);
  if (raw?.parent_instance_id) {
    throw new ConflictError(`Instance ${instanceId} is a callActivity child of ${raw.parent_instance_id} — operate on the saga root.`);
  }
```

Cascade in `handleRetryInstance`, before the parent's own status checks:

```typescript
  const cascaded = await retryChildSubtree(env, instanceId, now);
  if (cascaded) {
    await recordHistory(env.DB, { workspaceId: inst.workspaceId, instanceId, type: "operatorRetry", diagnostics: { target: "childSubtree" } });
    await resumeInline(env, instanceId); // re-drive the parent so a now-completed child applies
    return handleGetInstance(env, instanceId);
  }
```

`retryChildSubtree` (index.ts-local; extract the two retry bodies into a helper it can reuse):

```typescript
/** Depth-first operator-retry cascade (spec §4/§6): heal the deepest child
 *  incidents first; returns true if anything was retried. */
async function retryChildSubtree(env: Env, instanceId: string, now: string): Promise<boolean> {
  let any = false;
  for (const c of await listChildrenOfInstance(env.DB, instanceId)) {
    if (await retryChildSubtree(env, c.child_instance_id, now)) { any = true; continue; }
    if (c.child_status === "incident" || c.child_status === "compensationFailed") {
      await retryInstanceCore(env, c.child_instance_id, undefined, now); // the extracted shared body
      any = true;
    }
  }
  return any;
}
```

Extract `retryInstanceCore(env, instanceId, variables, now)` from the two status branches of `handleRetryInstance` (`index.ts:528-567`) so the handler and the cascade share one implementation (the handler keeps its HTTP concerns: body parse, 404, 409s). The core takes the raw row (NOT the mapped instance) so it works on children.

- [ ] **Step 3: Run + commit**

Run: `npx vitest run tests/integration/call-activity-operator.test.ts tests/integration/call-activity-compensation.test.ts && npm run test:integration && npm run typecheck` — Expected: PASS, including the unskipped case.

```bash
git add src/index.ts tests/integration/call-activity-operator.test.ts tests/integration/call-activity-compensation.test.ts
git commit -m "feat(m5-l2): operator verbs — 409 on children, depth-first cascading retry"
```

---

### Task 11: Lineage API + `?root=true` + console delta

**Files:**
- Modify: `src/index.ts` (`handleGetInstance` — locate by name), `src/persistence/ui-queries.ts` (`listInstancesFiltered`, `ui-queries.ts:498`)
- Modify: `src/contracts/api.ts` (lineage types), `specs/002-saga-orchestrator/contracts/openapi.yaml`
- Modify: `spa/src/` — instance view (locate: `grep -rn "subscriptions" spa/src --include=*.tsx`), `spa/src/components/LivingDiagram.tsx`, the status humanization map (`grep -rn "compensationFailed" spa/src`)
- Test: `tests/integration/ui-console.test.ts` (extend), SPA tests under `spa/src` (`npm run test:ui`)

**Interfaces:**
- Produces: `GET /instances/{id}` response gains `lineage: { parent: { instanceId, elementId } | null, children: Array<{ elementId, occurrence, childInstanceId, status }> }`; `GET /instances?root=true` filters `parent_instance_id IS NULL`; SPA callActivity nodes link to the child, children render a parent breadcrumb, and cancel/retry controls hide when `lineage.parent` is set.

- [ ] **Step 1: Failing contract tests** — extend `tests/integration/ui-console.test.ts` (and/or the instances contract test — check `tests/contract/`): parent instance response carries `lineage.children[0].childInstanceId`; child response carries `lineage.parent.instanceId`; `GET /instances?root=true&workspaceId=…` excludes the child; without the flag it is included; `status=errored` is an accepted filter value (extend the zod query schema where the multi-status filter is parsed — search `multi-status` / the status enum in `src/contracts/api.ts` or `src/ui/http.ts`).

- [ ] **Step 2: Implement backend** — `handleGetInstance`: after fetching the instance, read `listChildrenOfInstance` + the raw row's parent columns, attach:

```typescript
  const raw = await getInstanceRow(env.DB, instanceId);
  const children = await listChildrenOfInstance(env.DB, instanceId);
  const lineage = {
    parent: raw?.parent_instance_id ? { instanceId: raw.parent_instance_id, elementId: raw.parent_element_id } : null,
    children: children.map((c) => ({ elementId: c.parent_element_id, occurrence: c.occurrence, childInstanceId: c.child_instance_id, status: c.child_status })),
  };
```

Add `InstanceLineage` to `src/contracts/api.ts`; add the `root` query param (zod `z.enum(["true","false"]).optional()`) → `listInstancesFiltered` gains `rootOnly?: boolean` → SQL `AND parent_instance_id IS NULL`. Update `openapi.yaml`: the `lineage` object on the instance response, the `root` query param, `errored` added to every instance-status enum.

- [ ] **Step 3: SPA delta** — in the instance screen: render a `Lineage` strip (parent breadcrumb link ← / children list with status chips → linking to `/instances/{childId}` — follow the existing router/navigation idiom found in the screen); hide the cancel/retry buttons when `lineage.parent != null`; in `LivingDiagram.tsx`, make nodes whose businessObject `$type === "bpmn:CallActivity"` clickable, resolving the child via `lineage.children.find(c => c.elementId === nodeId)` (highest occurrence wins). Add `errored` to the status humanization map ("Errored (child)") and `StatusBadge` colors. Follow the existing visual language (solid cards, amber-700 accents — do not invent new styles).

- [ ] **Step 4: SPA tests** — extend the SPA unit tests (see existing `spa/src/**/*.test.ts*` — humanization coverage test will FAIL until `errored` is mapped, which is the failing-test entry point): humanization covers `errored`; a lineage-strip component test (children render, parent breadcrumb renders, buttons hidden for a child).

- [ ] **Step 5: Run + commit**

Run: `npx vitest run tests/integration/ui-console.test.ts && npm run test:integration && npm run typecheck && npm run test:ui && npm run typecheck:ui && npm run build:ui`
Expected: PASS + clean SPA build.

```bash
git add src/index.ts src/persistence/ui-queries.ts src/contracts/api.ts specs/002-saga-orchestrator/contracts/openapi.yaml spa/src tests/
git commit -m "feat(m5-l2): lineage block, ?root=true filter, console parent/child navigation + errored status"
```

---

### Task 12: Reverse-path matrix — registry wave + crash/duplicate/re-drive tests

**Files:**
- Modify: `tests/matrix/registry.ts`
- Create: `tests/integration/matrix/call-activity.test.ts`
- Test: `npm run check:matrix`

**Interfaces:**
- Consumes: the `Scenario` shape (`tests/matrix/registry.ts:11-24`); the fixtures from Task 6.
- Produces: registered scenarios `CA-FWD-01`, `CA-IDEMP-REDRIVE-01`, `CA-ERR-BOUNDARY-01`, `CA-INCIDENT-RETRY-01`, `CA-HAZARD-TIMER-01`, `CA-COMP-CHILD-01`, `CA-COMP-FAILED-01`, `CA-COMP-NOOP-01`, `CA-COMP-CRASH-01`, `CA-OP-CHILD-409-01` (valid, modes `["direct","workflow"]`, `phase: 1` for direct files; workflow file `tests/workflow-mode/matrix.wf.test.ts`) + rejects `CA-REJECT-MSG-01`, `CA-REJECT-DEPTH-01`, `CA-REJECT-UNRESOLVED-01` (legality `reject`, direct-only, pointing at `tests/integration/call-activity-publish.test.ts`).

- [ ] **Step 1: Register the scenarios** in `tests/matrix/registry.ts` following the existing row shape exactly (axes like `["Activities:callActivity", "Compensation:child-reverse", …]`; risk `high` for the compensation/crash rows). Direct files: the Task 6–10 test files for scenarios those already cover (add the `[CA-…]` marker comments to the covering `it(...)` titles), and `tests/integration/matrix/call-activity.test.ts` for the new ones.

- [ ] **Step 2: Run the drift guard** — `npm run check:matrix` — Expected: FAIL listing unmarked scenarios (the guard proves the wiring).

- [ ] **Step 3: Add `[CA-…]` markers** to the covering tests from Tasks 6–10, and write `tests/integration/matrix/call-activity.test.ts` for the reverse-path matrix (spec §5):

```typescript
it("[CA-COMP-CRASH-01] parent re-drive mid child-compensation re-parks on 'compensating' (no double CAS, no duplicate comp job)", async () => {
  // Run to the point where the child is 'compensating' with a pending release-stock
  // comp job (do NOT pump it). Then simulate crash-resume: resumeInline the parent
  // twice. Assert: child still 'compensating'; exactly one release-stock comp job;
  // then pump → child compensated → parent settles.
});
it("[CA-IDEMP-REDRIVE-01] cold inline re-drive of a completed parent is write-free", async () => {
  // Complete the happy path; snapshot history count + child row; resumeInline parent;
  // assert history count unchanged, one child, status unchanged (spec exit criteria).
});
it("[CA-COMP-NOOP-01] …", …); // if not already marked in Task 9's file
```

(Direct mode simulates "crash" as inline re-drive — the rewalk IS the recovery path; the lost-tickle self-heal scenario is workflow-mode-only and lands in Task 14.)

- [ ] **Step 4: Run + commit**

Run: `npm run check:matrix && npm run test:matrix && npm run typecheck` — Expected: PASS (check:matrix green for phase-1 scenarios; workflow markers are phase-gated exactly like existing rows — copy an existing dual-mode row's phase discipline).

```bash
git add tests/matrix/registry.ts tests/integration/matrix/call-activity.test.ts tests/integration/call-activity-*.test.ts
git commit -m "test(m5-l2): matrix registry wave + reverse-path crash/idempotency scenarios"
```

---

### Task 13: Docs lockstep — 09-profile, 02-activities fix, check-docs cap sync, CLAUDE.md, quickstart

**Files:**
- Modify: `docs/bpmn/09-easy-bpmn-profile.md`, `docs/bpmn/02-activities.md:68`, `scripts/check-docs.mjs`, `CLAUDE.md`, `specs/002-saga-orchestrator/spec.md` (+ `data-model.md` if it lists tables), `specs/002-saga-orchestrator/contracts/runtime-contracts.md`

**Interfaces:** none (docs only; `npm run check:docs` is the verification).

- [ ] **Step 1: 09-profile** — flip callActivity to accepted-and-validated **shipped in M5-L2**; document (spec §8): io-mapping = pass-through both ways (Zeebe-aligned default; explicit divergence note from OMG/Camunda-7 "no data crosses"); `easy-bpmn:ioMapping` deferred; publish-time version binding (runtime `latest` not honored — `camunda:calledElementBinding` tolerated-and-ignored); the v1 message-wait call-tree reject; `MAX_CALL_DEPTH = 4`; child operator verbs 409 (operate via root); the `errored` child terminal.
- [ ] **Step 2: 02-activities.md:68** — replace "Requires explicit in/out data mapping" with the pass-through default + a note that standard BPMN requires explicit mapping and easy-bpmn deliberately diverges (Zeebe-aligned).
- [ ] **Step 3: check-docs** — read `scripts/check-docs.mjs` (the `MAX_SCOPE_DEPTH` sync entry) and register `MAX_CALL_DEPTH` the same way, so every docs copy must equal the engine source value. Run `npm run check:docs` — expected PASS.
- [ ] **Step 4: CLAUDE.md** — update the M5 paragraph: M5-L1 → "M5-L1 + M5-L2 shipped"; add `MAX_CALL_DEPTH = 4` to the caps paragraph; next layer = M5-L3 multiInstance. Update `spec.md`'s layer status and `runtime-contracts.md` (child_instances table, `errored` status, lineage block) if those files enumerate them — mirror how M5-L1 amended them (read the M5-L1 commits for the pattern: `git log --oneline --grep m5-l1 -- specs/`).
- [ ] **Step 5: Run + commit**

Run: `npm run check:docs && npm run check:matrix` — Expected: PASS.

```bash
git add docs/ scripts/check-docs.mjs CLAUDE.md specs/
git commit -m "docs(m5-l2): profile + canonicity lockstep, MAX_CALL_DEPTH doc sync, CLAUDE.md layer status"
```

---

### Task 14: Workflow-mode validation, real-CF smoke, PR

**Files:**
- Modify: `tests/workflow-mode/matrix.wf.test.ts` (+ its harness — read `tests/workflow-mode/` and the `test:wf` script first)

**Interfaces:**
- Consumes: the `npm run test:wf` wrangler-dev harness (memory: clean `.wrangler/state` per run, kill `workerd serve` by PID); the real-CF smoke process used for M5-L1/TASK-54 (deployed Worker at `bpmn.rntme.com`).

- [ ] **Step 1: Workflow-mode scenarios** — add the `[CA-…]` workflow-mode markers to `tests/workflow-mode/matrix.wf.test.ts` for: the forward happy path (child Workflow really created; parent single-wake survives the child terminating before the parent parks — the **dropped-tickle self-heal**: assert the parent reaches terminal well under the 1h backstop), the compensation path (child reverse over a TERMINATED child Workflow — the operator-resume-after-termination path this project cannot CI), and `CA-COMP-CRASH-01`'s workflow twin. Run `npm run test:wf` locally. Scenarios that only reproduce on real CF get the `@needs-real-cf` tag (existing convention).
- [ ] **Step 2: Full local gate**

```bash
npm run test && npm run test:matrix && npm run check:docs && npm run check:matrix && npm run typecheck && npm run typecheck:ui && npm run build:ui && npx wrangler deploy --dry-run
```

Expected: ALL PASS.

- [ ] **Step 3: Real-CF smoke (MANDATORY gate — TASK-54 precedent)** — deploy the branch to a preview (or coordinate with the user for the production Worker), then over the public HTTP API: publish child+parent, run (a) forward happy path, (b) `failSettle` compensation with the child reverse pass, (c) the dropped-tickle timing check (child completes fast; parent must settle promptly, not in ~1h). Record Worker version ids and outcomes in the PR description. **If any smoke scenario hangs, STOP and debug before merging** (single-wake defects only reproduce here).
- [ ] **Step 4: PR**

```bash
git push -u origin m5-l2-call-activity
gh pr create --title "M5-L2: callActivity — reusable sub-saga (child instances, hierarchical compensation across instances)" --body "…summary per spec §1-§9, smoke evidence, constitution check pointer…

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01SaE7nknZ52uJG4tind9t5D"
```

Then update the backlog per the Backlog.md workflow (create the M5-L2 layer tasks as flat TASK-NN entries marked Done against the PR, mirroring the M5-L1 pattern — TASK-64..70).

---

## Execution notes

- **Task order is strict** for 1→6 (each produces types/rows the next consumes); 7–10 are sequential over shared files; 11–13 can interleave; 14 is last.
- **The memoization rule is the #1 correctness trap** (Global Constraints): never let a `runStep` body return "not ready". If a new step seems to need polling, restructure so the D1 read happens outside the step.
- **The second trap is the direct-mode lock re-entry**: any NEW site that drives a child synchronously from inside a parent drive must pass `suppressParentNotify: true` and re-read the child afterward.
- If TASK-71..73 moved `drainScopeSubtree` / subscription-release code, re-locate by content; the cascade hook of Task 8 goes wherever the drain now lives.
