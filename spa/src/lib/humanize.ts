// Event humanization (design §13, G3) — the single place that knows engine jargon.
// `humanize(type)` → tone + a short narrative title; ANY unmapped/future type falls
// back deterministically (title-cased + muted) so a new engine event never regresses
// to raw jargon. `narrate(type, el)` → the warm one-line "voice" spoken over the flow
// (the affirmative journal that tells the story of what works and how — A's voice
// inside B's living stage). Pure + unit-tested (humanize.test.ts asserts every
// KNOWN_EMITTED_TYPE maps, that titles/tones are valid, and that the fallback is clean).

export type Tone = "info" | "ok" | "warn" | "danger" | "muted" | "accent";

export interface Humanized {
  tone: Tone;
  title: string;
}

// Re-voiced toward a plain, confident, narrative register (away from terse jargon
// like "Service-task job created"). Keys + tones are stable; only the words warmed.
const TABLE: Record<string, Humanized> = {
  // Lifecycle
  instanceStarted: { tone: "accent", title: "Run started" },
  instanceCompleted: { tone: "ok", title: "Run completed" },
  instanceCancelled: { tone: "warn", title: "Run cancelled" },
  elementEntered: { tone: "muted", title: "Advanced" },
  definitionDraftCreated: { tone: "muted", title: "Draft created" },
  definitionPublished: { tone: "info", title: "Version published" },

  // Service tasks / jobs
  serviceTaskJobCreated: { tone: "info", title: "Work queued for a service" },
  serviceTaskWaiting: { tone: "muted", title: "Waiting for a worker" },
  jobActivated: { tone: "info", title: "Worker picked up the job" },
  jobCompleted: { tone: "ok", title: "Worker finished" },
  serviceTaskCompleted: { tone: "ok", title: "Service step done" },
  jobFailed: { tone: "danger", title: "Worker reported a failure" },
  jobActivationExpired: { tone: "danger", title: "No worker took it in time" },
  serviceTaskOutputRejected: { tone: "warn", title: "Output too large — rejected" },
  poisonJob: { tone: "danger", title: "Output repeatedly too large" },
  businessErrorCaught: { tone: "warn", title: "Business error caught" },

  // Incidents / operator
  incidentCreated: { tone: "danger", title: "Incident raised" },
  operatorRetry: { tone: "accent", title: "You retried" },

  // Gateways
  gatewayDecisionEvaluated: { tone: "info", title: "Path chosen" },
  ebgDecision: { tone: "info", title: "Event chose the path" },
  eventBasedGatewayWaiting: { tone: "muted", title: "Waiting on the first event" },

  // Timers
  timerArmed: { tone: "info", title: "Timer started" },
  timerFired: { tone: "warn", title: "Timer elapsed" },
  timerCancelled: { tone: "muted", title: "Timer cleared" },

  // Messages / correlation
  receiveTaskWaiting: { tone: "muted", title: "Waiting for a message" },
  messageCatchWaiting: { tone: "muted", title: "Waiting for a message" },
  messageReceived: { tone: "info", title: "Message arrived" },
  messageCorrelated: { tone: "ok", title: "Message matched" },
  messageBuffered: { tone: "muted", title: "Early message held" },
  messageExpired: { tone: "warn", title: "Buffered message expired" },
  messageLate: { tone: "warn", title: "Message arrived too late" },
  duplicateIgnored: { tone: "muted", title: "Duplicate ignored" },
  invariantViolation: { tone: "danger", title: "Invariant violation" },

  // Transaction / saga
  transactionEntered: { tone: "info", title: "Transaction entered" },
  transactionCommitted: { tone: "ok", title: "Transaction committed" },
  transactionCancelled: { tone: "warn", title: "Transaction unwinding" },
  compensationStarted: { tone: "warn", title: "Rolling back" },
  compensationCompleted: { tone: "ok", title: "Roll-back complete" },
  compensationFailed: { tone: "danger", title: "Roll-back failed" },
  sagaFailed: { tone: "danger", title: "Saga couldn't fully roll back" },

  // Concurrency (M4)
  branchForked: { tone: "info", title: "Branches forked" },
  regionActivated: { tone: "info", title: "Fanned out" },
  branchArrivedAtJoin: { tone: "muted", title: "Branch reached the join" },
  joinCompleted: { tone: "ok", title: "Branches joined" },
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

// ---- The spoken narration over the flow (full sentence, element woven in) ---

type Narrator = (el: string | null) => string;
const at = (el: string | null) => (el ? ` at ${el}` : "");

const NARRATION: Record<string, Narrator> = {
  instanceStarted: () => "The run began.",
  instanceCompleted: () => "Every step landed — the run completed.",
  instanceCancelled: () => "The run was cancelled.",
  elementEntered: (el) => (el ? `Reached ${el}.` : "Advanced a step."),
  definitionDraftCreated: () => "A draft was created.",
  definitionPublished: () => "A new version was published.",

  serviceTaskJobCreated: (el) => `Queued work${el ? ` for ${el}` : ""}.`,
  serviceTaskWaiting: (el) => `Waiting for a worker to take ${el ?? "the job"}.`,
  jobActivated: (el) => `A worker picked up ${el ?? "the job"}.`,
  jobCompleted: (el) => `The worker finished ${el ?? "its work"}.`,
  serviceTaskCompleted: (el) => `${el ?? "The service step"} is done.`,
  jobFailed: (el) => `The worker reported a failure${at(el)}.`,
  jobActivationExpired: (el) => `No worker took ${el ?? "the job"} in time.`,
  serviceTaskOutputRejected: () => "A worker's output was too large and was rejected.",
  poisonJob: (el) => `${el ?? "A job"} keeps producing oversized output.`,
  businessErrorCaught: (el) => `A business error was caught${at(el)} and routed.`,

  incidentCreated: (el) => `An incident was raised${at(el)}.`,
  operatorRetry: () => "You retried.",

  gatewayDecisionEvaluated: (el) => `Chose a path${at(el)}.`,
  ebgDecision: () => "An event decided which way to go.",
  eventBasedGatewayWaiting: () => "Waiting for whichever event comes first.",

  timerArmed: () => "A timer started.",
  timerFired: () => "A timer elapsed.",
  timerCancelled: () => "A timer was cleared.",

  receiveTaskWaiting: () => "Waiting for a message.",
  messageCatchWaiting: () => "Waiting for a message.",
  messageReceived: () => "A message arrived.",
  messageCorrelated: () => "A message matched this run.",
  messageBuffered: () => "An early message is held until its run is ready.",
  messageExpired: () => "A buffered message expired before it matched.",
  messageLate: () => "A message arrived with no run to match.",
  duplicateIgnored: () => "A duplicate message was ignored.",
  invariantViolation: () => "An invariant was violated.",

  transactionEntered: () => "Entered the transaction scope.",
  transactionCommitted: () => "The transaction committed.",
  transactionCancelled: () => "The transaction is unwinding.",
  compensationStarted: () => "Rolling completed work back.",
  compensationCompleted: () => "Roll-back finished cleanly.",
  compensationFailed: (el) => `Roll-back failed${at(el)} — this one needs you.`,
  sagaFailed: () => "The saga couldn't fully roll back.",

  branchForked: () => "Work split into parallel branches.",
  regionActivated: () => "Fanned out into parallel branches.",
  branchArrivedAtJoin: () => "A branch reached the join.",
  joinCompleted: () => "All branches met at the join.",
};

/** A warm one-line narration for the ribbon. Falls back to the humanized title +
 *  element so a new/unmapped engine event still reads cleanly (never raw jargon). */
export function narrate(
  type: string,
  elementName?: string | null,
): { tone: Tone; line: string } {
  const h = humanize(type);
  const narrator = NARRATION[type];
  const el = elementName ?? null;
  const line = narrator ? narrator(el) : `${h.title}${el ? ` · ${el}` : ""}`;
  return { tone: h.tone, line };
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
