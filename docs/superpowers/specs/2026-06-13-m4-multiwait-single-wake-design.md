# M4 multi-wait fix — replay-stable single-wake Workflow drive (TASK-54)

- **Date:** 2026-06-13
- **Status:** Design — empirically validated on real Cloudflare Workflows; awaiting plan
- **Milestone:** M4 (concurrency) — unblocks TASK-53 AC #8/#9, epic closure
- **Supersedes mechanism:** the workflow-mode multi-wait `Promise.race` in
  `src/runtime/frontier.ts` / `src/runtime/engine.ts` (the L6.6 blocking defect)
- **Source-of-truth alignment:** keeps `specs/002-saga-orchestrator/` + constitution intact;
  this is a runtime mechanism change, not a profile/scope change. No new BPMN constructs.

---

## 1. Problem (L6.6, confirmed real)

The M4 workflow-mode multi-wait **hangs on real Cloudflare Workflows** at any AND/OR-join. After the
second branch completes, the surviving branch's `sendEvent` never resumes the suspended Workflow; the
instance is stuck `running` (only the 1-hour `SVC_WAIT_TIMEOUT` is a backstop). Single-token M0–M3 flows
are unaffected because M4 is gated on `graph.regions`. CI cannot see this: vitest runs
`EXECUTION_MODE=direct`, which never calls `step.waitForEvent`.

### Root cause

Cloudflare Workflows re-invokes `run()` from the top on every `sendEvent` (deterministic replay; steps
are cached **by name, not call order**). The token-frontier rewalk (`driveFrontier` → `raceParkedWaits`,
`frontier.ts`) issues **a different *set* of `step.waitForEvent` calls on each re-invocation**: when a
branch's job lands in D1, that branch fast-forwards out of its `waitForEvent` into a write-free `step.do`
apply, so the set of *pending* waits shrinks (inv#1 races `{A,B}`; inv#2 races `{A}`). A `Promise.race`
over multiple concurrent `waitForEvent` whose **membership changes across replays** does not compose with
Cloudflare's one-suspension-point-at-a-time model — the survivor's event is delivered into the instance
but never resumes it.

---

## 2. Empirical findings (measured, not assumed)

A throwaway Workflow probe (`/tmp/cf-wf-probe`, retained as the TASK-54 re-validation harness) was run
**locally under `wrangler dev` and deployed to the real edge** (`cf-wf-probe.vladprsib.workers.dev`,
since torn down). It measured the three facts the design hinges on, plus a faithful reproduction of the
bug and a validation of the fix. Results were **identical on local workerd and real CF**:

| Probe | Mechanism | Real CF result |
|-------|-----------|----------------|
| **B** | shrinking-membership `Promise.race` (today's M4) | **HANGS** — survivor event delivered, instance never progresses (reproduces L6.6 exactly) |
| **C** | single `waitForEvent`, constant type, sequential names `wake#K`, re-walk-from-state | **COMPLETES** |
| **C** | one tickle after multiple completions | re-walk **drains all** in one pass |
| **C** | a **fully lost** wake + bounded timeout | **self-heals to complete** (`timeouts:1` observed on real CF) |

Supporting CF semantics (docs + the probe):
- **Steps cache by name, not order** (Rules of Workflows). Interleaved `step.do` between waits is safe;
  only the *set of pending `waitForEvent`* must be replay-stable.
- **`waitForEvent` timeout throws** (`Error: Execution timed out after Nms`) → must be caught.
- **Events are buffered** before the matching `waitForEvent` is reached, but the buffer window is short and
  not a durability guarantee → a timeout backstop is mandatory ("always set a timeout").
- On the probe, real-CF wakes were sometimes effectively lost (event delivery raced **KV** eventual
  consistency). The real engine reads **D1** (strongly consistent, read-your-writes; the job/message/timer
  result is committed to D1 *before* `sendEvent`), so the tickle path is the fast primary and the timeout
  is a rare backstop — the engine will self-heal *less* often than the KV-backed probe did.

---

## 3. Decision

Replace the workflow-mode per-token multi-wait with a **single replay-stable wake**, and **unify both
execution paths** (single-token and region) onto it.

> **Central insight:** direct mode already works by *re-walk-from-D1 on each external event* — the
> executor re-invokes `runInstance` per `/jobs/complete`, message, or timer fire, and the engine
> reconciles entirely from D1 (that path is green: 413 CI tests). The fix makes **workflow mode behave
> identically**, with one `bpmn_wake` event playing the role the executor's re-invocation plays in direct
> mode. The two modes converge on one mental model; workflow mode merely needs *a* signal to re-enter
> `run()`, and `bpmn_wake` is that signal.

### 3.1 The wake protocol

- **One constant event type** — `bpmn_wake` — for **all** instances. `sendEvent` is instance-scoped, so a
  single global type cannot collide across instances. The wake is a **pure tickle**: "state changed in
  D1, re-walk." Its payload is advisory and ignored; **D1 is the only truth**.
- **The drive loop owns the single wait.** `runInstance` → `loop` runs:
  ```
  let k = 0
  for (;;) {
    const r = await drive(...)                 // scalar OR frontier — leaf drivers PARK, never wait
    if (r.completed)  return settleFrontierCompletion(...)   // or completed
    if (r.incident)   return incident
    if (r.compensate) return settleAfterCompensation(...)
    // r.parked:
    if (!waitFor) return { status: "waiting" }              // DIRECT mode: executor re-drives
    const timeout = wakeBackstop(env, instanceId)           // timer-aware (§3.3)
    try { await waitFor({ name: `bpmn_wake#${k}`, workflowEventType: WAKE_TYPE, timeout }) }
    catch { /* timeout → self-heal: fall through to re-walk */ }
    k++
  }
  ```
- **`k` is the per-`run()` wait counter** (number of `waitForEvent` issued so far this invocation). It is
  replay-stable because the re-walk is deterministic and reads consistent D1, so the number of waits
  before reaching any frontier state is fixed. Distinct names `bpmn_wake#0, #1, …` give distinct
  suspension points (a reused name returns the cached event, not a new suspend); the probe validated
  exactly this sequencing.
- **Leaf drivers park, never wait.** Today `forward-task.ts` (service-task-as-wait), `driveReceiveTask`,
  the EBG/timer catches, and the frontier branch drivers each call `waitFor` with a per-element name and a
  per-type event. Under single-wake they **record the park in D1 (job row / subscription / timer — which
  they already do) and return `parked`**, exactly as they do today when `waitFor === null` (direct mode).
  The outer loop issues the one `bpmn_wake#k`.

### 3.2 Apply-from-D1 (the key behavioural change + main risk)

Because the wake is a contentless tickle, every apply must source its data from **D1**, not from an event
payload:
- **Service task / job:** already read from the `jobs` row (`output`, `output_applied`) — unchanged.
- **Receive task / message catch / EBG message branch:** today the payload is applied from the
  `waitForEvent` result. It must instead be applied from the **matched `messages` row in D1** (the broker
  persists the message before delivery; the subscription→message match is recorded). The atomic
  "apply-payload-with-transition-out-of-wait" invariant is preserved — it just reads the payload from D1.
- **Timer / EBG timer branch:** the `fireTimer` decider already commits the transition to D1 before
  waking; the re-walk reads the `timer_outcomes` decider and routes — unchanged in substance.

`persist-before-advance` already guarantees the data is in D1 before any `sendEvent`, so this is a
re-pointing of the *read*, not a new persistence requirement. **This is the primary regression surface and
the focus of re-validation (§6).**

### 3.3 Timer-aware self-heal timeout

`wakeBackstop(env, instanceId) = min(timeToNearestKnownDeadline, MAX_WAKE_BACKSTOP)`:
- If the instance has a pending timer/EBG-timer, size the wait to its `fire_at` so a 7-day timer stays
  O(1) steps (the existing "timer-sized `waitForEvent` backstop" idea) and the timer fires exactly when
  due.
- Otherwise (waiting only on external jobs/messages, which have no model deadline) use `MAX_WAKE_BACKSTOP`
  — a few minutes — so a genuinely lost wake recovers within that bound.
- Each timeout = one re-walk = step-budget cost; `STEP_BUDGET_SOFT`/`stepBudget` (design §9) is the
  existing circuit breaker. With D1's read-your-writes consistency the timeout is a *rare* backstop, so
  step consumption on normal flows is unaffected.

---

## 4. What changes (file-by-file)

- **`src/runtime/engine.ts`** — `loop` becomes the single-wake loop above for **both** the
  `!graph.regions` scalar path and the region path. The scalar `while` loop's leaf drive and the region
  `driveFrontier` both return park/complete/incident; the wait is issued **only** in `loop`. Remove the
  per-region `raceParkedWaits` call and `matchKeyedEvent` (engine.ts ~488–496).
- **`src/runtime/frontier.ts`** — delete `raceParkedWaits`, `collectingWaitFor`, `WaitCollector`,
  `RaceOutcome`, `matchKeyedEvent`. `driveFrontier` stops collecting waits; a parked branch records its
  park in D1 and the walk reports `parked`.
- **`src/runtime/forward-task.ts`, `driveReceiveTask`, EBG/timer catch drivers** — stop calling `waitFor`;
  park-and-return. Re-point message/EBG apply to read the payload from the matched `messages` row (§3.2).
- **`src/runtime/executor.ts`** — `WorkflowExecutor.deliver`, `deliverJobResult`, `wakeTimer` all
  `sendEvent({ type: WAKE_TYPE, payload: { kind } })` (small advisory envelope). Keep the existing
  `catch → runInstance(waitFor: null)` inline-drive fallback for terminated Workflows (operator
  resume) — that path is already the direct-mode re-walk and needs no change.
- **`src/bpmn/profile.ts`** — `workflowEventTypeFor`, `workflowJobEventTypeFor`,
  `workflowEventGatewayTypeFor`, `workflowTimerEventTypeFor` are no longer needed for delivery. Reduce to
  a single `WAKE_TYPE = "bpmn_wake"` constant; drop the per-type derivations (and the
  `message_subscriptions.workflow_event_type` column usage for delivery — keep the column nullable for
  back-compat or migrate it out; an implementation decision for the plan).
- **`src/workflows/process-workflow.ts`** — unchanged in structure (one `run()`, internal loop).
- **Direct mode (`waitFor: null`)** — untouched. It already parks-and-returns and re-drives per event;
  it is the regression net (413 CI tests + Scenarios 27–30 join logic).

---

## 5. Why this is correct and replay-stable

1. **Exactly one `waitForEvent` pending at a time** — the only shape Probe B/C proved survives on real CF.
2. **Replay-stable step sequence** — `bpmn_wake#k` names depend only on the deterministic re-walk over the
   immutable graph reading consistent D1; steps cache by name, so interleaved `step.do` applies are safe.
3. **No payload matching** — the §5.2 "match-keyed event" / positional-apply concern dissolves: the
   re-walk reconciles every parked token against D1 subscriptions/jobs/timers, applying each exactly once
   via the existing `output_applied` / consumed-subscription / decider idempotency markers.
4. **Hang-proof** — a lost or raced wake is recovered by the bounded timeout → re-walk (Probe c4, observed
   self-healing on real CF). The worst case is bounded latency, never a permanent hang.
5. **Mode convergence** — workflow mode now does what direct mode already does; the green direct-mode join
   logic is the shared core.

---

## 6. Re-validation plan (unification widens the matrix)

Because single-token M0–M3 workflow-mode waits also change, re-validation covers **both** tiers on **real
Cloudflare Workflows** (the manual matrix — CI in direct mode cannot reach the wake path):

- **Single-token regression (new):** the canonical order-saga, a conditional saga, and the two M3 samples
  (timer-saga, event-gateway-saga) each run to completion on real CF — confirming the apply-from-D1
  re-point preserves M1/M2/M3 behaviour (message catch, EBG race, boundary/intermediate timers, free error
  routing).
- **M4 substrate probe:** AND-join (`PARALLEL_BPMN`) completes after both branches in any order on real CF
  — the L6.6 probe goes green.
- **WM-1..WM-6** (`quickstart.md`) pass on real CF with recorded evidence.
- **CI stays green** — 413 direct-mode tests + Scenarios 27–30 unchanged; single-token M0–M3 unchanged in
  direct mode.
- The retained `/tmp/cf-wf-probe` harness (Probe B = bug, Probe C = fix) is the substrate-level regression
  check; the bug (B) must still hang and the fix shape (C) must still complete on any future CF runtime.

Only after the matrix is green on real CF: re-deploy prod, then L6.7 (constitution gate, Backlog closure,
merge `m4-concurrency`).

---

## 7. Risks

- **R-apply-from-D1 (primary):** re-pointing message/EBG payload application from the event to the D1
  `messages` row. Mitigation: the data is already persisted pre-advance; the single-token real-CF
  regression suite (§6) is the gate; the atomic apply-with-transition batch is preserved.
- **R-unification-blast-radius:** the change now touches the proven M1–M3 single-token path, not just M4.
  Mitigation: direct mode (the CI net) is untouched; the real-CF single-token suite re-validates before
  any prod redeploy; prior M3 is one `wrangler rollback` away.
- **R-timeout-budget:** a long external wait re-walks every `MAX_WAKE_BACKSTOP`. Mitigation: timer-aware
  sizing keeps known-deadline waits O(1); `stepBudget` is the existing circuit breaker; D1 consistency
  makes timeouts rare.
- **R-cf-substrate-drift:** a future CF Workflows version could change replay/event semantics. Mitigation:
  the retained probe harness re-measures the truth table in minutes; the matrix is a DoD gate.

---

## 8. Open questions (for the plan / deferred)

- Keep `message_subscriptions.workflow_event_type` as a nullable vestige vs. migrate it out (no behavioural
  effect either way under single-wake).
- Exact `MAX_WAKE_BACKSTOP` value (proposed: a few minutes) — tune against step-budget once the WM matrix
  runs on real CF.
- Whether to also collapse the scalar `!graph.regions` branch into a literal 1-element frontier (full code
  unification) or keep it as a thin parallel branch that shares the one wake loop — a structure choice for
  the plan, not a semantic one.

---

## Appendix A — probe reproduction (retained harness)

`/tmp/cf-wf-probe` — a self-contained Worker with three Workflows (`ProbeA` static race, `ProbeB`
shrinking race = the bug, `ProbeC` single-wake = the fix) + a KV-backed state store and an HTTP driver
(`/create`, `/done`, `/send`, `/status`, `/reset`). Local: `wrangler dev`; real CF: `wrangler deploy`
(needs a KV namespace). Decisive sequences:

- **Bug:** `ProbeB` — create → `/send evB` → `/send evA` → status stays `running` forever.
- **Fix:** `ProbeC` — create → `/done B` + `/send wake` → `/done A` + `/send wake` → `complete{passes:2}`.
- **Self-heal:** `ProbeC` with `to=4 seconds` — create → `/done A` + `/done B` (no `/send`) →
  `complete{passes:1, timeouts:1}` (wake-0 timed out → re-walk → done).
