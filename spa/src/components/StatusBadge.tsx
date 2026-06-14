import { Badge } from "./ui";
import { statusTone } from "../lib/format";

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status}</Badge>;
}
