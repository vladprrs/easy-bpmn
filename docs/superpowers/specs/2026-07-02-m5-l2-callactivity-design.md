# M5-L2 — `callActivity` (reusable sub-saga): design

**Date:** 2026-07-02
**Status:** validated with the user (brainstorming session); supersedes nothing — refines
`2026-06-20-m5-composition-design.md` §6 "M5-L2" into an implementable layer design.
**Governance:** constitution v2.5.0 already accepts the full M5 construct set with recorded
callActivity clauses (publish-time version binding, cross-instance idempotency, child compensation
= the child's own reverse pass). This layer **opens the runtime** for `callActivity`; no new
constitution version is required, only the per-layer Constitution Check and the lockstep doc sync
(precedent: M5-L1).

## 0. Prerequisite: M5-L1 review follow-ups land first

TASK-71 (runtime re-entry backstop), TASK-72 (`drainScopeSubtree` does not release message
subscriptions / broker keys), and TASK-73 (armed scope timer fires on an incident/compensating
instance) ship as a **separate short branch before M5-L2 starts**. Two of them are load-bearing
here: L2's cascading child cancellation extends the same drain path TASK-72 fixes, and the child
lifecycle inherits the timer/status blind spot TASK-73 closes. TASK-74 (polish sweep) is not a
prerequisite.

## 1. Approach

**Chosen: a real child instance with its own Cloudflare Workflow** (cross-instance lifecycle,
composition-design thread C). The child is a full `process_instances` row plus its own Workflow,
indistinguishable at runtime from an API-started instance except for its parent linkage. The
parent parks on the existing single-wake (`WAKE_TYPE`, TASK-54 protocol); the child tickles the
parent at its terminal.

Rejected alternatives:

- **Inline expansion at publish** (rewrite the callActivity as an embedded `subProcess`): no
  per-child inspection, merges child history into the parent, removes the foundation M5-L3
  MI-callActivity explicitly needs ("fan-out of child instances" is a literal M5 exit criterion),
  and would reopen already-recorded constitution clauses. This is declining the layer, not
  building it.
- **Hybrid** (own D1 row, execution driven inside the parent Workflow): avoids the cross-Workflow
  wake handshake but consumes the parent's step budget per child, compounds with nesting, and
  forks retry/termination semantics between root and child instances.

## 2. Data model (migration `0008_call_activity.sql`)

```sql
CREATE TABLE child_instances (
  parent_instance_id TEXT    NOT NULL,
  parent_element_id  TEXT    NOT NULL,            -- the callActivity node id
  occurrence         INTEGER NOT NULL,
  iteration_index    INTEGER NOT NULL DEFAULT 0,  -- reserved for M5-L3 MI
  child_instance_id  TEXT    NOT NULL,
  status             TEXT    NOT NULL,            -- invoked | outputApplied
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  UNIQUE (parent_instance_id, parent_element_id, occurrence, iteration_index)
);
```

Plus, on `process_instances`: nullable `parent_instance_id`, `parent_element_id`,
`parent_occurrence` (back-reference; root instances stay NULL) and nullable `error_code`
(the child's uncaught business-error terminal, read by the parent — §4). On `saga_steps`:
nullable `child_instance_id` (step-kind dispatch — §5).

The `child_instances` row is the **provenance row of the child-idempotency triad**: it is written
in the same persist-before-advance batch that decides to invoke the child, and it — not Workflow
step memory, not `runStep` memoization — is the rewalk fast-forward predicate gating `create()`
(the analogue of `gateway_decisions` / `matched_subscription_id` / `output_applied=1`).

## 3. Forward lifecycle (new `src/runtime/call-activity.ts`, mirroring `service-task.ts`)

Engine reaches `call:el#occ`:

1. **Fast-forward predicate** — an existing `child_instances` row: `outputApplied` → pure
   write-free cursor move; `invoked` → skip to step 3 (park).
2. **No row → one persist-before-advance `dbBatch`:** deterministic
   `child_instance_id = "pi-" + hash(parentInstanceId, elementId, occurrence, 0)` (the iteration
   index is in the hash now so M5-L3 MI does not collide N iterations onto one id); insert the
   provenance row (`invoked`) + the child's `process_instances` row (variables = full snapshot of
   the parent's effective variables — pass-through in; `correlation_key = 'child:' + childId`, a
   technical value that never reaches the broker because child message waits are rejected at
   publish, §7) + a `callActivityInvoked` history event. Then the **idempotent CF create**:
   `PROCESS_WORKFLOW.create({ id: childId })` with "id already in use" treated as success — never
   an auto-generated id.
3. **Park** on the parent's single wake, exactly as for a job wait.
4. **Child terminal → parent tickle + bounded self-heal.** The child engine detects
   `parent_instance_id != NULL` at its terminal write and tickles the parent
   (`sendEvent WAKE_TYPE`). Because a child has no `/jobs/activate` lease handshake, the tickle
   can land in the gap before the parent arms its wait (the `W-AND-TICKLE-GAP-01` class), and the
   only stock recovery is the 1-hour `MAX_WAKE_BACKSTOP_MS` — compounding per nesting level. So
   the same terminal write **arms a durable DO alarm** (extending `JobScheduler`, which already
   owns DLQ + model-timer alarms) that retries the parent tickle until the parent's history shows
   the child consumed; total retries bounded per level (cap derived so `MAX_CALL_DEPTH` levels
   stay bounded). The `MAX_WAKE_BACKSTOP_MS` vs "a few minutes" doc/code drift is reconciled in
   the same change; the child-wait path is explicitly short.
5. **Apply-once decider on wake.** The parent re-reads the child row. Child `completed` → one
   atomic `dbBatch`: merge the child's variables into the parent (pass-through out; when the
   callActivity sits inside an M4 parallel/inclusive region the merge targets the **branch
   overlay**, not root vars), set `child_instances.status = 'outputApplied'`, transition out of
   the park. A duplicate wake no-ops on the row status. Keyed by
   `(parentInstance, element, occurrence, iteration)` — this is the `call_output_applied` decider
   of the composition design, realized as the row-status transition.

Cold inline re-drive of the parent (the `deliverJobResult` terminated-Workflow fallback) neither
double-starts nor double-applies: both sides are gated by the provenance row.

## 4. Errors, boundaries on the callActivity, cascading drain

**Child business error → parent.** An uncaught error end event in a *child* does not raise the
child-local `uncaughtError` incident (that is root behavior); the child settles terminally as
`status='errored'` with `error_code` on its instance row, its Workflow ends, parent tickled. The
parent, on wake, routes **as if the callActivity itself threw that error**: first a matching
error boundary on the callActivity (by `errorRef` code, or catch-all), then standard M5-L1
hierarchical bubbling through the parent's scope tree, `uncaughtError` at the parent root.
Escalation is **out of this layer** (its construct opens in its own M5 layer).

**Child technical incident** (e.g. `serviceTaskFailure` after retries): the child is
**non-terminal** (`incident`), no tickle, the parent stays parked. Operator `/retry` on the
parent **cascades down**: recursively retry incidents in the child subtree first (the child then
finishes on its own and tickles normally); only when the subtree is clean retry the parent's own
incidents.

**Timer boundary on the callActivity (Hazard).** M5-L1 "interrupt without auto-compensation"
extends across the instance boundary: draining a subtree that contains a running child **cancels
the child instance** — terminate its Workflow, CAS the child to `cancelled`, release its
resources (the TASK-72 subscription/broker-key release, extended to children, applied
recursively down to `MAX_CALL_DEPTH`). The child's saga ledger is **retained**; its committed
inner transactions are not auto-compensated on Hazard, exactly as in L1.

**Cancel path.** If the callActivity sits inside a parent transaction that cancels, the parent's
reverse pass reaches the child step and drives the **child's own reverse pass** (§5) over its
retained ledger — for a completed child that is the full committed set; for a child interrupted
by a drain it compensates exactly the child's committed steps; a child ledger with nothing
committed is a no-op compensator that resolves without parking.

## 5. Compensating a committed callActivity (reverse pass of a terminated child)

Step-kind dispatch: `saga_steps.child_instance_id IS NULL` → the existing worker-task path
(`createCompensationJob` unchanged); non-NULL → child compensation:

1. **CAS entry `{completed, cancelled} → compensating`** — a distinct, narrow entry point that
   bypasses the terminal guards in `compensation.ts` / `engine.ts`. `completed` is the committed
   callActivity; `cancelled` is the drain-interrupted child of §4 whose committed steps still
   need compensation. Idempotent on `compensating|compensated` (re-entry is a no-op) and unable
   to regress a child in any other status (`errored`, `running`, `incident` never enter here). A child with no
   committed ledger steps goes straight to `compensated` and the parent step closes **without
   parking** (the no-op compensator).
2. **Inline drive of the dead child.** The child Workflow is terminated, so the reverse pass runs
   via inline drive (`runInstance` on the child, DirectExecutor-style) — the same path that
   carries operator-resume-after-termination today (`executor.ts` `deliverJobResult` fallback).
   The child's compensation jobs complete through the normal callback path: their callbacks find
   a terminated Workflow and continue inline.
3. **Parent parks** on its single wake. The child's reverse terminal
   (`compensated | compensationFailed`) tickles the parent, guarded by the same DO-alarm
   self-heal as §3.
4. **Parent on wake** re-reads the child: `compensated` → `markStepCompensated` (write-free
   fast-forward like any other step); `compensationFailed` → the **parent's own**
   `compensationFailed` incident (constitution clause); the reverse pass halts and is repaired by
   the cascading `/retry`.

**Reverse-path matrix (mandatory scenarios):** parent crash mid-child-compensation (rewalk sees
`compensating`, re-parks); double entry into the child step (CAS no-op); lost compensation tickle
(DO alarm completes it); re-drive of an already-`compensated` child (write-free fast-forward).

## 6. Operator surface and console delta

**Cascade down; direct child operations are forbidden** (user decision):

- `POST /instances/{parent}/cancel` — the drain cancels running children recursively (§4), then
  the normal reverse pass runs child reverse passes per §5.
- `POST /instances/{parent}/retry` — subtree-first cascade (§4).
- `cancel`/`retry` **directly on a child** (`parent_instance_id != NULL`) → `409` whose body
  names the `parentInstanceId` ("operate via the saga root"). One check in both handlers.

**Console delta — lineage only:**

- `GET /instances/{id}` gains a `lineage` block: `parent {instanceId, elementId}` +
  `children[] {elementId, occurrence, childInstanceId, status}` — a direct `child_instances`
  read; the D1-only inspection invariant holds.
- SPA: the callActivity node on the diagram links to the child instance; the child shows a
  breadcrumb back to the parent; cancel/retry controls are hidden on child instances (driven by
  `lineage.parent`).
- `GET /instances` lists children as ordinary rows; a `?root=true` filter keeps saga lists
  uncluttered. Heatmap and all other screens unchanged.

## 7. Validator / publish-time

`bpmn:callActivity` leaves interim-reject. At the **caller's** publish:

- `calledElement` resolves to the **latest published version** of the referenced process in the
  same workspace → `calledDefinitionVersionId` recorded in the caller's `parsed_profile`
  (constitutional publish-time binding; Camunda's runtime `latest` is deliberately not honored).
  Unresolved → reject with element id + reason.
- Non-process `calledElement` (GlobalTask) → its own explicit reject, not the generic
  "unresolved". `camunda:calledElementBinding` / `calledElementVersion` are
  tolerated-and-ignored (a documented surprise).
- **Static call-cycle rejection**: child versions are pinned at publish, so the call graph is
  immutable — DFS over the resolved call tree; a cycle rejects.
- **`MAX_CALL_DEPTH = 4`** (constant in `src/runtime/engine.ts` beside the other caps, under the
  `check:docs` lockstep sync): call depth is statically computable at publish
  (`1 + max(child depths)`), so this is a **publish-time reject**, not a runtime incident — same
  discipline as `MAX_SCOPE_DEPTH`. Scope depth remains per-definition; cross-instance depths do
  not sum.
- **v1 message reject**: a `receiveTask` or message `intermediateCatchEvent` anywhere in the
  **resolved call tree** (grandchildren included — they have the same missing-key problem) →
  reject at the caller's publish with element id + reason. The called process itself stays
  publishable and API-startable standalone; only calling it is restricted. Rationale: a child is
  never API-started, so it has no correlation-key source (`process_instances.correlation_key` is
  NOT NULL); v1-reject keeps the one-subscription-per-broker-key invariant trivially sound.
  Fast-follow candidate: inherit the parent's key together with a cross-definition extension of
  the broker-key guard.
- Boundaries **on** a callActivity: error / timer / compensation boundaries are legal as on any
  activity (M5-L1 mechanics; compensation wiring still requires a transaction ancestor).

## 8. Canonicity docs (lockstep, no behavior)

- `docs/bpmn/09-easy-bpmn-profile.md`: callActivity → accepted-and-validated; io-mapping
  documented as **pass-through both ways** (the Zeebe-aligned default, an explicit divergence
  from OMG/Camunda-7 "no data crosses the boundary"); `easy-bpmn:ioMapping` deferred as the
  future selective-mapping escape hatch.
- Fix the `docs/bpmn/02-activities.md:68` contradiction ("Requires explicit in/out data
  mapping" describes standard BPMN, not the chosen default).
- Constitution: per-layer Constitution Check in the plan + a PATCH note recording the L2 runtime
  opening (L1 precedent); CLAUDE.md M5 paragraph updated in the same PR.

## 9. Testing and exit criteria

**Unit:** validator accepts callActivity and rejects each of: unresolved `calledElement`,
GlobalTask target, call cycle, `MAX_CALL_DEPTH` overflow, message wait anywhere in the call tree
(including a grandchild), while tolerating `camunda:*` binding attributes; child-id determinism.

**Integration (direct mode, `vitest-pool-workers`):** forward happy path with pass-through
variables both ways; idempotency (double drive → one child, one apply); child error → callActivity
boundary / bubbling / parent `uncaughtError`; child technical incident + cascaded retry; Hazard
timer with cascading cancellation of a running child; parent cancel → reverse pass driving the
child's reverse pass; child `compensationFailed` → parent incident; no-op compensator; `409` on
direct child operations; `lineage` block + `?root=true`.

**Matrix:** new scenarios registered in `tests/matrix/registry.ts` (under `check:matrix`),
including the §5 reverse-path matrix.

**Workflow mode — critical for this layer:** vitest runs direct-mode only, and L2's two riskiest
mechanisms — the child→parent wake handshake and the DO-alarm self-heal — exist **only** in
workflow mode. Layer B scenarios run via `npm run test:wf` (wrangler dev), and a **real-CF smoke
gates the merge** (TASK-54 precedent: single-wake defects surface only on real Cloudflare). The
dropped-tickle self-heal is a mandatory smoke scenario.

**SPA (`npm run test:ui`):** lineage rendering, hidden controls on a child, clickable
callActivity node.

**Exit criteria (verbatim from the composition design):** a reusable sub-saga commits
end-to-end; a child business error propagates to the parent's callActivity boundary; a committed
callActivity compensates by driving the child's reverse pass; a child `compensationFailed`
surfaces as a parent `compensationFailed`; cold inline re-drive of the parent does not
double-start or double-apply the child; the dropped-tickle self-heal reaches terminal once within
the bounded window.
