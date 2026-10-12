import { z } from "zod";

import { requiredText } from "@/lib/validation";

// LEAD-03: the reasons an organization offers when a lead is not relevant

export const REASON_MAX = 80;
// the database refuses more (trigger disqualify_reasons_cap, hint 'reasons:max')
export const REASONS_PER_ORG = 50;

export const reasonSchema = z.object({
  name: requiredText(REASON_MAX, "יש להזין סיבה.", `הסיבה ארוכה מדי (עד ${REASON_MAX} תווים).`),
});

// offered to an organization that has no reasons yet; the admin adds them with one click and edits freely
export const SUGGESTED_REASONS = ["לא עונה", "המחיר גבוה מדי", "קנה אצל מתחרה", "לא מתאים לשירות", "פרטים לא נכונים", "אחר"] as const;
