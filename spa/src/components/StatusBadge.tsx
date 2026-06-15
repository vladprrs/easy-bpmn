// The single status / outcome pill for the whole console. The human-readable label
// ALWAYS comes from lib/humanize, so a raw camelCase enum (compensationFailed,
// arrivedAtJoin, invariantViolation, …) can never reach the operator. The tone
// defaults to the instance-status map (statusTone) but any panel may override it for
// its own vocabulary — attempts, jobs, saga steps, timers, tokens, messages — so the
// label-humanization lives in exactly one place while the colour stays domain-correct.

import { Badge } from "./ui";
import { statusTone } from "../lib/format";
import { humanize, type Tone } from "../lib/humanize";

export function StatusBadge({ status, tone }: { status: string; tone?: Tone }) {
  return <Badge tone={tone ?? statusTone(status)}>{humanize(status).title}</Badge>;
}
