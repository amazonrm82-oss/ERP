import { z } from "zod";

import { checkbox, optionalId, optionalText } from "@/lib/validation";
import { parseMoneyToAgorot } from "@/lib/format";

// SEG-03: a campaign cost as the form sends it. The database keeps the same rules (one of source or campaign, a month's
// first day, 1 agora up to a billion shekels, ILS only).

/** "2026-11" (<input type="month">) -> "2026-11-01"; null when it is not a month between 2000 and 2100. */
export function monthStart(value: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  return `${match[1]}-${match[2]}-01`;
}

/** "2026-11-01" -> "נובמבר 2026" */
export function monthLabel(day: string): string {
  return new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

export const MAX_COST_AGOROT = 100_000_000_000;

export const campaignCostSchema = z
  .object({
    source_id: optionalId,
    campaign: optionalText(200, "שם הקמפיין ארוך מדי (עד 200 תווים)."),
    month: z.preprocess(
      (value) => (typeof value === "string" ? monthStart(value) : null),
      z.string({ error: "בחרו חודש." }),
    ),
    amount: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string()).transform((value, ctx) => {
      const agorot = value === "" ? null : parseMoneyToAgorot(value);
      if (agorot === null || agorot < 1 || agorot > MAX_COST_AGOROT) {
        ctx.addIssue({ code: "custom", message: "יש להזין סכום בשקלים, למשל 2,500." });
        return z.NEVER;
      }
      return agorot;
    }),
    note: optionalText(500, "ההערה ארוכה מדי (עד 500 תווים)."),
    // owner (63) ב: the amount was typed with VAT (unchecked by default; offered only in a business that charges VAT)
    amount_includes_vat: checkbox,
  })
  .refine((value) => value.source_id !== null || value.campaign !== null, {
    path: ["campaign"],
    error: "בחרו מקור או כתבו שם קמפיין.",
  });

export type CampaignCostInput = z.infer<typeof campaignCostSchema>;

/**
 * An amount typed with VAT, before VAT at a rate in basis points, rounded half up (= app.amount_before_vat; both run
 * tests/unit/fixtures/amount-before-vat.json). Whole-number arithmetic, exact up to the largest cost.
 */
export function amountBeforeVat(amount: number, rateBp: number): number | null {
  if (!Number.isInteger(amount) || !Number.isInteger(rateBp) || rateBp < 0) return null;
  const sign = amount < 0 ? -1 : 1;
  const base = 10000 + rateBp;
  return sign * Math.floor((2 * Math.abs(amount) * 10000 + base) / (2 * base));
}


