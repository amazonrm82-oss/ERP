// RVW-89: a marketing SMS carries the sender line "{שם העסק} · {טלפון העסק} · {כתובת העסק}" (MARKETING_SENDER_LINE). The SMS
// composer (app.sms_compose_core, 021247) fills the address only from the document settings' address line and city, and the
// phone from the document settings' phone, else the business phone; a field left empty refuses the message
// ('unfilled_field'). This is the same rule, so the settings pages can say so before a message fails. Pure.

export type MarketingDetailsInput = {
  addressLine: string | null;
  city: string | null;
  documentPhone: string | null;
  businessPhone: string | null;
};

export type MarketingDetailMissing = "address" | "phone";

const filled = (value: string | null) => (value ?? "").trim() !== "";

/** What a marketing SMS still needs: the business address and/or phone; [] = nothing missing. */
export function marketingSmsMissing(input: MarketingDetailsInput): MarketingDetailMissing[] {
  const missing: MarketingDetailMissing[] = [];
  if (!filled(input.addressLine) && !filled(input.city)) missing.push("address");
  if (!filled(input.documentPhone) && !filled(input.businessPhone)) missing.push("phone");
  return missing;
}

/** The line shown on the settings pages while something is missing; null when nothing is. */
export function marketingSmsMissingText(missing: MarketingDetailMissing[]): string | null {
  if (missing.length === 0) return null;
  const what = missing.length === 2 ? "כתובת וטלפון" : missing[0] === "address" ? "כתובת" : "טלפון";
  return `SMS שיווקי דורש כתובת וטלפון בהגדרות המסמכים (חסר: ${what}). עד שימולאו, הודעות שיווק ובקשות ביקורת ב-SMS לא יישלחו.`;
}
