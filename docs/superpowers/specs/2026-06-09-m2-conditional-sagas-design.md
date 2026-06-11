# M2 — Conditional Sagas (exclusiveGateway + FEEL conditions + loops) — Design

**Date:** 2026-06-09
**Status:** Approved design (brainstorming output). Slices milestone **M2** of
`docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md` (§8 row M2, §9 open question, §5
`gateway_decisions` stub) into a concrete, implementable design. Target semantics:
`docs/bpmn/03-gateways.md`.
**Resolves (saga design §9):** the M2 expression-language open question → **FEEL via `feelin`**.
**Extends (saga design §8):** M2 scope now **includes cycles** (loop back through an XOR gateway) —
the saga design deferred the same-element-runs-N-times problem with "this shape is not stable past
M1" (§5 note); this design pays that cost now via an **occurrence discriminator** instead of
deferring it to M4/M5.

---

## 1. Context & goal

After the M1 closeout (commit `b6ba5fb`), the engine executes canonical transaction-sagas over pull
workers, but control flow is still deterministic-linear: the validator rejects >1 outgoing sequence
flow (`validator.ts:491-497`), `conditionExpression`, and the `default` attribute; the engine is a
scalar cursor over `node.next`. The multi-edge groundwork already exists:
`GraphNode.outgoing: Flow[]` carries `conditionExpression`/`isDefault` hooks (always `null`/`false`
today), and sequence-flow topology is persisted and replay-deterministic (`bpmn_elements`,
migration `0003_topology.sql`).

M2 makes sagas **data-driven**: a saga can branch on instance variables (`exclusiveGateway` +
FEEL conditions + `default`) and **loop** (retry-with-changed-input, poll-until-ready patterns),
with every branch decision persisted for audit and deterministic replay.

## 2. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Expression language** | **FEEL via `feelin`** (v7.x): the BPMN/DMN-ecosystem language (Camunda 8 semantics), pure-JS interpreter (lezer grammar + luxon), no `eval`/`new Function` (Workers-compatible), edited natively by Camunda Modeler → true round-trip. Rejected: JSONLogic / custom JS subset (non-standard blobs inside `conditionExpression`; fail the canonicity test). |
| 2 | **Cycles** | **Allowed in M2** (user decision; expands the milestone beyond the original "L"). Requires an **occurrence** discriminator across jobs, ledger, subscriptions, step names, and decisions. Loop iteration cap: `MAX_ELEMENT_OCCURRENCES = 1000` (engine constant) → terminal incident `kind=loopLimit`. |
| 3 | **Where conditions live** | **Only on outgoing flows of `exclusiveGateway`.** Conditional flows on activities (implicit split) stay rejected — implicit multi-out is inclusive-split semantics and pulls multi-token (M4) into M2. |
| 4 | **Architecture** | **Approach A — occurrence-extension of the current single-token engine.** Rejected: tokens-first (pulling M4's `execution_tokens` forward — double migration churn since M4 redesigns for concurrency anyway); job-row reuse without occurrence (conflates attempt audit across iterations, breaks Workflow step-name memoization). |
| 5 | **No-match / ambiguity** | Per BPMN: evaluate conditions in **document order**, first `true` wins; none true → `default`; no default → terminal incident `kind=noPath` (inside a transaction this is a **Hazard**: no auto-compensation, operator may `/cancel`). Deterministic by persisted flow order. |
| 6 | **Decision replay** | A `gateway_decisions` row is written **atomically with the transition** (persist-before-advance). An existing row for `(instance, gateway, occurrence)` is **reused, never re-evaluated** — crash/replay takes the recorded branch in both execution modes. |

## 3. Profile / validator (publish-time)

Accept, everywhere a token node can appear (process level and inside `transaction`):

- `bpmn:exclusiveGateway` — split (1 in, N out) and join (N in, 1 out; pass-through, no waiting).
- On a **split**: every **non-default** outgoing flow MUST carry a `conditionExpression`
  (`tFormalExpression`; language unset or FEEL); the **`default`** flow (gateway attribute) MUST
  NOT carry one and MUST reference one of the gateway's own outgoing flows. A 1-out gateway is a
  pass-through/merge and needs no conditions.
- All conditions are **FEEL-parsed at publish** (`feelin`); a parse failure rejects the draft with
  element id + reason (the existing reject contract).
- **Cycles on the token path are legal.** Reachability stays BFS-based (already graph-shaped).

Still rejected, with element id + reason: `conditionExpression` on any flow not leaving an
`exclusiveGateway`; >1 outgoing flow on a non-gateway node; boundary events attached to a gateway
(invalid BPMN); `inclusiveGateway`/`parallelGateway`/`eventBasedGateway`/`complexGateway`
(M4/M3); everything in the M1 reject list.

Round-trip: a saga model with an XOR split/join and FEEL conditions must round-trip (semantically)
through bpmn-js — same publish-time test as the §3 saga example.

## 4. IR + persisted topology

- `NodeType`/`ElementType` += `"exclusiveGateway"`.
- `Flow.conditionExpression`/`Flow.isDefault` become live; **`outgoing[]` order = document order =
  evaluation order** (made explicit and persisted).
- `bpmn_elements` gains `condition_expression`, `is_default` columns (additive). The
  `getVersionGraph` deep-equal-vs-fresh-parse replay test extends to conditions.
- `GraphNode.next` stays derived (`outgoing[0]`) for non-gateway nodes; the engine never reads
  `.next` on a gateway — branch selection owns it.

## 5. Engine — "the walk is the replay" (cycles machinery)

The load-bearing change. Two M1 assumptions break under cycles:

1. `getForwardJobByElement(instanceId, elementId)` — on re-entering an element the engine would
   find the prior iteration's completed job and silently fast-forward past the step.
2. Workflow step names (`svc-create:${elementId}`, `wait-job:${elementId}`, `msg:${elementId}`) —
   step memoization is by name, so a second iteration would return the first iteration's memoized
   result.

**Fix — one mechanism for both:**

- **Occurrence = walk-local visit counter.** The engine always **re-walks the graph from the start
  element**, counting visits per element id in memory, fast-forwarding through already-applied
  steps using canonical D1 state (apply steps are idempotent: variable merges already applied,
  ledger is `INSERT OR IGNORE`, transitions re-set the same values). Workflow mode already works
  this way (replay + memoization); **direct mode switches from "resume at `current_element_id`" to
  the same rewalk-from-start**. Occurrence is NOT derived from live D1 row counts — during a
  Workflow replay those reads see post-crash state and would desynchronize step names from the
  original execution.
- **Every step name and persistence key gains the occurrence**: `svc-create:el#2`,
  `wait-job:el#2`, `msg:el#1`, `gw:el#0`. Job lookup becomes
  `getForwardJob(instanceId, elementId, occurrence)`.
- **A fresh job row per iteration**: `service_task_jobs.occurrence INTEGER NOT NULL DEFAULT 0`;
  unique index becomes `(instance_id, element_id, is_compensation, occurrence)`. At a visit the
  engine looks up the job at exactly `(elementId, walkOccurrence)`: no row → create (new
  iteration); row with un-applied output → apply it (resume frontier). A new
  `output_applied INTEGER NOT NULL DEFAULT 0` flag is set **in the same `dbBatch` as the advance**
  so the rewalk treats applied steps as **write-free fast-forward** (in-memory cursor move only) —
  re-running the apply would re-merge an old iteration's output over newer variables (regression),
  re-write the cursor backwards, and duplicate history events. The `bpmn_job_<jobId>` event type
  is already unique per job; the `/jobs/*` worker contract is unchanged.
- **Receive Tasks in loops**: message subscriptions are keyed with occurrence too; the broker key
  (`workspaceId + messageName + correlationKey`) is unchanged — sequential re-subscription on the
  same key is the already-supported pattern.
- **Loop guard**: when a walk-local counter exceeds `MAX_ELEMENT_OCCURRENCES` (1000) → terminal
  incident `kind=loopLimit`; inside a transaction this is Hazard semantics (no auto-compensation;
  operator `/cancel` available). This also bounds the Workflow step budget (R5: `limits.steps`
  25000 vs ~5 steps per task iteration).

Cost note: direct-mode wake-ups become O(history) rewalks — acceptable at MVP scale, and identical
in shape to what Workflow replay already does.

## 6. Gateway dispatch + `gateway_decisions`

Node dispatch gains `exclusiveGateway`. Inside one persisted step (`gw:${elementId}#${occ}`):

1. If a decision row exists for `(instance_id, element_id, occurrence)` → take its
   `chosen_flow_id` (fast-forward; never re-evaluate).
2. Else read instance variables from D1 → evaluate non-default outgoing conditions in document
   order → first `true` wins → else `default` → else terminal incident `kind=noPath`.
3. Persist the decision row + `applyTransition` to the chosen target + history event in **one
   `dbBatch`** (persist-before-advance).

```sql
CREATE TABLE gateway_decisions (
  decision_id        TEXT PRIMARY KEY,
  instance_id        TEXT NOT NULL,
  element_id         TEXT NOT NULL,     -- the exclusiveGateway
  occurrence         INTEGER NOT NULL,
  chosen_flow_id     TEXT NOT NULL,
  is_default         INTEGER NOT NULL DEFAULT 0,
  evaluations        TEXT NOT NULL,     -- JSON [{flowId, expression, result}] in document order
  variables_snapshot TEXT,              -- evaluation context; size-capped by the payload limit
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_gateway_decisions ON gateway_decisions (instance_id, element_id, occurrence);
```

Visibility: a `gatewayDecisionEvaluated` history event (free-text `history_events.type` — no schema
change) carrying `{chosenFlowId, occurrence, evaluations}` in `diagnostics`. No new public endpoint
in M2 (the operator story is covered by history; YAGNI).

## 7. FEEL evaluation module (`src/runtime/expressions.ts`)

Thin wrapper over `feelin`:

- **Publish-time**: `parse(expression)` — syntax check only; failure → validation issue.
- **Runtime**: `evaluateCondition(expression, variables) → boolean`. The flow is taken only on
  boolean `true`. FEEL null-tolerance is preserved as the standard semantics: a missing variable
  makes comparisons `null` → not `true` → flow not taken (NOT an error). A hard interpreter throw →
  incident (deterministic, operator-visible).
- Context = the instance's current variables object (same JSON the service-task input uses).

## 8. Compensation with iterations

`saga_steps.occurrence INTEGER NOT NULL DEFAULT 0`; `uq_saga_steps_forward` becomes
`(instance_id, element_id, occurrence)`; the `INSERT OR IGNORE` dedup contract is preserved per
iteration. Each completed pass of a compensatable step is its own ledger row, so the existing
reverse pass (`ORDER BY seq DESC`) **compensates every iteration separately with zero algorithm
change** (two completed `reserveStock` passes → two `release-stock` compensation jobs, reverse
order). A compensation job inherits its forward step's occurrence (uniqueness:
`(instance_id, element_id, is_compensation, occurrence)`).

## 9. Migration `0004_conditional.sql` + contracts

Additive only:

- `service_task_jobs`: + `occurrence`, `output_applied`; drop/recreate
  `uq_jobs_instance_element_kind` → `(instance_id, element_id, is_compensation, occurrence)`.
- `saga_steps`: + `occurrence`; recreate `uq_saga_steps_forward` → `(instance_id, element_id, occurrence)`.
- `message_subscriptions`: + `occurrence` (keyed per visit).
- `bpmn_elements`: + `condition_expression`, `is_default`.
- New `gateway_decisions` table (above).
- `incidents.kind` += `loopLimit | noPath` (zod contracts + openapi updated).
- Worker-facing `/jobs/*` schemas unchanged.

## 10. Testing (exit criteria — constitution gate)

Integration unless noted:

1. **Branching**: data-driven XOR selects the right path; decision row recorded with per-flow
   evaluations; `default` taken when no condition matches.
2. **No-match**: no `true` + no `default` → terminal `noPath` incident; inside a transaction →
   Hazard (no auto-compensation), then operator `/cancel` compensates.
3. **Ambiguity**: multiple `true` conditions → first in document order, deterministically.
4. **Loop + compensation**: N iterations of a compensatable step → N jobs (occ 0..N-1) + N ledger
   rows; a later business error compensates **each** iteration in reverse `seq` order.
5. **Loop guard**: a model exceeding `MAX_ELEMENT_OCCURRENCES` → `loopLimit` incident.
6. **Replay determinism**: restart mid-loop in BOTH modes (direct rewalk; Workflow memoization) →
   no duplicate jobs, decisions reused not re-evaluated; `getVersionGraph` deep-equal still holds
   with conditions persisted.
7. **Publish-time matrix** (unit + contract): invalid FEEL rejected with element id; condition on a
   non-gateway flow rejected; `default` referencing a foreign flow rejected; non-default
   condition-less gateway flow rejected; gateway round-trips through bpmn-js.
8. **Idempotency**: duplicate `complete`/`fail` within a loop iteration advances at most once per
   occurrence.
9. **FEEL null-semantics** (unit): missing variable → flow not taken, no incident.

## 11. Risks

- **R-M2-1 (largest): direct-mode rewalk-resume** — changes the engine's resume semantics;
  mitigated by the existing 120-test suite (must stay green untouched) + scenario 6.
- **R-M2-2: feelin bundle size** (~253 KB unpacked + luxon) — verify via
  `wrangler deploy --dry-run`; Workers Paid script limit (10 MB) leaves ample headroom.
- **R-M2-3: FEEL edge semantics** — null-tolerance and type coercion need explicit unit coverage
  (scenario 9) so "condition silently false" is a tested behavior, not a surprise.
- **R-M2-4: `variables_snapshot` growth** — reuse the existing payload-limit check as the cap.
- **R-M2-5: step budget under loops** — the 1000-iteration cap bounds it; document per-iteration
  step cost next to the `limits.steps` setting.

## 12. Backlog mapping (milestone m-2, ≈9 tasks)

1. Validator/profile: accept XOR + FEEL conditions + `default` + cycles; reject matrix; bpmn-js
   round-trip test.
2. Graph IR + persisted topology: gateway node kind; live `Flow.conditionExpression`/`isDefault`;
   `bpmn_elements` columns; deep-equal replay test.
3. FEEL module (`feelin` wrapper): boolean/null contract, publish-time parse, unit tests, bundle
   check.
4. Migration `0004_conditional.sql` + zod/openapi contracts + incident kinds.
5. **Engine: occurrence + rewalk-resume** ("the walk is the replay") — jobs/receive/step names
   keyed by occurrence; `output_applied` marker. The heart of M2.
6. Engine: `exclusiveGateway` dispatch + `gateway_decisions` persist-before-advance + history
   event + `noPath`.
7. Loop guard (`loopLimit`) + Hazard semantics inside a transaction.
8. Compensation with iterations: ledger occurrence + the loop-compensation integration scenario.
9. Governance lockstep: constitution 2.0.0 → 2.1.0 (trim the exclusion list by exactly what M2
   ships) + `docs/bpmn/03-gateways.md` easy-bpmn scope section + `09-easy-bpmn-profile.md` +
   sample model + quickstart scenarios.

**Next step after backlog:** `writing-plans` for the M2 task set (per-task implementation plans),
then implement in task order 1→9 (5 and 6 are the critical path; 1–4 unblock them).

---

## 13. Implementation deltas (post-implementation amendments, TASK-37)

Corrections and clarifications recorded after the M2 implementation landed (TASK-29..36); the
sections above are left as written for history.

- **Step budget (§5, §11 R-M2-5): the running budget is 10,000, not 25,000.** Cloudflare Workflows
  allows **10,000 steps per instance by default on Workers Paid**; 25,000 is the configurable
  **maximum** via `"limits": { "steps": N }` (1,024 on Free; `step.sleep` doesn't count) — verified
  2026-06-11 against developers.cloudflare.com/workflows/reference/limits/. This deployment runs
  the 10k default; the per-shape arithmetic (a single-element loop trips `loopLimit` at ~4-7k
  steps, safely inside 10k; a hot multi-element cycle can exhaust the platform budget first) and
  the escalation knob live in the **`wrangler.jsonc` workflows block comment**, which is the
  authoritative budget note.
- **`variablesSnapshotOmitted` flag shape (§6).** `gateway_decisions.variables_snapshot` is capped
  by the existing event-payload limit as designed (R-M2-4); the implemented shape: an oversized
  evaluation context stores `variables_snapshot = NULL` and the `gatewayDecisionEvaluated` history
  diagnostics carry `variablesSnapshotOmitted: true` + `variablesByteSize` — an omission marker,
  never an error (the decision itself is unaffected). Pass-through (1-out) gateway visits also
  store `NULL` (no conditions were evaluated), without the flag.
- **Retry-after-noPath semantics (§6).** A **failed** gateway visit (`noPath`, or a hard FEEL
  evaluation error) writes **no** `gateway_decisions` row — the row is written only atomically with
  a successful transition. Consequently an operator `POST /instances/{id}/retry` **re-evaluates the
  failed visit fresh** (typically after a variable patch), which is the intended remediation;
  "reused, never re-evaluated" applies only to recorded (successful) decisions.
