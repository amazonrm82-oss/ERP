import { z } from "zod";

import { parseMoneyToAgorot } from "@/lib/format";
import { checkbox, moneyField, optionalEmail, optionalId, optionalPhone, optionalText, requiredId } from "@/lib/validation";

const leadFields = {
  full_name: optionalText(200, "השם ארוך מדי (עד 200 תווים)."),
  phone: optionalPhone,
  email: optionalEmail,
  company_name: optionalText(200, "שם החברה ארוך מדי (עד 200 תווים)."),
  source_id: optionalId,
  message: optionalText(5000, "ההודעה ארוכה מדי (עד 5,000 תווים)."),
};

type Identity = { full_name: string | null; phone: string | null; email: string | null };

// Mirrors the leads_has_identity check constraint.
const hasIdentity = (lead: Identity) => Boolean(lead.full_name || lead.phone || lead.email);
const identityIssue = { path: ["full_name"], error: "יש למלא לפחות אחד מהשדות: שם, טלפון או אימייל." };

export const LEAD_FIELD_NAMES = ["full_name", "phone", "email", "company_name", "source_id", "message"] as const;

export const createLeadSchema = z
  .object({
    ...leadFields,
    status_id: requiredId("יש לבחור סטטוס."),
    // only with a "not relevant" status; checked against the organization's list (RVW-9)
    disqualify_reason: optionalText(500, "הסיבה ארוכה מדי (עד 500 תווים)."),
  })
  .refine(hasIdentity, identityIssue);

export const updateLeadSchema = z.object(leadFields).refine(hasIdentity, identityIssue);

export const changeStatusSchema = z.object({
  status_id: requiredId("יש לבחור סטטוס."),
  disqualify_reason: optionalText(500, "הסיבה ארוכה מדי (עד 500 תווים)."),
});

// LEAD-01: campaign, budget and the five classic UTM values a person may edit. Click ids,
// referrer and landing page come from the visit only (no grant) and are never in a form.
export const LEAD_UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export type LeadUtmKey = (typeof LEAD_UTM_KEYS)[number];

export const LEAD_CAMPAIGN_FIELD_NAMES = ["campaign", "budget", ...LEAD_UTM_KEYS] as const;

/** Optional amount in shekels ("12,500") -> agorot; empty stays empty (null), unlike moneyField. */
const optionalMoney = z
  .preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string())
  .transform((value, ctx) => {
    if (value === "") return null;
    const agorot = parseMoneyToAgorot(value);
    if (agorot === null) {
      ctx.addIssue({ code: "custom", message: "יש להזין סכום בשקלים, למשל 12,500." });
      return z.NEVER;
    }
    return agorot;
  });

// counted in code points, like char_length() in the database, so a value the intake stored
// with emoji never blocks a save of the card
const utmText = z
  .preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string())
  .refine((value) => [...value].length <= 200, { error: "הערך ארוך מדי (עד 200 תווים)." })
  .transform((value) => (value === "" ? null : value));

export const leadCampaignSchema = z.object({
  campaign: optionalText(200, "שם הקמפיין ארוך מדי (עד 200 תווים)."),
  budget: optionalMoney,
  utm_source: utmText,
  utm_medium: utmText,
  utm_campaign: utmText,
  utm_term: utmText,
  utm_content: utmText,
});

export type LeadCampaignInput = z.infer<typeof leadCampaignSchema>;

/** The columns a new lead gets: utm holds only the values given. */
export function campaignInsert(input: LeadCampaignInput) {
  const utm: Partial<Record<LeadUtmKey, string>> = {};
  for (const key of LEAD_UTM_KEYS) {
    const value = input[key];
    if (value !== null) utm[key] = value;
  }
  return { campaign: input.campaign, budget_agorot: input.budget, utm };
}

/**
 * The columns an edit writes. utm goes as {"$merge": {...}}: the database merges the five
 * keys into the row as it is (trigger leads_utm_merge, migration 0114), so utm.extra and the
 * other keys the visit brought are never lost. A null removes a key.
 */
export function campaignUpdate(input: LeadCampaignInput) {
  const patch: Record<LeadUtmKey, string | null> = {
    utm_source: input.utm_source,
    utm_medium: input.utm_medium,
    utm_campaign: input.utm_campaign,
    utm_term: input.utm_term,
    utm_content: input.utm_content,
  };
  return { campaign: input.campaign, budget_agorot: input.budget, utm: { $merge: patch } };
}

/** Agorot -> what the budget input starts with ("12500", "12500.5"); empty when unset. */
export function budgetInputValue(agorot: number | null): string {
  if (agorot === null) return "";
  const whole = Math.trunc(agorot / 100);
  const cents = agorot % 100;
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, "0")}`;
}

/** The five UTM values stored in leads.utm, as strings (anything else is ignored). */
export function utmValues(utm: unknown): Partial<Record<LeadUtmKey, string>> {
  const out: Partial<Record<LeadUtmKey, string>> = {};
  if (!utm || typeof utm !== "object" || Array.isArray(utm)) return out;
  for (const key of LEAD_UTM_KEYS) {
    const value = (utm as Record<string, unknown>)[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export const convertLeadSchema = z.object({
  create_deal: checkbox,
  deal_name: optionalText(200, "שם העסקה ארוך מדי (עד 200 תווים)."),
  amount: moneyField,
});
