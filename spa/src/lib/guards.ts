// Status guard-rails (design §15) — mirror the server's cancel/retry guards so the
// UI only offers an action the API will accept. The server stays authoritative
// (a 409 still triggers a "state changed, refresh" toast).

const CANCELLABLE = new Set(["running", "waiting", "incident"]);
const RETRYABLE = new Set(["incident", "compensationFailed"]);

export function canCancel(status: string): boolean {
  return CANCELLABLE.has(status);
}

export function canRetry(status: string): boolean {
  return RETRYABLE.has(status);
}

/** compensationFailed is the terminal "stuck" state — resume (retry) only, no cancel. */
export function isStuck(status: string): boolean {
  return status === "compensationFailed";
}
