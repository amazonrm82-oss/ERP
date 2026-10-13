import { z } from "zod";

import { optionalId, optionalText, requiredText } from "@/lib/validation";

// DEAL-03: the reasons an organization offers when a deal is lost, and the competitor field

export const LOSS_REASON_MAX = 80;
// the database refuses more (trigger deal_loss_reasons_cap, hint 'reasons:max')
export const LOSS_REASONS_PER_ORG = 50;
// deals_competitor_check
export const COMPETITOR_MAX = 120;

export const lossReasonSchema = z.object({
  name: requiredText(LOSS_REASON_MAX, "יש להזין סיבה.", `הסיבה ארוכה מדי (עד ${LOSS_REASON_MAX} תווים).`),
});

// every organization starts with these and renames or deletes them freely; the database seeds them
// (app.seed_deal_loss_reasons); tests/db/76-deal-loss-reasons.test.ts keeps the two equal
export const DEFAULT_LOSS_REASONS = ["מחיר", "בחרו במתחרה", "לא בזמן הנכון", "אין תקציב", "לא ענו", "אחר"] as const;

/** The reason and competitor a person gives when a deal is lost. Both optional (22.9 sets no rule; the app asks gently). */
export const dealLossSchema = z.object({
  lost_reason_id: optionalId,
  competitor: optionalText(COMPETITOR_MAX, `שם המתחרה ארוך מדי (עד ${COMPETITOR_MAX} תווים).`),
});

export const DEAL_LOSS_FIELD_NAMES = ["lost_reason_id", "competitor"] as const;

export type DealLoss = z.infer<typeof dealLossSchema>;
