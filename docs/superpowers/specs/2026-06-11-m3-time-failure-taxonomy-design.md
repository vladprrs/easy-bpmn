# M3 — Time & Failure Taxonomy (timers, eventBasedGateway, error routing, incident taxonomy)

**Date:** 2026-06-11
**Status:** Approved design (brainstorming output), hardened by a 4-lens adversarial review
(internal consistency, code-facts, governance, BPMN canonicity). Source artifact for the M3 constitution
amendment (2.1.0 → 2.2.0), the M3 spec deltas in `specs/002-saga-orchestrator`, and the Backlog.md M3
task slicing (TASK-26 epic).
**Builds on:** `2026-06-08-saga-orchestrator-design.md` (§4.5 failure taxonomy, §8 M3 roadmap row, §9 open
questions), `2026-06-09-m2-conditional-sagas-design.md` (rewalk/occurrence engine, `gateway_decisions`),
`2026-06-08-m1-closeout-design.md` (per-job DO-alarm pattern).

---

## 1. Context & goal

M2 shipped conditional sagas (XOR + FEEL + token-path cycles on the rewalk/occurrence engine). M3 is the
roadmap's "Time & failure taxonomy" row: model-level timers and a real failure taxonomy on top of the
M1 minimal technical-vs-business split.

The scope chosen here is the **full** construct set tagged "M3" in the codebase — including
`eventBasedGateway` (deferred to "timers & events (M3)" by `DEFERRED_GATEWAY_REASONS`,
`src/bpmn/profile.ts:38-40`) — plus the failure-taxonomy debt explicitly parked for M3 in code comments
and TASK-26 notes. That is wider than the roadmap's difficulty-L estimate; the design compensates by
slicing into independently shippable layers (§10) where the validator opens each construct only together
with its runtime.

**M3 exit criteria** (roadmap, restated against this scope):

1. A boundary timer on a service task fires and routes the token down its modeled alternate path.
2. A boundary timer on a task inside a `transaction` routes to a cancel end event → the saga compensates
   completed steps in reverse (the canonical "timeout → compensation" pattern).
3. An `eventBasedGateway` race is won by whichever of {message, timer} occurs first, deterministically,
   in both orders.
4. Business vs technical failures route distinctly **per error code** (multiple error boundaries on one
   task reach distinct paths; `retryable=false` short-circuits retries), and the formerly-conflated
   `timeout` meanings are distinguished: two new incident kinds (`jobActivationTimeout`, `waitTimeout`)
   plus the fired-model-timer **non-incident** path (history `timerFired`).

## 2. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Timer construct set** | Interrupting boundary timer (on `serviceTask`/`receiveTask`) + `intermediateCatchEvent` (timer and message) + `eventBasedGateway`. Timer start events, non-interrupting boundary timers, `timeCycle`, and timers on `transaction` stay out (§3). |
| 2 | **Canonical timers only** | No `easy-bpmn` timeout extension attributes. Every model-level timeout is a drawn BPMN timer with a drawn outgoing path. This dissolves the §9 open question of the saga design doc: a boundary timer **always** has a modeled path, so there is no "default behavior" to invent and no conflict with the Hazard principle (Constitution VI). Un-modeled waits keep today's behavior (safety-net incident). |
| 3 | **Error routing** | Free routing: multiple interrupting error boundaries per activity (distinct, non-empty `@errorCode`s), plus at most one catch-all (no `errorRef`); the M1 rule "the single outgoing flow must target a cancel end event" (`src/bpmn/validator.ts:826-840`) is lifted — the flow may target any token-path node in the same scope (§3). |
| 4 | **Firing mechanism** | DO-alarm-first: D1 `timers` table is canonical; a per-timer alarm on a generalized one-shot Scheduler DO (the existing `JobScheduler`, same binding) fires it. One mechanism for all three constructs in both execution modes. The alarm/fire/claim path is fully testable in vitest (direct mode) via `runDurableObjectAlarm`; the Workflow-mode `sendEvent` wake is verified manually/`wrangler dev`, like today's Workflow-only paths (§7). `step.sleep` is not used. |
| 5 | **Race deciders** | Every race has exactly **one deciding row**, claimed by a **plain `INSERT`** (never `INSERT OR IGNORE`) composed into the same `dbBatch` as the loser-visible transition, so the loser's **whole batch aborts** on the unique-constraint violation and the loser converts to the recorded outcome — the documented `gateway_decisions` contract (`src/persistence/gateway-decisions.ts:70-84`). EBG races decide on `gateway_decisions`; boundary/catch timer races decide on a new `timer_outcomes` row (§4.3, §4.5). |
| 6 | **Taxonomy principle** | A fired BPMN timer is **not** an incident — it is a modeled path (history `timerFired`). Incidents remain only for un-modeled safety nets. The overloaded incident kind `timeout` splits into `jobActivationTimeout` (DLQ) and `waitTimeout` (un-guarded wait cap); `conditionFailure` is added for hard FEEL errors. |
| 7 | **Jobs API retry policy** | `retryable` is **honored** (`false` ⇒ immediate exhaustion, skip remaining attempts). Workers that omit the field are unchanged; a worker already sending `retryable=false` (legal and ignored today) changes behavior — called out in the openapi delta/release note. Reclaim re-leases already increment `attempt_count` today; M3 adds the missing **termination check** on the pure-reclaim path. The poison budget stays per-(instance, element) **across** occurrences — the TASK-26 "per-occurrence" candidate is rejected (§5.3). |
| 8 | **Housekeeping in scope** | Incident hygiene (`setIncidentResolution` per-incident, open-incident listing, empty-ledger-cancel closure), jobs-API retry policy (above), and an `engine.ts` extraction refactor (L0) are in M3. Per-model broker buffer TTL stays **deferred** (YAGNI; a model-level knob would also violate decision #2). |
| 9 | **Governance** | Constitution 2.1.0 → **2.2.0** (additive profile widening — same MINOR class as the M2 bump; unlike M2, which amended *after* the validator opened the constructs, M3 amends **first**, as the opening item of L2 — the Principle-I-compliant ordering). The amendment covers the full M3 set once; `docs/bpmn/09` is updated **fully at L2** with an explicit interim state for not-yet-shipped constructs (§8). L0/L1 are constitution-neutral (no profile change) and pass the Constitution Check against 2.1.0. |

## 3. Profile widening (validator: reject → accept-and-validate)

New constructs **IN** after M3 (all standard BPMN 2.0; the only extension binding remains
`easy-bpmn:taskDefinition` on tasks — nothing new). Intermediate catch events and event-based gateways
are token nodes allowed **at process level and inside a `transaction`** (M2 gateway precedent,
`docs/bpmn/03-gateways.md`); a timer park inside a transaction keeps the saga scope open for the whole
delay — deliberate, and covered by a §7 gate.

1. **`bpmn:boundaryEvent` + `timerEventDefinition`** — **interrupting only**. `cancelActivity` absent or
   `true`; an explicit `cancelActivity="false"` is rejected with reason "non-interrupting boundary needs a
   second token — M4". Attachable to `serviceTask` and `receiveTask` (inside or outside a transaction);
   **at most one timer boundary per activity** (two static durations/dates make one statically dead; a
   date+duration pair makes the winner arrival-time-dependent — restricted in M3 for determinism, revisit
   on demand). **Never attachable to an `isForCompensation` handler** (a handler *is* a `serviceTask`,
   but compensation handlers carry no boundary events in BPMN and their boundary's outgoing flow would
   leak a token out of the compensation lane — extends the M2 "no token-path flows into handlers" rule,
   which today only checks flows *targeting* handlers). Exactly one outgoing sequence flow.
   **Not attachable to `transaction`** in M3: per BPMN §10.5.5 only Cancellation auto-compensates a
   transaction, so an interrupting timer boundary would terminate the scope **without** compensation
   (sound inference from §10.5.5 + §13 interrupting-boundary semantics) — a silent-rollback-loss trap.
   The canonical "saga timeout → compensate" shape is a boundary timer on a task *inside* the
   transaction routing to a cancel end event (exit criterion 2). Timers on the transaction itself are
   deferred to M5 (escalation era).
2. **`bpmn:intermediateCatchEvent` + `timerEventDefinition`** — a delay step on the token path. Exactly
   one incoming and one outgoing sequence flow.
3. **`bpmn:intermediateCatchEvent` + `messageEventDefinition`** — required as an EBG branch target; also
   allowed standalone. Exactly one incoming and one outgoing sequence flow (when standalone). Identical
   **wait/correlation/resume** semantics to `receiveTask` (same subscription machinery, correlation key
   supplied at instance start; the `<message>` element carries only its name) — but it is an *event*,
   not an activity: no boundary events attach to it, no `easy-bpmn:taskDefinition`.
4. **`bpmn:eventBasedGateway`** — ≥2 outgoing flows; every target must be an `intermediateCatchEvent`
   (timer or message) whose **only** incoming flow is the one from this gateway. Profile restrictions,
   each rejected with element id + reason: **at most one timer branch** (same rationale and honest
   wording as the boundary-timer multiplicity rule — *not* "dead branch", which is false for a
   date+duration mix); **message branches must reference distinct messages** (two branches on one
   `messageName` collapse to one broker key — `workspaceId + messageName + correlationKey` with an
   instance-level key — and the broker hard-rejects a second active subscription per key,
   `correlation-broker.ts:83`; this must fail at publish, not at runtime); **`instantiate="true"`
   rejected** (instances start via the API — the existing `receiveTask` instantiate rule generalized);
   **`eventGatewayType="Parallel"` rejected** (wait-for-ALL-events semantics — M4-class).

**Timer triggers:** `timeDuration` and `timeDate` only, as **static ISO-8601 literals**. A
`timerEventDefinition` MUST carry exactly one of `timeDate`|`timeDuration`, and the literal MUST parse as
ISO-8601 — zero or two time children, `timeCycle` (repetition ⇒ extra tokens, M4+), a FEEL expression, or
a non-parsing literal are each rejected with element id + reason. FEEL-expression triggers are deferred
(the `timers.fire_at` snapshot makes them replay-safe to add later; §11).

**Error-routing widening:**

- Per activity: any number of interrupting error boundaries whose `errorRef`s resolve to Errors with
  **distinct, non-empty `@errorCode`** values (matching is by `@errorCode` — duplicate codes would make
  two boundaries claim the same exact match; an `errorRef` to an Error with no/empty `errorCode` is
  rejected rather than silently acting as a second catch-all), plus at most one catch-all boundary
  (`errorEventDefinition` without `errorRef`).
- Matching precedence on a worker `fail` with `errorCode`: exact `@errorCode` match → catch-all →
  (no boundary matches) **Hazard**, exactly as today (Constitution VI untouched). The catch-all catches
  *any* business error code, including codes not declared as a `bpmn:error` in the model.
- The boundary's outgoing flow targets any **token-path** node in the same scope — not a start event,
  not another boundary event, not an `isForCompensation` handler (the M2 endpoint rules,
  `validator.ts:564-595`, apply unchanged). An error handled by an alternate path inside a transaction
  leaves the saga ledger untouched: completed steps remain compensatable if the saga cancels later
  (standard compensation semantics — handlers stay registered until the scope cancels or completes).

**Still OUT (rejected pre-publish with element id + reason):** timer start events (instances start via
API — invariant), non-interrupting boundary **timers** (M4; a non-interrupting **error** boundary is
rejected as *invalid BPMN* — Error has no non-interrupting form — never as an M4 deferral), `timeCycle`
(M4+), boundary timers on `transaction` (M5), FEEL-expression timer triggers (deferred),
`signal`/`escalation`/`conditional` events (M5), `eventBasedGateway` `instantiate`/`Parallel` (above),
and everything already excluded. Tolerate-and-ignore for foreign-namespace extensions / DI /
`documentation` is unchanged and re-tested against the new constructs.

## 4. Runtime design

### 4.1 `timers` table (D1 — canonical source of record)

```sql
CREATE TABLE timers (
  timer_id        TEXT PRIMARY KEY,   -- deterministic: instanceId:elementId#occurrence
  instance_id     TEXT NOT NULL,
  element_id      TEXT NOT NULL,      -- the timer-event element (boundary | catch | EBG branch)
  occurrence      INTEGER NOT NULL,   -- the arming visit's occurrence (see below)
  kind            TEXT NOT NULL,      -- boundary | intermediateCatch | eventGateway
  attached_to_ref TEXT,               -- boundary: host activity element id
  gateway_id      TEXT,               -- eventGateway: owning gateway element id
  fire_at         TEXT NOT NULL,      -- computed at arm time (timeDate as-is; now + timeDuration)
  status          TEXT NOT NULL,      -- armed | fired | cancelled  (bookkeeping/read model, §4.3)
  fired_at        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_timers_visit ON timers (instance_id, element_id, occurrence);
CREATE INDEX idx_timers_instance_status ON timers (instance_id, status);

-- The race decider for boundary/catch timers (EBG timers decide on gateway_decisions instead, §4.5).
-- Plain-INSERT-claimed; a conflicting batch aborts wholesale (gateway-decisions.ts contract).
CREATE TABLE timer_outcomes (
  timer_id   TEXT PRIMARY KEY,
  outcome    TEXT NOT NULL,           -- fired | cancelled
  decided_at TEXT NOT NULL
);
```

- **Occurrence keying:** a boundary timer is armed as part of its **host activity's** visit, so
  `occurrence` = the host's visit occurrence; an intermediate catch uses its own visit occurrence; an EBG
  timer branch uses the **gateway's** visit occurrence. Never derived from live D1 counts (M2 rule).
- **Arming is `INSERT OR IGNORE` in the same `dbBatch`** as the wait it guards (the job `svc-create`
  batch, the subscription-registration batch, or the catch/EBG park batch) — persist-before-advance.
  `fire_at` is computed once at first arm; the `timerArmed` history row is written **in the first-arm
  batch only** (paired with the `INSERT OR IGNORE`); a rewalk that revisits an `armed` row is a pure
  re-park (write-free).
- **Fast-forward predicate** (rewalk, write-free): for boundary/catch timers, the `timer_outcomes` row —
  `fired` → the token took the timer path, `cancelled` → the wait resolved the other way; for
  `eventGateway` timers, **`gateway_decisions` is the truth** (the timer row's `status` is bookkeeping
  only). No decider row + `armed` → re-park (and idempotently re-arm the DO alarm). Because the decider
  is claimed in the same batch as the transition, a "fired with no transition" state cannot exist.
- **Wake event type resolution:** `fireTimer` derives the Workflow-mode wake target per kind — boundary
  on a service task → `workflowJobEventTypeFor(jobId)` (job looked up via `attached_to_ref` +
  occurrence); boundary on a receive task / EBG → the subscription's **existing**
  `message_subscriptions.workflow_event_type` column (see §4.5); intermediate catch → a per-visit type
  derived from `element_id#occurrence` through the existing sanitizer (dot-free, ≤100 chars).

### 4.2 Scheduler DO — generalize `JobScheduler`, not a new class

The existing per-job `JobScheduler` Durable Object becomes a generic **one-shot scheduler**. Existing
job DOs keep their raw-`jobId` naming (`idFromName(jobId)`, unchanged — no re-keying of armed DLQ
timers); new timer DOs are keyed `timer:<timerId>` (the prefix cannot collide with job ids). `arm()` =
`storage.put` + `setAlarm(fireAt)`; `alarm()` = re-read D1 → idempotently execute
(`terminateUnleasableJob` | `fireTimer`) → `storage.deleteAll()`. Same wrangler binding
(`JOB_SCHEDULER`, class `JobScheduler`) — no DO-namespace migration.

**Self-healing arm:** arming stays best-effort/non-fatal at write time (M1 precedent), but every engine
rewalk **re-arms all `armed` timers it walks past** (idempotent `setAlarm`), so a DO hiccup is repaired by
the next drive of the instance.

**Timer-guarded waits and the wait cap.** A wait guarded by an armed modeled timer **never raises
`waitTimeout`**. In Workflow mode the `waitForEvent` timeout for such a wait is sized to the timer —
`max(SVC_WAIT_TIMEOUT, fire_at − now + slack)` — so a 7-day timer costs O(1) steps, not 168 hourly
re-parks; the timeout then doubles as the lost-alarm backstop: on any wake the engine re-reads D1 and
settles overdue timers (`fire_at <= now`) exactly as the alarm path would. Un-guarded waits keep today's
fixed 1-hour cap → `waitTimeout` incident (§5.1).

### 4.3 Boundary timer lifecycle (on a service task; receive-task variant below)

1. **Visit:** one batch — forward job row (`svc-create:el#occ`) + `INSERT OR IGNORE` timer row +
   `timerArmed` history (first arm only); then arm the DO.
2. **Exit of a timer-guarded visit — every exit path cancels the timer in its own batch** via the
   decider: the batch carries a plain `INSERT INTO timer_outcomes (timer_id, outcome) VALUES (?,
   'cancelled')` plus the bookkeeping flip `armed → cancelled`. This applies to **all four** exits:
   normal completion (`svc-apply`), business error → error-boundary route, retry exhaustion → Hazard
   incident, and operator `/cancel` (which already abandons active jobs — it now also settles armed
   timers of the abandoned visits). Without this, a stale alarm would fire mid-compensation or on an
   incident-parked instance. DO disarm is best-effort (a stray alarm no-ops against a decided timer).
3. **Fire** (`alarm → fireTimer(timerId)`): re-read D1; no-op unless the instance is non-terminal, the
   row is `armed` with `fire_at <= now`, **and the timer's visit is still the instance's current wait**
   (job/subscription row check, mirroring `abandonActiveForwardJobs`). Then **one batch**: plain
   `INSERT INTO timer_outcomes (…, 'fired')` (the claim) + timer row → `fired` + abandon the in-flight
   job (status-conditional — a late worker `complete`/`fail` gets the existing stable no-op ack) +
   history `timerFired` + the transition out of the wait. If a competing exit batch already claimed the
   decider, this batch **aborts wholesale** on the unique-constraint violation; `fireTimer` catches the
   conflict, re-reads, and no-ops. Then wake the instance — Workflow mode: `sendEvent` with a
   discriminated payload (`{outcome:'timerFired', timerId}`) on the wait's event type (§4.1); direct
   mode: `resumeInline`. The engine routes the token down the boundary's outgoing flow.
4. **Race completion-vs-fire:** both contenders' batches carry the conflicting decider INSERT, so
   exactly one batch commits; the loser aborts atomically (no partial effects) and converts to the
   recorded outcome — completion's `deliverJobResult` re-reads, sees `fired`, and acks the worker with
   the stable "superseded" no-op. This holds in **both** execution modes; Workflow first-event-wins
   memoization is a second guard, not the primary one. Both orders get integration tests.
5. **Receive-task variant:** identical, except the fire batch **supersedes the active broker
   subscription** instead of abandoning a job (mirroring §4.5's losing-branch cleanup) — a late publish
   to that broker key gets the stable buffered/no-match outcome, preserving the at-most-one-active-
   subscription invariant.

Inside a transaction, a boundary timer routing to a cancel end event triggers the standard cancellation →
reverse compensation pass — no new compensation machinery.

### 4.4 Intermediate timer catch

A new engine dispatch case (`timer:el#occ` step naming): batch = timer row + `timerArmed` history + park;
arm; on fire, one batch = `timer_outcomes` claim + flip + history `timerFired` + advance along the single
outgoing flow (status-guarded transition, existing pattern). Operator `/cancel` settles the armed timer
via the decider exactly as in §4.3.2. In Workflow mode the wait is a `waitForEvent` on the per-visit
event type sized per §4.2; direct mode parks and resumes inline from `fireTimer`.

### 4.5 `eventBasedGateway` — the race decides on `gateway_decisions`

The decision row reuses `gateway_decisions` (instance, gateway element, occurrence → chosen flow), with
its **documented contract** (`gateway-decisions.ts:70-84`): a **plain INSERT** (explicitly *not*
`OR IGNORE` — an ignored conflict would let the losing batch's transition commit while its decision row
is discarded, permanently recording branch A while the instance advanced down branch B) composed into the
same batch as the transition; the loser's whole batch aborts, and the loser re-reads the decision and
converts to the recorded branch. Note this is **new concurrent-writer behavior** layered on the table:
XOR's `decideGateway` today is check-first with no concurrent contender; the EBG has two genuine writers
(broker delivery vs `fireTimer`).

1. **Token arrival** (`ebg:el#occ`): one **D1 batch** = occurrence-keyed subscription rows for every
   message branch + timer row (+ `timerArmed`) for the timer branch + park; then **best-effort broker
   registrations** (a DO RPC cannot ride a `dbBatch` — the M1 `registerReceive` pattern; a rewalk
   re-registers idempotently, which is the recovery story for a mid-set crash). Each EBG-branch
   subscription stores the EBG visit's wait event type in the **existing
   `message_subscriptions.workflow_event_type` column** — no new column; the actual change is the
   **delivery path**, which today re-derives the event type from the message name
   (`executor.ts:44-50`, symmetry contract in `profile.ts:64-75`) and must instead honor the stored
   per-subscription value (the symmetry contract is relaxed for EBG subscriptions).
2. **Message wins:** the apply-message batch (payload application atomic with the transition, as for
   receive tasks) carries the `gateway_decisions` INSERT + cancels the timer (bookkeeping flip; the EBG
   timer has no `timer_outcomes` row — `gateway_decisions` is its sole decider) + supersedes the losing
   subscriptions + history `ebgDecision`; the token advances along the winning message branch.
3. **Timer wins:** the `fireTimer` batch carries the `gateway_decisions` INSERT (the claim) + timer row
   → `fired` + supersedes **all** subscriptions + history `timerFired` + `ebgDecision` + transition; the
   token advances along the timer branch. A losing `fireTimer` (message got there first) aborts on the
   decision conflict, re-reads, flips its timer row to `cancelled`, and no-ops.
4. **Early-buffered messages** win at registration time. Tie-break when several branches have buffered
   messages: branches are registered and buffered claims evaluated in **model document order — first hit
   wins**; deterministic and replay-stable via the decision row (a §7 gate covers two buffered branches).

### 4.6 Engine integration & step budget

- New wait outcomes: the job-result event union gains `{ outcome: "timerFired", timerId }`; the message
  wait payload gains the same discriminator; catch/EBG waits get their own event types. All event types
  go through the existing sanitizer (dot-free, ≤100 chars).
- Step names follow the M2 convention, occurrence-tagged: `timer:el#occ`, `ebg:el#occ`; history markers
  `timerArmed` / `timerFired` / `timerCancelled` / `ebgDecision`; fast-forward stays write-free via the
  `timer_outcomes` / `gateway_decisions` / subscription predicates (§4.1).
- Budget: with timer-sized waits (§4.2) a timer adds ~1–2 Workflow steps per visit regardless of
  duration; an EBG ~2–3 — comfortably inside the `limits.steps` headroom; the cap-vs-budget comment in
  `wrangler.jsonc` (R-M2-5) is re-validated during implementation.

## 5. Failure taxonomy

### 5.1 Incident kinds

Today the single kind `timeout` conflates **three** meanings: (a) the un-leasable-job DLQ expiry
(`engine.ts:564`), (b) the 1-hour service-task wait cap (`engine.ts:442-445`), (c) the 1-hour
receive-task wait cap (`engine.ts:1232-1237`). (The compensation wait cap is **not** a `timeout` site —
it writes `compensationFailure` + `compensationFailed` via `markStepCompensationFailed`, and M3 does not
change that.)

After M3: `serviceTaskFailure | compensationFailure | conditionFailure | jobActivationTimeout |
waitTimeout | poison | loopLimit | noPath` (+ legacy `timeout`).

- `jobActivationTimeout` — meaning (a): nobody leases the `taskType` before `activation_expires_at`.
- `waitTimeout` — meanings (b)+(c): an **un-guarded** wait (no modeled timer) hits the safety-net cap.
  A wait guarded by a modeled timer never raises it (§4.2).
- `conditionFailure` — hard FEEL evaluation errors (deferred from M2/TASK-34; today masked as
  `serviceTaskFailure`).
- Existing `timeout` rows are left as-is (not distinguishable retroactively); the API enum retains
  `timeout` documented as legacy. New code never writes it.
- **A fired model timer never creates an incident** — it is a modeled path.

### 5.2 Incident hygiene (shipped M3 fixes for flagged warts)

- `setIncidentResolution` gains an `incident_id` filter (today it flips **all** non-`operatorResolved`
  rows of the instance — `src/persistence/instances.ts:748-753`).
- Instance inspection exposes the **list of open incidents**, not only the latest (`LIMIT 1` today).
- Operator `/cancel` with an empty ledger closes **all open incidents** as `operatorResolved` instead of
  leaving them `open` on a terminal instance; `/cancel` also settles armed timers (§4.3.2).

### 5.3 Jobs API retry policy

- **`retryable` honored:** `fail` with `retryable=false` ⇒ immediate exhaustion (skip remaining
  attempts) → the standard exhaustion path (Hazard incident inside a transaction). Absent/`true` ⇒
  current backoff behavior. No request-schema change; `openapi.yaml` re-documents the field as honored,
  with an explicit behavior-change note for workers already sending `retryable=false` (advisory and
  ignored today, `openapi.yaml:857-864`).
- **Reclaim exhaustion enforced:** reclaim re-leases already increment `attempt_count`
  (`jobs.ts:32-65`); what's missing is the termination check — neither `leaseJobs` nor
  `parkExpiredLease` compares against `retry_limit`, so a job exhausted purely through lease expiry
  retries forever (deferral comment at `src/index.ts:629-633`). M3 routes reclaim exhaustion into the
  same exhaustion path as `fail`.
- **Poison budget: keep across-occurrence (TASK-26 candidate rejected).** `src/runtime/engine.ts:600-606`
  records a deliberate TASK-35 decision: strikes are counted per (instance, element) across all
  occurrences, because an element whose completions keep breaching the merge limit is poisoning the
  instance regardless of which loop iteration produced the output — a per-occurrence budget would grant
  a cycling model up to `POISON_THRESHOLD × MAX_ELEMENT_OCCURRENCES` strikes before dying. M3 keeps the
  shared budget; per-occurrence remains deferred until a real model needs it (§11).

## 6. API & observability deltas

- `GET /instances/{id}` gains a `timers` block (armed/fired/cancelled with `fire_at`/`fired_at`) read
  from D1 — Workflow internals stay hidden.
- New history event types (free-text column, no migration): `timerArmed`, `timerFired`, `timerCancelled`,
  `ebgDecision`.
- `openapi.yaml`: incident-kind enum extended (+legacy `timeout` retained); `retryable` documented as
  honored **with the behavior-change note** (decision #7); inspection schema gains `timers` and the
  open-incidents list.
- **No new operator verbs.** "Fire timer now" is deferred (§11). Existing `/cancel` and `/retry`
  semantics are unchanged (beyond `/cancel` settling timers and closing open incidents, §5.2).

## 7. Testing

The alarm → `fireTimer` → claim/abort → D1 path — the primary mechanism in both modes — is fully
testable in vitest direct mode (the only mode CI runs): `runDurableObjectAlarm` from `cloudflare:test`
triggers a Scheduler DO alarm deterministically (precedent: `tests/integration/saga-dlq-timeout.test.ts`),
no real sleeps anywhere. **Workflow-mode-only paths are verified manually/`wrangler dev`** (mirroring the
M1/M2 lists): the `sendEvent` discriminated wake, first-event-wins memoization as the secondary race
guard, and the timer-sized `waitForEvent` backstop settling.

Integration/quickstart gates (each an executable scenario, M2 style):

1. Boundary timer on a service task → alternate path taken; late worker callback → stable no-op ack.
2. Boundary timer inside a transaction → cancel end → reverse compensation (exit criterion 2).
3. Timer-vs-completion race, both orders: the loser's batch aborts on the decider conflict and converts
   (complete first → fire no-ops; fire first → late complete gets the superseded no-op ack).
4. Intermediate timer catch delays and advances — at process level and **inside a transaction** (scope
   stays open across the delay).
5. EBG: message wins / timer wins / early-buffered message wins at registration / **two** buffered
   branches → model-document-order tie-break; decision replay-stable; losing subscriptions superseded.
6. Boundary timer on a **receive task** fires → subscription superseded; a late publish gets the stable
   buffered/no-match outcome.
7. Multi-error-boundary routing: distinct `errorCode`s reach distinct paths; catch-all catches an
   undeclared code; unmatched code without catch-all stays a Hazard.
8. **Error → alternate path → saga continues → later cancel:** ALL completed forward steps (pre- and
   post-error) compensate in reverse — the ledger-untouched claim of §3.
9. Standalone message `intermediateCatchEvent` correlates and advances like a `receiveTask`
   (publish-before and publish-after orders).
10. Abnormal-exit timer settlement: error-boundary exit, retry exhaustion, and operator `/cancel` each
    cancel the armed timer; a stray alarm afterwards is a no-op (no mid-compensation firing).
11. `retryable=false` → immediate exhaustion incident; lease-expiry exhaustion terminates via the same
    path.
12. Incident kinds: DLQ → `jobActivationTimeout`; un-guarded wait cap → `waitTimeout`; hard FEEL error →
    `conditionFailure`; hygiene fixes (per-incident resolution, open list, empty-ledger close-all).

Plus: validator accept/reject matrix for every §3 rule (including: boundary on a compensation handler,
second timer boundary, EBG duplicate messages / `instantiate` / `Parallel` type, malformed
`timerEventDefinition`, non-interrupting error boundary, tolerate-and-ignore), contract tests for the
openapi deltas, broker unit tests for EBG supersede + buffered claims, and Scheduler DO unit tests
(idempotent alarm, re-arm, stray-alarm no-op).

## 8. Governance

- **Constitution 2.1.0 → 2.2.0**, amended once as the **opening item of L2**, before any M3 construct
  ships. The amendment procedure is the full set required by `constitution.md:215-218`, not just the
  Sync Impact Report: updated constitution + Sync Impact Report + semver reasoning + review of dependent
  Spec Kit templates (`.specify/templates/plan-template.md` and `spec-template.md` re-list the accepted
  construct set — both changed for M2) + the `CLAUDE.md` lockstep line (pinned to "constitution v2.1.0"
  today) + the L2 backlog task referencing every constitution-impacting file change.
  Exact text changes: the accepted-set addition lives in **Principle I** (`constitution.md:55-67`,
  plus the milestone sentence at `:82-83`); the exclusion list lives in **MVP Scope**
  (`constitution.md:169-179`) — drop `event-based` from the gateway line (`:170`), **requalify** (not
  delete) the events line (`:171-172`: timer **start** events and non-catch message events stay
  excluded; interrupting boundary timers and timer/message intermediate catch events become accepted),
  update the milestone parenthetical (`:178-179`), and extend the in-scope recap (`:181-187`). The
  "error boundary must route to a cancel end event" restriction is **not** in the constitution — it is
  lifted in `docs/bpmn/09` (`:209`, `:296`) and the validator only.
- **Lockstep with an explicit interim state.** `docs/bpmn/09-easy-bpmn-profile.md` is updated **fully at
  L2** (not per layer — its own rule `09:383-384` requires lockstep with the amendment AND the
  validator, which a lagging update cannot satisfy): bump the version pin (`09:4`), move the M3
  constructs out of the deferred table (`09:249-250`) into an explicit interim marking — "amended in
  v2.2.0; validator opens at L3/L4, until then rejects with reason 'M3 — not yet implemented'" — rewrite
  the deferred-table preamble (`09:244`), and amend the `09:383-384` lockstep sentence to define this
  interim state. The validator keeping a constitution-allowed construct rejected with that reason until
  its layer ships is then documented behavior, not drift.
- **`docs/bpmn/01-events.md` scope section fixed at L2, not L5** — it is already false for shipped M1/M2
  ("None Start/End only", "**all** boundary events out of scope", `01-events.md:123-134`), so the fix is
  half an M1 correction; a `check:docs` stale-phrase pattern lands in the same change so it cannot
  regress.
- **`check:docs` concrete deltas:** (a) L1 updates the `09:29-31` M1-exception bullet (`kind=timeout` →
  `jobActivationTimeout`) and adds an incident-kind enum sync guard; (b) L2 adds the `01-events.md`
  stale-phrase patterns (the M2 precedent for extending the guard, commit `4d25d3a`); (c) L4 flips
  guard 5 of `scripts/check-docs.mjs` (`:139-159`), which today hard-requires the
  "eventBasedGateway … M3" deferred pointer in lockstep with `DEFERRED_GATEWAY_REASONS`
  (`profile.ts:39`) — both flip together when EBG ships.
- **Spec Kit — honest precedent, gap closed.** What M2 actually did: updated `data-model.md`,
  `quickstart.md`, and both contracts files (commit `a1a9aa5`); **never touched `spec.md`/`plan.md`**
  (both still M1-only — `plan.md:7` declares "M2–M5 each require their own constitution amendment and
  plan"); **no recorded Constitution Check**. M3 ships the same artifact set (data-model/contracts/
  quickstart M3 deltas) **plus closes the gap**: the L2 governance task records an explicit Constitution
  Check (pre-implementation, against 2.2.0) with this design doc as the spec source, and notes the M2
  deviation. A full Spec Kit plan for M3 is deliberately not produced — the project's operating mode
  since M2 is brainstorming-design → backlog slicing; this deviation from `plan.md:7` is recorded here
  (Complexity-Tracking style) rather than laundered as precedent.
- **Backlog:** slice the TASK-26 epic into per-layer tasks (its AC#1; record that the specs/002 M3
  deltas + Constitution Check are owed by L2/L5 tasks) and close the stale TASK-25 (M2 epic — AC#3 was
  delivered by TASK-34; M2 shipped).

## 9. Risks

- **R1 — refactor-then-build ordering:** L0 extracts modules from the 1.4k-line `engine.ts` before any
  M3 feature. Mitigation: behavior-frozen refactor, full suite green, no public-API change; land it as
  its own reviewed task.
- **R2 — race-decider discipline:** the whole correctness story rests on "plain INSERT decider in the
  same batch as the transition" (decision #5). An `INSERT OR IGNORE`, a decider outside the batch, or a
  missing decider on one exit path silently reintroduces the double-advance bug. Mitigation: the
  `gateway-decisions.ts` contract comment is the normative reference; both race orders + all four
  abnormal-exit paths are integration-tested (§7 gates 3, 10).
- **R3 — EBG delivery plumbing:** honoring the stored `workflow_event_type` instead of re-deriving it
  (`executor.ts:44-50`) touches the broker delivery path and relaxes the `profile.ts:64-75` symmetry
  contract. Mitigation: broker unit tests cover supersede and buffered-early-message claims; the
  receive-task path keeps its existing behavior.
- **R4 — canonicity drift:** new sample models (timer saga, EBG saga) must round-trip (semantically)
  through bpmn-js, as the §3 example of the saga design does.
- **R5 — alarm reliability:** a missed DO alarm parks an instance until the next drive. Mitigation:
  rewalk re-arm (§4.2), the timer-sized `waitForEvent` backstop with overdue settling on any wake, and
  the fire guard's idempotent re-check.
- **R6 — API-visible behavior changes:** the incident-kind enum is public, and honoring `retryable`
  changes semantics for workers already sending `false`. Mitigation: additive enum with the legacy value
  retained; explicit release/contract notes; contract tests updated in the same layer (L1).

## 10. Roadmap — shippable layers

| Layer | Scope | Notes |
|-------|-------|-------|
| **L0** | `engine.ts` module extraction (dispatch registry, service-task visit block, compensation pass, incident helpers) | Pure refactor; no behavior change; suite green. |
| **L1** | Failure taxonomy: incident-kind split + hygiene fixes + `retryable`/reclaim-exhaustion | No profile change; openapi + contract tests + `09:29-31` bullet + incident-kind `check:docs` guard. |
| **L2** | Constitution 2.2.0 (full M3 set, full amendment procedure incl. templates + CLAUDE.md) + **full `docs/bpmn/09` update with interim markings** + `01-events.md` fix + stale-phrase guards + recorded Constitution Check; then free error routing (validator + engine + tests) | Governance first, then the smallest runtime delta. |
| **L3** | Boundary timers: `timers`+`timer_outcomes` migration + Scheduler DO generalization + arm/fire/decider runtime + abnormal-exit settlement + inspection `timers` block | Exit criteria 1–2; §7 gates 1–4, 6, 10. |
| **L4** | Intermediate catch (timer + message) + `eventBasedGateway` (incl. EBG validator rules, delivery-path change, tie-break) + `check:docs` guard-5 flip | Exit criterion 3; §7 gates 4–5, 9. |
| **L5** | Quickstart M3 gates + sample models (timer saga, EBG saga) + round-trip tests + specs/002 data-model/contracts/quickstart M3 deltas + docs final sweep + epic closure | Round-trip gates for the new samples. |

## 11. Deferred (tracked, not dropped)

- `timeCycle` and non-interrupting boundary **timers** (need extra tokens) — M4. (A non-interrupting
  *error* boundary is invalid BPMN, rejected permanently — not deferred.)
- Boundary timers on `transaction`, `signal`/`escalation`/`conditional` events — M5.
- Timer start events — conflicts with the instances-start-via-API invariant; revisit only with a concrete
  need.
- FEEL expressions in timer definitions — replay-safe to add later (`fire_at` snapshot), kept out for
  modeler portability and scope control.
- Multiple timer boundaries per activity / multiple EBG timer branches (the date+duration
  "deadline-vs-timeout" race) — a legitimate standard shape, restricted in M3 for determinism; revisit
  when a real model needs it.
- `eventGatewayType="Parallel"` (wait-for-all) — M4-class semantics.
- Per-model broker buffer TTL — YAGNI; also has no canonical home in the model under decision #2.
- Per-occurrence poison budget — deliberately rejected (TASK-35 rationale, §5.3); revisit only when a
  real model needs a fresh budget per loop pass.
- "Fire timer now" operator verb — useful ops tool, not needed for any exit criterion.
