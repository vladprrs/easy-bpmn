import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

interface Env {
  STATE: KVNamespace;
  PROBE_A: Workflow;
  PROBE_B: Workflow;
  PROBE_C: Workflow;
}

type Params = { id: string; branches: string[]; timeout?: string };

// ---------------------------------------------------------------------------
// Probe A — STATIC-membership race.
// run() ALWAYS issues the same two waitForEvent calls every invocation; a
// completed branch's wait stays in the race and is satisfied by name-cache.
// Hypothesis: works (deliver evB then evA both progress the instance).
// ---------------------------------------------------------------------------
export class ProbeA extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { id } = event.payload;
    // Always race the SAME static set — membership never shrinks.
    const first = await Promise.race([
      step.waitForEvent(`wait-A`, { type: "evA", timeout: "120 seconds" }).then(() => "A"),
      step.waitForEvent(`wait-B`, { type: "evB", timeout: "120 seconds" }).then(() => "B"),
    ]);
    await step.do(`first-${first}`, async () => {
      await this.env.STATE.put(`${id}:A:first`, first);
      return first;
    });
    // Now wait on the OTHER one (still a distinct name).
    const other = first === "A" ? "B" : "A";
    await step.waitForEvent(`wait-other-${other}`, { type: `ev${other}`, timeout: "120 seconds" });
    await step.do(`done`, async () => {
      await this.env.STATE.put(`${id}:A:done`, "1");
      return "done";
    });
    return { probe: "A", first, completed: true };
  }
}

// ---------------------------------------------------------------------------
// Probe B — SHRINKING-membership race (reproduces the L6.6 defect).
// Each round rebuilds the race over only NOT-yet-done branches; a completed
// branch DROPS OUT of the waitForEvent set on the next re-invocation.
// Hypothesis: hangs / diverges after the 2nd branch (the M4 bug).
// ---------------------------------------------------------------------------
export class ProbeB extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { id, branches } = event.payload;
    let round = 0;
    for (;;) {
      const active: string[] = [];
      const waits: Promise<string>[] = [];
      for (const b of branches) {
        // RAW read outside step.do — faithfully models the real engine reading D1
        // during the re-walk; this is what makes the issued waitForEvent SET diverge.
        const done = await this.env.STATE.get(`${id}:done:${b}`);
        if (!done) {
          active.push(b);
          // wait name is STABLE per branch, but the CALL is conditional → membership shrinks
          waits.push(
            step.waitForEvent(`wait-${b}`, { type: `ev${b}`, timeout: "120 seconds" }).then(() => b),
          );
        }
      }
      await step.do(`active-${round}`, async () => {
        await this.env.STATE.put(`${id}:B:active:${round}`, JSON.stringify(active));
        return active.length;
      });
      if (waits.length === 0) return { probe: "B", rounds: round, completed: true };
      const who = await Promise.race(waits);
      await step.do(`apply-${who}`, async () => {
        await this.env.STATE.put(`${id}:done:${who}`, "1");
        return who;
      });
      round++;
      if (round > 20) return { probe: "B", rounds: round, completed: false, reason: "runaway" };
    }
  }
}

// ---------------------------------------------------------------------------
// Probe C — SINGLE-WAKE (validates the proposed fix).
// Exactly ONE waitForEvent pending at a time, on a CONSTANT event type "wake",
// with a distinct sequential name wake-${k}. Each pass re-reads external state
// (models "re-walk from D1") inside a memoized step.do, applies everything done,
// and only suspends if work remains. Tickle-only: the wake payload is ignored;
// truth lives in STATE (= D1).
// Hypothesis: completes regardless of delivery order, and a wake delivered
// before wake-${k} is reached is buffered (or harmlessly redundant).
// ---------------------------------------------------------------------------
export class ProbeC extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { id, branches } = event.payload;
    const timeout = event.payload.timeout ?? "120 seconds";
    let k = 0;
    let timeouts = 0;
    for (;;) {
      const pending = await step.do(`reconcile-${k}`, async () => {
        let p = 0;
        for (const b of branches) {
          if (!(await this.env.STATE.get(`${id}:done:${b}`))) p++;
        }
        await this.env.STATE.put(`${id}:C:pass:${k}`, JSON.stringify({ pending: p, ts: Date.now() }));
        return p;
      });
      if (pending === 0) return { probe: "C", passes: k, timeouts, completed: true };
      try {
        await step.waitForEvent(`wake-${k}`, { type: "wake", timeout });
      } catch (e) {
        // waitForEvent TIMES OUT BY THROWING → self-heal: record + re-walk from state (D1 is truth)
        timeouts++;
        await step.do(`timeout-${k}`, async () => {
          await this.env.STATE.put(`${id}:C:timeout:${k}`, JSON.stringify({ err: String(e), ts: Date.now() }));
          return "timeout";
        });
      }
      k++;
      if (k > 50) return { probe: "C", passes: k, timeouts, completed: false, reason: "runaway" };
    }
  }
}

// ---------------------------------------------------------------------------
// Driver — HTTP harness to create instances, mark branches done, send events,
// and read status. Returns JSON for scripting.
// ---------------------------------------------------------------------------
function wf(env: Env, probe: string): Workflow {
  if (probe === "A") return env.PROBE_A;
  if (probe === "B") return env.PROBE_B;
  return env.PROBE_C;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.searchParams;
    const json = (o: unknown, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

    try {
      switch (url.pathname) {
        case "/create": {
          const probe = p.get("probe") ?? "C";
          const id = p.get("id")!;
          const branches = (p.get("branches") ?? "A,B").split(",");
          const timeout = p.get("to") ?? undefined;
          const inst = await wf(env, probe).create({ id, params: { id, branches, timeout } });
          return json({ ok: true, id: inst.id, probe });
        }
        case "/done": {
          const id = p.get("id")!;
          const branch = p.get("branch")!;
          await env.STATE.put(`${id}:done:${branch}`, "1");
          return json({ ok: true, id, branch, marked: true });
        }
        case "/send": {
          const probe = p.get("probe") ?? "C";
          const id = p.get("id")!;
          const type = p.get("type")!;
          const inst = await wf(env, probe).get(id);
          await inst.sendEvent({ type, payload: { id, type } });
          return json({ ok: true, id, type, sent: true });
        }
        case "/status": {
          const probe = p.get("probe") ?? "C";
          const id = p.get("id")!;
          const inst = await wf(env, probe).get(id);
          const status = await inst.status();
          // gather trace keys
          const list = await env.STATE.list({ prefix: `${id}:` });
          const trace: Record<string, string> = {};
          for (const k of list.keys) trace[k.name] = (await env.STATE.get(k.name)) ?? "";
          return json({ ok: true, id, status, trace });
        }
        case "/reset": {
          const id = p.get("id")!;
          const list = await env.STATE.list({ prefix: `${id}:` });
          for (const k of list.keys) await env.STATE.delete(k.name);
          return json({ ok: true, id, reset: true });
        }
        default:
          return json({ ok: false, error: "unknown path", paths: ["/create", "/done", "/send", "/status", "/reset"] }, 404);
      }
    } catch (e) {
      return json({ ok: false, error: String(e), stack: (e as Error)?.stack }, 500);
    }
  },
};
