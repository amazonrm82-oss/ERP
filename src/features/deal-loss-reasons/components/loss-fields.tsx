"use client";

import { SelectField, TextField } from "@/components/ui/field";

import type { LossReasonOption } from "../queries";
import { COMPETITOR_MAX } from "../schema";

type Props = {
  // the organization's active reasons
  reasons: LossReasonOption[];
  // the deal's reason today, kept as a choice even when it was hidden since
  current?: LossReasonOption | null;
  // free text an old deal was lost with (before the list), shown so it is not forgotten
  oldText?: string | null;
  competitor?: string | null;
  errors?: Record<string, string | undefined>;
  controlSize?: "md" | "sm";
  // when the fields sit under a stage menu, the reason is the first thing to answer
  autoFocus?: boolean;
};

/**
 * Why a deal was lost (DEAL-03): a reason from the organization's list and the
 * competitor, both optional. Fields named lost_reason_id and competitor
 * (dealLossSchema).
 */
export function LossFields({ reasons, current, oldText, competitor, errors = {}, controlSize = "md", autoFocus }: Props) {
  const options = current && !reasons.some((reason) => reason.id === current.id) ? [current, ...reasons] : reasons;
  return (
    <>
      <SelectField
        label="סיבת הפסד"
        name="lost_reason_id"
        controlSize={controlSize}
        defaultValue={current?.id ?? ""}
        error={errors.lost_reason_id}
        hint={oldText && !current ? `נכתב בעבר: ${oldText}` : "לא חובה, אבל עוזר להבין למה עסקאות לא נסגרות."}
        autoFocus={autoFocus}
      >
        <option value="">בלי סיבה</option>
        {options.map((reason) => (
          <option key={reason.id} value={reason.id}>
            {reason.name}
          </option>
        ))}
      </SelectField>
      <TextField
        label="מתחרה"
        name="competitor"
        controlSize={controlSize}
        maxLength={COMPETITOR_MAX}
        autoComplete="off"
        placeholder="למשל: שם החברה שבחרו בה"
        defaultValue={competitor ?? ""}
        error={errors.competitor}
      />
    </>
  );
}
