import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { OVERLAY_INLINE_MAX_BYTES, writeOverlay, readOverlay } from "../../src/persistence/tokens";

// M4-L6 (design §9.1) — branch variable overlays exceeding OVERLAY_INLINE_MAX_BYTES
// are offloaded to R2 under a DETERMINISTIC key (written before the D1 commit so a
// crash-retry is byte-identical); the D1 column then holds {"__r2":"<key>"} and
// reads transparently rehydrate. Small overlays stay inline.

describe("R2 overlay offload (M4-L6)", () => {
  it("keeps a small overlay inline — no R2 write, column holds the overlay verbatim", async () => {
    const overlay = { a: 1, b: "x", nested: { c: true } };
    const stored = await writeOverlay(env, "inst-small", "inst-small:#root", overlay);
    expect(stored).toEqual(overlay);
    expect(await readOverlay(env, stored)).toEqual(overlay);
  });

  it("offloads an overlay over the inline cap to R2 under overlays/${id}/${tokenId}.json; reads rehydrate", async () => {
    const big = { blob: "x".repeat(OVERLAY_INLINE_MAX_BYTES + 100), n: 7 };
    const tokenId = "inst-big:fork#0:f1";
    const stored = await writeOverlay(env, "inst-big", tokenId, big);
    expect(stored).toEqual({ __r2: "overlays/inst-big/inst-big:fork#0:f1.json" });
    // The R2 object exists under the deterministic key.
    expect(await env.OVERLAYS.get("overlays/inst-big/inst-big:fork#0:f1.json")).not.toBeNull();
    // readOverlay transparently rehydrates the offloaded value.
    expect(await readOverlay(env, stored)).toEqual(big);
  });

  it("is deterministic — same instance+token writes the same key, byte-identical on retry", async () => {
    const big = { blob: "y".repeat(OVERLAY_INLINE_MAX_BYTES + 50) };
    const s1 = await writeOverlay(env, "inst-det", "inst-det:#root", big);
    const s2 = await writeOverlay(env, "inst-det", "inst-det:#root", big);
    expect(s1).toEqual(s2);
    expect(s1).toEqual({ __r2: "overlays/inst-det/inst-det:#root.json" });
  });

  it("readOverlay returns a non-__r2 value verbatim (inline fast path, no R2 round-trip)", async () => {
    expect(await readOverlay(env, { plain: 1 })).toEqual({ plain: 1 });
    expect(await readOverlay(env, {})).toEqual({});
  });
});
