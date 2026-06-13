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
