# M3 — Time & Failure Taxonomy (timers, eventBasedGateway, error routing, incident taxonomy)

**Date:** 2026-06-11
**Status:** Approved design (brainstorming output). Source artifact for the M3 constitution amendment
(2.1.0 → 2.2.0), the M3 sections of `specs/002-saga-orchestrator`, and the Backlog.md M3 task slicing
(TASK-26 epic).
**Builds on:** `2026-06-08-saga-orchestrator-design.md` (§4.5 failure taxonomy, §8 M3 roadmap row, §9 open
questions), `2026-06-09-m2-conditional-sagas-design.md` (rewalk/occurrence engine, `gateway_decisions`),
`2026-06-08-m1-closeout-design.md` (per-job DO-alarm pattern).

---

## 1. Context & goal

M2 shipped conditional sagas (XOR + FEEL + token-path cycles on the rewalk/occurrence engine). M3 is the
roadmap's "Time & failure taxonomy" row: model-level timers and a real failure taxonomy on top of the
M1 minimal technical-vs-business split.

The scope chosen here is the **full** construct set tagged "M3" in the codebase — including
`eventBasedGateway` (`src/bpmn/profile.ts` defers it to "M3 — timers & events") — plus the failure-taxonomy
debt explicitly parked for M3 in code comments and TASK-26 notes. That is wider than the roadmap's
difficulty-L estimate; the design compensates by slicing into independently shippable layers (§10) where
the validator opens each construct only together with its runtime.

**M3 exit criteria** (roadmap, restated against this scope):

1. A boundary timer on a service task fires and routes the token down its modeled alternate path.
2. A boundary timer on a task inside a `transaction` routes to a cancel end event → the saga compensates
   completed steps in reverse (the canonical "timeout → compensation" pattern).
3. An `eventBasedGateway` race is won by whichever of {message, timer} occurs first, deterministically,
   in both orders.
4. Business vs technical failures route distinctly **per error code**: multiple error boundaries on one
   task route to distinct paths; `retryable=false` short-circuits retries; incident kinds distinguish the
   three formerly-conflated timeout meanings.

## 2. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Timer construct set** | Interrupting boundary timer (on `serviceTask`/`receiveTask`) + `intermediateCatchEvent` (timer and message) + `eventBasedGateway`. Timer start events, non-interrupting boundaries, `timeCycle`, and timers on `transaction` stay out (§3). |
| 2 | **Canonical timers only** | No `easy-bpmn` timeout extension attributes. Every model-level timeout is a drawn BPMN timer with a drawn outgoing path. This dissolves the §9 open question of the saga design doc: a boundary timer **always** has a modeled path, so there is no "default behavior" to invent and no conflict with the Hazard principle (Constitution VI). Un-modeled waits keep today's behavior (safety-net incident). |
| 3 | **Error routing** | Free routing: multiple interrupting error boundaries per activity with distinct `errorRef`, plus at most one catch-all (no `errorRef`); the boundary's outgoing flow may target any node in the same scope — the M1 "must reach a cancel end event" rule is lifted. |
| 4 | **Firing mechanism** | DO-alarm-first: D1 `timers` table is canonical; a per-timer alarm on a generalized one-shot Scheduler DO (the existing `JobScheduler`, renamed in role, same binding) fires it. One mechanism for all three constructs, identical in Workflow and direct modes, fully testable in vitest via `runDurableObjectAlarm`. `step.sleep` is not used. |
| 5 | **EBG decision storage** | Reuse `gateway_decisions` (instance, gateway, occurrence → chosen flow): the EBG race winner is whoever first inserts the decision row — the same atomic-claim + replay-stable-fast-forward semantics XOR already has. No new decision table. |
| 6 | **Taxonomy principle** | A fired BPMN timer is **not** an incident — it is a modeled path (history `timerFired`). Incidents remain only for un-modeled safety nets. The overloaded incident kind `timeout` splits into `jobActivationTimeout` (DLQ) and `waitTimeout` (wait-cap safety net); `conditionFailure` is added for hard FEEL errors. |
| 7 | **Jobs API retry policy** | `retryable` is **honored** (`false` ⇒ immediate exhaustion, skip remaining attempts; default `true` — existing workers unchanged). Lease-expiry reclaims count toward `retries`. The poison budget stays per-(instance, element) **across** occurrences — the TASK-26 "per-occurrence" candidate is rejected (§5.3). |
| 8 | **Housekeeping in scope** | Incident hygiene (`setIncidentResolution` per-incident, open-incident listing, empty-ledger-cancel closure), jobs-API retry policy (above), and an `engine.ts` extraction refactor (L0) are in M3. Per-model broker buffer TTL stays **deferred** (YAGNI; a model-level knob would also violate decision #2). |
| 9 | **Governance** | Constitution 2.1.0 → **2.2.0** (additive profile widening, M2 precedent), amended once up front for the full M3 set; `docs/bpmn/09` updated in lockstep per shipped layer; `docs/bpmn/01-events.md` stale MVP scope section fixed; M3 sections land in `specs/002-saga-orchestrator` (M2 precedent — no new feature directory). |

## 3. Profile widening (validator: reject → accept-and-validate)

New constructs **IN** after M3 (all standard BPMN 2.0; the only extension binding remains
`easy-bpmn:taskDefinition` on tasks — nothing new):

1. **`bpmn:boundaryEvent` + `timerEventDefinition`** — **interrupting only**. `cancelActivity` absent or
   `true`; an explicit `cancelActivity="false"` is rejected with reason "non-interrupting boundary needs a
   second token — M4". Attachable to `serviceTask` and `receiveTask` (inside or outside a transaction).
   Exactly one outgoing sequence flow; its target may be any node in the same scope.
   **Not attachable to `transaction`** in M3: per the BPMN spec an interrupting timer on a transaction
   terminates the scope **without** compensation (only Cancel auto-compensates) — a silent-rollback-loss
   trap. The canonical "saga timeout → compensate" shape is a boundary timer on a task *inside* the
   transaction routing to a cancel end event (exit criterion 2). Timers on the transaction itself are
   deferred to M5 (escalation era).
2. **`bpmn:intermediateCatchEvent` + `timerEventDefinition`** — a delay step on the token path. Exactly
   one incoming and one outgoing sequence flow.
3. **`bpmn:intermediateCatchEvent` + `messageEventDefinition`** — required as an EBG branch target;
   also allowed standalone, with semantics identical to `receiveTask` (same subscription machinery,
   correlation key supplied at instance start). The `<message>` element carries only its name, as today.
4. **`bpmn:eventBasedGateway`** — ≥2 outgoing flows; every target must be an `intermediateCatchEvent`
   (timer or message) whose **only** incoming flow is the one from this gateway; **at most one timer
   branch** per gateway (a second timer can never win against an earlier one — a dead branch; rejected
   with element id + reason).

**Timer triggers:** `timeDuration` and `timeDate` only, as **static ISO-8601 literals**. `timeCycle`
(repetition ⇒ extra tokens) is rejected → M4+. FEEL expressions inside timer definitions are rejected →
deferred (the `timers.fire_at` snapshot makes them replay-safe to add later; see §11).

**Error-routing widening:**

- Per activity: any number of interrupting error boundaries with **distinct, resolvable** `errorRef`s,
  plus at most one catch-all boundary (`errorEventDefinition` without `errorRef`).
- Matching precedence on a worker `fail` with `errorCode`: exact `@errorCode` match → catch-all →
  (no boundary matches) **Hazard**, exactly as today (Constitution VI untouched). The catch-all catches
  *any* business error code, including codes not declared as a `bpmn:error` in the model.
- The boundary's outgoing flow targets any node in the same scope. An error handled by an alternate path
  inside a transaction leaves the saga ledger untouched: completed steps remain compensatable if the saga
  cancels later.

**Still OUT (rejected pre-publish with element id + reason):** timer start events (instances start via
API — invariant), non-interrupting boundary events (M4), `timeCycle` (M4+), boundary timers on
`transaction` (M5), FEEL-expression timer triggers (deferred), `signal`/`escalation`/`conditional` events
(M5), and everything already excluded. Tolerate-and-ignore for foreign-namespace extensions / DI /
`documentation` is unchanged and re-tested against the new constructs.

## 4. Runtime design

### 4.1 `timers` table (D1 — canonical source of record)

```sql
CREATE TABLE timers (
  timer_id        TEXT PRIMARY KEY,   -- deterministic: instanceId:elementId#occurrence
  instance_id     TEXT NOT NULL,
  element_id      TEXT NOT NULL,      -- the timer-event element (boundary | catch | EBG branch target)
  occurrence      INTEGER NOT NULL,   -- the arming visit's occurrence (see below)
  kind            TEXT NOT NULL,      -- boundary | intermediateCatch | eventGateway
  attached_to_ref TEXT,               -- boundary: host activity element id
  gateway_id      TEXT,               -- eventGateway: owning gateway element id
  fire_at         TEXT NOT NULL,      -- computed at arm time (timeDate as-is; now + timeDuration)
  status          TEXT NOT NULL,      -- armed | fired | cancelled
  fired_at        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_timers_visit ON timers (instance_id, element_id, occurrence);
CREATE INDEX idx_timers_instance_status ON timers (instance_id, status);
```

- **Occurrence keying:** a boundary timer is armed as part of its **host activity's** visit, so
  `occurrence` = the host's visit occurrence; an intermediate catch uses its own visit occurrence; an EBG
  timer branch uses the **gateway's** visit occurrence. Never derived from live D1 counts (M2 rule).
- **Arming is `INSERT OR IGNORE` in the same `dbBatch`** as the wait it guards (the job `svc-create`
  batch, the subscription-registration batch, or the catch/EBG park batch) — persist-before-advance.
  `fire_at` is computed once at first arm; a rewalk that revisits an `armed` row is a pure re-park.
- **Fast-forward predicate** (rewalk, write-free): `fired` → the token took the timer path; `cancelled` →
  the wait resolved the other way; `armed` → re-park (and idempotently re-arm the DO alarm).

### 4.2 Scheduler DO — generalize `JobScheduler`, not a new class

The existing per-job `JobScheduler` Durable Object becomes a generic **one-shot scheduler**. Existing
job DOs keep their raw-`jobId` naming (`idFromName(jobId)`, unchanged — no re-keying of armed DLQ
timers); new timer DOs are keyed `timer:<timerId>` (the prefix cannot collide with job ids). `arm()` =
`storage.put` + `setAlarm(fireAt)`; `alarm()` = re-read D1 → idempotently execute
(`terminateUnleasableJob` | `fireTimer`) → `storage.deleteAll()`. Same wrangler binding
(`JOB_SCHEDULER`, class `JobScheduler`) — no DO-namespace migration.

**Self-healing arm:** arming stays best-effort/non-fatal at write time (M1 precedent), but every engine
rewalk **re-arms all `armed` timers it walks past** (idempotent `setAlarm`), so a DO hiccup is repaired by
the next drive of the instance. In Workflow mode the existing 1-hour `waitForEvent` cap additionally acts
as a wake-up backstop: on any wake the engine re-reads D1 and settles overdue timers (`fire_at <= now`)
exactly as the alarm path would.

### 4.3 Boundary timer lifecycle (on a service task; receive task analogous)

1. **Visit:** one batch — forward job row (`svc-create:el#occ`) + `INSERT OR IGNORE` timer row; then arm
   the DO.
2. **Normal completion** (`svc-apply`): the same batch flips the timer `armed → cancelled`; DO disarm is
   best-effort (a stray alarm no-ops against a `cancelled` row).
3. **Fire** (`alarm → fireTimer(timerId)`): re-read D1; no-op unless the instance is non-terminal and the
   row is `armed` with `fire_at <= now`. Then **atomic claim**
   `UPDATE timers SET status='fired' WHERE timer_id=? AND status='armed'`; on claim: one batch =
   abandon the in-flight job (status-conditional, the `abandonActiveForwardJobs` shape — a late worker
   `complete`/`fail` gets the existing stable no-op ack) + history `timerFired` + transition; then wake
   the instance — Workflow mode: `sendEvent` with a discriminated payload on the current wait's event
   type; direct mode: `resumeInline`. The engine routes the token down the boundary's outgoing flow.
4. **Race completion-vs-fire:** D1's single writer means exactly one side wins its conditional update
   (the loser matches 0 rows); in Workflow mode, first-event-wins step memoization is a second guard;
   both sides re-read D1 before acting. Both orders get integration tests.

Inside a transaction, a boundary timer routing to a cancel end event triggers the standard cancellation →
reverse compensation pass — no new compensation machinery.

### 4.4 Intermediate timer catch

A new engine dispatch case (`timer:el#occ` step naming): batch = timer row + park; arm; on fire, claim +
history + advance along the single outgoing flow. In Workflow mode the wait is a `waitForEvent` on a
sanitized per-visit event type (`bpmn_timer_…`, dot-free ≤100 chars via the existing
`workflowEventTypeFor`-style sanitizer); direct mode parks and resumes inline from `fireTimer`.

### 4.5 `eventBasedGateway` — the race reuses `gateway_decisions`

1. **Token arrival** (`ebg:el#occ`): one batch = broker subscriptions for every message branch +
   timer row for the timer branch (if any); park. Each EBG-branch subscription records the EBG visit's
   wait **event type** so the deliver path can target the single `waitForEvent` of this visit (the
   subscriptions table gains a wait-target column; exact name at plan time).
2. **Winner = first to insert the `gateway_decisions` row** for (instance, gateway, occurrence): message
   delivery claims it inside the existing atomic apply-message transition; `fireTimer` claims it on the
   timer path. The loser's insert violates uniqueness → no-op (stable prior outcome).
3. **After the claim:** cancel the timer (`armed → cancelled`), close the losing subscriptions
   (superseded), history `ebgDecision`, advance along the winning branch. Message payload application is
   atomic with the transition, as for receive tasks.
4. **Early-buffered messages** in the broker win immediately at registration time — deterministic, and
   replay-stable via the decision row.

### 4.6 Engine integration & step budget

- New wait outcomes: the job-result event union gains `{ outcome: "timerFired", timerId }`; the message
  wait payload gains the same discriminator; catch/EBG waits get their own event types. All event types
  go through the existing sanitizer (dot-free, ≤100 chars).
- Step names follow the M2 convention, occurrence-tagged: `timer:el#occ`, `ebg:el#occ`, plus
  `timerFired`/`timerCancelled` history markers; fast-forward stays write-free via the `timers` /
  `gateway_decisions` / subscription predicates.
- Budget: a timer adds ~1–2 Workflow steps per visit, an EBG ~2–3 — comfortably inside the
  `limits.steps` headroom; the cap-vs-budget comment in `wrangler.jsonc` (R-M2-5) is re-validated during
  implementation.

## 5. Failure taxonomy

### 5.1 Incident kinds

After M3: `serviceTaskFailure | compensationFailure | conditionFailure | jobActivationTimeout |
waitTimeout | poison | loopLimit | noPath` (+ legacy `timeout`).

- `jobActivationTimeout` — the DLQ case (nobody leases the `taskType`); replaces `timeout` at the
  un-leasable-job site.
- `waitTimeout` — the safety-net wait cap (today's fixed 1-hour svc/recv/comp waits) fired with **no**
  modeled timer; replaces `timeout` at those sites.
- `conditionFailure` — hard FEEL evaluation errors (deferred from M2/TASK-34; today masked as
  `serviceTaskFailure`).
- Existing `timeout` rows are left as-is (the three meanings are not distinguishable retroactively);
  the API enum retains `timeout` documented as legacy. New code never writes it.
- **A fired model timer never creates an incident** — it is a modeled path.

### 5.2 Incident hygiene (shipped M3 fixes for flagged warts)

- `setIncidentResolution` gains an `incident_id` filter (today it flips **all** non-`operatorResolved`
  rows of the instance — `src/persistence/instances.ts`).
- Instance inspection exposes the **list of open incidents**, not only the latest (`LIMIT 1` today).
- Operator `/cancel` with an empty ledger closes the open incident as `operatorResolved` instead of
  leaving it `open` on a terminal instance.

### 5.3 Jobs API retry policy

- **`retryable` honored:** `fail` with `retryable=false` ⇒ immediate exhaustion (skip remaining
  attempts) → the standard exhaustion path (Hazard incident inside a transaction). Absent/`true` ⇒
  current backoff behavior. No request-schema change; `openapi.yaml` re-documents the field as honored.
- **Lease-expiry counts as an attempt:** exhaustion purely through repeated reclaims now terminates via
  the same exhaustion path (closes the explicit deferral at `src/index.ts:633` — today such a job retries
  forever).
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
  honored; inspection schema gains `timers` and the open-incidents list.
- **No new operator verbs.** "Fire timer now" is deferred (§11). Existing `/cancel` and `/retry`
  semantics are unchanged.

## 7. Testing

All timer paths are testable in the vitest direct mode (the only mode CI runs):
`runDurableObjectAlarm` from `cloudflare:test` triggers a Scheduler DO alarm deterministically — no real
sleeps anywhere in the suite.

Integration/quickstart gates (each an executable scenario, M2 style):

1. Boundary timer on a service task → alternate path taken; late worker callback → stable no-op ack.
2. Boundary timer inside a transaction → cancel end → reverse compensation (exit criterion 2).
3. Timer-vs-completion race, both orders (complete first → timer no-ops; fire first → late complete
   no-ops).
4. Intermediate timer catch delays and advances.
5. EBG: message wins / timer wins / early-buffered message wins at registration; decision replay-stable.
6. Multi-error-boundary routing: distinct `errorCode`s reach distinct paths; catch-all catches an
   undeclared code; unmatched code without catch-all stays a Hazard.
7. `retryable=false` → immediate exhaustion incident.
8. Lease-expiry exhaustion terminates via the exhaustion path.
9. Incident kinds: DLQ → `jobActivationTimeout`; wait cap → `waitTimeout`; hard FEEL error →
   `conditionFailure`; hygiene fixes (per-incident resolution, open list, empty-ledger close).

Plus: validator accept/reject matrix for every §3 rule (including tolerate-and-ignore), contract tests
for the openapi deltas, broker unit tests for EBG subscription supersede, and Scheduler DO unit tests
(idempotent alarm, re-arm, stray-alarm no-op).

## 8. Governance

- **Constitution 2.1.0 → 2.2.0** (additive profile widening; M2 precedent), amended **once, up front
  (L2)** for the full M3 construct set, with a Sync Impact Report. Principle I's exclusion list trims
  timer/EBG/intermediate-catch constructs and the error-routing restriction; Principles V/VI untouched
  (the Hazard rule is preserved by decision #2).
- The validator may keep rejecting a constitution-allowed construct with reason "M3 — not yet
  implemented" until its layer ships (validator opens each construct only with its runtime).
- **Lockstep docs:** `docs/bpmn/09-easy-bpmn-profile.md` updated per shipped layer; the stale MVP-scope
  section of `docs/bpmn/01-events.md` (lines ~123-134) fixed; `npm run check:docs` guards extended where
  constants/enums are duplicated into docs.
- **Spec Kit:** M3 sections land in `specs/002-saga-orchestrator` (spec/plan/data-model/contracts/
  quickstart), passing the Constitution Check before research and after design, as M2 did.
- **Backlog:** slice the TASK-26 epic into per-layer tasks (its AC#1) and close the stale TASK-25
  (M2 epic, still "To Do" though M2 shipped).

## 9. Risks

- **R1 — refactor-then-build ordering:** L0 extracts modules from the 1.4k-line `engine.ts` before any
  M3 feature. Mitigation: behavior-frozen refactor, full suite green, no public-API change; land it as
  its own reviewed task.
- **R2 — timer races:** completion-vs-fire and EBG message-vs-timer. Mitigation: every transition is a
  conditional single-writer D1 update; both orders are integration-tested; Workflow memoization is a
  second, not primary, guard.
- **R3 — EBG delivery plumbing:** routing broker deliveries to a per-visit wait event type touches the
  correlation broker. Mitigation: subscriptions carry the wait target; broker unit tests cover supersede
  and buffered-early-message claims.
- **R4 — canonicity drift:** new sample models (timer saga, EBG saga) must round-trip (semantically)
  through bpmn-js, as the §3 example of the saga design does.
- **R5 — alarm reliability:** a missed DO alarm parks an instance until the next drive. Mitigation:
  rewalk re-arm (4.2), the Workflow 1-hour wake backstop, and overdue-timer settling on any wake.
- **R6 — API-visible enum change:** incident kinds are public. Mitigation: additive enum, legacy value
  retained, contract tests updated in the same layer (L1).

## 10. Roadmap — shippable layers

| Layer | Scope | Notes |
|-------|-------|-------|
| **L0** | `engine.ts` module extraction (dispatch registry, service-task visit block, compensation pass, incident helpers) | Pure refactor; no behavior change; suite green. |
| **L1** | Failure taxonomy: incident-kind split + hygiene fixes + `retryable`/lease-expiry/poison-budget | No profile change; openapi + contract tests updated. |
| **L2** | Constitution 2.2.0 (full M3 set) + free error routing (validator + engine + tests) | Smallest runtime delta first; profile doc lockstep. |
| **L3** | Boundary timers: `timers` migration + Scheduler DO generalization + fire/race runtime | Exit criteria 1–2. |
| **L4** | Intermediate catch (timer + message) + `eventBasedGateway` | Exit criterion 3; broker wait-target plumbing. |
| **L5** | Docs/quickstart/sample models/`check:docs` finalization; `01-events.md` fix | Round-trip gates for the new samples. |

## 11. Deferred (tracked, not dropped)

- `timeCycle` and non-interrupting boundary timers (need extra tokens) — M4.
- Boundary timers on `transaction`, `signal`/`escalation`/`conditional` events — M5.
- Timer start events — conflicts with the instances-start-via-API invariant; revisit only with a concrete
  need.
- FEEL expressions in timer definitions — replay-safe to add later (`fire_at` snapshot), kept out for
  modeler portability and scope control.
- Per-model broker buffer TTL — YAGNI; also has no canonical home in the model under decision #2.
- Per-occurrence poison budget — deliberately rejected (TASK-35 rationale, §5.3); revisit only when a
  real model needs a fresh budget per loop pass.
- "Fire timer now" operator verb — useful ops tool, not needed for any exit criterion.
