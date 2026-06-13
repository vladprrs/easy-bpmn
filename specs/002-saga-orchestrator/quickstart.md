# Quickstart: SAGA Orchestrator Validation (M1 + M2 + M3 + M4)

This guide describes the end-to-end validation scenarios for the transaction-saga implementation:
scenarios 1–9 are the named M1 constitution-critical gates; scenarios 10–14 are the M2
conditional-saga gates (exclusiveGateway + FEEL + cycles); scenarios 15–26 are the M3
time-&-failure-taxonomy gates (boundary/intermediate timers, `eventBasedGateway`, free error
routing, the incident-kind split + `retryable`); scenarios 27–30 are the M4 concurrency gates
(block-structured parallel AND / inclusive OR, the token frontier, branch-local variable merge, and
parallel-branch compensation) — each mapping to a green integration test named next to it — followed by
the **M4 manual Workflow-mode matrix** placeholder (the Workflow-mode-only concurrency behaviours, filled
in by task L6.6). The M3 design source is
`docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md` (§7 gates); the M4 source is
`docs/superpowers/specs/2026-06-13-m4-concurrency-design.md` (§14 testing & exit criteria).

## Prerequisites

- Node.js 22+ (Wrangler 4.x requires Node ≥22)
- Wrangler installed through project dependencies
- Cloudflare local development support for Workers, Workflows, Durable Objects, and D1
- A Workers **Paid** plan target (Durable Objects force Paid). Workflows step budget: **10,000
  steps per instance by default**, raisable to **25,000** via `limits.steps` — see the verified
  budget analysis in `wrangler.jsonc` (the M2 loop guard `MAX_ELEMENT_OCCURRENCES = 1000` trips
  well inside the default for single-element loops).

## Setup

```bash
npm install
npx wrangler d1 migrations apply easy_bpmn --local   # applies 0001 … 0007 (MVP, saga, topology, conditional, backfill, timers, tokens)
npm run test
npm run dev
```

Expected setup outcome:

- Unit, contract, and integration tests pass (including the M1 + M2 gates).
- Local Worker API is available at `http://localhost:8787`.
- Local D1 database has the MVP schema plus the saga ledger, jobs lease/DLQ columns, worker
  credentials, incident `kind`/`resolution`, the `(workspace_id, status)` list index, the M2
  `occurrence`/`output_applied` columns, conditional topology columns, `gateway_decisions`, the
  M3 `timers` + `timer_outcomes` tables (migration `0006_timers.sql`), and the M4 `execution_tokens`
  read-model + `join_arrivals`/`join_completions` join facts + `gateway_decisions.activated_flow_ids` +
  `saga_steps.token_id` (migration `0007_tokens.sql`).
- Workflow and Durable Object bindings are available in local development.

## Scenario 1: Happy Saga Commits (gate: happy-saga-commit)

1. Publish the §3 canonical order-saga (a `bpmn:transaction` with three forward Service Tasks each
   routed by `easy-bpmn:taskDefinition type` to a distinct microservice; on disk as
   `examples/order-saga.bpmn`).

```bash
curl -sS http://localhost:8787/definitions/drafts \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile xml examples/order-saga.bpmn \
        '{workspaceId: "default", name: "order saga", bpmnXml: $xml}')"
curl -sS -X POST http://localhost:8787/definitions/drafts/{draftId}/publish
```

Expected: draft `valid` with empty `validationIssues`; publish returns `201` with an immutable
`definitionVersionId` whose elements include the transaction, boundary events, association,
compensation handlers, and root error.

2. Start an instance.

```bash
curl -sS http://localhost:8787/definitions/versions/{definitionVersionId}/instances \
  -H 'Content-Type: application/json' \
  -d '{ "workspaceId": "default", "correlationKey": "order-001", "variables": { "amount": 42 } }'
```

Expected: `201`; the instance enters `Tx_order` (`transactionEntered` recorded) and the
`reserve-stock` forward job becomes leasable.

3. Each microservice leases and completes its forward job (separate worker identities).

```bash
curl -sS http://localhost:8787/jobs/activate \
  -H 'Authorization: Bearer <workspace-default-worker-token>' \
  -H 'Content-Type: application/json' \
  -d '{ "taskType": "reserve-stock", "workerId": "stock-svc", "leaseMs": 30000, "waitMs": 20000 }'
# -> { "jobs": [ { "jobId": "...", "lockToken": "...", "attempt": 1, "traceId": "...", "variables": {...} } ] }
curl -sS http://localhost:8787/jobs/{jobId}/complete \
  -H 'Authorization: Bearer <workspace-default-worker-token>' \
  -H 'Content-Type: application/json' \
  -d '{ "lockToken": "{lockToken}", "outputVariables": { "reservationId": "r-9" } }'
```

Repeat activate/complete for `charge-card` then `confirm-shipping`.

Expected outcome:

- Each `complete` persists output and writes a `saga_steps` ledger row atomically with the advance.
- After the last forward step the transaction reaches its none end event and the instance status
  becomes `completed`.
- `GET /instances/{id}` shows the `saga` block phase `forward` with every step committed.

## Scenario 2: Business Error Mid-Saga → Reverse-Order Compensation (gate: business-error-compensation)

Complete `reserve-stock` and `charge-card`, then fail `confirm-shipping` with a business error.

```bash
curl -sS http://localhost:8787/jobs/{confirmShippingJobId}/fail \
  -H 'Authorization: Bearer <workspace-default-worker-token>' \
  -H 'Content-Type: application/json' \
  -d '{ "lockToken": "{lockToken}", "reason": "carrier rejected", "errorCode": "SHIPPING_REJECTED" }'
```

> Note: the `errorCode` alone makes this a business failure. A `retryable` field is accepted but
> **advisory/ignored server-side** — terminality is decided only by `errorCode` (business) or
> retry-budget exhaustion (technical); see the runtime contracts.

Expected outcome:

- The modeled error boundary routes the token to the cancel end event; the instance status becomes
  `compensating` (`transactionCancelled` recorded).
- Compensation jobs are dispatched in **reverse completion order**: `refund-card` (undo charge)
  **before** `release-stock` (undo reserve).
- Each compensation activate returns `isCompensation: true`, the forward step's `originalInput`, and
  its `capturedOutput`.
- After both compensators complete, the instance status becomes `compensated`, the cancel boundary
  takes the `SagaFailed` path, and the instance settles to the saga-failed terminal state — status
  stays `compensated`, never clobbered to `completed`.

## Scenario 3: Compensator Fails → compensationFailed → Operator Retry Resumes (gate: compensator-fail-remediation)

Force `refund-card`'s compensation to fail until its retries are exhausted.

Expected outcome:

- The instance status becomes `compensationFailed`; a `compensationFailed` history event and an
  incident (`kind=compensationFailure`) are recorded; the reverse pass **stops** at `refund-card`,
  leaving `release-stock` still pending.
- An operator discovers and resumes it:

```bash
curl -sS 'http://localhost:8787/instances?workspaceId=default&status=compensationFailed'
curl -sS -X POST http://localhost:8787/instances/{instanceId}/retry
```

- `retry` resets the failed compensation job and returns the instance to `compensating` (the one
  resumable transition).
- When the previously-failed compensator now succeeds, the reverse pass continues and the instance
  reaches `compensated`.

## Scenario 4: Duplicate Complete AND Duplicate Fail Each Advance At Most Once (gate: duplicate-callback-idempotency)

Send `complete` twice for one forward job with the same `lockToken`; separately send `fail` twice
for another job.

Expected outcome:

- The second `complete` returns the stable prior outcome; the instance does not advance a second
  time (Workflow step memoization).
- The second `fail` returns the prior outcome and does **not** re-count the attempt (forward
  `workerCallback` keyed by `jobId + lockToken`).
- A worker holding a stale `lockToken` (its lease expired and the job was re-leased) matches zero
  rows on `complete` and is rejected without advancing.

## Scenario 5: Late Callback to a Terminal Instance → 200 No-op Ack (gate: terminal-instance-noop-ack)

Drive an instance to a terminal state, then deliver a late `complete`/`fail` for one of its jobs.

Expected outcome:

- The API gates on D1, finds the instance terminal, and returns a **200 no-op acknowledgement**.
- `sendEvent` is never attempted against the not-running instance; no `500` is raised and the
  at-least-once worker is not wedged in a permastuck retry loop.

## Scenario 6: Cross-Tenant Activate Rejected (gate: cross-tenant-activate-reject)

Using a worker credential scoped to workspace A, activate a `taskType` whose only jobs belong to
workspace B.

```bash
curl -sS http://localhost:8787/jobs/activate \
  -H 'Authorization: Bearer <workspace-A-worker-token>' \
  -H 'Content-Type: application/json' \
  -d '{ "taskType": "reserve-stock", "workerId": "a-svc", "workspaceId": "B" }'
```

Expected outcome:

- Zero jobs returned; no workspace B payload is exposed.
- The forged body `workspaceId: "B"` is ignored; access is evaluated against the credential-derived
  workspace (A) only.
- A missing or revoked credential is rejected as unauthorized.

## Scenario 7: v1 Instance Mid-Saga Compensates via v1's Graph After v2 Publishes (gate: version-binding-during-compensation)

Start an instance on v1, complete one forward step, publish v2 with different compensation
associations, then trigger cancellation on the v1 instance.

```bash
curl -sS -X POST http://localhost:8787/instances/{v1InstanceId}/cancel
```

Expected outcome:

- The running instance remains bound to v1; v2 does not affect it.
- The reverse pass uses **v1's** compensation handlers and `taskType`s.
- History and the saga view reference only the v1 definition version.

## Scenario 8: Un-leasable Job → DLQ Timeout (gate: unleasable-job-dlq-timeout)

Start an instance whose first Service Task `taskType` no worker ever polls. The job is created with
`activation_expires_at = created_at + 15 min` and a per-job `JobScheduler` Durable Object alarm is
armed. At expiry the alarm re-reads D1 and, the job still un-leased, terminates it.

Expected outcome:

- The instance settles to a **terminal incident** with `kind=jobActivationTimeout`; a `jobActivationExpired`
  history event is written and the reason is specific (`un-leasable`), **not** the
  `process-workflow` catch-all `Workflow terminated:`.
- A job that was **leased before** `activation_expires_at` is **not** timed out (the alarm no-ops).
- The DLQ never compensates.

## Scenario 9: Poison Job → Terminal `kind=poison` (no compensation) (gate: poison-job-termination)

A worker repeatedly **completes** with output that cannot be applied — here a ~0.6 MiB output that,
merged with ~0.6 MiB of instance variables, breaches the ~1 MiB event-payload limit.

Expected outcome:

- The job is re-opened up to `POISON_THRESHOLD = 3` strikes, then terminates with a **distinct**
  `kind=poison` + a `poisonJob` history event.
- The instance does **NOT** enter `compensating` and **no** compensation jobs are created (poison is
  distinct from a business-error → cancel, the only compensating path).

---

The M2 scenarios below use the shipped sample model
`examples/conditional-fulfillment-saga.bpmn` (XOR split/join + a loop + compensation wiring) or its
test-fixture siblings (`tests/helpers.ts`: `SAGA_XOR_BPMN`, `SAGA_XOR_NODEFAULT_BPMN`,
`SAGA_LOOP_BPMN`, `LOOP_XOR_BPMN`). The sample itself is publish-validated from disk by
`tests/integration/sample-conditional-saga.test.ts`.

## Scenario 10: Branch by Data (gate: branch-by-data — `tests/integration/xor-gateway.test.ts`)

Publish the sample and start an instance; complete `reserve-item` with
`{ "moreItems": false, "paymentMethod": "card" }`.

```bash
curl -sS http://localhost:8787/definitions/drafts \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile xml examples/conditional-fulfillment-saga.bpmn \
        '{workspaceId: "default", name: "conditional saga", bpmnXml: $xml}')"
```

Expected outcome (tests: `"routes by data: evaluations recorded in document order…"`,
`"takes the default flow when no condition is true…"`,
`"multiple true conditions → the FIRST in document order wins…"`):

- The token leaves `GW_method` on `Flow_pay_card` (FEEL `paymentMethod = "card"`); a `paymentMethod`
  of anything else takes the gateway-owned `default` flow instead.
- A `gateway_decisions` row records the chosen flow + per-flow evaluations in **document order**
  (short-circuited at the first `true`); the `gatewayDecisionEvaluated` history event is the
  operator surface.
- The XOR join (`GW_paid`) is a pass-through decision; exactly one job exists, on the chosen branch.

## Scenario 11: Loop N Iterations, Then Compensate Each (gate: loop-compensation — `tests/integration/loop-compensation.test.ts`)

Complete `reserve-item` three times (worker output `moreItems: true` twice, then `false`), then fail
the post-loop step with its model business error (e.g. `FINALIZE_FAILED` on `SAGA_LOOP_BPMN`).

Expected outcome (test: `"3 iterations + business-failed finalize → 3 comp jobs in reverse seq
order…"`):

- Each iteration is its own occurrence-keyed job + `saga_steps` ledger row (occurrences 0..2).
- The error boundary → cancel end cancels the transaction; the reverse pass creates **one
  compensation job per iteration, highest occurrence first**, each seeded with **its own
  iteration's** `originalInput` + `capturedOutput`.
- `compensationStarted` AND `compensationCompleted` history events carry the iteration's
  `occurrence`; the instance settles `compensated` via the cancel-boundary path.

## Scenario 12: No Path → `noPath` Incident, Hazard `/cancel` (gate: nopath-hazard — `tests/integration/xor-gateway.test.ts`)

Publish `SAGA_XOR_NODEFAULT_BPMN` (both gateway flows carry conditions, no default) and start an
instance whose variables match **neither** condition.

Expected outcome (tests: `"no condition true + no default → noPath incident…"`, `"operator /retry
with a variable patch re-evaluates the failed visit FRESH…"`):

- The gateway visit raises a **terminal incident `kind=noPath`** (the recorded evaluations in the
  diagnostics); inside the transaction this is a **Hazard** — NO auto-compensation.
- `POST /instances/{id}/cancel` then compensates the pending ledger (the operator remediation).
- Alternatively `POST /instances/{id}/retry` re-evaluates the failed visit **fresh** (no decision
  row was written for the failed visit), so a variable patch can route the saga forward.

## Scenario 13: Loop Limit → `loopLimit` Incident (gate: loop-limit — `tests/integration/loop-limit.test.ts`)

Drive a model into a hot cycle (the `f_spin` self-loop in `SAGA_LOOP_BPMN` / `LOOP_XOR_BPMN`'s
gateway cycle) past `MAX_ELEMENT_OCCURRENCES = 1000`.

Expected outcome (tests: `"loop guard — MAX_ELEMENT_OCCURRENCES trips a terminal loopLimit
incident"`, `"loop guard inside a transaction — Hazard semantics"`, `"technical retries do not
consume the cap"`):

- The walk terminates with incident `kind=loopLimit` naming the tripping element; inside a
  transaction this is Hazard semantics (no auto-compensation; operator `/cancel` available, and the
  incident resolution advances `compensating → compensated` when the pass settles).
- Technical retries of one iteration do **not** consume the visit cap (occurrence ≠ attempt).

## Scenario 14: Decision-Replay Stability (gate: decision-replay — `tests/integration/xor-gateway.test.ts`, `tests/integration/xor-replay-workflow.test.ts`, `tests/integration/loop-replay-workflow.test.ts`, `tests/integration/loop-rewalk.test.ts`)

Crash/resume an instance after a gateway decision committed, then mutate its variables and resume.

Expected outcome (tests: `"mutating variables between resumes never re-routes a recorded decision"`
(direct rewalk), `"crash after the decision committed (memo lost) + variables mutated → the replay
keeps the recorded branch"` (Workflow memoization), `"rewalk fast-forward is write-free…"`):

- A recorded `(instance, gateway, occurrence)` decision is **reused, never re-evaluated**, in BOTH
  execution modes — the walk is the replay.
- Rewalk fast-forward over applied steps is **write-free** (no duplicate jobs, history events, or
  variable merges); resuming mid-loop lands on the exact frontier occurrence.

---

The M3 scenarios below add model-level timers, the `eventBasedGateway`, free error routing, and the
failure-taxonomy split on top of the rewalk/occurrence engine. Two shipped sample models —
`examples/timer-saga.bpmn` (boundary timer inside a transaction → cancel end → compensation) and
`examples/event-gateway-saga.bpmn` (message-vs-timer race) — are publish-validated AND semantically
round-tripped from disk by `tests/integration/sample-m3-models.test.ts` (the R4 canonicity gate).
The runtime firing path is exercised in **direct mode** (the only mode CI runs) by triggering the
Scheduler Durable Object alarm deterministically via `runDurableObjectAlarm` — no real sleeps
anywhere. Every design §7 gate maps to a green test named in its heading.

## Scenario 15: Boundary Timer on a Service Task → Alternate Path (gate: boundary-timer-alt-path — `tests/integration/boundary-timer.test.ts`)

A service task carries an interrupting boundary timer (`timerEventDefinition`/`timeDuration`). When
the deadline elapses the timer fires and the token takes the boundary's outgoing flow; a late worker
callback to the abandoned job gets the stable no-op ack.

Expected outcome (design §7 gate 1): the `timers` row flips `armed → fired` with a `timer_outcomes`
`fired` decider row; a `timerFired` history event (NOT an incident) is written; the token advances
down the modeled alternate path; the in-flight job is abandoned and a late `complete`/`fail` returns
the superseded no-op ack.

## Scenario 16: Boundary Timer Inside a Transaction → Reverse Compensation (gate: timer-saga-compensation — `tests/integration/boundary-timer.test.ts`, `tests/integration/sample-m3-models.test.ts`)

The canonical "saga timeout → compensate" shape, the M3 analogue of Scenario 2:
`examples/timer-saga.bpmn` reserves stock + charges the card, then a long-running `awaitShipment`
step times out.

Expected outcome (design exit criterion 2, §7 gate 2): the boundary timer fires → routes to the
transaction's cancel end event → the instance enters `compensating`; completed steps compensate in
**reverse order** (`refund-card` before `release-stock`); the instance settles `compensated` via the
cancel boundary's `SagaFailed` path. There is **no** `easy-bpmn` timeout attribute — the trip is a
drawn boundary timer with a drawn path (design decision #2).

## Scenario 17: Timer-vs-Completion Race, Both Orders (gate: timer-completion-race — `tests/integration/boundary-timer.test.ts`)

Drive a timer-guarded service task two ways: worker `complete` first, then the alarm; and the alarm
first, then a late `complete`.

Expected outcome (design §7 gate 3): exactly one of the two batches commits its decider
(`timer_outcomes`) — complete-first settles the timer `cancelled` and a stray alarm no-ops;
fire-first claims `fired` and the late `complete` aborts on the unique constraint and converts to the
superseded no-op ack. No double advance in either order.

## Scenario 18: Intermediate Timer Catch — Process Level and Inside a Transaction (gate: intermediate-timer-catch — `tests/integration/intermediate-timer.test.ts`)

An `intermediateCatchEvent` + `timerEventDefinition` is a delay step on the token path.

Expected outcome (design §7 gate 4): the token parks (timer armed), and on fire advances along the
single outgoing flow with a `timerFired` history event. Inside a `transaction` the saga scope stays
open across the delay (completed steps remain compensatable).

## Scenario 19: eventBasedGateway Race — Message / Timer / Buffered (gate: ebg-race — `tests/integration/event-gateway.test.ts`, `tests/integration/sample-m3-models.test.ts`)

`examples/event-gateway-saga.bpmn` parks on an `eventBasedGateway` racing a message branch
(`ApprovalGranted`) against a timer branch (`PT24H`).

Expected outcome (design §4.5, §7 gate 5): the winner is whichever occurs first, decided on a single
`gateway_decisions` row (plain INSERT, same batch as the transition); the loser's batch aborts and
converts. Message wins → token down the fulfil branch, timer settled `cancelled` (bookkeeping, no
`timer_outcomes` row); timer wins → token down the escalate branch, message subscription superseded;
an early-buffered message is claimed at registration; with two buffered message branches the
**model-document-order first hit** wins. The decision is replay-stable.

## Scenario 20: Boundary Timer on a Receive Task → Subscription Superseded (gate: receive-task-timer — `tests/integration/boundary-timer.test.ts`)

A `receiveTask` guarded by a boundary timer.

Expected outcome (design §7 gate 6): on fire the active broker subscription is superseded (preserving
the at-most-one-active-subscription invariant); a late publish to that broker key gets the stable
buffered/no-match outcome, not a second advance.

## Scenario 21: Multi-Error-Boundary Routing (gate: free-error-routing — `tests/integration/error-routing.test.ts`)

One activity carries several interrupting error boundaries with **distinct, non-empty** `@errorCode`s
plus at most one catch-all.

Expected outcome (design §7 gate 7): a worker `fail` with a given `errorCode` reaches the boundary
whose Error's `@errorCode` matches **exactly**; the catch-all catches any business code including one
not declared as a `bpmn:error` in the model; an unmatched code with no catch-all stays a **Hazard**
(Constitution VI untouched). The boundary's outgoing flow may target any token-path node in the
scope (the M1 "must target a cancel end" restriction is lifted).

## Scenario 22: Error → Alternate Path → Saga Continues → Later Cancel (gate: error-path-then-compensate — `tests/integration/error-routing.test.ts`)

A business error is handled by an alternate path **inside** a transaction; the saga continues and is
cancelled later.

Expected outcome (design §7 gate 8): the alternate path leaves the saga ledger untouched —
**all** completed forward steps (both pre- and post-error) compensate in reverse when the saga
cancels (standard compensation semantics; handlers stay registered until the scope settles).

## Scenario 23: Standalone Message Intermediate Catch (gate: message-intermediate-catch — `tests/integration/message-intermediate-catch.test.ts`)

A standalone `intermediateCatchEvent` + `messageEventDefinition` (no gateway).

Expected outcome (design §7 gate 9): it correlates and advances exactly like a `receiveTask` (same
subscription machinery), in both publish-before and publish-after orders.

## Scenario 24: Abnormal-Exit Timer Settlement (gate: timer-abnormal-exit — `tests/integration/boundary-timer.test.ts`)

Exit a timer-guarded visit via an error-boundary route, a retry exhaustion, and an operator
`/cancel`.

Expected outcome (design §7 gate 10): each exit settles the armed timer `cancelled` via the decider;
a stray alarm afterwards is a no-op — no mid-compensation or post-incident firing.

## Scenario 25: retryable=false and Lease-Expiry Exhaustion (gate: retryable-reclaim — `tests/integration/jobs-retryable-reclaim.test.ts`)

A worker fails a job with `retryable=false`; separately, a job is left to exhaust its retry budget
purely through lease expiry (reclaim re-leases).

Expected outcome (design §7 gate 11): `retryable=false` short-circuits remaining attempts → immediate
exhaustion incident (Hazard inside a transaction); lease-expiry exhaustion now terminates via the
**same** exhaustion path (the previously-missing reclaim termination check). A worker omitting
`retryable` is unchanged.

## Scenario 26: Incident Kinds + Hygiene (gate: incident-taxonomy — `tests/integration/incident-hygiene.test.ts`, `tests/integration/wait-cap-incidents.test.ts`, `tests/integration/service-task-incident.test.ts`)

Exercise the `timeout` split and the hygiene fixes.

Expected outcome (design §7 gate 12, §5): an un-leasable job → `jobActivationTimeout`; an un-guarded
service-task / receive-task wait cap → `waitTimeout`; a hard FEEL error → `conditionFailure`;
`setIncidentResolution` resolves a single incident by id (no longer all of the instance's open
incidents); inspection lists **all** open incidents; an empty-ledger `/cancel` closes them all as
`operatorResolved`. A fired model timer never creates an incident.

---

The M4 scenarios below exercise block-structured parallel (`parallelGateway`) and inclusive
(`inclusiveGateway`) gateways, the token frontier, branch-local variable scopes, and
parallel-branch compensation. The design source is
`docs/superpowers/specs/2026-06-13-m4-concurrency-design.md` (§14 testing & exit criteria).

## Scenario 27: AND Split / Join (gate: parallel-and-split-join — `tests/integration/parallel-gateway.test.ts`)

A `parallelGateway` split fans out into two or more concurrent service-task branches; the
matching AND join waits for a token from every activated branch before producing the post-join
token; the instance completes once the token frontier is empty.

Expected outcome: both branch jobs become leasable simultaneously (real worker-side parallelism);
each completed branch records a `join_arrivals` row via `INSERT OR IGNORE`; the last arrival
fires the `join_completions` plain-INSERT claim in the same `dbBatch` as the merged-overlay
write and the produced-token row; the instance reaches `completed` via the atomic last-token-out
conditional UPDATE when the frontier empties.

## Scenario 28: OR Split / Join (gate: inclusive-or-split-join — `tests/integration/inclusive-gateway.test.ts`)

An `inclusiveGateway` split evaluates FEEL conditions on its outgoing flows in document order;
only the true-condition flows are activated (the activated set is recorded in
`gateway_decisions.activated_flow_ids`). The matching OR join waits for exactly the recorded
activated subset (keyed by origin branch, not incoming flow). A `default` flow is taken when no
condition is true; zero activation with no default raises a `noPath` incident.

Expected outcome: an instance with exactly one true-condition branch activates one job and one
branch token; the OR join fires when that branch's token arrives; with no `default` and no true
condition the engine settles a terminal `noPath` incident (Hazard inside a transaction; no
auto-compensation); with a `default` flow it is taken as the activated singleton; the recorded
`activated_flow_ids` set is reused verbatim on rewalk and never re-evaluated.

## Scenario 29: Branch-Local Variable Merge at the Join (gate: branch-local-variable-merge — `tests/integration/parallel-gateway.test.ts`)

Each branch token carries its own `variables_overlay` delta; service-task output writes inside
a branch go to that token's own overlay and are invisible to sibling branches before the join
merge. At the join the deltas are merged into the post-join token in **split out-flow document
order** (later-in-order wins on key conflict); the merge is shallow (top-level key union).

Expected outcome: branch A writes key `aResult` and branch B writes key `bResult`; both are
present in the post-join scope; when both branches write the same key `shared`, the value from
the branch whose out-flow appears later in the split's `outgoing[]` (document order) wins; a
branch-A write is not visible when branch B reads the same key before the join — branch B reads
the pre-split scope value.

## Scenario 30: Parallel Transaction Compensation (gate: parallel-branch-compensation — `tests/integration/parallel-compensation.test.ts`)

A business error in one branch (or an operator `/cancel`) begins scope cancel while a sibling
branch is still in-flight (a straggler). The compensation reverse pass (a) records the live-token
cohort, (b) arms per-token terminators so the quiescence barrier never depends on a future poll,
(c) ledgers straggler completes that arrive after cancel begins, (d) compensates each causal
chain in lineage-ordered reverse, and (e) settles `compensated` exactly once — only after the
ledger is drained **and** all cohort tokens are terminal.

Expected outcome: a straggler's late `complete` writes a `saga_steps` ledger row (`INSERT OR
IGNORE`) but does not advance the instance; the compensating drive ledgers the straggler before
running the reverse pass; within each branch lineage the compensation steps run in strict
descending-seq order; cross-branch order is unconstrained (no happens-before relation across
independent branches); the quiescence barrier prevents the `compensated` terminal transition
while any cohort token is still live; the instance settles `compensated` exactly once.

## M4 manual Workflow-mode matrix

> **L6.6 executed 2026-06-13 against REAL Cloudflare Workflows** (`bpmn.rntme.com`, Worker
> Version `1993c802-bf27-4b16-bd29-82d0159b4982` = the M4 branch; remote D1 migration
> `0007_tokens.sql` applied; R2 `easy-bpmn-overlays` enabled). **Result: a BLOCKING defect was
> found — the M4 workflow-mode multi-wait does NOT work on real Cloudflare Workflows.** This gate
> is therefore **FAILED** and the M4 epic is **NOT closed**. See "Root cause" + "Fix direction"
> below; the fix is tracked separately (re-opens the L3 engine).

The direct-mode integration tests (Scenarios 27–30) cover all concurrent-join *logic* via the D1
replay predicates + the deterministic DFS traversal and pass (413/413 in CI). The behaviours
below only manifest when a real Cloudflare Workflow drives the instance (`Promise.race` fan-in,
step memoization across suspend/resume), which is exactly what direct-mode CI cannot reach — the
reason this matrix is a blocking gate.

### Substrate probes (real CF + local `wrangler dev`)

| Probe | Real CF | Local miniflare | Notes |
|-------|---------|-----------------|-------|
| Sequential `Start→A→B→End` (two job-result events in sequence) | **PASS** | **PASS** | workflow-mode multi-event resume works for a linear chain — isolates the defect to the multi-wait |
| AND-join `PARALLEL_BPMN` (fan-out + two concurrent `step.waitForEvent`) | **FAIL** | **FAIL** | fan-out OK; join correctly holds before the 2nd branch; but completing the 2nd branch never resumes the Workflow → join never fires → instance stuck `running` (no self-heal over minutes; the 1-hour `SVC_WAIT_TIMEOUT` is the only backstop) |

**Evidence (real CF):** instance `pi_abd7ca7f-…` history ends
`… serviceTaskCompleted(B) → branchArrivedAtJoin(B) → jobCompleted(A)` with **no**
`serviceTaskCompleted(A)`; token `…:fork#0:f1` left `active` at `A`, `…:fork#0:f2`
`arrivedAtJoin`. The pattern is **identical** under local `wrangler dev`, ruling out a
miniflare-only artifact.

### The six matrix scenarios

All six depend on a working multi-branch fan-in, so all are **BLOCKED** by the substrate defect
above — none can pass until the multi-wait is fixed and the substrate AND-join goes green:

| # | Scenario | Status |
|---|----------|--------|
| WM-1 | Two parallel message catches, deliver A then B → each applies exactly once, join proceeds, no duplicate-step-name error | **BLOCKED** — multi-wait join hangs |
| WM-2 | Crash/restart mid-race after delivering A → re-walk fast-forwards A write-free, re-races B, no re-apply | **BLOCKED** — multi-wait join hangs |
| WM-3 | Deliver A and B near-simultaneously then force replay → identical final state regardless of race winner | **BLOCKED** — multi-wait join hangs |
| WM-4 | One branch times out while a sibling is live → no `unhandledRejection`, the sibling completes | **BLOCKED** — multi-wait join hangs |
| WM-5 | In-region loops approaching the budget → graceful `stepBudget`/`concurrencyLimit` incident, not an opaque errored Workflow | **BLOCKED** — multi-wait join hangs |
| WM-6 | Cancel a region with parked + in-flight straggler branches → quiescence barrier + per-causal-chain reverse-seq ordering across suspend/resume | **BLOCKED** — multi-wait join hangs |

### Root cause (high confidence)

Cloudflare Workflows re-invokes `run()` from the top on every event (deterministic replay,
memoizing `step.do`/`step.waitForEvent` by name). The token-frontier rewalk
(`runInstance` → `driveFrontier` → `raceParkedWaits`) issues **a different set of
`step.waitForEvent` calls on each re-invocation**: when one branch's job completes, that branch
shifts from a `step.waitForEvent` to a `step.do` apply, so the per-replay step sequence diverges
(invocation #1 issues `waitForEvent(A)` + `waitForEvent(B)`; invocation #2 issues
`step.do(svc-apply:B)` + `waitForEvent(A)`). A `Promise.race` over multiple concurrent
`step.waitForEvent` does not compose with Cloudflare's one-suspension-point-at-a-time replay
model, so the surviving branch's later `sendEvent` never resumes the Workflow. This is the
**R-cf-multiwait** risk flagged in the design (§5.2, decision 3, the risk register) — now
confirmed real, not merely "partially testable".

### Fix direction (separate effort — re-opens the L3 engine)

The workflow-mode multi-wait needs a **replay-stable** wake mechanism — e.g. a **single
per-instance `step.waitForEvent`** on one stable event type (every job-result / message / timer
`sendEvent`s that type), with the engine re-walking and reconciling against canonical D1 on each
wake (the "advisory winner, D1 is the truth" philosophy already in §5.2). That keeps the
`step.*` sequence identical across replays regardless of which branches have completed. The
direct-mode join logic (Scenarios 27–30, 413 CI tests) is unaffected and is the regression net.
Needs: brainstorm → implementation → **real-CF re-validation via this matrix** before M4 closes.

### Current production state (2026-06-13)

`bpmn.rntme.com` serves the **M4 branch** (Version `1993c802…`), deployed for this validation.
Single-token M0–M3 flows are **unaffected** (M4 is gated on `graph.regions`) — existing
functionality works; **any parallel/inclusive instance hangs at its join**. The prior M3
version is one `wrangler rollback` away. Per operator decision (2026-06-13) the M4 version was
**left deployed** (pre-revenue, no users) pending the multi-wait fix; the validation instances
above remain in prod D1 as identifiable `workspaceId="default"` test data.

## Workflow-mode-only paths (manual validation)

Direct mode (the CI mode) covers the alarm → `fireTimer` → claim/abort → D1 path — the **primary**
race mechanism in both execution modes. The following are exercised only when a real Cloudflare
Workflow drives the instance, so they are verified manually / via `wrangler dev` (mirroring the
M1/M2 manual lists), not in CI:

- **`sendEvent` discriminated wake** — `fireTimer` waking the Workflow with a discriminated payload
  (`{outcome:'timerFired', timerId}`) on the wait's event type; the engine routes the token down the
  timer path on resume.
- **First-event-wins memoization as the secondary race guard** — Workflow step memoization makes the
  losing wake a no-op; this is a *second* guard behind the D1 decider, not the primary one.
- **Timer-sized `waitForEvent` backstop** — the `waitForEvent` timeout sized to `fire_at` so a 7-day
  timer costs O(1) steps; on any wake the engine re-reads D1 and settles overdue timers
  (`fire_at <= now`) exactly as the alarm path would (the lost-alarm backstop).

## Validation Commands

```bash
npm run test:unit          # bpmn validator (saga + conditional + M3 accept/reject, FEEL parse/null semantics), graph scope, reverse-order ledger, retry backoff curve, timers persistence, fire-timer, job-scheduler DO
npm run test:contract      # /jobs/* + operator verbs + list + saga view vs contracts/openapi.yaml; job-result union (incl. timeout/poison kind); lease SQL; the M2 /jobs/* schema pin (tests/contract/jobs-schema-pin.test.ts)
npm run test:integration   # the nine M1 gates + the five M2 gates + the M3 gates above (D1 + DO + Workflow + pull workers); timer firing via runDurableObjectAlarm, no real sleeps
npm run check:docs         # docs/bpmn/ consistency guard (incl. the M3 incident-kind + eventBasedGateway guards)
npx wrangler deploy --dry-run
```

Expected validation outcome:

- The §3 canonical order-saga, the conditional sample, AND the two M3 samples
  (`examples/timer-saga.bpmn`, `examples/event-gateway-saga.bpmn`) publish and semantically
  round-trip; each still-unsupported construct is rejected with element id + reason (deferred
  gateways/events with their milestone pointers); foreign-ns / DI / `documentation` are tolerated.
- The nine M1 integration gates pass: happy commit; business-error reverse compensation;
  compensator-fail remediation; duplicate complete/fail idempotency; terminal-instance no-op ack;
  cross-tenant activate reject; version binding through compensation; un-leasable-job DLQ timeout;
  poison-job termination.
- The five M2 gates pass: branch-by-data; loop-N-iterations-then-compensate-each; noPath Hazard +
  operator remediation; loopLimit guard; decision-replay stability.
- The M3 gates pass (Scenarios 15–26): boundary-timer alternate path + timer-saga compensation;
  timer-vs-completion race both orders; intermediate timer catch; `eventBasedGateway` race
  (message/timer/buffered/tie-break); receive-task boundary timer; multi-error-boundary + catch-all
  routing; error-path-then-compensate ledger integrity; standalone message catch; abnormal-exit timer
  settlement; `retryable=false` + lease-expiry exhaustion; the incident-kind split + hygiene. The
  M3 Workflow-mode-only paths above are validated manually.
- The four M4 direct-mode gates pass (Scenarios 27–30): AND split/join with frontier-empty
  completion; OR split/join with recorded activation subset; branch-local variable merge in split
  out-flow document order; parallel-branch compensation with straggler ledger, per-token terminators,
  lineage-ordered reverse, and quiescence barrier. **The M4 manual Workflow-mode matrix (WM-1
  through WM-6) FAILED on real Cloudflare Workflows (L6.6, 2026-06-13): the multi-wait AND/OR-join
  hangs after the second branch — a blocking defect that re-opens the L3 engine. M4 is NOT
  closed.** See the "M4 manual Workflow-mode matrix" section above for the root cause + fix
  direction.
- No external workflow infrastructure (Camunda/Zeebe/broker/cluster) is deployed.
