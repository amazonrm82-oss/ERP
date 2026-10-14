import type { RequiredAsk } from "@/features/custom-fields/components/required-fields-dialog";
import type { MoveRefusal } from "@/features/custom-fields/required-move";

import { moveRecordAction } from "./actions";

/**
 * FLD-09: the window for a refused move (board, board card menu, table cell): the fields the refusal
 * names, saved with the same move by moveRecordAction. reason: a lead's "not relevant" reason or a
 * deal's loss reason by name, as the place sent it; reasons (lead only): the organization's list, so the
 * window can ask for the reason again when it does not pass.
 */
export function moveAsk(input: {
  orgId: string;
  object: "lead" | "deal";
  id: string;
  targetId: string;
  description: string;
  reason: string | null;
  reasons?: string[];
  reasonLabel?: string;
  refusal: MoveRefusal;
  onSaved?: () => void;
}): RequiredAsk {
  const { orgId, object, id, targetId, reason, refusal } = input;
  const reasonError = refusal.fieldErrors?.disqualify_reason;
  const askReason = object === "lead" && input.reasons !== undefined && (reason !== null || reasonError !== undefined);
  return {
    object,
    description: input.description,
    fields: refusal.missing,
    reason: askReason ? { reasons: input.reasons ?? [], label: input.reasonLabel ?? "למה הליד לא רלוונטי?", value: reason ?? "", error: reasonError } : undefined,
    save: (formData) => moveRecordAction(orgId, object, id, targetId, reason, formData),
    onSaved: input.onSaved,
  };
}
