# M1 Closeout — Design (finish the two deferred M1 tasks before M2)

**Date:** 2026-06-08
**Status:** Approved design (brainstorming output). Scopes the completion of milestone **M1** — the two tasks left in *To Do* after the M1 core landed (`5c7c8b5`): **TASK-11** (multi-edge graph IR + queryable topology persistence) and **TASK-23** (Service-Task failure-edge policies: retry backoff, un-leasable-job DLQ, poison-job).
**Parent design:** `docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md` (§4.1 IR, §4.3 pull-worker failure edges, §4.5 taxonomy, §5 data model). This doc does **not** supersede it; it records the closeout-specific decisions and the *as-built* reality discovered by reading the M0/M1 code.
**Out of scope:** everything M2+ (gateways, conditions, expression language). M2 is brainstormed separately once M1 is closed.

---

## 1. Context — why these two tasks remain

M0 (governance + profile widening) and the M1 core (pull workers, auth, Service-Task-as-wait, transaction scope, reverse-order compensation, operator verbs, saga view, status table, ledger) are committed. Two M1 tasks were deliberately deferred and stayed *To Do*:

- **TASK-11** — the engine-facing multi-edge IR (`outgoing: Flow[]`) + persisted, queryable topology. Deferred because the M1 forward path is **single-token**, so the engine runs fine on the linear `next` cursor; the multi-edge shape has **no M1 runtime consumer** (its consumer is M2 branch selection).
- **TASK-23** — retry backoff, un-leasable-job DLQ TTL, poison-job termination. Deferred (per its own notes) to avoid backoff-aware test churn + new cron/alarm infra late in a long session.

**Decision (scope):** finish both as a clean M1 closeout *before* brainstorming M2 (rejected alternatives: fold the IR into M2; or do M2 narrowly assuming the IR exists). The two tasks are **independent** — TASK-11 is parse/IR/persistence; TASK-23 is runtime + a Durable Object. They ship as **two separate PRs**, orderable either way / in parallel.

---

## 2. As-built reality (verified by reading the code)

Two findings materially change the work from what the (pre-M0) task text assumes.

### 2.1 ~70% of TASK-11 already landed in M0

`src/bpmn/validator.ts` already **populates** the full scope-aware structure that TASK-11's text describes as missing:

- transaction scope `{startId, childIds, endIds, compensations}` (`validator.ts:699-713`), `associations` (`:734`), `errors`, boundary classification — `kind` / `attachedToRef` / `errorRef` / `errorCode` / `compensationHandlerId` (`:684-691`), `endKind` (`:348`).
- **All** the M1 negative validations already exist: compensation boundary must have zero outgoing flow (`:533`), exactly one outgoing `<association>` (`:540`), association target in the same transaction scope (`:556`); error boundary exactly one outgoing flow (`:579`); cancel boundary exactly one outgoing flow (`:603`); `isForCompensation` only inside a `<transaction>` (`:615`).
- Reachability is already a BFS over flow **+ attachment + association** edges (`:623-653`), so compensation handlers (no incoming sequence flow) are **not** flagged unreachable.
- The §3 order-saga already **publishes** and round-trips.

The validator even builds the per-scope multi-edge adjacency map internally (`:416`) — then **flattens** it to `next = outgoing[0] ?? null` (`:677`).

### 2.2 0002_saga.sql already shipped every column TASK-23 needs

`migrations/0002_saga.sql` already added `activation_expires_at`, `lock_token` / `lock_expires_at` / `worker_id`, `error_code`, `incidents.kind` + `incidents.resolution`, the relaxed `uq_jobs_instance_element_kind` index, `idx_jobs_leasable`, `saga_steps`, and `worker_credentials`. **TASK-23 needs no new D1 columns** — it is pure runtime logic + one new Durable Object + tests.

**Backlog hygiene (approved):** rewrite TASK-11's acceptance criteria / implementation plan to the real residual gap below; its current plan predates M0, cites stale line numbers, and assumes a from-scratch IR. TASK-23's task text is accurate.

---

## 3. TASK-11 — residual design

### 3.1 Expose `outgoing: Flow[]` on `GraphNode` (keep `next` derived)

- Add `Flow { flowId: string; targetId: string; conditionExpression?: string | null; isDefault?: boolean }`.
- `GraphNode.outgoing: Flow[]` — built from the adjacency map already computed at `validator.ts:416`, instead of flattening to a scalar at `:677`.
- **Keep `next` as a derived convenience** (`outgoing[0]?.targetId ?? null`). The engine reads `.next` in nine places (`engine.ts:117,127,190,199,335,417,447,609,631`) and is **left untouched** — M1 stays single-token (Risk R1: zero engine blast radius). The engine's migration to *select* among `outgoing[]` by condition is M2 work.
- `conditionExpression` / `isDefault` exist on `Flow` but are **always `null` / `false` in M1** (the validator still rejects `conditionExpression` and `default`, `validator.ts:240,311`). They are the M2 hook, present in the type now so the persisted shape is stable across the M1→M2 boundary.

### 3.2 Queryable topology persistence (`migrations/0003_topology.sql`)

Chosen over JSON-only: persist topology **both** as `parsed_profile` JSON (already the engine + `getVersionGraph` source of truth) **and** as queryable D1 rows.

- New migration **`0003_topology.sql`** (0002 is taken by saga): `ALTER TABLE bpmn_elements ADD COLUMN source_ref TEXT; ADD COLUMN target_ref TEXT;` — additive, idempotent, never mutates a published version.
- Stop dropping refs: today `elements.push({ elementId: f.id, type: "sequenceFlow" })` (`validator.ts:729`) and the `bpmn_elements` INSERT (`definitions.ts:141`) write no source/target. Persist `source_ref`/`target_ref` for `sequenceFlow` rows and `source`/`target` for `association` rows.
- `getVersionElements` (`definitions.ts:179`) reads the refs back.
- The `parsed_profile` JSON already carries the full `ExecutionGraph`; `getVersionGraph` round-trip is a JSON deep-equal.

### 3.3 Tests

- **Unit:** for the §3 order-saga graph, assert each forward node's `outgoing[]` carries the right `flowId`+`targetId` (`f1..f4`, `g1..g3`); assert compensation boundaries (`reserveStock_comp`, `chargeCard_comp`) and `isForCompensation` handlers (`releaseStock`, `refundCard`) are **absent from any token-path `outgoing[]`** and **not** flagged unreachable. (The negative-wiring cases — comp boundary with an outgoing flow, 0/>1 association, cross-scope association — are already validated in M0; add explicit assertions per TASK-11 AC#4.)
- **Integration:** publish §3 → read back: `sequenceFlow` rows expose non-NULL `source_ref`/`target_ref`, `association` rows expose source/target (closing the `validator.ts:729` / `definitions.ts:141` drop). `getVersionGraph` deep-equals a freshly-parsed graph (replay determinism).

---

## 4. TASK-23 — failure-edge policies

Three mechanisms, three trigger natures. No new D1 columns (§2.2).

### 4.1 Retry backoff — lazy, no background trigger

- On `/jobs/fail` with `retryable` (no `errorCode`) **or** a lease-expiry reclaim at attempt *n*: park the job `status='locked', lock_token=NULL, lock_expires_at = now + computeBackoffMs(n)`. The existing activate gate (`status='locked' AND lock_expires_at < now`) re-leases it only after the delay — so **backoff reuses the lease gate and needs no new column** and stays **distinct from `leaseMs`** (lease bounds one in-flight attempt; backoff spaces attempts apart).
- `src/runtime/retry-policy.ts` exports pure `computeBackoffMs(attempt, policy)` = `min(maxBackoffMs, baseMs * factor^(attempt-1))` + full jitter, plus the `RETRY_POLICY` / `ACTIVATION_TTL_MS` / `POISON_THRESHOLD` defaults. Unit-tested over attempts `1..N` with a jitter-bounds assertion.
- **Idempotency:** a duplicate `fail` for the same `jobId`+`lockToken` returns the stable prior outcome (`workerCallback` scope) — no double attempt-count, no double-park.
- **Test wrinkle:** the existing `drainSampleWorkers` driver assumes immediate re-lease; backoff tests must advance time / set `lock_expires_at` into the past to re-lease.

### 4.2 DLQ for un-leasable jobs — per-job Durable Object alarm

Chosen mechanism (over cron sweep and lazy-only): a Durable Object alarm. Lazy-only was rejected because a job whose `taskType` is **never** polled would never evict (the exact DLQ case). Within DO-alarm, the design is **per-job, self-checking, idempotent** (chosen over a single timer-wheel scheduler DO — a DO has only one alarm; per-job keeps the DO "dumb", avoids a shared sorted queue and any DO↔D1 drift, and is naturally isolated; per-job churn is negligible at M1 volume).

- **New DO `JobScheduler`** — `wrangler.jsonc` gains the binding + a `migrations` tag `v2` with `new_sqlite_classes: ["JobScheduler"]`. (Bindings are Worker-wide, so the DO's `env` already has `DB` + `PROCESS_WORKFLOW` + `CORRELATION_BROKER`; no extra wiring.) `CorrelationBroker` (tag `v1`) is untouched.
- **Arm:** at job creation, after the D1 insert, `JOB_SCHEDULER.get(idFromName(jobId))` → `storage.setAlarm(activation_expires_at)`, fired through `ctx.waitUntil` so it never blocks the create response. `activation_expires_at` is set at creation to `created_at + ACTIVATION_TTL_MS`.
- **Fire (`alarm()`):** re-read D1 (the canonical store — the DO holds **no authoritative state**, consistent with "D1 canonical, DO coordination only"). If the job is still `status='created' AND attempt_count=0` and past `activation_expires_at` → it is un-leasable → route a synthetic `{ outcome:'failed', retryable:false, kind:'timeout', reason:'un-leasable' }` through the **same engine job-result path** as `/jobs/fail` → terminal incident `kind='timeout'` + a `jobActivationExpired` history event + operator alert; the instance settles to a terminal status. If the job has progressed (leased / completed / failed) → **no-op**. A late or duplicate alarm is a no-op (the re-check is idempotent). The DO self-deletes its storage after firing.
- Reuses the §4.7 parent-design rule: `sendEvent` to a terminal / not-running instance is a 200 no-op ack, never a 500.
- **Negative case (AC):** a job leased *before* `activation_expires_at` is **not** timed out.

### 4.3 Poison job — synchronous, no trigger

- On `/jobs/complete`, if the output is **un-applicable** (fails to merge into instance variables / fails the post-delivery payload-limit check in `payload.ts`), count it against the job. At `POISON_THRESHOLD` → terminal incident with a **distinct `kind`**; the instance does **NOT** enter `compensating` and **no** compensation jobs are created (only a `fail` carrying an `errorCode` that matches a model `bpmn:error/@errorCode` triggers compensation, parent §4.5). Asserted explicitly in tests.

### 4.4 Default constants (approved; tunable at spec review)

`baseMs = 1000`, `factor = 2`, `maxBackoffMs = 30_000`; `ACTIVATION_TTL_MS = 15 min`; `POISON_THRESHOLD = 3`. Recorded in `src/runtime/retry-policy.ts` and the `specs/002-saga-orchestrator` runtime contract.

---

## 5. Testing strategy (direct-mode constraint)

The vitest suite runs `EXECUTION_MODE=direct` only; the Workflow-mode `sendEvent` / `waitForEvent` paths are known-untested (memory: `easy_bpmn_tests_direct_mode_only`). Therefore:

- **Backoff** and **poison** are fully direct-mode testable (the engine job-result application runs inline in direct mode).
- **DLQ:** structure the alarm to call a `terminateUnleasableJob(jobId)` routine that performs the D1 re-check and routes the synthetic failed result through the engine's job-result application path (inline in direct mode). Tests invoke the DO `alarm()` handler (vitest-pool-workers supports DO alarm testing) **or** call the routine directly, then assert the terminal incident `kind='timeout'` and the specific reason in D1 — without a live Workflow. The `sendEvent` leg in workflow mode remains the documented, pre-existing untested zone (not newly regressed).
- Every runtime / persistence / API change ships a contract or integration test (constitution gate).

---

## 6. Migrations & config summary

| Change | Where |
|---|---|
| `bpmn_elements.source_ref` / `target_ref` | `migrations/0003_topology.sql` (TASK-11) |
| (no new D1 columns for TASK-23) | — already in `0002_saga.sql` |
| `JobScheduler` DO binding + migration tag `v2` | `wrangler.jsonc` (TASK-23) |

Both migrations additive, idempotent, never mutate a published version.

---

## 7. Decisions log

1. **Scope** = finish M1 (TASK-11 + TASK-23) before M2; two independent PRs.
2. **TASK-11 IR** = expose `outgoing: Flow[]`, keep `next` derived, engine untouched (single-token through M1).
3. **Topology persistence** = full queryable (JSON + `0003_topology.sql` rows + readback), not JSON-only.
4. **DLQ trigger** = Durable Object alarm, **per-job / self-checking / idempotent** (not cron, not a single scheduler DO, not lazy-only).
5. **Constants** = base 1s / factor 2 / maxBackoff 30s; activation TTL 15 min; poison threshold 3.
6. **Backlog hygiene** = rewrite TASK-11 AC/plan to the real ~30% residual gap.

## 8. Risks

- **R1 — engine blast radius:** mitigated by keeping `next` derived; the engine is not modified by TASK-11.
- **DO-alarm ↔ Workflow seam untested in direct mode:** mitigated by the `terminateUnleasableJob` routing so the DLQ outcome is assertable in direct mode; the `sendEvent` leg stays the known-untested zone.
- **Backoff vs lease conflation:** mitigated by parking via `lock_expires_at` while leaving `leaseMs` semantics for in-flight attempts; explicit test that changing one does not move the other.
- **Migration-number / DO-tag collision:** topology migration is `0003` (0002 = saga); DO migration tag is `v2` (v1 = CorrelationBroker).
