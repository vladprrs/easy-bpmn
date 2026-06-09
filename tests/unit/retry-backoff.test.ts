import { describe, expect, it } from "vitest";
import {
  ACTIVATION_TTL_MS,
  POISON_THRESHOLD,
  RETRY_POLICY,
  backoffCapMs,
  computeBackoffMs,
} from "../../src/runtime/retry-policy";

// TASK-23 (design §4.1/§4.4): pure exponential-with-full-jitter backoff. The
// cap is min(maxBackoff, base*factor^(attempt-1)); the returned value is full
// jitter in [0, cap]. computeBackoffMs takes an injectable `rand` so the jitter
// bounds are deterministically assertable.

describe("computeBackoffMs (retry backoff)", () => {
  it("caps exponentially and never exceeds maxBackoffMs", () => {
    // base 1000, factor 2, max 30_000
    expect(backoffCapMs(1)).toBe(1000);
    expect(backoffCapMs(2)).toBe(2000);
    expect(backoffCapMs(3)).toBe(4000);
    expect(backoffCapMs(4)).toBe(8000);
    expect(backoffCapMs(5)).toBe(16000);
    expect(backoffCapMs(6)).toBe(RETRY_POLICY.maxBackoffMs); // 32000 → capped 30000
    expect(backoffCapMs(7)).toBe(RETRY_POLICY.maxBackoffMs);
  });

  it("is monotonically non-decreasing in the cap and bounded by maxBackoffMs", () => {
    let prev = 0;
    for (let attempt = 1; attempt <= 10; attempt++) {
      const cap = backoffCapMs(attempt);
      expect(cap).toBeGreaterThanOrEqual(prev);
      expect(cap).toBeLessThanOrEqual(RETRY_POLICY.maxBackoffMs);
      prev = cap;
    }
  });

  it("applies full jitter — result lies in [0, cap]", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const cap = backoffCapMs(attempt);
      expect(computeBackoffMs(attempt, RETRY_POLICY, () => 0)).toBe(0);
      expect(computeBackoffMs(attempt, RETRY_POLICY, () => 1)).toBe(cap);
      expect(computeBackoffMs(attempt, RETRY_POLICY, () => 0.5)).toBe(Math.round(0.5 * cap));
    }
  });

  it("default randomness stays within bounds across many samples", () => {
    for (let i = 0; i < 200; i++) {
      const attempt = (i % 7) + 1;
      const v = computeBackoffMs(attempt);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(backoffCapMs(attempt));
    }
  });

  it("exposes the approved M1 defaults", () => {
    expect(RETRY_POLICY).toEqual({ baseMs: 1000, factor: 2, maxBackoffMs: 30_000 });
    expect(ACTIVATION_TTL_MS).toBe(15 * 60 * 1000);
    expect(POISON_THRESHOLD).toBe(3);
  });
});
