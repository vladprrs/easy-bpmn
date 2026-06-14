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
