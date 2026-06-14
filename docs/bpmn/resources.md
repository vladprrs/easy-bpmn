# Resources — Specs, References & Open-Source Projects

A curated survey of where to learn BPMN 2.0 and which existing projects `easy-bpmn` can study or reuse.
This is the "did anyone already build this?" scan — and the answer is *yes, a lot*, which is good: we
can stand on `bpmn-moddle` for parsing and on existing engines for semantic ground truth.

## Specifications (authoritative)

| Resource | Link | Notes |
|----------|------|-------|
| **OMG BPMN 2.0.2** | <https://www.omg.org/spec/BPMN/2.0.2/> | The standard. Published 2013; current. The execution-semantics chapters are the source of truth for [`07`](./07-execution-semantics.md). |
| OMG BPMN 2.0 (2.0.0) | <https://www.omg.org/spec/BPMN/2.0/> | Original 2011 release. |
| BPMN XSD schemas | (in the OMG spec download) | The XSDs define the exact XML in [`06`](./06-xml-serialization.md). |
| DMN (decisions) | <https://www.omg.org/spec/DMN/> | Companion standard for business-rule tasks / FEEL. |
| CMMN (cases) | <https://www.omg.org/spec/CMMN/> | Companion standard for case management. |

## Learning references (practical)

| Resource | Link | Notes |
|----------|------|-------|
| **Camunda BPMN reference** | <https://camunda.com/bpmn/reference/> | The best free, example-driven symbol catalog. Basis of the taxonomy in [`01`](./01-events.md)–[`05`](./05-swimlanes-collaboration.md). |
| Camunda BPMN tutorial | <https://camunda.com/bpmn/> | Gentle intro. |
| bpmn.io | <https://bpmn.io/> | Home of `bpmn-js`/`bpmn-moddle`; docs & walkthroughs. |
| Bruce Silver, *BPMN Method and Style* | (book) | The definitive style guide; origin of the "Level 1/2" descriptive/analytic distinction. |
| Dumas et al., *Fundamentals of Business Process Management* | (book) | The standard academic/practitioner text. |
| Camunda *BPMN for research* | <https://github.com/camunda/bpmn-for-research> | A corpus of example diagrams — useful test fixtures. |

## Open-source — JavaScript/TypeScript (most relevant to us)

`easy-bpmn` is JS/TS on Cloudflare, so these are the closest fits.

### Parsing & model
| Project | Link | Why it matters |
|---------|------|----------------|
| **`bpmn-moddle`** | <https://github.com/bpmn-io/bpmn-moddle> | Read/write BPMN 2.0 XML ⇄ typed model, namespace-aware. **Use this for our parser.** |
| `camunda-bpmn-moddle` | <https://github.com/camunda/camunda-bpmn-moddle> | `camunda:` extension descriptors for moddle. |
| `zeebe-bpmn-moddle` | <https://github.com/camunda/zeebe-bpmn-moddle> | `zeebe:` extension descriptors for moddle. |

### Execution engines (semantic references)
| Project | Link | Why it matters |
|---------|------|----------------|
| **`bpmn-engine`** (paed01) | <https://github.com/paed01/bpmn-engine> | Lightweight, event-driven BPMN 2.0 executor in Node. Closest open analog to our runtime; study token/wait-state handling. |
| `bpmn-server` | <https://github.com/bpmn-io/bpmn-server> *(community)* | Persistence + monitoring atop an engine — reference for history/operate shape. |
| `workflow-js` | (npm/github) | Minimal BPMN 2.0 workflow library. |

### Rendering / modeling / validation
| Project | Link | Why it matters |
|---------|------|----------------|
| `bpmn-js` | <https://github.com/bpmn-io/bpmn-js> | The standard renderer/modeler (powers Camunda Modeler). For a future viewer/editor. |
| `bpmn-js-properties-panel` | <https://github.com/bpmn-io/bpmn-js-properties-panel> | Properties UI for a modeler. |
| `bpmnlint` | <https://github.com/bpmn-io/bpmnlint> | Pluggable validation rules — inspiration for our whitelist/structure checks. |
| `bpmn-js-token-simulation` | <https://github.com/bpmn-io/bpmn-js-token-simulation> | Visual token simulator — great for reasoning about [`07`](./07-execution-semantics.md). |
| `bpmn-auto-layout` | <https://github.com/bpmn-io/bpmn-auto-layout> | Generate DI layout for semantic-only BPMN (no diagram). |

### Curated lists
| Project | Link |
|---------|------|
| `bpmn-io/awesome-bpmn-io` | <https://github.com/bpmn-io/awesome-bpmn-io> |
| `hinsencamp/awesome-bpmn` | <https://github.com/hinsencamp/awesome-bpmn> |
| `ungerts/awesome-bpm` | <https://github.com/ungerts/awesome-bpm> |

## Open-source — other languages (semantic ground truth)

| Project | Lang | Link | Why it matters |
|---------|------|------|----------------|
| **Operaton** | Java | <https://operaton.org/> | OSS fork of Camunda 7. The **external-task worker** model maps directly onto `easy-bpmn`'s service-task contract. |
| Camunda 8 (Zeebe) | Java/Go | <https://github.com/camunda/camunda> | Cloud-native engine; job workers; FEEL; the modern reference for scalable durable execution. |
| **SpiffWorkflow** | Python | <https://github.com/sartography/SpiffWorkflow> | Readable pure-Python BPMN engine — cross-language semantic reference. |
| Flowable | Java | <https://github.com/flowable/flowable-engine> | Embeddable BPMN/DMN/CMMN. |
| Activiti | Java | <https://github.com/Activiti/Activiti> | Light-weight BPM engine (Flowable's ancestor). |
| jBPM / Kogito (KIE) | Java | <https://github.com/kiegroup/jbpm> | Red Hat business automation. |
| **Temporal** | Go/poly | <https://github.com/temporalio/temporal> | *Not* BPMN, but the canonical **durable-execution / replay / idempotency** model — directly relevant to constitution III. |
| MontiCore/bpmn | Java | <https://github.com/MontiCore/bpmn> | A textual DSL over BPMN 2.0.2 — interesting for a non-XML authoring path. |

## How this maps to `easy-bpmn`

- **Parse** with `bpmn-moddle` (don't reinvent XML/namespace handling).
- **Validate** with a custom whitelist (inspired by `bpmnlint`) — reject anything outside the
  [profile](./09-easy-bpmn-profile.md).
- **Execute** a tiny subset durably on **one Cloudflare Workflow per process instance** (coordinated by a
  single Durable Object correlation broker; Workflow state is runtime-only, never the inspection source) —
  cross-check semantics against `bpmn-engine` / `SpiffWorkflow`.
- **Service-task contract** modeled on the **external-task / job-worker** pattern (Operaton / Zeebe).
- **Durability/idempotency** philosophy informed by **Temporal**.

> Conclusion of the "existing projects" scan: the parsing and modeling problems are *solved* (reuse
> `bpmn-moddle`); the differentiated work is the **durable, idempotent, correlation-correct executor on
> Cloudflare** and the **strict supported-subset validation** — exactly what the constitution says the
> MVP is about.
