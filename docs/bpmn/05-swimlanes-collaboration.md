# 05 — Swimlanes, Collaboration & Choreography

## Pools and lanes

**Swimlanes** organize *who* does what.

| Element | Shape | XML | Meaning |
|---------|-------|-----|---------|
| **Pool** | large labeled rectangle | `participant` (in a `collaboration`), with `processRef` → a `process` | A **participant** — an organization, system, or role that owns one process. |
| **Lane** | horizontal/vertical subdivision of a pool | `laneSet` → `lane` (with `flowNodeRef` children) | A sub-partition of a pool, usually a role/department/system responsible for the contained nodes. |

Key facts:
- A **pool contains exactly one process.** The pool *is* the boundary of that process.
- **Lanes are organizational only** — they carry no execution semantics. The engine runs the process;
  lanes just say who's responsible. (Camunda 7 can use lanes for user-task assignment, but that's an
  extension, not core semantics.)
- A **collapsed pool** ("black box") hides its internals — you only see message flows touching it. Used
  for external parties whose process you don't model (e.g. "Customer", "Payment Provider").

```text
┌─ Pool: Order Service ────────────────────────────────┐
│ Lane: API     ○──→ [Receive Order] ──→ ...           │
│ Lane: Billing            ──→ [Charge Card] ──→ ●      │
└──────────────────────────────────────────────────────┘
            ╎ (message flow)              ╎
┌─ Pool: Payment Provider (collapsed / black box) ──────┐
└──────────────────────────────────────────────────────┘
```

## Collaboration

A **collaboration** diagram shows **≥2 pools** exchanging **message flows**. XML:

```xml
<bpmn:collaboration id="Collab_1">
  <bpmn:participant id="P_Order" name="Order Service" processRef="Process_Order" />
  <bpmn:participant id="P_Pay"   name="Payment Provider" />            <!-- black box, no processRef -->
  <bpmn:messageFlow id="MF_1" sourceRef="Task_Charge" targetRef="P_Pay" />
</bpmn:collaboration>
<bpmn:process id="Process_Order" isExecutable="true"> ... </bpmn:process>
```

Rules:
- **Message flows** connect nodes/pools *across* participants — never within one pool.
- Each non-collapsed participant references its own `<process>` via `processRef`.
- The orchestration each participant runs internally is an ordinary process diagram (sequence flows).

## Choreography (brief)

A **choreography** diagram models the *message exchange itself* between participants, with **no central
orchestrator**. The boxes are **choreography tasks** (a message exchange between two participants),
banded with the participant names; there are no pools owning the control flow.

- XML: `<choreography>`, `<choreographyTask>`, with `participantRef`s and `messageFlowRef`s.
- Use case: defining a public B2B protocol ("who must send what to whom, in what order") without
  exposing anyone's internal process.
- Rare in practice and unsupported by most execution engines. Mentioned here only for completeness.

> **Orchestration vs choreography:** orchestration = one controller (a process/pool) directs the work;
> choreography = peers agree on a message protocol with no controller. `easy-bpmn` is firmly an
> **orchestration** engine.

---

## `easy-bpmn` scope

**Out of scope for the MVP: pools, lanes, collaboration, message flow, and choreography.**

The MVP models a **single process** (one implicit participant) with no pools or lanes drawn. There is
no multi-pool collaboration and no message-flow modeling — external systems interact with the process
through the **API** (start instance, send message for a Receive Task), not through diagrammed message
flows.

Practically, the parser can accept a bare `<process>` with no surrounding `<collaboration>`. If a
`<collaboration>`, `<participant>`, `laneSet`/`lane`, `messageFlow`, or `<choreography>` is present, it
MUST be rejected before publish with a user-visible reason (constitution, MVP scope section). See
[`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).
