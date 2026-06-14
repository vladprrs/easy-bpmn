# Operator Console — Visual & UX Design Brief

- **Date:** 2026-06-14
- **Status:** Design brief (shape phase). Companion to, and **distills**, the architecture/IA/contract doc
  [`2026-06-14-operator-console-ui-design.md`](./2026-06-14-operator-console-ui-design.md). That doc owns *what
  endpoints exist*; this brief owns *how it looks, feels, and is navigated*. Where they touch, the architecture doc and
  `specs/002-saga-orchestrator/contracts/` win on contract; this brief wins on visual/UX direction — **including the
  information architecture, which this brief deliberately flattens (see §4).**
- **Produced by:** `/impeccable shape` discovery interview (2026-06-14). Locked decisions in §0.
- **Hands off to:** `/impeccable craft` (or `/impeccable`) for implementation against the shipped SPA in `spa/`.
- **Scope:** an elevation of the *already-shipped* console (`spa/`). Keeps the React/Vite/Tailwind/bpmn-js stack, the
  read-only invariant, the endpoints, the token architecture (`spa/src/styles/tokens.css`), the teal brand, and the
  load-bearing BPMN category palette. It changes the **aesthetic, typography, hierarchy, spatial rhythm, motion, the
  narrative framing, and the navigation model.**

---

## 0. Locked decisions (from the discovery interview)

| Decision | Choice | Consequence for this brief |
|---|---|---|
| **Aesthetic ambition** | **Awwwards-caliber, "sexy", distinctly modern** | The bar is *distinctive and memorable*. |
| **Theme** | **Light only** (firm; the recent `dark→light` re-skin was deliberate) | Win cinematic-on-**light**, never the neon-glow-on-dark cliché. *Luminous, not radioactive.* |
| **Direction** | **B — "Living Systems"** (flow-as-hero, cinematic) — chosen over the safer editorial "A" | The **diagram is the hero**: the saga rendered as flowing current through a luminous process. Motion is first-class. |
| **Information architecture** | **Diagram-first single screen — the "Process Stage."** No Projects/Sagas/transaction-list landing screens. | *(2026-06-14 follow-up.)* The console opens **directly** onto a process's living diagram; switching process, dropping into an instance, and finding a transaction are **controls** (incl. a ⌘K palette), not screens. This §4 supersedes the architecture doc's 3-level nav for UX. |
| **Typography** | **A distinctive display/UI/mono trio** (replace system SF/Segoe) | Crisp data/label layer under a moving hero. See §3.2. |
| **North star (confirmed)** | **Health is the hero.** "Everything works; if it doesn't, that's a product problem. Show it's OK and tell the story of *what* works and *how* — maximally simply." | Emotional center is a **working saga, watched as living flow.** Triage stays fast — no longer the mood. **Simplicity is a hard constraint.** |

**The synthesis:** an **immersive, light, living view of your system at work** — the console opens straight onto a process's
luminous diagram, where *healthy throughput is something you watch happen.* Award-worthy through **one breathtaking living hero
on a calm field** — cinematic, never busy. Base = **B (the living stage)**; it inherits **A's voice** (humanized plain-language
narration) as the words over the flow. *The flow is the stage; the narration is the voice; health is the hero — and the stage is
the whole app:* no landing screens, no transaction lists to wade through (§4).

**The central tension, resolved up front:** "cinematic / motion-forward / single-screen" vs. "maximally simple." Resolution —
**simplicity of structure and information; richness reserved for the single focal flow.** One hero, calm everywhere else; one
screen, controls not screens. If motion (or a screen, or a list) appears where it isn't the flow or a direct control, it's wrong.

---

## 1. Feature summary

A read-only operator console for `easy-bpmn`, used by a single technical operator (platform engineer/developer) to watch,
understand, and — when needed — steer distributed sagas across their microservices. Today it is competent, generic, and spread
across a Projects→Sagas→Instance drill-down. This brief re-frames it as a single place where you **watch your distributed system
breathe**: the console opens directly onto a process's living diagram, each transaction's journey rendered as luminous current, so
that "my system is working" is something you *see and feel* — not infer from green counters across three screens.

## 2. Primary user action

> **Watch a saga flow through its process — see what happened, what's happening, and that it worked — and act (`cancel`/`retry`)
> with full confidence on the rare occasions it didn't.**

The living diagram is the surface that answers this — and it is the **first and only screen**; the console opens straight onto it
(§4). Tables, tabs, JSON, attempts are *depth behind* it, surfaced on demand. If a pixel doesn't help the operator *watch the flow*
or *act with confidence*, it is competing with the hero and should recede.

---

## 3. Design direction

### 3.1 The concept — "Living Systems"

The **BPMN diagram is the hero**, near-full-bleed on the existing pale dot-grid field, and it is **alive**: tokens travel through
it as soft luminous current; the traversed path illuminates as the saga progresses; the live frontier breathes; on success the
circuit completes and settles into a calm, finished glow. You don't *read about* the saga — you *watch it run* (live via SSE) and
can *scrub it back* to replay. This is the literal embodiment of the north star: **"show me my system working."**

Because the theme is **light**, the cinematic quality comes from **luminosity on a pale field**, not glow-on-dark — the feeling of
*light moving through frosted glass* or *current flowing across paper*: soft, purposeful, precise. The teal brand (`#109b86`)
becomes the **color of live current** — its signature meaning. This deliberately avoids the AI cliché ("dark mode with glowing
accents"): the luminance is *functional* (it shows liveness) and *restrained* (soft, never neon), on a light canvas.

### 3.2 Typography — crisp data under a moving hero

Per the impeccable font procedure (no reflex/banned faces; pair a distinctive display with a refined body; real mono for data).
Brand words: **alive · precise · modern-confident.** Working trio — all **free, self-hostable, subsettable**, none banned,
lazy-loaded:

- **Display — `Clash Display`** (Fontshare): confident, contemporary. Carries the hero moments the flow doesn't — the process/
  instance headline, big duration/throughput numbers, the affirmative health line.
- **UI / body — `General Sans`** (Fontshare; designed to pair with Clash): clean, legible dense, good tabular numerics. Tables,
  labels, controls, running text. (`Switzer` alt.)
- **Data / mono — `Commit Mono`** (free, OFL; `JetBrains Mono` fallback): IDs, correlation keys, timestamps, JSON, payloads,
  element ids, and the diagram's technical labels. A deliberate texture confined to genuine machine data.

> Committed working selection, not a mandate — finalize with live previews in `craft`. Non-negotiables: (a) leave the system stack
> behind; (b) display ≠ body; (c) a real mono for the data layer. 5-step fixed `rem` scale, ≥1.25 ratio, fewer-bigger-contrast;
> all-caps only for the existing `.tech-label` micro-labels.

### 3.3 Color, light & the current

Keep the `tokens.css` architecture. Refinements:

- **Live current = teal (brand).** Tokens and the illuminating path glow soft teal while active; on completion the path settles to
  semantic completed-green; a stalled/failed path interrupts in coral. **Node runtime-state outlines keep their existing semantic
  colors** (running-blue / completed-green / error-coral). Clean separation: *current (edges/tokens) = brand-teal liveness; node
  state = semantic.* The current is a **motion overlay on edges**, so it does **not** fight the **frozen BPMN category palette**
  (node fills/borders) — an explicit interview anti-goal, respected by construction.
- **Status color is rare and meaningful** (60-30-10 by weight): calm neutral + teal current is the default mood; settle-green,
  warn-amber, danger-coral appear only with meaning. On light, one confident green and one precise coral out-read a wall of chips —
  *that* is "show it's OK": health is the quiet luminous default, trouble is sharp rare punctuation.
- Push the neutral ramp a hair toward teal (chroma ~0.005–0.01); migrate *new* accent/state work to **OKLCH** (pragmatic, not a
  full ramp rewrite). Keep the pale dot-grid canvas as the "field" the current crosses.

### 3.4 The signature — the living flow (the one memorable thing)

**Tokens as traveling light through a luminous process, the path drawing itself as the saga runs, completing into a settled
healthy circuit — and a timeline ribbon beneath that scrubs the saga's life to replay.** Useful, not just pretty (traversed path,
token frontier, failed element, gateway decisions are already in the data), which keeps it credible. It extends primitives the
shipped `index.css` already has (`ebpmn-stroke-pulse`, `ebpmn-march`, the `ebpmn-traversed/current/failed` markers applied by
`BpmnViewer`) — an *extension of an existing motion seam*, not a new engine.

---

## 4. Information architecture & layout — the single "Process Stage"

**The console is one screen.** It opens directly onto a process's living diagram. There is no Projects landing, no Sagas list, no
transaction-list landing page. Navigation is **controls on the stage, not screens.** This is the operator's directive and the
purest expression of "one living hero / maximally simple." The architecture doc's three-level Project ▸ Saga ▸ Instance *nav* is
superseded here (its *endpoints* are kept — they now feed controls instead of screens, so backend risk is low).

**The Stage carries exactly these elements, and nothing else competes with the hero:**

1. **The hero — the living process diagram**, near-full-bleed on the dot-grid field. On load the stage **auto-selects the most
   relevant instance** (most-recent in-flight, else most-recent overall) and flows it live (§3.4) — *alive on first paint, no empty
   model.* A clear toggle switches to **aggregate mode** (the whole process at once — see "two modes" below).
2. **Process switcher** (top-left): the current process name in display type; click → switch process. Doubles as the only
   breadcrumb the operator needs ("Order Fulfillment ▸ #A1F3"). Backed by `GET /sagas`.
3. **Process statistics** (unobtrusive — a slim rail / inline under the name): status counts for *this* process (running /
   completed / incident / …) from existing `GET /sagas` rollups; the affirmative "all flows nominal" when clean. Clicking a stat
   (e.g. "3 incidents") filters the instance switcher to those.
4. **Instance switcher** (drop into a specific run): a compact control showing the current instance + a picker. Picking renders
   that instance's living flow on the same stage. Backed by `GET /instances?sagaId=&status=&search=`.
5. **Command palette (⌘K) — the universal navigator** *(the key enabler that makes "no lists" work).* One input to: switch process,
   **find an instance by business/correlation key** (`GET /instances?search=`), jump to an attention item, or open a secondary
   surface (Messages, Versions). It replaces every routing list/landing with a single fast modern control — finding is *instant*,
   so a browse-list is never needed.
6. **Global attention indicator** (top chrome, cross-process): a count + popover of what needs attention across *all* processes
   (`GET /attention`), each item deep-linking to its process+instance on the stage. Cross-process triage as a **popover, not a
   screen** — present for on-call, never the mood.
7. **Depth = progressive disclosure on the same stage:** the **narration ribbon/scrubber** beneath the diagram (the humanized
   timeline — *A's voice inside B's stage*), and a **drawer** for Variables / Worker Attempts / raw JSON / Timers-Tokens /
   Waiting-on / Saga ledger / Messages / Versions. Nothing competes with the hero; everything is one calm reveal away.

**Two modes of one stage:**
- **Single-instance mode** (default on load; also the deep-link target): the full cinematic living flow of one run.
- **Aggregate mode** (process-wide): a **calm living heatmap** — node badges = how many instances sit at each element now, edge
  intensity = throughput, a hot coral node = where instances are failing. Answers *"where is work stuck across all my orders"* at a
  glance. This is the **one genuinely-new read** (per-node instance density — a D1 aggregation; call it `GET /sagas/{id}/heatmap`
  or fold into `GET /sagas/{id}`). **Committed for v1** (operator decision 2026-06-14): the per-node living heatmap ships in v1 — it is what makes
  aggregate mode truly *alive*, and the operator explicitly chose it over the status-counts-only fallback.

**What collapses, and where it goes (all endpoints still used):**
- Projects landing → workspace is ambient (set at login); multi-workspace via the palette. *No screen.*
- Sagas list → the process switcher + palette. *No screen.*
- Instance-list landing → the instance switcher + palette search. *No screen.*
- Attention screen → the global attention popover. *No screen.*
- Messages / Versions → secondary surfaces opened from the palette / drawer. *No landing.*

**Permalinks (serve the alert-deep-link / G8 job):** `/console/p/{sagaId}/i/{instanceId}` opens the stage with process+instance
preset; `/console/p/{sagaId}` opens the aggregate. **Chrome is a slim top bar** — process switcher · stats · attention · ⌘K · live
indicator — and the diagram commands the rest. Whitespace + dot-grid field = calm. This is the "single immersive surface" feel
(a beautiful flow tool), which is both maximally simple and very Awwwards. Use the 4pt scale (present), `gap` over margins, varied
rhythm, container queries; density lives only where it earns its keep (the data drawer, in the mono layer) — *calm by default,
dense on demand.*

## 5. Key states

Affirmative-first per the north star — the healthy flow is the headline, trouble is sharp punctuation.

| State | What the operator needs to see/feel | Direction |
|---|---|---|
| **Stage on load (alive)** | "My system is working — right now." | Auto-selected most-relevant instance flows live on the process diagram; stats read "nominal". Sexy on first paint. |
| **Aggregate mode (process-wide)** | "Where is everything, across all runs?" | Calm living heatmap: per-node instance density + edge throughput; hot coral node = where runs fail. **In v1** (the one new D1 aggregation). |
| **Single saga completing (success)** | The satisfying finish. | The circuit completes and settles into a calm finished glow; green used once. |
| **In flight (live)** | The flow happening now. | Tokens travel (SSE); the path illuminates; the frontier breathes. |
| **Empty — no processes yet** | Teach, don't apologize. | A calm idle field on the stage: "a process appears here once a definition is published / your services start sagas." |
| **Process with no runs yet** | Model is real, just idle. | The static model rendered alive-idle (gentle), "no runs yet" — never a blank hero. |
| **Loading** | No jank, no layout shift. | The diagram area reserves space; quiet field skeleton; the ribbon skeletons to final rhythm. |
| **Incident (needs attention)** | *Which* node, *why*, *what next*. | A node that won't light / a path stalls coral; a precise unpanicked callout ("Payment authorization failed — retryable; worker 503") + reverse-pass preview before Cancel. |
| **`compensationFailed` (stuck)** | "This needs me; one safe move." | The flow visibly ran *backward* and stalled; a calm Resume-only banner (no false "final cancel" — would 409 per guard-rails). |
| **Acting (cancel/retry)** | Trust the consequence. | The reverse-pass preview can *show the reverse flow* (which nodes compensate) **before** the click — MoT-3 closed in the flow's own language. Optimistic status; reconcile from the stream. |
| **Reduced motion** | Identical info, no animation. | **Load-bearing:** render the *final illuminated path statically* (traversed/current/failed as static states, no traveling light). The cinematic layer is enhancement; the legible static diagram is the floor. |
| **Degraded diagram (`/bpmn` or ELK fails)** | The story still reads. | Fall back to the narration ribbon / element list — the diagram *is* the hero, so the textual narration is the resilient floor; never a blank screen. |
| **SSE reconnecting** | "Still live." | A quiet "reconnecting…" affordance; never a modal; poll fallback invisible. |
| **Large payload / long history** | Don't choke; stay honest. | "Large payload stored externally" placeholder; virtualized ribbon; lazy per-row humanization. |

## 6. Interaction model

- **The command palette (⌘K) is the universal navigator** — switch process, find a transaction by key, jump to an attention item,
  open a secondary surface. It is what lets the IA stay screen-free; it must be fast, fuzzy, and keyboard-first.
- **Watch + scrub is the signature interaction.** The timeline ribbon is a scrubber; scrubbing replays the flow to any moment. The
  element↔event link becomes *"scrub to this moment / click a node to jump the ribbon there"* — scrubbing a story, not filtering a
  log.
- **Progressive disclosure is the simplicity engine.** Default = the living flow + stats + switchers. Variables diff, worker
  attempts, raw JSON, timers/tokens reveal on demand in the drawer. Start simple; depth earned by a click.
- **Confidence for the rare destructive moment.** `cancel`/`retry` show the consequence first — the reverse-pass preview, ideally
  *animated as the reverse flow*. Mirror the server guard-rails in the UI but treat the server as authoritative (409 → "state
  changed, refresh", never a wrong action).
- **Motion = the living flow + functional feedback only.** The flow (token travel, path illumination, settle, reverse-preview) is
  the *only* expressive motion. `transform`/`opacity` only; ease-out-quart/expo; **no bounce/elastic**; all gated on
  `prefers-reduced-motion`. **Stays credible (mitigates B's "can read less serious" risk):** motion reads as *current/throughput*
  (precise, purposeful), never playful; reduced-motion gives a fully serious static view.
- **Performant by construction.** Animate along edge paths (SVG `getPointAtLength` / CSS `offset-path`), GPU-friendly transforms,
  60fps; **pause when hidden or the SSE tail is idle**; cap concurrent animated tokens (engine caps the frontier at 256 — mirror a
  sane visual cap; in aggregate mode prefer heat over per-token animation). Detailed technique is a plan-time study (§10).

## 7. Content requirements

- **Voice = confident, plain, narrative.** "Tell the story of what works and how, simply" lives in the humanization layer
  (`spa/src/lib/humanize.ts`, already mapping all ~52 engine events to plain language). Today's titles are terse/technical
  ("*Service-task job created*"). Warm them into a journal voice — concise, human — keeping the **deterministic fallback** for
  unmapped/future types (a new engine event must never regress to raw jargon). The "every emitted type maps" unit test stays green.
- **Headlines:** the process and each instance earn a one-line humanized headline (process name + health; instance business key +
  outcome + duration + service span where available) — the display-type moment.
- **Affirmative microcopy:** lead with proof-of-working ("*all flows nominal*"), not red counters; reserve alarm language for real
  `incident`/`compensationFailed`.
- **Empty/error/incident copy:** teach and direct; never dead-ends; never restate the heading. Every word earns its place.

## 8. Recommended references (for `craft`)

1. **`reference/motion-design.md`** — the living-flow hero + reduced-motion discipline (highest-stakes craft surface).
2. **`reference/typography.md`** — the trio; web-font loading, subsetting, scales.
3. **`reference/spatial-design.md`** — the single-stage layout, the slim chrome, the ribbon, container queries.
4. **`reference/interaction-design.md`** — the ⌘K palette, scrub interaction, progressive disclosure, cancel/retry confidence.
5. **`reference/color-and-contrast.md`** — luminous-on-light, teal-current, OKLCH tinting, 60-30-10 by weight.
6. **`reference/ux-writing.md`** — warming the humanization voice; affirmative/empty/incident copy.

## 9. Reconcile with the shipped system (keep / elevate / replace)

- **Keep:** read-only invariant; React/Vite/Tailwind/bpmn-js stack; **all endpoints & SSE** (now feeding controls, not screens);
  `tokens.css` architecture; teal brand; **BPMN category palette + node runtime-state markers** (frozen — load-bearing);
  status-tone semantics. Use `.glass` *sparingly* (slim floating chrome only; never decoratively; never on diagram nodes).
- **Elevate:** typography (system → trio); the diagram from static-overlay → **living hero** (the main build: token travel + path
  illumination + settle + reverse-preview, extending the existing `ebpmn-*` keyframes/markers); **the IA → a single Process Stage**
  (process/instance switchers + ⌘K palette + attention popover + drawer); the humanized timeline (side feed → spoken narration over
  the flow); color discipline (current = teal, status rare).
- **Replace:** the **Projects/Sagas/Attention/Messages screens** → controls/popovers/palette on the single stage (the
  `StatTile`/`HealthBar` hero-metric template in `Projects.tsx` goes entirely — the affirmative health line + stats rail replaces
  it). Re-voice the humanization titles toward narration.
- **IA divergence note (governance):** this brief's §4 supersedes the architecture doc's §6 nav for UX. The collapse reuses
  existing endpoints; the **aggregate living heatmap is in v1** — a *new read/aggregation* that must be added to
  `openapi.yaml` + `runtime-contracts.md` in lockstep with contract/integration tests, and `npm run check:docs` kept green (per the
  governance gate). The architecture doc §6/§9/§12 should be reconciled to "single Process Stage" when this brief is accepted.
- **Hold the impeccable bans regardless of "sexy/cinematic":** no side-stripe (`border-left/right > 1px`) accents; no gradient
  text; no glassmorphism-everywhere; no neon-glow-on-dark (we're light, current is soft+functional); no identical card-grid soup;
  no pure `#000`/`#fff`; don't center everything; no bounce/elastic. *Cinematic here = one luminous hero on a calm field.*

## 10. Open questions (resolve in `craft` / plan-time)

1. **Aggregate "living heatmap" — DECIDED: in v1.** Remaining: endpoint shape (`GET /sagas/{id}/heatmap` vs folded into
   `GET /sagas/{id}`), the query (instances grouped by `current_element_id` + edge throughput), index/perf, and high-instance-count
   degradation (heat, not N tokens). Ships with contract/integration tests + openapi/`check:docs`.
2. **Auto-select policy** — which instance the stage flows on load (most-recent in-flight → else most-recent overall? per-process
   memory of "last viewed"?). Defines "alive on first paint".
3. **Living-flow technique & performance (highest stakes).** Token rendering + path illumination along ELK-routed edges
   (`getPointAtLength` vs `offset-path` vs canvas overlay); 60fps on large diagrams; pause-when-hidden/idle; visual token cap; the
   **reduced-motion static fallback** (load-bearing); how aggregate mode renders at high instance counts (heat, not N tokens).
4. **Command-palette scope** — exactly which actions/searches it covers v1 (process switch + instance search at minimum;
   attention/messages/versions as reach).
5. **Cross-process attention** — popover only, or a minimal "everything on fire" overlay reachable from ⌘K? (Default: popover.)
6. **Font trio finalization** — confirm `Clash Display`/`General Sans`/`Commit Mono` with live previews + measured subset weight +
   self-hosting/licensing. (Working selection committed; swap is cheap.)
7. **Headline data** — does `GET /instances{,/id}`/`/sagas` carry enough for the headlines (duration, service span, process
   health)? If not, a read-only aggregation question for the architecture doc.
8. **Humanization re-voicing** — in-scope this pass (recommended — it *is* the "tell the story" deliverable; the test guards
   coverage) or a follow-up?
9. **Output of this brief** — companion file (non-destructive). Inline into the architecture doc instead, if preferred.
