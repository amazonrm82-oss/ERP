import { z } from "zod";

import { requiredText } from "@/lib/validation";

// LEAD-03: the reasons an organization offers when a lead is not relevant

export const REASON_MAX = 80;
// the database refuses more (trigger disqualify_reasons_cap, hint 'reasons:max')
export const REASONS_PER_ORG = 50;

export const reasonSchema = z.object({
  name: requiredText(REASON_MAX, "יש להזין סיבה.", `הסיבה ארוכה מדי (עד ${REASON_MAX} תווים).`),
});

// every organization starts with these and renames or deletes them freely; the database seeds them
// (app.seed_list_defaults); tests/db/56-managed-list-defaults.test.ts keeps the two equal
export const DEFAULT_REASONS = ["לא עונה", "המחיר גבוה מדי", "קנה אצל מתחרה", "לא מתאים לשירות", "פרטים לא נכונים", "אחר"] as const;
