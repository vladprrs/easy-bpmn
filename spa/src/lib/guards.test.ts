import { describe, expect, it } from "vitest";
import { canCancel, canRetry, isStuck } from "./guards";

describe("status guard-rails (§15)", () => {
  it("allows cancel only from running/waiting/incident", () => {
    expect(["running", "waiting", "incident"].every(canCancel)).toBe(true);
    expect(["completed", "compensated", "compensationFailed", "cancelled", "compensating"].some(canCancel)).toBe(false);
  });

  it("allows retry only from incident/compensationFailed", () => {
    expect(["incident", "compensationFailed"].every(canRetry)).toBe(true);
    expect(["running", "waiting", "completed", "compensated"].some(canRetry)).toBe(false);
  });

  it("flags compensationFailed as the stuck (resume-only) state", () => {
    expect(isStuck("compensationFailed")).toBe(true);
    expect(isStuck("incident")).toBe(false);
    // A stuck instance can be retried but never cancelled (cancel would 409).
    expect(canRetry("compensationFailed")).toBe(true);
    expect(canCancel("compensationFailed")).toBe(false);
  });
});
