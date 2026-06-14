// Compensation preview (design §13, G5 / MoT-3): from the saga ledger, compute
// "what cancel will compensate" = steps still `pending`, in reverse completion
// order (seq desc), each with its compensator. Shown BEFORE the Cancel click so the
// consequence is legible. Pure derivation — no engine call.

import type { SagaInspection, SagaStepInspection } from "../api/types";

export interface CompensationPreviewItem {
  elementId: string;
  seq: number;
  compensationElementId: string | null;
  compensationTaskType: string | null;
}

export function compensationPreview(saga: SagaInspection | null | undefined): CompensationPreviewItem[] {
  if (!saga) return [];
  return (saga.steps ?? [])
    .filter((s: SagaStepInspection) => s.compensationStatus === "pending")
    .sort((a, b) => b.seq - a.seq)
    .map((s) => ({
      elementId: s.elementId,
      seq: s.seq,
      compensationElementId: s.compensationElementId ?? null,
      compensationTaskType: s.compensationTaskType ?? null,
    }));
}
