// M-UI session-token unit tests (design §8): HMAC sign/verify round-trip,
// tamper/secret/expiry rejection. Runs in the workers pool (crypto.subtle).

import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "../../src/ui/session";

const SECRET = "unit-secret-please-change";

describe("M-UI session token (HMAC-SHA256)", () => {
  it("round-trips a freshly signed token", async () => {
    const token = await signToken(SECRET, 60_000);
    expect(token).toContain(".");
    expect(await verifyToken(SECRET, token)).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signToken(SECRET, 60_000);
    expect(await verifyToken("a-different-secret", token)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const token = await signToken(SECRET, 60_000);
    const payload = token.slice(0, token.indexOf("."));
    expect(await verifyToken(SECRET, `${payload}.deadbeefdeadbeef`)).toBe(false);
  });

  it("rejects an expired token", async () => {
    const token = await signToken(SECRET, -1_000); // exp already in the past
    expect(await verifyToken(SECRET, token)).toBe(false);
  });

  it("rejects malformed and empty tokens", async () => {
    expect(await verifyToken(SECRET, "")).toBe(false);
    expect(await verifyToken(SECRET, "no-dot-here")).toBe(false);
    expect(await verifyToken(SECRET, undefined)).toBe(false);
    expect(await verifyToken(SECRET, null)).toBe(false);
  });
});
