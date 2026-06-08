# Phase 0 Research: SAGA Orchestrator (M1 — Canonical transaction-saga)

This phase records the seven locked design decisions from the SAGA orchestrator design
(`docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md` §2), the four deferred open
questions (§9), and the verified platform constraints (§4.3 / §10) that the M1 plan depends
on. The MVP-era decisions (Workflows-first execution, one Workflow per instance, the single
Durable Object correlation broker keyed by `workspaceId + messageName + correlationKey`, D1 as
canonical store, `bpmn-moddle`, `zod`, Vitest with `@cloudflare/vitest-pool-workers`) are
carried forward unchanged from `specs/001-bpmn-lite-orchestrator-mvp/research.md`.

## Decision: Model sagas in canonical BPMN, not a custom notation

**Decision**: A saga is a `<bpmn:transaction>` subProcess. Each forward step is a `serviceTask`
with an `easy-bpmn:taskDefinition type` (the pull topic). Each compensatable step carries a
`compensateEventDefinition` boundary event `<bpmn:association>`-wired to an
`isForCompensation="true"` handler. A business failure is caught by an `errorEventDefinition`
boundary event routing to a `cancelEventDefinition` end event; cancelling the transaction
triggers reverse-order compensation; a `cancelEventDefinition` boundary event on the
transaction takes the saga-failed path. The only additive binding is `easy-bpmn:taskDefinition`
inside standard `<extensionElements>`.

**Rationale**: This is the BPMN-standard way to express a saga (spec §10.5.5, "Transaction"):
when a transaction is **cancelled**, the engine **automatically** compensates the
successfully-completed activities **in reverse completion order**, then throws Cancel to the
transaction's cancel boundary event. Modeling it canonically keeps every file XSD-valid and
round-trippable through bpmn-js / Camunda Modeler when the `easy-bpmn` extensions and Diagram
Interchange are ignored — the operative "no custom notation" test from Principle I and
`09-easy-bpmn-profile.md`. Cancel events are valid only on transaction subprocesses, which is
exactly the saga boundary, so nothing is overloaded.

**Alternatives considered**:
- A custom `<saga>` / `<compensate>` notation or a non-standard attribute marking
  compensators: rejected as literal custom notation that violates Principle I and would not
  round-trip through a standard modeler.
- Triggering compensation with an explicit `compensateEventDefinition` *throw* event inside the
  transaction: rejected — transaction cancellation already triggers compensation automatically,
  so a redundant throw would **double-fire**. Compensation must be reached via `error boundary →
  cancel end`, never a throw.
- Reusing the `camunda:`/`zeebe:` external-task vocabulary verbatim: rejected (same reasoning as
  the MVP) — files would look like Camunda/Zeebe yet not honor their execution semantics.

## Decision: Pull / external-task worker model (Zeebe-style), long-poll transport for M1

**Decision**: Remote microservices **lease** jobs by `taskType` via `POST /jobs/activate`, run
their local transaction, then call `POST /jobs/{jobId}/complete` or `/fail` with their
`lockToken`. The orchestrator does not know service addresses. The M1 transport is a **bounded
long-poll** on `/jobs/activate` (up to `waitMs`). The Service Task therefore becomes a durable
**async wait** (one `step.waitForEvent` per logical job), like a Receive Task, rather than a
synchronous in-process call.

**Rationale**: Pull decouples the orchestrator from service discovery and lets any number of
independent microservices participate without the orchestrator holding their endpoints — the
right shape for "a SAGA orchestrator for many microservices." It reuses the existing
`easy-bpmn:taskDefinition type` as the topic and the existing persist-before-advance discipline.
Retries are driven by **re-lease** (lease expiry or `fail retryable=true` makes the job
re-leasable) so the Workflow step budget stays flat: one `waitForEvent` per task with a timeout
`>= retries × (leaseMs + maxBackoff)`, not one wait per attempt.

**Alternatives considered**:
- Keep the synchronous push call (`invokeSampleWorker` in a `for` loop): rejected — it requires
  the orchestrator to address each service and blocks a Workflow step on an external call; it
  does not scale to many independent microservices.
- A per-`taskType` Durable Object dispatcher: rejected for M1 — D1's single-writer serializes the
  atomic IN-subquery claim, so two activates cannot double-claim without a DO; the DO is
  unnecessary complexity until throughput demands it.
- Cloudflare Queues for job delivery: useful later for high-throughput async dispatch, but less
  direct than a long-poll lease for the synchronous activate/complete/fail contract and stable
  per-job idempotency in M1.

## Decision: Trigger compensation only by transaction Cancel, never by an uncaught Error (Hazard)

**Decision**: Compensation is triggered **only** when the `<transaction>` is cancelled — reached
via an explicit `error boundary event` on a failing step routing to a `cancel end event`, or via
an operator `POST /instances/{id}/cancel`. An Error that reaches the transaction boundary
**uncaught** is a **Hazard**: it terminates the transaction and propagates (terminal incident);
it does **not** auto-compensate.

**Rationale**: This is the BPMN transaction semantics (§10.5.5) and the basis of Principle VI.
Auto-compensating on any uncaught error would compensate after partial / ambiguous failures whose
effects are not safely known, which is exactly the unsafe behavior the Hazard concept exists to
prevent. Forcing every compensatable failure to be modeled as `error boundary → cancel end` makes
the rollback intent explicit and auditable.

**Alternatives considered**:
- Auto-compensate on any uncaught error or technical exhaustion: rejected — conflates a Hazard
  (unknown state) with a clean business rollback and would compensate steps whose forward effect
  may not have happened.
- Let a technical exhaustion inside the transaction silently terminate with no operator path:
  rejected — instead it becomes a terminal incident, and an operator may `POST /cancel` to force
  a deliberate compensation pass.

## Decision: Compensator exhaustion settles to `compensationFailed` with operator remediation

**Decision**: A compensation handler retries per its own `retries` policy; on exhaustion the
instance settles into the terminal **`compensationFailed`** state with an operator alert and an
incident (`kind=compensationFailure`). The reverse pass **stops** at the failed step (the
already-compensated suffix stays compensated). An operator `POST /instances/{id}/retry` resets the
failed compensation job and resumes the reverse pass from there — the single resumable status
transition (`compensationFailed → compensating`).

**Rationale**: A saga is only safe if a compensator failure has a deterministic, operator-visible
outcome rather than silently blocking forever (Principle VI). Stopping at the failed step (rather
than skipping it) preserves a truthful ledger of exactly how far rollback got, which is what an
operator needs to remediate.

**Alternatives considered**:
- Skip a failed compensator and continue the reverse pass: rejected — it would leave a step's
  forward effect un-undone while reporting the saga as fully compensated, corrupting the rollback
  guarantee.
- Block / retry forever with no terminal state: rejected — violates "never silently block
  forever" and gives operators no discovery or remediation path.

## Decision: Compensators receive original input + captured output and must be idempotent

**Decision**: A compensation job is seeded with **both** the forward step's original input and its
captured output (persisted in the `saga_steps` ledger at forward completion). Compensators MUST be
**idempotent** under at-least-once delivery; a new `compensate` idempotency scope returns the
stable prior outcome for a duplicate callback.

**Rationale**: Undoing a step often needs identifiers produced by the forward step (e.g. a charge
id to refund), so the captured output is required, while the original input grounds the
compensation in the same business context. At-least-once delivery (lease expiry, duplicate
callbacks) means a compensator can be invoked more than once; idempotency on `jobId` is the only
safe contract. The ledger row is written **atomically with advance** via `INSERT OR IGNORE`
against `uq_saga_steps_forward`, so a replayed completion is a no-op (no double-compensation) and
the advance-then-crash-before-ledger hole is closed.

**Alternatives considered**:
- Pass only the original input: rejected — a refund/cancel typically needs the forward output's
  identifiers.
- Re-derive the captured output at compensation time by re-querying the service: rejected — it
  reintroduces a network dependency and a non-deterministic compensation basis; the ledger's
  captured output is authoritative (and is the surviving completion's output even if a stale lease
  ran the step twice).

## Decision: Per-workspace worker credential; server derives workspaceId, never trusts the body

**Decision**: Every `/jobs/*` call carries a per-workspace worker credential (bearer token). The
server **derives `workspaceId` from the credential** and rejects any `taskType` claim outside that
workspace; the request body never carries a trusted `workspaceId` for job access. Credentials live
in a new `worker_credentials` table (`workspace_id`, `token_hash`, `created_at`, `revoked_at`).

**Rationale**: The pull endpoints hand out job payloads (business variables) to whoever polls; a
body-supplied `workspaceId` would be a trivial cross-tenant exfiltration vector (mitigates R6). A
credential-derived workspace makes isolation a server-side invariant rather than a trust in caller
input.

**Alternatives considered**:
- Trust a body `workspaceId` (as the MVP message-publish path does for correlation): rejected for
  `/jobs/*` — message publish is a narrower, correlation-keyed surface, whereas activate hands out
  arbitrary job payloads, so it must be authenticated and workspace-scoped server-side.
- A single global worker credential: rejected — it could lease any tenant's jobs, defeating
  isolation.
- mTLS / signed-request schemes: heavier than M1 needs; a hashed bearer token in D1 is sufficient
  and testable now, and the contract leaves room to harden later.

## Decision: Governance — new Spec Kit feature + constitution 2.0.0

**Decision**: Open Spec Kit feature `specs/002-saga-orchestrator` and bump the constitution to
**2.0.0** with a Sync Impact Report, a widened Principle I (the canonical-saga construct set,
preserving the no-custom-notation clause), a trimmed MVP Scope exclusion list (removing only the
M1-shipped constructs), and a new Principle VI (SAGA / Compensation Integrity). `specs/001` is
retained unchanged as MVP history.

**Rationale**: Per the versioning policy ("MAJOR = expand product scope in a way that invalidates
existing governance"), adding the transaction-saga set invalidates the old MVP Scope list (which
forbade transaction subprocess, compensation, and the saga boundary events), so the bump is
1.0.0 → 2.0.0. Each plan still passes the Constitution Check before Phase 0 and after Phase 1, and
every runtime/persistence/API change ships contract/integration tests for the
constitution-critical behaviors (compensation ordering, saga state transitions, remote worker
contract, manual remediation, worker auth/isolation).

**Alternatives considered**:
- A MINOR bump: rejected — adding the principle is additive, but trimming the MVP Scope exclusion
  list materially invalidates prior governance, which the policy classifies as MAJOR.
- Amend `specs/001` in place: rejected — `001` is retained as MVP history; the scope expansion is a
  new feature directory.

## Open questions (deferred, tracked — not dropped)

- **M2 — expression language**: standard **FEEL** (portable, canonical, heavy to embed) vs a
  restricted JSONLogic / JS-subset evaluator (light, non-standard) for `conditionExpression`.
  Regardless of language, the *evaluated* decision is persisted in `gateway_decisions` for
  deterministic replay/audit. Deferred to M2.
- **M3 — timeout behavior**: when a per-step or boundary timer fires, default to an alternate BPMN
  path if modeled, else compensation; and whether the broker's fixed one-hour buffering TTL becomes
  per-model configurable. Deferred to M3. (M1 ships only the single job-level activation TTL for
  un-leasable jobs.)
- **M4 — concurrency strategy on CF Workflows**: how to express a concurrent token set within one
  Workflow (parallel `step.do` vs child workflows) while keeping replay-safety and the ≤1 MiB
  per-event / ≤1 GB cumulative-state limits. Deferred to M4.
- **M1 — worker SDK shape**: M1 ships the long-poll HTTP activate/complete/fail contract plus a
  sample worker loop; whether a thin client SDK is in M1 or a fast-follow is open.

## Verified platform constraints

- **D1 does not parse `UPDATE … LIMIT … RETURNING`** (live-verified, error code 7500). Job leasing
  MUST use the atomic IN-subquery form with the lease guard in **both** the inner subquery and the
  outer `WHERE` (D1's single-writer serializes activates so two cannot double-claim):
  ```sql
  UPDATE service_task_jobs
     SET worker_id=?, lock_token=?, lock_expires_at=:leaseUntil, status='locked'
   WHERE job_id IN (
     SELECT job_id FROM service_task_jobs
      WHERE task_type=:t
        AND (status='created' OR (status='locked' AND lock_expires_at < :now))
      ORDER BY created_at LIMIT :n)
     AND (status='created' OR (status='locked' AND lock_expires_at < :now))
  RETURNING job_id, instance_id, element_id, is_compensation, attempt_count, input_variables;
  ```
  `complete`/`fail` are `lock_token`-conditional updates (`… WHERE job_id=? AND lock_token=?`):
  a stale worker matches 0 rows and is rejected; a duplicate (same token) matches 0 rows and
  returns the stable prior outcome.
- **Cloudflare Workflows ≤1 MiB per event** and **≤1 GB cumulative persisted state per instance**
  (every `waitForEvent` payload + `step.do` result persists for the instance's life). Keep
  `step.do` results small scalars; reject oversized `complete` outputs **before** `sendEvent`
  (`assertPayloadWithinLimit`, `payload.ts`); push large worker outputs to R2 references and
  deliver only the reference in the event.
- **Workflow `limits.steps` headroom**: set `wrangler.jsonc` workflow `limits.steps` to ~25000 to
  cover a long forward saga plus the reverse compensation pass.
- **Workers Free (1,024 Workflow steps) is inadequate** for a long saga + reverse pass; Durable
  Objects already force the **Paid** plan, so this is not an added constraint.

## Source References

- BPMN 2.0 specification §10.5.5 "Transaction" (cancel → reverse-order auto-compensation; Hazard)
- Cloudflare Workflows API: https://developers.cloudflare.com/workflows/build/workers-api/
- Cloudflare Workflows limits: https://developers.cloudflare.com/workflows/reference/limits/
- Cloudflare D1 overview: https://developers.cloudflare.com/d1/
- `docs/superpowers/specs/2026-06-08-saga-orchestrator-design.md` (§2 decisions, §4 architecture,
  §9 open questions, §10 risks)
- `docs/bpmn/09-easy-bpmn-profile.md` (the operative round-trip test for canonicity)
