// Event humanization (design §13, G3). The single place that knows engine jargon:
// maps every emitted history `type` → a tone + a human title. ANY unmapped/future
// type falls back deterministically (title-cased + muted) so a new engine event
// never regresses to raw jargon. Pure + unit-tested (humanize.test.ts asserts every
// KNOWN_EMITTED_TYPE maps, and that the fallback is clean).

export type Tone = "info" | "ok" | "warn" | "danger" | "muted" | "accent";

export interface Humanized {
  tone: Tone;
  title: string;
}

const TABLE: Record<string, Humanized> = {
  // Lifecycle
  instanceStarted: { tone: "accent", title: "Instance started" },
  instanceCompleted: { tone: "ok", title: "Instance completed" },
  instanceCancelled: { tone: "warn", title: "Instance cancelled" },
  elementEntered: { tone: "muted", title: "Entered element" },
  definitionDraftCreated: { tone: "muted", title: "Draft created" },
  definitionPublished: { tone: "info", title: "Definition published" },

  // Service tasks / jobs
  serviceTaskJobCreated: { tone: "info", title: "Service-task job created" },
  serviceTaskWaiting: { tone: "muted", title: "Waiting for worker" },
  jobActivated: { tone: "info", title: "Job leased by worker" },
  jobCompleted: { tone: "ok", title: "Worker completed job" },
  serviceTaskCompleted: { tone: "ok", title: "Service task completed" },
  jobFailed: { tone: "danger", title: "Worker failed job" },
  jobActivationExpired: { tone: "danger", title: "Job activation timed out (DLQ)" },
  serviceTaskOutputRejected: { tone: "warn", title: "Worker output rejected (too large)" },
  poisonJob: { tone: "danger", title: "Poison job (output repeatedly rejected)" },
  businessErrorCaught: { tone: "warn", title: "Business error caught" },

  // Incidents / operator
  incidentCreated: { tone: "danger", title: "Incident raised" },
  operatorRetry: { tone: "accent", title: "Operator retried" },

  // Gateways
  gatewayDecisionEvaluated: { tone: "info", title: "Gateway decision" },
  ebgDecision: { tone: "info", title: "Event-gateway decision" },
  eventBasedGatewayWaiting: { tone: "muted", title: "Event gateway waiting" },

  // Timers
  timerArmed: { tone: "info", title: "Timer armed" },
  timerFired: { tone: "warn", title: "Timer fired" },
  timerCancelled: { tone: "muted", title: "Timer cancelled" },

  // Messages / correlation
  receiveTaskWaiting: { tone: "muted", title: "Waiting for message" },
  messageCatchWaiting: { tone: "muted", title: "Waiting for message" },
  messageReceived: { tone: "info", title: "Message received" },
  messageCorrelated: { tone: "ok", title: "Message correlated" },
  messageBuffered: { tone: "muted", title: "Message buffered (early)" },
  messageExpired: { tone: "warn", title: "Buffered message expired" },
  messageLate: { tone: "warn", title: "Message arrived late (no match)" },
  duplicateIgnored: { tone: "muted", title: "Duplicate message ignored" },
  invariantViolation: { tone: "danger", title: "Invariant violation" },

  // Transaction / saga
  transactionEntered: { tone: "info", title: "Transaction entered" },
  transactionCommitted: { tone: "ok", title: "Transaction committed" },
  transactionCancelled: { tone: "warn", title: "Transaction cancelling" },
  compensationStarted: { tone: "warn", title: "Compensation started" },
  compensationCompleted: { tone: "ok", title: "Compensation completed" },
  compensationFailed: { tone: "danger", title: "Compensation failed" },
  sagaFailed: { tone: "danger", title: "Saga failed (reverse pass exhausted)" },

  // Concurrency (M4)
  branchForked: { tone: "info", title: "Branch forked" },
  regionActivated: { tone: "info", title: "Region activated (fan-out)" },
  branchArrivedAtJoin: { tone: "muted", title: "Branch arrived at join" },
  joinCompleted: { tone: "ok", title: "Join completed" },
};

/** Every history `type` the engine is known to emit (mirrors the runtime grep). */
export const KNOWN_EMITTED_TYPES = Object.keys(TABLE);

function titleCase(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

export function humanize(type: string): Humanized & { mapped: boolean } {
  const hit = TABLE[type];
  if (hit) return { ...hit, mapped: true };
  return { tone: "muted", title: titleCase(type), mapped: false };
}

/** One-line detail for a timeline row: element + the most useful diagnostics. */
export function describeEvent(
  ev: { elementId?: string | null; diagnostics?: Record<string, unknown>; payloadSnapshot?: Record<string, unknown> | null },
  elementName?: (id: string) => string,
): string {
  const parts: string[] = [];
  if (ev.elementId) parts.push(elementName ? elementName(ev.elementId) : ev.elementId);
  const d = ev.diagnostics ?? {};
  if (typeof d.reason === "string" && d.reason) parts.push(d.reason);
  else if (typeof d.errorCode === "string" && d.errorCode) parts.push(`error: ${d.errorCode}`);
  else if (typeof d.chosenFlowId === "string") parts.push(`→ ${d.chosenFlowId}`);
  return parts.join(" · ");
}
