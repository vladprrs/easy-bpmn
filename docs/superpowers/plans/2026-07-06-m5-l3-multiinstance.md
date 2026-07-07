# M5-L3 multiInstance (Data-Driven Fan-Out) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement M5-L3 dper `docs/superpowers/specs/2026-07-06-m5-l3-multiinstance-design.md` — `multiInstanceLoopCharacteristics` (parallel + sequential) on serviceTask/subProcess/callActivity: FEEL cardinality/collection with a persisted activation decider, per-iteration execution keyed by `iteration_index`, `completionCondition` with non-compensating cancel-remaining, output aggregation by index, per-iteration compensation via `miBody` scopes, the body-aware `MAX_MI_CARDINALITY` cap with the `miCardinality` incident, the step-free park mitigation, and the thin lineage/console delta.

**Architecture:** A dedicated `src/runtime/multi-instance.ts` driver (mirroring `call-activity.ts`) dispatched from `driveLeaf` when `node.multiInstance != null`. One MI arrival = one walk occurrence; iterations are a second dimension `iterationIndex` (the `child_instances` 0008 precedent, extended to `service_task_jobs` + `saga_steps` in migration 0009). The `mi_activations` row is the `gateway_decisions` analogue (cardinality pinned once) and carries the early-settle + apply-once deciders. Iterations reuse the existing per-kind drivers with an `iterationIndex` thread; subProcess bodies run per-iteration branch tokens (`…:el#occ:mi#i`) walked by the driver via the shared `driveLeaf`. Every MI activity contributes a `miBody` ScopeMeta, which makes the shipped M5-L1 subtree machinery (reverse cursor, stragglers, drain) see iterations with zero algorithm change.

**Tech Stack:** Cloudflare Workers (TypeScript), D1, Durable Objects, Cloudflare Workflows, bpmn-moddle, feelin, Vitest + `@cloudflare/vitest-pool-workers` (direct mode), `wrangler dev` for workflow mode.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-06-m5-l3-multiinstance-design.md` ("design §N" below). Where this plan is more detailed, the plan wins.
- Governance: constitution v2.5.0 already accepts MI and pre-records `MAX_MI_CARDINALITY`; this layer only OPENS the runtime. No constitution bump — per-layer Constitution Check doc + the `docs/bpmn/09` interim-marker flip (L1/L2 precedent).
- `MAX_MI_CARDINALITY = 200`, defined in `src/runtime/engine.ts`, enforced at **runtime activation** (body-aware via publish-time `bodyStepCost`), synced by `scripts/check-docs.mjs` (`SYNCED_CONSTANTS`). Test override env: `MAX_MI_CARDINALITY_OVERRIDE`.
- New incident kind `miCardinality` must land in BOTH `IncidentKind` (`src/persistence/instances.ts:855`) and the openapi `Incident.kind` enum, or `check:docs` #7 fails. Runtime FEEL failures at MI activation reuse `conditionFailure`.
- Iteration keys: `iteration_index INTEGER NOT NULL DEFAULT 0` — non-MI writes stay 0 everywhere. Workflow step names and job idempotency keys gain an `@${i}` suffix **only when `i > 0`** — every pre-L3 step name/key stays byte-identical (replay safety).
- **Workflow-step memoization discipline** (unchanged): a `runStep` body's result is memoized by NAME. Gate every step issuance on a D1 predicate read OUTSIDE the step.
- Backward compatibility: all existing M1–M5-L2 tests MUST pass without edits, EXCEPT the three MI-interim-reject tests this layer deliberately flips (`tests/unit/bpmn-validator.test.ts:113-117`, `tests/unit/validator-call-activity.test.ts:36-41`, `tests/matrix/reject.test.ts` `[R-MI-SUBPROC-01]`) and the matrix count literals (`tests/matrix/registry.test.ts` 86/19, `scripts/check-matrix.mjs:87` 86). Graphs without MI nodes take zero new code paths (the no-op gate); the step-free park (Task 4) is the one deliberate behavior change for existing graphs (step-count only, never state).
- All CI tests run direct mode. Finish every task with `npm run typecheck` (vitest does not typecheck). Full check per task: `npm run test:unit && npm run test:integration && npm run typecheck`.
- Commit style: `feat(m5-l3): …` / `fix(m5-l3): …` / `test(m5-l3): …` / `docs(m5-l3): …`.
- Code and docs are English. No custom `bpmn:`-namespace notation; the collection binding is the constitution-named `easy-bpmn:multiInstance` extension element.
- File anchors (`file.ts:NNN`) are from `main` @ `44f924d` — re-locate by content when drifted.

---

### Task 1: Governance opening — branch, Constitution Check, 09-profile marker

**Files:**
- Create: `specs/002-saga-orchestrator/m5-L3-constitution-check.md`
- Modify: `docs/bpmn/09-easy-bpmn-profile.md` (interim marker flip only)

**Interfaces:**
- Consumes: constitution v2.5.0 M5 amendment; the M5-L3 design spec.
- Produces: branch `m5-l3-multi-instance`; the recorded per-layer Constitution Check every later task cites.

- [ ] **Step 1: Cut the branch**

```bash
cd /home/coder/project && git checkout main && git pull && git checkout -b m5-l3-multi-instance
```

- [ ] **Step 2: Write the per-layer Constitution Check**

Create `specs/002-saga-orchestrator/m5-L3-constitution-check.md` mirroring `specs/002-saga-orchestrator/m5-L2-constitution-check.md` (read it first): H1 `# M5-L3 Constitution Check (pre-implementation, against constitution v2.5.0)`; front-matter bold fields (**Milestone** M5-L3, **Recorded** 2026-07-06, **Constitution version checked against** "v2.5.0 (unchanged — no new amendment for this layer)", **Spec source** linking decomposition §6 M5-L3 + the layer design + this plan); `## Two required gate checks`; `## Per-principle confirmation for the M5-L3 layer` (I: MI accepted v2.5.0, data-binding + no-cardinality-source rejects are the constitution's permanent rejects, XSD-valid/round-trip unchanged — `easy-bpmn:multiInstance` is ordinary extension content; II: immutable versions untouched, MI-callActivity reuses the pinned binding; III: the `mi_activations` decider + iteration-keyed idempotency extend the at-least-once/single-apply discipline; IV: verbatim — MI introduces no correlation surface (body message waits v1-rejected); V: every new transition writes D1 history (`miActivated`/`miIterationCompleted`/`miCompletionConditionMet`/`miCompleted`), inspection stays D1-only; VI: per-iteration compensation via `pending` miBody rows + the existing reverse cursor, Cancel-only trigger unchanged, cancel-remaining is NORMAL discard never compensation). `## Complexity Tracking` table records the deliberate v1 narrowings: the MI-subProcess body whitelist (no message waits / event gateway / nested scopes / nested MI / AND-OR gateways), the deferred compensate-MI-as-a-unit boundary, and behavior=`All`-only. Close "Result: **PASS**".

- [ ] **Step 3: Flip the `docs/bpmn/09` interim marker for multiInstance only**

In `docs/bpmn/09-easy-bpmn-profile.md:481-485`, change the `multiInstanceLoopCharacteristics` bullet from "accepted (v2.5.0), runtime not yet open — publish still rejects (interim)" to "**runtime opening in this layer (M5-L3, in progress)**", leaving escalation/signal/event-subprocess interim-rejected. Do NOT touch the other flip sites yet (Task 13 does the full sweep).

- [ ] **Step 4: Commit**

```bash
git add specs/002-saga-orchestrator/m5-L3-constitution-check.md docs/bpmn/09-easy-bpmn-profile.md
git commit -m "docs(m5-l3): constitution check + 09-profile runtime-opening marker for multiInstance"
```

---

### Task 2: Graph types + moddle extension + validator acceptance (pure, no DB)

**Files:**
- Modify: `src/bpmn/graph.ts`
- Modify: `src/bpmn/moddle-extension.ts:12-28`
- Modify: `src/bpmn/validator.ts` (loop-characteristics sites `:545`, `:570`, `:596`, `:808`; `classifyContainer`; `scopeMetas` build `:1924-1936`; graph build `:1807-1990`)
- Modify: `src/runtime/expressions.ts` (add `parseFeelExpression`)
- Test: `tests/unit/validator-multi-instance.test.ts` (create), `tests/unit/bpmn-validator.test.ts:113-117` (flip), `tests/unit/validator-call-activity.test.ts:36-41` (flip)

**Interfaces:**
- Consumes: `classifyContainer(container, scopeId, scopeKind, parentScopeId, depth)` recursion; `readTaskDefinition` extension-scan pattern (validator.ts:79-91); `parseCondition` (expressions.ts:100).
- Produces (every later task relies on these exact names):

```typescript
// src/bpmn/graph.ts — new, next to TimerTriggerSpec
export interface MultiInstanceSpec {
  isSequential: boolean;
  /** Exactly one of loopCardinality | collection is set (validated at publish). */
  loopCardinality?: string | null;   // FEEL, number-valued
  collection?: string | null;        // FEEL, list-valued (easy-bpmn:multiInstance)
  elementVariable?: string | null;   // default "item" applied at runtime
  outputVariable?: string | null;    // aggregation only when present
  completionCondition?: string | null; // FEEL, boolean
  /** Static per-iteration step-cost estimate (design §6): 1 leaf; interior node count for a subProcess body; resolved child-graph count for a callActivity body (filled by call resolution). */
  bodyStepCost: number;
}
// GraphNode gains:  multiInstance?: MultiInstanceSpec | null;
```

- [ ] **Step 1: Write the failing validator tests**

Create `tests/unit/validator-multi-instance.test.ts` importing `parseAndValidate` from `src/bpmn/validator` (copy the import style of `tests/unit/validator-call-activity.test.ts`). Fixture builder:

```typescript
const MI_XML = (activity: string, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="defs" targetNamespace="http://example.com">
  ${extra}
  <bpmn:process id="proc" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="mi1"/>
    ${activity}
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="end"/>
    <bpmn:endEvent id="end"/>
  </bpmn:process>
</bpmn:definitions>`;

const MI_TASK = (loop: string, ext = "") => `<bpmn:serviceTask id="mi1" name="Fan">
  <bpmn:extensionElements><easy-bpmn:taskDefinition type="charge" retries="1"/>${ext}</bpmn:extensionElements>
  ${loop}
</bpmn:serviceTask>`;

const CARD = (n = "3", seq = "false", inner = "") =>
  `<bpmn:multiInstanceLoopCharacteristics isSequential="${seq}">
     <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">${n}</bpmn:loopCardinality>${inner}
   </bpmn:multiInstanceLoopCharacteristics>`;
const COLL_EXT = `<easy-bpmn:multiInstance collection="orders" elementVariable="order" outputVariable="results"/>`;
```

Accept tests (assert `r.ok === true` and the emitted node shape):
1. parallel cardinality MI on a serviceTask → `r.graph!.nodes["mi1"].multiInstance` matches `{ isSequential: false, loopCardinality: "3", collection: null, bodyStepCost: 1 }`; `r.graph!.scopes!["mi1"]` matches `{ kind: "miBody", parentId: null, startId: "mi1" }`.
2. sequential collection MI (`<bpmn:multiInstanceLoopCharacteristics isSequential="true"/>` + `COLL_EXT` in extensionElements) → `multiInstance` matches `{ isSequential: true, collection: "orders", elementVariable: "order", outputVariable: "results" }`.
3. `completionCondition` accepted: `CARD("5","false", `<bpmn:completionCondition xsi:type="bpmn:tFormalExpression">done = true</bpmn:completionCondition>`)` → `multiInstance.completionCondition === "done = true"`.
4. MI on a subProcess (body: none-start → serviceTask(echo) → none-end) → `scopes!["mi1"].kind === "miBody"`, `multiInstance.bodyStepCost` ≥ 1, interior nodes carry `scopeId: "mi1"`.
5. MI on a callActivity (`<bpmn:callActivity id="mi1" calledElement="child-proc">` + CARD) → accepted with `multiInstance` set AND `calledElementId: "child-proc"` (`bodyStepCost` is 1 here; call resolution refines it — Task 3).
6. error + timer boundaries attached to an MI serviceTask → accepted (reuse the boundary XML from the subProcess boundary tests).
7. tolerates camunda/zeebe MI attributes as extension content when a recognized source exists.

Reject tests (each asserts `r.ok === false` + an issue with `elementId === "mi1"` and a reason regex):
8. `standardLoopCharacteristics` → `/standard loop|loop marker/i` (distinct message, permanent).
9. MI on a `receiveTask` → `/multi-instance.*not supported on/i`; 10. MI on a `transaction` → same.
11. `loopDataInputRef` present (`CARD("3","false")` with `<bpmn:loopDataInputRef>x</bpmn:loopDataInputRef>` inside) → `/loopDataInputRef|data bindings/i`; same for `inputDataItem`.
12. no cardinality source (bare `<bpmn:multiInstanceLoopCharacteristics/>`) → `/no recognized cardinality source/i`.
13. both sources (CARD + COLL_EXT) → `/both/i`.
14. bad FEEL in `loopCardinality` (`CARD("(((")`) → parse-failure reason; bad `completionCondition` likewise.
15. `isForCompensation` on an MI activity → reject; compensation boundary ATTACHED TO the MI activity → `/compensate.*multi-instance.*deferred/i`.
16. body whitelist: MI subProcess whose body contains a `receiveTask` → `/message|receive/i` + `/multi-instance body/i`; body contains a nested `subProcess` → reject; body contains a `parallelGateway` → reject; body contains an `eventBasedGateway` → reject.
17. behavior: `<bpmn:multiInstanceLoopCharacteristics behavior="One">` → reject (only `All`).

Also FLIP the three existing interim-reject tests: `tests/unit/bpmn-validator.test.ts:113-117` — the serviceTask-MI fixture (`MULTI_INSTANCE_BPMN`, `tests/helpers.ts:748`) has no `loopCardinality`, so it now rejects with the NO-CARDINALITY-SOURCE reason: update the regex to `/no recognized cardinality source/i`. `tests/unit/validator-call-activity.test.ts:36-41` — a bare `<bpmn:multiInstanceLoopCharacteristics/>` on a callActivity likewise flips from `/M5-L3/` to the no-source reason. Leave `tests/matrix/reject.test.ts` to Task 12.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/validator-multi-instance.test.ts` — Expected: FAIL (accepts get `ok:false` with the interim wording).

- [ ] **Step 3: Moddle extension + graph types**

`src/bpmn/moddle-extension.ts` — add beside `TaskDefinition` (types array, :17-27):

```typescript
{
  name: "MultiInstance",
  superClass: ["Element"],
  properties: [
    { name: "collection", isAttr: true, type: "String" },
    { name: "elementVariable", isAttr: true, type: "String" },
    { name: "outputVariable", isAttr: true, type: "String" },
  ],
},
```

Export `export const MULTI_INSTANCE_TYPE = "easy-bpmn:MultiInstance";`. Add `MultiInstanceSpec` + `GraphNode.multiInstance` to `src/bpmn/graph.ts` exactly as in **Produces**.

`src/runtime/expressions.ts` — add a syntax-only variant next to `parseCondition` (reuse its feelin `parseExpression` walk, minus the unary-test lint and the boolean-oriented wording):

```typescript
/** Publish-time FEEL syntax check for value-typed expressions (MI cardinality etc.). */
export function parseFeelExpression(expression: string): ParseConditionResult
```

- [ ] **Step 4: Implement the validator**

In `src/bpmn/validator.ts`:

1. Add a `readMultiInstance(el)` helper next to `readTaskDefinition` (:79): returns `{ mi: ModdleElement | null, standardLoop: boolean }` by inspecting `el.loopCharacteristics?.$type` (`bpmn:MultiInstanceLoopCharacteristics` vs `bpmn:StandardLoopCharacteristics`), plus `readMiBinding(el)` scanning `extensionElements.values` for `MULTI_INSTANCE_TYPE`.
2. Add one shared `classifyMultiInstance(el, id, elementName, scopeId): NodeMi | "rejected"` used by the serviceTask/subProcess/callActivity branches. It emits `err(...)` for: standardLoop (`"Element '<id>' has standardLoopCharacteristics (the loop marker), which is not supported — model repetition as sequence-flow cycles (M2) or multiInstanceLoopCharacteristics (M5-L3)."`); data bindings (`el.loopCharacteristics.loopDataInputRef || loopDataOutputRef || inputDataItem || outputDataItem` → `"…carries standard MI data bindings (loopDataInputRef/loopDataOutputRef/inputDataItem/outputDataItem), which are permanently rejected — use loopCardinality or easy-bpmn:multiInstance collection."`); non-All `behavior` / `complexBehaviorDefinition` / `oneBehaviorEventRef` / `noneBehaviorEventRef`; no source / both sources; FEEL parse failures via `parseFeelExpression(loopCardinality body)` (`bodyOf` pattern, :104-107) and `parseCondition(completionCondition body)`; `isForCompensation`. On success returns the parsed `MultiInstanceSpec` fields (bodyStepCost filled later).
3. Rewire the four loop-characteristics sites: transaction (:545) — keep a reject but split the wording (standardLoop vs `"Multi-instance is not supported on a transaction."`); receiveTask/generic (:808) — `"Element '<id>' has multi-instance characteristics — multiInstance is supported only on serviceTask, subProcess, and callActivity (M5-L3)."`; serviceTask (via the generic site today — add an explicit MI branch in the serviceTask handling at :823+), subProcess (:570), callActivity (:596) — call `classifyMultiInstance`; on success attach the spec to the pushed NodeInfo (extend the `NodeInfo` type at :136-157 with `multiInstance?`).
4. **subProcess MI**: still recurse `classifyContainer(el, id, "subProcess", scopeId, depth + 1)` so interior rules/scope depth run, but record the scope kind as `"miBody"` — thread a `miBody` flag into the `scopes[]` entry (the `scopeMetas` build at :1924-1936 writes `kind: "miBody"` for it). **Body whitelist**: after recursion, scan the just-classified children of this scope (nodes whose `scopeId === id`) and `err(...)` for types `receiveTask`, `intermediateCatchEvent` with `messageName`, `eventBasedGateway`, `subProcess`, `transaction`, `callActivity`, `parallelGateway`, `inclusiveGateway`, or a nested `multiInstance` — reason `"…is not allowed inside a multi-instance body in this layer — v1 MI bodies allow service tasks, exclusive gateways, timer catches, and end events; use multi-instance over a callActivity for richer bodies."`
5. **Leaf MI scope**: for serviceTask/callActivity MI, push a synthetic scope entry `{ id, kind: "miBody", parent: scopeId, depth: depth + 1, startId: id }` into the same `scopes[]`/`scopeParent`/`scopeDepth` structures (so `MAX_SCOPE_DEPTH` at :474 counts it).
6. **Boundary rules**: in the boundary-kind checks (:1163-1334), reject a `compensate` boundary whose `attachedToRef` node has `multiInstance` (`"Compensation boundary on a multi-instance activity (compensate-as-a-unit) is deferred — per-iteration compensation applies."`); error/timer boundaries on MI hosts are legal unchanged.
7. **Graph build** (:1807+): copy `multiInstance` from NodeInfo onto the `GraphNode`; compute `bodyStepCost` — leaf: `1`; subProcess body: count of interior nodes (`scopeId === id`) whose type is in `{serviceTask, exclusiveGateway, intermediateCatchEvent, endEvent, boundaryEvent}` (min 1).
8. Keep `RegionInput`/regions untouched (MI is an ordinary vertex — confirmed regions.ts:49).

- [ ] **Step 5: Run tests + full unit suite; commit**

Run: `npx vitest run tests/unit/validator-multi-instance.test.ts tests/unit/bpmn-validator.test.ts tests/unit/validator-call-activity.test.ts && npm run test:unit && npm run typecheck` — Expected: PASS except `tests/matrix/reject.test.ts` `[R-MI-SUBPROC-01]` and `tests/contract/api.test.ts:100` if they run under test:unit (they run under matrix/contract — verify; if the contract deferred-construct fixture uses `MULTI_INSTANCE_BPMN` swap it for an ad-hoc-subprocess fixture NOW, the L2 Task-2 precedent `4327b06`).

```bash
git add src/bpmn/graph.ts src/bpmn/moddle-extension.ts src/bpmn/validator.ts src/runtime/expressions.ts tests/unit/validator-multi-instance.test.ts tests/unit/bpmn-validator.test.ts tests/unit/validator-call-activity.test.ts
git commit -m "feat(m5-l3): validator accepts multiInstance on serviceTask/subProcess/callActivity — sources, rejects, miBody scopes"
```

---

### Task 3: Publish-time composition — call-resolution bodyStepCost + cap constant + incident kind

**Files:**
- Modify: `src/runtime/engine.ts` (add `MAX_MI_CARDINALITY` beside `MAX_CALL_DEPTH`, :203; test override beside :211-218)
- Modify: `src/bpmn/call-resolution.ts` (bodyStepCost for MI-callActivity; MI-body message reject composes)
- Modify: `src/persistence/instances.ts:855` (`IncidentKind` += `"miCardinality"`)
- Modify: `specs/002-saga-orchestrator/contracts/openapi.yaml` (`Incident.kind` enum += `miCardinality`, description sentence)
- Modify: `scripts/check-docs.mjs:172` (`SYNCED_CONSTANTS` += `"MAX_MI_CARDINALITY"`)
- Test: `tests/integration/multi-instance-publish.test.ts` (create)

**Interfaces:**
- Consumes: `resolveCallActivities(db, workspaceId, graph)` (call-resolution.ts:43-113), its memoized `depthOf` walk.
- Produces: `export const MAX_MI_CARDINALITY = 200;` (engine.ts, doc comment: body-aware, enforced at runtime activation, `@{i}` iteration keys); `export function maxMiCardinality(env: Env): number` override helper; `node.multiInstance.bodyStepCost` refined for callActivity MI = the called graph's step-costing node count; `effectiveMiCap(spec, env)` lives in Task 5's module.

- [ ] **Step 1: Failing publish tests**

`tests/integration/multi-instance-publish.test.ts` (harness = `createDraft`/`publishDraft` from `tests/helpers.ts`): (a) MI-callActivity over a published 3-task child publishes OK and the stored graph (`GET /definitions/versions/{id}` or direct `getVersionGraph` via `env.DB`) carries `multiInstance.bodyStepCost >= 3`; (b) MI-callActivity whose called process contains a `receiveTask` still rejects (the L2 message-wait rule composes — fixture: `receiveWaitBpmn` from `tests/integration/call-activity-publish.test.ts`); (c) publish of MI-callActivity with unresolved `calledElement` rejects (unchanged L2 rule fires with MI present).

- [ ] **Step 2: Implement**

engine.ts, after `MAX_CALL_DEPTH`:

```typescript
/**
 * M5-L3 — multi-instance fan-out cap (constitution v2.5.0; design §6). BODY-AWARE:
 * the effective per-activation cap is min(MAX_MI_CARDINALITY,
 * floor(STEP_BUDGET_SOFT / (bodyStepCost * 4))) — enforced at RUNTIME activation
 * (cardinality is data), settling a graceful `miCardinality` incident, never an
 * opaque errored Workflow. `check:docs` syncs every doc copy.
 */
export const MAX_MI_CARDINALITY = 200;
export function maxMiCardinality(env: Env): number { /* MAX_MI_CARDINALITY_OVERRIDE pattern of :211-218 */ }
```

call-resolution.ts: inside the resolve walk, for each callActivity node with `multiInstance`, set `node.multiInstance.bodyStepCost = stepCostOf(childGraph)` where `stepCostOf` counts `Object.values(g.nodes)` of type in the Task-2 step-costing set (min 1). `IncidentKind` union: append `| "miCardinality"` with a `// COMPOSITION (M5-L3 design §6)` comment. openapi enum line (`:1533`): append `, miCardinality` + one description sentence ("M5-L3 adds `miCardinality` — a multi-instance activation whose cardinality exceeds the body-aware cap."). check-docs `SYNCED_CONSTANTS` append.

- [ ] **Step 3: Verify + commit**

Run: `npx vitest run tests/integration/multi-instance-publish.test.ts && npm run check:docs && npm run typecheck` — PASS.

```bash
git add src/runtime/engine.ts src/bpmn/call-resolution.ts src/persistence/instances.ts specs/002-saga-orchestrator/contracts/openapi.yaml scripts/check-docs.mjs tests/integration/multi-instance-publish.test.ts
git commit -m "feat(m5-l3): MAX_MI_CARDINALITY cap + miCardinality incident kind + call-resolution bodyStepCost"
```

---

### Task 4: Step-free park mitigation (standalone, benefits every layer)

**Files:**
- Modify: `src/runtime/forward-task.ts:183-234` (svc-park), `src/runtime/call-activity.ts:156` (call-park)
- Test: `tests/integration/step-free-park.test.ts` (create)

**Interfaces:**
- Consumes: the intermediate-timer pattern (`src/runtime/intermediate-timer.ts:93-99` — predicate read outside, step only on state change).
- Produces: a rewalk over an unchanged park issues NO runStep. `mi-park` (Task 5) is born step-free.

- [ ] **Step 1: Failing test**

`tests/integration/step-free-park.test.ts`: publish/start a graph parking on a service task; drive with a counting `runStep` via `runInstance(env, id, { runStep: countingStep, waitFor: null })` (import from `src/runtime/engine`; copy the inline-step shape from `executor.ts:148-155`). First drive records baseline step names; a second cold re-drive (nothing changed) must issue ZERO steps whose name starts with `svc-park:` (assert on the captured name list; also assert the instance is still `waiting`). Same for a parked callActivity (`SIMPLE_PARENT_BPMN` from `tests/integration/call-activity-fixtures.ts` without draining the child worker) and `call-park:`.

- [ ] **Step 2: Implement**

forward-task.ts — replace the unconditional `await runStep(\`svc-park:${tag}\`, () => parkWaiting(...))` (:232) with:

```typescript
  // M5-L3 step-free park (design §6): a rewalk over an unchanged park is
  // step-free — the predicate is read OUTSIDE any step (timer-catch pattern).
  const inst = await loadInst(env, instanceId);
  if (inst.status === "waiting" && inst.current_element_id === elementId) return { kind: "waiting" };
  await runStep(`svc-park:${tag}`, () => parkWaiting(env, instanceId, elementId, occ, "serviceTask"));
```

call-activity.ts — same guard (the predicate is `parkCallWaiting`'s own idempotence condition, :505-512) before the `call-park` issuance at :156. Do NOT touch `recv:`/`ebg:` (subscription re-registration is a live self-heal, out of scope — note this in a comment).

- [ ] **Step 3: Verify + commit**

Run: `npx vitest run tests/integration/step-free-park.test.ts && npm run test:integration && npm run test:unit && npm run typecheck` — PASS (no existing test asserts park step issuance; if one does, it is asserting the old cost — update it citing this task).

```bash
git add src/runtime/forward-task.ts src/runtime/call-activity.ts tests/integration/step-free-park.test.ts
git commit -m "feat(m5-l3): step-free park on rewalk for svc-park/call-park (design §6 highest-leverage mitigation)"
```

---

### Task 5: Migration 0009 + mi-activations persistence + iteration-keyed jobs/steps

**Files:**
- Create: `migrations/0009_multi_instance.sql`, `src/persistence/mi-activations.ts`
- Modify: `src/persistence/saga.ts` (iteration on insert/lookups), `src/persistence/instances.ts` (job statements: iteration on create/lookup), `src/runtime/forward-task.ts` + `src/runtime/compensation.ts` (thread `iterationIndex = 0` defaults through job/step creation + `getSagaStep`/`getCompensationJob`)
- Test: `tests/unit/mi-activations.test.ts` (create), plus the existing suites as the no-op gate

**Interfaces:**
- Produces:

```sql
-- migrations/0009_multi_instance.sql
CREATE TABLE IF NOT EXISTS mi_activations (
  instance_id TEXT NOT NULL, element_id TEXT NOT NULL, occurrence INTEGER NOT NULL,
  cardinality INTEGER NOT NULL, is_sequential INTEGER NOT NULL,
  items TEXT, settled_kind TEXT, settled_count INTEGER,
  output_applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mi_activations_visit ON mi_activations (instance_id, element_id, occurrence);
ALTER TABLE service_task_jobs ADD COLUMN iteration_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE saga_steps ADD COLUMN iteration_index INTEGER NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS uq_jobs_instance_element_kind;
CREATE UNIQUE INDEX uq_jobs_instance_element_kind ON service_task_jobs (instance_id, element_id, is_compensation, occurrence, iteration_index);
DROP INDEX IF EXISTS uq_saga_steps_forward;
CREATE UNIQUE INDEX uq_saga_steps_forward ON saga_steps (instance_id, element_id, occurrence, iteration_index);
```

```typescript
// src/persistence/mi-activations.ts
export interface MiActivationRow { instance_id: string; element_id: string; occurrence: number;
  cardinality: number; is_sequential: number; items: string | null;
  settled_kind: "all" | "condition" | "abort" | null; settled_count: number | null;
  output_applied: number; created_at: string; updated_at: string; }
export function insertMiActivationStmt(db, input: { instanceId; elementId; occurrence; cardinality; isSequential; items: unknown[] | null; now }): D1PreparedStatement
export async function getMiActivation(db, instanceId, elementId, occurrence): Promise<MiActivationRow | null>
export function settleMiActivationStmt(db, input: { instanceId; elementId; occurrence; kind: "all" | "condition" | "abort"; count; now }): D1PreparedStatement  // WHERE … AND settled_kind IS NULL — the once-only decider
export function markMiOutputAppliedStmt(db, input: { instanceId; elementId; occurrence; now }): D1PreparedStatement  // WHERE … AND output_applied = 0 — the single-apply CAS
```

- saga.ts: `insertSagaStepStmt` input gains `iterationIndex?: number` (default 0, bound into the INSERT); `getSagaStep(db, instanceId, elementId, occurrence, iterationIndex = 0)`; `SagaStepView` gains `iterationIndex`. instances.ts: job insert stmt gains `iterationIndex` (default 0); `getForwardJob`/`getCompensationJob` lookups gain the defaulted param. `retainStragglerStmts` (compensation.ts:432-467) carries the job's iteration through.

- [ ] **Step 1: Write failing unit tests** — `tests/unit/mi-activations.test.ts`: insert→get roundtrip; duplicate insert throws (unique); `settleMiActivationStmt` flips once (second run changes 0 rows — assert via `meta.changes`); `markMiOutputAppliedStmt` same; two saga steps same `(instance, element, occurrence)` different iteration both insert; same iteration ignored (INSERT OR IGNORE).
- [ ] **Step 2: Apply migration locally** — `npx wrangler d1 migrations apply easy_bpmn --local`. (vitest-pool-workers applies migrations from the config automatically — confirm `vitest.config.ts` migration wiring picks up 0009.)
- [ ] **Step 3: Implement**, mirroring `src/persistence/child-instances.ts` statement style. Thread `iterationIndex` defaults through forward-task.ts job creation (`createForwardJob`), `applyForwardCompletion`'s `insertSagaStepStmt`, compensation.ts `createCompensationJob` (idempotency key: `` `${instanceId}:${elementId}:1:${occurrence}` + (it > 0 ? `@${it}` : "") ``) and `getCompensationJob` — all call sites pass 0 for now.
- [ ] **Step 4: Verify + commit** — `npx vitest run tests/unit/mi-activations.test.ts && npm run test:unit && npm run test:integration && npm run typecheck` — PASS (pure no-op for existing paths).

```bash
git add migrations/0009_multi_instance.sql src/persistence/mi-activations.ts src/persistence/saga.ts src/persistence/instances.ts src/runtime/forward-task.ts src/runtime/compensation.ts tests/unit/mi-activations.test.ts
git commit -m "feat(m5-l3): migration 0009 — mi_activations decider + iteration_index on jobs/saga_steps"
```

---

### Task 6: MI runtime core — serviceTask MI, parallel + sequential, aggregation, N=0, caps

**Files:**
- Create: `src/runtime/multi-instance.ts`
- Modify: `src/runtime/engine.ts` (driveLeaf MI dispatch before the type branches, ~:410; pass a `nextOcc`-free API — the driver needs only `runStep`, `activeTokenId`, `drivers.driveLeaf` comes in Task 7), `src/runtime/forward-task.ts` (iterationIndex thread: tags `@${i}` for i>0, job keys, per-iteration input override)
- Test: `tests/integration/multi-instance-forward.test.ts`, `tests/integration/multi-instance-fixtures.ts` (create both)

**Interfaces:**
- Produces (exact exports of `src/runtime/multi-instance.ts`):

```typescript
export type MiOutcome = { kind: "next"; next: string } | { kind: "waiting" } | { kind: "incident" };
export const miTokenId = (instanceId: string, elementId: string, occ: number, i: number) =>
  branchTokenId(instanceId, elementId, occ, `mi#${i}`);
export const miIterTag = (tag: string, i: number) => i > 0 ? `${tag}@${i}` : tag;
export function effectiveMiCap(env: Env, bodyStepCost: number): number;  // min(maxMiCardinality(env), floor(stepBudgetSoft(env) / (bodyStepCost * 4)))
export async function driveMultiInstance(env, instanceId, graph, elementId, occ, node, runStep, activeTokenId?): Promise<MiOutcome>;
export function iterationContext(base: JsonObject, spec: MultiInstanceSpec, items: unknown[] | null, i: number): JsonObject; // base + {[elementVariable ?? "item"]: items?.[i]} + {loopCounter: i}
```

- `driveServiceTask`-side: `forward-task.ts`'s driver gains an optional `mi?: { iterationIndex: number; inputOverride: JsonObject }` arg — tags via `miIterTag`, job insert/lookup keyed with the iteration, `createForwardJob` captures `inputOverride` as the job input instead of re-resolving scope, and the ledger `insertSagaStepStmt` gets `iterationIndex` + **`scopeId: elementId`** (the miBody scope) when driven under MI. The forward job-completion path (`applyForwardCompletion`) must NOT advance the instance for an MI iteration — under MI the driver owns advancement: thread a flag so the iteration apply writes job output + ledger + `miIterationCompleted` history but no `applyTransitionStmt` advance (the MI apply step does that).

Driver skeleton (the heart of the layer — implement exactly this shape):

```typescript
export async function driveMultiInstance(env, instanceId, graph, elementId, occ, node, runStep, activeTokenId) {
  const spec = node.multiInstance!; const tag = `${elementId}#${occ}`;
  // 0. Boundary-timer Hazard fast-forward — mirror call-activity.ts:117-121 (Task 9 fills the drain).
  // 1. ACTIVATE (gateway_decisions discipline): D1 read outside any step.
  let act = await getMiActivation(env.DB, instanceId, elementId, occ);
  if (!act) {
    const outcome = await runStep(`mi-activate:${tag}`, () => activateMi(env, instanceId, graph, elementId, occ, node, activeTokenId));
    if (outcome !== "ok") return { kind: "incident" };          // conditionFailure | miCardinality already recorded
    act = (await getMiActivation(env.DB, instanceId, elementId, occ))!;
  }
  const N = act.cardinality; const items = act.items ? parseJson<unknown[]>(act.items, []) : null;
  // 2. DRIVE ITERATIONS (index order; sequential stops at the first live one).
  //    iterState(i) is a pure D1 read: the iteration job / child / token+marker.
  let completed = 0; let live = 0; let erroredIteration: … | null = null;
  for (let i = 0; i < N; i++) {
    if (act.settled_kind && act.settled_kind !== "all") break;   // early-settled: never start more
    const st = await iterationState(env, instanceId, graph, elementId, occ, node, i);
    if (st.kind === "completed") { completed++; continue; }
    if (st.kind === "errored")   { erroredIteration = st; break; }
    // not started or in flight → drive one state forward via the per-kind driver
    const r = await driveIteration(env, instanceId, graph, elementId, occ, node, i, runStep, act, activeTokenId);
    if (r.kind === "incident") return r;
    if (r.kind === "completed") { completed++;
      const met = await maybeSettleOnCondition(env, instanceId, graph, elementId, occ, node, act, i, runStep, activeTokenId);
      if (met) { act = (await getMiActivation(...))!; continue; } }
    else { live++; if (spec.isSequential) break; }
  }
  if (erroredIteration) return abortOnIterationError(env, instanceId, graph, elementId, occ, node, erroredIteration, runStep); // Task 9
  // 3. SETTLE + APPLY (apply-once decider): all N settled, or an early-settle decider present.
  const settled = act.settled_kind != null || (completed >= N && live === 0);
  if (settled) {
    if (!act.output_applied) await runStep(`mi-apply:${tag}`, () => applyMiCompletion(env, instanceId, graph, elementId, occ, node, activeTokenId));
    return { kind: "next", next: node.next! };
  }
  // 4. PARK — step-free re-park (Task 4 pattern).
  const inst = await loadInst(env, instanceId);
  if (!(inst.status === "waiting" && inst.current_element_id === elementId))
    await runStep(`mi-park:${tag}`, () => parkMiWaiting(env, instanceId, elementId, occ));
  return { kind: "waiting" };
}
```

`activateMi`: idempotent re-run guard (existing row → "ok"); resolve base vars (the `isBranch` idiom); evaluate the source — `loopCardinality` via `evaluateCondition`-style raw feelin eval (use `normalizeFeelValue`; require a non-negative integer) or `collection` (require an array); failures → `createIncident(..., "conditionFailure")` and return "incident"; `N > effectiveMiCap(env, spec.bodyStepCost)` → `createIncident(env, instanceId, elementId, 0, \`Multi-instance cardinality ${N} exceeds the body-aware cap ${cap} (MAX_MI_CARDINALITY = 200).\`, { cardinality: N, cap, bodyStepCost: spec.bodyStepCost }, "miCardinality")` and return "incident"; else ONE dbBatch: `insertMiActivationStmt` + `historyStmt(type: "miActivated", diagnostics: { cardinality: N, isSequential: spec.isSequential, hasCollection: items != null, occurrence: occ, ...branchHistoryTags(activeTokenId) })`. **N = 0**: write the row with `settled_kind: 'all'`, `settled_count: 0` in the same batch — step 3 applies immediately.

`driveIteration` for a serviceTask body delegates to the forward-task driver with `mi: { iterationIndex: i, inputOverride: iterationContext(base, spec, items, i) }`; it returns completed/waiting/incident by reading the iteration job state (the forward triad's own fast-forwards do the work). `iterationState` reads the job row `(el, occ, i)`: `output_applied=1` → completed (collect output later from the job row / variable snapshot); failed-terminal handled by the incident path; worker business error → `errored` (Task 9).

`applyMiCompletion`: re-read act (idempotent on `output_applied=1`); collect outputs by index (serviceTask: each completed job's output variables via the jobs table; store `null` at unfinished indexes); one dbBatch: `markMiOutputAppliedStmt` + optional variable write (`outputVariable` → root `applyTransitionStmt(variables: merged, currentElementId: node.next, status: "running")` or branch overlay via `setTokenOverlayStmt` + `applyTransitionStmt(currentElementId: null, status:"running")` — copy `applyChildTerminal`'s split, call-activity.ts:272-282) + `historyStmt(type: "miCompleted", diagnostics: { cardinality: N, completedCount, settledKind })` + iteration-token teardown stmts (mark any live `mi#` tokens `consumed`). Without `outputVariable` still advance/transition.

`maybeSettleOnCondition` (completionCondition declared only): evaluate over `{...base, ...iterationOutput, nrOfInstances: N, nrOfCompletedInstances: k, nrOfActiveInstances: live}` via `evaluateCondition`; eval error → `conditionFailure` incident; true → `runStep(\`mi-settle:${tag}@${i}\`, ...)` ONE batch: `settleMiActivationStmt(kind:'condition', count:k)` + `historyStmt("miCompletionConditionMet", {completedCount:k})` + cancel-remaining stmts (Task 8 fills the job-abandon/child-cancel/token-discard; in this task: no-op besides the decider).

Engine dispatch — in `driveLeaf` BEFORE the transaction/subProcess branch (engine.ts:~418) and before serviceTask/callActivity dispatch:

```typescript
      if (node.multiInstance) {
        const r = await driveMultiInstance(env, instanceId, graph, cur, occ, node, runStep, activeTokenId);
        if (r.kind === "waiting") return { kind: "parked" };
        if (r.kind === "incident") return { kind: "incident" };
        return { kind: "next", next: r.next };
      }
```

- [ ] **Step 1: Failing tests** — `tests/integration/multi-instance-fixtures.ts`: `MI_PAR_TASK_BPMN` (parallel, `loopCardinality` 3, task type `charge`, `easy-bpmn:multiInstance outputVariable="results"`? — cardinality-only + outputVariable requires the ext WITHOUT collection: allowed — outputVariable/elementVariable may accompany loopCardinality; assert Task 2 accepts this or use collection fixtures), `MI_SEQ_COLL_BPMN` (sequential, collection `orders`, elementVariable `order`, outputVariable `results`), `MI_ZERO_BPMN`, `MI_CAP_BPMN` (`loopCardinality` 999). Tests in `multi-instance-forward.test.ts`:
  1. `[MI-PAR-TASK-01]` parallel: start with `{}`; assert instance `waiting`, THREE leasable `charge` jobs concurrently (`POST /jobs/activate` maxJobs 5 → 3 jobs, each `variables.loopCounter` ∈ {0,1,2} distinct); complete each with `{amount: 10*(i+1)}`; parent `completed`; `variables.results` = `[{amount:10},{amount:20},{amount:30}]` (index order regardless of completion order — complete out of order in the test); history: `miActivated`=1, `miIterationCompleted`=3, `miCompleted`=1.
  2. `[MI-SEQ-COLL-01]` sequential over `orders: ["a","b"]`: only ONE job leasable at a time; first job `variables.order === "a"`, `loopCounter === 0`; after completing it the second appears (`order:"b"`); aggregation by index; `mi_activations` row has `items` snapshot (mutate `orders` via… not mutable mid-flight without a worker write — assert snapshot simply by row content).
  3. `[MI-ZERO-01]` empty collection: instance completes on start-drive; `results` = `[]`; `miActivated` + `miCompleted` both present.
  4. `[MI-CAP-01]` cardinality 999: incident `kind === "miCardinality"`, `payloadContext.cardinality === 999`, instance `incident`, no jobs created.
  5. idempotency: after completion, `resumeInline(env, id)` twice → history counts unchanged, variables byte-identical.
  6. MI inside an M4 parallel branch (fixture: AND-split, one branch carries the MI task) → aggregation lands in the branch overlay, join folds it up; parent `completed` with `results` visible in final vars.
- [ ] **Step 2: Implement** as specced above. Watch: the forward-task iteration apply must write `miIterationCompleted` (with `{iterationIndex: i, occurrence: occ}`) in ITS batch; job `variables` for activation of MI jobs = `inputOverride` (workers see item+loopCounter).
- [ ] **Step 3: Verify + commit** — `npx vitest run tests/integration/multi-instance-forward.test.ts && npm run test:integration && npm run test:unit && npm run typecheck`.

```bash
git add src/runtime/multi-instance.ts src/runtime/engine.ts src/runtime/forward-task.ts tests/integration/multi-instance-forward.test.ts tests/integration/multi-instance-fixtures.ts
git commit -m "feat(m5-l3): MI runtime core — activation decider, serviceTask iterations, aggregation, N=0, miCardinality"
```

---

### Task 7: MI over subProcess — iteration tokens + body sub-walk

**Files:**
- Modify: `src/runtime/multi-instance.ts` (subProcess `driveIteration` + the body sub-walk), `src/runtime/engine.ts` (pass `drivers.driveLeaf` into the MI dispatch — extend the dispatch call to `driveMultiInstance(..., drivers)`; both walk drivers), `src/runtime/frontier.ts` (preserve live `mi#` tokens in `reconstructFrontier`/`syncFrontierReadModel`)
- Test: `tests/integration/multi-instance-subprocess.test.ts` (create; fixtures added to `multi-instance-fixtures.ts`)

**Interfaces:**
- Consumes: `drivers.driveLeaf(cur, occ, activeTokenId)` (`LeafDrivers`, engine.ts:405-727); `upsertTokenStmt`/`setTokenStatusStmt`/`setTokenOverlayStmt` (tokens.ts); `resolveScope` (frontier.ts:42).
- Produces: `driveMultiInstance(env, instanceId, graph, elementId, occ, node, runStep, activeTokenId, driveLeaf?, nextOcc?)` — the two extra params threaded from BOTH walk drivers (single-token: the `drivers` closure + the walk's `visits`-backed `nextOcc`; region DFS: frontier.ts's own `nextOcc`). Iteration token = `miTokenId(instanceId, el, occ, i)`, `region_id: null`, `parent_token_id: activeTokenId ?? rootTokenId(instanceId)`, `branch_flow_id: "mi#" + i`, `position_element_id` = current body node.

- [ ] **Step 1: Failing tests** — fixtures: `MI_PAR_SUB_BPMN` (parallel cardinality 2; body: none-start → `reserve` task → XOR (cond `order = "b"` → `extra` task → end / default end) — exercises interior gateway + per-iteration overlay), `MI_SEQ_SUB_BPMN` (sequential collection). Tests:
  1. `[MI-PAR-SUB-01]` two concurrent `reserve` jobs; each iteration's interior gateway decision recorded at DIFFERENT occurrences (assert two `gateway_decisions` rows); outputs aggregate from iteration overlays; live `execution_tokens` during flight: two `mi#` tokens (`status IN ('active','waiting')`); after completion tokens are `consumed`.
  2. `[MI-SEQ-SUB-01]` sequential: interior task jobs appear one iteration at a time; interior variable writes do NOT leak into root vars mid-flight (assert root `variables` unchanged until `miCompleted`); aggregation array = per-iteration overlays.
  3. cold re-drive idempotency mid-flight (one iteration completed, one parked): `resumeInline` → no duplicate jobs (job count unchanged), no duplicate history.
- [ ] **Step 2: Implement the sub-walk.** For a subProcess body, `driveIteration(i)`:
  1. Ensure the iteration token exists (`getToken` read outside steps; create via `runStep(\`mi-iter:${tag}@${i}\`, ...)`: `upsertTokenStmt(status:'active', positionElementId: scope.startId)` with overlay = `iterationContext(...)` + `miIterationStarted`-free — reuse `miActivated`? No: add no extra history; the token row suffices).
  2. Walk: `cur = scopes-of(graph)[el].startId`; loop: `node = graph.nodes[cur]`; **intercept** `type === "endEvent"` with `node.scopeId === el`: `endKind === "none"` → iteration completes — `runStep(\`mi-iter-done:${tag}@${i}\`, ...)` ONE batch: `setTokenStatusStmt(tok,'consumed')` + `historyStmt("miIterationCompleted", {iterationIndex: i, occurrence: occ})`, return completed (guard: marker-existence check outside the step for idempotence — `visitApplied`-style on the token status); `endKind === "error"` → return `{kind:"errored", errorCode}` (Task 9). Otherwise dispatch `driveLeaf(cur, nextOcc(cur), miToken)`: `next` → follow; `parked` → return waiting; `incident`/`compensate` → bubble as incident (body whitelist excludes tx so `compensate` cannot occur).
  3. Iteration output for aggregation = the token's final overlay (read at `applyMiCompletion` from the consumed token row).
  Sequential vs parallel differ only in how many iterations the main loop drives. `reconstructFrontier` (frontier.ts:27-33): also return live `mi#` tokens (SELECT live tokens whose `branch_flow_id LIKE 'mi#%'`) so the post-drive sync never consumes them; alternatively filter them from the vanish set in `syncFrontierReadModel` — choose the sync-filter (one-line: skip rows whose `branch_flow_id` starts with `mi#`).
- [ ] **Step 3: Verify + commit** — targeted suite + full integration + unit + typecheck.

```bash
git add src/runtime/multi-instance.ts src/runtime/engine.ts src/runtime/frontier.ts tests/integration/multi-instance-subprocess.test.ts tests/integration/multi-instance-fixtures.ts
git commit -m "feat(m5-l3): MI over subProcess — iteration tokens, driver body sub-walk, overlay isolation"
```

---

### Task 8: completionCondition — early settle + non-compensating cancel-remaining

**Files:**
- Modify: `src/runtime/multi-instance.ts` (`maybeSettleOnCondition` cancel-remaining stmts)
- Test: `tests/integration/multi-instance-condition.test.ts` (create)

**Interfaces:**
- Consumes: `abandonJobOnTimerFireStmt` (the drain's job-abandon statement, compensation.ts:504-506 usage), `cancelChildCascade` (child-cascade.ts:55), `setTokenStatusStmt`.
- Produces: cancel-remaining inside the `mi-settle` step: for each non-finished iteration — in-flight job → abandon stmt; in-flight child (Task 10 wiring) → `cancelChildCascade` AFTER the batch; live `mi#` token → `setTokenStatusStmt(tok, "discarded")`. NEVER `ledgerStragglers`, NEVER compensation-job creation.

- [ ] **Step 1: Failing tests** — fixture `MI_COND_BPMN`: parallel cardinality 4, task `probe`, `completionCondition` `hits >= 2` (workers return `{hits: <n>}` cumulatively? condition context = base + just-finished output + counts — set condition `nrOfCompletedInstances >= 2`). Tests:
  1. `[MI-COND-EARLY-01]` complete 2 of 4 jobs → instance completes without the other 2; those jobs are terminal-abandoned (status assert via D1); `miCompletionConditionMet` history with `completedCount: 2`; `results` has exactly 2 non-null entries at the completed indexes; **zero compensation jobs** (`SELECT COUNT(*) FROM service_task_jobs WHERE is_compensation = 1` → 0); remaining `mi#` tokens `discarded`.
  2. `[MI-COND-LEDGER-01]` the same MI inside a transaction with a later cancel end (extend the `sagaBpmn` wrapper): after early settle at k=2, the tx cancels → exactly the 2 finished iterations compensate (2 compensation jobs, reverse seq order), the other 2 ledger nothing — the design's flagship gate.
  3. conditionCondition FEEL error → `conditionFailure` incident.
- [ ] **Step 2: Implement** — `iterationState` gains "abandoned" (terminal, not completed, not errored — settled-early leftovers count as neither live nor completed on rewalk; the settle decider short-circuits the main loop anyway). The `mi-settle` batch collects the abandon/discard statements from a D1 sweep of iterations `> current` states read OUTSIDE the step.
- [ ] **Step 3: Verify + commit.**

```bash
git add src/runtime/multi-instance.ts tests/integration/multi-instance-condition.test.ts tests/integration/multi-instance-fixtures.ts
git commit -m "feat(m5-l3): completionCondition — once-only early settle, normal (non-compensating) cancel-remaining"
```

---

### Task 9: Iteration errors + Hazard timer on the MI activity

**Files:**
- Modify: `src/runtime/multi-instance.ts` (`abortOnIterationError`, timer fast-forward), `src/runtime/forward-task.ts` (MI iteration business-error surfacing), `src/runtime/boundary-timer.ts:453-475` (MI-visit guard beside the callActivity guard)
- Test: `tests/integration/multi-instance-errors.test.ts` (create)

**Interfaces:**
- Consumes: `errorCatchTarget(graph, elementId, errorCode)`; `drainScopeSubtree(env, graph, instanceId, rootScopeId)` (compensation.ts:482); `settleMiActivationStmt(kind: 'abort')`; the `scope-timer-exit`/`call-timer-exit` fast-forward patterns.
- Produces: an iteration business error (worker `/jobs/fail` with an error code routed by the existing error machinery / a body error-end / a child `errored` — Task 10) settles `settled_kind='abort'` once, drains the miBody subtree (retention semantics), then routes exactly as "the MI activity threw": boundary on the MI element → its flow; else bubble; root → `uncaughtError`. Timer boundary on the MI element = Hazard: `mi-timer-exit:${tag}` step → same drain (NO abort-settle needed beyond marking — reuse `settled_kind='abort'`), continue on the boundary flow.

- [ ] **Step 1: Failing tests** — fixtures: `MI_ERR_BOUNDARY_BPMN` (parallel 3, worker `flaky` errors iteration 1 with code `MI_FAIL`; error boundary on mi1 catches `MI_FAIL` → handler task → end2), `MI_ERR_SUB_BPMN` (MI subProcess whose body error-ends on a condition), `MI_TIMER_BPMN` (MI with a PT0S-ish timer boundary — the L2 `CALL_PARENT_TIMER_BPMN` shape). Tests:
  1. `[MI-ERR-BOUNDARY-01]` iteration 1 errors → instance routes the boundary; in-flight iterations abandoned (drain), COMPLETED iteration 0's ledger row retained `pending`; `settled_kind === 'abort'`.
  2. `[MI-ERR-UNCAUGHT-01]` no boundary → `uncaughtError` incident at root (or `errored` for a child instance — covered in Task 10).
  3. `[MI-HAZARD-TIMER-01]` timer fires while 3 iterations in flight → boundary flow taken, iterations drained without compensation (0 compensation jobs), finished rows retained; operator `/cancel` afterwards compensates the retained rows (the L1 §3.2 gate, now over MI rows).
  4. body error-end (`MI_ERR_SUB_BPMN`) routes identically.
- [ ] **Step 2: Implement.** Business-error detection per body kind lives in `iterationState` (job in the error-routed terminal state — reuse how a plain serviceTask surfaces a caught business error today: `errorCatchTarget` from the TASK routes… for MI the task-level error must NOT route from the inner task's boundary search alone — the bubble crosses the miBody scope to the MI element; verify `errorCatchTarget`'s ancestor climb handles a `miBody` scope kind agnostically; fix its kind assumptions if any). `abortOnIterationError`: settle-decider CAS (`settleMiActivationStmt(kind:'abort')` — loser fast-forwards); `runStep(\`mi-abort:${tag}\`, ...)`: `drainScopeSubtree(env, graph, instanceId, elementId)` + route batch (`miCompleted`-free; write `callActivityErrored`-style `miAborted` history with `{errorCode, iterationIndex}`) + transition to the catch target / incident. The boundary-timer guard in `planBoundaryTimerFire` (:453-475): add an MI-visit branch — skip the fire when the visit's `mi_activations.output_applied = 1` or an abort already settled (mirror the callActivity skip conditions); the drain runs on the walk's `mi-timer-exit` fast-forward, like `cancelChildOnTimerFire`.
- [ ] **Step 3: Verify + commit.**

```bash
git add src/runtime/multi-instance.ts src/runtime/forward-task.ts src/runtime/boundary-timer.ts tests/integration/multi-instance-errors.test.ts tests/integration/multi-instance-fixtures.ts
git commit -m "feat(m5-l3): iteration errors abort+drain+route; Hazard timer on an MI activity"
```

---

### Task 10: MI over callActivity — child fan-out + per-iteration child compensation

**Files:**
- Modify: `src/runtime/call-activity.ts` (thread `iterationIndex` through the triad: `invokeChild` :204/:212, `applyChildTerminal` :268, `applyChildErrored` :383, `getChildInstanceForVisit` call sites :123/:130/:170/:189/:262, `cancelChildOnTimerFire` — cascade ALL iterations, `appliedCallOutcome`, tags via `miIterTag`), `src/runtime/multi-instance.ts` (callActivity `driveIteration` delegating to `driveCallActivity` with `mi`), `src/runtime/compensation.ts` (`retainCallStraggler` :346-391 — the token's OWN iteration row, iteration-aware dedup via `getSagaStep(..., iterationIndex)`)
- Test: `tests/integration/multi-instance-call.test.ts` (create)

**Interfaces:**
- Consumes: everything M5-L2 built; `childInstanceIdFor(parent, el, occ, i)` (the 4th param finally non-zero); `beginChildCompensation` unchanged (per-child); `getSagaStepByChildId` unchanged (per-child uniqueness holds under MI).
- Produces: `driveCallActivity(env, instanceId, graph, elementId, occ, node, runStep, activeTokenId?, mi?: { iterationIndex: number; inputOverride: JsonObject })` — with `mi` set: child id/rows keyed `(el, occ, i)`, initial vars = `inputOverride`, tags `call-create:el#occ@i` etc.; **no parent advancement** on apply (`applyChildTerminal` writes the flip + ledger step (`iterationIndex: i`, `scopeId: elementId` the miBody scope) + `miIterationCompleted` history but no transition — the MI driver owns it); `errored` child → returned to the MI driver as an iteration error (Task 9 path), not routed directly.

- [ ] **Step 1: Failing tests** — fixtures: publish `SIMPLE_CHILD_BPMN` (L2 fixtures) + `MI_CALL_BPMN` (parallel collection `["a","b","c"]` over `<bpmn:callActivity calledElement="simple-child">`, outputVariable `results`); `MI_CALL_TX_BPMN` (the MI callActivity inside a cancellable transaction — extend `CALL_PARENT_TX_CANCEL_BPMN`'s shape); `MI_CALL_ERR_BPMN` (child = `CALL_CHILD_BPMN` which errors on `failChild`). Tests:
  1. `[MI-CALL-FANOUT-01]` three children created, ids `await childInstanceIdFor(parent, "mi1", 0, i)` for i∈{0,1,2}, each `child_instances` row `(occurrence 0, iteration_index i)`; each child's initial vars carry `item`/`loopCounter`; drain workers → parent completes; `results[i]` = child i's final vars; lineage children carry THREE rows for mi1.
  2. `[MI-CALL-COMP-01]` **the flagship**: `MI_CALL_TX_BPMN` — children complete, then the tx cancels → the parent reverse pass drives EACH child's own reverse pass (3 `comp-child` settles, children end `compensated`), reverse seq order; parent `compensated`.
  3. `[MI-CALL-ERR-01]` child 1 errors (`failChild` only for item "b" via child gateway) → MI abort: siblings cascade-cancelled (`cancelled`, ledgers retained), error routes to the mi1 boundary.
  4. duplicate cold re-drive after fan-out: still exactly 3 `child_instances` rows, 3 CF-create attempts idempotent (direct mode: children ran inline once).
  5. Hazard timer on `mi1` cancels ALL live iteration children (extend `cancelChildOnTimerFire` to iterate `listChildrenByElement` rows of the visit).
- [ ] **Step 2: Implement** the `mi` thread; keep every existing call site passing `mi = undefined` (byte-identical behavior). `retainCallStraggler`: parse the token's `mi#i` via `parseTokenId(...).branchFlowId` and select the matching row (`getChildInstanceForVisit(db, instanceId, pos, occ, i)`), falling back to latest-visit for non-MI tokens; dedup guard `getSagaStep(env.DB, instanceId, pos, row.occurrence, row.iteration_index)`.
- [ ] **Step 3: Verify + commit** — targeted + `npm run test:integration && npm run test:unit && npm run typecheck` (the L2 suites are the regression net here — they must stay green untouched).

```bash
git add src/runtime/call-activity.ts src/runtime/multi-instance.ts src/runtime/compensation.ts tests/integration/multi-instance-call.test.ts tests/integration/multi-instance-fixtures.ts
git commit -m "feat(m5-l3): MI-callActivity — iteration-keyed child triad fan-out + per-iteration child compensation"
```

---

### Task 11: Per-iteration compensation closure for serviceTask/subProcess MI + straggler/barrier regression net

**Files:**
- Modify: `src/runtime/compensation.ts` (compensation-job creation/lookup iteration thread — `createCompensationJob` uses `step.iterationIndex`; `ledgerStragglers` job resolution for `mi#` tokens), `src/runtime/multi-instance.ts` (only if gaps surface)
- Test: `tests/integration/multi-instance-compensation.test.ts` (create)

**Interfaces:**
- Consumes: Task 5's iteration-keyed `getCompensationJob`/`createCompensationJob`; the existing reverse cursor (`selectSubtreeStepsForCompensation` — no change: `seq DESC` over miBody rows).
- Produces: nothing new — this task PROVES the "zero algorithm change" claim with tests, and closes the two straggler refinements (design §5).

- [ ] **Step 1: Failing tests** — fixture `MI_TASK_TX_BPMN`: tx [ `charge` (comp `refund`) as parallel MI cardinality 3 → steerable gateway → cancel-end / end ]. Tests:
  1. `[MI-COMP-REVERSE-01]` all 3 iterations complete → cancel → THREE `refund` compensation jobs, executed reverse-seq (assert via job created_at order / seq of their steps), each `iteration_index` matching; parent `compensated`.
  2. `[MI-COMP-STRAGGLER-01]` cancel fires while iteration 2's job is still in flight (park it via no worker): two-phase cancel — in-flight job abandoned/terminated per the cohort terminator, completed iterations' rows compensate, barrier releases (instance reaches `compensated`, never wedges) — the §3.1.2 gate over MI.
  3. `[MI-COMP-SUBPROC-01]` MI-subProcess whose INTERIOR task has a compensation boundary, inside a tx → interior steps compensate per iteration (occurrence-distinct rows, existing machinery).
- [ ] **Step 2: Implement** the residual wiring the tests surface (expected: `createCompensationJob` iteration pass-through; `ledgerStragglers` resolving the iteration job for a token parked ON the MI element — map `mi#i` → job `(el, occ, i)`).
- [ ] **Step 3: Verify + commit.**

```bash
git add src/runtime/compensation.ts src/runtime/multi-instance.ts tests/integration/multi-instance-compensation.test.ts tests/integration/multi-instance-fixtures.ts
git commit -m "feat(m5-l3): per-iteration compensation closure — reverse cursor, stragglers, barrier over MI iterations"
```

---

### Task 12: Operator + console delta — lineage iterationIndex, SPA, history polish

**Files:**
- Modify: `src/contracts/api.ts:313-318` (`InstanceLineageChild` += `iterationIndex: number`), `src/index.ts:356-366` (map `c.iteration_index`), `specs/002-saga-orchestrator/contracts/openapi.yaml:1161-1198` (`InstanceLineage` children items += `iterationIndex`, required), `spa/src/api/types.ts` (mirror), `spa/src/lib/lineage.ts` (sort + label), `spa/src/stage/LineageStrip.tsx` (render `·i{n}` suffix for iterationIndex > 0)
- Test: `spa/src/lib/lineage.test.ts` (extend), `tests/integration/multi-instance-operator.test.ts` (create)

**Interfaces:**
- Produces: `InstanceLineageChild { elementId; occurrence; iterationIndex; childInstanceId; status }`; `sortedLineageChildren` orders `occurrence DESC, iterationIndex ASC, elementId`.

- [ ] **Step 1: Failing tests** — integration: `[MI-LINEAGE-01]` after `MI_CALL_BPMN` fan-out, `GET /instances/{parent}` lineage children = 3 rows with `iterationIndex` 0..2; `[MI-OP-RETRY-01]` an MI child in `incident` (child worker fails poisoned) → parent `/retry` cascades into the child (existing `retryChildSubtree` — assert it heals); `[MI-OP-409-01]` direct child cancel → 409 (unchanged). SPA: extend `lineage.test.ts` for the new sort/label.
- [ ] **Step 2: Implement**; `npm run test:ui && npm run typecheck:ui` for the SPA side; `npm run build:ui` must succeed.
- [ ] **Step 3: Verify + commit.**

```bash
git add src/contracts/api.ts src/index.ts specs/002-saga-orchestrator/contracts/openapi.yaml spa/src tests/integration/multi-instance-operator.test.ts
git commit -m "feat(m5-l3): lineage iterationIndex — API + openapi + console strip; operator cascade tests"
```

---

### Task 13: Matrix wave + docs lockstep

**Files:**
- Modify: `tests/matrix/registry.ts` (MI wave), `tests/matrix/registry.test.ts` (count literals), `scripts/check-matrix.mjs` (count 86 → new total; `MUST_COVER` += `"multiInstance"`), `tests/matrix/reject.test.ts` (`[R-MI-SUBPROC-01]` flip to a body-whitelist reject)
- Create: `tests/integration/matrix/multi-instance.test.ts` (overflow scenarios not already markered)
- Modify (docs sweep, verbatim flip list from the pre-plan survey): `docs/bpmn/09-easy-bpmn-profile.md` (:20-24 intro, :70-77 roadmap SHIPPED sentence, :266 table tail + a new Multi-Instance row, :402-405 MAX_SCOPE_DEPTH parenthetical, :451-453 L2 tail, :481-485 → an "M5-L3 (`multiInstance`) — SHIPPED, runtime open:" block in the :378/:417 house style with per-feature "— **shipped**:" bullets incl. `MAX_MI_CARDINALITY = 200` + `miCardinality` + the v1 body whitelist + behavior=All + 0-based `loopCounter` + the `easy-bpmn:multiInstance` binding (documented divergence/extension), :511 parenthetical, :764-780, :782-791), `docs/bpmn/02-activities.md` (:120-123, :138-139, :141-145 + an "In scope since M5-L3" paragraph), `docs/bpmn/07-execution-semantics.md` (:185-195 — scope-kind union + the depth wording now that MI adds the miBody scope, still publish-static), `specs/002-saga-orchestrator/spec.md` (:26 header, :840-843, :896, :976 in-place "since shipped" edits — the L2 pattern), `specs/002-saga-orchestrator/data-model.md` (title, :667/:687-688 flips, new `## M5-L3 deltas (migration 0009)` section: `mi_activations` DDL + iteration_index columns + the `@{i}` key discipline, :758-760 stub note), `specs/002-saga-orchestrator/contracts/runtime-contracts.md` (title + new `## Multi-Instance Contract (M5-L3)` section: activation decider, iteration keys, condition settle, aggregation, abort/Hazard, per-iteration compensation, caps), `CLAUDE.md` (M5-L3 shipped paragraph + `MAX_MI_CARDINALITY` in the caps list + next = M5-L4)

**Matrix wave (one-object-per-line rows; all `phase: 1`; dual-mode rows declare `workflowFile: "tests/workflow-mode/matrix.wf.test.ts"`):**
`MI-PAR-TASK-01` (axes incl. "multiInstance"), `MI-SEQ-COLL-01`, `MI-ZERO-01`, `MI-CAP-01` (direct-only), `MI-PAR-SUB-01`, `MI-SEQ-SUB-01` (direct-only), `MI-COND-EARLY-01`, `MI-COND-LEDGER-01` (direct-only), `MI-ERR-BOUNDARY-01`, `MI-HAZARD-TIMER-01`, `MI-CALL-FANOUT-01`, `MI-CALL-COMP-01`, `MI-CALL-ERR-01` (direct-only), `MI-COMP-REVERSE-01` (direct-only), `MI-COMP-STRAGGLER-01` (direct-only), `MI-LINEAGE-01` (direct-only) → `directFile` = the Task 6–12 suites that already carry the `[id]` markers (add markers to it() titles retroactively where missing — grep each). Rejects (3, `legality:"reject"`, `directFile: "tests/unit/validator-multi-instance.test.ts"`… **NO** — rejects must live in integration/matrix homes per the L2 pattern; point them at `tests/integration/multi-instance-publish.test.ts` and ADD the markered publish-reject tests there): `MI-REJECT-DATABINDING-01`, `MI-REJECT-NOSOURCE-01`, `MI-REJECT-BODY-01`. Flip `R-MI-SUBPROC-01`'s test body: MI-subProcess now ACCEPTS — repoint the scenario title/test to "MI body containing a receiveTask rejects (v1 whitelist)" keeping the id + `R-` prefix (floor stays ≥ 11). New totals: 86 + 19 = **105** scenarios, rejects 19 + 3 = **22** — update `registry.test.ts:5` `toHaveLength(105)`, `:23-27` `toHaveLength(22)`, `check-matrix.mjs:87` `105`.

- [ ] **Step 1:** registry rows + count bumps + `MUST_COVER` + reject flips; `npm run check:matrix` → 0 failures.
- [ ] **Step 2:** docs sweep (every file above); `npm run check:docs` → PASS (this catches any `MAX_MI_CARDINALITY = <n>` literal drift).
- [ ] **Step 3:** `npm run test:matrix && npm run test:unit && npm run test:integration && npm run typecheck` → PASS.
- [ ] **Step 4: Commit** (two commits: `test(m5-l3): e2e matrix MI wave …` and `docs(m5-l3): lockstep sweep — 09-profile SHIPPED block, spec/data-model/contracts deltas, CLAUDE.md`).

---

### Task 14: Workflow-mode Layer B + real-CF smoke + PR

**Files:**
- Modify: `tests/workflow-mode/matrix.wf.test.ts` (new `describe("matrix workflow-mode: M5-L3 multiInstance")` block)
- Create: nothing else

**Steps:**

- [ ] **Step 1: Author the Layer B block** (driver API: `publishAndStart`, `leaseWhenReady`/`completeJob`, `pollToTerminal`, `getInstance`, `getHistory`): live tests `[MI-PAR-TASK-01]` (3 concurrent leases over real Workflows, aggregation), `[MI-SEQ-COLL-01]`, `[MI-CALL-FANOUT-01]` (poll lineage for 3 children), `[MI-COND-EARLY-01]`, `[MI-ERR-BOUNDARY-01]`; `it.skip @needs-real-cf` for `[MI-CALL-COMP-01]` + `[MI-HAZARD-TIMER-01]` (tx/compensation + timer-Hazard are tickle-flaky under wrangler-dev — L2 precedent); `it.skip @needs-override` for `[MI-CAP-01]` (needs `MAX_MI_CARDINALITY_OVERRIDE`) — every skip title carries its `[id]` marker.
- [ ] **Step 2: Run Layer B locally**: `rm -rf .wrangler/state && npx wrangler d1 migrations apply easy_bpmn --local && npx wrangler dev --port 8787 --local --var MAX_WAKE_BACKSTOP_OVERRIDE:8000` (background, kill by PID after) then `npm run test:wf` — the MI block + the pre-existing blocks green (skips excepted).
- [ ] **Step 3: Full local gate**: `npm test && npm run typecheck && npm run check:docs && npm run check:matrix && npm run test:matrix && npm run test:ui && npm run typecheck:ui && npm run build:ui && npx wrangler deploy --dry-run`.
- [ ] **Step 4: PR** — push `m5-l3-multi-instance`, open the PR (`gh pr create`) titled `M5-L3: multiInstance — data-driven fan-out (parallel + sequential, MI-callActivity, per-iteration compensation)`, body = layer summary + exit-criteria checklist + the real-CF smoke plan.
- [ ] **Step 5: Real-CF smoke (merge gate)**: after CI green, deploy the branch to the real worker (or a preview), apply remote migration 0009 (`npx wrangler d1 migrations apply easy_bpmn --remote`), run `WF_BASE_URL=https://bpmn.rntme.com npm run test:wf -- -t "M5-L3"` plus the two `@needs-real-cf` scenarios manually; record results in the PR; merge on green.
- [ ] **Step 6: Backlog closeout** — flip the TASK-82…88 backlog files to Done with Final Notes (commits + scenario ids), the L2 TASK-75..81 precedent.

## Execution notes

- Task order is strict for 1→5 (foundations), then 6→11 are sequential (each builds on the driver), 12 can run after 10, 13–14 last.
- The M5-L2 suites are the no-op regression net — they run in every task's verify step and must never need edits (except where a task explicitly lists them).
- If context/compaction forces a handoff: the branch, this plan's checkboxes, and the backlog tasks are the durable state; re-read the design spec + `git log --oneline main..HEAD` to resume.
