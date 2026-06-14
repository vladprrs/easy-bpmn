# BPMN 2.0 — Local Reference

A working reference for **BPMN 2.0** (Business Process Model and Notation), assembled for the
`easy-bpmn` project. It covers the notation, its **XML serialization** (what our parser must read),
execution semantics, the surrounding engine ecosystem, and — most importantly — **what subset
`easy-bpmn` actually supports**.

> BPMN 2.0 is an [OMG](https://www.omg.org/spec/BPMN/2.0.2/) standard (current published version
> **2.0.2**, 2013). The notation is stable; this reference will not drift with tool releases.

## How to use this

- **Building the parser / validator?** Start with [`06-xml-serialization.md`](./06-xml-serialization.md)
  and [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md).
- **Building the runtime?** See [`07-execution-semantics.md`](./07-execution-semantics.md) and the profile.
- **Need to know if an element is in scope?** Jump to the [scope-at-a-glance](#scope-at-a-glance) table.
- **Forgot what a symbol means?** [`01-events.md`](./01-events.md) → [`05-swimlanes-collaboration.md`](./05-swimlanes-collaboration.md).

## Files

| File | What's in it |
|------|--------------|
| [`00-overview.md`](./00-overview.md) | What BPMN is, the 5 element categories, tokens, conformance/modeling levels |
| [`01-events.md`](./01-events.md) | The full event taxonomy matrix (triggers × positions), interrupting vs non-interrupting, boundary & event subprocess events |
| [`02-activities.md`](./02-activities.md) | The 8 task types, sub-processes, call activity, markers (loop / multi-instance / compensation) |
| [`03-gateways.md`](./03-gateways.md) | Exclusive, parallel, inclusive, event-based, complex — split/join semantics |
| [`04-flows-and-data.md`](./04-flows-and-data.md) | Sequence/conditional/default flow, message flow, association; data objects/stores/IO; messages, signals, errors, escalations |
| [`05-swimlanes-collaboration.md`](./05-swimlanes-collaboration.md) | Pools, lanes, collaboration, message flow, choreography (brief) |
| [`06-xml-serialization.md`](./06-xml-serialization.md) | **The XML format**: namespaces, element→tag map, attributes, event definitions, DI, full annotated example |
| [`07-execution-semantics.md`](./07-execution-semantics.md) | Token semantics, instance lifecycle, gateway behavior, correlation, transactions, error propagation |
| [`08-engines-and-extensions.md`](./08-engines-and-extensions.md) | Camunda 7/8 (Zeebe), Operaton, Flowable; `camunda:`/`zeebe:` extension namespaces; JS ecosystem we can reuse; FEEL |
| [`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md) | **Our supported subset**, validation rules, runtime mapping, valid vs rejected examples |
| [`glossary.md`](./glossary.md) | Terms: token, definition, instance, correlation key, … |
| [`resources.md`](./resources.md) | Specs, books, OSS projects (engines, parsers, modelers) — the "existing projects" survey |

## Scope-at-a-glance

The original M0 happy path was `Start Event → Service Task → Receive Task → End Event`. The
supported subset has since grown through **M1–M4** (transaction-saga + compensation, `exclusiveGateway`
conditionals, timers / message intermediate catch / `eventBasedGateway` / free error routing,
block-structured `parallelGateway` / `inclusiveGateway` concurrency) — see
[`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md) for the **authoritative current scope** (constitution
now v2.3.1).

| Category | In scope (M1–M4) | Out of scope (rejected before publish) |
|----------|------------------|----------------------------------------|
| Events | None Start/End; interrupting boundary/intermediate timers, message intermediate catch, error/cancel/compensation boundary events (M1/M3) | Timer **start** events, non-interrupting boundary timers, `timeCycle`, signal/escalation/conditional events, `intermediateThrowEvent`, link events, terminate end |
| Tasks | **Service Task**, **Receive Task** | User, Send, Script, Manual, Business Rule, abstract Task |
| Gateways | Exclusive (M2), Event-based (M3), block-structured (SESE) Parallel + Inclusive (M4) | Complex |
| Flow | Sequence Flow; conditional + default flow off an `exclusiveGateway`/`inclusiveGateway` (M2/M4) | Conditional/default flow elsewhere, message flow |
| Sub-processes | `transaction` (M1) | Embedded, event, ad-hoc, call activity |
| Other | Message + correlation key, compensation (M1) | Multi-instance, data objects, pools/lanes, process migration |

> The rest of this reference documents **all of BPMN 2.0** so we understand the standard we're a
> subset of — but only the left column above is executable in `easy-bpmn`. Anything else MUST be
> rejected at publish time with a user-visible reason
> ([`09-easy-bpmn-profile.md`](./09-easy-bpmn-profile.md)).

## Sources

- OMG BPMN 2.0.2 specification — <https://www.omg.org/spec/BPMN/2.0.2/>
- Camunda BPMN reference (symbols & examples) — <https://camunda.com/bpmn/reference/>
- `bpmn.io` toolkit & docs — <https://bpmn.io/>

See [`resources.md`](./resources.md) for the full survey of specs, books, and open-source projects.
