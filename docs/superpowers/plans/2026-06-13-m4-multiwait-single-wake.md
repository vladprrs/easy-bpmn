# M4 Multi-Wait Fix — Single-Wake Workflow Drive (TASK-54) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workflow-mode multi-`waitForEvent` `Promise.race` (the L6.6 hang) with a single replay-stable `bpmn_wake`, unifying both execution paths onto the green direct-mode "re-walk-from-D1 on each event" model.

**Architecture:** In workflow mode the engine issues exactly **one** `step.waitForEvent` per parked pass on a constant event type `bpmn_wake` (distinct sequential step names `wake#k`), with a timer-aware self-heal timeout. Every `/jobs/complete`, message correlation, and timer fire `sendEvent`s a contentless `bpmn_wake` tickle; the engine re-walks and reconciles entirely from D1. The single behavioural addition is **apply-from-D1** for messages (jobs/timers already re-read D1). Direct mode (the 413-test CI net) is untouched.

**Tech Stack:** TypeScript, Cloudflare Workers + Workflows + D1 + Durable Objects, Vitest (`@cloudflare/vitest-pool-workers`, `EXECUTION_MODE=direct`). Design doc: `docs/superpowers/specs/2026-06-13-m4-multiwait-single-wake-design.md`. Empirical probe harness retained at `/tmp/cf-wf-probe` (ProbeB=bug, ProbeC=fix).

**CI reachability note:** CI runs `EXECUTION_MODE=direct`, which never calls `step.waitForEvent`. Therefore Tasks 1–6 (queries, helper, apply-from-D1) are fully TDD-covered in CI; Tasks 7–9 (the single-wake loop, executor tickle, dead-code removal) are **structure changes whose runtime behaviour is validated by the real-CF matrix in Task 10**, with CI proving only that direct mode stays byte-identical. This split is intentional and is the entire reason L6.6 existed.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/persistence/timers.ts` | timer rows | **Add** `getEarliestArmedTimerForInstance` |
| `src/persistence/messages.ts` | external messages | **Add** `getCorrelatedMessageForSubscription` |
| `src/runtime/wake.ts` (new) | single-wake constants + backstop | **Create** `WAKE_TYPE`, `MAX_WAKE_BACKSTOP`, `wakeBackstop()` |
| `src/runtime/engine.ts` | walk/dispatch core | apply-from-D1 in `driveReceiveTask`; `driveLeaf` always-park; single-wake `loop` |
| `src/runtime/event-gateway.ts` | EBG | apply-from-D1 for the message branch; park-not-suspend |
| `src/runtime/frontier.ts` | token DFS | delete race machinery; `driveFrontier` no collector |
| `src/runtime/forward-task.ts`, `compensation.ts`, `intermediate-timer.ts` | leaf waits | park-not-suspend (drop `waitFor` suspend) |
| `src/runtime/executor.ts` | exec seam | `WorkflowExecutor` sends `WAKE_TYPE` tickle |
| `src/bpmn/profile.ts` | event types | delete the 4 per-type fns |
| `tests/integration/*` | tests | apply-from-D1 (direct), backstop unit, regression |

---

## Task 1: `getEarliestArmedTimerForInstance` query

**Files:**
- Modify: `src/persistence/timers.ts`
- Test: `tests/unit/timers-earliest.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/timers-earliest.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { insertTimerArmedStmt, getEarliestArmedTimerForInstance } from "../../src/persistence/timers";

describe("getEarliestArmedTimerForInstance", () => {
  it("returns the earliest-firing armed timer, ignoring fired/cancelled and other instances", async () => {
    const now = "2026-06-13T00:00:00.000Z";
    await env.DB.batch([
      insertTimerArmedStmt(env.DB, { timerId: "i1:a#0", instanceId: "i1", elementId: "a", occurrence: 0, kind: "boundary", attachedToRef: "h", fireAt: "2026-06-13T01:00:00.000Z", now }),
      insertTimerArmedStmt(env.DB, { timerId: "i1:b#0", instanceId: "i1", elementId: "b", occurrence: 0, kind: "boundary", attachedToRef: "h", fireAt: "2026-06-13T00:30:00.000Z", now }),
      insertTimerArmedStmt(env.DB, { timerId: "i2:c#0", instanceId: "i2", elementId: "c", occurrence: 0, kind: "boundary", attachedToRef: "h", fireAt: "2026-06-13T00:10:00.000Z", now }),
    ]);
    const t = await getEarliestArmedTimerForInstance(env.DB, "i1");
    expect(t?.fireAt).toBe("2026-06-13T00:30:00.000Z");
    expect(await getEarliestArmedTimerForInstance(env.DB, "no-such")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/timers-earliest.test.ts`
Expected: FAIL — `getEarliestArmedTimerForInstance` is not exported.

- [ ] **Step 3: Add the query**

Append to `src/persistence/timers.ts` (next to `listTimersForInstance`):

```typescript
/** The earliest-firing ARMED timer for an instance (the single-wake backstop, TASK-54), or null. */
export async function getEarliestArmedTimerForInstance(db: D1Database, instanceId: string): Promise<TimerView | null> {
  const row = await dbFirst<TimerRow>(
    db,
    `SELECT * FROM timers WHERE instance_id = ? AND status = 'armed' ORDER BY fire_at ASC LIMIT 1`,
    [instanceId],
  );
  return row ? mapTimer(row) : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/timers-earliest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/persistence/timers.ts tests/unit/timers-earliest.test.ts
git commit -m "feat(m4): earliest-armed-timer query for the single-wake backstop (TASK-54)"
```

---

## Task 2: `wake.ts` — constants + `wakeBackstop`

**Files:**
- Create: `src/runtime/wake.ts`
- Test: `tests/unit/wake-backstop.test.ts` (create)

The backstop = `min(timeToNearestArmedTimer + slack, MAX_WAKE_BACKSTOP)`; no timer ⇒ `MAX_WAKE_BACKSTOP`. `MAX_WAKE_BACKSTOP` defaults to `SVC_WAIT_TIMEOUT` ("1 hour") — a rare backstop, since D1's read-your-writes consistency makes the tickle the reliable primary path (design §2/§3.3). This keeps long timers cheap (the DO alarm fires them; the backstop never undercuts the platform step budget) and recovers a lost wake within the bound.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/wake-backstop.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { insertTimerArmedStmt } from "../../src/persistence/timers";
import { wakeBackstop, MAX_WAKE_BACKSTOP_MS } from "../../src/runtime/wake";

afterEach(() => vi.useRealTimers());

describe("wakeBackstop", () => {
  it("returns MAX_WAKE_BACKSTOP when no timer is armed", async () => {
    const out = await wakeBackstop(env, "none");
    expect(out).toBe(`${Math.ceil(MAX_WAKE_BACKSTOP_MS / 1000)} seconds`);
  });

  it("sizes to the nearest armed timer when it is sooner than the cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    await env.DB.batch([
      insertTimerArmedStmt(env.DB, { timerId: "w1:a#0", instanceId: "w1", elementId: "a", occurrence: 0, kind: "boundary", attachedToRef: "h", fireAt: "2026-06-13T00:00:30.000Z", now: "2026-06-13T00:00:00.000Z" }),
    ]);
    // 30s to fire + 5s slack = 35s, below the 1h cap.
    expect(await wakeBackstop(env, "w1")).toBe("35 seconds");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/wake-backstop.test.ts`
Expected: FAIL — module `src/runtime/wake.ts` does not exist.

- [ ] **Step 3: Create `src/runtime/wake.ts`**

```typescript
// Single-wake protocol (TASK-54): ONE replay-stable step.waitForEvent per parked
// pass on a constant event type, with a timer-aware self-heal timeout. The wake is
// a pure tickle — D1 is the truth; the engine re-walks and reconciles on every wake.
import type { Env } from "../env";
import { getEarliestArmedTimerForInstance } from "../persistence/timers";

/**
 * The single Cloudflare Workflows event type every job/message/timer sendEvent uses.
 * Must satisfy ^[a-zA-Z0-9_][a-zA-Z0-9-_]*$ (no dots — see [[easy_bpmn_deployed]]).
 * Instance-scoped sendEvent means one global type can never collide across instances.
 */
export const WAKE_TYPE = "bpmn_wake";

/** Slack added past a timer's fire_at so the backstop never wakes microseconds early. */
const WAKE_SLACK_MS = 5000;

/**
 * Ceiling on the wake backstop when no modeled deadline applies (external job/message
 * waits). A lost wake recovers within this bound; D1 read-your-writes consistency
 * makes the tickle the reliable primary path, so this is a rare fallback. Tunable
 * (design §8). Defaults to one hour, matching the legacy SVC_WAIT_TIMEOUT.
 */
export const MAX_WAKE_BACKSTOP_MS = 60 * 60 * 1000;

/**
 * The per-instance waitForEvent timeout for the single wake: size to the nearest
 * armed timer (so a modeled timer fires on time and a 7-day timer stays cheap),
 * capped at MAX_WAKE_BACKSTOP so a lost tickle on a non-timer wait self-heals.
 * Returns a Cloudflare-Workflows duration string ("N seconds").
 */
export async function wakeBackstop(env: Env, instanceId: string): Promise<string> {
  const timer = await getEarliestArmedTimerForInstance(env.DB, instanceId);
  let ms = MAX_WAKE_BACKSTOP_MS;
  if (timer) {
    const untilMs = new Date(timer.fireAt).getTime() - Date.now() + WAKE_SLACK_MS;
    ms = Math.min(MAX_WAKE_BACKSTOP_MS, Math.max(WAKE_SLACK_MS, untilMs));
  }
  return `${Math.ceil(ms / 1000)} seconds`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/wake-backstop.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/wake.ts tests/unit/wake-backstop.test.ts
git commit -m "feat(m4): WAKE_TYPE + timer-aware wakeBackstop helper (TASK-54)"
```

---

## Task 3: `getCorrelatedMessageForSubscription` query (apply-from-D1 read)

**Files:**
- Modify: `src/persistence/messages.ts`
- Test: `tests/unit/correlated-message.test.ts` (create)

The `external_messages` row carries the full `payload` and `matched_subscription_id` (set at POST time for a live correlation — `src/index.ts:636-650`). This query reconstructs the `MessageEventPayload` a re-walk needs.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/correlated-message.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { insertExternalMessage, getCorrelatedMessageForSubscription } from "../../src/persistence/messages";

describe("getCorrelatedMessageForSubscription", () => {
  it("returns the correlated message (with payload) linked to a subscription, else null", async () => {
    const now = "2026-06-13T00:00:00.000Z";
    await insertExternalMessage(env.DB, {
      externalMessageId: "em1", workspaceId: "default", messageName: "Ready",
      correlationKey: "k1", messageId: "mid1", payload: { ok: true }, payloadHash: "h",
      outcome: "correlated", finalOutcome: "correlated",
      matchedInstanceId: "i1", matchedSubscriptionId: "sub_1", receivedAt: now, correlatedAt: now,
    });
    const m = await getCorrelatedMessageForSubscription(env.DB, "sub_1");
    expect(m).toMatchObject({ externalMessageId: "em1", messageName: "Ready", messageId: "mid1", correlationKey: "k1" });
    expect(m?.payload).toEqual({ ok: true });
    expect(await getCorrelatedMessageForSubscription(env.DB, "sub_none")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/correlated-message.test.ts`
Expected: FAIL — `getCorrelatedMessageForSubscription` not exported.

- [ ] **Step 3: Add the query**

Append to `src/persistence/messages.ts` (reuse the file's existing `dbFirst`, `parseJson`/`fromJson` helpers and `MessageEventPayload` type — match the existing import style at the top of the file):

```typescript
import type { MessageEventPayload } from "../contracts/workflow-events";

interface CorrelatedMessageRow {
  external_message_id: string;
  message_name: string;
  correlation_key: string;
  message_id: string;
  payload: string;
}

/**
 * The correlated external message linked to an ACTIVE subscription (apply-from-D1,
 * TASK-54): a single-wake re-walk reconstructs the MessageEventPayload from D1 alone
 * (no in-flight event). The link (`matched_subscription_id`) is set at POST time for
 * a live correlation (src/index.ts handlePublishMessage). Returns null when no
 * correlated message is linked (e.g. still waiting, or an early-buffered message
 * applied via the broker registerSubscription path instead).
 */
export async function getCorrelatedMessageForSubscription(db: D1Database, subscriptionId: string): Promise<MessageEventPayload | null> {
  const row = await dbFirst<CorrelatedMessageRow>(
    db,
    `SELECT external_message_id, message_name, correlation_key, message_id, payload
       FROM external_messages
      WHERE matched_subscription_id = ? AND final_outcome = 'correlated'
      LIMIT 1`,
    [subscriptionId],
  );
  if (!row) return null;
  return {
    externalMessageId: row.external_message_id,
    messageName: row.message_name,
    correlationKey: row.correlation_key,
    messageId: row.message_id,
    payload: JSON.parse(row.payload),
  };
}
```

> **Note for the implementer:** confirm `dbFirst` is already imported in `messages.ts` (it is used by `getExternalMessageRow`). If `MessageEventPayload` is already imported, do not duplicate the import. Use the file's existing JSON-parse helper if it has one instead of raw `JSON.parse`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/correlated-message.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/persistence/messages.ts tests/unit/correlated-message.test.ts
git commit -m "feat(m4): getCorrelatedMessageForSubscription — apply-from-D1 read (TASK-54)"
```

---

## Task 4: apply-from-D1 in `driveReceiveTask` (the central change, proven in CI)

**Files:**
- Modify: `src/runtime/engine.ts` (`driveReceiveTask`, ~line 884-982)
- Test: `tests/integration/apply-from-d1.test.ts` (create)

A re-walk that finds an **active** subscription with a **correlated** message in D1 applies it from D1 — independent of the in-flight `pending` event. This is what makes a contentless `bpmn_wake` tickle (and a lost wake) recover the message. Tested white-box in **direct mode** so CI proves it.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/apply-from-d1.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { publishAndStart, get } from "../helpers";
import { resumeInline } from "../../src/runtime/engine";
import { getSubscriptionForVisit } from "../../src/persistence/instances";
import { insertExternalMessage } from "../../src/persistence/messages";

// Minimal single receive-task model (Start → ReceiveTask "Ready" → End).
const RECEIVE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D_recv" targetNamespace="x">
  <bpmn:message id="m_ready" name="Ready"/>
  <bpmn:process id="P_recv" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>s0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="R"/>
    <bpmn:receiveTask id="R" name="Wait" messageRef="m_ready"><bpmn:incoming>s0</bpmn:incoming><bpmn:outgoing>s1</bpmn:outgoing></bpmn:receiveTask>
    <bpmn:sequenceFlow id="s1" sourceRef="R" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>s1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

describe("apply-from-D1 (TASK-54)", () => {
  it("applies a correlated message from D1 on re-walk with NO in-flight event", async () => {
    const { instance } = await publishAndStart(RECEIVE_BPMN, { correlationKey: "afd1", variables: {} });
    const id = instance.body.instanceId;

    // Parked at the receive task — an active subscription exists for R#0.
    const parked = await get(`/instances/${id}`);
    expect(parked.body.status).toBe("waiting");
    const sub = await getSubscriptionForVisit(env.DB, id, "R", 0);
    expect(sub?.status).toBe("active");

    // Simulate the broker's POST-time link WITHOUT delivering an in-flight event.
    const now = new Date().toISOString();
    await insertExternalMessage(env.DB, {
      externalMessageId: "em_afd1", workspaceId: "default", messageName: "Ready",
      correlationKey: "afd1", messageId: "mid_afd1", payload: { greeted: true }, payloadHash: "h",
      outcome: "correlated", finalOutcome: "correlated",
      matchedInstanceId: id, matchedSubscriptionId: sub!.subscription_id, receivedAt: now, correlatedAt: now,
    });

    // The single-wake re-walk: a tickle drives runInstance with NO incomingEvent.
    await resumeInline(env, id);

    const done = await get(`/instances/${id}`);
    expect(done.body.status).toBe("completed");
    expect(done.body.variables).toMatchObject({ greeted: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/apply-from-d1.test.ts`
Expected: FAIL — instance stays `waiting`; the re-walk re-registers and parks instead of applying from D1.

- [ ] **Step 3: Add the apply-from-D1 branch to `driveReceiveTask`**

In `src/runtime/engine.ts`, in `driveReceiveTask`, **after** the consumed fast-forward + the `pending`-match block (right before the `registerReceive` call at ~line 925), insert:

```typescript
  // Apply-from-D1 (TASK-54): a single-wake re-walk has no in-flight `pending` event.
  // If the broker correlated a message to THIS active subscription (link recorded in
  // external_messages at POST time), apply it from D1 — the same merge+transition as
  // the pending path, sourcing the payload from the canonical store. This makes the
  // contentless bpmn_wake tickle (and a lost wake) recover the message.
  if (sub?.status === "active") {
    const fromD1 = await getCorrelatedMessageForSubscription(env.DB, sub.subscription_id);
    if (fromD1) {
      const r = await runStep(`msg:${tag}`, () => applyMessage(env, instanceId, graph, elementId, occ, next, fromD1, activeTokenId));
      return { kind: "next", next: r.next };
    }
  }
```

Add the import at the top of `engine.ts` (next to the existing `messages` persistence imports):

```typescript
import { getCorrelatedMessageForSubscription } from "../persistence/messages";
```

> The `sub` variable is already in scope (read at `driveReceiveTask` ~line 911 as `getSubscriptionForVisit`). Do not re-query.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/integration/apply-from-d1.test.ts`
Expected: PASS

- [ ] **Step 5: Run the FULL suite to prove direct mode is unchanged**

Run: `npm test`
Expected: PASS — all prior tests green (the new branch only fires when `pending` is absent AND a D1 link exists; the existing pending path still wins in direct delivery).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/engine.ts tests/integration/apply-from-d1.test.ts
git commit -m "feat(m4): apply-from-D1 for receiveTask/message-catch on re-walk (TASK-54)"
```

---

## Task 5: apply-from-D1 in `driveEventBasedGateway`

**Files:**
- Modify: `src/runtime/event-gateway.ts` (`driveEventBasedGateway`, ~line 156-255)
- Test: extend `tests/integration/apply-from-d1.test.ts`

The EBG registers one subscription per message branch. On a no-`pending` re-walk, if any branch's subscription has a correlated D1 message, apply it (message wins).

- [ ] **Step 1: Write the failing test (append to the apply-from-d1 file)**

```typescript
// (append in tests/integration/apply-from-d1.test.ts)
import { listActiveSubscriptionsForInstance } from "../../src/persistence/instances";

// Valid EBG: >=2 branches (a message catch + a never-firing timer); the messageRef
// sits INSIDE <messageEventDefinition> (validator requirement, src/bpmn/validator.ts).
const EBG_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D_ebg" targetNamespace="x">
  <bpmn:message id="m_go" name="Go"/>
  <bpmn:process id="P_ebg" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>s0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="G"/>
    <bpmn:eventBasedGateway id="G"><bpmn:incoming>s0</bpmn:incoming><bpmn:outgoing>g1</bpmn:outgoing><bpmn:outgoing>g2</bpmn:outgoing></bpmn:eventBasedGateway>
    <bpmn:sequenceFlow id="g1" sourceRef="G" targetRef="C1"/>
    <bpmn:intermediateCatchEvent id="C1"><bpmn:messageEventDefinition messageRef="m_go"/><bpmn:incoming>g1</bpmn:incoming><bpmn:outgoing>s1</bpmn:outgoing></bpmn:intermediateCatchEvent>
    <bpmn:sequenceFlow id="g2" sourceRef="G" targetRef="C2"/>
    <bpmn:intermediateCatchEvent id="C2"><bpmn:timerEventDefinition><bpmn:timeDuration>PT1H</bpmn:timeDuration></bpmn:timerEventDefinition><bpmn:incoming>g2</bpmn:incoming><bpmn:outgoing>s2</bpmn:outgoing></bpmn:intermediateCatchEvent>
    <bpmn:sequenceFlow id="s1" sourceRef="C1" targetRef="E"/>
    <bpmn:sequenceFlow id="s2" sourceRef="C2" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>s1</bpmn:incoming><bpmn:incoming>s2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

it("EBG applies a correlated message branch from D1 on re-walk", async () => {
  const { instance } = await publishAndStart(EBG_BPMN, { correlationKey: "afd-ebg", variables: {} });
  const id = instance.body.instanceId;
  // Only the message branch registers a subscription (the timer is a timers-table row).
  const subs = await listActiveSubscriptionsForInstance(env.DB, id);
  expect(subs.length).toBe(1);
  const now = new Date().toISOString();
  await insertExternalMessage(env.DB, {
    externalMessageId: "em_ebg", workspaceId: "default", messageName: "Go",
    correlationKey: "afd-ebg", messageId: "mid_ebg", payload: { went: 1 }, payloadHash: "h",
    outcome: "correlated", finalOutcome: "correlated",
    matchedInstanceId: id, matchedSubscriptionId: subs[0].subscription_id, receivedAt: now, correlatedAt: now,
  });
  await resumeInline(env, id);
  const done = await get(`/instances/${id}`);
  expect(done.body.status).toBe("completed");
  expect(done.body.variables).toMatchObject({ went: 1 });
});
```

> `listActiveSubscriptionsForInstance(db, instanceId): Promise<SubscriptionRow[]>` is exported at `src/persistence/instances.ts:756` (verified). No new reader needed.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/apply-from-d1.test.ts`
Expected: FAIL — the EBG re-walk re-parks instead of applying.

- [ ] **Step 3: Add apply-from-D1 to `driveEventBasedGateway`**

In `src/runtime/event-gateway.ts`, after the decision fast-forward (step 1) and the direct-mode `pending` block (step 2, ~line 192), **before** the park (step 3), insert:

```typescript
  // Apply-from-D1 (TASK-54): no in-flight `pending` on a single-wake re-walk. If a
  // message branch's subscription was correlated in D1, apply it (message wins).
  // `subscriptionIdFor` is the private builder this file already uses to register the
  // per-branch subscriptions (event-gateway.ts:710 → `ebgsub:${instanceId}:${catchId}#${occ}`),
  // so the lookup key matches what parkEventBasedGateway stored.
  for (const b of branches.message) {
    const fromD1 = await getCorrelatedMessageForSubscription(env.DB, subscriptionIdFor(instanceId, b.catchId, occ));
    if (fromD1 && fromD1.messageName === b.messageName) {
      const r = await runStep(`ebg-msg:${tag}`, () => applyEbgMessage(env, instanceId, graph, elementId, node, occ, b, branches, fromD1, activeTokenId));
      if (r.kind === "incident") return { kind: "incident" };
      return { kind: "next", next: r.next };
    }
  }
```

Add the import:

```typescript
import { getCorrelatedMessageForSubscription } from "../persistence/messages";
```

> **Implementer notes:** (1) `subscriptionIdFor(instanceId, catchId, occ)` is a private inline function in `event-gateway.ts:710-713` — already in scope in this file, no import or extraction needed. (2) `applyEbgMessage`'s 4th param is named `gwId` (the eventBasedGateway element id) and its 7th is `winner: EbgMessageBranch` — so passing `elementId` (= the gateway id) and `b` is positionally correct. (3) `EbgMessageBranch` carries `catchId` + `messageName` (event-gateway.ts:88-94).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/integration/apply-from-d1.test.ts`
Expected: PASS (both apply-from-D1 cases)

- [ ] **Step 5: Full suite (direct-mode regression)**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/runtime/event-gateway.ts src/persistence/instances.ts tests/integration/apply-from-d1.test.ts
git commit -m "feat(m4): apply-from-D1 for eventBasedGateway message branch (TASK-54)"
```

---

## Task 6: Leaf drivers park-not-suspend (workflow mode joins direct mode)

**Files:**
- Modify: `src/runtime/engine.ts` (`driveLeaf` in `loop`, ~line 301-308)
- Modify: `src/runtime/forward-task.ts`, `src/runtime/compensation.ts`, `src/runtime/intermediate-timer.ts`, `src/runtime/event-gateway.ts` (drop the `waitFor` suspend; park)

After this task, **no leaf driver ever calls a suspending `waitFor`** — they record the park in D1 and return `waiting`, exactly as direct mode does today. The single `bpmn_wake` is owned solely by `loop` (Task 7). CI (direct mode) is unaffected because direct mode already took the park path.

- [ ] **Step 1: Make `driveLeaf` always pass `null` as the leaf wait**

In `src/runtime/engine.ts` `loop`, replace (~line 307-308):

```typescript
      const leafWaitFor: WaitForEvent | null =
        waitFor && graph.regions ? collectingWaitFor(collector, activeTokenId) : waitFor;
```

with:

```typescript
      // TASK-54: leaf drivers NEVER suspend — they park (record the wait in D1) and
      // return `waiting`, identical to direct mode. The single bpmn_wake is issued by
      // `loop` after the drive (one waitForEvent at a time = the replay-stable shape).
      const leafWaitFor: WaitForEvent | null = null;
```

The `collector` param to `driveLeaf` is now unused; leave the signature for Task 9's cleanup.

- [ ] **Step 2: Drop the suspend in `forward-task.ts`**

In `src/runtime/forward-task.ts` `driveForwardServiceTask`, the `if (!waitFor)` park block (~line 168-171) now handles all modes since `waitFor` is always null here. **Delete** the workflow-mode suspend that follows it (~line 173-202: the `timerGuardedTimeout` + `await waitFor({ name: "wait-job:..." })` block and everything that branched on `outcome`). The function now ends at the park:

```typescript
  // Park: the instance resumes on the next drive (a /jobs/complete tickle in workflow
  // mode, or an inline re-drive in direct mode) once the job mutates in D1.
  await runStep(`svc-park:${tag}`, () => parkWaiting(env, instanceId, elementId, occ, "serviceTask"));
  return { kind: "waiting" };
```

> The timer-fast-forward + applied-outcome branches ABOVE the park stay — a re-walk after a tickle re-reads the job from D1 (`getForwardJob` → `applyForwardCompletion`) exactly as direct mode already does. Remove the now-unused `workflowJobEventTypeFor` and `timerGuardedTimeout` imports if nothing else uses them.

- [ ] **Step 3: Drop the suspend in `compensation.ts`, `intermediate-timer.ts`, `event-gateway.ts`**

Apply the same shape to each remaining `await waitFor({...})` leaf site (the call sites mapped in research: `compensation.ts:140`, `intermediate-timer.ts:108`, `event-gateway.ts:216`). In each, since `waitFor` is now always `null` at the leaf, the existing `if (!waitFor) return { kind: "waiting" }` (or park) path is taken and the suspend block below it is dead — **delete the suspend block** (the `await waitFor(...)` and its `outcome` handling), keeping the park return and the D1 fast-forward branches above it.

> For `compensation.ts` (which has no `if (!waitFor)` early return today), add one: after the compensation job is created/parked, `return { kind: "waiting" }` before any `waitFor` call, then delete the `waitFor` block.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (some imports now unused — remove them; the `collector`/`raceParkedWaits` are still referenced by `loop`/`frontier` until Tasks 7+9).

- [ ] **Step 5: Full suite (direct mode unchanged)**

Run: `npm test`
Expected: PASS — direct mode never used the deleted suspend blocks.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/engine.ts src/runtime/forward-task.ts src/runtime/compensation.ts src/runtime/intermediate-timer.ts src/runtime/event-gateway.ts
git commit -m "refactor(m4): leaf drivers park-not-suspend; workflow mode parks like direct (TASK-54)"
```

---

## Task 7: The single-wake `loop`

**Files:**
- Modify: `src/runtime/engine.ts` (`loop`, ~line 455-501)

`loop` now owns the one `bpmn_wake`. After each drive pass, if anything parked and we are in workflow mode, issue exactly one `step.waitForEvent(wake#k, bpmn_wake, backstop)` (try/caught → timeout self-heals), increment `k`, and re-walk. Direct mode returns `waiting` (the executor re-drives). This is **not CI-covered** (direct mode never issues a wait) — Task 10 validates it on real CF.

- [ ] **Step 1: Restructure the scalar park to use the single wake**

In `src/runtime/engine.ts` `loop`, the non-region scalar branch (~line 455-476) currently returns `{ status: "waiting" }` on park. Replace the scalar `while` loop's park return and the region loop's `raceParkedWaits` block with a shared single-wake. Concretely, introduce a wake counter and a helper at the top of `loop` (after `caps`/`runStep` setup):

```typescript
  let wakeSeq = 0;
  // Issue exactly ONE waitForEvent on the constant bpmn_wake type, sized to the
  // instance's nearest deadline. A timeout THROWS (CF semantics) → caught here so the
  // loop re-walks (self-heal). Returns false in direct mode (executor re-drives).
  const issueWake = async (): Promise<boolean> => {
    if (!waitFor) return false;
    caps.budget.steps += 1;
    const timeout = await wakeBackstop(env, instanceId);
    try {
      await waitFor({ name: `wake#${wakeSeq}`, workflowEventType: WAKE_TYPE, timeout });
    } catch {
      /* timeout (or any wait error) → self-heal: fall through to re-walk */
    }
    wakeSeq += 1;
    return true;
  };
```

Add the import:

```typescript
import { WAKE_TYPE, wakeBackstop } from "./wake";
```

- [ ] **Step 2: Scalar branch — wrap park in the wake loop**

Replace the non-region scalar block (~line 455-476) so that on a parked leaf it issues the wake and re-walks instead of returning immediately:

```typescript
  if (!graph.regions) {
    while (true) {
      const visits = new Map<string, number>();
      let cur: string = graph.startElementId;
      let parked = false;
      while (true) {
        if (!graph.nodes[cur]) return { status: "completed" };
        const occ = nextOccurrence(visits, cur);
        if (occ >= MAX_ELEMENT_OCCURRENCES) {
          await drivers.raiseLoopLimit(cur, occ);
          return { status: "incident" };
        }
        const r = await drivers.driveLeaf(cur, occ, rootTokenId(instanceId), scratch);
        if (r.kind === "next") { cur = r.next; continue; }
        if (r.kind === "parked") { parked = true; break; }
        if (r.kind === "incident") return { status: "incident" };
        if (r.kind === "compensate") return settleAfterCompensation(env, instanceId, graph, r.scopeId, runStep, waitFor);
        return { status: "completed" };
      }
      if (parked) {
        if (!(await issueWake())) return { status: "waiting" }; // direct mode parks
        continue; // workflow mode: re-walk after the wake
      }
    }
  }
```

> `scratch` (the unused `WaitCollector`) stays until Task 9 removes the param. `pending` (incomingEvent) is still threaded for direct-mode message apply; in workflow mode it is undefined and apply-from-D1 (Task 4) covers it.

- [ ] **Step 3: Region branch — replace `raceParkedWaits` with the single wake**

Replace the region loop's parked block (~line 486-497):

```typescript
    if (result.parked) {
      if (!(await issueWake())) return { status: "waiting" }; // direct mode parks
      continue; // workflow mode: re-walk after the single wake
    }
```

Delete the `caps.budget.steps += collector.size;` / `raceParkedWaits` / `matchKeyedEvent` lines. `driveFrontier` still returns `{ result, collector }` until Task 9; ignore `collector` here.

- [ ] **Step 4: Typecheck + full suite (direct mode unchanged)**

Run: `npm run typecheck && npm test`
Expected: PASS — direct mode returns `{ status: "waiting" }` exactly as before; the wake loop is workflow-mode-only.

- [ ] **Step 5: Local workflow-mode smoke (the probe-equivalent on the real engine)**

Run the AND-join under local `wrangler dev` (EXECUTION_MODE=workflow) per Task 10's procedure as an early signal. Expected: the AND-join COMPLETES (no hang). If it hangs, debug before proceeding (the wake counter or apply-from-D1 is the suspect).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/engine.ts
git commit -m "feat(m4): single bpmn_wake loop replaces multi-wait Promise.race (TASK-54)"
```

---

## Task 8: Executor sends the `bpmn_wake` tickle

**Files:**
- Modify: `src/runtime/executor.ts` (`WorkflowExecutor.deliver`, `deliverJobResult`, `wakeTimer`)

All three `WorkflowExecutor` sends become a contentless `sendEvent({ type: WAKE_TYPE, payload: { kind } })`. DirectExecutor is untouched. The catch→inline-drive fallbacks (terminated Workflow) stay verbatim.

- [ ] **Step 1: Change the three sends**

In `src/runtime/executor.ts`:

`deliver` (~line 62-71):
```typescript
  async deliver(args: DeliverArgs): Promise<void> {
    const instance = await this.env.PROCESS_WORKFLOW.get(args.workflowInstanceId);
    // TASK-54: contentless tickle — the engine re-walks and applies the correlated
    // message from D1 (apply-from-D1). One constant type = replay-stable.
    await instance.sendEvent({ type: WAKE_TYPE, payload: { kind: "message" } });
  }
```

`deliverJobResult` (~line 76, inside the `try`):
```typescript
      await instance.sendEvent({ type: WAKE_TYPE, payload: { kind: "jobResult" } });
```
(keep the entire `catch { ... runInstance(..., waitFor: null, startAt: args.elementId) ... }` fallback unchanged.)

`wakeTimer` (~line 113, inside the `try`):
```typescript
      await instance.sendEvent({ type: WAKE_TYPE, payload: { kind: "timerFired", timerId: args.timerId } });
```
(keep the `catch { ... runInstance(..., waitFor: null) ... }` fallback unchanged.)

Add the import and drop `workflowJobEventTypeFor`:
```typescript
import { WAKE_TYPE } from "./wake";
// remove: import { workflowJobEventTypeFor } from "../bpmn/profile";
```

- [ ] **Step 2: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS — DirectExecutor unchanged; the 413 tests never hit WorkflowExecutor.

- [ ] **Step 3: Commit**

```bash
git add src/runtime/executor.ts
git commit -m "feat(m4): WorkflowExecutor sends contentless bpmn_wake tickle (TASK-54)"
```

---

## Task 9: Remove the dead multi-wait machinery + per-type event fns

**Files:**
- Modify: `src/runtime/frontier.ts` (delete `raceParkedWaits`, `collectingWaitFor`, `WaitCollector`, `RaceOutcome`, `ParkedWait`, `matchKeyedEvent`); `driveFrontier` drops the `collector`
- Modify: `src/runtime/engine.ts` (drop `collector`/`scratch` params + imports)
- Modify: `src/bpmn/profile.ts` (delete the 4 event-type fns)
- Modify: callers that imported the deleted fns

- [ ] **Step 1: Delete the race machinery in `frontier.ts`**

Remove from `frontier.ts`: `raceParkedWaits` (line 328-343), `matchKeyedEvent` (351-353), `RaceOutcome` (315-319), `ParkedWait` (121-126), `WaitCollector` (132-140). (`collectingWaitFor` is NOT here — it is local to `engine.ts:552-557`, deleted in Step 2.) Change `driveFrontier` to not build/return a `WaitCollector`: drop the `collector` local, change `driveLeaf` calls to pass no collector, and return `FrontierResult` directly (not `{ result, collector }`). Update `LeafDrivers.driveLeaf` signature to drop the `collector` param.

- [ ] **Step 2: Update `engine.ts` callers**

- `loop`'s region branch: `const result = await driveFrontier(...)` (no `{ result, collector }` destructure).
- `driveLeaf` impl: drop the `collector` param. **Delete the local `collectingWaitFor` definition at `engine.ts:552-557`** (its only usage at line 308 was already removed in Task 6).
- Scalar branch: drop the `scratch` `WaitCollector` local and pass nothing for the removed param.
- Remove imports of `raceParkedWaits`, `matchKeyedEvent`, `WaitCollector` (engine.ts:104-105 + the frontier import line). `collectingWaitFor` had no import (it was local).

- [ ] **Step 3: Delete the 4 event-type fns + update their callers**

In `src/bpmn/profile.ts` delete `workflowEventTypeFor`, `workflowEventGatewayTypeFor`, `workflowJobEventTypeFor`, `workflowTimerEventTypeFor` (lines 97-136). Then fix every caller mapped in research:

- `engine.ts:135` re-export — delete.
- `engine.ts:1018`, `engine.ts:1089` (`workflowEventTypeFor` for the subscription's `workflow_event_type` column): pass `WAKE_TYPE` (the column becomes a vestige; keep the column NOT NULL by writing `WAKE_TYPE`). Import `WAKE_TYPE` from `./wake`.
- `boundary-timer.ts:384`, `:403`, `intermediate-timer.ts:226`, `event-gateway.ts:653` (the `wake: { workflowEventType }` builders): the executor ignores this field now; set `workflowEventType: WAKE_TYPE`. Remove the per-type imports.
- `event-gateway.ts:293` (`gwEventType` stored in subscription): use `WAKE_TYPE`.
- Any remaining import lines for the deleted fns — remove.

> Keep `message_subscriptions.workflow_event_type` as a NOT-NULL column written with `WAKE_TYPE` (no migration needed). Note its vestigial status in a comment.

- [ ] **Step 4: Typecheck + full suite + docs guard + dry-run**

Run: `npm run typecheck && npm test && npm run check:docs && npx wrangler deploy --dry-run`
Expected: ALL PASS — 413 tests + the 3 new test files green; no dangling references.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(m4): delete multi-wait race + per-type event fns; collapse to bpmn_wake (TASK-54)"
```

---

## Task 10: Real-CF re-validation (the DoD gate)

**Files:**
- Modify: `specs/002-saga-orchestrator/quickstart.md` ("M4 manual Workflow-mode matrix")

CI cannot reach the wake path. This task validates the runtime on **real Cloudflare Workflows**, the gate that L6.6 established.

- [ ] **Step 1: Deploy the fix to a real-CF validation target**

```bash
npx wrangler d1 migrations apply easy_bpmn --remote   # no-op if 0007 already applied
npx wrangler deploy
```
Record the Worker Version id.

- [ ] **Step 2: Substrate probe — single-token regression on real CF**

For each of: the canonical order-saga, a conditional saga, `examples/timer-saga.bpmn`, `examples/event-gateway-saga.bpmn` — publish, start, drive (jobs/messages/timers) against `bpmn.rntme.com`, and confirm each **completes** (apply-from-D1 preserved M1/M2/M3 message/EBG/timer behaviour). Record pass/fail.

- [ ] **Step 3: Substrate probe — AND-join goes green**

Start a `PARALLEL_BPMN` instance on real CF; complete branch B then branch A (any order). Confirm the join fires and the instance **completes** (the L6.6 hang is gone). Record the instance id + history.

- [ ] **Step 4: WM-1..WM-6 on real CF**

Execute the six matrix scenarios (quickstart.md "The six matrix scenarios"): parallel message catches deliver-A-then-B; crash/restart mid-race; near-simultaneous delivery + forced replay; one branch times out while a sibling is live; in-region loops near the budget; cancel a region with stragglers. Each must pass. Record evidence per scenario.

- [ ] **Step 5: Update the quickstart matrix to PASSED**

Rewrite the "M4 manual Workflow-mode matrix" section: flip the substrate probe + WM-1..WM-6 to PASS with the recorded evidence (Version id, instance ids), and replace the "BLOCKING defect" framing with "resolved by TASK-54 single-wake; re-validated <date>". Keep the root-cause history as a "previously" note.

- [ ] **Step 6: Commit**

```bash
git add specs/002-saga-orchestrator/quickstart.md
git commit -m "docs(m4): L6.6 matrix re-validated GREEN on real CF after single-wake fix (TASK-54)"
```

---

## Task 11: Constitution gate, Backlog closure, merge

**Files:**
- Modify: backlog tasks TASK-54, TASK-53; `CLAUDE.md` (M4 → shipped)

- [ ] **Step 1: Constitution check** — confirm no profile/scope change (this is a runtime mechanism fix); no `constitution.md` amendment needed. If `docs/bpmn/09` or specs reference the multi-wait mechanism, align them. Run `npm run check:docs`.

- [ ] **Step 2: Close Backlog** — mark TASK-54 ACs #1-#5 done with evidence; complete TASK-53 ACs #8/#9 (epic closure). Use the Backlog MCP `task_edit`/`task_complete` per the workflow.

- [ ] **Step 3: Flip `CLAUDE.md`** — M4 (concurrency) → shipped; update the milestone summary line.

- [ ] **Step 4: Full green gate**

Run: `npm run typecheck && npm test && npm run check:docs && npx wrangler deploy --dry-run`
Expected: ALL PASS.

- [ ] **Step 5: Finish the branch** — invoke `superpowers:finishing-a-development-branch` to merge `m4-concurrency` → `main` (66+ commits ahead). Confirm prod is on the fixed Version.

- [ ] **Step 6: Commit + memory** — update `easy_bpmn_deployed` memory: M4 multi-wait FIXED + merged + deployed.

---

## Self-Review

- **Spec coverage:** §1 problem → Tasks 4-9 + 10 (validation). §2 empirical findings → grounded in `/tmp/cf-wf-probe` (referenced, Task 10 reuses it). §3.1 wake protocol → Task 7 (`issueWake`, `wake#k`, try/catch). §3.2 apply-from-D1 → Tasks 3-5. §3.3 timer-aware timeout → Tasks 1-2. §4 file-by-file → Tasks 6-9 cover every listed file. §5 correctness → preserved by "one waitFor at a time" (Task 7) + Task 10. §6 re-validation → Task 10. §7 risks → R-apply-from-D1 proven in CI (Tasks 4-5); R-unification-blast-radius guarded by `npm test` after every task + Task 10 single-token regression. §8 open questions → `MAX_WAKE_BACKSTOP_MS` is a named tunable (Task 2). **No gaps.**
- **Placeholder scan:** every code step shows complete code; the two implementer notes (`dbFirst`/`MessageEventPayload` import dedup in Task 3; `ebgSubscriptionId` reuse in Task 5; `listSubscriptionsForInstance` existence in Task 5) are explicit "confirm/reuse, don't invent" guards, not deferred work. RECEIVE_BPMN/EBG_BPMN are complete inline models.
- **Type consistency:** `WAKE_TYPE`/`MAX_WAKE_BACKSTOP_MS`/`wakeBackstop` (Task 2) used identically in Tasks 7-9. `getCorrelatedMessageForSubscription` returns `MessageEventPayload` (Task 3) consumed by `applyMessage`/`applyEbgMessage` (Tasks 4-5). `getEarliestArmedTimerForInstance` returns `TimerView` (Task 1) read via `.fireAt` (Task 2). Consistent.
