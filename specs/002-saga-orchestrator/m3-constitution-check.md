# M3 Constitution Check (pre-implementation, against constitution v2.2.0)

**Milestone**: M3 — Time & Failure Taxonomy (timers, `eventBasedGateway`, free error routing, incident taxonomy)
**Recorded**: 2026-06-11 (M3-L2 governance opener, TASK-41)
**Constitution version checked against**: **v2.2.0** (this amendment — Principle I widened with the M3 set)
**Spec source**: [`docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md`](../../docs/superpowers/specs/2026-06-11-m3-time-failure-taxonomy-design.md)
(approved brainstorming-design output, hardened by a 4-lens adversarial review; the M3 source artifact for
the amendment, the specs/002 deltas, and the Backlog TASK-26 epic slicing).

This record satisfies the Development-Workflow gate ("Plans MUST pass the Constitution Check before Phase 0
research and again after Phase 1 design") for M3. The project's operating mode since M2 is
brainstorming-design → backlog slicing rather than a full Spec Kit `plan.md`; the design doc above **is**
the spec/plan source for M3 (the deviation from `plan.md:7` is recorded in the design doc §8, Complexity-
Tracking style, not laundered as precedent). Both gate checks are mapped onto that flow below.

## Two required gate checks (mapped onto the M3 brainstorming-design flow)

- **Before Phase 0 (design intake):** the M3 scope — the full construct set tagged "M3" in the codebase
  plus the parked failure-taxonomy debt — was checked against constitution **v2.1.0** at intake. Result:
  the *runtime* layers L0/L1 are constitution-neutral (no profile change) and pass against v2.1.0; the
  *profile-widening* layers L2–L5 require an amendment **first** (Principle I's "amend the constitution
  before widening the profile" ordering). That requirement is what this L2 governance task discharges.
- **After Phase 1 (design hardening → this amendment):** re-checked against the amended **v2.2.0**. The
  amended Principle I now lists the M3 set as accepted; the design's per-layer validator opening (each
  construct rejected with `M3 — not yet implemented` until its layer ships) is the **documented interim
  state** (constitution Principle I note + `docs/bpmn/09-easy-bpmn-profile.md`), not a violation. Result:
  **PASS** — no entry required in Complexity Tracking for the profile widening itself.

## Per-principle confirmation for the M3 set

- **I. Standard BPMN Profile Only — PASS.** Every M3 construct is standard BPMN 2.0: interrupting boundary
  `timerEventDefinition` on a `serviceTask`/`receiveTask`, timer/message `intermediateCatchEvent`,
  `eventBasedGateway`, and free error-boundary routing. The only additive binding stays
  `easy-bpmn:taskDefinition` (no new construct introduces notation). Timer triggers are static ISO-8601
  `timeDate`/`timeDuration` literals — no FEEL-in-timer, no custom attribute required to parse — so files
  stay XSD-valid and round-trip through bpmn-js/Camunda Modeler when `easy-bpmn` + DI are ignored
  (design §3, §4; round-trip gate R4/§7). Unsupported standard-namespace flow nodes (timer **start**
  events, non-interrupting boundary timers, `timeCycle`, `signal`/`escalation`/`conditional`, EBG
  `instantiate`/`Parallel`) are rejected pre-publish with element id + reason.
- **II. Immutable Definitions / Version-Bound Instances — PASS / N/A.** M3 adds no migration path and no
  version mutation; timer/EBG runtime binds to the same immutable published version for an instance's life
  (design §4). No change to the versioning contract.
- **III. Durable, Idempotent Execution — PASS.** Arming is persist-before-advance in the same `dbBatch` as
  the guarded wait; `timers`/`timer_outcomes`/`gateway_decisions` are the canonical D1 record. Every race
  has exactly one deciding row claimed by a plain `INSERT` composed into the transition batch, so a
  duplicate fire, a late worker callback, or a replay converts to the recorded outcome (stable no-op ack) —
  at-least-once safe in both execution modes (design §4.3–§4.5, decisions #4–#6).
- **IV. Correlation and Receive Task Integrity — PASS.** The message `intermediateCatchEvent` reuses the
  Receive Task's subscription/correlation machinery (message name + correlation key supplied at start; the
  `<message>` element carries only its name); EBG message branches must reference **distinct** messages so
  the at-most-one-active-subscription-per-broker-key invariant holds; losing branches are superseded with
  the stable buffered/no-match outcome (design §3, §4.5).
- **V. Auditability and Operator Clarity — PASS.** New history markers `timerArmed`/`timerFired`/
  `timerCancelled`/`ebgDecision`; `GET /instances/{id}` gains a D1-read `timers` block and the open-incident
  list (Workflow internals stay hidden). The failure taxonomy splits the overloaded `timeout` into
  `jobActivationTimeout` + `waitTimeout` and adds `conditionFailure`; every rejection/incident states what
  happened, which element, and the operator's next action (design §5, §6).
- **VI. SAGA / Compensation Integrity — PASS (untouched).** A fired model timer is a **modeled path**, not
  an auto-compensation trigger; an interrupting boundary timer is **never** attachable to a `transaction`
  (BPMN §10.5.5 — only Cancellation auto-compensates, so an interrupting timer there would terminate the
  scope without compensation: explicitly rejected to avoid silent rollback loss). The canonical
  "saga timeout → compensate" shape stays a boundary timer on a task *inside* the transaction routing to a
  **cancel end event** → standard reverse-order compensation. Free error routing leaves the saga ledger
  intact (completed steps remain compensatable on a later cancel). Compensation order, idempotency, and the
  `compensationFailed` terminal outcome are unchanged (design §2 decision #2/#6, §3, §4.3).

## M2 procedural deviation this check closes

M2 widened Principle I **after** the validator had already opened the conditional constructs, **never
touched `spec.md`/`plan.md`** (both remain M1-only — `plan.md:7` still reads "M2–M5 each require their own
constitution amendment and plan"), and **recorded no Constitution Check**. The actual M2 artifact set was
`data-model.md` + `quickstart.md` + both contracts files (commit `a1a9aa5`); the amendment trailed the
runtime instead of leading it.

M3 closes that gap deliberately:

1. **Amend-first ordering.** Constitution 2.1.0 → **2.2.0** lands as the *opening* item of L2, before any
   M3 construct's runtime ships (Principle-I-compliant), with the full amendment procedure required by
   `constitution.md` Governance (updated constitution + Sync Impact Report enumerating every changed file +
   semver reasoning + reviewed Spec Kit templates + the CLAUDE.md lockstep line + this task referencing the
   constitution-impacting file set).
2. **Recorded Constitution Check.** This file is that record — the artifact M2 omitted.
3. **Honest precedent, not laundered.** A full M3 Spec Kit `plan.md` is intentionally not produced; the
   design doc is the spec source, and the deviation from `plan.md:7` is recorded (design §8) rather than
   presented as established practice. The specs/002 M3 `data-model`/`contracts`/`quickstart` deltas are
   owed by the L1/L5 tasks (TASK-26 epic AC#1).
